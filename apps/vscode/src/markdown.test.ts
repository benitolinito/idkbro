import { describe, expect, it } from "vitest";
import { renderChatMarkdown } from "./markdown.js";

describe("renderChatMarkdown", () => {
  it("renders common Markdown used in agent responses", () => {
    const html = renderChatMarkdown("## Result\n\n- **Passed**\n- `npm test`\n\n```ts\nconst ok = true;\n```");

    expect(html).toContain("<h2>Result</h2>");
    expect(html).toContain("<strong>Passed</strong>");
    expect(html).toContain("<code>npm test</code>");
    expect(html).toContain('<code class="language-ts">');
    expect(html).toContain('<span class="tok-keyword">const</span>');
    expect(html).toContain('<span class="tok-constant">true</span>');
  });

  it("does not activate raw HTML or unsafe links", () => {
    const html = renderChatMarkdown('<script>alert(1)</script>\n\n[open](javascript:alert(1))');

    expect(html).not.toContain("<script>");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("&lt;script&gt;");
  });
});
