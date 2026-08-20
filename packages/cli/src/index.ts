#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { homedir, networkInterfaces, userInfo } from "node:os";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import chalk, { chalkStderr } from "chalk";
import { Command } from "commander";
import { CodexAppServerAdapter } from "@multicode/agent-adapters";
import { FileJournal, HostSession, LocalIpcServer, PostgresJournal, roomSecret, writeSessionToken } from "@multicode/session-core";
import {
  checkpointChunkBytes,
  type AgentEvent,
  type RelayServerMessage,
  type RoomServerMessage,
  type WorkspaceCheckpoint,
  type WorkspaceCheckpointChunk,
  type WorkspaceCheckpointDescriptor,
  type WorkspaceDiff,
} from "@multicode/protocol";
import { PostgresRelayRoomStore, RelayServer, RoomRelay } from "@multicode/relay";
import {
  applyWorkspaceCheckpoint,
  cleanupParticipantWorkspace,
  createRoomWorktrees,
  createWorkspaceCheckpoint,
  inspectManagedRoomWorktree,
  inspectRepository,
  prepareParticipantWorkspace,
  restoreParticipantWorkspace,
  sanitizeRoomId,
  type ParticipantWorkspaceState,
} from "@multicode/workspace";
import WebSocket from "ws";

const execFileAsync = promisify(execFile);
const defaultRelayUrl = process.env.MULTICODE_RELAY_URL ?? "wss://multicode.luisagd.com";

const out = {
  success: (message: string) => `${chalk.green("✓")} ${message}`,
  warning: (message: string) => `${chalk.yellow("!")} ${message}`,
  label: (label: string) => chalk.bold(label),
  value: (value: string) => chalk.cyan(value),
  muted: (value: string) => chalk.dim(value),
  command: (value: string) => chalk.cyan(value),
};

const err = {
  success: (message: string) => `${chalkStderr.green("✓")} ${message}`,
  error: (message: string) => `${chalkStderr.red("✗")} ${message}`,
  info: (symbol: string, message: string) => `${chalkStderr.cyan(symbol)} ${message}`,
  warning: (message: string) => `${chalkStderr.yellow("!")} ${message}`,
  label: (label: string) => chalkStderr.bold(label),
  value: (value: string) => chalkStderr.cyan(value),
  muted: (value: string) => chalkStderr.dim(value),
};

const streamingReasoningItems = new Set<string>();

async function versionOf(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { encoding: "utf8" });
    return (stdout || stderr).trim().split("\n").at(-1) ?? null;
  } catch {
    return null;
  }
}

