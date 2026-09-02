import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  applyWorkspaceCheckpoint,
  applyPortableWorkspaceCheckpoint,
  applyDirectWorkspaceCheckpoint,
  closeDirectHostedWorkspace,
  cleanupLegacyHostedWorkspace,
  cleanupParticipantWorkspace,
  createTaskWorktree,
  createRoomWorktrees,
  createWorkspaceCheckpoint,
  createPortableWorkspaceCheckpoint,
  decryptWorkspaceCheckpointBundle,
  encryptWorkspaceCheckpointBundle,
  inspectDirectCheckout,
  inspectManagedRoomWorktree,
  inspectRepository,
  mergeAgentWorkspace,
  prepareParticipantWorkspace,
  prepareAgentTurnWorkspace,
  prepareDirectHostedWorkspace,
  prepareDirectParticipantWorkspace,
  restoreParticipantWorkspace,
  releaseDirectCheckoutLease,
  sanitizeRoomId,
  WorkspaceProjectionTracker,
} from "./index.js";

const execFileAsync = promisify(execFile);

describe("sanitizeRoomId", () => {
  it("creates a safe branch and directory segment", () => {
    expect(sanitizeRoomId("Room 42 / Auth Refactor")).toBe("room-42-auth-refactor");
  });

  it("rejects an empty result", () => {
    expect(() => sanitizeRoomId("///")).toThrow(/letter or number/);
  });
});

describe("workspace projection tracking", () => {
  it("recognizes repeated watcher echoes without importing them as edits", () => {
    const projections = new WorkspaceProjectionTracker();
    const readme = "# MultiCode\n\nOne shared document.\n";
    projections.record("README.md", readme, { fileId: "readme", documentEpoch: 1, authoritySequence: 42 });

    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      expect(projections.matches("README.md", readme, { fileId: "readme", documentEpoch: 1 })).toBe(true);
    }
    expect(projections.matches("README.md", readme, { fileId: "other", documentEpoch: 1 })).toBe(false);
    expect(projections.matches("README.md", readme, { fileId: "readme", documentEpoch: 2 })).toBe(false);
    expect(projections.matches("README.md", `${readme}\nExternal edit.\n`, { fileId: "readme", documentEpoch: 1 })).toBe(false);
  });

  it("moves and retires projection identity with manifest operations", () => {
    const projections = new WorkspaceProjectionTracker();
    projections.record("src/old.ts", "export const value = 1;\n", { fileId: "value", documentEpoch: 3, authoritySequence: 7 });
    projections.move("src/old.ts", "src/new.ts");

    expect(projections.get("src/old.ts")).toBeUndefined();
    expect(projections.get("src/new.ts")).toMatchObject({ fileId: "value", documentEpoch: 3, authoritySequence: 7 });
    projections.forget("src/new.ts");
    expect(projections.get("src/new.ts")).toBeUndefined();
  });
});

describe("Git worktrees", () => {
  it("creates an isolated branch from the repository HEAD", async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), "multicode-repo-"));
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "multicode-data-"));
    await execFileAsync("git", ["init", "-q", fixture]);
    await execFileAsync("git", ["-C", fixture, "config", "user.email", "multicode@example.invalid"]);
    await execFileAsync("git", ["-C", fixture, "config", "user.name", "MultiCode"]);
    await execFileAsync("git", ["-C", fixture, "commit", "--allow-empty", "-qm", "initial"]);

    const repository = await inspectRepository(fixture);
    const worktree = await createTaskWorktree({ cwd: fixture, roomId: "Auth Room", dataDirectory });

    expect(worktree.branch).toBe("multicode/auth-room");
    expect(worktree.baseCommit).toBe(repository.head);
    expect(await inspectRepository(worktree.path)).toMatchObject({
      root: worktree.path,
      head: repository.head,
      branch: "multicode/auth-room",
      dirty: false,
    });
  });
});

