import { describe, expect, it } from "vitest";
import { renderTerminalMarkdown } from "./markdown.js";

describe("renderTerminalMarkdown", () => {
  it("renders lists, links, and fenced code without HTML", () => {
    const output = renderTerminalMarkdown("## Result\n\n- **Passed**\n- [Docs](https://example.com)\n\n```sh\nnpm test\n```");

    expect(output).toContain("Result");
    expect(output).toContain("• Passed");
    expect(output).toContain("Docs <https://example.com>");
    expect(output).toContain("npm test");
    expect(output).not.toContain("<h2>");
  });

  it("strips terminal control characters", () => {
    expect(renderTerminalMarkdown("safe\u001b[2J text")).toBe("safe text");
  });
});
