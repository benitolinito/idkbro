import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverLiveSessionForWorkspace } from "./live-session.js";

const temporaryDirectories: string[] = [];

async function session(root: string, roomId: string, repositoryRoot: string): Promise<string> {
  const directory = path.join(root, roomId);
  await mkdir(directory);
  await writeFile(path.join(directory, ".multicode-session.json"), JSON.stringify({ roomId, repositoryRoot }));
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("discoverLiveSessionForWorkspace", () => {
  it("ignores stale matching rooms and returns the live room", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "multicode-live-session-")); temporaryDirectories.push(root);
    const repository = "/repo/project";
    await session(root, "stale-room", repository);
    const live = await session(root, "live-room", repository);

    await expect(discoverLiveSessionForWorkspace(root, repository, async (directory) => directory === live))
      .resolves.toEqual({ roomId: "live-room", directory: live });
  });

  it("rejects ambiguous live rooms instead of selecting by directory order", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "multicode-live-session-")); temporaryDirectories.push(root);
    const repository = "/repo/project";
    await session(root, "room-one", repository);
    await session(root, "room-two", repository);

    await expect(discoverLiveSessionForWorkspace(root, repository, async () => true))
      .rejects.toThrow("Multiple live MultiCode sessions");
  });

  it("reports when only historical matching rooms remain", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "multicode-live-session-")); temporaryDirectories.push(root);
    const repository = "/repo/project";
    await session(root, "stale-room", repository);

    await expect(discoverLiveSessionForWorkspace(root, repository, async () => false))
      .rejects.toThrow("No live MultiCode session");
  });
});
