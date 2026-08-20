import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { CollaborativeDocuments, createHostIdentity, decryptPayload, deriveRoomKey, encryptPayload, FileJournal, HostSession, LocalIpcServer, loadOrCreateRoomSecret, loadOrCreateSessionEpoch, requestLocalIpc, roomSecret, signCapability, SqliteJournal, utf8, verifyCapability, WorkspaceManifest, type DurableJournal, type EncryptedPayload } from "./index.js";

function sessionText(session: HostSession, filePath: string): string {
  const record = session.manifest.fileByPath(filePath);
  if (!record) return "";
  return session.documents.document(record.fileId).getText("content").toString();
}

describe("session cryptography", () => {
  it("encrypts payloads with a room-epoch key", () => {
    const key = deriveRoomKey(roomSecret(), "room", "epoch");
    const encrypted = encryptPayload(key, utf8("secret source"), "room:event");
    expect(new TextDecoder().decode(decryptPayload(key, encrypted, "room:event"))).toBe("secret source");
    expect(() => decryptPayload(key, encrypted, "other:event")).toThrow();
  });

  it("keeps host authority distinct from the shared room key", () => {
    const identity = createHostIdentity();
    const capability = utf8(JSON.stringify({ roomId: "room", actorId: randomUUID(), role: "collaborator" }));
    expect(verifyCapability(identity.publicKey, capability, signCapability(identity, capability))).toBe(true);
  });
});

describe("authenticated daemon IPC", () => {
  it("accepts the private token and rejects another token", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "multicode-ipc-")); const socketPath = path.join(directory, "daemon.sock"); const server = new LocalIpcServer("correct-token", async (payload) => ({ echo: payload })); await server.listen(socketPath);
    try { expect(await requestLocalIpc(socketPath, "correct-token", "hello")).toEqual({ echo: "hello" }); await expect(requestLocalIpc(socketPath, "wrong-token", "hello")).rejects.toThrow(/Unauthorized/); }
    finally { await server.close(); }
  });
});

describe("collaborative documents", () => {
  it("converges Yjs updates across documents", () => {
    const first = new CollaborativeDocuments();
    const second = new CollaborativeDocuments();
    const text = first.document("file").getText("content");
    text.insert(0, "hello");
    second.apply("file", first.snapshot("file"));
    expect(second.document("file").getText("content").toString()).toBe("hello");
  });
});

