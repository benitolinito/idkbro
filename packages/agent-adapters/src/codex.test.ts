import { describe, expect, it } from "vitest";
import { normalizeCodexMessage } from "./codex.js";

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
});