describe("workspace checkpoints", () => {
  it("synchronizes only an isolated participant room worktree", async () => {
    const host = await mkdtemp(path.join(tmpdir(), "multicode-host-"));
    const participant = await mkdtemp(path.join(tmpdir(), "multicode-participant-"));
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "multicode-participant-data-"));
    await execFileAsync("git", ["init", "-q", host]);
    await execFileAsync("git", ["-C", host, "config", "user.email", "multicode@example.invalid"]);
    await execFileAsync("git", ["-C", host, "config", "user.name", "MultiCode"]);
    await writeFile(path.join(host, "shared.txt"), "initial\n");
    await execFileAsync("git", ["-C", host, "add", "shared.txt"]);
    await execFileAsync("git", ["-C", host, "commit", "-qm", "initial"]);
    const baseCommit = (await execFileAsync("git", ["-C", host, "rev-parse", "HEAD"])).stdout.trim();
    await execFileAsync("git", ["clone", "-q", host, participant]);
    const originalHead = (await execFileAsync("git", ["-C", participant, "rev-parse", "HEAD"])).stdout.trim();

    await writeFile(path.join(participant, "local.txt"), "keep me\n");
    await writeFile(path.join(host, "shared.txt"), "synchronized\n");
    await writeFile(path.join(host, "added.txt"), "new file\n");
    const checkpoint = await createWorkspaceCheckpoint({ cwd: host, roomId: "room-1", sequence: 1, baseCommit });
    expect(checkpoint).not.toBeNull();
    if (!checkpoint) throw new Error("Expected a checkpoint");
    const state = await prepareParticipantWorkspace({ cwd: participant, roomId: "room-1", baseCommit, dataDirectory });

    await applyWorkspaceCheckpoint(state, checkpoint);
    expect(await readFile(path.join(state.root, "shared.txt"), "utf8")).toBe("synchronized\n");
    expect(await readFile(path.join(state.root, "added.txt"), "utf8")).toBe("new file\n");
    expect((await execFileAsync("git", ["-C", state.root, "rev-parse", "HEAD"])).stdout.trim()).toBe(checkpoint.commit);
    expect(await readFile(path.join(participant, "shared.txt"), "utf8")).toBe("initial\n");
    expect(await readFile(path.join(participant, "local.txt"), "utf8")).toBe("keep me\n");
    expect((await execFileAsync("git", ["-C", participant, "rev-parse", "HEAD"])).stdout.trim()).toBe(originalHead);

    await restoreParticipantWorkspace(state);
    expect(await readFile(path.join(participant, "local.txt"), "utf8")).toBe("keep me\n");
    expect((await execFileAsync("git", ["-C", participant, "rev-parse", "HEAD"])).stdout.trim()).toBe(originalHead);
  });

  it("refuses to overwrite dirty participant room worktrees", async () => {
    const host = await mkdtemp(path.join(tmpdir(), "multicode-dirty-host-"));
    const participant = await mkdtemp(path.join(tmpdir(), "multicode-dirty-participant-"));
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "multicode-dirty-data-"));
    await execFileAsync("git", ["init", "-q", host]);
    await execFileAsync("git", ["-C", host, "config", "user.email", "multicode@example.invalid"]);
    await execFileAsync("git", ["-C", host, "config", "user.name", "MultiCode"]);
    await writeFile(path.join(host, "shared.txt"), "initial\n");
    await execFileAsync("git", ["-C", host, "add", "shared.txt"]);
    await execFileAsync("git", ["-C", host, "commit", "-qm", "initial"]);
    const baseCommit = (await execFileAsync("git", ["-C", host, "rev-parse", "HEAD"])).stdout.trim();
    await execFileAsync("git", ["clone", "-q", host, participant]);
    const state = await prepareParticipantWorkspace({ cwd: participant, roomId: "room-dirty", baseCommit, dataDirectory });

    await writeFile(path.join(host, "shared.txt"), "remote\n");
    const checkpoint = await createWorkspaceCheckpoint({ cwd: host, roomId: "room-dirty", sequence: 1, baseCommit });
    expect(checkpoint).not.toBeNull();
    if (!checkpoint) throw new Error("Expected a checkpoint");
    await writeFile(path.join(state.root, "shared.txt"), "local\n");
    await writeFile(path.join(state.root, "untracked.txt"), "preserve me\n");

    await expect(applyWorkspaceCheckpoint(state, checkpoint)).rejects.toThrow(/unacknowledged local changes/);
    expect(await readFile(path.join(state.root, "shared.txt"), "utf8")).toBe("local\n");
    expect(await readFile(path.join(state.root, "untracked.txt"), "utf8")).toBe("preserve me\n");
    expect((await execFileAsync("git", ["-C", state.root, "rev-parse", "HEAD"])).stdout.trim()).toBe(baseCommit);
  });

  it("rejects a tampered room ownership marker", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "multicode-marker-repo-"));
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "multicode-marker-data-"));
    await execFileAsync("git", ["init", "-q", repository]);
    await execFileAsync("git", ["-C", repository, "config", "user.email", "multicode@example.invalid"]);
    await execFileAsync("git", ["-C", repository, "config", "user.name", "MultiCode"]);
    await execFileAsync("git", ["-C", repository, "commit", "--allow-empty", "-qm", "initial"]);
    const baseCommit = (await execFileAsync("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
    const state = await prepareParticipantWorkspace({ cwd: repository, roomId: "room-marker", baseCommit, dataDirectory });
    const marker = JSON.parse(await readFile(state.markerPath, "utf8")) as Record<string, unknown>;
    await writeFile(state.markerPath, JSON.stringify({ ...marker, repositoryRoot: "/tmp/not-the-repository" }));

    await expect(restoreParticipantWorkspace(state)).rejects.toThrow(/validated MultiCode room worktree/);
  });

  it("removes a preserved room workspace only through explicit cleanup", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "multicode-cleanup-repo-"));
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "multicode-cleanup-data-"));
    await execFileAsync("git", ["init", "-q", repository]);
    await execFileAsync("git", ["-C", repository, "config", "user.email", "multicode@example.invalid"]);
    await execFileAsync("git", ["-C", repository, "config", "user.name", "MultiCode"]);
    await writeFile(path.join(repository, "file.txt"), "original\n");
    await execFileAsync("git", ["-C", repository, "add", "file.txt"]);
    await execFileAsync("git", ["-C", repository, "commit", "-qm", "initial"]);
    const baseCommit = (await execFileAsync("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
    const state = await prepareParticipantWorkspace({ cwd: repository, roomId: "room-cleanup", baseCommit, dataDirectory });

    await writeFile(path.join(state.root, "local.txt"), "keep until forced\n");
    await expect(cleanupParticipantWorkspace({ roomId: state.roomId, dataDirectory })).rejects.toThrow(/unacknowledged local changes/);
    expect(await readFile(path.join(state.root, "local.txt"), "utf8")).toBe("keep until forced\n");

    const removed = await cleanupParticipantWorkspace({ roomId: state.roomId, dataDirectory, force: true });
    expect(removed).toBe(state.root);
    await expect(readFile(state.markerPath, "utf8")).rejects.toThrow();
    expect(await readFile(path.join(repository, "file.txt"), "utf8")).toBe("original\n");
  });
});