async function doctor(): Promise<void> {
  const [gitVersion, codexVersion] = await Promise.all([
    versionOf("git", ["--version"]),
    versionOf("codex", ["--version"]),
  ]);

  const checks = [
    { name: "Node.js", ok: Number(process.versions.node.split(".")[0]) >= 20, detail: process.version },
    { name: "Git", ok: Boolean(gitVersion), detail: gitVersion ?? "not found" },
    { name: "Codex CLI", ok: Boolean(codexVersion), detail: codexVersion ?? "not found" },
  ];

  for (const check of checks) {
    const icon = check.ok ? chalk.green("✓") : chalk.red("✗");
    console.log(`${icon} ${out.label(check.name)} ${out.muted(check.detail)}`);
  }

  try {
    const repository = await inspectRepository(process.cwd());
    console.log(out.success(`${out.label("Repository")} ${out.value(repository.root)}`));
    console.log(`  ${out.muted("HEAD")} ${repository.head.slice(0, 12)}${repository.dirty ? out.muted(" (uncommitted changes excluded)") : ""}`);
  } catch (error) {
    console.log(`${chalk.red("✗")} ${out.label("Repository")} ${error instanceof Error ? error.message : String(error)}`);
  }

  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

function printAgentEvent(event: AgentEvent): void {
  switch (event.type) {
    case "agent.reasoning.delta":
      if (!streamingReasoningItems.has(event.itemId)) {
        streamingReasoningItems.add(event.itemId);
        process.stdout.write(`\n${chalk.cyan("◆")} ${chalk.bold("Thinking")}\n`);
      }
      process.stdout.write(chalk.dim(event.text));
      break;
    case "agent.reasoning.completed":
      if (streamingReasoningItems.delete(event.itemId)) {
        process.stdout.write("\n");
      } else if (event.text) {
        process.stdout.write(`\n${chalk.cyan("◆")} ${chalk.bold("Thinking")}\n${chalk.dim(event.text)}\n`);
      }
      break;
    case "agent.message.delta":
    case "command.output":
      process.stdout.write(event.text);
      break;
    case "approval.requested":
      console.error(`\n${err.warning(`${err.label("Approval required on the host")} ${err.muted(`(${event.approvalKind}, request ${event.requestId})`)}`)}`);
      console.error(err.muted("  Interactive approval handling is not implemented; the request remains pending."));
      break;
    case "agent.error":
      console.error(`\n${err.error(`${err.label("Codex")} ${event.message}`)}`);
      break;
    case "turn.completed":
      console.error(`\n${err.success(`${err.label("Turn completed")}${event.status ? err.muted(` (${event.status})`) : ""}`)}`);
      break;
    default:
      break;
  }
}

function printRoomMessage(message: RoomServerMessage, includeAgent = true): void {
  switch (message.type) {
    case "room.welcome":
      console.log(out.success(`${out.label("Joined room")} ${out.value(message.roomId)}`));
      console.log(`  ${out.muted("Participants")} ${message.participants.map((participant) => participant.name).join(", ")}`);
      if (message.activePrompt) console.log(`  ${out.muted("Active prompt")} ${out.label(message.activePrompt.participantName)}: ${message.activePrompt.text}`);
      if (message.queue.length) console.log(`  ${chalk.yellow(message.queue.length)} ${out.muted("prompt(s) waiting")}`);
      if (message.latestDiff) printWorkspaceDiff(message.latestDiff);
      break;
    case "participant.joined":
      console.error(`\n${err.info("+", `${err.label(message.participant.name)} joined the room`)}`);
      break;
    case "participant.left":
      console.error(`\n${err.muted(`− ${message.name} left the room`)}`);
      break;
    case "prompt.queued":
      console.error(`\n${err.info("→", `${err.label(message.prompt.participantName)} queued prompt ${err.muted(`#${message.position}`)}: ${message.prompt.text}`)}`);
      break;
    case "prompt.started":
      console.error(`\n${err.info("▶", `${err.label(message.prompt.participantName)}: ${message.prompt.text}`)}`);
      break;
    case "agent.event":
      if (includeAgent) printAgentEvent(message.event);
      break;
    case "workspace.diff":
      printWorkspaceDiff(message.diff);
      break;
    case "workspace.checkpoint":
      console.error(`\n${err.info("↻", `${err.label("Workspace checkpoint")} ${message.checkpoint.sequence} ${err.muted(message.checkpoint.commit.slice(0, 12))}`)}`);
      break;
    case "participant.synced":
      console.error(`\n${err.success(`${err.label("Participant synchronized")} ${err.muted(`checkpoint ${message.sequence}`)}`)}`);
      break;
    case "room.error":
      console.error(`\n${err.error(`${err.label("Room error")} ${message.message}`)}`);
      break;
  }
}

function printWorkspaceDiff(diff: WorkspaceDiff): void {
  console.error(`\n${chalkStderr.cyan("──")} ${err.label("Workspace changes")} ${err.muted(`after ${diff.revision}${diff.truncated ? " · truncated" : ""}`)} ${chalkStderr.cyan("──")}`);
  console.error(diff.text || "No tracked workspace changes.");
  console.error(chalkStderr.cyan("────────────────────────"));
}

async function readWorkspaceDiff(cwd: string, revision: string): Promise<WorkspaceDiff> {
  const maxLength = 250_000;
  let combined: string;
  try {
    const [status, diff] = await Promise.all([
      execFileAsync("git", ["status", "--short"], { cwd, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }),
      execFileAsync("git", ["diff", "--no-ext-diff", "--unified=3", "HEAD", "--"], {
        cwd,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      }),
    ]);
    combined = [`Status:\n${status.stdout.trim() || "(clean)"}`, diff.stdout.trim()].filter(Boolean).join("\n\n");
  } catch (error) {
    combined = `Unable to read workspace diff: ${error instanceof Error ? error.message : String(error)}`;
  }
  return {
    revision,
    text: combined.slice(0, maxLength),
    truncated: combined.length > maxLength,
    createdAt: new Date().toISOString(),
  };
}

async function agentPreviewEvent(cwd: string, revision: string) {
  const diff = await readWorkspaceDiff(cwd, revision);
  return { id: randomUUID(), kind: "agent.preview" as const, payload: Buffer.from(diff.text.slice(0, 180_000)).toString("base64url") };
}

function checkpointTransfer(checkpoint: WorkspaceCheckpoint): {
  descriptor: WorkspaceCheckpointDescriptor;
  chunks: WorkspaceCheckpointChunk[];
} {
  const bundle = Buffer.from(checkpoint.bundle, "base64");
  const chunks: WorkspaceCheckpointChunk[] = [];
  for (let offset = 0, index = 0; offset < bundle.byteLength; offset += checkpointChunkBytes, index += 1) {
    chunks.push({
      sequence: checkpoint.sequence,
      index,
      data: bundle.subarray(offset, offset + checkpointChunkBytes).toString("base64"),
    });
  }
  return {
    descriptor: {
      sequence: checkpoint.sequence,
      baseCommit: checkpoint.baseCommit,
      commit: checkpoint.commit,
      ref: checkpoint.ref,
      bundleBytes: bundle.byteLength,
      bundleHash: createHash("sha256").update(bundle).digest("hex"),
      chunkCount: chunks.length,
      createdAt: checkpoint.createdAt,
    },
    chunks,
  };
}

async function sendSocketMessage(socket: WebSocket, message: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.send(JSON.stringify(message), (error) => error ? reject(error) : resolve());
  });
}

async function sendRemoteCheckpoint(socket: WebSocket, checkpoint: WorkspaceCheckpoint, targetParticipantId?: string): Promise<void> {
  const transfer = checkpointTransfer(checkpoint);
  const target = targetParticipantId ? { targetParticipantId } : {};
  await sendSocketMessage(socket, { type: "relay.workspace.checkpoint.start", checkpoint: transfer.descriptor, ...target });
  for (const chunk of transfer.chunks) {
    await sendSocketMessage(socket, { type: "relay.workspace.checkpoint.chunk", chunk, ...target });
  }
  await sendSocketMessage(socket, { type: "relay.workspace.checkpoint.complete", sequence: checkpoint.sequence, ...target });
}

class CheckpointReceiver {
  private active: { descriptor: WorkspaceCheckpointDescriptor; chunks: Buffer[]; receivedBytes: number } | undefined;

