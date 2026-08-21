import { describe, expect, it } from "vitest";
import { hostApprovalCliArgs } from "./approval.js";

describe("hostApprovalCliArgs", () => {
  it("addresses an approval to the exact active room", () => {
    expect(hostApprovalCliArgs("9xreh43gay", 7, "accept")).toEqual([
      "approve", "7", "accept", "--session", "9xreh43gay",
    ]);
  });

  it("does not send an unscoped host approval", () => {
    expect(() => hostApprovalCliArgs(undefined, "approval-1", "decline"))
      .toThrow("has not identified the active room");
  });
});
