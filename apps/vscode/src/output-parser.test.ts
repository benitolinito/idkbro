import { describe, expect, it } from "vitest";
import { roomSessionFromOutput, roomTokenFromOutput, roomWorkspaceFromOutput } from "./output-parser.js";

const token = "FXSGG-NC3GC.UDiVsUJ2RSD3AN8iAeAnIbIdLv_Z61NjLq0ST3FbVt4";

describe("MultiCode CLI output parser", () => {
  it("accepts the current room-token output without a colon", () => {
    expect(roomTokenFromOutput(`Room token ${token}\n`)).toBe(token);
  });

  it("accepts legacy output with a colon", () => {
    expect(roomTokenFromOutput(`Room token: ${token}\n`)).toBe(token);
  });

  it("ignores ANSI styling around labels and values", () => {
    expect(roomTokenFromOutput(`\u001b[1mRoom token\u001b[22m \u001b[36m${token}\u001b[39m`)).toBe(token);
    expect(roomWorkspaceFromOutput("\u001b[32m✓\u001b[39m \u001b[1mRoom workspace\u001b[22m \u001b[36m/tmp/room/shared\u001b[39m\n")).toBe("/tmp/room/shared");
    expect(roomSessionFromOutput("\u001b[1mRoom session\u001b[22m \u001b[36mroom-42\u001b[39m\n")).toBe("room-42");
  });
});