  start(descriptor: WorkspaceCheckpointDescriptor): void {
    this.active = { descriptor, chunks: [], receivedBytes: 0 };
  }

  chunk(chunk: WorkspaceCheckpointChunk): void {
    const active = this.active;
    if (!active || chunk.sequence !== active.descriptor.sequence || chunk.index !== active.chunks.length) {
      this.active = undefined;
      throw new Error("Invalid checkpoint chunk ordering");
    }
    const decoded = Buffer.from(chunk.data, "base64");
    if (decoded.byteLength > checkpointChunkBytes || decoded.toString("base64") !== chunk.data) {
      this.active = undefined;
      throw new Error("Invalid checkpoint chunk encoding or size");
    }
    active.receivedBytes += decoded.byteLength;
    if (active.receivedBytes > active.descriptor.bundleBytes) {
      this.active = undefined;
      throw new Error("Checkpoint transfer exceeds its declared size");
    }
    active.chunks.push(decoded);
  }

  complete(sequence: number): WorkspaceCheckpoint {
    const active = this.active;
    this.active = undefined;
    if (!active || sequence !== active.descriptor.sequence || active.chunks.length !== active.descriptor.chunkCount) {
      throw new Error("Incomplete checkpoint transfer");
    }
    const bundle = Buffer.concat(active.chunks);
    if (bundle.byteLength !== active.descriptor.bundleBytes || createHash("sha256").update(bundle).digest("hex") !== active.descriptor.bundleHash) {
      throw new Error("Checkpoint transfer failed integrity validation");
    }
    return {
      sequence: active.descriptor.sequence,
      baseCommit: active.descriptor.baseCommit,
      commit: active.descriptor.commit,
      ref: active.descriptor.ref,
      bundle: bundle.toString("base64"),
      createdAt: active.descriptor.createdAt,
    };
  }
}

async function prepareRoom(dryRun = false): Promise<{
  roomId: string;
  workspacePath?: string;
  baseCommit?: string;
}> {
  const repository = await inspectRepository(process.cwd());
  const managedWorktree = await inspectManagedRoomWorktree(repository.root);
  if (managedWorktree) {
    throw new Error(`Refusing to host from a MultiCode ${managedWorktree.role} worktree. Open the original repository at ${managedWorktree.repositoryRoot}`);
  }
  console.log(out.success(`${out.label("Repository")} ${out.value(repository.root)}`));
  if (repository.dirty) console.log(out.warning("Uncommitted and untracked changes will be included in synchronized checkpoints."));
  if (repository.operationInProgress) throw new Error("Finish the current Git operation before creating a room");
  if (dryRun) {
    console.log(out.success(`${out.label("Base commit")} ${out.muted(repository.head)}`));
    console.log(out.success("Repository is ready for a synchronized room"));
    return { roomId: "dry-run" };
  }

  const roomId = randomUUID().split("-")[0] as string;
  console.log(out.success(`${out.label("Workspace")} ${out.value(repository.root)}`));
  console.log(out.success(`${out.label("Branch")} ${out.value(repository.branch ?? "detached HEAD")}`));
  return { roomId, workspacePath: repository.root, baseCommit: repository.head };
}

async function prepareHostedWorkspace(roomId: string): Promise<{ workspacePath: string; agentPath: string; baseCommit: string; checkpointCommit: string }> {
  const room = await createRoomWorktrees({ cwd: process.cwd(), roomId });
  console.log(out.success(`${out.label("Room workspace")} ${out.value(room.sharedPath)}`));
  console.log(out.success(`${out.label("Codex workspace")} ${out.value(room.agentPath)}`));
  return { workspacePath: room.sharedPath, agentPath: room.agentPath, baseCommit: room.baseCommit, checkpointCommit: room.checkpointCommit };
}

async function applyAgentResult(options: { sharedPath: string; agentPath: string; checkpointCommit: string }): Promise<boolean> {
  const { stdout } = await execFileAsync("git", ["diff", "--binary", options.checkpointCommit, "--"], { cwd: options.agentPath, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  if (!stdout) return false;
  try {
    await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["apply", "--3way", "--whitespace=nowarn", "-"], { cwd: options.sharedPath, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || "Agent changes conflict with shared workspace")));
    child.stdin.end(stdout);
    });
  } catch (error) {
    const proposalPath = path.join(options.sharedPath, ".multicode-agent-conflict.patch");
    await writeFile(proposalPath, stdout, "utf8");
    throw new Error(`${error instanceof Error ? error.message : String(error)}. Saved proposal at ${proposalPath}`);
  }
  return true;
}

async function createRoom(options: { agent: string; prompt?: string; model?: string; dryRun?: boolean }): Promise<void> {
  if (options.agent !== "codex") throw new Error("Only the codex adapter is available");
  const room = await prepareRoom(options.dryRun);
  if (options.dryRun || !room.workspacePath) return;

  const adapter = new CodexAppServerAdapter();
  const stop = installStopHandlers(async () => {
    console.error(`\n${err.info("■", "Stopping local room…")}`);
    await adapter.stop();
  });
  const eventTask = (async () => {
    for await (const event of adapter.events()) printAgentEvent(event);
  })();
  const { threadId } = await adapter.start({ cwd: room.workspacePath, ...(options.model ? { model: options.model } : {}) });
  console.log(out.success(`${out.label("Codex thread")} ${out.muted(threadId)}`));
  if (options.prompt) await adapter.sendPrompt({ promptId: randomUUID(), text: options.prompt });
  else console.log(`${out.muted("Room is running locally. Pass")} ${out.command("--prompt")} ${out.muted("to begin a turn.")}`);
  await eventTask;
  stop();
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`Invalid port: ${value}`);
  return port;
}

