import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { requestLocalIpc } from "@multicode/session-core";

export interface LiveSessionLocation {
  roomId: string;
  directory: string;
}

type LiveSessionProbe = (directory: string, roomId: string) => Promise<boolean>;

async function hasLiveDaemon(directory: string, roomId: string): Promise<boolean> {
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\multicode-${roomId}`
    : path.join(directory, "daemon.sock");
  try {
    const token = (await readFile(path.join(directory, "token"), "utf8")).trim();
    const status = await requestLocalIpc<{ roomId?: unknown }>(socketPath, token, { type: "status" }, 500);
    return status.roomId === roomId;
  } catch {
    return false;
  }
}

/** Find the one live room associated with a checkout, ignoring historical markers. */
export async function discoverLiveSessionForWorkspace(
  root: string,
  cwd: string,
  probe: LiveSessionProbe = hasLiveDaemon,
): Promise<LiveSessionLocation> {
  const resolvedCwd = path.resolve(cwd);
  const matches: LiveSessionLocation[] = [];

  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    try {
      const marker = JSON.parse(await readFile(path.join(directory, ".multicode-session.json"), "utf8")) as {
        repositoryRoot?: string;
        sharedPath?: string;
        agentPath?: string;
        roomId?: string;
      };
      if (![marker.repositoryRoot, marker.sharedPath, marker.agentPath].some((candidate) => candidate && path.resolve(candidate) === resolvedCwd)) continue;
      const roomId = marker.roomId ?? entry.name;
      if (await probe(directory, roomId)) matches.push({ roomId, directory });
    } catch {
      // Ignore unrelated and incomplete historical session directories.
    }
  }

  if (matches.length === 0) {
    throw new Error("No live MultiCode session is associated with this checkout; specify --session <room-id>");
  }
  if (matches.length > 1) {
    throw new Error(`Multiple live MultiCode sessions are associated with this checkout (${matches.map((match) => match.roomId).join(", ")}); specify --session <room-id>`);
  }
  return matches[0] as LiveSessionLocation;
}
