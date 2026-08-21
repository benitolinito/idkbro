import MarkdownIt from "markdown-it";
import { highlightCode } from "./syntax-highlight.js";

const parser = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  highlight: (source, language) => highlightCode(source, language),
});

/** Render untrusted chat Markdown. Raw HTML and unsafe link schemes stay inert. */
export function renderChatMarkdown(source: string): string {
  return parser.render(source);
}
