import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  roomClientMessageSchema,
  checkpointChunkBytes,
  type AgentConfig,
  type AgentEvent,
  type ApprovalDecision,
  type CollaborationEvent,
  type QueuedPrompt,
  type RoomParticipant,
  type RoomServerMessage,
  type WorkspaceDiff,
  type WorkspaceCheckpoint,
  type WorkspaceCheckpointChunk,
  type WorkspaceCheckpointDescriptor,
} from "@multicode/protocol";
import WebSocket, { WebSocketServer } from "ws";

const maxRelayFrameBytes = 256 * 1024;

export { RelayServer, type RelayServerOptions } from "./server.js";
export { PostgresRelayRoomStore, type RelayRoomStore } from "./store.js";

export interface RoomRelayOptions {
  roomId: string;
  token: string;
  hostName: string;
  onPrompt: (prompt: QueuedPrompt) => Promise<void>;
  onSteer?: (prompt: QueuedPrompt) => Promise<void>;
  onCollaborationEvent: (participant: RoomParticipant, event: CollaborationEvent) => Promise<CollaborationEvent>;
  onApproval?: (participant: RoomParticipant, requestId: string | number, decision: ApprovalDecision) => Promise<void>;
  onCheckpointRequest?: (participantId: string, sequence: number) => Promise<void> | void;
  onRoomEvent?: (message: RoomServerMessage) => void;
}

interface ConnectionState {
  participant?: RoomParticipant;
  authenticationTimer: NodeJS.Timeout;
  rates: Map<string, { startedAt: number; count: number }>;
}

function tokenMatches(expected: string, received: string): boolean {
  const expectedHash = createHash("sha256").update(expected).digest();
  const receivedHash = createHash("sha256").update(received).digest();
  return timingSafeEqual(expectedHash, receivedHash);
}

export class RoomRelay {
  private server: WebSocketServer | undefined;
  private readonly connections = new Map<WebSocket, ConnectionState>();
  private readonly queue: QueuedPrompt[] = [];
  private readonly steeringPromptIds = new Set<string>();
  private activePrompt: QueuedPrompt | null = null;
  private latestDiff: WorkspaceDiff | null = null;
  private latestCheckpoint: WorkspaceCheckpointDescriptor | null = null;
  private agentConfig: AgentConfig | undefined;
  private readonly host: RoomParticipant;

  constructor(private readonly options: RoomRelayOptions) {
    this.host = {
      id: "host",
      name: options.hostName,
      joinedAt: new Date().toISOString(),
      host: true,
      synced: true,
      capabilities: ["viewer", "editor", "prompter", "reviewer", "host"],
    };
  }

  async listen(options: { host: string; port: number }): Promise<{ host: string; port: number }> {
    if (this.server) throw new Error("Room relay is already listening");
    const server = new WebSocketServer({
      host: options.host,
      port: options.port,
      maxPayload: maxRelayFrameBytes,
      perMessageDeflate: false,
    });
    this.server = server;
    server.on("connection", (socket) => this.accept(socket));

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
    } catch (error) {
      this.server = undefined;
      server.close();
      throw error;
    }

