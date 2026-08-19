#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { networkInterfaces, userInfo } from "node:os";
import { createInterface, type Interface } from "node:readline";
import { promisify } from "node:util";
import { Command } from "commander";
import { CodexAppServerAdapter } from "@multicode/agent-adapters";
import type { AgentEvent, RelayServerMessage, RoomServerMessage, WorkspaceCheckpoint, WorkspaceDiff } from "@multicode/protocol";
import { RelayServer, RoomRelay } from "@multicode/relay";
import {
  applyWorkspaceCheckpoint,
  createWorkspaceCheckpoint,
  inspectRepository,
  prepareParticipantWorkspace,
  restoreParticipantWorkspace,
  type ParticipantWorkspaceState,
} from "@multicode/workspace";
import WebSocket from "ws";

const execFileAsync = promisify(execFile);
const defaultRelayUrl = process.env.MULTICODE_RELAY_URL ?? "wss://multicode.luisagd.com";

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

  for (const check of checks) console.log(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`);

  try {
    const repository = await inspectRepository(process.cwd());
    console.log(`✓ Repository: ${repository.root}`);
    console.log(`  HEAD: ${repository.head.slice(0, 12)}${repository.dirty ? " (uncommitted changes excluded)" : ""}`);
  } catch (error) {
    console.log(`- Repository: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

function printAgentEvent(event: AgentEvent): void {
  switch (event.type) {
    case "agent.message.delta":
    case "command.output":
      process.stdout.write(event.text);
      break;
    case "approval.requested":
      console.error(`\nApproval required on the host (${event.approvalKind}, request ${event.requestId}).`);
      console.error("Interactive approval handling is not implemented; the request remains pending.");
      break;
    case "agent.error":
      console.error(`\n[codex] ${event.message}`);
      break;
    case "turn.completed":
      console.error(`\n✓ Turn completed${event.status ? ` (${event.status})` : ""}`);
      break;
    default:
      break;
  }
}

function printRoomMessage(message: RoomServerMessage, includeAgent = true): void {
  switch (message.type) {
    case "room.welcome":
      console.log(`✓ Joined room ${message.roomId}`);
      console.log(`  Participants: ${message.participants.map((participant) => participant.name).join(", ")}`);
      if (message.activePrompt) console.log(`  Active prompt: ${message.activePrompt.participantName}: ${message.activePrompt.text}`);
      if (message.queue.length) console.log(`  ${message.queue.length} prompt(s) waiting`);
      if (message.latestDiff) printWorkspaceDiff(message.latestDiff);
      break;
    case "participant.joined":
      console.error(`\n+ ${message.participant.name} joined the room`);
      break;
    case "participant.left":
      console.error(`\n- ${message.name} left the room`);
      break;
    case "prompt.queued":
      console.error(`\n→ ${message.prompt.participantName} queued prompt #${message.position}: ${message.prompt.text}`);
      break;
    case "prompt.started":
      console.error(`\n▶ ${message.prompt.participantName}: ${message.prompt.text}`);
      break;
    case "agent.event":
      if (includeAgent) printAgentEvent(message.event);
      break;
    case "workspace.diff":
      printWorkspaceDiff(message.diff);
      break;
    case "workspace.checkpoint":
      console.error(`\n↻ Workspace checkpoint ${message.checkpoint.sequence}: ${message.checkpoint.commit.slice(0, 12)}`);
      break;
    case "participant.synced":
      console.error(`\n✓ Participant synchronized at checkpoint ${message.sequence}`);
      break;
    case "room.error":
      console.error(`\nRoom error: ${message.message}`);
      break;
  }
}

function printWorkspaceDiff(diff: WorkspaceDiff): void {
  console.error(`\n── workspace after ${diff.revision} ${diff.truncated ? "(truncated) " : ""}──`);
  console.error(diff.text || "No tracked workspace changes.");
  console.error("── end workspace diff ──");
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

async function prepareRoom(dryRun = false): Promise<{
  roomId: string;
  workspacePath?: string;
  baseCommit?: string;
}> {
  const repository = await inspectRepository(process.cwd());
  console.log(`✓ Repository: ${repository.root}`);
  if (repository.dirty) console.log("! Uncommitted and untracked changes will be included in synchronized checkpoints.");
  if (repository.operationInProgress) throw new Error("Finish the current Git operation before creating a room");
  if (dryRun) {
    console.log(`✓ Base commit: ${repository.head}`);
    console.log("✓ Repository is ready for a synchronized room");
    return { roomId: "dry-run" };
  }

  const roomId = randomUUID().split("-")[0] as string;
  console.log(`✓ Workspace: ${repository.root}`);
  console.log(`✓ Branch: ${repository.branch ?? "detached HEAD"}`);
  return { roomId, workspacePath: repository.root, baseCommit: repository.head };
}

async function createRoom(options: { agent: string; prompt?: string; model?: string; dryRun?: boolean }): Promise<void> {
  if (options.agent !== "codex") throw new Error("Only the codex adapter is available");
  const room = await prepareRoom(options.dryRun);
  if (options.dryRun || !room.workspacePath) return;

  const adapter = new CodexAppServerAdapter();
  const stop = installStopHandlers(async () => {
    console.error("\nStopping local room...");
    await adapter.stop();
  });
  const eventTask = (async () => {
    for await (const event of adapter.events()) printAgentEvent(event);
  })();
  const { threadId } = await adapter.start({ cwd: room.workspacePath, ...(options.model ? { model: options.model } : {}) });
  console.log(`✓ Codex thread: ${threadId}`);
  if (options.prompt) await adapter.sendPrompt({ promptId: randomUUID(), text: options.prompt });
  else console.log("Room is running locally. Pass --prompt to begin a turn.");
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
  const workspacePath = prepared.workspacePath;
  const baseCommit = prepared.baseCommit;
  let checkpointSequence = 0;
  let checkpointParent = baseCommit;
  const adapter = new CodexAppServerAdapter();
  const token = randomBytes(24).toString("base64url");
  const relay = new RoomRelay({
    roomId: prepared.roomId,
    token,
    hostName: options.name,
    onPrompt: async (prompt) => {
      await adapter.sendPrompt({ promptId: prompt.promptId, text: prompt.text });
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
    relay.publishWorkspaceCheckpoint(checkpoint);
  };

  const eventTask = (async () => {
    for await (const event of adapter.events()) {
      printAgentEvent(event);
      if (event.type === "turn.completed") {
        await publishCheckpoint();
        const diff = await readWorkspaceDiff(workspacePath, event.turnId);
        relay.publishWorkspaceDiff(diff);
        relay.publishAgentEvent(event);
        continue;
      }
      if (event.type === "command.exited") await publishCheckpoint();
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
      cwd: workspacePath,
      ...(options.model ? { model: options.model } : {}),
    });
    console.log(`✓ Codex thread: ${threadId}`);

    const bound = await relay.listen({ host: options.listen, port: parsePort(options.port) });
    await publishCheckpoint(true);
    const invite = inviteUrl({
      ...(options.publicUrl ? { publicUrl: options.publicUrl } : {}),
      listenHost: options.listen,
      port: bound.port,
      roomId: prepared.roomId,
      token,
    });
    console.log(`✓ Room ${prepared.roomId} listening on ${options.listen}:${bound.port}`);
    console.log("\nInvite someone with:");
    console.log(`  multicode room join '${invite}' --name 'Their name'`);
    if (!options.publicUrl && options.listen === "127.0.0.1") {
      console.log("\nLocal-only listener. Use --listen 0.0.0.0 for trusted LAN access or --public-url with a secure tunnel.");
    }
    console.log("\nType a prompt and press Enter. Prompts from all participants run in queue order.");

    input = promptInput((text) => relay.submitHostPrompt(text));
    cleanupSignals = installStopHandlers(async () => {
      console.error("\nStopping shared room...");
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
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
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
    const prepared = await prepareRoom();
    if (!prepared.workspacePath || !prepared.baseCommit) return;
    const workspacePath = prepared.workspacePath;
    const baseCommit = prepared.baseCommit;
    let checkpointSequence = 0;
    let checkpointParent = baseCommit;
    const publishCheckpoint = async (force = false): Promise<void> => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
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
      socket.send(JSON.stringify({ type: "relay.workspace.checkpoint", checkpoint }));
    };
    const eventTask = (async () => {
      for await (const event of adapter.events()) {
        printAgentEvent(event);
        if (!socket || socket.readyState !== WebSocket.OPEN) continue;
        if (event.type === "turn.completed") {
          await publishCheckpoint();
          const diff = await readWorkspaceDiff(workspacePath, event.turnId);
          socket.send(JSON.stringify({ type: "relay.workspace.diff", diff }));
          socket.send(JSON.stringify({ type: "relay.agent.event", event }));
        } else {
          if (event.type === "command.exited") await publishCheckpoint();
          socket.send(JSON.stringify({ type: "relay.agent.event", event }));
        }
      }
    })();
    const { threadId } = await adapter.start({
      cwd: workspacePath,
      ...(options.model ? { model: options.model } : {}),
    });
    console.log(`✓ Codex thread: ${threadId}`);
    await publishCheckpoint(true);
    console.log(`✓ Remote room created at ${relayUrl}`);
    console.log(`\nRoom code: ${created.code}`);
    console.log("\nInvite someone with:");
    const relayArgument = relayUrl === defaultRelayUrl ? "" : ` --relay '${relayUrl}'`;
    console.log(`  multicode join ${created.code}${relayArgument} --name 'Their name'`);
    console.log("\nType a prompt and press Enter. Prompts from all participants run in queue order.");

    socket.on("message", (data) => {
      let message: RelayServerMessage;
      try {
        message = JSON.parse(data.toString()) as RelayServerMessage;
      } catch {
        console.error("Received an invalid message from the relay");
        return;
      }
      if (message.type === "relay.room.created") return;
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
        console.error("\nDisconnected from relay; the remote room has closed.");
        resolve();
      });
    });
    input = promptInput((text) => {
      if (socket?.readyState !== WebSocket.OPEN) {
        console.error("Not connected; prompt was not sent.");
        return;
      }
      socket.send(JSON.stringify({ type: "prompt.submit", promptId: randomUUID(), text }));
    });
    cleanupSignals = installStopHandlers(async () => {
      console.error("\nStopping remote room...");
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
    url.hash = "";
    url.searchParams.delete("token");
  } else {
    const relayUrl = options.relay ?? defaultRelayUrl;
    const canonical = inviteOrCode.replace(/-/g, "").toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{10}$/.test(canonical)) throw new Error("Invalid room code");
    token = `${canonical.slice(0, 5)}-${canonical.slice(5)}`;
    url = remoteUrl(relayUrl, `/rooms/${token}`);
  }

  const socket = new WebSocket(url);
  let joined = false;
  let joinedRoomId: string | undefined;
  let input: Interface | undefined;
  let workspaceState: ParticipantWorkspaceState | undefined;
  let syncTask = Promise.resolve();

  const synchronize = async (roomId: string, checkpoint: WorkspaceCheckpoint): Promise<void> => {
    workspaceState ??= await prepareParticipantWorkspace({
      cwd: process.cwd(),
      roomId,
      baseCommit: checkpoint.baseCommit,
    });
    await applyWorkspaceCheckpoint(workspaceState, checkpoint);
    console.error(`\n✓ Workspace synchronized at ${checkpoint.commit.slice(0, 12)} (checkpoint ${checkpoint.sequence})`);
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "workspace.ack", sequence: checkpoint.sequence, commit: checkpoint.commit }));
    }
  };

  const closed = new Promise<void>((resolve, reject) => {
    socket.once("open", () => socket.send(JSON.stringify({ type: "room.join", token, name: options.name })));
    socket.on("message", (data) => {
      let message: RoomServerMessage;
      try {
        message = JSON.parse(data.toString()) as RoomServerMessage;
      } catch {
        console.error("Received an invalid message from the room");
        return;
      }
      printRoomMessage(message);
      if (message.type === "room.welcome" && !joined) {
        if (!message.latestCheckpoint) {
          console.error("Room has no workspace checkpoint; cannot synchronize safely.");
          socket.close(4004, "Room has no workspace checkpoint");
          return;
        }
        joinedRoomId = message.roomId;
        const initialCheckpoint = message.latestCheckpoint;
        syncTask = syncTask.then(async () => {
          await synchronize(message.roomId, initialCheckpoint);
          joined = true;
          console.log("Type a prompt and press Enter to add it to the shared queue.");
          input = promptInput((text) => {
            if (socket.readyState !== WebSocket.OPEN) {
              console.error("Not connected; prompt was not sent.");
              return;
            }
            socket.send(JSON.stringify({ type: "prompt.submit", promptId: randomUUID(), text }));
          });
        }).catch((error: unknown) => {
          console.error(`Workspace synchronization failed: ${error instanceof Error ? error.message : String(error)}`);
          socket.close(4005, "Workspace synchronization failed");
        });
      }
      if (message.type === "workspace.checkpoint") {
        const roomId = joinedRoomId;
        if (!roomId) return;
        syncTask = syncTask.then(() => synchronize(roomId, message.checkpoint)).catch((error: unknown) => {
          console.error(`Workspace synchronization failed: ${error instanceof Error ? error.message : String(error)}`);
          socket.close(4005, "Workspace synchronization failed");
        });
      }
      if (message.type === "room.error" && message.fatal) socket.close();
    });
    socket.once("error", reject);
    socket.once("close", (code, reason) => {
      input?.close();
      console.error(`\nDisconnected from room${reason.length ? `: ${reason.toString()}` : ` (code ${code})`}`);
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
      console.error("Restoring your original branch...");
      await restoreParticipantWorkspace(workspaceState);
      console.error(`✓ Restored ${workspaceState.originalBranch ?? workspaceState.originalHead.slice(0, 12)}`);
      if (workspaceState.backupRef) console.error(`✓ Local changes preserved at ${workspaceState.backupRef}`);
    }
  }
}

async function serveRelay(options: { host: string; port: string; maxRooms: string; roomsPerIp: string }): Promise<void> {
  const maxRooms = Number(options.maxRooms);
  if (!Number.isInteger(maxRooms) || maxRooms < 1) throw new Error(`Invalid room limit: ${options.maxRooms}`);
  const maxRoomsPerIp = Number(options.roomsPerIp);
  if (!Number.isInteger(maxRoomsPerIp) || maxRoomsPerIp < 1) throw new Error(`Invalid per-IP room limit: ${options.roomsPerIp}`);
  const relay = new RelayServer({ maxRooms, maxRoomsPerIp });
  const bound = await relay.listen({ host: options.host, port: parsePort(options.port) });
  console.log(`✓ MultiCode relay listening on http://${bound.host}:${bound.port}`);
  console.log(`✓ Health check: http://${bound.host}:${bound.port}/health`);

  await new Promise<void>((resolve) => {
    const cleanupSignals = installStopHandlers(async () => {
      console.error("\nStopping relay...");
      cleanupSignals();
      await relay.close();
      resolve();
    });
  });
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

const room = program.command("room").description("Manage collaboration rooms");
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
  .argument("<code>", "room code printed by the host")
  .option("--name <name>", "participant display name", defaultName)
  .option("--relay <url>", "override the central relay URL")
  .action(joinRoom);

const relay = program.command("relay").description("Run central relay infrastructure");
relay
  .command("serve")
  .description("Serve authenticated rooms for remote hosts and participants")
  .option("--host <address>", "address to listen on", process.env.MULTICODE_RELAY_HOST ?? "127.0.0.1")
  .option("--port <port>", "port to listen on", process.env.MULTICODE_RELAY_PORT ?? "7337")
  .option("--max-rooms <count>", "maximum concurrent rooms", process.env.MULTICODE_MAX_ROOMS ?? "100")
  .option("--rooms-per-ip <count>", "maximum active rooms per originating IP", process.env.MULTICODE_ROOMS_PER_IP ?? "5")
  .action(serveRelay);

program.parseAsync().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
