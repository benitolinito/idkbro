import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  roomClientMessageSchema,
  checkpointChunkBytes,
  type AgentEvent,
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
  onCheckpointRequest?: (participantId: string, sequence: number) => Promise<void> | void;
  onRoomEvent?: (message: RoomServerMessage) => void;
}

interface ConnectionState {
  participant?: RoomParticipant;
  authenticationTimer: NodeJS.Timeout;
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
  private activePrompt: QueuedPrompt | null = null;
  private latestDiff: WorkspaceDiff | null = null;
  private latestCheckpoint: WorkspaceCheckpointDescriptor | null = null;
  private readonly host: RoomParticipant;

  constructor(private readonly options: RoomRelayOptions) {
    this.host = {
      id: "host",
      name: options.hostName,
      joinedAt: new Date().toISOString(),
      host: true,
      synced: true,
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

  submitHostPrompt(text: string): string {
    const promptId = randomUUID();
    this.enqueue({
      promptId,
      participantId: this.host.id,
      participantName: this.host.name,
      text: text.trim(),
      submittedAt: new Date().toISOString(),
    });
    return promptId;
  }

  publishAgentEvent(event: AgentEvent): void {
    this.broadcast({ type: "agent.event", event });
    if (event.type === "turn.completed") {
      this.activePrompt = null;
      this.dispatchNext();
    } else if (event.type === "agent.exited") {
      this.activePrompt = null;
    }
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
      for (const state of this.connections.values()) {
        if (state.participant) state.participant.synced = false;
      }
    }
    this.sendCheckpointMessage({ type: "workspace.checkpoint.start", checkpoint }, targetParticipantId);
  }

  publishWorkspaceCheckpointChunk(chunk: WorkspaceCheckpointChunk, targetParticipantId?: string): void {
    this.sendCheckpointMessage({ type: "workspace.checkpoint.chunk", chunk }, targetParticipantId);
  }

  publishWorkspaceCheckpointComplete(sequence: number, targetParticipantId?: string): void {
    this.sendCheckpointMessage({ type: "workspace.checkpoint.complete", sequence }, targetParticipantId);
  }

  publishCollaborationEvent(event: import("@multicode/protocol").CollaborationEvent): void {
    this.broadcast({ type: "collab.event", event });
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
    this.connections.set(socket, { authenticationTimer });

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
      this.join(socket, state, parsed.data.name);
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
      this.broadcast({ type: "collab.event", event: parsed.data.event }, socket);
      return;
    }

    const prompt: QueuedPrompt = {
      promptId: parsed.data.promptId,
      participantId: state.participant.id,
      participantName: state.participant.name,
      text: parsed.data.text,
      submittedAt: new Date().toISOString(),
    };
    this.enqueue(prompt);
  }

  private join(socket: WebSocket, state: ConnectionState, name: string): void {
    clearTimeout(state.authenticationTimer);
    const participant: RoomParticipant = {
      id: randomUUID(),
      name,
      joinedAt: new Date().toISOString(),
      host: false,
      synced: this.latestCheckpoint === null,
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