function defaultPublicHost(listenHost: string): string {
  if (listenHost !== "0.0.0.0" && listenHost !== "::") return listenHost;
  for (const addresses of Object.values(networkInterfaces())) {
    const address = addresses?.find((candidate) => candidate.family === "IPv4" && !candidate.internal);
    if (address) return address.address;
  }
  return "localhost";
}

function inviteUrl(options: { publicUrl?: string; listenHost: string; port: number; roomId: string; token: string }): string {
  const base = options.publicUrl ?? `ws://${defaultPublicHost(options.listenHost)}:${options.port}`;
  const url = new URL(base);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("--public-url must use ws:// or wss://");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/rooms/${options.roomId}`;
  url.hash = new URLSearchParams({ token: options.token }).toString();
  return url.toString();
}

function remoteUrl(base: string, path: string): URL {
  const url = new URL(base);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("Relay URL must use ws:// or wss://");
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol === "ws:" && !loopback) throw new Error("Remote relays must use wss:// to protect room traffic");
  url.hash = "";
  url.search = "";
  url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`;
  return url;
}

function promptInput(onLine: (line: string) => void): Interface {
  const input = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  input.on("line", (line) => {
    const text = line.trim();
    if (text) onLine(text);
  });
  return input;
}

function installStopHandlers(stop: () => Promise<void>): () => void {
  let stopping = false;
  const handler = () => {
    if (stopping) return;
    stopping = true;
    void stop();
  };
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
  return () => {
    process.removeListener("SIGINT", handler);
    process.removeListener("SIGTERM", handler);
  };
}

interface HostRoomOptions {
  agent: string;
  prompt?: string;
  model?: string;
  name: string;
  listen: string;
  port: string;
  publicUrl?: string;
  relay?: string;
  local?: boolean;
}

async function hostRoom(options: HostRoomOptions): Promise<void> {
  if (options.local && options.relay) throw new Error("Use either --local or --relay, not both");
  const configuredRelay = options.relay ?? defaultRelayUrl;
  if (!options.local) {
    await hostRemoteRoom({ ...options, relay: configuredRelay });
    return;
  }
  if (options.agent !== "codex") throw new Error("Only the codex adapter is available");
  const prepared = await prepareRoom();
  if (!prepared.workspacePath || !prepared.baseCommit) return;
  const hosted = await prepareHostedWorkspace(prepared.roomId);
  const workspacePath = hosted.workspacePath;
  const agentPath = hosted.agentPath;
  const checkpointCommit = hosted.checkpointCommit;
  const baseCommit = hosted.baseCommit;
  let checkpointSequence = 0;
  let checkpointParent = baseCommit;
  let latestCheckpoint: WorkspaceCheckpoint | undefined;
  const adapter = new CodexAppServerAdapter();
  const token = randomBytes(24).toString("base64url");
  const relay = new RoomRelay({
    roomId: prepared.roomId,
    token,
    hostName: options.name,
    onPrompt: async (prompt) => {
      await adapter.sendPrompt({ promptId: prompt.promptId, text: prompt.text });
    },
    onCheckpointRequest: (participantId, sequence) => {
      if (!latestCheckpoint || latestCheckpoint.sequence !== sequence) throw new Error("Requested checkpoint is no longer available from the host");
      relay.publishWorkspaceCheckpoint(latestCheckpoint, participantId);
    },
    onRoomEvent: (message) => printRoomMessage(message, false),
  });
  const publishCheckpoint = async (force = false): Promise<void> => {
    const checkpoint = await createWorkspaceCheckpoint({
      cwd: workspacePath,
      roomId: prepared.roomId,
      sequence: checkpointSequence + 1,
      baseCommit,
      parentCommit: checkpointParent,
      force,
    });
    if (!checkpoint) return;
    checkpointSequence = checkpoint.sequence;
    checkpointParent = checkpoint.commit;
    latestCheckpoint = checkpoint;
    relay.publishWorkspaceCheckpoint(checkpoint);
  };

  const eventTask = (async () => {
    for await (const event of adapter.events()) {
      printAgentEvent(event);
      if (event.type === "turn.completed") {
        try { await applyAgentResult({ sharedPath: workspacePath, agentPath, checkpointCommit }); } catch (error) { console.error(err.warning(`Agent result was not merged: ${error instanceof Error ? error.message : String(error)}`)); }
        await publishCheckpoint();
        const diff = await readWorkspaceDiff(workspacePath, event.turnId);
        relay.publishWorkspaceDiff(diff);
        relay.publishAgentEvent(event);
        continue;
      }
      if (event.type === "command.exited") relay.publishCollaborationEvent(await agentPreviewEvent(agentPath, event.turnId));
      relay.publishAgentEvent(event);
    }
  })();
  let input: Interface | undefined;
  let cleanupSignals: () => void = () => undefined;
  let shutdownTask: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownTask ??= (async () => {
      input?.close();
      await relay.close();
      await adapter.stop();
    })();
    return shutdownTask;
  };

  try {
    const { threadId } = await adapter.start({
      cwd: agentPath,
      ...(options.model ? { model: options.model } : {}),
    });
    console.log(out.success(`${out.label("Codex thread")} ${out.muted(threadId)}`));

    const bound = await relay.listen({ host: options.listen, port: parsePort(options.port) });
    await publishCheckpoint(true);
    const invite = inviteUrl({
      ...(options.publicUrl ? { publicUrl: options.publicUrl } : {}),
      listenHost: options.listen,
      port: bound.port,
      roomId: prepared.roomId,
      token,
    });
    console.log(out.success(`${out.label("Room")} ${out.value(prepared.roomId)} ${out.muted("listening on")} ${out.value(`${options.listen}:${bound.port}`)}`));
    console.log(`\n${out.label("Invite someone with")}`);
    console.log(`  ${out.command(`multicode room join '${invite}' --name 'Their name'`)}`);
    if (!options.publicUrl && options.listen === "127.0.0.1") {
      console.log(`\n${out.warning("Local-only listener.")} ${out.muted("Use")} ${out.command("--listen 0.0.0.0")} ${out.muted("for trusted LAN access or")} ${out.command("--public-url")} ${out.muted("with a secure tunnel.")}`);
    }
    console.log(`\n${chalk.green("●")} ${out.label("Ready for prompts")} ${out.muted("Type a prompt and press Enter. Shared prompts run in queue order.")}`);

    input = promptInput((text) => relay.submitHostPrompt(text));
    cleanupSignals = installStopHandlers(async () => {
      console.error(`\n${err.info("■", "Stopping shared room…")}`);
      await shutdown();
    });
    if (options.prompt) relay.submitHostPrompt(options.prompt);
    await eventTask;
  } finally {
    cleanupSignals();
    await shutdown();
  }
}

