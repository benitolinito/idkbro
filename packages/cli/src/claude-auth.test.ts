import { describe, expect, it } from "vitest";
import { claudeAuthMode, claudeEnvironment, parseClaudeAuthStatus } from "./claude-auth.js";

describe("Claude authentication", () => {
  it("validates authentication modes", () => {
    expect(claudeAuthMode(undefined)).toBe("auto");
    expect(claudeAuthMode("subscription")).toBe("subscription");
    expect(claudeAuthMode("api-key")).toBe("api-key");
    expect(() => claudeAuthMode("other")).toThrow(/Unsupported Claude authentication mode/);
  });

  it("isolates subscription authentication from ambient credentials", () => {
    expect(claudeEnvironment("subscription", {
      PATH: "/bin",
      ANTHROPIC_API_KEY: "api-secret",
      ANTHROPIC_AUTH_TOKEN: "auth-secret",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
    })).toEqual({ PATH: "/bin" });
  });

  it("requires and isolates an API key in API-key mode", () => {
    expect(claudeEnvironment("api-key", {
      PATH: "/bin",
      ANTHROPIC_API_KEY: " api-secret ",
      ANTHROPIC_AUTH_TOKEN: "auth-secret",
    })).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: "api-secret" });
    expect(() => claudeEnvironment("api-key", { PATH: "/bin" })).toThrow(/requires ANTHROPIC_API_KEY/);
  });

  it("classifies status responses without depending on account identity fields", () => {
    expect(parseClaudeAuthStatus({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: "private@example.com" })).toEqual({
      loggedIn: true, source: "subscription", authMethod: "claude.ai", subscriptionType: "max",
    });
    expect(parseClaudeAuthStatus({ loggedIn: true, authMethod: "api_key" })).toEqual({ loggedIn: true, source: "api-key", authMethod: "api_key" });
    expect(parseClaudeAuthStatus({ loggedIn: true, authMethod: "oauth_token" })).toEqual({ loggedIn: true, source: "oauth", authMethod: "oauth_token" });
    expect(parseClaudeAuthStatus({ loggedIn: false, authMethod: "none" })).toEqual({ loggedIn: false, source: "signed-out", authMethod: "none" });
    expect(parseClaudeAuthStatus({ loggedIn: true, authMethod: "future_method" })).toEqual({ loggedIn: true, source: "unknown", authMethod: "future_method" });
    expect(parseClaudeAuthStatus("invalid")).toEqual({ loggedIn: false, source: "unknown" });
  });
});
