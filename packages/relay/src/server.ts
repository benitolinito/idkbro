import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import {
  relayHostMessageSchema,
  roomClientMessageSchema,
  checkpointChunkBytes,
  type AgentConfig,
  type AgentEvent,
  type QueuedPrompt,
  type RelayHostMessage,
  type RelayServerMessage,
  type RoomParticipant,
  type RoomServerMessage,
  type WorkspaceDiff,
  type WorkspaceCheckpointChunk,
  type WorkspaceCheckpointDescriptor,
  type CollaborationEvent,
} from "@multicode/protocol";
import WebSocket, { WebSocketServer } from "ws";
import type { RelayRoomStore } from "./store.js";
import { TokenBucket, collaborationRateGroup, collaborationRatePolicy, createCollaborationBucket } from "./rate-limit.js";

const maxRelayFrameBytes = 256 * 1024;
const maxSocketBufferedBytes = 1024 * 1024;

export interface RelayServerOptions {
  maxRooms?: number;
  maxRoomsPerIp?: number;
  maxParticipantsPerRoom?: number;
  authenticationTimeoutMs?: number;
  store?: RelayRoomStore;
}

const roomCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateRoomCode(): string {
  const bytes = randomBytes(10);
  const raw = [...bytes].map((value) => roomCodeAlphabet[value % roomCodeAlphabet.length]).join("");
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

function canonicalRoomCode(value: string): string {
  return value.replace(/-/g, "").toUpperCase();
}

function originatingIp(request: IncomingMessage): string {
  const cloudflareIp = request.headers["cf-connecting-ip"];
  const forwardedIp = request.headers["x-forwarded-for"];
  const headerIp = Array.isArray(cloudflareIp)
    ? cloudflareIp[0]
    : cloudflareIp ?? (Array.isArray(forwardedIp) ? forwardedIp[0] : forwardedIp?.split(",")[0]);
  const ip = headerIp?.trim() || request.socket.remoteAddress || "unknown";
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

const agentEventTypes = new Set<AgentEvent["type"]>([
  "agent.started",
  "turn.started",
  "turn.completed",
  "agent.message.delta",
  "agent.message.completed",
  "agent.reasoning.delta",
  "agent.reasoning.completed",
  "command.started",
  "command.output",
  "command.exited",
  "approval.requested",
  "agent.error",
  "agent.exited",
]);

function secretMatches(expected: string, received: string): boolean {
  const expectedHash = createHash("sha256").update(expected).digest();
  const receivedHash = createHash("sha256").update(received).digest();
  return timingSafeEqual(expectedHash, receivedHash);
}

function send(socket: WebSocket, message: RelayServerMessage): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > maxSocketBufferedBytes) {
    socket.close(1013, "Relay backpressure limit exceeded");
    return;
  }
  socket.send(JSON.stringify(message));
}

function reject(socket: WebSocket, message: string, code = 4003): void {
  send(socket, { type: "room.error", message, fatal: true });
  socket.close(code, message.slice(0, 120));
}

class CentralRoom {
  private readonly participants = new Map<WebSocket, RoomParticipant>();
  private readonly queue: QueuedPrompt[] = [];
  private readonly steeringPromptIds = new Set<string>();
  private activePrompt: QueuedPrompt | null = null;
  private latestDiff: WorkspaceDiff | null = null;
  private latestCheckpoint: WorkspaceCheckpointDescriptor | null = null;
  private agentConfig: AgentConfig | undefined;
  private readonly checkpointTransfers = new Map<string, {
    descriptor: WorkspaceCheckpointDescriptor;
    targetParticipantId?: string;
    nextIndex: number;
    receivedBytes: number;
    hash: ReturnType<typeof createHash>;
  }>();
  private readonly collabHistory: CollaborationEvent[] = [];
  private collabTail: Promise<void> = Promise.resolve();
  private readonly rateWindows = new WeakMap<WebSocket, Map<string, { startedAt: number; count: number }>>();
  private readonly collaborationRates = new WeakMap<WebSocket, Map<string, TokenBucket>>();
  private readonly roomPresenceRate = new TokenBucket(collaborationRatePolicy.roomPresence);
  private droppedPresenceEvents = 0;
  private closed = false;
  private hostDisconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private hostSocket: WebSocket;
  readonly host: RoomParticipant;

