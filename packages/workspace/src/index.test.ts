import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createTaskWorktree, inspectRepository, sanitizeRoomId } from "./index.js";

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
