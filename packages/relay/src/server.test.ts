import { randomUUID } from "node:crypto";
import type { RelayServerMessage } from "@multicode/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { RelayServer } from "./server.js";

class Messages {
  private readonly queued: RelayServerMessage[] = [];
  private readonly waiters = new Map<string, Array<(message: RelayServerMessage) => void>>();

  constructor(socket: WebSocket) {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as RelayServerMessage;
      const waiter = this.waiters.get(message.type)?.shift();
      if (waiter) waiter(message);
      else this.queued.push(message);
    });
  }

  next<T extends RelayServerMessage["type"]>(type: T): Promise<Extract<RelayServerMessage, { type: T }>> {
    const index = this.queued.findIndex((message) => message.type === type);
    if (index >= 0) {
      return Promise.resolve(this.queued.splice(index, 1)[0] as Extract<RelayServerMessage, { type: T }>);
    }
    return new Promise((resolve) => {
      const waiters = this.waiters.get(type) ?? [];
      waiters.push((message) => resolve(message as Extract<RelayServerMessage, { type: T }>));
      this.waiters.set(type, waiters);
    });
  }
}

async function open(url: string, headers?: Record<string, string>): Promise<{ socket: WebSocket; messages: Messages }> {
  const socket = new WebSocket(url, { headers });
  const messages = new Messages(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, messages };
}

describe("RelayServer", () => {
  const servers: RelayServer[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("routes queued prompts and agent events through outbound connections", async () => {
    const server = new RelayServer({});
    servers.push(server);
    const { port } = await server.listen({ host: "127.0.0.1", port: 0 });

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(await health.json()).toMatchObject({ ok: true, rooms: 0 });

    const host = await open(`ws://127.0.0.1:${port}/host`);
    sockets.push(host.socket);
    host.socket.send(JSON.stringify({
      type: "relay.room.create",
      name: "Ada",
    }));
    const created = await host.messages.next("relay.room.created");
    expect(created.code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);

    const participant = await open(`ws://127.0.0.1:${port}/rooms/${created.code}`);
    sockets.push(participant.socket);
    participant.socket.send(JSON.stringify({ type: "room.join", token: created.code, name: "Grace" }));
    expect((await participant.messages.next("room.welcome")).participants.map((value) => value.name)).toEqual(["Ada", "Grace"]);
    expect((await host.messages.next("participant.joined")).participant.name).toBe("Grace");

    participant.socket.send(JSON.stringify({ type: "prompt.submit", promptId: randomUUID(), text: "Fix the test" }));
    await participant.messages.next("prompt.queued");
    const prompt = await host.messages.next("prompt.started");
    expect(prompt.prompt).toMatchObject({ participantName: "Grace", text: "Fix the test" });

    host.socket.send(JSON.stringify({
      type: "relay.agent.event",
      event: { type: "agent.message.delta", threadId: "t1", turnId: "u1", itemId: "i1", text: "Working" },
    }));
    expect((await participant.messages.next("agent.event")).event).toMatchObject({ type: "agent.message.delta", text: "Working" });

    host.socket.send(JSON.stringify({
      type: "relay.agent.event",
      event: { type: "agent.reasoning.delta", threadId: "t1", turnId: "u1", itemId: "r1", text: "Inspecting" },
    }));
    expect((await participant.messages.next("agent.event")).event).toMatchObject({ type: "agent.reasoning.delta", text: "Inspecting" });
  });

  it("limits each originating IP to five active rooms", async () => {
    const server = new RelayServer({});
    servers.push(server);
    const { port } = await server.listen({ host: "127.0.0.1", port: 0 });
    const headers = { "CF-Connecting-IP": "203.0.113.9" };
    const activeHosts: WebSocket[] = [];

    for (let index = 0; index < 5; index += 1) {
      const host = await open(`ws://127.0.0.1:${port}/host`, headers);
      sockets.push(host.socket);
      activeHosts.push(host.socket);
      host.socket.send(JSON.stringify({ type: "relay.room.create", name: `Host ${index}` }));
      await host.messages.next("relay.room.created");
    }

    const sixth = await open(`ws://127.0.0.1:${port}/host`, headers);
    sockets.push(sixth.socket);
    sixth.socket.send(JSON.stringify({ type: "relay.room.create", name: "Host 6" }));
    expect(await sixth.messages.next("room.error")).toMatchObject({
      message: "This IP already has 5 active rooms",
      fatal: true,
    });

    await new Promise<void>((resolve) => {
      activeHosts[0]?.once("close", () => resolve());
      activeHosts[0]?.close();
    });
    const replacement = await open(`ws://127.0.0.1:${port}/host`, headers);
    sockets.push(replacement.socket);
    replacement.socket.send(JSON.stringify({ type: "relay.room.create", name: "Replacement" }));
    expect((await replacement.messages.next("relay.room.created")).code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
  });
});