async function openWebSocket(url: URL): Promise<WebSocket> {
  let announced = false;
  for (;;) {
    const socket = new WebSocket(url);
    try {
      await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
      return socket;
    } catch {
      socket.terminate();
      if (!announced) { console.error(err.warning("Relay unavailable; waiting for it to come back…")); announced = true; }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
}

async function createRemoteRoom(
  socket: WebSocket,
  options: { name: string },
): Promise<Extract<RelayServerMessage, { type: "relay.room.created" }>> {
  return new Promise((resolve, reject) => {
    const closed = () => reject(new Error("Relay disconnected before creating the room"));
    const receive = (data: WebSocket.RawData) => {
      let message: RelayServerMessage;
      try {
        message = JSON.parse(data.toString()) as RelayServerMessage;
      } catch {
        reject(new Error("Relay returned invalid JSON"));
        return;
      }
      if (message.type === "relay.room.created") {
        socket.off("message", receive);
        socket.off("close", closed);
        resolve(message);
      } else if (message.type === "room.error") {
        socket.off("message", receive);
        socket.off("close", closed);
        reject(new Error(message.message));
      }
    };
    socket.on("message", receive);
    socket.once("close", closed);
    socket.send(JSON.stringify({
      type: "relay.room.create",
      name: options.name,
    }));
  });
}

async function hostRemoteRoom(options: HostRoomOptions): Promise<void> {
  if (options.agent !== "codex") throw new Error("Only the codex adapter is available");
  const relayUrl = options.relay ?? defaultRelayUrl;

  const adapter = new CodexAppServerAdapter();
  let socket: WebSocket | undefined;
  let input: Interface | undefined;
  let cleanupSignals: () => void = () => undefined;
  let shutdownTask: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownTask ??= (async () => {
      input?.close();
      if (socket?.readyState === WebSocket.OPEN) socket.close(1000, "Host stopped room");
      await adapter.stop();
    })();
    return shutdownTask;
  };

  try {
    socket = await openWebSocket(remoteUrl(relayUrl, "/host"));
    const created = await createRemoteRoom(socket, { name: options.name });
    const sessionSecret = roomSecret();
    const prepared = await prepareRoom();
    if (!prepared.workspacePath || !prepared.baseCommit) return;
    const hosted = await prepareHostedWorkspace(created.roomId);
    const workspacePath = hosted.workspacePath;
    const agentPath = hosted.agentPath;
    const checkpointCommit = hosted.checkpointCommit;
    // The Pi relay is the room authority and durably journals encrypted collaboration events.
    const baseCommit = hosted.baseCommit;
    let checkpointSequence = 0;
    let checkpointParent = baseCommit;
    let latestCheckpoint: WorkspaceCheckpoint | undefined;
    const publishCheckpoint = async (force = false, targetParticipantId?: string): Promise<void> => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (targetParticipantId) {
        if (!latestCheckpoint) throw new Error("Requested checkpoint is no longer available from the host");
        await sendRemoteCheckpoint(socket, latestCheckpoint, targetParticipantId);
        return;
      }
      const checkpoint = await createWorkspaceCheckpoint({ cwd: workspacePath, roomId: prepared.roomId, sequence: checkpointSequence + 1, baseCommit, parentCommit: checkpointParent, force });
      if (!checkpoint) return;
      checkpointSequence = checkpoint.sequence;
      checkpointParent = checkpoint.commit;
      latestCheckpoint = checkpoint;
      await sendRemoteCheckpoint(socket, checkpoint);
    };
    const eventTask = (async () => {
      for await (const event of adapter.events()) {
        printAgentEvent(event);
        if (!socket || socket.readyState !== WebSocket.OPEN) continue;
        if (event.type === "turn.completed") {
          try { await applyAgentResult({ sharedPath: workspacePath, agentPath, checkpointCommit }); } catch (error) { console.error(err.warning(`Agent result was not merged: ${error instanceof Error ? error.message : String(error)}`)); }
          await publishCheckpoint();
          const diff = await readWorkspaceDiff(workspacePath, event.turnId);
          socket.send(JSON.stringify({ type: "relay.workspace.diff", diff }));
          socket.send(JSON.stringify({ type: "relay.agent.event", event }));
        } else {
          if (event.type === "command.exited") socket.send(JSON.stringify({ type: "relay.collab.event", event: await agentPreviewEvent(agentPath, event.turnId) }));
          socket.send(JSON.stringify({ type: "relay.agent.event", event }));
        }
      }
    })();
    const { threadId } = await adapter.start({
      cwd: agentPath,
      ...(options.model ? { model: options.model } : {}),
    });
    console.log(out.success(`${out.label("Codex thread")} ${out.muted(threadId)}`));
    await publishCheckpoint(true);
    console.log(out.success(`${out.label("Remote room")} ${out.value(relayUrl)}`));
    const inviteToken = `${created.code}.${sessionSecret}`;
    console.log(`\n${out.label("Room token")} ${chalk.bold.cyan(inviteToken)}`);
    console.log(`\n${out.label("Invite someone with")}`);
    const relayArgument = relayUrl === defaultRelayUrl ? "" : ` --relay '${relayUrl}'`;
    console.log(`  ${out.command(`multicode join ${inviteToken}${relayArgument} --name 'Their name'`)}`);
    console.log(`\n${chalk.green("●")} ${out.label("Ready for prompts")} ${out.muted("Type a prompt and press Enter. Shared prompts run in queue order.")}`);

    socket.on("message", (data) => {
      let message: RelayServerMessage;
      try {
        message = JSON.parse(data.toString()) as RelayServerMessage;
      } catch {
        console.error(err.error("Received an invalid message from the relay"));
        return;
      }
      if (message.type === "relay.room.created") return;
      if (message.type === "workspace.checkpoint.request") {
        void publishCheckpoint(false, message.participantId).catch((error: unknown) => {
          console.error(err.error(`Unable to send requested checkpoint: ${error instanceof Error ? error.message : String(error)}`));
        });
        return;
      }
      if (message.type === "prompt.started") {
        void adapter.sendPrompt({ promptId: message.prompt.promptId, text: message.prompt.text }).catch((error: unknown) => {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
              type: "relay.prompt.failed",
              promptId: message.prompt.promptId,
              message: error instanceof Error ? error.message : String(error),
            }));
          }
        });
      }
      printRoomMessage(message, false);
      if (message.type === "room.error" && message.fatal) void shutdown();
    });

    const disconnected = new Promise<void>((resolve) => {
      socket?.once("close", () => {
        console.error(`\n${err.error("Disconnected from relay; the remote room has closed.")}`);
        resolve();
      });
    });
    input = promptInput((text) => {
      if (socket?.readyState !== WebSocket.OPEN) {
        console.error(err.warning("Not connected; prompt was not sent."));
        return;
      }
      socket.send(JSON.stringify({ type: "prompt.submit", promptId: randomUUID(), text }));
    });
    cleanupSignals = installStopHandlers(async () => {
      console.error(`\n${err.info("■", "Stopping remote room…")}`);
      await shutdown();
    });
    if (options.prompt) {
      socket.send(JSON.stringify({ type: "prompt.submit", promptId: randomUUID(), text: options.prompt }));
    }
    await Promise.race([eventTask, disconnected]);
  } finally {
    cleanupSignals();
    await shutdown();
  }
}