describe("portable workspace mirrors", () => {
  it("materializes a self-contained encrypted snapshot without a participant clone", async () => {
    const host = await mkdtemp(path.join(tmpdir(), "multicode-portable-host-"));
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "multicode-portable-data-"));
    await execFileAsync("git", ["init", "-q", host]);
    await execFileAsync("git", ["-C", host, "config", "user.email", "multicode@example.invalid"]);
    await execFileAsync("git", ["-C", host, "config", "user.name", "MultiCode"]);
    await writeFile(path.join(host, "shared.txt"), "initial\n");
    await execFileAsync("git", ["-C", host, "add", "shared.txt"]);
    await execFileAsync("git", ["-C", host, "commit", "-qm", "initial"]);
    const baseCommit = (await execFileAsync("git", ["-C", host, "rev-parse", "HEAD"])).stdout.trim();
    await writeFile(path.join(host, "shared.txt"), "host version\n");
    await writeFile(path.join(host, "new.txt"), "visible to both users\n");
    const internal = await createWorkspaceCheckpoint({ cwd: host, roomId: "portable-room", sequence: 1, baseCommit });
    if (!internal) throw new Error("Expected internal checkpoint");
    const portable = await createPortableWorkspaceCheckpoint({ cwd: host, roomId: "portable-room", sequence: 1, baseCommit, sourceCommit: internal.commit });

    const key = Buffer.alloc(32, 7);
    const encrypted = encryptWorkspaceCheckpointBundle(key, portable.sequence, Buffer.from(portable.bundle, "base64"));
    expect(encrypted.includes(Buffer.from("visible to both users"))).toBe(false);
    const decrypted = decryptWorkspaceCheckpointBundle(key, portable.sequence, encrypted);
    const state = await applyPortableWorkspaceCheckpoint({
      dataDirectory,
      roomId: "portable-room",
      checkpoint: { ...portable, bundle: decrypted.toString("base64") },
    });

    expect(await readFile(path.join(state.root, "shared.txt"), "utf8")).toBe("host version\n");
    expect(await readFile(path.join(state.root, "new.txt"), "utf8")).toBe("visible to both users\n");
    expect((await execFileAsync("git", ["-C", state.root, "rev-list", "--count", "HEAD"])).stdout.trim()).toBe("1");
    expect((await execFileAsync("git", ["-C", state.root, "status", "--short"])).stdout).toBe(" M shared.txt\n?? new.txt\n");
  });

  it("updates a clean mirror but preserves an accidental participant edit", async () => {
    const host = await mkdtemp(path.join(tmpdir(), "multicode-portable-update-host-"));
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "multicode-portable-update-data-"));
    await execFileAsync("git", ["init", "-q", host]);
    await execFileAsync("git", ["-C", host, "config", "user.email", "multicode@example.invalid"]);
    await execFileAsync("git", ["-C", host, "config", "user.name", "MultiCode"]);
    await writeFile(path.join(host, "file.txt"), "base\n");
    await execFileAsync("git", ["-C", host, "add", "file.txt"]);
    await execFileAsync("git", ["-C", host, "commit", "-qm", "base"]);
    const baseCommit = (await execFileAsync("git", ["-C", host, "rev-parse", "HEAD"])).stdout.trim();

    await writeFile(path.join(host, "file.txt"), "one\n");
    const firstInternal = await createWorkspaceCheckpoint({ cwd: host, roomId: "portable-update", sequence: 1, baseCommit });
    if (!firstInternal) throw new Error("Expected first checkpoint");
    const first = await createPortableWorkspaceCheckpoint({ cwd: host, roomId: "portable-update", sequence: 1, baseCommit, sourceCommit: firstInternal.commit });
    const state = await applyPortableWorkspaceCheckpoint({ dataDirectory, roomId: "portable-update", checkpoint: first });

    await writeFile(path.join(host, "file.txt"), "two\n");
    const secondInternal = await createWorkspaceCheckpoint({ cwd: host, roomId: "portable-update", sequence: 2, baseCommit, parentCommit: firstInternal.commit });
    if (!secondInternal) throw new Error("Expected second checkpoint");
    const second = await createPortableWorkspaceCheckpoint({ cwd: host, roomId: "portable-update", sequence: 2, baseCommit, sourceCommit: secondInternal.commit });
    await applyPortableWorkspaceCheckpoint({ dataDirectory, roomId: "portable-update", checkpoint: second });
    expect(await readFile(path.join(state.root, "file.txt"), "utf8")).toBe("two\n");
    expect((await execFileAsync("git", ["-C", state.root, "status", "--short"])).stdout).toBe(" M file.txt\n");

    await writeFile(path.join(state.root, "file.txt"), "participant edit\n");
    await expect(applyPortableWorkspaceCheckpoint({ dataDirectory, roomId: "portable-update", checkpoint: second })).rejects.toThrow(/local changes/);
    await writeFile(path.join(host, "file.txt"), "three\n");
    const thirdInternal = await createWorkspaceCheckpoint({ cwd: host, roomId: "portable-update", sequence: 3, baseCommit, parentCommit: secondInternal.commit });
    if (!thirdInternal) throw new Error("Expected third checkpoint");
    const third = await createPortableWorkspaceCheckpoint({ cwd: host, roomId: "portable-update", sequence: 3, baseCommit, sourceCommit: thirdInternal.commit });
    await expect(applyPortableWorkspaceCheckpoint({ dataDirectory, roomId: "portable-update", checkpoint: third })).rejects.toThrow(/local changes/);
    expect(await readFile(path.join(state.root, "file.txt"), "utf8")).toBe("participant edit\n");
  });

  it("rejects a checkpoint encrypted for another sequence", () => {
    const key = Buffer.alloc(32, 9);
    const encrypted = encryptWorkspaceCheckpointBundle(key, 3, Buffer.from("bundle"));
    expect(() => decryptWorkspaceCheckpointBundle(key, 4, encrypted)).toThrow();
  });
});