  constructor(
    readonly roomId: string,
    private readonly participantToken: string,
    readonly resumeToken: string,
    hostSocket: WebSocket,
    hostName: string,
    readonly ownerIp: string,
    private readonly authenticationTimeoutMs: number,
    private readonly maxParticipants: number,
    private readonly persistEvent: (event: { id: string; kind: string; payload: string }) => Promise<void>,
    private readonly onClosed: () => void,
  ) {
    this.hostSocket = hostSocket;
    this.host = {
      id: "host",
      name: hostName,
      joinedAt: new Date().toISOString(),
      host: true,
      synced: true,
      capabilities: ["viewer", "editor", "prompter", "reviewer", "host"],
    };
    this.attachHost(hostSocket);
  }

  get code(): string { return this.participantToken; }
  get metrics(): { participants: number; droppedPresenceEvents: number } {
    return { participants: this.participants.size + 1, droppedPresenceEvents: this.droppedPresenceEvents };
  }

  resume(socket: WebSocket): void {
    if (this.closed) { reject(socket, "Room is closed", 4004); return; }
    if (this.hostSocket.readyState === WebSocket.OPEN) this.hostSocket.close(4000, "Host connection replaced");
    this.hostSocket = socket; this.attachHost(socket);
    send(socket, { type: "room.welcome", roomId: this.roomId, selfId: this.host.id, participants: [this.host, ...this.participants.values()], activePrompt: this.activePrompt, queue: [...this.queue], latestDiff: this.latestDiff, latestCheckpoint: this.latestCheckpoint, collabHistory: [...this.collabHistory], ...(this.agentConfig ? { agentConfig: this.agentConfig } : {}) });
  }

  private attachHost(socket: WebSocket): void {
    if (this.hostDisconnectTimer) clearTimeout(this.hostDisconnectTimer); this.hostDisconnectTimer = undefined;
    socket.on("message", (data) => { if (this.hostSocket === socket) this.receiveHost(data.toString()); });
    const disconnected = (code?: number) => {
      if (this.hostSocket !== socket || this.closed) return;
      if (code === 1000) { this.close("Host stopped room"); return; }
      this.broadcast({ type: "room.error", message: "Host connection interrupted; waiting for it to resume" }, socket);
      this.hostDisconnectTimer = setTimeout(() => this.close("Host did not reconnect"), 30_000); this.hostDisconnectTimer.unref();
    };
    socket.once("close", disconnected); socket.once("error", () => disconnected());
  }

  acceptParticipant(socket: WebSocket): void {
    if (this.closed) {
      reject(socket, "Room is closed", 4004);
      return;
    }
    const timer = setTimeout(() => reject(socket, "Join timed out", 4001), this.authenticationTimeoutMs);
    const authenticate = (data: WebSocket.RawData) => {
      let value: unknown;
      try {
        value = JSON.parse(data.toString());
      } catch {
        reject(socket, "Messages must be valid JSON", 4002);
        return;
      }
      const parsed = roomClientMessageSchema.safeParse(value);
      if (!parsed.success || parsed.data.type !== "room.join") {
        reject(socket, "A valid room.join message is required", 4001);
        return;
      }
      if (!secretMatches(canonicalRoomCode(this.participantToken), canonicalRoomCode(parsed.data.token))) {
        reject(socket, "Invalid room token");
        return;
      }
      clearTimeout(timer);
      this.join(socket, parsed.data.name, parsed.data.requestedRole ?? "editor");
    };
    socket.once("message", authenticate);
    socket.once("close", () => clearTimeout(timer));
  }

  close(reason = "Room closed"): void {
    if (this.closed) return;
    this.closed = true;
    if (this.hostDisconnectTimer) clearTimeout(this.hostDisconnectTimer); this.hostDisconnectTimer = undefined;
    for (const socket of this.participants.keys()) {
      send(socket, { type: "room.error", message: reason, fatal: true });
      socket.close(1012, reason.slice(0, 120));
    }
    this.participants.clear();
    if (this.hostSocket.readyState === WebSocket.OPEN) this.hostSocket.close(1001, reason.slice(0, 120));
    this.onClosed();
  }

