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

async function connect(port: number, token: string, name: string, requestedRole?: "viewer" | "editor", protocolCapabilities?: Array<"agent-config-v1" | "generic-tools-v1" | "structured-input-v1">): Promise<{
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
  socket.send(JSON.stringify({ type: "room.join", token, name, ...(requestedRole ? { requestedRole } : {}), ...(protocolCapabilities ? { protocolCapabilities } : {}) }));
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
      onCollaborationEvent: async (_participant, event) => event,
    });
    relays.push(relay);
    relay.publishAgentConfig({
      provider: "codex",
      displayName: "Codex",
      capabilities: { modelSelection: true, effortSelection: true, steering: true, interruption: true, approvals: true, structuredQuestions: false },
      model: "gpt-5.6-sol",
      effort: "medium",
      models: [{ id: "sol", model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", description: "Frontier", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }, { reasoningEffort: "high", description: "Deeper" }] }],
    });
    const { port } = await relay.listen({ host: "127.0.0.1", port: 0 });
    const client = await connect(port, "secret-token", "Grace");
    sockets.push(client.socket);
    expect(client.welcome.agentConfig).toMatchObject({ model: "gpt-5.6-sol", effort: "medium" });

    client.socket.send(JSON.stringify({ type: "prompt.submit", promptId: randomUUID(), text: "First", model: "gpt-5.6-sol", effort: "high" }));
    await client.messages.next("prompt.queued");
    const first = await client.messages.next("prompt.started");
    expect(first.prompt).toMatchObject({ participantName: "Grace", text: "First", model: "gpt-5.6-sol", effort: "high" });

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

  it("lets a prompt owner edit, steer, and remove queued prompts", async () => {
    const steered: string[] = [];
    const relay = new RoomRelay({
      roomId: "room-queue",
      token: "secret-token",
      hostName: "Ada",
      onPrompt: async () => undefined,
      onSteer: async (queuedPrompt) => { steered.push(queuedPrompt.text); },
      onCollaborationEvent: async (_participant, event) => event,
    });
    relays.push(relay);
    const { port } = await relay.listen({ host: "127.0.0.1", port: 0 });
    const client = await connect(port, "secret-token", "Grace");
    sockets.push(client.socket);

    client.socket.send(JSON.stringify({ type: "prompt.submit", promptId: "active", text: "First" }));
    await client.messages.next("prompt.queued");
    await client.messages.next("prompt.started");
    client.socket.send(JSON.stringify({ type: "prompt.submit", promptId: "queued", text: "Original" }));
    await client.messages.next("prompt.queued");

    client.socket.send(JSON.stringify({ type: "prompt.update", promptId: "queued", text: "Steer with this" }));
    expect((await client.messages.next("prompt.updated")).prompt.text).toBe("Steer with this");
    client.socket.send(JSON.stringify({ type: "prompt.steer", promptId: "queued" }));
    expect((await client.messages.next("prompt.steered")).prompt.promptId).toBe("queued");
    expect(steered).toEqual(["Steer with this"]);

    client.socket.send(JSON.stringify({ type: "prompt.submit", promptId: "remove-me", text: "Remove me" }));
    await client.messages.next("prompt.queued");
    client.socket.send(JSON.stringify({ type: "prompt.remove", promptId: "remove-me" }));
    expect((await client.messages.next("prompt.removed")).promptId).toBe("remove-me");
  });

  it("rejects an invalid invite token", async () => {
    const relay = new RoomRelay({
      roomId: "room-1",
      token: "correct-token",
      hostName: "Ada",
      onPrompt: async () => undefined,
      onCollaborationEvent: async (_participant, event) => event,
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

  it("rejects participant workspace collaboration", async () => {
    const relay = new RoomRelay({ roomId: "room-1", token: "secret-token", hostName: "Ada", onPrompt: async () => undefined, onCollaborationEvent: async (_participant, event) => event });
    relays.push(relay);
    const { port } = await relay.listen({ host: "127.0.0.1", port: 0 });
    const first = await connect(port, "secret-token", "Grace");
    sockets.push(first.socket);
    expect(first.welcome.participants.find((participant) => participant.id === first.welcome.selfId)?.capabilities).toEqual(["viewer", "prompter"]);
    first.socket.send(JSON.stringify({ type: "collab.publish", event: { id: randomUUID(), kind: "document.update", payload: "opaque-update" } }));
    expect((await first.messages.next("room.error")).message).toMatch(/workspace editing is disabled/i);
  });

  it("does not let a slow workspace checkpoint acknowledgement block prompts", async () => {
    const dispatched: string[] = [];
    const relay = new RoomRelay({
      roomId: "room-1",
      token: "secret-token",
      hostName: "Ada",
      onPrompt: async (prompt) => { dispatched.push(prompt.text); },
      onCollaborationEvent: async (_participant, event) => event,
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
    client.socket.send(JSON.stringify({ type: "prompt.submit", promptId: randomUUID(), text: "Continue" }));
    await client.messages.next("prompt.started");
    expect(dispatched).toEqual(["Continue"]);
  });

  it("keeps observers read-only and without prompt permissions", async () => {
    const relay = new RoomRelay({ roomId: "room-1", token: "secret-token", hostName: "Ada", onPrompt: async () => undefined, onCollaborationEvent: async (_participant, event) => event });
    relays.push(relay);
    const { port } = await relay.listen({ host: "127.0.0.1", port: 0 });
    const viewer = await connect(port, "secret-token", "Viewer", "viewer");
    sockets.push(viewer.socket);
    expect(viewer.welcome.participants.find((participant) => participant.name === "Viewer")?.capabilities).toEqual(["viewer"]);
    viewer.socket.send(JSON.stringify({ type: "prompt.submit", promptId: randomUUID(), text: "not allowed" }));
    expect((await viewer.messages.next("room.error")).message).toMatch(/prompter capability/);
    viewer.socket.send(JSON.stringify({ type: "collab.publish", event: { id: randomUUID(), kind: "document.update", payload: "opaque" } }));
    expect((await viewer.messages.next("room.error")).message).toMatch(/workspace editing is disabled/i);
  });

  it("negotiates structured-input support and routes answers only from reviewers", async () => {
    const answers: unknown[] = [];
    const relay = new RoomRelay({
      roomId: "room-input", token: "secret-token", hostName: "Ada", onPrompt: async () => undefined,
      onCollaborationEvent: async (_participant, event) => event,
      onInput: async (_participant, requestId, value) => { answers.push({ requestId, value }); },
    });
    relays.push(relay);
    const { port } = await relay.listen({ host: "127.0.0.1", port: 0 });
    const client = await connect(port, "secret-token", "Grace", "editor", ["agent-config-v1", "generic-tools-v1", "structured-input-v1"]);
    sockets.push(client.socket);
    expect(client.welcome.participants.find((participant) => participant.id === client.welcome.selfId)?.protocolCapabilities).toContain("structured-input-v1");

    client.socket.send(JSON.stringify({ type: "input.resolve", requestId: "question-1", answers: { choice: "Simple" } }));
    expect((await client.messages.next("room.error")).message).toMatch(/reviewer capability/);
    relay.setParticipantCapabilities(client.welcome.selfId, ["viewer", "editor", "prompter", "reviewer"]);
    expect((await client.messages.next("participant.capabilities")).capabilities).toEqual(["viewer", "prompter", "reviewer"]);
    client.socket.send(JSON.stringify({ type: "input.resolve", requestId: "question-1", answers: { choice: "Simple" } }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(answers).toEqual([{ requestId: "question-1", value: { choice: "Simple" } }]);
  });

  it("rejects participants above the configured room capacity", async () => {
    const relay = new RoomRelay({ roomId: "room-1", token: "secret-token", hostName: "Ada", maxParticipants: 2, onPrompt: async () => undefined, onCollaborationEvent: async (_participant, event) => event });
    relays.push(relay);
    const { port } = await relay.listen({ host: "127.0.0.1", port: 0 });
    const first = await connect(port, "secret-token", "Grace"); sockets.push(first.socket);
    const secondSocket = new WebSocket(`ws://127.0.0.1:${port}`); sockets.push(secondSocket);
    const secondMessages = new MessageCollector(secondSocket);
    await new Promise<void>((resolve, reject) => { secondSocket.once("open", resolve); secondSocket.once("error", reject); });
    secondSocket.send(JSON.stringify({ type: "room.join", token: "secret-token", name: "Linus" }));

    expect(await secondMessages.next("room.error")).toMatchObject({ fatal: true, message: expect.stringMatching(/participant limit/i) });
  });
});
