import { describe, expect, it } from "vitest";
import { shouldOpenAsSoleWorkspaceRoot } from "./workspace-root.js";

describe("shouldOpenAsSoleWorkspaceRoot", () => {
  it("keeps a window already rooted at the managed room workspace", () => {
    expect(shouldOpenAsSoleWorkspaceRoot(["/rooms/one/workspace"], "/rooms/one/workspace")).toBe(false);
  });

  it("switches away from the participant's original checkout", () => {
    expect(shouldOpenAsSoleWorkspaceRoot(["/users/participant/idk-bro"], "/rooms/one/workspace")).toBe(true);
  });

  it("collapses a multi-root window to the managed room workspace", () => {
    expect(shouldOpenAsSoleWorkspaceRoot(
      ["/users/participant/idk-bro", "/rooms/one/workspace"],
      "/rooms/one/workspace",
    )).toBe(true);
  });
});