  private join(socket: WebSocket, name: string, requestedRole: "viewer" | "editor"): void {
    if (this.participants.size + 1 >= this.maxParticipants) {
      reject(socket, `Room participant limit of ${this.maxParticipants} reached`, 4004);
      return;
    }
    const participant: RoomParticipant = {
      id: randomUUID(),
      name,
      joinedAt: new Date().toISOString(),
      host: false,
      synced: this.latestCheckpoint === null,
      capabilities: requestedRole === "viewer" ? ["viewer"] : ["viewer", "editor", "prompter"],
    };
    this.participants.set(socket, participant);
    send(socket, {
      type: "room.welcome",
      roomId: this.roomId,
      selfId: participant.id,
      participants: [this.host, ...this.participants.values()],
      activePrompt: this.activePrompt,
      queue: [...this.queue],
      latestDiff: this.latestDiff,
      latestCheckpoint: this.latestCheckpoint,
      collabHistory: [...this.collabHistory],
      ...(this.agentConfig ? { agentConfig: this.agentConfig } : {}),
    });
    this.broadcast({ type: "participant.joined", participant }, socket);

    socket.on("message", (data) => this.receiveParticipant(socket, data.toString()));
    socket.once("close", () => this.leave(socket));
    socket.once("error", () => this.leave(socket));
  }

