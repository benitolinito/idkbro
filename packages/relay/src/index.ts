import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  roomClientMessageSchema,
  type AgentEvent,
  type QueuedPrompt,
  type RoomParticipant,
  type RoomServerMessage,
  type WorkspaceDiff,
  type WorkspaceCheckpoint,
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
  private latestCheckpoint: WorkspaceCheckpoint | null = null;
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

  publishWorkspaceCheckpoint(checkpoint: WorkspaceCheckpoint): void {
    if (this.latestCheckpoint && checkpoint.sequence <= this.latestCheckpoint.sequence) {
      throw new Error("Workspace checkpoint sequence must increase");
    }
    this.latestCheckpoint = checkpoint;
    for (const state of this.connections.values()) {
      if (state.participant) state.participant.synced = false;
    }
    this.broadcast({ type: "workspace.checkpoint", checkpoint });
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
