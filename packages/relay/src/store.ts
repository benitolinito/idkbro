import { createHash } from "node:crypto";
import { Pool } from "pg";

export interface RelayRoomStore {
  migrate(): Promise<void>;
  roomOpened(room: { roomId: string; ownerIp: string }): Promise<void>;
  appendEvent(roomId: string, event: { id: string; kind: string; payload: string }): Promise<void>;
  roomClosed(roomId: string): Promise<void>;
  close(): Promise<void>;
}

/** Stores routing metadata only. End-to-end encrypted room data never reaches this store. */
export class PostgresRelayRoomStore implements RelayRoomStore {
  private readonly pool: Pool;
  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, ssl: connectionString.includes("localhost") || connectionString.includes("127.0.0.1") ? false : { rejectUnauthorized: true } });
  }
  async migrate(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS multicode_relay_rooms (
      room_id text PRIMARY KEY, owner_ip_hash text NOT NULL, opened_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz
    )`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS multicode_relay_events (
      room_id text NOT NULL REFERENCES multicode_relay_rooms(room_id) ON DELETE CASCADE,
      event_id uuid NOT NULL,
      kind text NOT NULL,
      payload text NOT NULL,
      sequence bigserial NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (room_id, event_id)
    )`);
  }
  async appendEvent(roomId: string, event: { id: string; kind: string; payload: string }): Promise<void> {
    await this.pool.query("INSERT INTO multicode_relay_events (room_id, event_id, kind, payload) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [roomId, event.id, event.kind, event.payload]);
  }
  async roomOpened(room: { roomId: string; ownerIp: string }): Promise<void> {
    const ownerIpHash = createHash("sha256").update(room.ownerIp).digest("hex");
    await this.pool.query("INSERT INTO multicode_relay_rooms (room_id, owner_ip_hash) VALUES ($1, $2) ON CONFLICT (room_id) DO UPDATE SET closed_at = NULL", [room.roomId, ownerIpHash]);
  }
  async roomClosed(roomId: string): Promise<void> { await this.pool.query("UPDATE multicode_relay_rooms SET closed_at = now() WHERE room_id = $1", [roomId]); }
  async close(): Promise<void> { await this.pool.end(); }
}
