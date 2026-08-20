import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
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

export interface RoomWorktrees {
  roomId: string;
  baseCommit: string;
  checkpointCommit: string;
  sharedPath: string;
  agentPath: string;
  sessionDirectory: string;
}

export interface ManagedRoomWorktree {
  role: "shared" | "agent";
  roomId: string;
  repositoryRoot: string;
  sessionDirectory: string;
}

export interface ParticipantWorkspaceState {
  /** Isolated MultiCode room worktree; never the user's original checkout. */
  root: string;
  originalRoot: string;
  originalBranch: string | null;
  originalHead: string;
  roomBranch: string;
  backupRef: string | null;
  roomId: string;
  markerPath: string;
  creationNonce: string;
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

export async function inspectManagedRoomWorktree(cwd: string): Promise<ManagedRoomWorktree | null> {
  const repository = await inspectRepository(cwd);
  const sessionDirectory = path.dirname(repository.root);
  const markerPath = path.join(sessionDirectory, ".multicode-session.json");
  let marker: unknown;
  try {
    marker = JSON.parse(await readFile(markerPath, "utf8"));
  } catch {
    return null;
  }
  if (!marker || typeof marker !== "object") return null;
  const value = marker as Record<string, unknown>;
  if (value.version !== 2 || typeof value.roomId !== "string" || typeof value.repositoryRoot !== "string") return null;
  const current = path.resolve(repository.root);
  const role = typeof value.sharedPath === "string" && path.resolve(value.sharedPath) === current
    ? "shared"
    : typeof value.agentPath === "string" && path.resolve(value.agentPath) === current
      ? "agent"
      : null;
  if (!role) return null;
  return { role, roomId: value.roomId, repositoryRoot: value.repositoryRoot, sessionDirectory };
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

/** Creates the two isolated projections used by a v2 host session. */
export async function createRoomWorktrees(options: {
  cwd: string;
  roomId: string;
  dataDirectory?: string;
}): Promise<RoomWorktrees> {
  const repository = await inspectRepository(options.cwd);
  if (repository.operationInProgress) throw new Error("Cannot create a room while a Git operation is in progress");
  const roomId = sanitizeRoomId(options.roomId);
  const dataDirectory = options.dataDirectory ?? path.join(homedir(), ".multicode", "sessions");
  const sessionDirectory = path.join(dataDirectory, roomId);
  const sharedPath = path.join(sessionDirectory, "shared");
  const agentPath = path.join(sessionDirectory, "agent");
  try { await access(sessionDirectory); throw new Error(`Session directory already exists for ${roomId}`); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  try {
    const checkpoint = await createWorkspaceCheckpoint({ cwd: repository.root, roomId, sequence: 1, baseCommit: repository.head, force: true });
    if (!checkpoint) throw new Error("Unable to create initial room checkpoint");
    await git(repository.root, ["worktree", "add", "--detach", sharedPath, checkpoint.commit]);
    await git(repository.root, ["worktree", "add", "--detach", agentPath, checkpoint.commit]);
    const [shared, agent] = await Promise.all([realpath(sharedPath), realpath(agentPath)]);
    await writeFile(path.join(sessionDirectory, ".multicode-session.json"), JSON.stringify({ version: 2, roomId, repositoryRoot: repository.root, baseCommit: repository.head, checkpointCommit: checkpoint.commit, sharedPath: shared, agentPath: agent, creationNonce: randomBytes(32).toString("base64url") }, null, 2), { mode: 0o600 });
    return { roomId, baseCommit: repository.head, checkpointCommit: checkpoint.commit, sharedPath: shared, agentPath: agent, sessionDirectory };
  } catch (error) {
    // Cleanup is limited to the newly created, deterministic session directory.
    await git(repository.root, ["worktree", "remove", "--force", sharedPath]).catch(() => undefined);
    await git(repository.root, ["worktree", "remove", "--force", agentPath]).catch(() => undefined);
    await rm(sessionDirectory, { recursive: true, force: true });
    throw error;
  }
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
  dataDirectory?: string;
}): Promise<ParticipantWorkspaceState> {
  const repository = await inspectRepository(options.cwd);
  await git(repository.root, ["cat-file", "-e", `${options.baseCommit}^{commit}`]).catch(() => {
    throw new Error(`This repository does not contain the room's base commit ${options.baseCommit.slice(0, 12)}`);
  });

  const roomId = sanitizeRoomId(options.roomId);
  const roomBranch = `multicode/room-${roomId}`;
  const dataDirectory = options.dataDirectory ?? path.join(homedir(), ".multicode", "sessions");
  const roomDirectory = path.join(dataDirectory, "rooms", roomId);
  const workspacePath = path.join(roomDirectory, "workspace");
  const markerPath = path.join(roomDirectory, ".multicode-room.json");
  try {
    await access(workspacePath);
    throw new Error(`A MultiCode room workspace already exists for ${roomId}; remove it explicitly before joining again`);
  } catch (error) {
    if (!(error instanceof Error) || !/ENOENT/.test(String((error as NodeJS.ErrnoException).code))) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await mkdir(roomDirectory, { recursive: true, mode: 0o700 });
  await git(repository.root, ["worktree", "add", "--detach", workspacePath, options.baseCommit]);
  const root = await realpath(workspacePath);
  if (root === repository.root) throw new Error("Refusing to use the original checkout as a room worktree");
  const creationNonce = randomBytes(32).toString("base64url");
  await writeFile(markerPath, JSON.stringify({ version: 2, roomId, repositoryRoot: repository.root, workspacePath: root, creationNonce }, null, 2), { mode: 0o600 });
  return {
    root,
    originalRoot: repository.root,
    originalBranch: repository.branch,
    originalHead: repository.head,
    roomBranch,
    backupRef: null,
    roomId,
    markerPath,
    creationNonce,
  };
}

async function verifyParticipantWorktree(state: ParticipantWorkspaceState): Promise<void> {
  const [root, originalRoot, markerPath] = await Promise.all([
    realpath(state.root),
    realpath(state.originalRoot),
    realpath(state.markerPath),
  ]);
  const expectedMarkerPath = path.join(path.dirname(root), ".multicode-room.json");
  if (
    root !== path.resolve(state.root)
    || originalRoot !== path.resolve(state.originalRoot)
    || markerPath !== expectedMarkerPath
    || path.basename(root) !== "workspace"
    || path.basename(path.dirname(root)) !== state.roomId
  ) {
    throw new Error("Refusing destructive operation outside the validated MultiCode room worktree");
  }

  let marker: Record<string, unknown>;
  try {
    marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("Refusing destructive operation because the MultiCode room marker is invalid");
  }
  if (
    marker.version !== 2
    || marker.roomId !== state.roomId
    || marker.repositoryRoot !== originalRoot
    || marker.workspacePath !== root
    || marker.creationNonce !== state.creationNonce
    || typeof state.creationNonce !== "string"
    || state.creationNonce.length < 32
    || root === originalRoot
  ) {
    throw new Error("Refusing destructive operation outside the validated MultiCode room worktree");
  }

  const [worktreeCommonDirectory, originalCommonDirectory] = await Promise.all([
    git(root, ["rev-parse", "--git-common-dir"]),
    git(originalRoot, ["rev-parse", "--git-common-dir"]),
  ]);
  const [canonicalWorktreeCommonDirectory, canonicalOriginalCommonDirectory] = await Promise.all([
    realpath(path.resolve(root, worktreeCommonDirectory)),
    realpath(path.resolve(originalRoot, originalCommonDirectory)),
  ]);
  if (canonicalWorktreeCommonDirectory !== canonicalOriginalCommonDirectory) {
    throw new Error("Refusing destructive operation because the room marker belongs to another repository");
  }

  const worktrees = await git(originalRoot, ["worktree", "list", "--porcelain"]);
  if (!worktrees.split("\n").some((line) => line === `worktree ${root}`)) throw new Error("Room worktree is no longer registered by Git");
}

async function assertParticipantWorktreeClean(state: ParticipantWorkspaceState): Promise<void> {
  const status = await git(state.root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status) {
    throw new Error(
      "Room workspace has unacknowledged local changes; refusing to reset it. Preserve or export those changes before resynchronizing",
    );
  }
}

export async function applyWorkspaceCheckpoint(state: ParticipantWorkspaceState, checkpoint: WorkspaceCheckpoint): Promise<void> {
  await verifyParticipantWorktree(state);
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "multicode-apply-"));
  const bundlePath = path.join(temporaryDirectory, "checkpoint.bundle");
  const localRef = `refs/multicode/received/${sanitizeRoomId(state.roomId)}`;
  try {
    await writeFile(bundlePath, Buffer.from(checkpoint.bundle, "base64"));
    await git(state.root, ["bundle", "verify", bundlePath]);
    await git(state.root, ["fetch", bundlePath, `${checkpoint.ref}:${localRef}`]);
    const receivedCommit = await git(state.root, ["rev-parse", localRef]);
    if (receivedCommit !== checkpoint.commit) throw new Error("Received checkpoint hash does not match the host");
    await assertParticipantWorktreeClean(state);
    await git(state.root, ["reset", "--hard", checkpoint.commit]);
    await git(state.root, ["clean", "-fd"]);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function restoreParticipantWorkspace(state: ParticipantWorkspaceState): Promise<void> {
  // Joining never touches the original checkout, so leaving deliberately preserves
  // the room worktree for recovery/export instead of switching or stashing anything.
  await verifyParticipantWorktree(state);
}

/** Explicitly removes a preserved participant room worktree after validating its marker and repository identity. */
export async function cleanupParticipantWorkspace(options: {
  roomId: string;
  dataDirectory?: string;
  force?: boolean;
}): Promise<string> {
  const roomId = sanitizeRoomId(options.roomId);
  const dataDirectory = options.dataDirectory ?? path.join(homedir(), ".multicode", "sessions");
  const roomDirectory = path.join(dataDirectory, "rooms", roomId);
  const markerPath = path.join(roomDirectory, ".multicode-room.json");
  let marker: Record<string, unknown>;
  try {
    marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(`No valid preserved MultiCode room workspace exists for ${roomId}`);
  }
  if (typeof marker.repositoryRoot !== "string" || typeof marker.workspacePath !== "string" || typeof marker.creationNonce !== "string") {
    throw new Error(`No valid preserved MultiCode room workspace exists for ${roomId}`);
  }
  const repository = await inspectRepository(marker.repositoryRoot);
  const state: ParticipantWorkspaceState = {
    root: marker.workspacePath,
    originalRoot: marker.repositoryRoot,
    originalBranch: repository.branch,
    originalHead: repository.head,
    roomBranch: `multicode/room-${roomId}`,
    backupRef: null,
    roomId,
    markerPath,
    creationNonce: marker.creationNonce,
  };
  await verifyParticipantWorktree(state);
  if (!options.force) await assertParticipantWorktreeClean(state);
  await git(state.originalRoot, ["worktree", "remove", ...(options.force ? ["--force"] : []), state.root]);
  await rm(path.dirname(state.root), { recursive: true, force: false });
  return state.root;
}

export interface AgentTurnSnapshot { commit: string; sequence: number }
export interface WorkspaceChange { operation: "create" | "update" | "delete" | "rename"; path: string; sourcePath?: string }
export interface PendingWorkspaceProposal { version: 1; sequence: number; roomId: string; baseCommit: string; agentCommit: string; humanCommit: string; patchPath: string; createdAt: string; status: "pending" }

async function captureSnapshotCommit(options: { cwd: string; roomId: string; sequence: number; baseCommit: string; parentCommit: string }): Promise<string> {
  const checkpoint = await createWorkspaceCheckpoint({ ...options, force: true });
  if (!checkpoint) throw new Error("Unable to capture workspace state");
  return checkpoint.commit;
}

async function verifyOwnedHostWorktrees(sharedPath: string, agentPath: string, roomId: string): Promise<void> {
  const shared = await realpath(sharedPath); const agent = await realpath(agentPath); const sessionDirectory = path.dirname(shared); const markerPath = path.join(sessionDirectory, ".multicode-session.json");
  if (path.dirname(agent) !== sessionDirectory || path.basename(shared) !== "shared" || path.basename(agent) !== "agent") throw new Error("Refusing destructive operation outside MultiCode-owned host worktrees");
  const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
  if (marker.version !== 2 || marker.roomId !== sanitizeRoomId(roomId) || marker.sharedPath !== shared || marker.agentPath !== agent || typeof marker.creationNonce !== "string" || marker.creationNonce.length < 32) throw new Error("Refusing destructive operation because the host worktree marker is invalid");
  const [sharedCommon, agentCommon] = await Promise.all([git(shared, ["rev-parse", "--git-common-dir"]), git(agent, ["rev-parse", "--git-common-dir"])]);
  if (await realpath(path.resolve(shared, sharedCommon)) !== await realpath(path.resolve(agent, agentCommon))) throw new Error("Host worktrees do not belong to the same repository");
}

export async function prepareAgentTurnWorkspace(options: { sharedPath: string; agentPath: string; roomId: string; sequence: number; baseCommit: string; parentCommit: string }): Promise<AgentTurnSnapshot> {
  await verifyOwnedHostWorktrees(options.sharedPath, options.agentPath, options.roomId);
  const commit = await captureSnapshotCommit({ cwd: options.sharedPath, roomId: `${options.roomId}-turn-base`, sequence: options.sequence, baseCommit: options.baseCommit, parentCommit: options.parentCommit });
  await git(options.agentPath, ["reset", "--hard", commit]);
  await git(options.agentPath, ["clean", "-fd"]);
  return { commit, sequence: options.sequence };
}

async function applyPatch(cwd: string, patchText: string, check: boolean, reverse = false): Promise<void> {
  if (!patchText) return;
  await new Promise<void>((resolve, reject) => {
    const child = execFile("git", ["apply", ...(check ? ["--check"] : []), ...(reverse ? ["--reverse"] : []), "--whitespace=nowarn", "-"], { cwd }, (error, _stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve());
    child.stdin?.end(patchText);
  });
}

async function tree(cwd: string, commit: string): Promise<string> { return git(cwd, ["rev-parse", `${commit}^{tree}`]); }
async function gitRaw(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 })).stdout;
}

export async function mergeAgentWorkspace(options: {
  sharedPath: string;
  agentPath: string;
  sessionDirectory: string;
  roomId: string;
  baseCommit: string;
  turn: AgentTurnSnapshot;
  withCommitLock: <T>(operation: () => Promise<T>) => Promise<T>;
  onApplied?: (changes: WorkspaceChange[]) => Promise<void>;
}): Promise<{ status: "unchanged" | "merged" | "conflicted"; proposalPath?: string; changes?: WorkspaceChange[] }> {
  await verifyOwnedHostWorktrees(options.sharedPath, options.agentPath, options.roomId);
  const agentCommit = await captureSnapshotCommit({ cwd: options.agentPath, roomId: `${options.roomId}-agent-final`, sequence: options.turn.sequence, baseCommit: options.baseCommit, parentCommit: options.turn.commit });
  if (await tree(options.agentPath, agentCommit) === await tree(options.agentPath, options.turn.commit)) return { status: "unchanged" };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const humanCommit = await captureSnapshotCommit({ cwd: options.sharedPath, roomId: `${options.roomId}-human-current`, sequence: options.turn.sequence + attempt, baseCommit: options.baseCommit, parentCommit: options.turn.commit });
    let mergedTree: string;
    try {
      mergedTree = (await git(options.sharedPath, ["merge-tree", "--write-tree", "--no-messages", `--merge-base=${options.turn.commit}`, humanCommit, agentCommit])).split("\n")[0] ?? "";
      if (!/^[a-f0-9]{40,64}$/.test(mergedTree)) throw new Error("Merge engine did not produce a tree");
    } catch {
      const proposal = await gitRaw(options.agentPath, ["diff", "--binary", options.turn.commit, agentCommit]);
      const proposalDirectory = path.join(options.sessionDirectory, "proposals"); await mkdir(proposalDirectory, { recursive: true });
      const proposalPath = path.join(proposalDirectory, `${options.turn.sequence}.patch`); await writeFile(proposalPath, proposal, "utf8");
      const metadata: PendingWorkspaceProposal = { version: 1, sequence: options.turn.sequence, roomId: options.roomId, baseCommit: options.turn.commit, agentCommit, humanCommit, patchPath: proposalPath, createdAt: new Date().toISOString(), status: "pending" };
      await writeFile(path.join(proposalDirectory, `${options.turn.sequence}.json`), JSON.stringify(metadata, null, 2), { mode: 0o600 });
      return { status: "conflicted", proposalPath };
    }
    const patchText = await gitRaw(options.sharedPath, ["diff", "--binary", humanCommit, mergedTree]);
    const nameStatus = await gitRaw(options.sharedPath, ["diff", "--name-status", "-M", "-z", humanCommit, mergedTree]);
    const fields = nameStatus.split("\0").filter(Boolean); const changes: WorkspaceChange[] = [];
    for (let index = 0; index < fields.length;) {
      const status = fields[index++] as string;
      if (status.startsWith("R")) { const sourcePath = fields[index++] as string; const destinationPath = fields[index++] as string; changes.push({ operation: "rename", sourcePath, path: destinationPath }); }
      else { const filePath = fields[index++] as string; changes.push({ operation: status === "A" ? "create" : status === "D" ? "delete" : "update", path: filePath }); }
    }
    const applied = await options.withCommitLock(async () => {
      const verification = await captureSnapshotCommit({ cwd: options.sharedPath, roomId: `${options.roomId}-merge-verify`, sequence: options.turn.sequence + attempt, baseCommit: options.baseCommit, parentCommit: humanCommit });
      if (await tree(options.sharedPath, verification) !== await tree(options.sharedPath, humanCommit)) return false;
      await applyPatch(options.sharedPath, patchText, true);
      await applyPatch(options.sharedPath, patchText, false);
      try { await options.onApplied?.(changes); }
      catch (error) { await applyPatch(options.sharedPath, patchText, false, true); throw error; }
      return true;
    });
    if (applied) return { status: "merged", changes };
  }
  throw new Error("Human workspace kept changing during merge; retry the Codex proposal later");
}
