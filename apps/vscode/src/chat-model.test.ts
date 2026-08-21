import { describe, expect, it } from "vitest";
import type { QueuedPrompt, RoomParticipant, RoomServerMessage } from "@multicode/protocol";
import { ChatModel } from "./chat-model.js";

const host: RoomParticipant = { id: "host", name: "Ada", joinedAt: new Date(0).toISOString(), host: true, synced: true, capabilities: ["viewer", "editor", "prompter", "reviewer"] };
const editor: RoomParticipant = { id: "editor", name: "Ada", joinedAt: new Date(0).toISOString(), host: false, synced: true, capabilities: ["viewer", "editor", "prompter"] };
const prompt: QueuedPrompt = { promptId: "prompt-1", participantId: "host", participantName: "Ada", text: "Fix the reconnect loop", submittedAt: new Date(0).toISOString() };

function welcome(): RoomServerMessage {
  return { type: "room.welcome", roomId: "ABCDE-23456", selfId: "editor", participants: [host, editor], activePrompt: null, queue: [], latestDiff: null, latestCheckpoint: null, collabHistory: [] };
}

describe("ChatModel", () => {
  it("preserves an ended transcript until Back resets the start screen", () => {
    const model = new ChatModel();
    model.start("host");
    model.stopped("Room closed");

    expect(model.snapshot()).toMatchObject({
      connection: "idle",
      canReturnToStart: true,
      timeline: expect.arrayContaining([expect.objectContaining({ kind: "system", text: "Room closed" })]),
    });
    model.reset();
    expect(model.snapshot()).toMatchObject({ connection: "idle", canReturnToStart: false, timeline: [], participants: [], queue: [] });
  });

  it("represents duplicate transport connections as one participant", () => {
    const model = new ChatModel();
    model.start("host");
    model.handle(welcome());

    expect(model.snapshot()).toMatchObject({
      connection: "connected",
      roomId: "ABCDE-23456",
      participants: [{ name: "Ada", host: true, synced: true }],
    });
  });

  it("tracks queued and active prompts without duplicating the transcript", () => {
    const model = new ChatModel();
    model.handle(welcome());
    model.handle({ type: "prompt.queued", prompt, position: 1 });
    expect(model.snapshot().queue).toEqual([{ id: "prompt-1", name: "Ada", text: "Fix the reconnect loop" }]);

    model.handle({ type: "prompt.started", prompt });
    model.handle({ type: "prompt.started", prompt });
    const state = model.snapshot();
    expect(state.queue).toEqual([]);
    expect(state.activePrompt).toEqual({ id: "prompt-1", name: "Ada", text: "Fix the reconnect loop" });
    expect(state.timeline.filter((item) => item.kind === "user")).toHaveLength(1);
  });

  it("exposes the Codex model catalog and current reasoning level", () => {
    const model = new ChatModel();
    model.handle(welcome());
    model.handle({
      type: "agent.config",
      config: {
        model: "gpt-5.6-sol",
        effort: "medium",
        models: [{ id: "sol", model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", description: "Frontier", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }]}],
      },
    });

    expect(model.snapshot().agentConfig).toMatchObject({
      model: "gpt-5.6-sol",
      effort: "medium",
      models: [expect.objectContaining({ displayName: "GPT-5.6 Sol" })],
    });
  });

  it("streams reasoning, assistant messages, commands, and completion", () => {
    const model = new ChatModel();
    model.handle(welcome());
    model.handle({ type: "agent.event", event: { type: "agent.reasoning.delta", threadId: "t", turnId: "turn", itemId: "r", text: "Inspecting " } });
    model.handle({ type: "agent.event", event: { type: "agent.reasoning.delta", threadId: "t", turnId: "turn", itemId: "r", text: "files" } });
    model.handle({ type: "agent.event", event: { type: "agent.message.delta", threadId: "t", turnId: "turn", itemId: "m", text: "Done" } });
    model.handle({ type: "agent.event", event: { type: "command.started", threadId: "t", turnId: "turn", itemId: "c", command: "npm test" } });
    model.handle({ type: "agent.event", event: { type: "command.exited", threadId: "t", turnId: "turn", itemId: "c", exitCode: 0, output: "24 passed" } });
    model.handle({ type: "agent.event", event: { type: "turn.completed", threadId: "t", turnId: "turn", status: "completed" } });

    expect(model.snapshot().timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "reasoning", id: "reasoning:turn", text: "Inspecting files", status: "completed" }),
      expect.objectContaining({ kind: "assistant", text: "Done" }),
      expect.objectContaining({ kind: "command", command: "npm test", text: "24 passed", status: "completed", turnId: "turn" }),
    ]));
  });

  it("exposes pending approvals to the host and records their resolution", () => {
    const model = new ChatModel();
    model.start("host");
    model.handle(welcome());
    model.handle({ type: "agent.event", event: { type: "approval.requested", requestId: 91, approvalKind: "item/commandExecution/requestApproval", details: { command: "npm test", cwd: "/repo" } } });

    expect(model.snapshot()).toMatchObject({
      canApprove: true,
      timeline: expect.arrayContaining([
        expect.objectContaining({ kind: "approval", status: "pending", text: "Command: npm test\nWorking directory: /repo", approval: expect.objectContaining({ requestId: 91 }) }),
      ]),
    });

    model.approvalSubmitting(91);
    expect(model.snapshot().timeline.find((item) => item.id === "approval:91")?.status).toBe("resolving");
    model.handle({ type: "agent.event", event: { type: "approval.resolved", requestId: 91, decision: "accept" } });
    expect(model.snapshot().timeline.find((item) => item.id === "approval:91")?.status).toBe("approved");
  });

  it("only exposes participant approval controls after reviewer capability is granted", () => {
    const model = new ChatModel();
    model.start("join");
    model.handle(welcome());
    expect(model.snapshot().canApprove).toBe(false);
    model.handle({ type: "participant.capabilities", participantId: "editor", capabilities: ["viewer", "editor", "prompter", "reviewer"] });
    expect(model.snapshot().canApprove).toBe(true);
  });

  it("groups multiple reasoning items from one turn into one timeline entry", () => {
    const model = new ChatModel();
    model.handle(welcome());
    model.handle({ type: "agent.event", event: { type: "agent.reasoning.delta", threadId: "t", turnId: "turn", itemId: "r1", text: "Inspecting files" } });
    model.handle({ type: "agent.event", event: { type: "agent.reasoning.completed", threadId: "t", turnId: "turn", itemId: "r1", text: "Inspecting files" } });
    model.handle({ type: "agent.event", event: { type: "agent.reasoning.delta", threadId: "t", turnId: "turn", itemId: "r2", text: "Checking tests" } });

    const reasoning = model.snapshot().timeline.filter((item) => item.kind === "reasoning");
    expect(reasoning).toEqual([
      expect.objectContaining({ id: "reasoning:turn", text: "Inspecting files\n\nChecking tests", status: "running" }),
    ]);
  });
});