describe("v2 host room worktrees", () => {
  it("creates separate shared and agent worktrees without changing the original checkout", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "multicode-host-room-"));
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "multicode-host-data-"));
    await execFileAsync("git", ["init", "-q", repository]);
    await execFileAsync("git", ["-C", repository, "config", "user.email", "multicode@example.invalid"]);
    await execFileAsync("git", ["-C", repository, "config", "user.name", "MultiCode"]);
    await writeFile(path.join(repository, "file.txt"), "base\n");
    await execFileAsync("git", ["-C", repository, "add", "."]); await execFileAsync("git", ["-C", repository, "commit", "-qm", "base"]);
    await writeFile(path.join(repository, "file.txt"), "unsaved\n");
    const room = await createRoomWorktrees({ cwd: repository, roomId: "room", dataDirectory });
    expect(await readFile(path.join(room.sharedPath, "file.txt"), "utf8")).toBe("unsaved\n");
    expect(await readFile(path.join(room.agentPath, "file.txt"), "utf8")).toBe("unsaved\n");
    expect(await readFile(path.join(repository, "file.txt"), "utf8")).toBe("unsaved\n");
    expect(await inspectManagedRoomWorktree(repository)).toBeNull();
    const repositoryRoot = await realpath(repository);
    expect(await inspectManagedRoomWorktree(room.sharedPath)).toMatchObject({ role: "shared", roomId: "room", repositoryRoot });
    expect(await inspectManagedRoomWorktree(room.agentPath)).toMatchObject({ role: "agent", roomId: "room", repositoryRoot });

    const removed = await cleanupLegacyHostedWorkspace({ roomId: room.roomId, dataDirectory });
    expect(removed).toMatchObject({ repositoryRoot, sharedPath: room.sharedPath, agentPath: room.agentPath });
    await expect(readFile(path.join(room.sharedPath, "file.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(room.agentPath, "file.txt"), "utf8")).rejects.toThrow();
  });

  it("retries prompt preparation while the agent index has a transient lock", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "multicode-agent-lock-repo-"));
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "multicode-agent-lock-data-"));
    await execFileAsync("git", ["init", "-q", repository]);
    await execFileAsync("git", ["-C", repository, "config", "user.email", "multicode@example.invalid"]);
    await execFileAsync("git", ["-C", repository, "config", "user.name", "MultiCode"]);
    await writeFile(path.join(repository, "file.txt"), "base\n");
    await execFileAsync("git", ["-C", repository, "add", "."]); await execFileAsync("git", ["-C", repository, "commit", "-qm", "base"]);
    const room = await createRoomWorktrees({ cwd: repository, roomId: "agent-lock-room", dataDirectory });
    const agentGitDirectory = (await execFileAsync("git", ["-C", room.agentPath, "rev-parse", "--git-dir"])).stdout.trim();
    const indexLock = path.resolve(room.agentPath, agentGitDirectory, "index.lock");
    await writeFile(indexLock, "transient lock");
    const release = setTimeout(() => { void rm(indexLock, { force: true }); }, 100);
    try {
      await expect(prepareAgentTurnWorkspace({ sharedPath: room.sharedPath, agentPath: room.agentPath, roomId: room.roomId, sequence: 1, baseCommit: room.baseCommit, parentCommit: room.checkpointCommit })).resolves.toMatchObject({ sequence: 1 });
    } finally {
      clearTimeout(release);
      await rm(indexLock, { force: true });
    }
  });

  it("merges independent human and agent edits including agent-created files", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "multicode-merge-repo-"));
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "multicode-merge-data-"));
    await execFileAsync("git", ["init", "-q", repository]);
    await execFileAsync("git", ["-C", repository, "config", "user.email", "multicode@example.invalid"]);
    await execFileAsync("git", ["-C", repository, "config", "user.name", "MultiCode"]);
    await writeFile(path.join(repository, "agent.txt"), "base agent\n"); await writeFile(path.join(repository, "human.txt"), "base human\n");
    await execFileAsync("git", ["-C", repository, "add", "."]); await execFileAsync("git", ["-C", repository, "commit", "-qm", "base"]);
    const room = await createRoomWorktrees({ cwd: repository, roomId: "merge-room", dataDirectory });
    const turn = await prepareAgentTurnWorkspace({ sharedPath: room.sharedPath, agentPath: room.agentPath, roomId: room.roomId, sequence: 1, baseCommit: room.baseCommit, parentCommit: room.checkpointCommit });
    await writeFile(path.join(room.agentPath, "agent.txt"), "agent changed\n"); await writeFile(path.join(room.agentPath, "created.txt"), "new agent file\n");
    await writeFile(path.join(room.sharedPath, "human.txt"), "human changed\n");

    expect(await mergeAgentWorkspace({ sharedPath: room.sharedPath, agentPath: room.agentPath, sessionDirectory: room.sessionDirectory, roomId: room.roomId, baseCommit: room.baseCommit, turn, withCommitLock: async (operation) => operation() })).toMatchObject({ status: "merged" });
    expect(await readFile(path.join(room.sharedPath, "agent.txt"), "utf8")).toBe("agent changed\n");
    expect(await readFile(path.join(room.sharedPath, "human.txt"), "utf8")).toBe("human changed\n");
    expect(await readFile(path.join(room.sharedPath, "created.txt"), "utf8")).toBe("new agent file\n");
  }, 15_000);

  it("keeps shared files untouched and writes an external proposal on conflict", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "multicode-conflict-repo-"));
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "multicode-conflict-data-"));
    await execFileAsync("git", ["init", "-q", repository]);
    await execFileAsync("git", ["-C", repository, "config", "user.email", "multicode@example.invalid"]);
    await execFileAsync("git", ["-C", repository, "config", "user.name", "MultiCode"]);
    await writeFile(path.join(repository, "same.txt"), "base\n"); await execFileAsync("git", ["-C", repository, "add", "."]); await execFileAsync("git", ["-C", repository, "commit", "-qm", "base"]);
    const room = await createRoomWorktrees({ cwd: repository, roomId: "conflict-room", dataDirectory });
    const turn = await prepareAgentTurnWorkspace({ sharedPath: room.sharedPath, agentPath: room.agentPath, roomId: room.roomId, sequence: 1, baseCommit: room.baseCommit, parentCommit: room.checkpointCommit });
    await writeFile(path.join(room.agentPath, "same.txt"), "agent\n"); await writeFile(path.join(room.sharedPath, "same.txt"), "human\n");

    const result = await mergeAgentWorkspace({ sharedPath: room.sharedPath, agentPath: room.agentPath, sessionDirectory: room.sessionDirectory, roomId: room.roomId, baseCommit: room.baseCommit, turn, withCommitLock: async (operation) => operation() });
    expect(result.status).toBe("conflicted"); expect(result.proposalPath).toContain(path.join(room.sessionDirectory, "proposals"));
    expect(await readFile(path.join(room.sharedPath, "same.txt"), "utf8")).toBe("human\n");
    expect(await readFile(result.proposalPath as string, "utf8")).toContain("+agent");
  });

  it("rolls the filesystem patch back when the durable workspace commit fails", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "multicode-rollback-repo-")); const dataDirectory = await mkdtemp(path.join(tmpdir(), "multicode-rollback-data-"));
    await execFileAsync("git", ["init", "-q", repository]); await execFileAsync("git", ["-C", repository, "config", "user.email", "multicode@example.invalid"]); await execFileAsync("git", ["-C", repository, "config", "user.name", "MultiCode"]);
    await writeFile(path.join(repository, "file.txt"), "base\n"); await execFileAsync("git", ["-C", repository, "add", "."]); await execFileAsync("git", ["-C", repository, "commit", "-qm", "base"]);
    const room = await createRoomWorktrees({ cwd: repository, roomId: "rollback-room", dataDirectory }); const turn = await prepareAgentTurnWorkspace({ sharedPath: room.sharedPath, agentPath: room.agentPath, roomId: room.roomId, sequence: 1, baseCommit: room.baseCommit, parentCommit: room.checkpointCommit });
    await writeFile(path.join(room.agentPath, "file.txt"), "agent\n");
    await expect(mergeAgentWorkspace({ sharedPath: room.sharedPath, agentPath: room.agentPath, sessionDirectory: room.sessionDirectory, roomId: room.roomId, baseCommit: room.baseCommit, turn, withCommitLock: async (operation) => operation(), onCommitted: async () => { throw new Error("journal failed"); } })).rejects.toThrow(/journal failed/);
    expect(await readFile(path.join(room.sharedPath, "file.txt"), "utf8")).toBe("base\n");
  });
});

