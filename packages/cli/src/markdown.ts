import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";
import MarkdownIt from "markdown-it";

function safe(value: string): string {
  return stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

/** Render untrusted chat Markdown as readable, ANSI-styled terminal text. */
export function renderTerminalMarkdown(source: string): string {
  const parser = new MarkdownIt({ html: false, linkify: true, typographer: false }).disable("table");
  let headingDepth = 0;
  let strongDepth = 0;
  let emphasisDepth = 0;
  let quoteDepth = 0;
  let listDepth = 0;
  const ordered = new Array<number>();
  const links = new Array<string>();

  const style = (value: string): string => {
    let result = safe(value);
    if (headingDepth) result = chalk.bold.cyan(result);
    if (strongDepth) result = chalk.bold(result);
    if (emphasisDepth) result = chalk.italic(result);
    return result;
  };
  const quotePrefix = (): string => quoteDepth ? `${chalk.dim("│")} `.repeat(quoteDepth) : "";

  parser.renderer.rules.text = (tokens, index) => style(tokens[index]?.content ?? "");
  parser.renderer.rules.heading_open = () => { headingDepth += 1; return ""; };
  parser.renderer.rules.heading_close = () => { headingDepth = Math.max(0, headingDepth - 1); return "\n\n"; };
  parser.renderer.rules.strong_open = () => { strongDepth += 1; return ""; };
  parser.renderer.rules.strong_close = () => { strongDepth = Math.max(0, strongDepth - 1); return ""; };
  parser.renderer.rules.em_open = () => { emphasisDepth += 1; return ""; };
  parser.renderer.rules.em_close = () => { emphasisDepth = Math.max(0, emphasisDepth - 1); return ""; };
  parser.renderer.rules.paragraph_open = () => quotePrefix();
  parser.renderer.rules.paragraph_close = () => listDepth ? "" : "\n\n";
  parser.renderer.rules.softbreak = () => "\n" + quotePrefix();
  parser.renderer.rules.hardbreak = () => "\n" + quotePrefix();
  parser.renderer.rules.hr = () => `${chalk.dim("─".repeat(36))}\n\n`;
  parser.renderer.rules.code_inline = (tokens, index) => chalk.inverse(safe(tokens[index]?.content ?? ""));
  parser.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index];
    const language = safe(token?.info.trim().split(/\s+/)[0] ?? "");
    const header = language ? `${chalk.dim(`[${language}]`)}\n` : "";
    const body = safe(token?.content.replace(/\n$/, "") ?? "").split("\n").map((line) => `${chalk.dim("│")} ${chalk.gray(line)}`).join("\n");
    return `${header}${body}\n\n`;
  };
  parser.renderer.rules.code_block = parser.renderer.rules.fence;
  parser.renderer.rules.blockquote_open = () => { quoteDepth += 1; return ""; };
  parser.renderer.rules.blockquote_close = () => { quoteDepth = Math.max(0, quoteDepth - 1); return "\n"; };
  parser.renderer.rules.bullet_list_open = () => { listDepth += 1; ordered.push(0); return ""; };
  parser.renderer.rules.bullet_list_close = () => { listDepth = Math.max(0, listDepth - 1); ordered.pop(); return listDepth ? "" : "\n"; };
  parser.renderer.rules.ordered_list_open = (tokens, index) => {
    listDepth += 1;
    ordered.push(Number(tokens[index]?.attrGet("start") ?? 1) || 1);
    return "";
  };
  parser.renderer.rules.ordered_list_close = parser.renderer.rules.bullet_list_close;
  parser.renderer.rules.list_item_open = () => {
    const current = ordered.at(-1) ?? 0;
    const marker = current ? `${current}.` : "•";
    if (current) ordered[ordered.length - 1] = current + 1;
    return `${"  ".repeat(Math.max(0, listDepth - 1))}${chalk.cyan(marker)} `;
  };
  parser.renderer.rules.list_item_close = () => "\n";
  parser.renderer.rules.link_open = (tokens, index) => { links.push(safe(tokens[index]?.attrGet("href") ?? "")); return ""; };
  parser.renderer.rules.link_close = () => {
    const href = links.pop();
    return href ? chalk.dim(` <${href}>`) : "";
  };
  parser.renderer.rules.html_inline = (tokens, index) => chalk.dim(safe(tokens[index]?.content ?? ""));
  parser.renderer.rules.html_block = parser.renderer.rules.html_inline;

  return parser.render(source).replace(/\n{3,}/g, "\n\n").trimEnd();
}
