import { describe, expect, it } from "vitest";
import { workspaceHandoffId, workspaceHandoffSecretKey } from "./workspace-handoff.js";

describe("workspace handoff keys", () => {
  it("uses a stable opaque key for the same room workspace", () => {
    expect(workspaceHandoffId("/sessions/room/shared")).toBe(workspaceHandoffId("/sessions/room/../room/shared"));
    expect(workspaceHandoffSecretKey("/sessions/room/shared")).not.toContain("/sessions/room/shared");
  });

  it("keeps different room workspaces isolated", () => {
    expect(workspaceHandoffId("/sessions/one/shared")).not.toBe(workspaceHandoffId("/sessions/two/shared"));
  });
});
