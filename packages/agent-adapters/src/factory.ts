import type { AgentAdapter, AgentProvider } from "@multicode/protocol";
import { ClaudeAgentAdapter, type ClaudeAgentAdapterOptions } from "./claude.js";
import { CodexAppServerAdapter } from "./codex.js";

export interface CreateAgentAdapterOptions {
  provider: AgentProvider;
  cwd?: string;
  executablePath?: string;
  environment?: NodeJS.ProcessEnv;
  claude?: Pick<ClaudeAgentAdapterOptions, "queryFactory" | "initializationTimeoutMs">;
}

export function createAgentAdapter(options: CreateAgentAdapterOptions): AgentAdapter {
  if (options.provider === "codex") return new CodexAppServerAdapter(options.executablePath ?? "codex", options.environment);
  if (options.provider === "claude") return new ClaudeAgentAdapter({
    ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    ...(options.environment ? { environment: options.environment } : {}),
    ...options.claude,
  });
  throw new Error(`Unsupported agent provider: ${String(options.provider)}`);
}
