import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, hkdfSync, randomBytes, randomUUID, sign, verify } from "node:crypto";
import { mkdir, chmod, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { Pool } from "pg";
import * as Y from "yjs";
import type { EnvelopeV2 } from "@multicode/protocol";

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
}

export class PostgresJournal {
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
}

export interface DocumentUpdateResult {
  fileId: string;
  sequence: number;
  update: Uint8Array;
}

/** The host-side authority for durable Yjs operations. */
export class HostSession {
  readonly documents = new CollaborativeDocuments();
  private readonly key: Buffer;

  constructor(
    readonly roomId: string,
    readonly sessionEpoch: string,
    secret: string,
    private readonly journal: DurableJournal,
  ) { this.key = deriveRoomKey(secret, roomId, sessionEpoch); }

  async applyDocumentUpdate(actorId: string, fileId: string, update: Uint8Array, correlationId = randomUUID()): Promise<DocumentUpdateResult> {
    const payload = new Uint8Array(update);
    const envelope: EnvelopeV2 = {
      protocolVersion: 2,
      roomId: this.roomId,
      sessionEpoch: this.sessionEpoch,
      messageId: randomUUID(),
      actorId,
      correlationId,
      payloadType: "document.update",
      payloadLength: payload.byteLength,
      payloadHash: payloadHash(payload),
    };
    const persisted = await this.journal.append(envelope, encryptPayload(this.key, payload, `${this.roomId}:${envelope.messageId}`));
    this.documents.apply(fileId, payload, actorId);
    return { fileId, sequence: persisted.sequence, update: payload };
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

export async function writeSessionToken(file: string, token = randomBytes(32).toString("base64url")): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, `${token}\n`, { mode: 0o600 }); await chmod(file, 0o600); return token;
}

export function payloadHash(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
export function utf8(value: string): Uint8Array { return textEncoder.encode(value); }
export function fromUtf8(value: Uint8Array): string { return textDecoder.decode(value); }
