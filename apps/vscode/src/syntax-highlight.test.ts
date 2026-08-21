import { describe, expect, it } from "vitest";
import { highlightCode, languageForPath, renderWorkspaceDiff } from "./syntax-highlight.js";

describe("syntax highlighting", () => {
  it("uses semantic token classes and escapes untrusted code", () => {
    const html = highlightCode('const enabled = true; node("<script>")', "ts");

    expect(html).toContain('class="tok-keyword">const</span>');
    expect(html).toContain('class="tok-constant">true</span>');
    expect(html).toContain('class="tok-function">node</span>');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("selects a language from common file extensions", () => {
    expect(languageForPath("src/view.tsx")).toBe("typescript");
    expect(languageForPath("scripts/release.sh")).toBe("shell");
    expect(languageForPath("README.md")).toBe("markdown");
  });

  it("renders colored, numbered unified diff rows", () => {
    const html = renderWorkspaceDiff([
      "Status:",
      " M src/view.ts",
      "",
      "diff --git a/src/view.ts b/src/view.ts",
      "index 111..222 100644",
      "--- a/src/view.ts",
      "+++ b/src/view.ts",
      "@@ -4,2 +4,2 @@",
      "-const oldValue = false;",
      "+const newValue = true;",
    ].join("\n"));

    expect(html).toContain("src/view.ts");
    expect(html).toContain('class="diff-line diff-delete"');
    expect(html).toContain('class="diff-line diff-add"');
    expect(html).toContain('class="tok-keyword">const</span>');
    expect(html).toContain('class="tok-constant">true</span>');
    expect(html).toContain('class="diff-gutter">4</span>');
  });
});
