import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  applyWorkspaceCheckpoint,
  cleanupParticipantWorkspace,
  createTaskWorktree,
  createRoomWorktrees,
  createWorkspaceCheckpoint,
  inspectRepository,
  prepareParticipantWorkspace,
  restoreParticipantWorkspace,
  sanitizeRoomId,
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
  });
});
