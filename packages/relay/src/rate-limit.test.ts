import { describe, expect, it } from "vitest";
import { TokenBucket, collaborationRateGroup } from "./rate-limit.js";

describe("TokenBucket", () => {
  it("allows a bounded burst and reports when another token is available", () => {
    let now = 0;
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 4, now: () => now });

    expect(bucket.take()).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(bucket.take()).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(bucket.take()).toEqual({ allowed: false, retryAfterMs: 250 });
    now = 250;
    expect(bucket.take()).toEqual({ allowed: true, retryAfterMs: 0 });
  });

  it("never accumulates beyond its burst capacity", () => {
    let now = 0;
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1, now: () => now });
    bucket.take();
    bucket.take();
    now = 10_000;

    expect(bucket.take().allowed).toBe(true);
    expect(bucket.take().allowed).toBe(true);
    expect(bucket.take().allowed).toBe(false);
  });

  it("separates lossy presence from durable collaboration groups", () => {
    expect(collaborationRateGroup("presence.update")).toBe("presence");
    expect(collaborationRateGroup("manifest.operation")).toBe("manifest");
    expect(collaborationRateGroup("document.update")).toBe("document");
    expect(collaborationRateGroup("document.subscribe")).toBe("document");
  });
});
