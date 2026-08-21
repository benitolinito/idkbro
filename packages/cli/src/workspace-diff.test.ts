import { describe, expect, it } from "vitest";
import { parseWorkspaceNumstat } from "./workspace-diff.js";

describe("parseWorkspaceNumstat", () => {
  it("parses text, binary, and renamed file statistics", () => {
    expect(parseWorkspaceNumstat([
      "6\t5\tapps/vscode/src/chat-view.ts",
      "-\t-\tassets/screenshot.png",
      "21\t1\t",
      "packages/agent-adapters/src/old.test.ts",
      "packages/agent-adapters/src/codex.test.ts",
      "",
    ].join("\0"))).toEqual([
      { path: "apps/vscode/src/chat-view.ts", additions: 6, deletions: 5 },
      { path: "assets/screenshot.png", additions: 0, deletions: 0, binary: true },
      { path: "packages/agent-adapters/src/codex.test.ts", additions: 21, deletions: 1 },
    ]);
  });
});
