import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CanUseTool, ModelInfo, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import {
  assertToolPathsWithinWorkspace,
  ClaudeAgentAdapter,
  claudeModels,
  createClaudeNormalizationState,
  normalizeClaudeMessage,
  type ClaudeQueryFactory,
} from "./claude.js";
import { createAgentAdapter } from "./factory.js";

class FixtureStream<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void { const waiter = this.waiters.shift(); if (waiter) waiter({ value, done: false }); else this.values.push(value); }
  close(): void { this.closed = true; for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true }); }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: async () => this.values.length ? { value: this.values.shift() as T, done: false } : this.closed ? { value: undefined, done: true } : new Promise((resolve) => this.waiters.push(resolve)) };
  }
}

class FakeQuery extends FixtureStream<unknown> {
  readonly models: ModelInfo[] = [{ value: "claude-test", displayName: "Claude Test", description: "Fixture", supportsEffort: true, supportedEffortLevels: ["low", "high"], supportsAdaptiveThinking: false, supportsFastMode: false }];
  readonly modelChanges: string[] = [];
  readonly flagChanges: unknown[] = [];
  interrupts = 0;
  supportedModels = async () => this.models;
  setModel = async (model: string) => { this.modelChanges.push(model); };
  applyFlagSettings = async (settings: unknown) => { this.flagChanges.push(settings); };
  interrupt = async () => { this.interrupts += 1; };
}

describe("normalizeClaudeMessage", () => {
  it("uses stable item IDs so completed text replaces streamed text", () => {
    const state = createClaudeNormalizationState(); state.threadId = "session-1"; state.turnId = "turn-1";
    normalizeClaudeMessage({ type: "stream_event", session_id: "session-1", event: { type: "message_start", message: { id: "message-1" } } }, state);
    expect(normalizeClaudeMessage({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } } }, state)).toEqual([
      { type: "agent.message.delta", threadId: "session-1", turnId: "turn-1", itemId: "message-1:0", text: "Hel" },
    ]);
    expect(normalizeClaudeMessage({ type: "assistant", message: { id: "message-1", content: [{ type: "text", text: "Hello" }] } }, state)).toEqual([
      { type: "agent.message.completed", threadId: "session-1", turnId: "turn-1", itemId: "message-1:0", text: "Hello" },
    ]);
  });

  it("normalizes thinking, Bash, generic tools, and tool results", () => {
    const state = createClaudeNormalizationState(); state.threadId = "session-1"; state.turnId = "turn-1";
    expect(normalizeClaudeMessage({ type: "assistant", message: { id: "message-1", content: [
      { type: "thinking", thinking: "Inspecting" },
      { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "npm test" } },
      { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "README.md" } },
    ] } }, state, 100)).toMatchObject([
      { type: "agent.reasoning.completed", text: "Inspecting" },
      { type: "command.started", itemId: "bash-1", command: "npm test" },
      { type: "tool.started", itemId: "read-1", toolName: "Read" },
    ]);
    expect(normalizeClaudeMessage({ type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "bash-1", content: "ok" },
      { type: "tool_result", tool_use_id: "read-1", content: "contents" },
    ] } }, state, 125)).toMatchObject([
      { type: "command.output", itemId: "bash-1" },
      { type: "command.exited", itemId: "bash-1", exitCode: 0 },
      { type: "tool.output", itemId: "read-1" },
      { type: "tool.completed", itemId: "read-1", status: "completed", durationMs: 25 },
    ]);
  });

  it("handles failures, budget limits, and unknown future frames", () => {
    const state = createClaudeNormalizationState(); state.threadId = "session-1"; state.turnId = "turn-1";
    expect(normalizeClaudeMessage({ type: "future_frame", payload: true }, state)).toEqual([]);
    expect(normalizeClaudeMessage({ type: "result", subtype: "error_max_budget_usd", is_error: true, errors: ["Budget reached"] }, state)).toEqual([
      { type: "agent.error", message: "Budget reached" },
      { type: "turn.completed", threadId: "session-1", turnId: "turn-1", status: "error_max_budget_usd" },
    ]);
  });
});

