import { inspectManagedRoomWorktree, type ManagedRoomWorktree } from "@multicode/workspace";

type ManagedWorktreeInspector = (directory: string) => Promise<ManagedRoomWorktree | null>;

/**
 * Hosting always starts from the original checkout. VS Code remains focused on
 * the room worktree so stopping and re-hosting does not require changing folders.
 */
export async function resolveHostingDirectory(
  directory: string,
  inspect: ManagedWorktreeInspector = inspectManagedRoomWorktree,
): Promise<string> {
  try {
    return (await inspect(directory))?.repositoryRoot ?? directory;
  } catch {
    // Let the CLI report its existing repository validation error.
    return directory;
  }
}