describe("host session durability", () => {
  it("uses a WAL-mode SQLite journal for durable ordered replay", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "multicode-session-sqlite-")); const databaseFile = path.join(directory, "session.db");
    const secret = roomSecret(); const journal = new SqliteJournal(databaseFile); const session = new HostSession("room", "sqlite-epoch-value", secret, journal);
    const source = new Y.Doc(); source.getText("content").insert(0, "sqlite durable"); await session.applyDocumentUpdate("ada", "file.ts", Y.encodeStateAsUpdate(source)); journal.close();
    const database = new DatabaseSync(databaseFile, { readOnly: true }); expect(database.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" }); database.close();
    const restartedJournal = new SqliteJournal(databaseFile); const restarted = new HostSession("room", "sqlite-epoch-value", secret, restartedJournal); await restarted.recover();
    expect(sessionText(restarted, "file.ts")).toBe("sqlite durable"); restartedJournal.close();
  });

  it("loads the latest encrypted SQLite snapshot before replaying later updates", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "multicode-session-compaction-")); const databaseFile = path.join(directory, "session.db"); const secret = roomSecret();
    const journal = new SqliteJournal(databaseFile); const session = new HostSession("room", "snapshot-epoch-value", secret, journal);
    await session.ensureDocumentText("system", "file.ts", "first"); expect(await session.compact()).toBe(1); await session.replaceDocumentText("ada", "file.ts", "second"); journal.close();
    const restartedJournal = new SqliteJournal(databaseFile); const restarted = new HostSession("room", "snapshot-epoch-value", secret, restartedJournal); const recovery = await restarted.recover();
    expect(recovery.replayedEntries).toBe(1); expect(sessionText(restarted, "file.ts")).toBe("second"); restartedJournal.close();
  });

  it("does not apply an update until its encrypted journal entry commits", async () => {
    const journal: DurableJournal = {
      append: async (envelope, payload: EncryptedPayload) => ({ roomId: envelope.roomId, sequence: 1, envelope: { ...envelope, sequence: 1 }, payload, createdAt: new Date().toISOString() }),
      replay: async () => [],
    };
    const session = new HostSession("room", "epoch", roomSecret(), journal);
    const source = new Y.Doc(); source.getText("content").insert(0, "durable");
    await session.applyDocumentUpdate("ada", "file", Y.encodeStateAsUpdate(source));
    expect(sessionText(session, "file")).toBe("durable");
  });

  it("leaves authoritative document state unchanged when journaling fails", async () => {
    const journal: DurableJournal = {
      append: async () => { throw new Error("disk unavailable"); },
      replay: async () => [],
    };
    const session = new HostSession("room", "epoch", roomSecret(), journal);
    const source = new Y.Doc(); source.getText("content").insert(0, "speculative");
    await expect(session.applyDocumentUpdate("ada", "file", Y.encodeStateAsUpdate(source))).rejects.toThrow(/disk unavailable/);
    expect(sessionText(session, "file")).toBe("");
  });

  it("rejects malformed Yjs updates before writing the journal", async () => {
    const appended: unknown[] = []; const journal: DurableJournal = { append: async (...args) => { appended.push(args); throw new Error("must not append"); }, replay: async () => [] };
    const session = new HostSession("room", "epoch", roomSecret(), journal);
    await expect(session.applyDocumentUpdate("ada", "file.ts", new Uint8Array([255, 255, 255]))).rejects.toThrow(/Malformed Yjs/);
    expect(appended).toEqual([]); expect(sessionText(session, "file.ts")).toBe("");
  });

  it("converges concurrent human updates and survives restart", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "multicode-convergence-")); const journalFile = path.join(directory, "journal.jsonl"); const secret = roomSecret();
    const session = new HostSession("room", "convergence-epoch", secret, new FileJournal(journalFile)); await session.ensureDocumentText("system", "file.ts", "start"); const snapshot = session.documentSnapshot("file.ts").update;
    const first = new Y.Doc(); const second = new Y.Doc(); Y.applyUpdate(first, snapshot); Y.applyUpdate(second, snapshot);
    let firstUpdate: Uint8Array<ArrayBufferLike> = new Uint8Array(); let secondUpdate: Uint8Array<ArrayBufferLike> = new Uint8Array(); first.once("update", (update: Uint8Array) => { firstUpdate = update; }); second.once("update", (update: Uint8Array) => { secondUpdate = update; });
    first.getText("content").insert(5, " A"); second.getText("content").insert(5, " B"); await Promise.all([session.applyDocumentUpdate("ada", "file.ts", firstUpdate), session.applyDocumentUpdate("grace", "file.ts", secondUpdate)]);
    const restarted = new HostSession("room", "convergence-epoch", secret, new FileJournal(journalFile)); await restarted.recover();
    const canonical = sessionText(session, "file.ts"); expect(sessionText(restarted, "file.ts")).toBe(canonical); expect(canonical).toContain(" A"); expect(canonical).toContain(" B");
  });

  it("replays encrypted document updates after a restart", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "multicode-session-recovery-"));
    const journalFile = path.join(directory, "journal.jsonl");
    const secret = roomSecret();
    const first = new HostSession("room", "epoch-that-is-stable", secret, new FileJournal(journalFile));
    const source = new Y.Doc();
    const updates: Uint8Array[] = [];
    source.on("update", (update: Uint8Array) => updates.push(update));
    source.getText("content").insert(0, "hello");
    source.getText("content").insert(5, " world");
    const results = await Promise.all(updates.map((update) => first.applyDocumentUpdate("ada", "file", update)));
    expect(results.map((result) => result.sequence)).toEqual([1, 2]);

    const restarted = new HostSession("room", "epoch-that-is-stable", secret, new FileJournal(journalFile));
    expect(await restarted.recover()).toEqual({ replayedEntries: 2, recoveredDocumentUpdates: 2, lastSequence: 2 });
    expect(sessionText(restarted, "file")).toBe("hello world");
  });

  it("rejects a tampered encrypted journal during recovery", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "multicode-session-tamper-"));
    const journalFile = path.join(directory, "journal.jsonl");
    const secret = roomSecret();
    const session = new HostSession("room", "epoch-that-is-stable", secret, new FileJournal(journalFile));
    const source = new Y.Doc(); source.getText("content").insert(0, "durable");
    await session.applyDocumentUpdate("ada", "file", Y.encodeStateAsUpdate(source));
    const entry = JSON.parse((await readFile(journalFile, "utf8")).trim()) as { payload: { ciphertext: string } };
    entry.payload.ciphertext = `${entry.payload.ciphertext.startsWith("A") ? "B" : "A"}${entry.payload.ciphertext.slice(1)}`;
    await writeFile(journalFile, `${JSON.stringify(entry)}\n`);

    await expect(new HostSession("room", "epoch-that-is-stable", secret, new FileJournal(journalFile)).recover()).rejects.toThrow();
  });

  it("persists daemon secrets and epochs and rejects configuration drift", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "multicode-session-identity-"));
    const epochFile = path.join(directory, "epoch");
    const secretFile = path.join(directory, "secret");
    const epoch = await loadOrCreateSessionEpoch(epochFile);
    const secret = await loadOrCreateRoomSecret(secretFile);
    expect(await loadOrCreateSessionEpoch(epochFile, epoch)).toBe(epoch);
    expect(await loadOrCreateRoomSecret(secretFile, secret)).toBe(secret);
    await expect(loadOrCreateSessionEpoch(epochFile, "different-epoch-value")).rejects.toThrow(/does not match/);
    await expect(loadOrCreateRoomSecret(secretFile, roomSecret())).rejects.toThrow(/does not match/);
  });
});