describe("direct host workspace", () => {
  it("uses the original clean checkout without creating another worktree", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "multicode-direct-host-"));
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "multicode-direct-data-"));
    await execFileAsync("git", ["init", "-q", repository]);
    await execFileAsync("git", ["-C", repository, "config", "user.email", "multicode@example.invalid"]);
    await execFileAsync("git", ["-C", repository, "config", "user.name", "MultiCode"]);
    await writeFile(path.join(repository, "README.md"), "# Direct room\n");
    await execFileAsync("git", ["-C", repository, "add", "README.md"]);
    await execFileAsync("git", ["-C", repository, "commit", "-qm", "initial"]);

    const hosted = await prepareDirectHostedWorkspace({ cwd: repository, roomId: "direct-room", dataDirectory });
    const root = await realpath(repository);
    expect(hosted.workspacePath).toBe(root);
    expect(await readFile(path.join(hosted.workspacePath, "README.md"), "utf8")).toBe("# Direct room\n");
    await expect(readFile(path.join(hosted.sessionDirectory, "shared", "README.md"), "utf8")).rejects.toThrow();
    expect(await inspectManagedRoomWorktree(hosted.workspacePath)).toBeNull();
    const worktrees = (await execFileAsync("git", ["-C", root, "worktree", "list", "--porcelain"])).stdout;
    expect(worktrees.match(/^worktree /gm)).toHaveLength(1);

    await writeFile(path.join(hosted.workspacePath, "README.md"), "# Agent edited the host checkout\n");
    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("# Agent edited the host checkout\n");
    const checkpoint = await createWorkspaceCheckpoint({
      cwd: hosted.workspacePath,
      roomId: hosted.roomId,
      sequence: 2,
      baseCommit: hosted.baseCommit,
      parentCommit: hosted.checkpointCommit,
      force: true,
    });
    if (!checkpoint) throw new Error("Expected a host checkpoint");
    const portable = await createPortableWorkspaceCheckpoint({
      cwd: hosted.workspacePath,
      roomId: hosted.roomId,
      sequence: checkpoint.sequence,
      baseCommit: hosted.baseCommit,
      sourceCommit: checkpoint.commit,
    });
    const mirror = await applyPortableWorkspaceCheckpoint({ dataDirectory, roomId: hosted.roomId, checkpoint: portable });
    expect(await readFile(path.join(mirror.root, "README.md"), "utf8")).toBe("# Agent edited the host checkout\n");

    const lease = JSON.parse(await readFile(hosted.lease.path, "utf8")) as Record<string, unknown>;
    expect(lease).toMatchObject({ version: 3, roomId: "direct-room", repositoryRoot: root, baseCommit: hosted.baseCommit, initialTree: hosted.initialTree });
    await closeDirectHostedWorkspace(hosted);
    await expect(readFile(hosted.lease.path, "utf8")).rejects.toThrow();
    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("# Agent edited the host checkout\n");
  });

  it("rejects dirty or mismatched checkouts before creating direct-room state", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "multicode-direct-dirty-"));
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "multicode-direct-dirty-data-"));
    await execFileAsync("git", ["init", "-q", repository]);
    await execFileAsync("git", ["-C", repository, "config", "user.email", "multicode@example.invalid"]);
    await execFileAsync("git", ["-C", repository, "config", "user.name", "MultiCode"]);
    await writeFile(path.join(repository, "file.txt"), "base\n");
    await execFileAsync("git", ["-C", repository, "add", "file.txt"]);
    await execFileAsync("git", ["-C", repository, "commit", "-qm", "initial"]);
    const clean = await inspectDirectCheckout({ cwd: repository });
    await writeFile(path.join(repository, "file.txt"), "dirty\n");

    await expect(inspectDirectCheckout({ cwd: repository })).rejects.toThrow(/Commit or stash/);
    await expect(prepareDirectHostedWorkspace({ cwd: repository, roomId: "dirty-room", dataDirectory })).rejects.toThrow(/Commit or stash/);
    await expect(readFile(path.join(dataDirectory, "dirty-room", ".multicode-session.json"), "utf8")).rejects.toThrow();
    await execFileAsync("git", ["-C", repository, "restore", "file.txt"]);
    await expect(inspectDirectCheckout({ cwd: repository, expectedBaseCommit: "0".repeat(clean.head.length) })).rejects.toThrow(/does not match room base/);
  });

  it("allows only one direct room to lease a checkout", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "multicode-direct-lease-"));
    const firstData = await mkdtemp(path.join(tmpdir(), "multicode-direct-first-"));
    const secondData = await mkdtemp(path.join(tmpdir(), "multicode-direct-second-"));
    await execFileAsync("git", ["init", "-q", repository]);
    await execFileAsync("git", ["-C", repository, "config", "user.email", "multicode@example.invalid"]);
    await execFileAsync("git", ["-C", repository, "config", "user.name", "MultiCode"]);
    await execFileAsync("git", ["-C", repository, "commit", "--allow-empty", "-qm", "initial"]);
    const first = await prepareDirectHostedWorkspace({ cwd: repository, roomId: "first", dataDirectory: firstData });

    await expect(prepareDirectHostedWorkspace({ cwd: repository, roomId: "second", dataDirectory: secondData })).rejects.toThrow(/already leased by room first/);
    await expect(readFile(path.join(secondData, "second", ".multicode-session.json"), "utf8")).rejects.toThrow();
    await releaseDirectCheckoutLease(first.lease);
  });
});

