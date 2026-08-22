export interface TokenBucketOptions {
  capacity: number;
  refillPerSecond: number;
  now?: () => number;
}

export interface TokenBucketResult {
  allowed: boolean;
  retryAfterMs: number;
}

/** A monotonic token bucket that permits bounded bursts without fixed-window edges. */
export class TokenBucket {
  private tokens: number;
  private updatedAt: number;
  private readonly now: () => number;

  constructor(private readonly options: TokenBucketOptions) {
    if (!(options.capacity > 0) || !(options.refillPerSecond > 0)) throw new Error("Token bucket limits must be positive");
    this.tokens = options.capacity;
    this.now = options.now ?? Date.now;
    this.updatedAt = this.now();
  }

  take(cost = 1): TokenBucketResult {
    if (!(cost > 0) || cost > this.options.capacity) {
      return { allowed: false, retryAfterMs: Math.ceil((Math.max(cost, 1) / this.options.refillPerSecond) * 1_000) };
    }
    const now = this.now();
    const elapsedMs = Math.max(0, now - this.updatedAt);
    this.tokens = Math.min(this.options.capacity, this.tokens + (elapsedMs / 1_000) * this.options.refillPerSecond);
    this.updatedAt = now;
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return { allowed: true, retryAfterMs: 0 };
    }
    return {
      allowed: false,
      retryAfterMs: Math.max(1, Math.ceil(((cost - this.tokens) / this.options.refillPerSecond) * 1_000)),
    };
  }
}

export const collaborationRatePolicy = {
  presence: { capacity: 20, refillPerSecond: 10 },
  document: { capacity: 60, refillPerSecond: 30 },
  manifest: { capacity: 30, refillPerSecond: 3 },
  roomPresence: { capacity: 100, refillPerSecond: 100 },
} as const;

export type CollaborationRateGroup = "presence" | "document" | "manifest";

export function collaborationRateGroup(kind: string): CollaborationRateGroup {
  if (kind === "presence.update") return "presence";
  if (kind === "manifest.operation") return "manifest";
  return "document";
}

export function createCollaborationBucket(group: CollaborationRateGroup, now?: () => number): TokenBucket {
  return new TokenBucket({ ...collaborationRatePolicy[group], ...(now ? { now } : {}) });
}
