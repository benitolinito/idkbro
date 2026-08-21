import { describe, expect, it } from "vitest";
import { SerialTaskQueue, shouldSaveRenderedDocument } from "./collaboration-runtime.js";

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
});
