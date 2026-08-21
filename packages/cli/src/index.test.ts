import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cli = path.resolve(import.meta.dirname, "../dist/index.js");

describe("public join command", () => {
  it("accepts the extension's bootstrap and viewer options", async () => {
    await expect(execFileAsync(process.execPath, [cli, "join", "invalid-token", "--bootstrap-only", "--viewer"]))
      .rejects.toMatchObject({
        stderr: expect.stringContaining("Invalid room token"),
      });
  });

  it("documents both extension options", async () => {
    const { stdout } = await execFileAsync(process.execPath, [cli, "join", "--help"]);
    expect(stdout).toContain("--bootstrap-only");
    expect(stdout).toContain("--viewer");
  });
});
