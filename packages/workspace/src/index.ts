import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { maxCheckpointBytes, type WorkspaceCheckpoint } from "@multicode/protocol";

const execFileAsync = promisify(execFile);
const maxCollaborativeTextBytes = 96 * 1024;

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

export interface DirectCheckoutLease {
  version: 3;
  roomId: string;
  repositoryRoot: string;
  sessionDirectory: string;
  baseCommit: string;
  initialTree: string;
  nonce: string;
  createdAt: string;
  path: string;
}

export interface DirectHostedWorkspace {
  roomId: string;
  workspacePath: string;
  agentPath: string;
  baseCommit: string;
  initialTree: string;
  checkpointCommit: string;
  sessionDirectory: string;
  lease: DirectCheckoutLease;
}

export interface DirectParticipantWorkspaceState {
  roomId: string;
  root: string;
  baseCommit: string;
  initialTree: string;
  sessionDirectory: string;
  markerPath: string;
  lease: DirectCheckoutLease;
  projectedCommit: string;
  checkpointSequence: number;
}

export interface ManagedRoomWorktree {
  version: 2 | 3;
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

export interface MirroredWorkspaceState {
  roomId: string;
  root: string;
  sequence: number;
  commit: string;
}

export interface WorkspaceProjectionIdentity {
  fileId?: string;
  documentEpoch?: number;
  authoritySequence?: number;
}

export interface WorkspaceProjectionRecord extends WorkspaceProjectionIdentity {
  path: string;
  contentHash: string;
}

/**
 * Records the exact content most recently accepted or materialized by the room
 * authority. Filesystem watchers use this ledger to distinguish their own
 * projection writes from genuinely external edits.
 */
export class WorkspaceProjectionTracker {
  private readonly records = new Map<string, WorkspaceProjectionRecord>();

  record(filePath: string, contents: string, identity: WorkspaceProjectionIdentity = {}): WorkspaceProjectionRecord {
    const record: WorkspaceProjectionRecord = {
      path: filePath,
      contentHash: projectionContentHash(contents),
      ...identity,
    };
    this.records.set(filePath, record);
    return { ...record };
  }

  matches(filePath: string, contents: string, identity: Pick<WorkspaceProjectionIdentity, "fileId" | "documentEpoch"> = {}): boolean {
    const record = this.records.get(filePath);
    if (!record || record.contentHash !== projectionContentHash(contents)) return false;
    if (identity.fileId !== undefined && record.fileId !== identity.fileId) return false;
    if (identity.documentEpoch !== undefined && record.documentEpoch !== identity.documentEpoch) return false;
    return true;
  }

  move(sourcePath: string, destinationPath: string): void {
    const record = this.records.get(sourcePath);
    this.records.delete(sourcePath);
    if (record) this.records.set(destinationPath, { ...record, path: destinationPath });
  }

  forget(filePath: string): void { this.records.delete(filePath); }
  clear(): void { this.records.clear(); }
  get(filePath: string): WorkspaceProjectionRecord | undefined {
    const record = this.records.get(filePath);
    return record ? { ...record } : undefined;
  }
}

export function projectionContentHash(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function git(cwd: string, args: string[]): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout.trim();
    } catch (error) {
      if (attempt >= 7 || !isGitLockContention(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(25 * (2 ** attempt), 1_000)));
    }
  }
}

function isGitLockContention(error: unknown): boolean {
  const value = error as { message?: unknown; stderr?: unknown };
  const detail = [value?.message, value?.stderr].filter((part): part is string => typeof part === "string").join("\n");
  return /Unable to create [^\r\n]*\.lock[^\r\n]*File exists|Another git process seems to be running/i.test(detail);
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
  if (![2, 3].includes(value.version as number) || typeof value.roomId !== "string" || typeof value.repositoryRoot !== "string") return null;
  const current = path.resolve(repository.root);
  const role = value.version === 2 && typeof value.sharedPath === "string" && path.resolve(value.sharedPath) === current
    ? "shared"
    : typeof value.agentPath === "string" && path.resolve(value.agentPath) === current
      ? "agent"
      : null;
  if (!role) return null;
  return { version: value.version as 2 | 3, role, roomId: value.roomId, repositoryRoot: value.repositoryRoot, sessionDirectory };
}

