const ansiSequence = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const roomTokenPattern = /Room token:?\s+([A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}\.[A-Za-z0-9_-]{40,})/i;
const roomWorkspacePattern = /Room workspace\s+([^\r\n]+)/i;

function plain(output: string): string {
  return output.replace(ansiSequence, "");
}

export function roomTokenFromOutput(output: string): string | undefined {
  return plain(output).match(roomTokenPattern)?.[1];
}

export function roomWorkspaceFromOutput(output: string): string | undefined {
  return plain(output).match(roomWorkspacePattern)?.[1]?.trim();
}
