import { execFile } from "node:child_process";
import { access, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RepositoryInfo {
  root: string;
  head: string;
  branch: string | null;
  dirty: boolean;
  operationInProgress: boolean;
}

export interface TaskWorktree {
  roomId: string;
  branch: string;
  path: string;
  baseCommit: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

export function sanitizeRoomId(roomId: string): string {
  const sanitized = roomId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

  if (!sanitized) {
    throw new Error("Room ID must contain at least one letter or number");
  }

  return sanitized;
}

export async function inspectRepository(cwd: string): Promise<RepositoryInfo> {
  let root: string;
  try {
    root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    throw new Error(`${cwd} is not inside a Git repository`);
  }

  const [head, branch, status, gitDir] = await Promise.all([
    git(root, ["rev-parse", "HEAD"]),
    git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => ""),
    git(root, ["status", "--porcelain=v1"]),
    git(root, ["rev-parse", "--git-dir"]),
  ]);

  const absoluteGitDir = path.resolve(root, gitDir);
  const markers = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"];
  const markerStates = await Promise.all(
    markers.map((marker) => access(path.join(absoluteGitDir, marker)).then(() => true, () => false)),
  );
  const operationInProgress = markerStates.some(Boolean);

  return {
    root,
    head,
    branch: branch || null,
    dirty: status.length > 0,
    operationInProgress,
  };
}

export async function createTaskWorktree(options: {
  cwd: string;
  roomId: string;
  dataDirectory?: string;
}): Promise<TaskWorktree> {
  const repository = await inspectRepository(options.cwd);
  if (repository.operationInProgress) {
    throw new Error("Cannot create a room while a merge, rebase, cherry-pick, or revert is in progress");
  }

  const roomId = sanitizeRoomId(options.roomId);
  const branch = `multicode/${roomId}`;
  const dataDirectory = options.dataDirectory ?? path.join(homedir(), ".multicode");
  const worktreePath = path.join(dataDirectory, "worktrees", roomId);
  await mkdir(path.dirname(worktreePath), { recursive: true });

  await git(repository.root, ["worktree", "add", "-b", branch, worktreePath, repository.head]);
  const canonicalWorktreePath = await realpath(worktreePath);

  return {
    roomId,
    branch,
    path: canonicalWorktreePath,
    baseCommit: repository.head,
  };
}