async function joinRoom(inviteOrCode: string, options: { name: string; relay?: string }): Promise<void> {
  let url: URL;
  let token: string;
  if (/^wss?:\/\//i.test(inviteOrCode)) {
    url = new URL(inviteOrCode);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("Invite must use ws:// or wss://");
    const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
    token = fragment.get("token") ?? url.searchParams.get("token") ?? "";
    if (!token) throw new Error("Invite URL is missing its room token");
    const [urlCode, urlSecret] = token.split(".", 2);
    if (!urlSecret || !/^[A-Za-z0-9_-]{40,}$/.test(urlSecret)) throw new Error("Invalid room token");
    const canonicalCode = (urlCode ?? "").replace(/-/g, "").toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{10}$/.test(canonicalCode)) throw new Error("Invalid room code");
    const roomCode = `${canonicalCode.slice(0, 5)}-${canonicalCode.slice(5)}`;
    token = roomCode;
    url.hash = "";
    url.searchParams.delete("token");
  } else {
    const relayUrl = options.relay ?? defaultRelayUrl;
    const [roomCode, roomKey] = inviteOrCode.split(".", 2);
    if (!roomKey || !/^[A-Za-z0-9_-]{40,}$/.test(roomKey)) throw new Error("Invalid room token");
    const canonical = (roomCode ?? "").replace(/-/g, "").toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{10}$/.test(canonical)) throw new Error("Invalid room code");
    token = `${canonical.slice(0, 5)}-${canonical.slice(5)}`;
    url = remoteUrl(relayUrl, `/rooms/${token}`);
  }

  const socket = await openWebSocket(url);
  let joined = false;
  let joinedRoomId: string | undefined;
  let input: Interface | undefined;
  let workspaceState: ParticipantWorkspaceState | undefined;
  let syncTask = Promise.resolve();
  const checkpointReceiver = new CheckpointReceiver();

  const synchronize = async (roomId: string, checkpoint: WorkspaceCheckpoint): Promise<void> => {
    workspaceState ??= await prepareParticipantWorkspace({
      cwd: process.cwd(),
      roomId,
      baseCommit: checkpoint.baseCommit,
    });
    if (workspaceState) console.error(`\n${err.label("Room workspace")} ${workspaceState.root}`);
    await applyWorkspaceCheckpoint(workspaceState, checkpoint);
    console.error(`\n${err.success(`${err.label("Workspace synchronized")} ${err.muted(`${checkpoint.commit.slice(0, 12)} · checkpoint ${checkpoint.sequence}`)}`)}`);
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "workspace.ack", sequence: checkpoint.sequence, commit: checkpoint.commit }));
    }
  };

  const queueSynchronization = (roomId: string, checkpoint: WorkspaceCheckpoint): void => {
    syncTask = syncTask.then(async () => {
      await synchronize(roomId, checkpoint);
      if (joined) return;
      joined = true;
      console.log(`${chalk.green("●")} ${out.label("Ready for prompts")} ${out.muted("Type a prompt and press Enter to add it to the shared queue.")}`);
      input = promptInput((text) => {
        if (socket.readyState !== WebSocket.OPEN) {
          console.error(err.warning("Not connected; prompt was not sent."));
          return;
        }
        socket.send(JSON.stringify({ type: "prompt.submit", promptId: randomUUID(), text }));
      });
    }).catch((error: unknown) => {
      console.error(err.error(`${err.label("Workspace synchronization failed")} ${error instanceof Error ? error.message : String(error)}`));
      socket.close(4005, "Workspace synchronization failed");
    });
  };

  const closed = new Promise<void>((resolve, reject) => {
    socket.send(JSON.stringify({ type: "room.join", token, name: options.name }));
    socket.on("message", (data) => {
      let message: RoomServerMessage;
      try {
        message = JSON.parse(data.toString()) as RoomServerMessage;
      } catch {
        console.error(err.error("Received an invalid message from the room"));
        return;
      }
      printRoomMessage(message);
      if (message.type === "room.welcome" && !joined) {
        if (!message.latestCheckpoint) {
          console.error(err.error("Room has no workspace checkpoint; cannot synchronize safely."));
          socket.close(4004, "Room has no workspace checkpoint");
          return;
        }
        joinedRoomId = message.roomId;
        const initialCheckpoint = message.latestCheckpoint;
        if ("bundle" in initialCheckpoint) queueSynchronization(message.roomId, initialCheckpoint);
        else socket.send(JSON.stringify({ type: "workspace.checkpoint.request", sequence: initialCheckpoint.sequence }));
      }
      if (message.type === "workspace.checkpoint") {
        const roomId = joinedRoomId;
        if (!roomId) return;
        queueSynchronization(roomId, message.checkpoint);
      }
      if (message.type === "workspace.checkpoint.start") checkpointReceiver.start(message.checkpoint);
      if (message.type === "workspace.checkpoint.chunk") {
        try { checkpointReceiver.chunk(message.chunk); } catch (error) {
          console.error(err.error(error instanceof Error ? error.message : String(error)));
          socket.close(4005, "Invalid checkpoint transfer");
        }
      }
      if (message.type === "workspace.checkpoint.complete") {
        const roomId = joinedRoomId;
        if (!roomId) return;
        try { queueSynchronization(roomId, checkpointReceiver.complete(message.sequence)); } catch (error) {
          console.error(err.error(error instanceof Error ? error.message : String(error)));
          socket.close(4005, "Invalid checkpoint transfer");
        }
      }
      if (message.type === "room.error" && message.fatal) socket.close();
    });
    socket.once("error", reject);
    socket.once("close", (code, reason) => {
      input?.close();
      console.error(`\n${err.warning(`Disconnected from room${reason.length ? `: ${reason.toString()}` : ` (code ${code})`}`)}`);
      resolve();
    });
  });

  const cleanupSignals = installStopHandlers(async () => socket.close(1000, "Participant left"));
  try {
    await closed;
    await syncTask;
  } finally {
    cleanupSignals();
    if (workspaceState) {
      console.error(err.info("↻", "Restoring your original branch…"));
      await restoreParticipantWorkspace(workspaceState);
      console.error(err.success(`${err.label("Restored")} ${err.value(workspaceState.originalBranch ?? workspaceState.originalHead.slice(0, 12))}`));
      if (workspaceState.backupRef) console.error(err.success(`${err.label("Local changes preserved")} ${err.muted(workspaceState.backupRef)}`));
    }
  }
}

