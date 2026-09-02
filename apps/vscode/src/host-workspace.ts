import { inspectManagedRoomWorktree, type ManagedRoomWorktree, type RepositoryInfo } from "@multicode/workspace";

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

export function hostingRepositoryWarning(repository: Pick<RepositoryInfo, "dirty" | "operationInProgress">): string | undefined {
  if (repository.operationInProgress) {
    return "Finish the current Git operation before hosting a MultiCode room.";
  }
  if (repository.dirty) {
    return "MultiCode requires a clean Git working tree with no uncommitted changes. Commit or stash all tracked and untracked changes before hosting a room.";
  }
  return undefined;
}
