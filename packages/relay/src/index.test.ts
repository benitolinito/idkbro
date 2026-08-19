import { randomUUID } from "node:crypto";
import type { RoomServerMessage } from "@multicode/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { RoomRelay } from "./index.js";

class MessageCollector {
  private readonly messages: RoomServerMessage[] = [];
  private readonly waiters: Array<{
    predicate: (message: RoomServerMessage) => boolean;
    resolve: (message: RoomServerMessage) => void;
  }> = [];

  constructor(socket: WebSocket) {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as RoomServerMessage;
      const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (index >= 0) {
        const waiter = this.waiters.splice(index, 1)[0];
        waiter?.resolve(message);
      } else {
        this.messages.push(message);
      }
    });
  }

  next<T extends RoomServerMessage["type"]>(type: T): Promise<Extract<RoomServerMessage, { type: T }>> {
    const index = this.messages.findIndex((message) => message.type === type);
    if (index >= 0) {
      return Promise.resolve(this.messages.splice(index, 1)[0] as Extract<RoomServerMessage, { type: T }>);
    }
    return new Promise((resolve) => {
      this.waiters.push({
        predicate: (message) => message.type === type,
        resolve: (message) => resolve(message as Extract<RoomServerMessage, { type: T }>),
      });
    });
  }
}

async function connect(port: number, token: string, name: string): Promise<{
  socket: WebSocket;
  messages: MessageCollector;
  welcome: Extract<RoomServerMessage, { type: "room.welcome" }>;
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages = new MessageCollector(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ type: "room.join", token, name }));
  const welcome = await messages.next("room.welcome");
  return { socket, messages, welcome };
}

describe("RoomRelay", () => {
  const relays: RoomRelay[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await Promise.all(relays.splice(0).map((relay) => relay.close()));
  });

  it("authenticates participants and dispatches prompts in FIFO order", async () => {
    const dispatched: string[] = [];
    const relay = new RoomRelay({
      roomId: "room-1",
      token: "secret-token",
      hostName: "Ada",
      onPrompt: async (prompt) => {
        dispatched.push(prompt.text);
      },
    });
    relays.push(relay);
    const { port } = await relay.listen({ host: "127.0.0.1", port: 0 });
    const client = await connect(port, "secret-token", "Grace");
    sockets.push(client.socket);

    client.socket.send(JSON.stringify({ type: "prompt.submit", promptId: randomUUID(), text: "First" }));
    await client.messages.next("prompt.queued");
    const first = await client.messages.next("prompt.started");
    expect(first.prompt).toMatchObject({ participantName: "Grace", text: "First" });

    client.socket.send(JSON.stringify({ type: "prompt.submit", promptId: randomUUID(), text: "Second" }));
    const queued = await client.messages.next("prompt.queued");
    expect(queued.prompt.text).toBe("Second");
    expect(dispatched).toEqual(["First"]);

    relay.publishAgentEvent({ type: "turn.completed", threadId: "thread-1", turnId: "turn-1" });
    const second = await client.messages.next("prompt.started");
    expect(second.prompt.text).toBe("Second");
    expect(dispatched).toEqual(["First", "Second"]);

    relay.publishWorkspaceDiff({
      revision: "turn-1",
      text: "M src/index.ts",
      truncated: false,
      createdAt: new Date().toISOString(),
    });
    expect((await client.messages.next("workspace.diff")).diff.text).toBe("M src/index.ts");

    const lateClient = await connect(port, "secret-token", "Linus");
    sockets.push(lateClient.socket);
    expect(lateClient.welcome.activePrompt?.text).toBe("Second");
    expect(lateClient.welcome.latestDiff?.text).toBe("M src/index.ts");
    expect(lateClient.welcome.participants.map((participant) => participant.name)).toEqual(["Ada", "Grace", "Linus"]);
  });

  it("rejects an invalid invite token", async () => {
    const relay = new RoomRelay({
      roomId: "room-1",
      token: "correct-token",
      hostName: "Ada",
      onPrompt: async () => undefined,
    });
    relays.push(relay);
    const { port } = await relay.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(socket);
    const messages = new MessageCollector(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({ type: "room.join", token: "wrong-token", name: "Mallory" }));

    const error = await messages.next("room.error");
    expect(error).toMatchObject({ message: "Invalid room token", fatal: true });
  });

  it("waits for workspace acknowledgement before dispatching prompts", async () => {
    const dispatched: string[] = [];
    const relay = new RoomRelay({
      roomId: "room-1",
      token: "secret-token",
      hostName: "Ada",
      onPrompt: async (prompt) => { dispatched.push(prompt.text); },
    });
    relays.push(relay);
    const { port } = await relay.listen({ host: "127.0.0.1", port: 0 });
    const client = await connect(port, "secret-token", "Grace");
    sockets.push(client.socket);

    relay.publishWorkspaceCheckpoint({
      sequence: 1,
      baseCommit: "base",
      commit: "checkpoint",
      ref: "refs/multicode/checkpoints/room-1",
      bundle: "bundle",
      createdAt: new Date().toISOString(),
    });
    await client.messages.next("workspace.checkpoint");
    client.socket.send(JSON.stringify({ type: "prompt.submit", promptId: randomUUID(), text: "Continue" }));
    expect((await client.messages.next("room.error")).message).toMatch(/synchronizing/);
    expect(dispatched).toEqual([]);

    client.socket.send(JSON.stringify({ type: "workspace.ack", sequence: 1, commit: "checkpoint" }));
    await client.messages.next("participant.synced");
    client.socket.send(JSON.stringify({ type: "prompt.submit", promptId: randomUUID(), text: "Continue" }));
    await client.messages.next("prompt.started");
    expect(dispatched).toEqual(["Continue"]);
  });
});