describe("v3 direct participant workspace", () => {
  it("projects checkpoints into the original checkout without moving HEAD", async () => {
    const host = await mkdtemp(path.join(tmpdir(), "multicode-direct-participant-host-"));
    const participant = await mkdtemp(path.join(tmpdir(), "multicode-direct-participant-"));
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "multicode-direct-participant-data-"));
    await execFileAsync("git", ["init", "-q", host]);
    await execFileAsync("git", ["-C", host, "config", "user.email", "multicode@example.invalid"]);
    await execFileAsync("git", ["-C", host, "config", "user.name", "MultiCode"]);
    await writeFile(path.join(host, "README.md"), "initial\n");
    await execFileAsync("git", ["-C", host, "add", "README.md"]);
    await execFileAsync("git", ["-C", host, "commit", "-qm", "initial"]);
    const baseCommit = (await execFileAsync("git", ["-C", host, "rev-parse", "HEAD"])).stdout.trim();
    await execFileAsync("git", ["clone", "-q", host, participant]);
    await writeFile(path.join(host, "README.md"), "room edit\n");
    await writeFile(path.join(host, "added.txt"), "added in room\n");
    const checkpoint = await createWorkspaceCheckpoint({ cwd: host, roomId: "direct-join", sequence: 1, baseCommit });
    if (!checkpoint) throw new Error("Expected checkpoint");

    const state = await prepareDirectParticipantWorkspace({ cwd: participant, roomId: "direct-join", baseCommit, dataDirectory });
    expect(state.root).toBe(await realpath(participant));
    await applyDirectWorkspaceCheckpoint(state, checkpoint);

    expect(await readFile(path.join(participant, "README.md"), "utf8")).toBe("room edit\n");
    expect(await readFile(path.join(participant, "added.txt"), "utf8")).toBe("added in room\n");
    expect((await execFileAsync("git", ["-C", participant, "rev-parse", "HEAD"])).stdout.trim()).toBe(baseCommit);
    expect((await execFileAsync("git", ["-C", participant, "status", "--porcelain"])).stdout).toContain("README.md");

    expect(await cleanupParticipantWorkspace({ roomId: state.roomId, dataDirectory })).toBe(state.root);
    expect(await readFile(path.join(participant, "README.md"), "utf8")).toBe("room edit\n");
    await expect(readFile(state.markerPath, "utf8")).rejects.toThrow();
  });

  it("refuses a later checkpoint after an unsynchronized local edit", async () => {
    const host = await mkdtemp(path.join(tmpdir(), "multicode-direct-conflict-host-"));
    const participant = await mkdtemp(path.join(tmpdir(), "multicode-direct-conflict-participant-"));
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "multicode-direct-conflict-data-"));
    await execFileAsync("git", ["init", "-q", host]);
    await execFileAsync("git", ["-C", host, "config", "user.email", "multicode@example.invalid"]);
    await execFileAsync("git", ["-C", host, "config", "user.name", "MultiCode"]);
    await writeFile(path.join(host, "file.txt"), "base\n");
    await execFileAsync("git", ["-C", host, "add", "file.txt"]);
    await execFileAsync("git", ["-C", host, "commit", "-qm", "base"]);
    const baseCommit = (await execFileAsync("git", ["-C", host, "rev-parse", "HEAD"])).stdout.trim();
    await execFileAsync("git", ["clone", "-q", host, participant]);
    const state = await prepareDirectParticipantWorkspace({ cwd: participant, roomId: "direct-conflict", baseCommit, dataDirectory });

    await writeFile(path.join(host, "file.txt"), "first\n");
    const first = await createWorkspaceCheckpoint({ cwd: host, roomId: state.roomId, sequence: 1, baseCommit });
    if (!first) throw new Error("Expected first checkpoint");
    await applyDirectWorkspaceCheckpoint(state, first);
    await writeFile(path.join(participant, "file.txt"), "local unsynchronized\n");
    await writeFile(path.join(host, "file.txt"), "second\n");
    const second = await createWorkspaceCheckpoint({ cwd: host, roomId: state.roomId, sequence: 2, baseCommit, parentCommit: first.commit });
    if (!second) throw new Error("Expected second checkpoint");

    await expect(applyDirectWorkspaceCheckpoint(state, second)).rejects.toThrow(/Local checkout changed/);
    expect(await readFile(path.join(participant, "file.txt"), "utf8")).toBe("local unsynchronized\n");
  });
});
