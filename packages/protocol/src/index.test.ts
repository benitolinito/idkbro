import { describe, expect, it } from "vitest";
import { controllerActionSchema, parseApprovalRequestId, roomClientMessageSchema, roomEventSchema, workspaceDiffSchema } from "./index.js";

describe("room protocol", () => {
  it("accepts a valid append-only event", () => {
    const result = roomEventSchema.safeParse({
      eventId: "evt_1",
      roomId: "room_1",
      sequenceNumber: null,
      eventType: "prompt.proposed",
      actorId: "user_1",
      actorType: "human",
      timestamp: "2026-08-19T12:00:00.000Z",
      payload: { text: "Add a regression test" },
    });

    expect(result.success).toBe(true);
  });

  it("requires a positive controller epoch", () => {
    const result = controllerActionSchema.safeParse({
      type: "prompt.dispatch",
      actionId: "action_1",
      promptId: "prompt_1",
      text: "Continue",
      controllerId: "user_1",
      controllerEpoch: 0,
    });

    expect(result.success).toBe(false);
  });

  it("preserves numeric approval request IDs across CLI input", () => {
    expect(parseApprovalRequestId("91")).toBe(91);
    expect(parseApprovalRequestId("approval-91")).toBe("approval-91");
    expect(parseApprovalRequestId("091")).toBe("091");
  });

  it("accepts model and reasoning overrides on a prompt", () => {
    expect(roomClientMessageSchema.parse({
      type: "prompt.submit",
      promptId: "prompt_1",
      text: "Refactor the parser",
      model: "gpt-5.6-sol",
      effort: "high",
    })).toMatchObject({ model: "gpt-5.6-sol", effort: "high" });
  });

  it("accepts queued prompt edit, remove, and steer actions", () => {
    expect(roomClientMessageSchema.parse({ type: "prompt.update", promptId: "prompt_1", text: "Use a narrower fix" })).toMatchObject({ type: "prompt.update" });
    expect(roomClientMessageSchema.parse({ type: "prompt.remove", promptId: "prompt_1" })).toEqual({ type: "prompt.remove", promptId: "prompt_1" });
    expect(roomClientMessageSchema.parse({ type: "prompt.steer", promptId: "prompt_1" })).toEqual({ type: "prompt.steer", promptId: "prompt_1" });
  });

  it("negotiates managed workspace mirrors", () => {
    expect(roomClientMessageSchema.parse({
      type: "room.join",
      token: "room-token",
      name: "Grace",
      protocolCapabilities: ["workspace-mirror-v1"],
    })).toMatchObject({ type: "room.join", protocolCapabilities: ["workspace-mirror-v1"] });
  });

  it("accepts structured per-file workspace statistics", () => {
    expect(workspaceDiffSchema.parse({
      revision: "turn-1",
      text: "diff --git a/a.ts b/a.ts",
      truncated: false,
      createdAt: new Date(0).toISOString(),
      additions: 6,
      deletions: 5,
      files: [{ path: "apps/vscode/src/chat-view.ts", additions: 6, deletions: 5 }],
    })).toMatchObject({ additions: 6, deletions: 5, files: [{ path: "apps/vscode/src/chat-view.ts" }] });
  });
});
