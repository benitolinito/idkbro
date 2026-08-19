import { describe, expect, it } from "vitest";
import { controllerActionSchema, roomEventSchema } from "./index.js";

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
});

