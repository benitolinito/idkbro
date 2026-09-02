import path from "node:path";

/** Participants should see only the managed room mirror, never a multi-root workspace. */
export function shouldOpenAsSoleWorkspaceRoot(currentRoots: readonly string[], targetRoot: string): boolean {
  return currentRoots.length !== 1 || path.resolve(currentRoots[0] as string) !== path.resolve(targetRoot);
}
