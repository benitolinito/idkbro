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
    expect(model.snapshot().queue).toEqual([{ id: "prompt-1", name: "Ada", text: "Fix the reconnect loop", owned: false }]);

    model.handle({ type: "prompt.started", prompt });
    model.handle({ type: "prompt.started", prompt });
    const state = model.snapshot();
    expect(state.queue).toEqual([]);
    expect(state.activePrompt).toEqual({ id: "prompt-1", name: "Ada", text: "Fix the reconnect loop", owned: false });
    expect(state.timeline.filter((item) => item.kind === "user")).toEqual([
      expect.objectContaining({ timestamp: prompt.submittedAt }),
    ]);
  });

  it("updates, removes, and steers owned queued prompts", () => {
    const model = new ChatModel();
    model.handle(welcome());
    const ownedPrompt: QueuedPrompt = { ...prompt, promptId: "prompt-owned", participantId: "editor", model: "gpt-5.6-sol", effort: "high" };
    model.handle({ type: "prompt.queued", prompt: ownedPrompt, position: 1 });
    model.handle({ type: "prompt.updated", prompt: { ...ownedPrompt, text: "Use the smaller change" } });

    expect(model.snapshot().queue).toEqual([expect.objectContaining({ id: "prompt-owned", text: "Use the smaller change", owned: true, model: "gpt-5.6-sol", effort: "high" })]);

    model.handle({ type: "prompt.steered", prompt: { ...ownedPrompt, text: "Use the smaller change" } });
    expect(model.snapshot().queue).toEqual([]);
    expect(model.snapshot().timeline).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "user", text: "Use the smaller change" })]));

    model.handle({ type: "prompt.queued", prompt: ownedPrompt, position: 1 });
    model.handle({ type: "prompt.removed", promptId: ownedPrompt.promptId });
    expect(model.snapshot().queue).toEqual([]);
  });

  it("exposes the Codex model catalog and current reasoning level", () => {
    const model = new ChatModel();
    model.handle(welcome());
    model.handle({
      type: "agent.config",
      config: {
        provider: "codex",
        displayName: "Codex",
        capabilities: { modelSelection: true, effortSelection: true, steering: true, interruption: true, approvals: true, structuredQuestions: false },
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
    model.handle({ type: "agent.event", event: { type: "turn.started", threadId: "t", turnId: "turn" } });
    model.handle({ type: "agent.event", event: { type: "agent.reasoning.delta", threadId: "t", turnId: "turn", itemId: "r", text: "Inspecting " } });
    model.handle({ type: "agent.event", event: { type: "agent.reasoning.delta", threadId: "t", turnId: "turn", itemId: "r", text: "files" } });
    model.handle({ type: "agent.event", event: { type: "agent.message.delta", threadId: "t", turnId: "turn", itemId: "m", text: "Done" } });
    model.handle({ type: "agent.event", event: { type: "command.started", threadId: "t", turnId: "turn", itemId: "c", command: "npm test" } });
    expect(model.snapshot().activeTurnIds).toEqual(["turn"]);
    model.handle({ type: "agent.event", event: { type: "command.exited", threadId: "t", turnId: "turn", itemId: "c", exitCode: 0, output: "24 passed" } });
    model.handle({ type: "agent.event", event: { type: "turn.completed", threadId: "t", turnId: "turn", status: "completed" } });

    expect(model.snapshot().activeTurnIds).toEqual([]);
    expect(model.snapshot().timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "reasoning", id: "reasoning:turn", text: "Inspecting files", status: "completed", startedAt: expect.any(String) }),
      expect.objectContaining({ kind: "assistant", text: "Done" }),
      expect.objectContaining({ kind: "command", command: "npm test", text: "24 passed", status: "completed", turnId: "turn", startedAt: expect.any(String) }),
    ]));
  });

  it("uses provider-neutral labels and tracks generic tools and structured questions", () => {
    const model = new ChatModel();
    model.start("host");
    model.handle(welcome());
    model.handle({ type: "agent.config", config: { provider: "claude", displayName: "Claude", model: "claude-test", models: [], capabilities: { modelSelection: true, effortSelection: false, steering: false, interruption: true, approvals: true, structuredQuestions: true } } });
    model.handle({ type: "agent.event", event: { type: "tool.started", threadId: "t", turnId: "turn", itemId: "read", toolName: "Read", displayName: "Read file", summary: "Read file: README.md" } });
    model.handle({ type: "agent.event", event: { type: "tool.completed", threadId: "t", turnId: "turn", itemId: "read", toolName: "Read", displayName: "Read file", status: "completed", durationMs: 4, output: "contents" } });
    model.handle({ type: "agent.event", event: { type: "input.requested", requestId: "question-1", toolUseId: "tool-1", questions: [{ id: "q1", header: "Style", question: "Which style?", options: [{ label: "Simple", description: "Minimal" }], multiSelect: false, allowFreeform: true }] } });

    expect(model.snapshot()).toMatchObject({
      agentConfig: { provider: "claude", displayName: "Claude", capabilities: { steering: false, effortSelection: false } },
      timeline: expect.arrayContaining([
        expect.objectContaining({ kind: "command", id: "tool:read", command: "Read file: README.md", text: "contents", status: "completed" }),
        expect.objectContaining({ kind: "input", id: "input:question-1", status: "pending", input: expect.objectContaining({ requestId: "question-1" }) }),
      ]),
    });
    model.handle({ type: "agent.event", event: { type: "input.answered", requestId: "question-1", answers: { q1: "Simple" } } });
    expect(model.snapshot().timeline.find((item) => item.id === "input:question-1")?.status).toBe("answered");
  });

  it("exposes colored file-change statistics for the review card", () => {
    const model = new ChatModel();
    model.handle(welcome());
    model.handle({
      type: "workspace.diff",
      diff: {
        revision: "turn",
        text: "diff",
        truncated: false,
        createdAt: new Date(0).toISOString(),
        additions: 27,
        deletions: 6,
        files: [
          { path: "apps/vscode/src/chat-view.ts", additions: 6, deletions: 5 },
          { path: "packages/agent-adapters/src/codex.test.ts", additions: 21, deletions: 1 },
        ],
      },
    });

    expect(model.snapshot().timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "diff",
        changes: {
          additions: 27,
          deletions: 6,
          files: [
            expect.objectContaining({ path: "apps/vscode/src/chat-view.ts", additions: 6, deletions: 5 }),
            expect.objectContaining({ path: "packages/agent-adapters/src/codex.test.ts", additions: 21, deletions: 1 }),
          ],
        },
      }),
    ]));
  });

  it("exposes pending approvals to the host and records their resolution", () => {
    const model = new ChatModel();
    model.start("host");
    model.handle(welcome());
    model.handle({ type: "agent.event", event: { type: "approval.requested", requestId: 91, approvalKind: "item/commandExecution/requestApproval", details: { command: "npm test", cwd: "/repo", reason: "Verify the change" } } });

    expect(model.snapshot()).toMatchObject({
      canApprove: true,
      timeline: expect.arrayContaining([
        expect.objectContaining({
          kind: "approval",
          status: "pending",
          text: "Command: npm test\nWorking directory: /repo\nVerify the change",
          approval: expect.objectContaining({ requestId: 91, command: "npm test", cwd: "/repo", reason: "Verify the change" }),
        }),
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

  it("keeps nonfatal room errors from breaking the connection or flooding the timeline", () => {
    const model = new ChatModel();
    model.handle(welcome());
    model.handle({ type: "room.error", message: "Collaboration rate limit exceeded" });
    model.handle({ type: "room.error", message: "Collaboration rate limit exceeded" });

    const state = model.snapshot();
    expect(state.connection).toBe("connected");
    expect(state.timeline.filter((item) => item.kind === "error")).toEqual([
      expect.objectContaining({ text: "Collaboration rate limit exceeded" }),
    ]);
  });

  it("marks fatal room errors as connection failures", () => {
    const model = new ChatModel();
    model.handle(welcome());
    model.handle({ type: "room.error", message: "Invalid room token", fatal: true });

    expect(model.snapshot()).toMatchObject({ connection: "error" });
  });
});