    const address = server.address() as AddressInfo;
    return { host: options.host, port: address.port };
  }

  submitHostPrompt(text: string, promptId = randomUUID(), settings: { model?: string; effort?: string } = {}): string {
    this.enqueue({
      promptId,
      participantId: this.host.id,
      participantName: this.host.name,
      text: text.trim(),
      ...settings,
      submittedAt: new Date().toISOString(),
    });
    return promptId;
  }

  publishAgentEvent(event: AgentEvent): void {
    this.broadcast({ type: "agent.event", event });
    if (event.type === "turn.completed" && event.status !== "pending-conflict") {
      this.activePrompt = null;
      this.dispatchNext();
    } else if (event.type === "agent.exited") {
      this.activePrompt = null;
    }
  }

  publishAgentConfig(config: AgentConfig): void {
    this.agentConfig = config;
    this.broadcast({ type: "agent.config", config });
  }

  publishWorkspaceDiff(diff: WorkspaceDiff): void {
    this.latestDiff = diff;
    this.broadcast({ type: "workspace.diff", diff });
  }

  publishWorkspaceCheckpoint(checkpoint: WorkspaceCheckpoint, targetParticipantId?: string): void {
    const bundle = Buffer.from(checkpoint.bundle, "base64");
    const chunkCount = Math.ceil(bundle.byteLength / checkpointChunkBytes);
    const descriptor: WorkspaceCheckpointDescriptor = {
      sequence: checkpoint.sequence,
      baseCommit: checkpoint.baseCommit,
      commit: checkpoint.commit,
      ref: checkpoint.ref,
      bundleBytes: bundle.byteLength,
      bundleHash: createHash("sha256").update(bundle).digest("hex"),
      chunkCount,
      createdAt: checkpoint.createdAt,
    };
    this.publishWorkspaceCheckpointStart(descriptor, targetParticipantId);
    for (let index = 0; index < chunkCount; index += 1) {
      this.publishWorkspaceCheckpointChunk({
        sequence: checkpoint.sequence,
        index,
        data: bundle.subarray(index * checkpointChunkBytes, (index + 1) * checkpointChunkBytes).toString("base64"),
      }, targetParticipantId);
    }
    this.publishWorkspaceCheckpointComplete(checkpoint.sequence, targetParticipantId);
  }

  publishWorkspaceCheckpointStart(checkpoint: WorkspaceCheckpointDescriptor, targetParticipantId?: string): void {
    if (!targetParticipantId && this.latestCheckpoint && checkpoint.sequence <= this.latestCheckpoint.sequence) {
      throw new Error("Workspace checkpoint sequence must increase");
    }
    if (!targetParticipantId) {
      this.latestCheckpoint = checkpoint;
    }
    if (targetParticipantId) this.sendCheckpointMessage({ type: "workspace.checkpoint.start", checkpoint }, targetParticipantId);
  }

  publishWorkspaceCheckpointChunk(chunk: WorkspaceCheckpointChunk, targetParticipantId?: string): void {
    if (targetParticipantId) this.sendCheckpointMessage({ type: "workspace.checkpoint.chunk", chunk }, targetParticipantId);
  }

  publishWorkspaceCheckpointComplete(sequence: number, targetParticipantId?: string): void {
    if (targetParticipantId) this.sendCheckpointMessage({ type: "workspace.checkpoint.complete", sequence }, targetParticipantId);
  }

  publishCollaborationEvent(event: CollaborationEvent): void {
    if (!event.recipientId) {
      this.broadcast({ type: "collab.event", event });
      return;
    }
    const target = [...this.connections.entries()].find(([, state]) => state.participant?.id === event.recipientId);
    if (!target) return;
    this.send(target[0], { type: "collab.event", event });
  }

  setParticipantCapabilities(participantId: string, capabilities: RoomParticipant["capabilities"]): void {
    const participant = this.participants().find((candidate) => candidate.id === participantId);
    if (!participant) throw new Error("Participant is no longer connected");
    participant.capabilities = [...new Set(capabilities.filter((capability) => capability !== "host"))];
    this.broadcast({ type: "participant.capabilities", participantId, capabilities: participant.capabilities });
  }

  async close(): Promise<void> {
    if (!this.server) return;
    for (const [socket, state] of this.connections) {
      clearTimeout(state.authenticationTimer);
      socket.close(1001, "Room closed by host");
      setTimeout(() => socket.terminate(), 250).unref();
    }
    this.connections.clear();
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private accept(socket: WebSocket): void {
    const authenticationTimer = setTimeout(() => {
      this.send(socket, { type: "room.error", message: "Join timed out", fatal: true });
      socket.close(4001, "Join timed out");
    }, 5_000);
    this.connections.set(socket, { authenticationTimer, rates: new Map() });

    socket.on("message", (data) => this.receive(socket, data.toString()));
    socket.on("close", () => this.disconnect(socket));
    socket.on("error", () => this.disconnect(socket));
  }

  private receive(socket: WebSocket, raw: string): void {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      this.send(socket, { type: "room.error", message: "Messages must be valid JSON" });
      return;
    }

    const parsed = roomClientMessageSchema.safeParse(value);
    if (!parsed.success) {
      this.send(socket, { type: "room.error", message: "Invalid room message" });
      return;
    }

    const state = this.connections.get(socket);
    if (!state) return;
    if (!state.participant) {
      if (parsed.data.type !== "room.join") {
        this.send(socket, { type: "room.error", message: "Join the room before sending messages", fatal: true });
        socket.close(4001, "Authentication required");
        return;
      }
      if (!tokenMatches(this.options.token, parsed.data.token)) {
        this.send(socket, { type: "room.error", message: "Invalid room token", fatal: true });
        socket.close(4003, "Invalid room token");
        return;
      }
      this.join(socket, state, parsed.data.name, parsed.data.requestedRole ?? "editor");
      return;
    }

    if (parsed.data.type === "room.join") {
      this.send(socket, { type: "room.error", message: "Already joined" });
      return;
    }

    if (parsed.data.type === "workspace.ack") {
      if (!this.latestCheckpoint || parsed.data.sequence !== this.latestCheckpoint.sequence || parsed.data.commit !== this.latestCheckpoint.commit) {
        this.send(socket, { type: "room.error", message: "Workspace acknowledgement does not match the latest checkpoint" });
        return;
      }
      state.participant.synced = true;
      this.broadcast({
        type: "participant.synced",
        participantId: state.participant.id,
        sequence: parsed.data.sequence,
        commit: parsed.data.commit,
      });
      this.dispatchNext();
      return;
    }

    if (parsed.data.type === "workspace.checkpoint.request") {
      if (!this.latestCheckpoint || parsed.data.sequence !== this.latestCheckpoint.sequence) {
        this.send(socket, { type: "room.error", message: "Requested workspace checkpoint is no longer available" });
        return;
      }
      void Promise.resolve(this.options.onCheckpointRequest?.(state.participant.id, parsed.data.sequence)).catch((error: unknown) => {
        this.send(socket, { type: "room.error", message: error instanceof Error ? error.message : String(error) });
      });
      return;
    }

    if (parsed.data.type === "collab.publish") {
      const rate = parsed.data.event.kind === "presence.update" ? ["presence", 60, 10_000] as const
        : parsed.data.event.kind === "manifest.operation" ? ["manifest", 30, 10_000] as const
        : ["document", 300, 10_000] as const;
      if (!this.allowRate(state, rate[0], rate[1], rate[2])) { this.send(socket, { type: "room.error", message: "Collaboration rate limit exceeded" }); return; }
      if ((parsed.data.event.kind === "document.update" || parsed.data.event.kind === "manifest.operation") && !state.participant.capabilities.includes("editor")) {
        this.send(socket, { type: "room.error", message: "Participant does not have editor capability" });
        return;
      }
      void this.options.onCollaborationEvent(state.participant, parsed.data.event).then((event) => {
        this.publishCollaborationEvent(event);
      }).catch((error: unknown) => {
        this.send(socket, { type: "room.error", message: `Collaboration update rejected: ${error instanceof Error ? error.message : String(error)}` });
      });
      return;
    }

    if (parsed.data.type === "approval.resolve") {
      if (!state.participant.capabilities.includes("reviewer")) { this.send(socket, { type: "room.error", message: "Participant does not have reviewer capability" }); return; }
      void this.options.onApproval?.(state.participant, parsed.data.requestId, parsed.data.decision).catch((error: unknown) => this.send(socket, { type: "room.error", message: error instanceof Error ? error.message : String(error) })); return;
    }

    if (parsed.data.type === "prompt.update" || parsed.data.type === "prompt.remove" || parsed.data.type === "prompt.steer") {
      const queueAction = parsed.data;
      if (!this.allowRate(state, "queue", 60, 60_000)) { this.send(socket, { type: "room.error", message: "Queue action rate limit exceeded" }); return; }
      const index = this.queue.findIndex((prompt) => prompt.promptId === queueAction.promptId);
      const queued = this.queue[index];
      if (!queued) { this.send(socket, { type: "room.error", message: "Queued prompt was not found" }); return; }
      if (queued.participantId !== state.participant.id) { this.send(socket, { type: "room.error", message: "Only the prompt owner can change it" }); return; }
      if (this.steeringPromptIds.has(queued.promptId)) { this.send(socket, { type: "room.error", message: "That prompt is already steering the active turn" }); return; }
      if (queueAction.type === "prompt.update") {
        const updated: QueuedPrompt = {
          ...queued,
          text: queueAction.text,
          ...(queueAction.model ? { model: queueAction.model } : {}),
          ...(queueAction.effort ? { effort: queueAction.effort } : {}),
        };
        this.queue[index] = updated;
        this.broadcast({ type: "prompt.updated", prompt: updated });
        return;
      }
      if (queueAction.type === "prompt.remove") {
        this.queue.splice(index, 1);
        this.broadcast({ type: "prompt.removed", promptId: queued.promptId });
        return;
      }
      if (!this.activePrompt) { this.send(socket, { type: "room.error", message: "There is no active turn to steer" }); return; }
      if (!this.options.onSteer) { this.send(socket, { type: "room.error", message: "This room does not support steering" }); return; }
      this.steeringPromptIds.add(queued.promptId);
      void this.options.onSteer(queued).then(() => {
        this.steeringPromptIds.delete(queued.promptId);
        const currentIndex = this.queue.findIndex((prompt) => prompt.promptId === queued.promptId);
        if (currentIndex >= 0) this.queue.splice(currentIndex, 1);
        this.broadcast({ type: "prompt.steered", prompt: queued });
        this.dispatchNext();
      }).catch((error: unknown) => {
        this.steeringPromptIds.delete(queued.promptId);
        this.send(socket, { type: "room.error", message: `Could not steer: ${error instanceof Error ? error.message : String(error)}` });
        this.dispatchNext();
      });
      return;
    }

    if (!this.allowRate(state, "prompt", 20, 60_000)) { this.send(socket, { type: "room.error", message: "Prompt rate limit exceeded" }); return; }
    if (!state.participant.capabilities.includes("prompter")) {
      this.send(socket, { type: "room.error", message: "Participant does not have prompter capability" });
      return;
    }

    const prompt: QueuedPrompt = {
      promptId: parsed.data.promptId,
      participantId: state.participant.id,
      participantName: state.participant.name,
      text: parsed.data.text,
      ...(parsed.data.model ? { model: parsed.data.model } : {}),
      ...(parsed.data.effort ? { effort: parsed.data.effort } : {}),
      submittedAt: new Date().toISOString(),
    };
    this.enqueue(prompt);
  }

  private join(socket: WebSocket, state: ConnectionState, name: string, requestedRole: "viewer" | "editor"): void {
    clearTimeout(state.authenticationTimer);
    const participant: RoomParticipant = {
      id: randomUUID(),
      name,
      joinedAt: new Date().toISOString(),
      host: false,
      synced: this.latestCheckpoint === null,
      capabilities: requestedRole === "viewer" ? ["viewer"] : ["viewer", "editor", "prompter"],
    };
    state.participant = participant;
    this.send(socket, {
      type: "room.welcome",
      roomId: this.options.roomId,
      selfId: participant.id,
      participants: [this.host, ...this.participants()],
      activePrompt: this.activePrompt,
      queue: [...this.queue],
      latestDiff: this.latestDiff,
      latestCheckpoint: this.latestCheckpoint,
      collabHistory: [],
      ...(this.agentConfig ? { agentConfig: this.agentConfig } : {}),
    });
    this.broadcast({ type: "participant.joined", participant }, socket);
  }

  private disconnect(socket: WebSocket): void {
    const state = this.connections.get(socket);
    if (!state) return;
    clearTimeout(state.authenticationTimer);
    this.connections.delete(socket);
    if (state.participant) {
      this.broadcast({
        type: "participant.left",
        participantId: state.participant.id,
        name: state.participant.name,
      });
      this.dispatchNext();
    }
  }

  private participants(): RoomParticipant[] {
    return [...this.connections.values()].flatMap((state) =>
      state.participant ? [state.participant] : [],
    );
  }

  private allowRate(state: ConnectionState, key: string, limit: number, windowMs: number): boolean {
    const now = Date.now(); let window = state.rates.get(key);
    if (!window || now - window.startedAt >= windowMs) { window = { startedAt: now, count: 0 }; state.rates.set(key, window); }
    window.count += 1; return window.count <= limit;
  }

  private sendCheckpointMessage(message: RoomServerMessage, targetParticipantId?: string): void {
    if (!targetParticipantId) {
      this.broadcast(message);
      return;
    }
    const target = [...this.connections.entries()].find(([, state]) => state.participant?.id === targetParticipantId);
    if (!target) throw new Error("Checkpoint target participant is no longer connected");
    this.send(target[0], message);
  }

  private enqueue(prompt: QueuedPrompt): void {
    if (!prompt.text) throw new Error("Prompt cannot be empty");
    this.queue.push(prompt);
    this.broadcast({
      type: "prompt.queued",
      prompt,
      position: this.queue.length + (this.activePrompt ? 1 : 0),
    });
    this.dispatchNext();
  }

  private dispatchNext(): void {
    if (this.activePrompt || this.queue.length === 0) return;
    if (this.steeringPromptIds.has(this.queue[0]?.promptId ?? "")) return;
    const prompt = this.queue.shift();
    if (!prompt) return;
    this.activePrompt = prompt;
    this.broadcast({ type: "prompt.started", prompt });
    void this.options.onPrompt(prompt).catch((error: unknown) => {
      this.broadcast({
        type: "room.error",
        message: `Could not start prompt: ${error instanceof Error ? error.message : String(error)}`,
      });
      this.activePrompt = null;
      this.dispatchNext();
    });
  }

  private broadcast(message: RoomServerMessage, except?: WebSocket): void {
    this.options.onRoomEvent?.(message);
    for (const [socket, state] of this.connections) {
      if (socket !== except && state.participant) this.send(socket, message);
    }
  }

  private send(socket: WebSocket, message: RoomServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }
}
