import { afterEach, describe, expect, it, vi } from "vitest";
import { AcknowledgedEventQueue, LatestValueThrottle, SerialTaskQueue, shouldSaveRenderedDocument } from "./collaboration-runtime.js";

afterEach(() => { vi.useRealTimers(); });

describe("collaboration runtime", () => {
  it("uses only the participant extension as a disk projector", () => {
    expect(shouldSaveRenderedDocument("extension")).toBe(true);
    expect(shouldSaveRenderedDocument("daemon")).toBe(false);
  });

  it("applies asynchronous wire events in arrival order", async () => {
    const queue = new SerialTaskQueue();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = queue.enqueue(async () => {
      order.push("first:start");
      await firstGate;
      order.push("first:end");
    });
    const second = queue.enqueue(async () => { order.push("second"); });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("continues after a rejected wire event", async () => {
    const queue = new SerialTaskQueue();
    await expect(queue.enqueue(async () => { throw new Error("bad event"); })).rejects.toThrow("bad event");
    await queue.enqueue(async () => undefined);
    await expect(queue.idle()).resolves.toBeUndefined();
  });

  it("coalesces ephemeral updates to the newest value within the interval", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const values: string[] = [];
    const throttle = new LatestValueThrottle(200, (value: string) => values.push(value));

    throttle.push("first");
    throttle.push("stale");
    throttle.push("latest");
    expect(values).toEqual(["first"]);

    vi.advanceTimersByTime(199);
    expect(values).toEqual(["first"]);
    vi.advanceTimersByTime(1);
    expect(values).toEqual(["first", "latest"]);
  });

  it("cancels a pending ephemeral update when cleared", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const values: string[] = [];
    const throttle = new LatestValueThrottle(200, (value: string) => values.push(value));

    throttle.push("first");
    throttle.push("pending");
    throttle.clear();
    vi.advanceTimersByTime(200);

    expect(values).toEqual(["first"]);
  });

  it("keeps durable events ordered until each one is acknowledged", () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const queue = new AcknowledgedEventQueue<{ id: string }>((value) => { sent.push(value.id); return true; });

    queue.enqueue({ id: "first" });
    queue.enqueue({ id: "second" });
    expect(sent).toEqual(["first"]);
    expect(queue.acknowledge("second")).toBe(false);
    expect(queue.acknowledge("first")).toBe(true);
    expect(sent).toEqual(["first", "second"]);
    expect(queue.size).toBe(1);
  });

  it("retries a durable event after the server-provided delay with the same ID", () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const queue = new AcknowledgedEventQueue<{ id: string }>((value) => { sent.push(value.id); return true; });

    queue.enqueue({ id: "durable" });
    queue.rateLimited("durable", 250);
    vi.advanceTimersByTime(249);
    expect(sent).toEqual(["durable"]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual(["durable", "durable"]);
    queue.acknowledge("durable");
  });

  it("resends the in-flight event after an acknowledgement timeout", () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const queue = new AcknowledgedEventQueue<{ id: string }>((value) => { sent.push(value.id); return true; }, 1_000);

    queue.enqueue({ id: "durable" });
    vi.advanceTimersByTime(1_000);
    expect(sent).toEqual(["durable", "durable"]);
    queue.clear();
  });
});
