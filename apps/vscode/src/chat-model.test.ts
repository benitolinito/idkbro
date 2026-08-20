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
      expect.objectContaining({ kind: "reasoning", text: "Inspecting files" }),
      expect.objectContaining({ kind: "assistant", text: "Done" }),
      expect.objectContaining({ kind: "command", text: "24 passed", status: "completed" }),
      expect.objectContaining({ kind: "system", text: "Turn completed · completed" }),
    ]));
  });
});
