import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, hkdfSync, randomBytes, randomUUID, sign, verify } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, chmod, open, readFile, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { Pool } from "pg";
import * as Y from "yjs";
import { envelopeV2Schema, type EnvelopeV2 } from "@multicode/protocol";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface EncryptedPayload {
  algorithm: "aes-256-gcm";
  nonce: string;
  ciphertext: string;
  tag: string;
}

export function roomSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function deriveRoomKey(secret: string, roomId: string, epoch: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "base64url"), Buffer.from(roomId), Buffer.from(`multicode/v2/${epoch}`), 32));
}

export function encryptPayload(key: Buffer, value: Uint8Array, aad: string): EncryptedPayload {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(textEncoder.encode(aad));
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return { algorithm: "aes-256-gcm", nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") };
}

export function decryptPayload(key: Buffer, value: EncryptedPayload, aad: string): Uint8Array {
  if (value.algorithm !== "aes-256-gcm") throw new Error("Unsupported encrypted payload algorithm");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.nonce, "base64url"));
  decipher.setAAD(textEncoder.encode(aad));
  decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
  return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64url")), decipher.final()]));
}

export interface HostIdentity {
  publicKey: string;
  privateKey: string;
}

export function createHostIdentity(): HostIdentity {
  const keys = generateKeyPairSync("ed25519");
  return { publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

export function signCapability(identity: HostIdentity, payload: Uint8Array): string {
  return sign(null, payload, identity.privateKey).toString("base64url");
}

export function verifyCapability(publicKey: string, payload: Uint8Array, signature: string): boolean {
  return verify(null, payload, publicKey, Buffer.from(signature, "base64url"));
}

export interface JournalEntry {
  roomId: string;
  sequence: number;
  envelope: EnvelopeV2;
  payload: EncryptedPayload;
  createdAt: string;
}

export interface DurableJournal {
  append(envelope: EnvelopeV2, payload: EncryptedPayload): Promise<JournalEntry>;
  replay(roomId: string, afterSequence?: number): Promise<JournalEntry[]>;
  saveSnapshot?(snapshot: JournalSnapshot): Promise<void>;
  loadLatestSnapshot?(roomId: string): Promise<JournalSnapshot | null>;
  close?(): void | Promise<void>;
}

export interface JournalSnapshot { roomId: string; sequence: number; payload: EncryptedPayload; payloadHash: string; createdAt: string }

/** Host-local fallback used when a room is running without a reachable relay database. */
export class FileJournal implements DurableJournal {
  private sequence = 0;
  private appendTail: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}

  append(envelope: EnvelopeV2, payload: EncryptedPayload): Promise<JournalEntry> {
    const operation = this.appendTail.then(() => this.appendNow(envelope, payload));
    this.appendTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async replay(roomId: string, afterSequence = 0): Promise<JournalEntry[]> {
    await this.appendTail;
    return (await this.readEntries()).filter((entry) => entry.roomId === roomId && entry.sequence > afterSequence);
  }

  private async appendNow(envelope: EnvelopeV2, payload: EncryptedPayload): Promise<JournalEntry> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const existing = await this.readEntries();
    this.sequence = Math.max(this.sequence, ...existing.map((entry) => entry.sequence));
    const sequence = ++this.sequence;
    const entry: JournalEntry = { roomId: envelope.roomId, sequence, envelope: { ...envelope, sequence }, payload, createdAt: new Date().toISOString() };
    const handle = await open(this.file, "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(entry)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return entry;
  }

  private async readEntries(): Promise<JournalEntry[]> {
    let contents: string;
    try {
      contents = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return contents.trim().split("\n").filter(Boolean).map((line, index) => {
      try {
        const value = JSON.parse(line) as JournalEntry;
        return { ...value, envelope: envelopeV2Schema.parse(value.envelope) };
      } catch (error) {
        throw new Error(`Invalid session journal entry at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }
}

export class SqliteJournal implements DurableJournal {
  private readonly database: DatabaseSync;
  private appendTail: Promise<void> = Promise.resolve();

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(file);
    this.database.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS room_sequences (room_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS room_events (
        room_id TEXT NOT NULL, sequence INTEGER NOT NULL, message_id TEXT NOT NULL,
        envelope TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (room_id, sequence), UNIQUE (room_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS room_snapshots (
        room_id TEXT NOT NULL, sequence INTEGER NOT NULL, payload TEXT NOT NULL,
        payload_hash TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (room_id, sequence)
      );
    `);
  }

  append(envelope: EnvelopeV2, payload: EncryptedPayload): Promise<JournalEntry> {
    const operation = this.appendTail.then(() => this.appendNow(envelope, payload));
    this.appendTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async replay(roomId: string, afterSequence = 0): Promise<JournalEntry[]> {
    await this.appendTail;
    const rows = this.database.prepare("SELECT room_id, sequence, envelope, payload, created_at FROM room_events WHERE room_id = ? AND sequence > ? ORDER BY sequence").all(roomId, afterSequence) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      roomId: String(row.room_id), sequence: Number(row.sequence), envelope: envelopeV2Schema.parse(JSON.parse(String(row.envelope))),
      payload: JSON.parse(String(row.payload)) as EncryptedPayload, createdAt: String(row.created_at),
    }));
  }

  close(): void { this.database.close(); }

  async saveSnapshot(snapshot: JournalSnapshot): Promise<void> {
    this.database.prepare("INSERT OR REPLACE INTO room_snapshots (room_id, sequence, payload, payload_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(snapshot.roomId, snapshot.sequence, JSON.stringify(snapshot.payload), snapshot.payloadHash, snapshot.createdAt);
  }

  async loadLatestSnapshot(roomId: string): Promise<JournalSnapshot | null> {
    const row = this.database.prepare("SELECT room_id, sequence, payload, payload_hash, created_at FROM room_snapshots WHERE room_id = ? ORDER BY sequence DESC LIMIT 1").get(roomId) as Record<string, unknown> | undefined;
    return row ? { roomId: String(row.room_id), sequence: Number(row.sequence), payload: JSON.parse(String(row.payload)) as EncryptedPayload, payloadHash: String(row.payload_hash), createdAt: String(row.created_at) } : null;
  }

  private async appendNow(envelope: EnvelopeV2, payload: EncryptedPayload): Promise<JournalEntry> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("INSERT INTO room_sequences (room_id, sequence) VALUES (?, 0) ON CONFLICT(room_id) DO NOTHING").run(envelope.roomId);
      const row = this.database.prepare("UPDATE room_sequences SET sequence = sequence + 1 WHERE room_id = ? RETURNING sequence").get(envelope.roomId) as { sequence?: number | bigint } | undefined;
      const sequence = Number(row?.sequence ?? 1); const createdAt = new Date().toISOString(); const persisted = { ...envelope, sequence };
      this.database.prepare("INSERT INTO room_events (room_id, sequence, message_id, envelope, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(envelope.roomId, sequence, envelope.messageId, JSON.stringify(persisted), JSON.stringify(payload), createdAt);
      this.database.exec("COMMIT");
      return { roomId: envelope.roomId, sequence, envelope: persisted, payload, createdAt };
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
}

export class PostgresJournal implements DurableJournal {
  readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, ssl: connectionString.includes("localhost") || connectionString.includes("127.0.0.1") ? false : { rejectUnauthorized: true } });
  }

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS multicode_room_events (
        room_id text NOT NULL,
        sequence bigint NOT NULL,
        message_id uuid NOT NULL,
        payload_type text NOT NULL,
        envelope jsonb NOT NULL,
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (room_id, sequence), UNIQUE (room_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS multicode_room_snapshots (
        room_id text NOT NULL, sequence bigint NOT NULL, payload jsonb NOT NULL,
        payload_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (room_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS multicode_room_sequences (
        room_id text PRIMARY KEY, sequence bigint NOT NULL DEFAULT 0
      );
    `);
  }

  async append(envelope: EnvelopeV2, payload: EncryptedPayload): Promise<JournalEntry> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO multicode_room_sequences (room_id) VALUES ($1) ON CONFLICT (room_id) DO NOTHING", [envelope.roomId]);
      const next = await client.query<{ sequence: string }>("UPDATE multicode_room_sequences SET sequence = sequence + 1 WHERE room_id = $1 RETURNING sequence", [envelope.roomId]);
      const sequence = Number(next.rows[0]?.sequence ?? 1);
      const persisted = { ...envelope, sequence };
      await client.query("INSERT INTO multicode_room_events (room_id, sequence, message_id, payload_type, envelope, payload) VALUES ($1,$2,$3,$4,$5,$6)", [envelope.roomId, sequence, envelope.messageId, envelope.payloadType, persisted, payload]);
      await client.query("COMMIT");
      return { roomId: envelope.roomId, sequence, envelope: persisted, payload, createdAt: new Date().toISOString() };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async replay(roomId: string, afterSequence = 0): Promise<JournalEntry[]> {
    const result = await this.pool.query<{
      room_id: string;
      sequence: string;
      envelope: EnvelopeV2;
      payload: EncryptedPayload;
      created_at: Date;
    }>("SELECT room_id, sequence, envelope, payload, created_at FROM multicode_room_events WHERE room_id = $1 AND sequence > $2 ORDER BY sequence", [roomId, afterSequence]);
    return result.rows.map((row) => ({
      roomId: row.room_id,
      sequence: Number(row.sequence),
      envelope: envelopeV2Schema.parse(row.envelope),
      payload: row.payload,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async close(): Promise<void> { await this.pool.end(); }
}

export class CollaborativeDocuments {
  private readonly documents = new Map<string, Y.Doc>();
  document(fileId: string): Y.Doc {
    let document = this.documents.get(fileId);
    if (!document) { document = new Y.Doc(); this.documents.set(fileId, document); }
    return document;
  }
  apply(fileId: string, update: Uint8Array, origin: unknown = "remote"): void { Y.applyUpdate(this.document(fileId), update, origin); }
  snapshot(fileId: string): Uint8Array { return Y.encodeStateAsUpdate(this.document(fileId)); }
  fileIds(): string[] { return [...this.documents.keys()]; }
  clone(): CollaborativeDocuments {
    const result = new CollaborativeDocuments();
    for (const fileId of this.fileIds()) result.apply(fileId, this.snapshot(fileId), "clone");
    return result;
  }
}

export interface FileRecord {
  fileId: string;
  path: string;
  kind: "text" | "binary";
  encoding: "utf-8" | "binary";
  mode: number;
  size: number;
  contentHash: string;
  documentEpoch: number;
  deleted: boolean;
}

export interface ManifestSnapshot {
  revision: number;
  files: FileRecord[];
  retiredPaths: string[];
}

function normalizedWorkspacePath(value: string): string {
  if (!value || value.includes("\0") || value.includes("\\") || path.posix.isAbsolute(value)) throw new Error("Invalid workspace path");
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === "." || normalized.startsWith("../") || /^[A-Za-z]:/.test(normalized)) throw new Error("Workspace path escapes the room root");
  for (const component of normalized.split("/")) {
    if (!component || /[<>:"|?*\u0000-\u001f]/.test(component) || /[ .]$/.test(component) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(component)) throw new Error("Workspace path is not portable");
  }
  return normalized;
}

function manifestPathKey(value: string): string { return normalizedWorkspacePath(value).toLocaleLowerCase("en-US"); }

export class WorkspaceManifest {
  private revision = 0;
  private readonly files = new Map<string, FileRecord>();
  private readonly paths = new Map<string, string>();
  private readonly retiredPaths = new Set<string>();

  static fromSnapshot(snapshot: ManifestSnapshot): WorkspaceManifest {
    const manifest = new WorkspaceManifest();
    if (!Number.isInteger(snapshot.revision) || snapshot.revision < 0) throw new Error("Invalid manifest snapshot revision");
    for (const source of snapshot.files) {
      const record = { ...source, path: normalizedWorkspacePath(source.path) };
      if (manifest.files.has(record.fileId)) throw new Error("Duplicate manifest file ID");
      if (!record.deleted && manifest.paths.has(manifestPathKey(record.path))) throw new Error("Duplicate manifest path");
      manifest.files.set(record.fileId, record);
      if (!record.deleted) manifest.paths.set(manifestPathKey(record.path), record.fileId);
    }
    for (const retired of snapshot.retiredPaths ?? []) manifest.retiredPaths.add(normalizedWorkspacePath(retired));
    manifest.revision = snapshot.revision;
    return manifest;
  }

  snapshot(): ManifestSnapshot { return { revision: this.revision, files: [...this.files.values()].map((file) => ({ ...file })), retiredPaths: [...this.retiredPaths] }; }
  file(fileId: string): FileRecord | undefined { const file = this.files.get(fileId); return file ? { ...file } : undefined; }
  fileByPath(filePath: string): FileRecord | undefined {
    const fileId = this.paths.get(manifestPathKey(filePath));
    return fileId ? this.file(fileId) : undefined;
  }

  ensureTextFile(filePath: string, fileId: string = randomUUID()): FileRecord {
    const normalized = normalizedWorkspacePath(filePath);
    const existingId = this.paths.get(manifestPathKey(normalized));
    if (existingId) { const existing = this.file(existingId) as FileRecord; if (existing.path !== normalized) throw new Error("Manifest path already exists with different casing"); return existing; }
    if (this.files.has(fileId)) throw new Error("Manifest file ID already exists");
    const record: FileRecord = { fileId, path: normalized, kind: "text", encoding: "utf-8", mode: 0o100644, size: 0, contentHash: payloadHash(new Uint8Array()), documentEpoch: 1, deleted: false };
    this.files.set(fileId, record); this.paths.set(manifestPathKey(normalized), fileId); this.retiredPaths.delete(normalized); this.revision += 1;
    return { ...record };
  }

  createTextFile(filePath: string, fileId: string, content: string, expectedRevision: number): FileRecord {
    if (expectedRevision !== this.revision) throw new Error("Manifest revision changed; resynchronization required");
    if (this.fileByPath(filePath)) throw new Error("Manifest path already exists");
    const record = this.ensureTextFile(filePath, fileId);
    return this.updateTextContent(record.fileId, content);
  }

  rename(fileId: string, destinationPath: string, expectedRevision: number): FileRecord {
    if (expectedRevision !== this.revision) throw new Error("Manifest revision changed; resynchronization required");
    const record = this.files.get(fileId); if (!record || record.deleted) throw new Error("Manifest file no longer exists");
    const destination = normalizedWorkspacePath(destinationPath);
    if (this.paths.has(manifestPathKey(destination))) throw new Error("Manifest destination already exists");
    this.paths.delete(manifestPathKey(record.path)); this.retiredPaths.add(record.path); record.path = destination; this.paths.set(manifestPathKey(destination), fileId); this.retiredPaths.delete(destination); this.revision += 1;
    return { ...record };
  }

  delete(fileId: string, expectedRevision: number): FileRecord {
    if (expectedRevision !== this.revision) throw new Error("Manifest revision changed; resynchronization required");
    const record = this.files.get(fileId); if (!record || record.deleted) throw new Error("Manifest file no longer exists");
    this.paths.delete(manifestPathKey(record.path)); this.retiredPaths.add(record.path); record.deleted = true; record.documentEpoch += 1; this.revision += 1;
    return { ...record };
  }

  updateTextContent(fileId: string, value: string): FileRecord {
    const record = this.files.get(fileId); if (!record || record.deleted || record.kind !== "text") throw new Error("Manifest text file no longer exists");
    const bytes = utf8(value); record.size = bytes.byteLength; record.contentHash = payloadHash(bytes);
    return { ...record };
  }
}

export interface DocumentUpdateResult {
  fileId: string;
  path: string;
  sequence: number;
  update: Uint8Array;
}

interface PersistedDocumentUpdateV1 {
  version: 1;
  fileId: string;
  update: string;
}

interface PersistedDocumentUpdateV2 {
  version: 2;
  fileId: string;
  path: string;
  update: string;
}

export interface RecoveryResult {
  replayedEntries: number;
  recoveredDocumentUpdates: number;
  lastSequence: number;
}

export type ManifestOperation =
  | { type: "create"; path: string; content: string; expectedRevision?: number }
  | { type: "rename"; sourcePath: string; destinationPath: string; expectedRevision?: number }
  | { type: "delete"; path: string; expectedRevision?: number };

interface PersistedManifestOperation {
  version: 1;
  type: "create" | "rename" | "delete";
  fileId: string;
  sourcePath?: string;
  destinationPath?: string;
  content?: string;
  documentSnapshot?: string;
  expectedRevision: number;
}

export interface ManifestOperationResult {
  sequence: number;
  revision: number;
  record: FileRecord;
}

export type WorkspaceTransactionOperation =
  | { type: "create"; path: string; content: string }
  | { type: "replace"; path: string; content: string }
  | { type: "rename"; sourcePath: string; destinationPath: string; content?: string }
  | { type: "delete"; path: string };

interface PersistedWorkspaceTransaction {
  version: 1;
  transactionId: string;
  operations: Array<
    | { type: "create"; fileId: string; path: string; content: string; documentSnapshot?: string }
    | { type: "replace"; fileId: string; path: string; content: string }
    | { type: "rename"; fileId: string; sourcePath: string; destinationPath: string; content?: string }
    | { type: "delete"; fileId: string; path: string }
  >;
}

export interface WorkspaceTransactionResult {
  transactionId: string;
  sequence: number;
  operations: WorkspaceTransactionOperation[];
  documentUpdates: Array<{ fileId: string; path: string; documentEpoch: number; update: Uint8Array }>;
}

/** The host-side authority for durable Yjs operations. */
export class HostSession {
  documents = new CollaborativeDocuments();
  manifest = new WorkspaceManifest();
  private readonly key: Buffer;
  private operationTail: Promise<void> = Promise.resolve();
  private lastSequence = 0;

  constructor(
    readonly roomId: string,
    readonly sessionEpoch: string,
    secret: string,
    private readonly journal: DurableJournal,
  ) { this.key = deriveRoomKey(secret, roomId, sessionEpoch); }

  applyDocumentUpdate(actorId: string, fileId: string, update: Uint8Array, correlationId: string = randomUUID()): Promise<DocumentUpdateResult> {
    return this.enqueue(() => this.applyDocumentUpdateNow(actorId, fileId, update, correlationId));
  }

  applyManifestOperation(actorId: string, operation: ManifestOperation, correlationId: string = randomUUID()): Promise<ManifestOperationResult> {
    return this.enqueue(() => this.applyManifestOperationNow(actorId, operation, correlationId));
  }

  applyWorkspaceTransaction(actorId: string, operations: WorkspaceTransactionOperation[], correlationId: string = randomUUID()): Promise<WorkspaceTransactionResult> {
    return this.enqueue(() => this.applyWorkspaceTransactionNow(actorId, operations, correlationId));
  }

  async ensureDocumentText(actorId: string, filePath: string, content: string, correlationId: string = randomUUID()): Promise<FileRecord> {
    const existing = this.manifest.fileByPath(filePath);
    if (!existing) return (await this.applyManifestOperation(actorId, { type: "create", path: filePath, content }, correlationId)).record;
    const current = this.documents.document(existing.fileId).getText("content").toString();
    if (current !== content) await this.replaceDocumentText(actorId, filePath, content, correlationId);
    return this.manifest.file(existing.fileId) as FileRecord;
  }

  async replaceDocumentText(actorId: string, filePath: string, content: string, correlationId: string = randomUUID()): Promise<DocumentUpdateResult | null> {
    const existing = this.manifest.fileByPath(filePath);
    if (!existing) {
      const created = await this.applyManifestOperation(actorId, { type: "create", path: filePath, content }, correlationId);
      return { fileId: created.record.fileId, path: created.record.path, sequence: created.sequence, update: this.documents.snapshot(created.record.fileId) };
    }
    const source = new Y.Doc(); Y.applyUpdate(source, this.documents.snapshot(existing.fileId));
    const text = source.getText("content"); if (text.toString() === content) return null;
    let update: Uint8Array | undefined; const listener = (value: Uint8Array) => { update = value; }; source.on("update", listener);
    source.transact(() => { text.delete(0, text.length); if (content) text.insert(0, content); }, actorId); source.off("update", listener);
    if (!update) return null;
    return this.applyDocumentUpdate(actorId, filePath, update, correlationId);
  }

  documentSnapshot(filePath: string): { record: FileRecord; update: Uint8Array } {
    const record = this.manifest.fileByPath(filePath); if (!record || record.deleted) throw new Error("Document is not present in the manifest");
    return { record, update: this.documents.snapshot(record.fileId) };
  }

  compact(): Promise<number> {
    return this.enqueue(async () => {
      if (!this.journal.saveSnapshot || this.lastSequence < 1) return this.lastSequence;
      const plaintext = utf8(JSON.stringify({ version: 1, manifest: this.manifest.snapshot(), documents: this.documents.fileIds().map((fileId) => ({ fileId, update: Buffer.from(this.documents.snapshot(fileId)).toString("base64url") })) }));
      await this.journal.saveSnapshot({ roomId: this.roomId, sequence: this.lastSequence, payload: encryptPayload(this.key, plaintext, `${this.roomId}:snapshot:${this.lastSequence}`), payloadHash: payloadHash(plaintext), createdAt: new Date().toISOString() });
      return this.lastSequence;
    });
  }

  async close(): Promise<void> { await this.operationTail; await this.journal.close?.(); }

  recover(afterSequence = 0): Promise<RecoveryResult> {
    return this.enqueue(async () => {
      let replayAfter = afterSequence;
      if (this.journal.loadLatestSnapshot) {
        const snapshot = await this.journal.loadLatestSnapshot(this.roomId);
        if (snapshot && snapshot.sequence > replayAfter) {
          const plaintext = decryptPayload(this.key, snapshot.payload, `${this.roomId}:snapshot:${snapshot.sequence}`);
          if (payloadHash(plaintext) !== snapshot.payloadHash) throw new Error("Session snapshot integrity mismatch");
          const value = JSON.parse(fromUtf8(plaintext)) as { version?: unknown; manifest?: ManifestSnapshot; documents?: Array<{ fileId?: unknown; update?: unknown }> };
          if (value.version !== 1 || !value.manifest || !Array.isArray(value.documents)) throw new Error("Invalid session snapshot");
          const documents = new CollaborativeDocuments();
          for (const document of value.documents) { if (typeof document.fileId !== "string" || typeof document.update !== "string") throw new Error("Invalid session snapshot document"); documents.apply(document.fileId, Buffer.from(document.update, "base64url"), "snapshot-recovery"); }
          this.manifest = WorkspaceManifest.fromSnapshot(value.manifest); this.documents = documents; replayAfter = snapshot.sequence;
        }
      }
      const entries = await this.journal.replay(this.roomId, replayAfter);
      let recoveredDocumentUpdates = 0;
      let lastSequence = replayAfter;
      for (const entry of entries) {
        if (entry.roomId !== this.roomId || entry.envelope.roomId !== this.roomId || entry.envelope.sessionEpoch !== this.sessionEpoch || entry.envelope.sequence !== entry.sequence) {
          throw new Error(`Session journal identity mismatch at sequence ${entry.sequence}`);
        }
        const plaintext = decryptPayload(this.key, entry.payload, `${this.roomId}:${entry.envelope.messageId}`);
        if (entry.envelope.payloadLength !== plaintext.byteLength || entry.envelope.payloadHash !== payloadHash(plaintext)) {
          throw new Error(`Session journal payload integrity mismatch at sequence ${entry.sequence}`);
        }
        if (entry.envelope.payloadType === "document.update") {
          const persisted = JSON.parse(fromUtf8(plaintext)) as { version?: unknown; fileId?: unknown; path?: unknown; update?: unknown };
          if ((persisted.version !== 1 && persisted.version !== 2) || typeof persisted.fileId !== "string" || !persisted.fileId || typeof persisted.update !== "string") {
            throw new Error(`Invalid persisted document update at sequence ${entry.sequence}`);
          }
          const filePath = persisted.version === 2 && typeof persisted.path === "string" ? persisted.path : persisted.fileId;
          const record = this.manifest.ensureTextFile(filePath, persisted.fileId);
          this.documents.apply(record.fileId, Buffer.from(persisted.update, "base64url"), entry.envelope.actorId);
          this.manifest.updateTextContent(record.fileId, this.documents.document(record.fileId).getText("content").toString());
          recoveredDocumentUpdates += 1;
        } else if (entry.envelope.payloadType === "manifest.operation") {
          const persisted = JSON.parse(fromUtf8(plaintext)) as PersistedManifestOperation;
          this.applyPersistedManifestOperation(persisted);
        } else if (entry.envelope.payloadType === "workspace.finalize") {
          const persisted = JSON.parse(fromUtf8(plaintext)) as PersistedWorkspaceTransaction;
          const applied = this.stageWorkspaceTransaction(persisted);
          this.manifest = applied.manifest; this.documents = applied.documents;
          recoveredDocumentUpdates += applied.documentUpdates.length;
        }
        lastSequence = entry.sequence;
      }
      this.lastSequence = lastSequence;
      return { replayedEntries: entries.length, recoveredDocumentUpdates, lastSequence };
    });
  }

  private async applyDocumentUpdateNow(actorId: string, filePath: string, update: Uint8Array, correlationId: string): Promise<DocumentUpdateResult> {
    const payload = new Uint8Array(update);
    if (!payload.byteLength || payload.byteLength > 96 * 1024) throw new Error("Document update exceeds the allowed size");
    const existing = this.manifest.fileByPath(filePath);
    const fileId = existing?.fileId ?? randomUUID();
    const validation = new Y.Doc();
    if (existing) Y.applyUpdate(validation, this.documents.snapshot(existing.fileId), "validation-base");
    try { Y.applyUpdate(validation, payload, "validation"); } catch { throw new Error("Malformed Yjs document update"); }
    const persistedPayload = utf8(JSON.stringify({ version: 2, fileId, path: normalizedWorkspacePath(filePath), update: Buffer.from(payload).toString("base64url") } satisfies PersistedDocumentUpdateV2));
    const envelope: EnvelopeV2 = {
      protocolVersion: 2,
      roomId: this.roomId,
      sessionEpoch: this.sessionEpoch,
      messageId: randomUUID(),
      actorId,
      correlationId,
      payloadType: "document.update",
      payloadLength: persistedPayload.byteLength,
      payloadHash: payloadHash(persistedPayload),
    };
    const persisted = await this.journal.append(envelope, encryptPayload(this.key, persistedPayload, `${this.roomId}:${envelope.messageId}`));
    this.lastSequence = persisted.sequence;
    const record = this.manifest.ensureTextFile(filePath, fileId);
    this.documents.apply(record.fileId, payload, actorId);
    this.manifest.updateTextContent(record.fileId, this.documents.document(record.fileId).getText("content").toString());
    return { fileId: record.fileId, path: record.path, sequence: persisted.sequence, update: payload };
  }

  private async applyManifestOperationNow(actorId: string, operation: ManifestOperation, correlationId: string): Promise<ManifestOperationResult> {
    const revision = operation.expectedRevision ?? this.manifest.snapshot().revision;
    let persisted: PersistedManifestOperation;
    if (operation.type === "create") {
      if (this.manifest.fileByPath(operation.path)) throw new Error("Manifest path already exists");
      const initial = new Y.Doc(); if (operation.content) initial.getText("content").insert(0, operation.content);
      persisted = { version: 1, type: "create", fileId: randomUUID(), destinationPath: normalizedWorkspacePath(operation.path), content: operation.content, documentSnapshot: Buffer.from(Y.encodeStateAsUpdate(initial)).toString("base64url"), expectedRevision: revision };
    } else {
      const record = this.manifest.fileByPath(operation.type === "rename" ? operation.sourcePath : operation.path);
      if (!record || record.deleted) throw new Error("Manifest file no longer exists");
      persisted = operation.type === "rename"
        ? { version: 1, type: "rename", fileId: record.fileId, sourcePath: record.path, destinationPath: normalizedWorkspacePath(operation.destinationPath), expectedRevision: revision }
        : { version: 1, type: "delete", fileId: record.fileId, sourcePath: record.path, expectedRevision: revision };
    }
    const plaintext = utf8(JSON.stringify(persisted));
    const envelope: EnvelopeV2 = {
      protocolVersion: 2, roomId: this.roomId, sessionEpoch: this.sessionEpoch, messageId: randomUUID(), actorId, correlationId,
      payloadType: "manifest.operation", payloadLength: plaintext.byteLength, payloadHash: payloadHash(plaintext),
    };
    const journalEntry = await this.journal.append(envelope, encryptPayload(this.key, plaintext, `${this.roomId}:${envelope.messageId}`));
    this.lastSequence = journalEntry.sequence;
    const record = this.applyPersistedManifestOperation(persisted);
    return { sequence: journalEntry.sequence, revision: this.manifest.snapshot().revision, record };
  }

  private async applyWorkspaceTransactionNow(actorId: string, operations: WorkspaceTransactionOperation[], correlationId: string): Promise<WorkspaceTransactionResult> {
    if (!operations.length) throw new Error("Workspace transaction must contain at least one operation");
    const persisted: PersistedWorkspaceTransaction = { version: 1, transactionId: randomUUID(), operations: [] };
    const shadow = WorkspaceManifest.fromSnapshot(this.manifest.snapshot());
    for (const operation of operations) {
      if (operation.type === "create") {
        if (Buffer.byteLength(operation.content) > 96 * 1024) throw new Error("Collaborative text file is too large");
        const path = normalizedWorkspacePath(operation.path); const fileId = randomUUID();
        shadow.createTextFile(path, fileId, operation.content, shadow.snapshot().revision);
        const initial = new Y.Doc(); if (operation.content) initial.getText("content").insert(0, operation.content);
        persisted.operations.push({ type: "create", fileId, path, content: operation.content, documentSnapshot: Buffer.from(Y.encodeStateAsUpdate(initial)).toString("base64url") });
      } else if (operation.type === "replace") {
        if (Buffer.byteLength(operation.content) > 96 * 1024) throw new Error("Collaborative text file is too large");
        const path = normalizedWorkspacePath(operation.path); const record = shadow.fileByPath(path);
        if (!record) throw new Error("Workspace transaction document no longer exists");
        shadow.updateTextContent(record.fileId, operation.content);
        persisted.operations.push({ type: "replace", fileId: record.fileId, path, content: operation.content });
      } else if (operation.type === "rename") {
        const sourcePath = normalizedWorkspacePath(operation.sourcePath); const destinationPath = normalizedWorkspacePath(operation.destinationPath); const record = shadow.fileByPath(sourcePath);
        if (!record) throw new Error("Workspace transaction rename source no longer exists");
        shadow.rename(record.fileId, destinationPath, shadow.snapshot().revision);
        if (operation.content !== undefined) shadow.updateTextContent(record.fileId, operation.content);
        persisted.operations.push({ type: "rename", fileId: record.fileId, sourcePath, destinationPath, ...(operation.content !== undefined ? { content: operation.content } : {}) });
      } else {
        const path = normalizedWorkspacePath(operation.path); const record = shadow.fileByPath(path);
        if (!record) throw new Error("Workspace transaction delete target no longer exists");
        shadow.delete(record.fileId, shadow.snapshot().revision);
        persisted.operations.push({ type: "delete", fileId: record.fileId, path });
      }
    }
    const staged = this.stageWorkspaceTransaction(persisted);
    const plaintext = utf8(JSON.stringify(persisted));
    const envelope: EnvelopeV2 = {
      protocolVersion: 2, roomId: this.roomId, sessionEpoch: this.sessionEpoch, messageId: randomUUID(), actorId, correlationId,
      payloadType: "workspace.finalize", payloadLength: plaintext.byteLength, payloadHash: payloadHash(plaintext),
    };
    const journalEntry = await this.journal.append(envelope, encryptPayload(this.key, plaintext, `${this.roomId}:${envelope.messageId}`));
    this.lastSequence = journalEntry.sequence;
    this.manifest = staged.manifest; this.documents = staged.documents;
    return { transactionId: persisted.transactionId, sequence: journalEntry.sequence, operations: operations.map((operation) => ({ ...operation })), documentUpdates: staged.documentUpdates };
  }

  private stageWorkspaceTransaction(persisted: PersistedWorkspaceTransaction): { manifest: WorkspaceManifest; documents: CollaborativeDocuments; documentUpdates: WorkspaceTransactionResult["documentUpdates"] } {
    if (persisted.version !== 1 || typeof persisted.transactionId !== "string" || !Array.isArray(persisted.operations)) throw new Error("Invalid persisted workspace transaction");
    const manifest = WorkspaceManifest.fromSnapshot(this.manifest.snapshot());
    const documents = this.documents.clone();
    const changedText = new Set<string>();
    for (const operation of persisted.operations) {
      if (operation.type === "create") {
        manifest.createTextFile(operation.path, operation.fileId, operation.content, manifest.snapshot().revision);
        const text = documents.document(operation.fileId).getText("content");
        if (operation.documentSnapshot) documents.apply(operation.fileId, Buffer.from(operation.documentSnapshot, "base64url"), "workspace-create"); else if (operation.content) text.insert(0, operation.content);
        changedText.add(operation.fileId);
      } else {
        const current = manifest.file(operation.fileId);
        if (!current || current.deleted) throw new Error("Persisted workspace transaction file no longer exists");
        if (operation.type === "replace") {
          if (current.path !== operation.path) throw new Error("Persisted workspace transaction path changed");
          const text = documents.document(operation.fileId).getText("content"); text.delete(0, text.length); if (operation.content) text.insert(0, operation.content);
          manifest.updateTextContent(operation.fileId, operation.content); changedText.add(operation.fileId);
        } else if (operation.type === "rename") {
          if (current.path !== operation.sourcePath) throw new Error("Persisted workspace transaction rename source changed");
          manifest.rename(operation.fileId, operation.destinationPath, manifest.snapshot().revision);
          if (operation.content !== undefined) { const text = documents.document(operation.fileId).getText("content"); text.delete(0, text.length); if (operation.content) text.insert(0, operation.content); manifest.updateTextContent(operation.fileId, operation.content); changedText.add(operation.fileId); }
        } else {
          if (current.path !== operation.path) throw new Error("Persisted workspace transaction delete path changed");
          manifest.delete(operation.fileId, manifest.snapshot().revision);
        }
      }
    }
    const documentUpdates = [...changedText].flatMap((fileId) => {
      const record = manifest.file(fileId); if (!record || record.deleted) return [];
      const update = Y.encodeStateAsUpdate(documents.document(fileId), Y.encodeStateVector(this.documents.document(fileId)));
      return [{ fileId, path: record.path, documentEpoch: record.documentEpoch, update }];
    });
    return { manifest, documents, documentUpdates };
  }

  private applyPersistedManifestOperation(operation: PersistedManifestOperation): FileRecord {
    if (operation.version !== 1 || !operation.fileId || !Number.isInteger(operation.expectedRevision)) throw new Error("Invalid persisted manifest operation");
    if (operation.type === "create") {
      if (typeof operation.destinationPath !== "string" || typeof operation.content !== "string") throw new Error("Invalid persisted create operation");
      const record = this.manifest.createTextFile(operation.destinationPath, operation.fileId, operation.content, operation.expectedRevision);
      const document = this.documents.document(record.fileId); const text = document.getText("content");
      if (!text.length && operation.documentSnapshot) this.documents.apply(record.fileId, Buffer.from(operation.documentSnapshot, "base64url"), "manifest-create");
      else if (!text.length && operation.content) text.insert(0, operation.content);
      return record;
    }
    const current = this.manifest.file(operation.fileId);
    if (!current || current.deleted || current.path !== operation.sourcePath) throw new Error("Persisted manifest source no longer matches");
    if (operation.type === "rename") {
      if (typeof operation.destinationPath !== "string") throw new Error("Invalid persisted rename operation");
      return this.manifest.rename(operation.fileId, operation.destinationPath, operation.expectedRevision);
    }
    if (operation.type === "delete") return this.manifest.delete(operation.fileId, operation.expectedRevision);
    throw new Error("Unsupported persisted manifest operation");
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class LocalIpcServer {
  private server: Server | undefined;
  constructor(private readonly token: string, private readonly onMessage: (message: unknown) => Promise<unknown>) {}
  async listen(socketPath: string): Promise<void> {
    await mkdir(path.dirname(socketPath), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      this.server = createServer((socket) => this.accept(socket));
      this.server.once("error", reject); this.server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
  }
  async close(): Promise<void> { if (this.server) await new Promise<void>((resolve) => this.server?.close(() => resolve())); }
  private accept(socket: Socket): void {
    socket.setEncoding("utf8"); let buffer = "";
    socket.on("data", (data: string) => { buffer += data; const lines = buffer.split("\n"); buffer = lines.pop() ?? ""; for (const line of lines) void this.receive(socket, line); });
  }
  private async receive(socket: Socket, line: string): Promise<void> {
    try {
      const request = JSON.parse(line) as { token?: string; id?: string; payload?: unknown };
      if (request.token !== this.token) throw new Error("Unauthorized local IPC request");
      socket.write(`${JSON.stringify({ id: request.id, ok: true, result: await this.onMessage(request.payload) })}\n`);
    } catch (error) { socket.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`); }
  }
}

export async function requestLocalIpc<T = unknown>(socketPath: string, token: string, payload: unknown, timeoutMs = 5_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const socket = createConnection(socketPath); let buffer = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Session daemon request timed out")); }, timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify({ token, id: randomUUID(), payload })}\n`));
    socket.on("data", (data: string) => {
      buffer += data; const newline = buffer.indexOf("\n"); if (newline < 0) return;
      clearTimeout(timer); socket.end();
      try { const response = JSON.parse(buffer.slice(0, newline)) as { ok?: boolean; result?: T; error?: string }; response.ok ? resolve(response.result as T) : reject(new Error(response.error ?? "Session daemon request failed")); }
      catch (error) { reject(error); }
    });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

export async function writeSessionToken(file: string, token = randomBytes(32).toString("base64url")): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, `${token}\n`, { mode: 0o600 }); await chmod(file, 0o600); return token;
}

async function loadOrCreatePrivateValue(options: {
  file: string;
  configured?: string;
  create: () => string;
  label: string;
  validate: (value: string) => boolean;
}): Promise<string> {
  await mkdir(path.dirname(options.file), { recursive: true, mode: 0o700 });
  try {
    const existing = (await readFile(options.file, "utf8")).trim();
    if (!options.validate(existing)) throw new Error(`Persisted ${options.label} is invalid`);
    if (options.configured && options.configured !== existing) throw new Error(`Configured ${options.label} does not match the persisted session`);
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const value = options.configured ?? options.create();
  if (!options.validate(value)) throw new Error(`Configured ${options.label} is invalid`);
  try {
    const handle = await open(options.file, "wx", 0o600);
    try {
      await handle.writeFile(`${value}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = (await readFile(options.file, "utf8")).trim();
    if (!options.validate(existing) || (options.configured && options.configured !== existing)) {
      throw new Error(`Persisted ${options.label} does not match the requested session`);
    }
    return existing;
  }
}

export function loadOrCreateSessionEpoch(file: string, configured?: string): Promise<string> {
  return loadOrCreatePrivateValue({
    file,
    ...(configured ? { configured } : {}),
    create: randomUUID,
    label: "session epoch",
    validate: (value) => value.length >= 16 && value.length <= 256,
  });
}

export function loadOrCreateRoomSecret(file: string, configured?: string): Promise<string> {
  return loadOrCreatePrivateValue({
    file,
    ...(configured ? { configured } : {}),
    create: roomSecret,
    label: "room secret",
    validate: (value) => /^[A-Za-z0-9_-]{40,}$/.test(value) && Buffer.from(value, "base64url").byteLength >= 32,
  });
}

export function payloadHash(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
export function utf8(value: string): Uint8Array { return textEncoder.encode(value); }
export function fromUtf8(value: Uint8Array): string { return textDecoder.decode(value); }
