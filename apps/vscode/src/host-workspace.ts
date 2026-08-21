import { inspectManagedRoomWorktree, type ManagedRoomWorktree } from "@multicode/workspace";

type ManagedWorktreeInspector = (directory: string) => Promise<ManagedRoomWorktree | null>;

/**
 * Direct rooms always start from the original checkout. The extension uses this
 * to migrate a legacy room-worktree window back to that checkout in place.
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