export async function inspectDirectCheckout(options: { cwd: string; expectedBaseCommit?: string }): Promise<RepositoryInfo & { initialTree: string }> {
  const repository = await inspectRepository(options.cwd);
  if (repository.operationInProgress) throw new Error("Finish the current merge, rebase, cherry-pick, or revert before starting a direct room");
  if (repository.dirty) throw new Error("Commit or stash all tracked and untracked changes before starting a direct room");
  if (options.expectedBaseCommit && repository.head !== options.expectedBaseCommit) {
    throw new Error(`Checkout HEAD ${repository.head.slice(0, 12)} does not match room base ${options.expectedBaseCommit.slice(0, 12)}`);
  }
  return { ...repository, root: await realpath(repository.root), initialTree: await git(repository.root, ["rev-parse", `${repository.head}^{tree}`]) };
}

/**
 * Prepares the v3 host layout: the original checkout is the room projection and
 * the only additional Git worktree is the temporary agent sandbox.
 */
export async function prepareDirectHostedWorkspace(options: {
  cwd: string;
  roomId: string;
  dataDirectory?: string;
  worktreeDirectory?: string;
}): Promise<DirectHostedWorkspace> {
  const repository = await inspectDirectCheckout({ cwd: options.cwd });
  const roomId = sanitizeRoomId(options.roomId);
  const dataDirectory = options.dataDirectory ?? path.join(homedir(), ".multicode", "sessions");
  const sessionDirectory = path.join(dataDirectory, roomId);
  // Keep the executable agent checkout outside the session-state tree. Agent
  // tools run with agentPath as their cwd, so the old sibling layout exposed
  // room credentials through obvious paths such as ../token.
  const worktreeDirectory = options.worktreeDirectory
    ?? (options.dataDirectory ? `${options.dataDirectory}-worktrees` : path.join(homedir(), ".multicode", "agent-worktrees"));
  const agentContainer = path.join(worktreeDirectory, roomId);
  const agentPath = path.join(agentContainer, "agent");
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await mkdir(worktreeDirectory, { recursive: true, mode: 0o700 });
  try {
    await mkdir(sessionDirectory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Session directory already exists for ${roomId}`);
    throw error;
  }
  try {
    await mkdir(agentContainer, { mode: 0o700 });
  } catch (error) {
    await rm(sessionDirectory, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Agent worktree state already exists for ${roomId}`);
    throw error;
  }

  let lease: DirectCheckoutLease | undefined;
  try {
    lease = await acquireDirectCheckoutLease({
      repository,
      roomId,
      sessionDirectory,
    });
    // Close the preflight-to-lease race before creating any checkpoint from the
    // checkout. Cooperative room writers now see the lease and must stand down.
    await inspectDirectCheckout({ cwd: repository.root, expectedBaseCommit: repository.head });
    const checkpoint = await createWorkspaceCheckpoint({ cwd: repository.root, roomId, sequence: 1, baseCommit: repository.head, force: true });
    if (!checkpoint) throw new Error("Unable to create initial direct-room checkpoint");
    await git(repository.root, ["worktree", "add", "--detach", agentPath, checkpoint.commit]);
    const canonicalAgentPath = await realpath(agentPath);
    const marker = JSON.stringify({
      version: 3,
      roomId,
      repositoryRoot: repository.root,
      workspacePath: repository.root,
      agentPath: canonicalAgentPath,
      baseCommit: repository.head,
      initialTree: repository.initialTree,
      checkpointCommit: checkpoint.commit,
      leasePath: lease.path,
      creationNonce: lease.nonce,
    }, null, 2);
    await writeFile(path.join(sessionDirectory, ".multicode-session.json"), marker, { mode: 0o600 });
    // The ownership verifier needs non-secret provenance beside the worktree;
    // runtime credentials and journals remain only in sessionDirectory.
    await writeFile(path.join(agentContainer, ".multicode-session.json"), marker, { mode: 0o600 });
    return {
      roomId,
      workspacePath: repository.root,
      agentPath: canonicalAgentPath,
      baseCommit: repository.head,
      initialTree: repository.initialTree,
      checkpointCommit: checkpoint.commit,
      sessionDirectory,
      lease,
    };
  } catch (error) {
    await git(repository.root, ["worktree", "remove", "--force", agentPath]).catch(() => undefined);
    if (lease) await releaseDirectCheckoutLease(lease).catch(() => undefined);
    await rm(agentContainer, { recursive: true, force: true });
    await rm(sessionDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function releaseDirectCheckoutLease(lease: DirectCheckoutLease): Promise<void> {
  let persisted: Record<string, unknown>;
  try {
    persisted = JSON.parse(await readFile(lease.path, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("Direct-room checkout lease is missing or invalid");
  }
  if (
    persisted.version !== 3
    || persisted.roomId !== lease.roomId
    || persisted.repositoryRoot !== lease.repositoryRoot
    || persisted.nonce !== lease.nonce
  ) throw new Error("Refusing to release a direct-room lease owned by another session");
  await rm(lease.path);
}

/** Ends a v3 host session without touching the user's checkout contents. */
export async function closeDirectHostedWorkspace(workspace: DirectHostedWorkspace): Promise<void> {
  await verifyOwnedHostWorktrees(workspace.workspacePath, workspace.agentPath, workspace.roomId);
  try {
    await git(workspace.workspacePath, ["worktree", "remove", "--force", workspace.agentPath]);
  } finally {
    try {
      await releaseDirectCheckoutLease(workspace.lease);
    } finally {
      await rm(path.dirname(workspace.agentPath), { recursive: true, force: true });
    }
  }
}

/** Force-removes both worktrees from a superseded v2 host session. */
export async function cleanupLegacyHostedWorkspace(options: {
  roomId: string;
  dataDirectory?: string;
}): Promise<{ repositoryRoot: string; sharedPath: string; agentPath: string }> {
  const roomId = sanitizeRoomId(options.roomId);
  const dataDirectory = options.dataDirectory ?? path.join(homedir(), ".multicode", "sessions");
  const sessionDirectory = path.join(dataDirectory, roomId);
  const markerPath = path.join(sessionDirectory, ".multicode-session.json");
  let marker: Record<string, unknown>;
  try {
    marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(`No valid legacy MultiCode host workspace exists for ${roomId}`);
  }
  if (
    marker.version !== 2
    || marker.roomId !== roomId
    || typeof marker.repositoryRoot !== "string"
    || typeof marker.sharedPath !== "string"
    || typeof marker.agentPath !== "string"
  ) throw new Error(`No valid legacy MultiCode host workspace exists for ${roomId}`);
  await verifyOwnedHostWorktrees(marker.sharedPath, marker.agentPath, roomId);
  await git(marker.repositoryRoot, ["worktree", "remove", "--force", marker.agentPath]);
  await git(marker.repositoryRoot, ["worktree", "remove", "--force", marker.sharedPath]);
  await rm(sessionDirectory, { recursive: true, force: false });
  return { repositoryRoot: marker.repositoryRoot, sharedPath: marker.sharedPath, agentPath: marker.agentPath };
}

async function acquireDirectCheckoutLease(options: {
  repository: RepositoryInfo & { initialTree: string };
  roomId: string;
  sessionDirectory: string;
}): Promise<DirectCheckoutLease> {
  const commonDirectory = await realpath(path.resolve(options.repository.root, await git(options.repository.root, ["rev-parse", "--git-common-dir"])));
  const leaseDirectory = path.join(commonDirectory, "multicode");
  const leasePath = path.join(leaseDirectory, "checkout-lease.json");
  await mkdir(leaseDirectory, { recursive: true, mode: 0o700 });
  const lease: DirectCheckoutLease = {
    version: 3,
    roomId: options.roomId,
    repositoryRoot: options.repository.root,
    sessionDirectory: options.sessionDirectory,
    baseCommit: options.repository.head,
    initialTree: options.repository.initialTree,
    nonce: randomBytes(32).toString("base64url"),
    createdAt: new Date().toISOString(),
    path: leasePath,
  };
  let handle;
  try {
    handle = await open(leasePath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      let owner = "another room";
      try {
        const existing = JSON.parse(await readFile(leasePath, "utf8")) as Record<string, unknown>;
        if (typeof existing.roomId === "string") owner = `room ${existing.roomId}`;
      } catch { /* Preserve an invalid lease for explicit recovery instead of deleting it. */ }
      throw new Error(`Checkout is already leased by ${owner}; stop or recover that room before continuing`);
    }
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify(lease, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  return lease;
}

export async function prepareDirectParticipantWorkspace(options: {
  cwd: string;
  roomId: string;
  baseCommit: string;
  dataDirectory?: string;
}): Promise<DirectParticipantWorkspaceState> {
  const repository = await inspectDirectCheckout({ cwd: options.cwd, expectedBaseCommit: options.baseCommit });
  const roomId = sanitizeRoomId(options.roomId);
  const dataDirectory = options.dataDirectory ?? path.join(homedir(), ".multicode", "sessions");
  const sessionDirectory = path.join(dataDirectory, "rooms", roomId);
  const markerPath = path.join(sessionDirectory, ".multicode-room.json");
  await mkdir(path.dirname(sessionDirectory), { recursive: true, mode: 0o700 });
  try {
    await mkdir(sessionDirectory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Session state already exists for room ${roomId}`);
    throw error;
  }

  let lease: DirectCheckoutLease | undefined;
  try {
    lease = await acquireDirectCheckoutLease({ repository, roomId, sessionDirectory });
    const state: DirectParticipantWorkspaceState = {
      roomId,
      root: repository.root,
      baseCommit: repository.head,
      initialTree: repository.initialTree,
      sessionDirectory,
      markerPath,
      lease,
      projectedCommit: repository.head,
      checkpointSequence: 0,
    };
    await persistDirectParticipantState(state);
    return state;
  } catch (error) {
    if (lease) await releaseDirectCheckoutLease(lease).catch(() => undefined);
    await rm(sessionDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function applyDirectWorkspaceCheckpoint(state: DirectParticipantWorkspaceState, checkpoint: WorkspaceCheckpoint): Promise<void> {
  await verifyDirectParticipantWorkspace(state);
  if (checkpoint.baseCommit !== state.baseCommit) throw new Error("Room checkpoint base does not match this checkout");
  if (checkpoint.sequence <= state.checkpointSequence) return;
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "multicode-direct-apply-"));
  const bundlePath = path.join(temporaryDirectory, "checkpoint.bundle");
  const localRef = `refs/multicode/received/${sanitizeRoomId(state.roomId)}`;
  try {
    await writeFile(bundlePath, Buffer.from(checkpoint.bundle, "base64"));
    await git(state.root, ["bundle", "verify", bundlePath]);
    await git(state.root, ["fetch", bundlePath, `${checkpoint.ref}:${localRef}`]);
    const receivedCommit = await git(state.root, ["rev-parse", localRef]);
    if (receivedCommit !== checkpoint.commit) throw new Error("Received checkpoint hash does not match the host");
    const [currentTree, projectedTree] = await Promise.all([
      captureWorkspaceTree(state.root),
      git(state.root, ["rev-parse", `${state.projectedCommit}^{tree}`]),
    ]);
    if (currentTree !== projectedTree) throw new Error("Local checkout changed after room synchronization; refusing to overwrite it with a checkpoint");
    const patchText = await gitRaw(state.root, ["diff", "--binary", state.projectedCommit, checkpoint.commit]);
    let applied = false;
    try {
      await applyPatch(state.root, patchText, true);
      await applyPatch(state.root, patchText, false);
      applied = true;
      const resultingTree = await captureWorkspaceTree(state.root);
      const checkpointTree = await git(state.root, ["rev-parse", `${checkpoint.commit}^{tree}`]);
      if (resultingTree !== checkpointTree) throw new Error("Checkpoint projection did not produce the advertised workspace tree");
      const nextState = { ...state, projectedCommit: checkpoint.commit, checkpointSequence: checkpoint.sequence };
      await persistDirectParticipantState(nextState);
      state.projectedCommit = nextState.projectedCommit;
      state.checkpointSequence = nextState.checkpointSequence;
    } catch (error) {
      if (applied) await applyPatch(state.root, patchText, false, true).catch(() => undefined);
      throw error;
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function releaseDirectParticipantWorkspace(state: DirectParticipantWorkspaceState): Promise<string> {
  await verifyDirectParticipantWorkspace(state);
  await releaseDirectCheckoutLease(state.lease);
  await rm(state.sessionDirectory, { recursive: true, force: false });
  return state.root;
}

async function persistDirectParticipantState(state: DirectParticipantWorkspaceState): Promise<void> {
  const contents = JSON.stringify({
    version: 3,
    roomId: state.roomId,
    repositoryRoot: state.root,
    workspacePath: state.root,
    baseCommit: state.baseCommit,
    initialTree: state.initialTree,
    projectedCommit: state.projectedCommit,
    checkpointSequence: state.checkpointSequence,
    lease: state.lease,
  }, null, 2);
  const temporaryMarker = `${state.markerPath}.${randomBytes(12).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await open(temporaryMarker, "wx", 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryMarker, state.markerPath);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryMarker, { force: true });
  }
}

async function verifyDirectParticipantWorkspace(state: DirectParticipantWorkspaceState): Promise<void> {
  const [root, markerPath, sessionDirectory] = await Promise.all([realpath(state.root), realpath(state.markerPath), realpath(state.sessionDirectory)]);
  if (
    root !== path.resolve(state.root)
    || markerPath !== path.join(sessionDirectory, ".multicode-room.json")
    || path.basename(sessionDirectory) !== state.roomId
  ) throw new Error("Refusing to operate on an unverified direct room checkout");
  const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
  const persistedLease = marker.lease as Record<string, unknown> | undefined;
  if (
    marker.version !== 3
    || marker.roomId !== state.roomId
    || marker.repositoryRoot !== root
    || marker.baseCommit !== state.baseCommit
    || marker.initialTree !== state.initialTree
    || marker.projectedCommit !== state.projectedCommit
    || marker.checkpointSequence !== state.checkpointSequence
    || !persistedLease
    || persistedLease.path !== state.lease.path
    || persistedLease.nonce !== state.lease.nonce
  ) throw new Error("Refusing to operate because the direct room marker is invalid");
  const lease = JSON.parse(await readFile(state.lease.path, "utf8")) as Record<string, unknown>;
  if (lease.version !== 3 || lease.roomId !== state.roomId || lease.repositoryRoot !== root || lease.nonce !== state.lease.nonce) {
    throw new Error("Refusing to operate because the direct checkout lease is invalid");
  }
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

async function captureWorkspaceTree(cwd: string): Promise<string> {
  const repository = await inspectRepository(cwd);
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "multicode-tree-"));
  const indexPath = path.join(temporaryDirectory, "index");
  try {
    const environment = { GIT_INDEX_FILE: indexPath };
    await gitWithEnv(repository.root, ["read-tree", repository.head], environment);
    await gitWithEnv(repository.root, ["add", "-A", "--", "."], environment);
    return await gitWithEnv(repository.root, ["write-tree"], environment);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
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

/**
 * Create a self-contained snapshot bundle for participants that do not have a
 * clone of the host repository. The synthetic commit deliberately has no
 * parent, so the bundle contains the current tree without disclosing history.
 */
export async function createPortableWorkspaceCheckpoint(options: {
  cwd: string;
  roomId: string;
  sequence: number;
  baseCommit: string;
  sourceCommit: string;
}): Promise<WorkspaceCheckpoint> {
  const repository = await inspectRepository(options.cwd);
  const roomId = sanitizeRoomId(options.roomId);
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "multicode-portable-checkpoint-"));
  const bundlePath = path.join(temporaryDirectory, "workspace.bundle");
  const checkpointRef = `refs/multicode/mirrors/${roomId}`;
  try {
    const tree = await git(repository.root, ["rev-parse", `${options.sourceCommit}^{tree}`]);
    const commit = await gitWithEnv(repository.root, ["commit-tree", tree, "-m", `MultiCode mirror ${options.sequence}`], {
      GIT_AUTHOR_NAME: "MultiCode",
      GIT_AUTHOR_EMAIL: "multicode@localhost",
      GIT_COMMITTER_NAME: "MultiCode",
      GIT_COMMITTER_EMAIL: "multicode@localhost",
    });
    await git(repository.root, ["update-ref", checkpointRef, commit]);
    await git(repository.root, ["bundle", "create", bundlePath, checkpointRef]);
    const bundleBytes = await readFile(bundlePath);
    if (bundleBytes.byteLength + 29 > maxCheckpointBytes) throw new Error("Portable workspace checkpoint exceeds the 32 MiB relay limit");
    return {
      sequence: options.sequence,
      baseCommit: options.baseCommit,
      commit,
      ref: checkpointRef,
      bundle: bundleBytes.toString("base64"),
      createdAt: new Date().toISOString(),
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

/** AES-GCM envelope: version byte, 12-byte nonce, 16-byte tag, ciphertext. */
export function encryptWorkspaceCheckpointBundle(key: Buffer, sequence: number, bundle: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`workspace-checkpoint:${sequence}`));
  const ciphertext = Buffer.concat([cipher.update(bundle), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext]);
}

export function decryptWorkspaceCheckpointBundle(key: Buffer, sequence: number, envelope: Buffer): Buffer {
  if (envelope.byteLength < 30 || envelope[0] !== 1) throw new Error("Invalid encrypted workspace checkpoint");
  const decipher = createDecipheriv("aes-256-gcm", key, envelope.subarray(1, 13));
  decipher.setAAD(Buffer.from(`workspace-checkpoint:${sequence}`));
  decipher.setAuthTag(envelope.subarray(13, 29));
  return Buffer.concat([decipher.update(envelope.subarray(29)), decipher.final()]);
}

interface MirroredWorkspaceMarker {
  version: 1;
  roomId: string;
  workspacePath: string;
  creationNonce: string;
  sequence: number;
  commit: string;
}

/**
 * Materialize a verified portable checkpoint into an isolated MultiCode-owned
 * repository. Existing participant checkouts are never used or modified.
 */
export async function applyPortableWorkspaceCheckpoint(options: {
  dataDirectory: string;
  roomId: string;
  checkpoint: WorkspaceCheckpoint;
}): Promise<MirroredWorkspaceState> {
  const roomId = sanitizeRoomId(options.roomId);
  const configuredDataDirectory = path.resolve(options.dataDirectory);
  await mkdir(configuredDataDirectory, { recursive: true, mode: 0o700 });
  const roomDirectory = path.join(await realpath(configuredDataDirectory), "mirrors", roomId);
  const workspacePath = path.join(roomDirectory, "workspace");
  const markerPath = path.join(roomDirectory, ".multicode-mirror.json");
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "multicode-mirror-apply-"));
  const bundlePath = path.join(temporaryDirectory, "workspace.bundle");
  let marker: MirroredWorkspaceMarker | undefined;
  try {
    try {
      marker = JSON.parse(await readFile(markerPath, "utf8")) as MirroredWorkspaceMarker;
      if (
        marker.version !== 1
        || marker.roomId !== roomId
        || path.resolve(marker.workspacePath) !== workspacePath
        || typeof marker.creationNonce !== "string"
        || marker.creationNonce.length < 32
      ) throw new Error("Invalid MultiCode mirror marker");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    await mkdir(workspacePath, { recursive: true, mode: 0o700 });
    if (await realpath(workspacePath) !== workspacePath) throw new Error("Refusing to use a shared workspace mirror outside its managed directory");
    try {
      await access(path.join(workspacePath, ".git"));
      if (await realpath(path.join(workspacePath, ".git")) !== path.join(workspacePath, ".git")) throw new Error("Invalid shared workspace Git directory");
    } catch {
      const entries = await readdir(workspacePath);
      if (entries.length) throw new Error("Refusing to initialize a MultiCode mirror over existing files");
      await git(workspacePath, ["init"]);
    }

    const status = await git(workspacePath, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (status) throw new Error("Shared workspace mirror has local changes; refusing to overwrite them");
    if (marker) {
      const currentCommit = await git(workspacePath, ["rev-parse", "HEAD"]);
      if (currentCommit !== marker.commit) throw new Error("Shared workspace mirror no longer matches its synchronized version");
      const [currentTree, synchronizedTree] = await Promise.all([
        captureWorkspaceTree(workspacePath),
        git(workspacePath, ["rev-parse", `${marker.commit}^{tree}`]),
      ]);
      if (currentTree !== synchronizedTree) throw new Error("Shared workspace mirror has local changes; refusing to overwrite them");
      if (options.checkpoint.sequence <= marker.sequence) {
        return { roomId, root: workspacePath, sequence: marker.sequence, commit: marker.commit };
      }
    }

    await writeFile(bundlePath, Buffer.from(options.checkpoint.bundle, "base64"));
    await git(workspacePath, ["bundle", "verify", bundlePath]);
    const localRef = `refs/multicode/received/${roomId}`;
    await git(workspacePath, ["fetch", bundlePath, `+${options.checkpoint.ref}:${localRef}`]);
    const receivedCommit = await git(workspacePath, ["rev-parse", localRef]);
    if (receivedCommit !== options.checkpoint.commit) throw new Error("Received workspace checkpoint hash does not match the host");
    await git(workspacePath, ["reset", "--hard", receivedCommit]);

    const nextMarker: MirroredWorkspaceMarker = {
      version: 1,
      roomId,
      workspacePath,
      creationNonce: marker?.creationNonce ?? randomBytes(32).toString("base64url"),
      sequence: options.checkpoint.sequence,
      commit: receivedCommit,
    };
    const temporaryMarker = `${markerPath}.${randomBytes(12).toString("hex")}.tmp`;
    await writeFile(temporaryMarker, JSON.stringify(nextMarker, null, 2), { mode: 0o600 });
    await rename(temporaryMarker, markerPath);
    return { roomId, root: workspacePath, sequence: nextMarker.sequence, commit: nextMarker.commit };
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
  if (marker.version === 3) {
    const lease = marker.lease as DirectCheckoutLease | undefined;
    if (
      typeof marker.repositoryRoot !== "string"
      || typeof marker.baseCommit !== "string"
      || typeof marker.initialTree !== "string"
      || typeof marker.projectedCommit !== "string"
      || typeof marker.checkpointSequence !== "number"
      || !lease
    ) throw new Error(`No valid direct MultiCode room state exists for ${roomId}`);
    return releaseDirectParticipantWorkspace({
      roomId,
      root: marker.repositoryRoot,
      baseCommit: marker.baseCommit,
      initialTree: marker.initialTree,
      sessionDirectory: roomDirectory,
      markerPath,
      lease,
      projectedCommit: marker.projectedCommit,
      checkpointSequence: marker.checkpointSequence,
    });
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
export interface WorkspaceChange {
  operation: "create" | "update" | "delete" | "rename";
  path: string;
  sourcePath?: string;
  content?: string;
  /** False when a change should remain outside participant-facing agent previews. */
  collaborative?: boolean;
}
export interface PendingWorkspaceProposal { version: 1; sequence: number; roomId: string; baseCommit: string; agentCommit: string; humanCommit: string; patchPath: string; createdAt: string; status: "pending" }

async function captureSnapshotCommit(options: { cwd: string; roomId: string; sequence: number; baseCommit: string; parentCommit: string }): Promise<string> {
  const checkpoint = await createWorkspaceCheckpoint({ ...options, force: true });
  if (!checkpoint) throw new Error("Unable to capture workspace state");
  return checkpoint.commit;
}

async function verifyOwnedHostWorktrees(sharedPath: string, agentPath: string, roomId: string): Promise<void> {
  const shared = await realpath(sharedPath); const agent = await realpath(agentPath); const sessionDirectory = path.dirname(agent); const markerPath = path.join(sessionDirectory, ".multicode-session.json");
  if (path.basename(agent) !== "agent") throw new Error("Refusing destructive operation outside a MultiCode-owned agent worktree");
  const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
  const validNonce = typeof marker.creationNonce === "string" && marker.creationNonce.length >= 32;
  const validV2 = marker.version === 2
    && path.dirname(shared) === sessionDirectory
    && path.basename(shared) === "shared"
    && marker.sharedPath === shared;
  const validV3 = marker.version === 3
    && marker.workspacePath === shared
    && typeof marker.leasePath === "string";
  if (marker.roomId !== sanitizeRoomId(roomId) || marker.agentPath !== agent || !validNonce || (!validV2 && !validV3)) throw new Error("Refusing destructive operation because the host workspace marker is invalid");
  if (validV3) {
    const lease = JSON.parse(await readFile(marker.leasePath as string, "utf8")) as Record<string, unknown>;
    if (lease.version !== 3 || lease.roomId !== marker.roomId || lease.repositoryRoot !== shared || lease.nonce !== marker.creationNonce) {
      throw new Error("Refusing destructive operation because the direct checkout lease is invalid");
    }
  }
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

async function readTreeCollaborativeText(cwd: string, treeId: string, filePath: string): Promise<{ content: string } | { collaborative: false }> {
  const contents = await new Promise<Buffer>((resolve, reject) => {
    execFile("git", ["show", `${treeId}:${filePath}`], { cwd, encoding: "buffer", maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { reject(new Error(Buffer.from(stderr).toString("utf8") || error.message)); return; }
      resolve(Buffer.from(stdout));
    });
  });
  if (contents.byteLength > maxCollaborativeTextBytes) return { collaborative: false };
  try { return { content: new TextDecoder("utf-8", { fatal: true }).decode(contents) }; }
  catch { return { collaborative: false }; }
}

export async function mergeAgentWorkspace(options: {
  sharedPath: string;
  agentPath: string;
  sessionDirectory: string;
  roomId: string;
  baseCommit: string;
  turn: AgentTurnSnapshot;
  withCommitLock: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Journal the merged changes while the workspace lock is held. The Git patch is already visible in the shared checkout. */
  onCommitted?: (changes: WorkspaceChange[]) => Promise<void>;
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
      if (status.startsWith("R")) {
        const sourcePath = fields[index++] as string; const destinationPath = fields[index++] as string;
        const text = await readTreeCollaborativeText(options.sharedPath, mergedTree, destinationPath);
        changes.push({ operation: "rename", sourcePath, path: destinationPath, ...text });
      }
      else {
        const filePath = fields[index++] as string; const operation = status === "A" ? "create" : status === "D" ? "delete" : "update";
        if (operation === "delete") changes.push({ operation, path: filePath });
        else changes.push({ operation, path: filePath, ...await readTreeCollaborativeText(options.sharedPath, mergedTree, filePath) });
      }
    }
    const applied = await options.withCommitLock(async () => {
      const verification = await captureSnapshotCommit({ cwd: options.sharedPath, roomId: `${options.roomId}-merge-verify`, sequence: options.turn.sequence + attempt, baseCommit: options.baseCommit, parentCommit: humanCommit });
      if (await tree(options.sharedPath, verification) !== await tree(options.sharedPath, humanCommit)) return false;
      await applyPatch(options.sharedPath, patchText, true);
      await applyPatch(options.sharedPath, patchText, false);
      try {
        if (options.onCommitted) await options.onCommitted(changes);
      } catch (error) {
        try { await applyPatch(options.sharedPath, patchText, false, true); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], "Workspace commit failed and its Git projection could not be rolled back"); }
        throw error;
      }
      return true;
    });
    if (applied) return { status: "merged", changes };
  }
  throw new Error("Human workspace kept changing during merge; retry the Codex proposal later");
}
