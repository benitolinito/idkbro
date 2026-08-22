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

/**
 * Sends durable events one at a time and retains them until the authority
 * broadcasts the matching event ID. Reusing the ID makes retries idempotent.
 */
export class AcknowledgedEventQueue<T extends { id: string }> {
  private readonly values: T[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly send: (value: T) => boolean,
    private readonly acknowledgementTimeoutMs = 5_000,
    private readonly disconnectedRetryMs = 500,
  ) {}

  get size(): number { return this.values.length; }

  enqueue(value: T): void {
    if (this.values.some((candidate) => candidate.id === value.id)) return;
    this.values.push(value);
    this.pump();
  }

  acknowledge(id: string): boolean {
    if (this.values[0]?.id !== id) return false;
    this.cancelTimer();
    this.values.shift();
    this.pump();
    return true;
  }

  rateLimited(id: string, retryAfterMs: number): boolean {
    if (this.values[0]?.id !== id) return false;
    this.cancelTimer();
    this.timer = setTimeout(() => { this.timer = undefined; this.transmit(); }, Math.max(1, retryAfterMs));
    return true;
  }

  resume(): void {
    if (!this.values.length) return;
    this.cancelTimer();
    this.transmit();
  }

  clear(): void {
    this.cancelTimer();
    this.values.splice(0);
  }

  private pump(): void {
    if (!this.timer && this.values.length) this.transmit();
  }

  private transmit(): void {
    const value = this.values[0];
    if (!value) return;
    const sent = this.send(value);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.transmit();
    }, sent ? this.acknowledgementTimeoutMs : this.disconnectedRetryMs);
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
