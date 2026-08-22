export interface WorkspaceFileReference {
  file: string;
  line?: number;
  column?: number;
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Parse a Markdown link target that may point at a workspace file and location. */
export function parseWorkspaceFileReference(href: string): WorkspaceFileReference | undefined {
  const input = href.trim();
  if (!input || input.startsWith("#") || /[\u0000-\u001f]/.test(input)) return undefined;

  let file = input;
  let fragment = "";
  const scheme = /^([A-Za-z][A-Za-z\d+.-]*):/.exec(input)?.[1]?.toLowerCase();
  const windowsDrive = /^[A-Za-z]:[\\/]/.test(input);
  if (scheme === "file") {
    try {
      const url = new URL(input);
      if (url.hostname && url.hostname !== "localhost") return undefined;
      file = decodeURIComponent(url.pathname);
      fragment = url.hash.slice(1);
      if (/^\/[A-Za-z]:\//.test(file)) file = file.slice(1);
    } catch {
      return undefined;
    }
  } else {
    if (scheme && !windowsDrive) return undefined;
    const hashIndex = file.indexOf("#");
    if (hashIndex >= 0) {
      fragment = file.slice(hashIndex + 1);
      file = file.slice(0, hashIndex);
    }
    const queryIndex = file.indexOf("?");
    if (queryIndex >= 0) file = file.slice(0, queryIndex);
    try { file = decodeURIComponent(file); } catch { return undefined; }
  }

  let line: number | undefined;
  let column: number | undefined;
  const fragmentLocation = /^L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/.exec(fragment);
  if (fragmentLocation) {
    line = positiveInteger(fragmentLocation[1]);
    column = positiveInteger(fragmentLocation[2]);
  } else {
    const suffixLocation = /^(.*):(\d+):(\d+)$/.exec(file) ?? /^(.*):(\d+)$/.exec(file);
    if (suffixLocation?.[1]) {
      file = suffixLocation[1];
      line = positiveInteger(suffixLocation[2]);
      column = positiveInteger(suffixLocation[3]);
    }
  }

  if (!file || file.endsWith("/") || file.endsWith("\\")) return undefined;
  return { file, ...(line ? { line } : {}), ...(column ? { column } : {}) };
}
