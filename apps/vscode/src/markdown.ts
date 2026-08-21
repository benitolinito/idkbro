import MarkdownIt from "markdown-it";

const parser = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
});

/** Render untrusted chat Markdown. Raw HTML and unsafe link schemes stay inert. */
export function renderChatMarkdown(source: string): string {
  return parser.render(source);
}
