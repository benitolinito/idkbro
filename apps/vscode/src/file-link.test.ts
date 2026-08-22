import { describe, expect, it } from "vitest";
import { parseWorkspaceFileReference } from "./file-link.js";

describe("parseWorkspaceFileReference", () => {
  it("accepts repository-relative paths and source locations", () => {
    expect(parseWorkspaceFileReference("README.md")).toEqual({ file: "README.md" });
    expect(parseWorkspaceFileReference("src/view.ts#L12C4")).toEqual({ file: "src/view.ts", line: 12, column: 4 });
    expect(parseWorkspaceFileReference("src/view.ts:18:3")).toEqual({ file: "src/view.ts", line: 18, column: 3 });
  });

  it("accepts absolute and file URI references", () => {
    expect(parseWorkspaceFileReference("/repo/src/view.ts:8")).toEqual({ file: "/repo/src/view.ts", line: 8 });
    expect(parseWorkspaceFileReference("file:///repo/My%20File.ts#L5")).toEqual({ file: "/repo/My File.ts", line: 5 });
  });

  it("rejects external, fragment-only, remote, and malformed references", () => {
    expect(parseWorkspaceFileReference("https://example.com/file.ts")).toBeUndefined();
    expect(parseWorkspaceFileReference("javascript:alert(1)")).toBeUndefined();
    expect(parseWorkspaceFileReference("#section")).toBeUndefined();
    expect(parseWorkspaceFileReference("file://server/share/file.ts")).toBeUndefined();
    expect(parseWorkspaceFileReference("bad%2")).toBeUndefined();
  });
});
