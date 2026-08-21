type TokenKind = "comment" | "constant" | "function" | "keyword" | "number" | "operator" | "property" | "string" | "type";

const commonKeywords = new Set([
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "export", "extends", "finally", "for", "from", "function", "get", "if", "implements", "import", "in", "instanceof", "interface", "let", "new", "of", "package", "private", "protected", "public", "return", "set", "static", "super", "switch", "throw", "try", "type", "typeof", "var", "void", "while", "with", "yield",
]);
const languageKeywords: Record<string, Set<string>> = {
  python: new Set(["and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield"]),
  shell: new Set(["case", "do", "done", "elif", "else", "esac", "export", "fi", "for", "function", "if", "in", "local", "readonly", "select", "then", "until", "while"]),
  css: new Set(["and", "not", "only", "or"]),
};
const constants = new Set(["false", "null", "none", "true", "undefined", "False", "None", "True"]);
const commentLanguages = new Set(["python", "shell", "yaml", "toml", "ruby"]);

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] as string);
}

function languageName(language = ""): string {
  const normalized = language.toLowerCase().replace(/^language-/, "");
  if (["js", "jsx", "javascript", "mjs", "cjs"].includes(normalized)) return "javascript";
  if (["ts", "tsx", "typescript", "mts", "cts"].includes(normalized)) return "typescript";
  if (["py", "python"].includes(normalized)) return "python";
  if (["sh", "bash", "zsh", "shell"].includes(normalized)) return "shell";
  if (["yml", "yaml"].includes(normalized)) return "yaml";
  if (["html", "htm", "svg", "xml"].includes(normalized)) return "html";
  if (["c++", "cc", "cpp", "cxx", "h", "hpp"].includes(normalized)) return "cpp";
  return normalized;
}

export function languageForPath(file: string): string {
  const name = file.toLowerCase();
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  if (["js", "jsx", "mjs", "cjs"].includes(extension)) return "javascript";
  if (["ts", "tsx", "mts", "cts"].includes(extension)) return "typescript";
  if (["py"].includes(extension)) return "python";
  if (["sh", "bash", "zsh"].includes(extension)) return "shell";
  if (["yml", "yaml"].includes(extension)) return "yaml";
  if (["html", "htm", "svg", "xml"].includes(extension)) return "html";
  if (["css", "scss", "less"].includes(extension)) return "css";
  if (["json", "jsonc"].includes(extension)) return "json";
  if (["md", "mdx"].includes(extension)) return "markdown";
  if (["c", "h", "cc", "cpp", "cxx", "hpp"].includes(extension)) return "cpp";
  if (["rs", "go", "java", "rb", "php", "swift", "kt", "kts", "toml", "sql"].includes(extension)) return extension;
  if (["dockerfile", "makefile"].includes(name.split("/").pop() ?? "")) return "shell";
  return "text";
}

function tokenClass(token: string, language: string, source: string, end: number): TokenKind | undefined {
  if (token.startsWith("//") || token.startsWith("/*") || token.startsWith("<!--") || (token.startsWith("#") && commentLanguages.has(language))) return "comment";
  if (/^["'`]/.test(token)) return "string";
  if (/^(?:0x[\da-f]+|\d+(?:\.\d+)?)$/i.test(token)) return "number";
  if (/^[=!<>+\-*/%&|?:~^]+$/.test(token)) return "operator";
  if (!/^[A-Za-z_$][\w$-]*$/.test(token)) return undefined;
  if ((languageKeywords[language] ?? commonKeywords).has(token) || commonKeywords.has(token)) return "keyword";
  if (constants.has(token)) return "constant";
  if (/^[A-Z][A-Za-z0-9_$]*$/.test(token)) return "type";
  if (/^\s*\(/.test(source.slice(end))) return "function";
  const before = source.slice(0, end - token.length);
  if (/\.\s*$/.test(before) || (language === "css" && /^\s*:/.test(source.slice(end)))) return "property";
  return undefined;
}

/** Return escaped, theme-tokenized HTML suitable for a code element. */
export function highlightCode(source: string, requestedLanguage = ""): string {
  const language = languageName(requestedLanguage);
  const hashComment = commentLanguages.has(language) ? "|#[^\\n]*" : "";
  const pattern = new RegExp(`<!--[\\s\\S]*?-->|\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*${hashComment}|\`(?:\\\\.|[^\`\\\\])*\`|\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|0x[\\da-f]+|\\d+(?:\\.\\d+)?|[A-Za-z_$][\\w$-]*|[=!<>+\\-*/%&|?:~^]+|[\\s\\S]`, "gi");
  let html = "";
  for (const match of source.matchAll(pattern)) {
    const token = match[0];
    const kind = tokenClass(token, language, source, (match.index ?? 0) + token.length);
    const escaped = escapeHtml(token);
    html += kind ? `<span class="tok-${kind}">${escaped}</span>` : escaped;
  }
  return html;
}

interface DiffLine {
  kind: "add" | "context" | "delete" | "meta";
  oldLine?: number;
  newLine?: number;
  text: string;
}

interface DiffFile {
  path: string;
  lines: DiffLine[];
}

function parseWorkspaceDiff(source: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  let oldLine = 0;
  let newLine = 0;
  for (const line of source.split(/\r?\n/)) {
    const fileMatch = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (fileMatch) {
      current = { path: fileMatch[2] as string, lines: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      current.lines.push({ kind: "meta", text: (hunk[3] as string).trim() || line });
      continue;
    }
    if (/^(?:index |--- |\+\+\+ |new file mode |deleted file mode |similarity index |rename (?:from|to) )/.test(line)) continue;
    if (line.startsWith("+")) current.lines.push({ kind: "add", newLine: newLine++, text: line.slice(1) });
    else if (line.startsWith("-")) current.lines.push({ kind: "delete", oldLine: oldLine++, text: line.slice(1) });
    else if (line.startsWith(" ")) current.lines.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, text: line.slice(1) });
    else if (line === "\\ No newline at end of file") current.lines.push({ kind: "meta", text: line });
  }
  return files.filter((file) => file.lines.length > 0);
}

/** Render a bounded, escaped unified-diff preview for the webview. */
export function renderWorkspaceDiff(source: string, maxLines = 800): string {
  const files = parseWorkspaceDiff(source);
  if (!files.length) return "";
  let remaining = maxLines;
  let truncated = false;
  const sections: string[] = [];
  for (const file of files) {
    if (remaining <= 0) { truncated = true; break; }
    const language = languageForPath(file.path);
    const visible = file.lines.slice(0, remaining);
    remaining -= visible.length;
    if (visible.length < file.lines.length) truncated = true;
    const rows = visible.map((line) => {
      if (line.kind === "meta") return `<div class="diff-line diff-meta"><span class="diff-gutter"></span><span class="diff-gutter"></span><code>${highlightCode(line.text, language)}</code></div>`;
      const marker = line.kind === "add" ? "+" : line.kind === "delete" ? "−" : "";
      return `<div class="diff-line diff-${line.kind}"><span class="diff-marker">${marker}</span><span class="diff-gutter">${line.oldLine ?? ""}</span><span class="diff-gutter">${line.newLine ?? ""}</span><code>${highlightCode(line.text, language)}</code></div>`;
    }).join("");
    sections.push(`<section class="diff-file-preview"><div class="diff-file-heading">${escapeHtml(file.path)}</div><div class="diff-lines">${rows}</div></section>`);
  }
  if (truncated) sections.push('<div class="diff-preview-truncated">Preview truncated. Open Source Control to review the complete diff.</div>');
  return sections.join("");
}