  private receiveParticipant(socket: WebSocket, raw: string): void {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      send(socket, { type: "room.error", message: "Messages must be valid JSON" });
      return;
    }
    const parsed = roomClientMessageSchema.safeParse(value);
    if (!parsed.success || parsed.data.type === "room.join") {
      send(socket, { type: "room.error", message: "Invalid participant message" });
      return;
    }
    const participantMessage = parsed.data;
    const participant = this.participants.get(socket);
    if (!participant) return;
    if (participantMessage.type === "workspace.ack") {
      if (!this.latestCheckpoint || participantMessage.sequence !== this.latestCheckpoint.sequence || participantMessage.commit !== this.latestCheckpoint.commit) {
        send(socket, { type: "room.error", message: "Workspace acknowledgement does not match the latest checkpoint" });
        return;
      }
      participant.synced = true;
      this.broadcast({
        type: "participant.synced",
        participantId: participant.id,
        sequence: participantMessage.sequence,
        commit: participantMessage.commit,
      });
      this.dispatchNext();
      return;
    }
    if (participantMessage.type === "workspace.checkpoint.request") {
      if (!this.latestCheckpoint || participantMessage.sequence !== this.latestCheckpoint.sequence) {
        send(socket, { type: "room.error", message: "Requested workspace checkpoint is no longer available" });
        return;
      }
      send(this.hostSocket, {
        type: "workspace.checkpoint.request",
        participantId: participant.id,
        sequence: participantMessage.sequence,
      });
      return;
    }
    if (participantMessage.type === "collab.publish") {
      if ((participantMessage.event.kind === "document.update" || participantMessage.event.kind === "manifest.operation") && !participant.capabilities.includes("editor")) {
        send(socket, { type: "room.error", message: "Participant does not have editor capability" });
        return;
      }
      const group = collaborationRateGroup(participantMessage.event.kind);
      let buckets = this.collaborationRates.get(socket);
      if (!buckets) { buckets = new Map(); this.collaborationRates.set(socket, buckets); }
      let bucket = buckets.get(group);
      if (!bucket) { bucket = createCollaborationBucket(group); buckets.set(group, bucket); }
      const participantRate = bucket.take();
      if (group === "presence") {
        if (!participantRate.allowed) { this.droppedPresenceEvents += 1; return; }
        const roomRate = this.roomPresenceRate.take();
        if (!roomRate.allowed) { this.droppedPresenceEvents += 1; return; }
      } else if (!participantRate.allowed) {
        send(socket, {
          type: "collab.rate_limited",
          eventId: participantMessage.event.id,
          kind: participantMessage.event.kind,
          retryAfterMs: participantRate.retryAfterMs,
        });
        return;
      }
      send(this.hostSocket, { type: "collab.submitted", participantId: participant.id, event: participantMessage.event });
      return;
    }
    if (participantMessage.type === "approval.resolve") {
      if (!participant.capabilities.includes("reviewer")) { send(socket, { type: "room.error", message: "Participant does not have reviewer capability" }); return; }
      send(this.hostSocket, { type: "approval.submitted", participantId: participant.id, requestId: participantMessage.requestId, decision: participantMessage.decision }); return;
    }
    if (participantMessage.type === "prompt.update" || participantMessage.type === "prompt.remove" || participantMessage.type === "prompt.steer") {
      if (!this.allowRate(socket, "queue", 60, 60_000)) { send(socket, { type: "room.error", message: "Queue action rate limit exceeded" }); return; }
      const index = this.queue.findIndex((prompt) => prompt.promptId === participantMessage.promptId);
      const queued = this.queue[index];
      if (!queued) { send(socket, { type: "room.error", message: "Queued prompt was not found" }); return; }
      if (queued.participantId !== participant.id) { send(socket, { type: "room.error", message: "Only the prompt owner can change it" }); return; }
      if (this.steeringPromptIds.has(queued.promptId)) { send(socket, { type: "room.error", message: "That prompt is already steering the active turn" }); return; }
      if (participantMessage.type === "prompt.update") {
        const updated: QueuedPrompt = {
          ...queued,
          text: participantMessage.text,
          ...(participantMessage.model ? { model: participantMessage.model } : {}),
          ...(participantMessage.effort ? { effort: participantMessage.effort } : {}),
        };
        this.queue[index] = updated;
        this.broadcast({ type: "prompt.updated", prompt: updated });
        return;
      }
      if (participantMessage.type === "prompt.remove") {
        this.queue.splice(index, 1);
        this.broadcast({ type: "prompt.removed", promptId: queued.promptId });
        return;
      }
      if (!this.activePrompt) { send(socket, { type: "room.error", message: "There is no active turn to steer" }); return; }
      this.steeringPromptIds.add(queued.promptId);
      send(this.hostSocket, { type: "prompt.steer", prompt: queued });
      return;
    }
    if (!this.allowRate(socket, "prompt", 20, 60_000)) { send(socket, { type: "room.error", message: "Prompt rate limit exceeded" }); return; }
    if (!participant.capabilities.includes("prompter")) {
      send(socket, { type: "room.error", message: "Participant does not have prompter capability" });
      return;
    }
    this.enqueue({
      promptId: participantMessage.promptId,
      participantId: participant.id,
      participantName: participant.name,
      text: participantMessage.text,
      ...(participantMessage.model ? { model: participantMessage.model } : {}),
      ...(participantMessage.effort ? { effort: participantMessage.effort } : {}),
      submittedAt: new Date().toISOString(),
    });
  }

  private receiveHost(raw: string): void {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      send(this.hostSocket, { type: "room.error", message: "Messages must be valid JSON" });
      return;
    }
    const parsed = relayHostMessageSchema.safeParse(value);
    if (!parsed.success || parsed.data.type === "relay.room.create") {
      send(this.hostSocket, { type: "room.error", message: "Invalid host message" });
      return;
    }
    const message = parsed.data as RelayHostMessage;
    switch (message.type) {
      case "prompt.submit":
        this.enqueue({
          promptId: message.promptId,
          participantId: this.host.id,
          participantName: this.host.name,
          text: message.text,
          ...(message.model ? { model: message.model } : {}),
          ...(message.effort ? { effort: message.effort } : {}),
          submittedAt: new Date().toISOString(),
        });
        break;
      case "relay.agent.config":
        this.agentConfig = message.config;
        this.broadcast({ type: "agent.config", config: message.config }, this.hostSocket);
        break;
      case "relay.agent.event":
        if (!agentEventTypes.has(message.event.type)) {
          send(this.hostSocket, { type: "room.error", message: "Unknown agent event" });
          return;
        }
        this.broadcast({ type: "agent.event", event: message.event }, this.hostSocket);
        if (message.event.type === "turn.completed" && message.event.status !== "pending-conflict") {
          this.activePrompt = null;
          this.dispatchNext();
        }
        break;
      case "relay.agent.encrypted":
        if (!agentEventTypes.has(message.eventType as AgentEvent["type"])) {
          send(this.hostSocket, { type: "room.error", message: "Unknown encrypted agent event" });
          return;
        }
        this.broadcast({ type: "agent.encrypted", eventType: message.eventType, ...(message.status ? { status: message.status } : {}), payload: message.payload }, this.hostSocket);
        if (message.eventType === "turn.completed" && message.status !== "pending-conflict") {
          this.activePrompt = null;
          this.dispatchNext();
        }
        break;
      case "relay.workspace.diff":
        this.latestDiff = message.diff;
        this.broadcast({ type: "workspace.diff", diff: message.diff }, this.hostSocket);
        break;
      case "relay.workspace.checkpoint":
        send(this.hostSocket, { type: "room.error", message: "Single-message checkpoints are no longer supported; use a chunked checkpoint transfer" });
        break;
      case "relay.workspace.checkpoint.start":
        this.startCheckpointTransfer(message.checkpoint, message.targetParticipantId);
        break;
      case "relay.workspace.checkpoint.chunk":
        this.acceptCheckpointChunk(message.chunk, message.targetParticipantId);
        break;
      case "relay.workspace.checkpoint.complete":
        this.completeCheckpointTransfer(message.sequence, message.targetParticipantId);
        break;
      case "relay.prompt.failed":
        if (this.activePrompt?.promptId !== message.promptId) return;
        this.broadcast({ type: "room.error", message: `Prompt failed on host: ${message.message}` });
        this.activePrompt = null;
        this.dispatchNext();
        break;
      case "relay.prompt.steered": {
        if (!this.steeringPromptIds.delete(message.promptId)) return;
        const index = this.queue.findIndex((prompt) => prompt.promptId === message.promptId);
        const prompt = this.queue[index];
        if (!prompt) return;
        this.queue.splice(index, 1);
        this.broadcast({ type: "prompt.steered", prompt });
        this.dispatchNext();
        break;
      }
      case "relay.prompt.steer.failed":
        if (!this.steeringPromptIds.delete(message.promptId)) return;
        this.broadcast({ type: "room.error", message: `Could not steer the active turn: ${message.message}` });
        this.dispatchNext();
        break;
      case "relay.participant.capabilities": {
        const participant = [...this.participants.values()].find((candidate) => candidate.id === message.participantId);
        if (!participant) { send(this.hostSocket, { type: "room.error", message: "Participant is no longer connected" }); break; }
        participant.capabilities = [...new Set(message.capabilities)];
        this.broadcast({ type: "participant.capabilities", participantId: participant.id, capabilities: participant.capabilities });
        break;
      }
      case "relay.collab.rejected": {
        const target = [...this.participants.entries()].find(([, participant]) => participant.id === message.participantId);
        if (target) send(target[0], { type: "collab.rejected", eventId: message.eventId, message: message.message });
        break;
      }
      case "relay.collab.event":
        if (message.event.recipientId) {
          const target = [...this.participants.entries()].find(([, participant]) => participant.id === message.event.recipientId);
          if (target) send(target[0], { type: "collab.event", event: message.event });
          break;
        }
        if (message.event.kind === "presence.update" || message.event.kind === "document.snapshot" || message.event.kind === "document.subscribe") {
          this.broadcast({ type: "collab.event", event: message.event }, this.hostSocket);
          break;
        }
        this.collabTail = this.collabTail.then(async () => {
          await this.persistEvent(message.event);
          if (message.event.kind !== "document.update" || message.event.transactionId) {
            this.collabHistory.push(message.event);
            if (this.collabHistory.length > 1000) this.collabHistory.shift();
          }
          this.broadcast({ type: "collab.event", event: message.event }, this.hostSocket);
        }).catch(() => send(this.hostSocket, { type: "room.error", message: "Collaboration event was not durably persisted" }));
        break;
      default:
        break;
    }
  }

  private allowRate(socket: WebSocket, key: string, limit: number, windowMs: number): boolean {
    let windows = this.rateWindows.get(socket); if (!windows) { windows = new Map(); this.rateWindows.set(socket, windows); }
    const now = Date.now(); let window = windows.get(key);
    if (!window || now - window.startedAt >= windowMs) { window = { startedAt: now, count: 0 }; windows.set(key, window); }
    window.count += 1; return window.count <= limit;
  }

  private enqueue(prompt: QueuedPrompt): void {
    this.queue.push(prompt);
    this.broadcast({
      type: "prompt.queued",
      prompt,
      position: this.queue.length + (this.activePrompt ? 1 : 0),
    });
    this.dispatchNext();
  }

  private checkpointTransferKey(targetParticipantId?: string): string {
    return targetParticipantId ?? "*";
  }

  private startCheckpointTransfer(checkpoint: WorkspaceCheckpointDescriptor, targetParticipantId?: string): void {
    if (targetParticipantId) {
      if (!this.latestCheckpoint || checkpoint.sequence !== this.latestCheckpoint.sequence) {
        send(this.hostSocket, { type: "room.error", message: "Requested checkpoint transfer does not match the current checkpoint" });
        return;
      }
      if (!this.participantSocket(targetParticipantId)) {
        send(this.hostSocket, { type: "room.error", message: "Checkpoint target participant is no longer connected" });
        return;
      }
    } else if (this.latestCheckpoint && checkpoint.sequence <= this.latestCheckpoint.sequence) {
      send(this.hostSocket, { type: "room.error", message: "Workspace checkpoint sequence must increase" });
      return;
    }
    const key = this.checkpointTransferKey(targetParticipantId);
    if (this.checkpointTransfers.has(key)) {
      send(this.hostSocket, { type: "room.error", message: "A checkpoint transfer is already active for this target" });
      return;
    }
    this.checkpointTransfers.set(key, {
      descriptor: checkpoint,
      ...(targetParticipantId ? { targetParticipantId } : {}),
      nextIndex: 0,
      receivedBytes: 0,
      hash: createHash("sha256"),
    });
    if (targetParticipantId) this.routeCheckpoint({ type: "workspace.checkpoint.start", checkpoint }, targetParticipantId);
  }

  private acceptCheckpointChunk(chunk: WorkspaceCheckpointChunk, targetParticipantId?: string): void {
    const key = this.checkpointTransferKey(targetParticipantId);
    const transfer = this.checkpointTransfers.get(key);
    if (!transfer || chunk.sequence !== transfer.descriptor.sequence || chunk.index !== transfer.nextIndex) {
      this.checkpointTransfers.delete(key);
      send(this.hostSocket, { type: "room.error", message: "Invalid checkpoint chunk ordering" });
      return;
    }
    const decoded = Buffer.from(chunk.data, "base64");
    if (decoded.byteLength > checkpointChunkBytes || decoded.toString("base64") !== chunk.data) {
      this.checkpointTransfers.delete(key);
      send(this.hostSocket, { type: "room.error", message: "Invalid checkpoint chunk encoding or size" });
      return;
    }
    transfer.receivedBytes += decoded.byteLength;
    if (transfer.receivedBytes > transfer.descriptor.bundleBytes) {
      this.checkpointTransfers.delete(key);
      send(this.hostSocket, { type: "room.error", message: "Checkpoint transfer exceeds its declared size" });
      return;
    }
    transfer.hash.update(decoded);
    transfer.nextIndex += 1;
    if (targetParticipantId) this.routeCheckpoint({ type: "workspace.checkpoint.chunk", chunk }, targetParticipantId);
  }

  private completeCheckpointTransfer(sequence: number, targetParticipantId?: string): void {
    const key = this.checkpointTransferKey(targetParticipantId);
    const transfer = this.checkpointTransfers.get(key);
    this.checkpointTransfers.delete(key);
    if (
      !transfer
      || sequence !== transfer.descriptor.sequence
      || transfer.nextIndex !== transfer.descriptor.chunkCount
      || transfer.receivedBytes !== transfer.descriptor.bundleBytes
      || transfer.hash.digest("hex") !== transfer.descriptor.bundleHash
    ) {
      send(this.hostSocket, { type: "room.error", message: "Checkpoint transfer failed integrity validation" });
      return;
    }
    if (!targetParticipantId) {
      void this.collabTail.then(() => { this.latestCheckpoint = transfer.descriptor; this.collabHistory.length = 0; });
    }
    if (targetParticipantId) this.routeCheckpoint({ type: "workspace.checkpoint.complete", sequence }, targetParticipantId);
  }

  private participantSocket(participantId: string): WebSocket | undefined {
    return [...this.participants.entries()].find(([, participant]) => participant.id === participantId)?.[0];
  }

  private routeCheckpoint(message: RoomServerMessage, targetParticipantId?: string): void {
    if (!targetParticipantId) {
      this.broadcast(message, this.hostSocket);
      return;
    }
    const socket = this.participantSocket(targetParticipantId);
    if (socket) send(socket, message);
  }

  private dispatchNext(): void {
    if (this.closed || this.activePrompt || this.queue.length === 0) return;
    if (this.steeringPromptIds.has(this.queue[0]?.promptId ?? "")) return;
    const prompt = this.queue.shift();
    if (!prompt) return;
    this.activePrompt = prompt;
    this.broadcast({ type: "prompt.started", prompt });
  }

  private leave(socket: WebSocket): void {
    const participant = this.participants.get(socket);
    if (!participant) return;
    this.participants.delete(socket);
    this.broadcast({ type: "participant.left", participantId: participant.id, name: participant.name });
    this.dispatchNext();
  }

  private broadcast(message: RoomServerMessage, except?: WebSocket): void {
    if (this.hostSocket !== except) send(this.hostSocket, message);
    for (const socket of this.participants.keys()) {
      if (socket !== except) send(socket, message);
    }
  }
}

