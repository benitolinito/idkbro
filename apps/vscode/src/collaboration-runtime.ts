export type WorkspaceDiskOwner = "daemon" | "extension";

export function shouldSaveRenderedDocument(owner: WorkspaceDiskOwner): boolean {
  return owner === "extension";
}

/** Keeps async wire events ordered even when applying one event touches the filesystem. */
export class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  idle(): Promise<void> { return this.tail; }
}