describe("ClaudeAgentAdapter", () => {
  it("starts with a fake SDK transport, discovers models, and scrubs subprocess credentials", async () => {
    const query = new FakeQuery();
    let sdkOptions: Record<string, unknown> | undefined;
    let promptStream: AsyncIterable<SDKUserMessage> | undefined;
    const factory: ClaudeQueryFactory = ({ prompt, options }) => { promptStream = prompt; sdkOptions = options; return query as unknown as Query; };
    const adapter = new ClaudeAgentAdapter({ queryFactory: factory, environment: { ANTHROPIC_API_KEY: "sk-ant-secret" } });
    const cwd = await mkdtemp(path.join(tmpdir(), "multicode-claude-adapter-"));

    await expect(adapter.start({ cwd })).resolves.toEqual({ threadId: expect.any(String) });
    expect(adapter.configuration()).toMatchObject({ provider: "claude", displayName: "Claude", model: "claude-test", capabilities: { steering: false, effortSelection: true } });
    expect((sdkOptions?.env as NodeJS.ProcessEnv).CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
    expect((sdkOptions?.env as NodeJS.ProcessEnv).CLAUDE_AGENT_SDK_CLIENT_APP).toBe("multicode");

    const first = await adapter.sendPrompt({ promptId: "00000000-0000-4000-8000-000000000001", text: "Hello" });
    await expect(adapter.sendPrompt({ promptId: "00000000-0000-4000-8000-000000000002", text: "Again" })).rejects.toThrow(/already active/);
    const prompt = await promptStream?.[Symbol.asyncIterator]().next();
    expect(prompt?.value.message).toMatchObject({ role: "user", content: "Hello" });
    expect(first.turnId).toEqual(expect.any(String));
    await expect(adapter.steer({ promptId: "steer", text: "redirect" })).rejects.toThrow(/disabled/);
    query.push({ type: "result", subtype: "success", is_error: false, session_id: "session-1" });
    await adapter.stop();
  });

  it("closes the SDK transport and redacts initialization failures", async () => {
    const query = new FakeQuery();
    query.supportedModels = async () => { throw new Error("Unable to authenticate sk-ant-startup-secret"); };
    const adapter = new ClaudeAgentAdapter({ queryFactory: (() => query as unknown as Query), environment: { ANTHROPIC_API_KEY: "sk-ant-startup-secret" } });
    const cwd = await mkdtemp(path.join(tmpdir(), "multicode-claude-start-error-"));
    await expect(adapter.start({ cwd })).rejects.toThrow("Unable to authenticate [REDACTED]");
  });

  it("keeps concurrent approvals distinct and rejects stale resolutions", async () => {
    const query = new FakeQuery();
    let canUseTool: CanUseTool | undefined;
    const adapter = new ClaudeAgentAdapter({ queryFactory: (({ options }) => { canUseTool = options.canUseTool as CanUseTool; return query as unknown as Query; }) });
    const cwd = await mkdtemp(path.join(tmpdir(), "multicode-claude-approvals-"));
    await adapter.start({ cwd });
    const eventIterator = adapter.events()[Symbol.asyncIterator]();
    await eventIterator.next();
    const first = canUseTool?.("Write", { file_path: "one.txt" }, { signal: new AbortController().signal, toolUseID: "tool-1", requestId: "request-1" });
    const second = canUseTool?.("Edit", { file_path: "two.txt" }, { signal: new AbortController().signal, toolUseID: "tool-2", requestId: "request-2" });
    const requested = await Promise.all([eventIterator.next(), eventIterator.next()]);
    expect(requested.map((event) => event.value && event.value.type === "approval.requested" ? event.value.requestId : undefined).sort()).toEqual(["request-1", "request-2"]);
    await adapter.resolveApproval("request-2", "decline");
    await adapter.resolveApproval("request-1", "accept");
    await expect(first).resolves.toMatchObject({ behavior: "allow", updatedInput: { file_path: "one.txt" } });
    await expect(second).resolves.toMatchObject({ behavior: "deny" });
    await expect(adapter.resolveApproval("request-1", "accept")).rejects.toThrow(/no longer pending/);

    const controller = new AbortController();
    const aborted = canUseTool?.("Write", { file_path: "three.txt" }, { signal: controller.signal, toolUseID: "tool-3", requestId: "request-3" });
    await eventIterator.next(); controller.abort();
    await expect(aborted).resolves.toMatchObject({ behavior: "deny", message: "Permission request aborted" });
    await expect(adapter.resolveApproval("request-3", "accept")).rejects.toThrow(/no longer pending/);
    await adapter.stop();
  });

  it("redacts credentials from failures and reports requested interruption without a spurious error", async () => {
    const query = new FakeQuery();
    const adapter = new ClaudeAgentAdapter({ queryFactory: (() => query as unknown as Query), environment: { ANTHROPIC_API_KEY: "sk-ant-super-secret" } });
    const cwd = await mkdtemp(path.join(tmpdir(), "multicode-claude-errors-"));
    await adapter.start({ cwd });
    const events = adapter.events()[Symbol.asyncIterator](); await events.next();
    await adapter.sendPrompt({ promptId: "00000000-0000-4000-8000-000000000003", text: "Fail safely" }); await events.next();
    query.push({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["Failed with sk-ant-super-secret"], session_id: "session-1" });
    await expect(events.next()).resolves.toMatchObject({ value: { type: "agent.error", message: "Failed with [REDACTED]" } });
    await events.next();

    await adapter.sendPrompt({ promptId: "00000000-0000-4000-8000-000000000004", text: "Interrupt me" }); await events.next();
    await adapter.interrupt();
    query.push({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["[ede_diagnostic] interrupted"], session_id: "session-1" });
    await expect(events.next()).resolves.toMatchObject({ value: { type: "turn.completed", status: "interrupted" } });
    expect(query.interrupts).toBe(1);
    await adapter.stop();
  });

  it("maps structured question answers back to AskUserQuestion", async () => {
    const query = new FakeQuery();
    let canUseTool: CanUseTool | undefined;
    const adapter = new ClaudeAgentAdapter({ queryFactory: (({ options }) => { canUseTool = options.canUseTool as CanUseTool; return query as unknown as Query; }) });
    const cwd = await mkdtemp(path.join(tmpdir(), "multicode-claude-input-"));
    await adapter.start({ cwd });
    const events = adapter.events()[Symbol.asyncIterator](); await events.next();
    const response = canUseTool?.("AskUserQuestion", { questions: [{ header: "Style", question: "Which style?", options: [{ label: "Simple", description: "Minimal" }], multiSelect: false }] }, { signal: new AbortController().signal, toolUseID: "question-tool", requestId: "question-1" });
    const requested = await events.next();
    expect(requested.value).toMatchObject({ type: "input.requested", requestId: "question-1", questions: [{ question: "Which style?" }] });
    const questionId = requested.value && requested.value.type === "input.requested" ? requested.value.questions[0]?.id : undefined;
    await adapter.resolveInput("question-1", { [questionId as string]: "Simple" });
    await expect(response).resolves.toMatchObject({ behavior: "allow", updatedInput: { answers: { "Which style?": "Simple" } } });
    await adapter.stop();
  });
});

describe("Claude adapter security and factory", () => {
  it("rejects traversal and symlink escapes while allowing workspace paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "multicode-claude-root-"));
    const outside = await mkdtemp(path.join(tmpdir(), "multicode-claude-outside-"));
    await mkdir(path.join(root, "src"));
    await symlink(outside, path.join(root, "escape"));
    await expect(assertToolPathsWithinWorkspace(root, "Write", { file_path: "src/new.ts" })).resolves.toBeUndefined();
    await expect(assertToolPathsWithinWorkspace(root, "Read", { file_path: "../secret" })).rejects.toThrow(/escapes/);
    await expect(assertToolPathsWithinWorkspace(root, "Write", { file_path: "escape/new.ts" })).rejects.toThrow(/escapes/);
  });

  it("converts SDK models and validates providers through the factory", () => {
    expect(claudeModels([{ value: "claude-test", displayName: "Claude Test", description: "Fixture", supportsEffort: true, supportedEffortLevels: ["low", "high"], supportsAdaptiveThinking: false, supportsFastMode: false }])).toMatchObject([
      { model: "claude-test", isDefault: true, defaultReasoningEffort: "high" },
    ]);
    expect(createAgentAdapter({ provider: "codex" }).configuration().provider).toBe("codex");
    expect(createAgentAdapter({ provider: "claude" }).configuration().provider).toBe("claude");
    expect(() => createAgentAdapter({ provider: "unknown" as "claude" })).toThrow(/Unsupported/);
  });
});