export class RelayServer {
  private httpServer: Server | undefined;
  private webSocketServer: WebSocketServer | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private readonly rooms = new Map<string, CentralRoom>();
  private readonly startedAt = Date.now();
  private readonly maxRooms: number;
  private readonly maxRoomsPerIp: number;
  private readonly maxParticipantsPerRoom: number;
  private readonly authenticationTimeoutMs: number;

  constructor(private readonly options: RelayServerOptions) {
    this.maxRooms = options.maxRooms ?? 100;
    this.maxRoomsPerIp = options.maxRoomsPerIp ?? 5;
    this.maxParticipantsPerRoom = Math.max(2, options.maxParticipantsPerRoom ?? 32);
    this.authenticationTimeoutMs = options.authenticationTimeoutMs ?? 5_000;
  }

  async listen(options: { host: string; port: number }): Promise<{ host: string; port: number }> {
    if (this.httpServer) throw new Error("Relay server is already listening");
    await this.options.store?.migrate();
    const webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: maxRelayFrameBytes,
      perMessageDeflate: false,
    });
    const httpServer = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          ok: true,
          rooms: this.rooms.size,
          participants: [...this.rooms.values()].reduce((sum, room) => sum + room.metrics.participants, 0),
          droppedPresenceEvents: [...this.rooms.values()].reduce((sum, room) => sum + room.metrics.droppedPresenceEvents, 0),
          uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1_000),
        }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Not found" }));
    });
    this.webSocketServer = webSocketServer;
    this.httpServer = httpServer;

    httpServer.on("upgrade", (request, socket, head) => {
      const pathname = new URL(request.url ?? "/", "http://relay.invalid").pathname;
      const roomMatch = /^\/rooms\/([A-Za-z0-9-]{1,64})$/.exec(pathname);
      if (pathname !== "/host" && !roomMatch) {
        this.rejectUpgrade(socket);
        return;
      }
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      if (pathname === "/host") void this.acceptHost(webSocket, originatingIp(request));
        else this.acceptParticipant(webSocket, canonicalRoomCode(roomMatch?.[1] ?? ""));
      });
    });

    try {
      await new Promise<void>((resolve, rejectListen) => {
        httpServer.once("error", rejectListen);
        httpServer.listen(options.port, options.host, resolve);
      });
    } catch (error) {
      this.httpServer = undefined;
      this.webSocketServer = undefined;
      httpServer.close();
      webSocketServer.close();
      throw error;
    }
    const address = httpServer.address() as AddressInfo;
    this.heartbeatTimer = setInterval(() => {
      for (const socket of webSocketServer.clients) {
        if (socket.readyState === WebSocket.OPEN) socket.ping();
      }
    }, 25_000);
    this.heartbeatTimer.unref();
    return { host: options.host, port: address.port };
  }

  async close(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    for (const room of this.rooms.values()) room.close("Relay shutting down");
    this.rooms.clear();
    const webSocketServer = this.webSocketServer;
    const httpServer = this.httpServer;
    this.webSocketServer = undefined;
    this.httpServer = undefined;
    if (webSocketServer) {
      for (const socket of webSocketServer.clients) {
        socket.close(1001, "Relay shutting down");
        setTimeout(() => socket.terminate(), 250).unref();
      }
      webSocketServer.close();
    }
    if (httpServer) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await this.options.store?.close();
  }

  private async acceptHost(socket: WebSocket, ownerIp: string): Promise<void> {
    const timer = setTimeout(() => reject(socket, "Room creation timed out", 4001), this.authenticationTimeoutMs);
    socket.once("message", (data) => { void (async () => {
      clearTimeout(timer);
      let value: unknown;
      try {
        value = JSON.parse(data.toString());
      } catch {
        reject(socket, "Messages must be valid JSON", 4002);
        return;
      }
      const parsed = relayHostMessageSchema.safeParse(value);
      if (!parsed.success || (parsed.data.type !== "relay.room.create" && parsed.data.type !== "relay.room.resume")) {
        reject(socket, "A valid relay.room.create or relay.room.resume message is required", 4001);
        return;
      }
      if (parsed.data.type === "relay.room.resume") {
        const room = this.rooms.get(canonicalRoomCode(parsed.data.roomId));
        if (!room || !secretMatches(room.resumeToken, parsed.data.resumeToken)) { reject(socket, "Invalid room resume credentials", 4003); return; }
        room.resume(socket); send(socket, { type: "relay.room.created", roomId: room.roomId, code: room.code, resumeToken: room.resumeToken, resumed: true }); return;
      }
      if (this.rooms.size >= this.maxRooms) {
        reject(socket, "Relay room limit reached", 4013);
        return;
      }
      const roomsForIp = [...this.rooms.values()].filter((room) => room.ownerIp === ownerIp).length;
      if (roomsForIp >= this.maxRoomsPerIp) {
        reject(socket, `This IP already has ${this.maxRoomsPerIp} active rooms`, 4013);
        return;
      }
      const creation = parsed.data;
      let code = generateRoomCode();
      while (this.rooms.has(canonicalRoomCode(code))) code = generateRoomCode();
      const roomId = canonicalRoomCode(code);
      const room = new CentralRoom(
        roomId,
        code,
        randomBytes(32).toString("base64url"),
        socket,
        creation.name,
        ownerIp,
        this.authenticationTimeoutMs,
        this.maxParticipantsPerRoom,
        (event) => this.options.store?.appendEvent(roomId, event) ?? Promise.resolve(),
        () => { this.rooms.delete(roomId); void this.options.store?.roomClosed(roomId); },
      );
      this.rooms.set(roomId, room);
      try { await this.options.store?.roomOpened({ roomId, ownerIp }); } catch (error) {
        this.rooms.delete(roomId); room.close("Relay persistence failed"); reject(socket, error instanceof Error ? error.message : "Relay persistence failed", 1011); return;
      }
      send(socket, { type: "relay.room.created", roomId, code, resumeToken: room.resumeToken });
    })(); });
    socket.once("close", () => clearTimeout(timer));
  }

  private acceptParticipant(socket: WebSocket, roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) {
      reject(socket, "Room not found", 4004);
      return;
    }
    room.acceptParticipant(socket);
  }

  private rejectUpgrade(socket: Duplex): void {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
  }
}