async function serveRelay(options: { host: string; port: string; maxRooms: string; roomsPerIp: string }): Promise<void> {
  const maxRooms = Number(options.maxRooms);
  if (!Number.isInteger(maxRooms) || maxRooms < 1) throw new Error(`Invalid room limit: ${options.maxRooms}`);
  const maxRoomsPerIp = Number(options.roomsPerIp);
  if (!Number.isInteger(maxRoomsPerIp) || maxRoomsPerIp < 1) throw new Error(`Invalid per-IP room limit: ${options.roomsPerIp}`);
  const databaseUrl = process.env.MULTICODE_DATABASE_URL;
  const relay = new RelayServer({ maxRooms, maxRoomsPerIp, ...(databaseUrl ? { store: new PostgresRelayRoomStore(databaseUrl) } : {}) });
  const bound = await relay.listen({ host: options.host, port: parsePort(options.port) });
  console.log(out.success(`${out.label("MultiCode relay")} ${out.value(`http://${bound.host}:${bound.port}`)}`));
  console.log(out.success(`${out.label("Health check")} ${out.value(`http://${bound.host}:${bound.port}/health`)}`));

  await new Promise<void>((resolve) => {
    const cleanupSignals = installStopHandlers(async () => {
      console.error(`\n${err.info("■", "Stopping relay…")}`);
      cleanupSignals();
      await relay.close();
      resolve();
    });
  });
}

async function serveSession(options: { session: string; socket?: string }): Promise<void> {
  const databaseUrl = process.env.MULTICODE_DATABASE_URL;
  const sessionDirectory = path.join(homedir(), ".multicode", "sessions", sanitizeRoomId(options.session));
  const token = await writeSessionToken(path.join(sessionDirectory, "token"));
  const journal = databaseUrl ? new PostgresJournal(databaseUrl) : new FileJournal(path.join(sessionDirectory, "journal.jsonl"));
  if (journal instanceof PostgresJournal) await journal.migrate();
  const socketPath = options.socket ?? (process.platform === "win32" ? `\\\\.\\pipe\\multicode-${sanitizeRoomId(options.session)}` : path.join(sessionDirectory, "daemon.sock"));
  const ipc = new LocalIpcServer(token, async (payload) => ({ session: options.session, payload }));
  await ipc.listen(socketPath);
  console.log(out.success(`${out.label("Session daemon")} ${out.value(options.session)} ${out.muted(`listening on ${socketPath}`)}`));
  await new Promise<void>((resolve) => {
    const stop = async () => { await ipc.close(); if (journal instanceof PostgresJournal) await journal.close(); resolve(); };
    process.once("SIGINT", () => void stop()); process.once("SIGTERM", () => void stop());
  });
}

async function cleanupRoomWorkspace(roomId: string, options: { force?: boolean }): Promise<void> {
  const removed = await cleanupParticipantWorkspace({ roomId, ...(options.force ? { force: true } : {}) });
  console.log(out.success(`${out.label("Removed room workspace")} ${out.value(removed)}`));
}

const defaultName = (() => {
  try {
    return userInfo().username;
  } catch {
    return "participant";
  }
})();

const program = new Command()
  .name("multicode")
  .description("Collaborate around a local coding-agent session")
  .version("0.2.0");

program.command("doctor").description("Check local prerequisites").action(doctor);

const room = program.command("room", { hidden: true }).description("Internal room commands");
room
  .command("create")
  .description("Create a local agent room in the current workspace")
  .option("--agent <agent>", "agent adapter", "codex")
  .option("--prompt <prompt>", "send an initial prompt")
  .option("--model <model>", "override the configured Codex model")
  .option("--dry-run", "validate the repository without starting Codex")
  .action(createRoom);

room
  .command("host")
  .description("Host an interactive room that other people can join")
  .option("--agent <agent>", "agent adapter", "codex")
  .option("--prompt <prompt>", "queue an initial prompt")
  .option("--model <model>", "override the configured Codex model")
  .option("--name <name>", "host display name", defaultName)
  .option("--listen <address>", "address to listen on", "127.0.0.1")
  .option("--port <port>", "port to listen on; use 0 for any free port", "7337")
  .option("--public-url <url>", "public ws:// or wss:// base URL for invitations")
  .option("--relay <url>", "central relay ws:// or wss:// URL")
  .option("--local", "host directly instead of using the central relay")
  .action(hostRoom);

room
  .command("join")
  .description("Join an interactive room using an invite URL")
  .argument("<invite-or-code>", "room code or invite URL printed by the host")
  .option("--name <name>", "participant display name", defaultName)
  .option("--relay <url>", "central relay URL (or set MULTICODE_RELAY_URL)")
  .action(joinRoom);

program
  .command("host")
  .description(`Start a shared Codex room through ${defaultRelayUrl}`)
  .option("--agent <agent>", "agent adapter", "codex")
  .option("--prompt <prompt>", "queue an initial prompt")
  .option("--model <model>", "override the configured Codex model")
  .option("--name <name>", "host display name", defaultName)
  .option("--relay <url>", "override the central relay URL")
  .action((options) => hostRoom({ ...options, listen: "127.0.0.1", port: "7337" }));

program
  .command("join")
  .description(`Join a shared room through ${defaultRelayUrl}`)
  .argument("<full-token>", "complete room token printed by the host")
  .option("--name <name>", "participant display name", defaultName)
  .option("--relay <url>", "override the central relay URL")
  .action(joinRoom);

program
  .command("cleanup")
  .description("Remove a preserved participant room workspace")
  .argument("<room-id>", "room identifier printed when joining")
  .option("--force", "remove the room workspace even when it contains local changes")
  .action(cleanupRoomWorkspace);

const relay = program.command("relay", { hidden: true }).description("Run central relay infrastructure");
relay
  .command("serve")
  .description("Serve authenticated rooms for remote hosts and participants")
  .option("--host <address>", "address to listen on", process.env.MULTICODE_RELAY_HOST ?? "127.0.0.1")
  .option("--port <port>", "port to listen on", process.env.MULTICODE_RELAY_PORT ?? "7337")
  .option("--max-rooms <count>", "maximum concurrent rooms", process.env.MULTICODE_MAX_ROOMS ?? "100")
  .option("--rooms-per-ip <count>", "maximum active rooms per originating IP", process.env.MULTICODE_ROOMS_PER_IP ?? "5")
  .action(serveRelay);

program
  .command("session", { hidden: true })
  .description("Run the protocol-v2 host session daemon")
  .requiredOption("--session <room-id>", "room/session identifier")
  .option("--socket <path>", "local IPC socket or named pipe")
  .action(serveSession);

program.parseAsync().catch((error: unknown) => {
  console.error(err.error(`${err.label("Error")} ${error instanceof Error ? error.message : String(error)}`));
  process.exitCode = 1;
});
