import { createHash, randomUUID } from "node:crypto";
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

  it("streams late-join checkpoints from the host without retaining the bundle", async () => {
    const server = new RelayServer({});
    servers.push(server);
    const { port } = await server.listen({ host: "127.0.0.1", port: 0 });
    const host = await open(`ws://127.0.0.1:${port}/host`);
    sockets.push(host.socket);
    host.socket.send(JSON.stringify({ type: "relay.room.create", name: "Ada" }));
    const created = await host.messages.next("relay.room.created");
    const bundle = Buffer.from("checkpoint bundle contents");
    const checkpoint = {
      sequence: 1,
      baseCommit: "base",
      commit: "checkpoint",
      ref: "refs/multicode/checkpoints/room",
      bundleBytes: bundle.byteLength,
      bundleHash: createHash("sha256").update(bundle).digest("hex"),
      chunkCount: 1,
      createdAt: new Date().toISOString(),
    };
    host.socket.send(JSON.stringify({ type: "relay.workspace.checkpoint.start", checkpoint }));
    host.socket.send(JSON.stringify({ type: "relay.workspace.checkpoint.chunk", chunk: { sequence: 1, index: 0, data: bundle.toString("base64") } }));
    host.socket.send(JSON.stringify({ type: "relay.workspace.checkpoint.complete", sequence: 1 }));

    const participant = await open(`ws://127.0.0.1:${port}/rooms/${created.code}`);
    sockets.push(participant.socket);
    participant.socket.send(JSON.stringify({ type: "room.join", token: created.code, name: "Grace" }));
    const welcome = await participant.messages.next("room.welcome");
    expect(welcome.latestCheckpoint).toEqual(checkpoint);
    expect(welcome.latestCheckpoint && "bundle" in welcome.latestCheckpoint).toBe(false);
    await host.messages.next("participant.joined");

    participant.socket.send(JSON.stringify({ type: "workspace.checkpoint.request", sequence: 1 }));
    const request = await host.messages.next("workspace.checkpoint.request");
    expect(request.sequence).toBe(1);
    host.socket.send(JSON.stringify({ type: "relay.workspace.checkpoint.start", checkpoint, targetParticipantId: request.participantId }));
    host.socket.send(JSON.stringify({ type: "relay.workspace.checkpoint.chunk", chunk: { sequence: 1, index: 0, data: bundle.toString("base64") }, targetParticipantId: request.participantId }));
    host.socket.send(JSON.stringify({ type: "relay.workspace.checkpoint.complete", sequence: 1, targetParticipantId: request.participantId }));

    expect((await participant.messages.next("workspace.checkpoint.start")).checkpoint).toEqual(checkpoint);
    expect((await participant.messages.next("workspace.checkpoint.chunk")).chunk.data).toBe(bundle.toString("base64"));
    expect((await participant.messages.next("workspace.checkpoint.complete")).sequence).toBe(1);

    const invalidCheckpoint = { ...checkpoint, sequence: 2, bundleHash: "0".repeat(64) };
    host.socket.send(JSON.stringify({ type: "relay.workspace.checkpoint.start", checkpoint: invalidCheckpoint }));
    host.socket.send(JSON.stringify({ type: "relay.workspace.checkpoint.chunk", chunk: { sequence: 2, index: 0, data: bundle.toString("base64") } }));
    host.socket.send(JSON.stringify({ type: "relay.workspace.checkpoint.complete", sequence: 2 }));
    expect((await host.messages.next("room.error")).message).toMatch(/integrity validation/);
  });
});
