import { describe, expect, it } from "vitest";
import { CodexAppServerAdapter, normalizeCodexMessage } from "./codex.js";

describe("normalizeCodexMessage", () => {
  it("normalizes agent message deltas", () => {
    expect(
      normalizeCodexMessage({
        method: "item/agentMessage/delta",
        params: { threadId: "thr_1", turnId: "turn_1", itemId: "item_1", delta: "hello" },
      }),
    ).toEqual({
      type: "agent.message.delta",
      threadId: "thr_1",
      turnId: "turn_1",
      itemId: "item_1",
      text: "hello",
    });
  });

  it("preserves approval request IDs for a later response", () => {
    expect(
      normalizeCodexMessage({
        id: 91,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thr_1", command: "npm test" },
      }),
    ).toEqual({
      type: "approval.requested",
      requestId: 91,
      approvalKind: "item/commandExecution/requestApproval",
      details: { threadId: "thr_1", command: "npm test" },
    });
  });

  it("responds to a pending approval once and publishes its resolution", async () => {
    const writes: string[] = [];
    const adapter = new CodexAppServerAdapter();
    const internals = adapter as unknown as {
      process: { stdin: { writable: boolean; write: (value: string) => void } };
      handleLine: (line: string) => void;
    };
    internals.process = { stdin: { writable: true, write: (value) => { writes.push(value); } } };
    internals.handleLine(JSON.stringify({
      id: 91,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thr_1", command: "npm test" },
    }));

    const events = adapter.events()[Symbol.asyncIterator]();
    await expect(events.next()).resolves.toMatchObject({ value: { type: "approval.requested", requestId: 91 } });
    await adapter.resolveApproval(91, "accept");

    expect(JSON.parse(writes[0] as string)).toEqual({ id: 91, result: { decision: "accept" } });
    await expect(events.next()).resolves.toEqual({ value: { type: "approval.resolved", requestId: 91, decision: "accept" }, done: false });
    await expect(adapter.resolveApproval(91, "decline")).rejects.toThrow("no longer pending");
  });

  it("normalizes streamed Codex reasoning summaries", () => {
    expect(
      normalizeCodexMessage({
        method: "item/reasoning/summaryTextDelta",
        params: { threadId: "thr_1", turnId: "turn_1", itemId: "reason_1", delta: "Inspecting the code" },
      }),
    ).toEqual({
      type: "agent.reasoning.delta",
      threadId: "thr_1",
      turnId: "turn_1",
      itemId: "reason_1",
      text: "Inspecting the code",
    });
  });

  it("normalizes completed Codex reasoning summaries", () => {
    expect(
      normalizeCodexMessage({
        method: "item/completed",
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          item: { type: "reasoning", id: "reason_1", summary: ["Inspecting", "Implementing"] },
        },
      }),
    ).toEqual({
      type: "agent.reasoning.completed",
      threadId: "thr_1",
      turnId: "turn_1",
      itemId: "reason_1",
      text: "Inspecting\nImplementing",
    });
  });
});
