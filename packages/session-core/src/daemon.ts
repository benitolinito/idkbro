#!/usr/bin/env node
import path from "node:path";
import { homedir } from "node:os";
import { sanitizeRoomId } from "@multicode/workspace";
import { HostSession, LocalIpcServer, loadOrCreateRoomSecret, loadOrCreateSessionEpoch, PostgresJournal, SqliteJournal, writeSessionToken } from "./index.js";

const configuredRoomSecret = process.env.MULTICODE_ROOM_SECRET;
if (!configuredRoomSecret) throw new Error("MULTICODE_ROOM_SECRET is required so a restarted daemon can decrypt its room journal");
const sessionId = sanitizeRoomId(process.env.MULTICODE_SESSION_ID ?? "local");
const sessionDirectory = path.join(homedir(), ".multicode", "sessions", sessionId);
const token = await writeSessionToken(path.join(sessionDirectory, "token"));
const persistedRoomSecret = await loadOrCreateRoomSecret(path.join(sessionDirectory, "room-secret"), configuredRoomSecret);
const sessionEpoch = await loadOrCreateSessionEpoch(path.join(sessionDirectory, "epoch"), process.env.MULTICODE_SESSION_EPOCH);
const databaseUrl = process.env.MULTICODE_DATABASE_URL;
const journal = databaseUrl ? new PostgresJournal(databaseUrl) : new SqliteJournal(path.join(sessionDirectory, "session.db"));
if (journal instanceof PostgresJournal) await journal.migrate();
const session = new HostSession(sessionId, sessionEpoch, persistedRoomSecret, journal);
await session.recover();
const ipc = new LocalIpcServer(token, async (payload) => {
  const request = payload as { type?: string; actorId?: string; fileId?: string; update?: string };
  if (request.type === "document.update" && request.actorId && request.fileId && request.update) {
    const result = await session.applyDocumentUpdate(request.actorId, request.fileId, Buffer.from(request.update, "base64url"));
    return { ...result, update: Buffer.from(result.update).toString("base64url") };
  }
  return { sessionId, status: "ready" };
});
await ipc.listen(process.platform === "win32" ? `\\\\.\\pipe\\multicode-${sessionId}` : path.join(sessionDirectory, "daemon.sock"));
const closeJournal = async () => { if (journal instanceof PostgresJournal) await journal.close(); else journal.close(); };
process.on("SIGINT", () => void ipc.close().then(closeJournal));
process.on("SIGTERM", () => void ipc.close().then(closeJournal));
