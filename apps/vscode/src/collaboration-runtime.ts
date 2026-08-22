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

/** Sends the newest ephemeral value at most once per interval. */
export class LatestValueThrottle<T> {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: { value: T } | undefined;
  private lastRunAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly intervalMs: number,
    private readonly run: (value: T) => void,
    private readonly now: () => number = Date.now,
  ) {}

  push(value: T): void {
    this.pending = { value };
    if (this.timer) return;
    const delay = Math.max(0, this.intervalMs - (this.now() - this.lastRunAt));
    if (delay === 0) {
      this.flush();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, delay);
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
    this.lastRunAt = Number.NEGATIVE_INFINITY;
  }

  private flush(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    this.lastRunAt = this.now();
    this.run(pending.value);
  }
}