describe("workspace manifest", () => {
  it("preserves stable file identity across rename and advances epochs on delete", () => {
    const manifest = new WorkspaceManifest();
    const created = manifest.ensureTextFile("src/first.ts");
    const renamed = manifest.rename(created.fileId, "src/renamed.ts", manifest.snapshot().revision);
    expect(renamed.fileId).toBe(created.fileId);
    expect(manifest.fileByPath("src/first.ts")).toBeUndefined();
    expect(manifest.fileByPath("src/renamed.ts")?.fileId).toBe(created.fileId);
    const deleted = manifest.delete(created.fileId, manifest.snapshot().revision);
    expect(deleted.documentEpoch).toBe(2);
    expect(deleted.deleted).toBe(true);
  });

  it("rejects stale structural operations and escaping paths", () => {
    const manifest = new WorkspaceManifest();
    const created = manifest.ensureTextFile("safe.ts");
    expect(() => manifest.rename(created.fileId, "renamed.ts", 0)).toThrow(/revision changed/);
    expect(() => manifest.ensureTextFile("../escape.ts")).toThrow(/escapes/);
    expect(() => manifest.ensureTextFile("CON.txt")).toThrow(/portable/);
    expect(() => manifest.ensureTextFile("src/bad?.ts")).toThrow(/portable/);
  });

  it("rejects case-colliding paths on every platform", () => {
    const manifest = new WorkspaceManifest(); manifest.ensureTextFile("src/File.ts"); expect(() => manifest.ensureTextFile("src/file.ts")).toThrow(/already exists/);
  });

  it("durably replays create, rename, and delete operations", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "multicode-manifest-recovery-"));
    const journalFile = path.join(directory, "journal.jsonl");
    const secret = roomSecret();
    const session = new HostSession("room", "manifest-epoch-value", secret, new FileJournal(journalFile));
    const created = await session.applyManifestOperation("ada", { type: "create", path: "src/new.ts", content: "export const value = 1;\n", expectedRevision: 0 });
    const renamed = await session.applyManifestOperation("ada", { type: "rename", sourcePath: "src/new.ts", destinationPath: "src/value.ts", expectedRevision: 1 });
    expect(renamed.record.fileId).toBe(created.record.fileId);
    await session.applyManifestOperation("ada", { type: "delete", path: "src/value.ts", expectedRevision: 2 });

    const restarted = new HostSession("room", "manifest-epoch-value", secret, new FileJournal(journalFile));
    expect((await restarted.recover()).lastSequence).toBe(3);
    expect(restarted.manifest.file(created.record.fileId)).toMatchObject({ path: "src/value.ts", deleted: true, documentEpoch: 2 });
    expect(restarted.manifest.snapshot().revision).toBe(3);
  });

  it("commits and recovers a multi-file workspace transaction as one journal record", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "multicode-workspace-transaction-"));
    const journalFile = path.join(directory, "journal.jsonl");
    const secret = roomSecret();
    const session = new HostSession("room", "workspace-transaction-epoch", secret, new FileJournal(journalFile));
    const result = await session.applyWorkspaceTransaction("agent", [
      { type: "create", path: "src/one.ts", content: "one\n" },
      { type: "create", path: "src/two.ts", content: "two\n" },
    ]);
    expect(result.sequence).toBe(1);
    expect((await readFile(journalFile, "utf8")).trim().split("\n")).toHaveLength(1);

    const restarted = new HostSession("room", "workspace-transaction-epoch", secret, new FileJournal(journalFile));
    expect((await restarted.recover()).lastSequence).toBe(1);
    expect(sessionText(restarted, "src/one.ts")).toBe("one\n");
    expect(sessionText(restarted, "src/two.ts")).toBe("two\n");
  });

  it("applies none of a workspace transaction when its journal commit fails", async () => {
    const journal: DurableJournal = { append: async () => { throw new Error("journal failed"); }, replay: async () => [] };
    const session = new HostSession("room", "workspace-transaction-epoch", roomSecret(), journal);
    await expect(session.applyWorkspaceTransaction("agent", [
      { type: "create", path: "one.ts", content: "one" },
      { type: "create", path: "two.ts", content: "two" },
    ])).rejects.toThrow(/journal failed/);
    expect(session.manifest.snapshot().files).toEqual([]);
    expect(sessionText(session, "one.ts")).toBe("");
  });
});

describe("encrypted collaboration payloads", () => {
  it("cannot be decrypted with another room secret", () => {
    const first = deriveRoomKey(roomSecret(), "room", "epoch");
    const second = deriveRoomKey(roomSecret(), "room", "epoch");
    const payload = encryptPayload(first, utf8("Yjs update"), "room:message");
    expect(new TextDecoder().decode(decryptPayload(first, payload, "room:message"))).toBe("Yjs update");
    expect(() => decryptPayload(second, payload, "room:message")).toThrow();
  });
});
