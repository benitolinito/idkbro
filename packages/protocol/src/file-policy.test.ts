import { describe, expect, it } from "vitest";
import { isSensitiveWorkspacePath } from "./index.js";

describe("workspace sensitive-file policy", () => {
  it.each([
    ".env.example",
    "deploy/.env.sample",
    "config/.env.template",
    "CONFIG/.ENV.EXAMPLE",
    "src/config.ts",
  ])("allows shareable template %s", (file) => {
    expect(isSensitiveWorkspacePath(file)).toBe(false);
  });

  it.each([
    ".env",
    "deploy/.env.local",
    "deploy/.env.production",
    "deploy/.env.example.local",
    "keys/id_rsa",
    "keys/id_ed25519",
    "certificates/server.pem",
    "certificates/server.key",
    "certificates/client.p12",
    "certificates/client.pfx",
  ])("blocks credential-like path %s", (file) => {
    expect(isSensitiveWorkspacePath(file)).toBe(true);
  });
});
