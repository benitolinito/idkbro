import { describe, expect, it, vi } from "vitest";
import { resolveHostingDirectory } from "./host-workspace.js";

describe("resolveHostingDirectory", () => {
  it("keeps an ordinary repository as the hosting directory", async () => {
    await expect(resolveHostingDirectory("/repo", vi.fn(async () => null))).resolves.toBe("/repo");
  });

  it("redirects a managed room worktree to its original repository", async () => {
    const inspect = vi.fn(async () => ({
      role: "shared" as const,
      roomId: "room",
      repositoryRoot: "/original/repo",
      sessionDirectory: "/sessions/room",
    }));

    await expect(resolveHostingDirectory("/sessions/room/shared", inspect)).resolves.toBe("/original/repo");
  });

  it("leaves repository errors for the CLI to report", async () => {
    const inspect = vi.fn(async () => { throw new Error("not a repository"); });
    await expect(resolveHostingDirectory("/not-a-repo", inspect)).resolves.toBe("/not-a-repo");
  });
});
