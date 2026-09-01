import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, hkdfSync, randomBytes, randomUUID, sign, verify } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, chmod, open, readFile, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { Pool } from "pg";
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
