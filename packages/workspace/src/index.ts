import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { WorkspaceCheckpoint } from "@multicode/protocol";

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

export interface ParticipantWorkspaceState {
  root: string;
  originalBranch: string | null;
  originalHead: string;
  roomBranch: string;
  backupRef: string | null;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

async function gitWithEnv(cwd: string, args: string[], environment: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, ...environment },
    encoding: "utf8",
    maxBuffer: 40 * 1024 * 1024,
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

export async function createWorkspaceCheckpoint(options: {
  cwd: string;
  roomId: string;
  sequence: number;
  baseCommit: string;
  parentCommit?: string;
  force?: boolean;
}): Promise<WorkspaceCheckpoint | null> {
  const repository = await inspectRepository(options.cwd);
  const roomId = sanitizeRoomId(options.roomId);
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "multicode-checkpoint-"));
  const indexPath = path.join(temporaryDirectory, "index");
  const bundlePath = path.join(temporaryDirectory, "checkpoint.bundle");
  const checkpointRef = `refs/multicode/checkpoints/${roomId}`;
  const gitEnvironment = { GIT_INDEX_FILE: indexPath };

  try {
    await gitWithEnv(repository.root, ["read-tree", repository.head], gitEnvironment);
    await gitWithEnv(repository.root, ["add", "-A", "--", "."], gitEnvironment);
    const tree = await gitWithEnv(repository.root, ["write-tree"], gitEnvironment);
    const parent = options.parentCommit ?? options.baseCommit;
    const parentTree = await git(repository.root, ["rev-parse", `${parent}^{tree}`]);
    if (!options.force && tree === parentTree) return null;
    const commit = await gitWithEnv(repository.root, ["commit-tree", tree, "-p", parent, "-m", `MultiCode checkpoint ${options.sequence}`], {
      ...gitEnvironment,
      GIT_AUTHOR_NAME: "MultiCode",
      GIT_AUTHOR_EMAIL: "multicode@localhost",
      GIT_COMMITTER_NAME: "MultiCode",
      GIT_COMMITTER_EMAIL: "multicode@localhost",
    });
    await git(repository.root, ["update-ref", checkpointRef, commit]);
    await git(repository.root, ["bundle", "create", bundlePath, checkpointRef, `^${options.baseCommit}`]);
    const bundle = (await readFile(bundlePath)).toString("base64");
    if (bundle.length > 32 * 1024 * 1024) throw new Error("Workspace checkpoint exceeds the 32 MiB relay limit");
    return {
      sequence: options.sequence,
      baseCommit: options.baseCommit,
      commit,
      ref: checkpointRef,
      bundle,
      createdAt: new Date().toISOString(),
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function prepareParticipantWorkspace(options: {
  cwd: string;
  roomId: string;
  baseCommit: string;
}): Promise<ParticipantWorkspaceState> {
  const repository = await inspectRepository(options.cwd);
  await git(repository.root, ["cat-file", "-e", `${options.baseCommit}^{commit}`]).catch(() => {
    throw new Error(`This repository does not contain the room's base commit ${options.baseCommit.slice(0, 12)}`);
  });

  const roomId = sanitizeRoomId(options.roomId);
  const originalHead = repository.head;
  const originalBranch = repository.branch;
  let backupRef: string | null = null;
  if (repository.dirty) {
    await git(repository.root, ["stash", "push", "--include-untracked", "-m", `MultiCode backup before ${roomId}`]);
    const stashCommit = await git(repository.root, ["rev-parse", "stash@{0}"]);
    backupRef = `refs/multicode/backups/${roomId}/${Date.now()}`;
    await git(repository.root, ["update-ref", backupRef, stashCommit]);
  }

  const roomBranch = `multicode/room-${roomId}`;
  await git(repository.root, ["switch", "-C", roomBranch, options.baseCommit]);
  return { root: repository.root, originalBranch, originalHead, roomBranch, backupRef };
}

export async function applyWorkspaceCheckpoint(state: ParticipantWorkspaceState, checkpoint: WorkspaceCheckpoint): Promise<void> {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "multicode-apply-"));
  const bundlePath = path.join(temporaryDirectory, "checkpoint.bundle");
  const localRef = `refs/multicode/received/${sanitizeRoomId(state.roomBranch)}`;
  try {
    await writeFile(bundlePath, Buffer.from(checkpoint.bundle, "base64"));
    await git(state.root, ["bundle", "verify", bundlePath]);
    await git(state.root, ["fetch", bundlePath, `${checkpoint.ref}:${localRef}`]);
    const receivedCommit = await git(state.root, ["rev-parse", localRef]);
    if (receivedCommit !== checkpoint.commit) throw new Error("Received checkpoint hash does not match the host");
    await git(state.root, ["reset", "--hard", checkpoint.commit]);
    await git(state.root, ["clean", "-fd"]);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function restoreParticipantWorkspace(state: ParticipantWorkspaceState): Promise<void> {
  if (state.originalBranch) await git(state.root, ["switch", state.originalBranch]);
  else await git(state.root, ["switch", "--detach", state.originalHead]);
  if (state.backupRef) await git(state.root, ["stash", "apply", "--index", state.backupRef]);
}
