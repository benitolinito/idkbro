import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { inferSessionStatus, InteractiveCli, maskRoomToken, sanitizeTerminalOutput } from "./ui.js";

class FakeSessionProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn(() => true);
}

describe("InteractiveCli", () => {
  it("renders the host and join launcher", () => {
    const instance = render(React.createElement(InteractiveCli, {
      options: { entryPath: "/tmp/multicode.js" },
      spawnSession: () => new FakeSessionProcess(),
    }));

    expect(instance.lastFrame()).toContain("MULTICODE");
    expect(instance.lastFrame()).toContain("Host with Codex");
    expect(instance.lastFrame()).toContain("Host with Claude");
    expect(instance.lastFrame()).toContain("Join a room");
    instance.cleanup();
  });

  it("starts the selected host and forwards composer input", async () => {
    const process = new FakeSessionProcess();
    let submitted = "";
    process.stdin.on("data", (chunk) => { submitted += chunk.toString(); });
    const spawnSession = vi.fn(() => process);
    const instance = render(React.createElement(InteractiveCli, {
      options: { entryPath: "/tmp/multicode.js", name: "Ben" },
      spawnSession,
    }));

    instance.stdin.write("\r");
    await vi.waitFor(() => expect(spawnSession).toHaveBeenCalledWith(["host", "--agent", "codex", "--name", "Ben"]));
    process.stdout.write("Room token TEST1-ROOM2.secret\nReady for prompts\n");
    instance.stdin.write("Fix the tests");
    await vi.waitFor(() => expect(instance.lastFrame()).toContain("Fix the tests"));
    instance.stdin.write("\r");

    await vi.waitFor(() => expect(submitted).toBe("Fix the tests\n"));
    expect(instance.lastFrame()).toContain("Ready for prompts");
    expect(instance.lastFrame()).toContain("Fix the tests");
    expect(instance.lastFrame()).toContain("connected");
    instance.cleanup();
  });

  it("masks a pasted join token and passes the complete token to the session", async () => {
    const process = new FakeSessionProcess();
    const spawnSession = vi.fn(() => process);
    const instance = render(React.createElement(InteractiveCli, {
      options: { entryPath: "/tmp/multicode.js" },
      spawnSession,
    }));

    instance.stdin.write("\u001B[B");
    await vi.waitFor(() => expect(instance.lastFrame()).toContain("❯ Host with Claude"));
    instance.stdin.write("\u001B[B");
    await vi.waitFor(() => expect(instance.lastFrame()).toContain("❯ Join a room"));
    instance.stdin.write("\r");
    await vi.waitFor(() => expect(instance.lastFrame()).toContain("Paste room token"));
    instance.stdin.write("ABCDE-FGHIJ.super-secret-room-key");
    await vi.waitFor(() => expect(instance.lastFrame()).toContain("ABCDE-FGHIJ."));
    expect(instance.lastFrame()).not.toContain("super-secret-room-key");
    instance.stdin.write("\r");

    await vi.waitFor(() => expect(spawnSession).toHaveBeenCalledWith([
      "join",
      "ABCDE-FGHIJ.super-secret-room-key",
    ]));
    instance.cleanup();
  });
});

describe("terminal UI helpers", () => {
  it("strips child-process color codes", () => {
    expect(sanitizeTerminalOutput("\u001B[31mfailed\u001B[39m")).toBe("failed");
  });

  it("masks the room secret while retaining the locator", () => {
    const masked = maskRoomToken("ABCDE-FGHIJ.super-secret-room-key");
    expect(masked).toMatch(/^ABCDE-FGHIJ\./);
    expect(masked).not.toContain("super-secret-room-key");
  });

  it("derives connection state from session output", () => {
    expect(inferSessionStatus("Ready for prompts")).toBe("connected");
    expect(inferSessionStatus("Relay unavailable; reconnecting…")).toBe("reconnecting");
    expect(inferSessionStatus("ordinary model output")).toBeUndefined();
  });
});
