import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import {
  relayHostMessageSchema,
  roomClientMessageSchema,
  type AgentEvent,
  type QueuedPrompt,
  type RelayHostMessage,
  type RelayServerMessage,
  type RoomParticipant,
  type RoomServerMessage,
  type WorkspaceDiff,
} from "@multicode/protocol";
import WebSocket, { WebSocketServer } from "ws";

export interface RelayServerOptions {
  maxRooms?: number;
  maxRoomsPerIp?: number;
  authenticationTimeoutMs?: number;
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
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function reject(socket: WebSocket, message: string, code = 4003): void {
  send(socket, { type: "room.error", message, fatal: true });
  socket.close(code, message.slice(0, 120));
}

class CentralRoom {
  private readonly participants = new Map<WebSocket, RoomParticipant>();
  private readonly queue: QueuedPrompt[] = [];
  private activePrompt: QueuedPrompt | null = null;
  private latestDiff: WorkspaceDiff | null = null;
  private closed = false;
  readonly host: RoomParticipant;

  constructor(
    readonly roomId: string,
    private readonly participantToken: string,
    private readonly hostSocket: WebSocket,
    hostName: string,
    readonly ownerIp: string,
    private readonly authenticationTimeoutMs: number,
    private readonly onClosed: () => void,
  ) {
    this.host = {
      id: "host",
      name: hostName,
      joinedAt: new Date().toISOString(),
      host: true,
    };
    hostSocket.on("message", (data) => this.receiveHost(data.toString()));
    hostSocket.once("close", () => this.close("Host disconnected"));
    hostSocket.once("error", () => this.close("Host connection failed"));
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
      this.join(socket, parsed.data.name);
    };
    socket.once("message", authenticate);
    socket.once("close", () => clearTimeout(timer));
  }

  close(reason = "Room closed"): void {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.participants.keys()) {
      send(socket, { type: "room.error", message: reason, fatal: true });
      socket.close(1012, reason.slice(0, 120));
    }
    this.participants.clear();
    if (this.hostSocket.readyState === WebSocket.OPEN) this.hostSocket.close(1001, reason.slice(0, 120));
    this.onClosed();
  }

  private join(socket: WebSocket, name: string): void {
    const participant: RoomParticipant = {
      id: randomUUID(),
      name,
      joinedAt: new Date().toISOString(),
      host: false,
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
    if (!parsed.success || parsed.data.type !== "prompt.submit") {
      send(socket, { type: "room.error", message: "Invalid participant message" });
      return;
    }
    const participant = this.participants.get(socket);
    if (!participant) return;
    this.enqueue({
      promptId: parsed.data.promptId,
      participantId: participant.id,
      participantName: participant.name,
      text: parsed.data.text,
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
          submittedAt: new Date().toISOString(),
        });
        break;
      case "relay.agent.event":
        if (!agentEventTypes.has(message.event.type)) {
          send(this.hostSocket, { type: "room.error", message: "Unknown agent event" });
          return;
        }
        this.broadcast({ type: "agent.event", event: message.event }, this.hostSocket);
        if (message.event.type === "turn.completed") {
          this.activePrompt = null;
          this.dispatchNext();
        } else if (message.event.type === "agent.exited") {
          this.close("Host agent exited");
        }
        break;
      case "relay.workspace.diff":
        this.latestDiff = message.diff;
        this.broadcast({ type: "workspace.diff", diff: message.diff }, this.hostSocket);
        break;
      case "relay.prompt.failed":
        if (this.activePrompt?.promptId !== message.promptId) return;
        this.broadcast({ type: "room.error", message: `Prompt failed on host: ${message.message}` });
        this.activePrompt = null;
        this.dispatchNext();
        break;
      default:
        break;
    }
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

  private dispatchNext(): void {
    if (this.closed || this.activePrompt || this.queue.length === 0) return;
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
  private readonly authenticationTimeoutMs: number;

  constructor(private readonly options: RelayServerOptions) {
    this.maxRooms = options.maxRooms ?? 100;
    this.maxRoomsPerIp = options.maxRoomsPerIp ?? 5;
    this.authenticationTimeoutMs = options.authenticationTimeoutMs ?? 5_000;
  }

  async listen(options: { host: string; port: number }): Promise<{ host: string; port: number }> {
    if (this.httpServer) throw new Error("Relay server is already listening");
    const webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: 384 * 1024,
      perMessageDeflate: false,
    });
    const httpServer = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, rooms: this.rooms.size, uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1_000) }));
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
        if (pathname === "/host") this.acceptHost(webSocket, originatingIp(request));
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
  }

  private acceptHost(socket: WebSocket, ownerIp: string): void {
    const timer = setTimeout(() => reject(socket, "Room creation timed out", 4001), this.authenticationTimeoutMs);
    socket.once("message", (data) => {
      clearTimeout(timer);
      let value: unknown;
      try {
        value = JSON.parse(data.toString());
      } catch {
        reject(socket, "Messages must be valid JSON", 4002);
        return;
      }
      const parsed = relayHostMessageSchema.safeParse(value);
      if (!parsed.success || parsed.data.type !== "relay.room.create") {
        reject(socket, "A valid relay.room.create message is required", 4001);
        return;
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
        socket,
        creation.name,
        ownerIp,
        this.authenticationTimeoutMs,
        () => this.rooms.delete(roomId),
      );
      this.rooms.set(roomId, room);
      send(socket, { type: "relay.room.created", roomId, code });
    });
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
