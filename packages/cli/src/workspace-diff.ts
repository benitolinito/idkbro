import type { WorkspaceDiffFile } from "@multicode/protocol";

export function parseWorkspaceNumstat(text: string): WorkspaceDiffFile[] {
  const records = text.split("\0");
  const files: WorkspaceDiffFile[] = [];
  for (let index = 0; index < records.length - 1;) {
    const record = records[index++] ?? "";
    if (!record) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const added = record.slice(0, firstTab);
    const deleted = record.slice(firstTab + 1, secondTab);
    let file = record.slice(secondTab + 1);
    if (!file) {
      index += 1; // Skip the rename source; the destination is what reviewers open.
      file = records[index++] ?? "";
    }
    if (!file) continue;
    const binary = added === "-" || deleted === "-";
    files.push({
      path: file,
      additions: binary ? 0 : Number.parseInt(added, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(deleted, 10) || 0,
      ...(binary ? { binary: true } : {}),
    });
  }
  return files;
}
