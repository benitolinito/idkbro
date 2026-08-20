#!/usr/bin/env node
import path from "node:path";
import { homedir } from "node:os";
import { FileJournal, HostSession, LocalIpcServer, PostgresJournal, writeSessionToken } from "./index.js";

const roomSecret = process.env.MULTICODE_ROOM_SECRET;
if (!roomSecret) throw new Error("MULTICODE_ROOM_SECRET is required so a restarted daemon can decrypt its room journal");
const sessionId = process.env.MULTICODE_SESSION_ID ?? "local";
const sessionDirectory = path.join(homedir(), ".multicode", "sessions", sessionId);
const token = await writeSessionToken(path.join(sessionDirectory, "token"));
const databaseUrl = process.env.MULTICODE_DATABASE_URL;
const journal = databaseUrl ? new PostgresJournal(databaseUrl) : new FileJournal(path.join(sessionDirectory, "journal.jsonl"));
if (journal instanceof PostgresJournal) await journal.migrate();
const session = new HostSession(sessionId, process.env.MULTICODE_SESSION_EPOCH ?? crypto.randomUUID(), roomSecret, journal);
const ipc = new LocalIpcServer(token, async (payload) => {
  const request = payload as { type?: string; actorId?: string; fileId?: string; update?: string };
  if (request.type === "document.update" && request.actorId && request.fileId && request.update) {
    const result = await session.applyDocumentUpdate(request.actorId, request.fileId, Buffer.from(request.update, "base64url"));
    return { ...result, update: Buffer.from(result.update).toString("base64url") };
  }
  return { sessionId, status: "ready" };
});
await ipc.listen(process.platform === "win32" ? `\\\\.\\pipe\\multicode-${sessionId}` : path.join(sessionDirectory, "daemon.sock"));
const closeJournal = async () => { if (journal instanceof PostgresJournal) await journal.close(); };
process.on("SIGINT", () => void ipc.close().then(closeJournal));
process.on("SIGTERM", () => void ipc.close().then(closeJournal));
