import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  CanUseTool,
  ModelInfo,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentAdapter,
  AgentConfig,
  AgentEvent,
  AgentInputAnswers,
  AgentModel,
  AgentPrompt,
  AgentQuestion,
  AgentStartOptions,
  ApprovalDecision,
} from "@multicode/protocol";

type JsonObject = Record<string, unknown>;

export interface ClaudeQueryFactory {
  (options: { prompt: AsyncIterable<SDKUserMessage>; options: Record<string, unknown> }): Query;
}

export interface ClaudeAgentAdapterOptions {
  executablePath?: string;
  environment?: NodeJS.ProcessEnv;
  queryFactory?: ClaudeQueryFactory;
  initializationTimeoutMs?: number;
}

class AsyncPushQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) throw new Error("Claude input stream is closed");
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) return { value, done: false };
        if (this.closed) return { value: undefined, done: true };
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

class AgentEventQueue extends AsyncPushQueue<AgentEvent> {}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function text(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function number(value: unknown): number | undefined { return typeof value === "number" ? value : undefined; }

function safePreview(value: unknown, maximum = 2_000): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!serialized) return "";
  return serialized.length > maximum ? `${serialized.slice(0, maximum)}…` : serialized;
}

function toolDisplayName(name: string): string {
  const known: Record<string, string> = {
    Bash: "Shell command", Read: "Read file", Edit: "Edit file", Write: "Write file",
    Glob: "Find files", Grep: "Search files", AskUserQuestion: "Question",
  };
  return known[name] ?? name.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function toolSummary(name: string, input: JsonObject): string {
  if (name === "Bash") return text(input.command) ?? "Run a shell command";
  for (const key of ["file_path", "path", "pattern", "query", "description"]) {
    const value = text(input[key]);
    if (value) return `${toolDisplayName(name)}: ${value}`;
  }
  return toolDisplayName(name);
}

interface ToolState { name: string; displayName: string; startedAt: number; }

export interface ClaudeNormalizationState {
  threadId: string;
  turnId: string | undefined;
  streamMessageId: string | undefined;
  tools: Map<string, ToolState>;
}

export function createClaudeNormalizationState(): ClaudeNormalizationState {
  return { threadId: "", turnId: undefined, streamMessageId: undefined, tools: new Map() };
}

/** Normalizes one SDK frame without throwing on future or unknown frame types. */
export function normalizeClaudeMessage(message: SDKMessage | unknown, state: ClaudeNormalizationState, now = Date.now()): AgentEvent[] {
  const frame = object(message);
  if (!frame) return [];
  const type = text(frame.type);
  const sessionId = text(frame.session_id);
  if (sessionId && !state.threadId) state.threadId = sessionId;
  const threadId = state.threadId;
  const turnId = state.turnId ?? "";

  if (type === "system" && frame.subtype === "init") {
    return threadId ? [{ type: "agent.started", threadId }] : [];
  }

  if (type === "stream_event") {
    const event = object(frame.event);
    if (!event) return [];
    if (event.type === "message_start") state.streamMessageId = text(object(event.message)?.id);
    if (event.type !== "content_block_delta") return [];
    const delta = object(event.delta);
    const index = number(event.index) ?? 0;
    const itemId = `${state.streamMessageId ?? text(frame.uuid) ?? "claude"}:${index}`;
    if (delta?.type === "text_delta") return [{ type: "agent.message.delta", threadId, turnId, itemId, text: text(delta.text) ?? "" }];
    if (delta?.type === "thinking_delta") return [{ type: "agent.reasoning.delta", threadId, turnId, itemId, text: text(delta.thinking) ?? "" }];
    return [];
  }

  if (type === "assistant") {
    const assistant = object(frame.message);
    const messageId = text(assistant?.id) ?? text(frame.uuid) ?? "claude";
    const content = Array.isArray(assistant?.content) ? assistant.content : [];
    const events: AgentEvent[] = [];
    content.forEach((rawBlock, index) => {
      const block = object(rawBlock);
      if (!block) return;
      if (block.type === "text") {
        events.push({ type: "agent.message.completed", threadId, turnId, itemId: `${messageId}:${index}`, text: text(block.text) ?? "" });
      } else if (block.type === "thinking") {
        events.push({ type: "agent.reasoning.completed", threadId, turnId, itemId: `${messageId}:${index}`, text: text(block.thinking) ?? "" });
      } else if (block.type === "tool_use") {
        const itemId = text(block.id) ?? `${messageId}:${index}`;
        const name = text(block.name) ?? "Tool";
        const input = object(block.input) ?? {};
        state.tools.set(itemId, { name, displayName: toolDisplayName(name), startedAt: now });
        if (name === "Bash") {
          const cwd = text(input.cwd);
          events.push({ type: "command.started", threadId, turnId, itemId, command: text(input.command) ?? safePreview(input), ...(cwd ? { cwd } : {}) });
        } else {
          events.push({ type: "tool.started", threadId, turnId, itemId, toolName: name, displayName: toolDisplayName(name), summary: toolSummary(name, input), preview: input });
        }
      }
    });
    return events;
  }

  if (type === "user") {
    const userMessage = object(frame.message);
    const content = Array.isArray(userMessage?.content) ? userMessage.content : [];
    const events: AgentEvent[] = [];
    for (const rawBlock of content) {
      const block = object(rawBlock);
      if (block?.type !== "tool_result") continue;
      const itemId = text(block.tool_use_id) ?? "";
      const tool = state.tools.get(itemId);
      if (!tool) continue;
      const output = safePreview(block.content ?? frame.tool_use_result);
      const failed = block.is_error === true;
      if (tool.name === "Bash") {
        if (output) events.push({ type: "command.output", threadId, turnId, itemId, text: output });
        const result = object(frame.tool_use_result);
        const exitCode = number(result?.exitCode) ?? number(result?.exit_code) ?? (failed ? 1 : 0);
        events.push({ type: "command.exited", threadId, turnId, itemId, exitCode, ...(output ? { output } : {}) });
      } else {
        if (output) events.push({ type: "tool.output", threadId, turnId, itemId, text: output });
        events.push({ type: "tool.completed", threadId, turnId, itemId, toolName: tool.name, displayName: tool.displayName, status: failed ? "failed" : "completed", durationMs: Math.max(0, now - tool.startedAt), ...(output ? { output } : {}) });
      }
      state.tools.delete(itemId);
    }
    return events;
  }

  if (type === "result") {
    const status = frame.subtype === "success" && frame.is_error !== true ? "completed" : text(frame.subtype) ?? "failed";
    const events: AgentEvent[] = [];
    if (frame.is_error === true) {
      const errors = Array.isArray(frame.errors) ? frame.errors.filter((value): value is string => typeof value === "string") : [];
      const result = text(frame.result);
      events.push({ type: "agent.error", message: errors.join("\n") || result || `Claude turn failed: ${status}` });
    }
    events.push({ type: "turn.completed", threadId, turnId, status });
    return events;
  }

  return [];
}

export function claudeModels(models: ModelInfo[]): AgentModel[] {
  return models.map((model, index) => {
    const efforts = model.supportedEffortLevels ?? [];
    return {
      id: model.value,
      model: model.value,
      displayName: model.displayName,
      description: model.description,
      isDefault: index === 0,
      defaultReasoningEffort: efforts.includes("high") ? "high" : efforts[0] ?? "none",
      supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort, description: `${reasoningEffort} reasoning effort` })),
    };
  });
}

function candidatePaths(toolName: string, input: JsonObject): string[] {
  if (toolName === "Bash") return [];
  return ["file_path", "path", "notebook_path", "directory", "source_path", "destination_path"]
    .flatMap((key) => typeof input[key] === "string" ? [input[key] as string] : []);
}

async function nearestExistingRealpath(target: string): Promise<string> {
  let current = target;
  while (true) {
    try { await lstat(current); return await realpath(current); }
    catch {
      const parent = path.dirname(current);
      if (parent === current) throw new Error(`No existing parent for ${target}`);
      current = parent;
    }
  }
}

export async function assertToolPathsWithinWorkspace(cwd: string, toolName: string, input: JsonObject): Promise<void> {
  const root = await realpath(cwd);
  for (const candidate of candidatePaths(toolName, input)) {
    const target = path.resolve(root, candidate);
    const existing = await nearestExistingRealpath(target);
    const relative = path.relative(root, existing);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${toolName} path escapes the agent worktree`);
  }
}

interface PendingPermission {
  input: JsonObject;
  suggestions?: PermissionUpdate[];
  resolve: (result: PermissionResult) => void;
  promise: Promise<PermissionResult>;
  cleanup: () => void;
}

interface PendingInput {
  input: JsonObject;
  questions: AgentQuestion[];
  resolve: (result: PermissionResult) => void;
  promise: Promise<PermissionResult>;
  cleanup: () => void;
}

export class ClaudeAgentAdapter implements AgentAdapter {
  private readonly eventQueue = new AgentEventQueue();
  private readonly inputQueue = new AsyncPushQueue<SDKUserMessage>();
  private readonly normalizer = createClaudeNormalizationState();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly pendingInputs = new Map<string, PendingInput>();
  private query: Query | undefined;
  private consumeTask: Promise<void> | undefined;
  private threadId: string | undefined;
  private activeTurnId: string | undefined;
  private interruptedTurnId: string | undefined;
  private stopped = false;
  private cwd = "";
  private config: AgentConfig = {
    provider: "claude", displayName: "Claude", models: [],
    capabilities: { modelSelection: true, effortSelection: true, steering: false, interruption: true, approvals: true, structuredQuestions: true },
  };

  constructor(private readonly options: ClaudeAgentAdapterOptions = {}) {}

  async start(options: AgentStartOptions): Promise<{ threadId: string }> {
    if (this.query) throw new Error("Claude adapter has already started");
    this.cwd = await realpath(options.cwd);
    const queryFactory = this.options.queryFactory ?? (await import("@anthropic-ai/claude-agent-sdk")).query as ClaudeQueryFactory;
    const canUseTool: CanUseTool = (toolName, input, permissionOptions) => this.requestToolPermission(toolName, input, permissionOptions);
    const environment = {
      ...process.env,
      ...this.options.environment,
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
      CLAUDE_AGENT_SDK_CLIENT_APP: "multicode",
    };
    this.query = queryFactory({
      prompt: this.inputQueue,
      options: {
        cwd: this.cwd,
        env: environment,
        includePartialMessages: true,
        permissionMode: "default",
        canUseTool,
        persistSession: false,
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort && options.effort !== "none" ? { effort: options.effort } : {}),
        ...(this.options.executablePath ? { pathToClaudeCodeExecutable: this.options.executablePath } : {}),
      },
    });

    // MultiCode owns its stable thread identity just as it owns turn IDs. The
    // current SDK does not emit its init frame until the first user message,
    // while MultiCode must finish room startup before accepting that message.
    const threadId = randomUUID();
    this.threadId = threadId;
    this.normalizer.threadId = threadId;
    this.consumeTask = this.consume();
    // Streaming-input queries defer spawning until they receive input or a
    // control request. Model discovery is a harmless control request that
    // starts the subprocess and allows the init frame to arrive before the
    // first user turn.
    const modelsPromise = this.query.supportedModels();
    const timeoutMs = this.options.initializationTimeoutMs ?? 15_000;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let discoveredModels: ModelInfo[];
    try {
      discoveredModels = await Promise.race([
        modelsPromise,
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Claude Agent SDK initialization timed out during model discovery")), timeoutMs); }),
      ]);
    } catch (error) {
      this.inputQueue.close();
      this.query.close();
      await this.consumeTask.catch(() => undefined);
      this.query = undefined;
      throw new Error(this.redact(error instanceof Error ? error.message : String(error)));
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    const models = claudeModels(discoveredModels);
    const selectedModel = options.model ?? models.find((model) => model.isDefault)?.model;
    const selected = models.find((model) => model.model === selectedModel);
    const selectedEffort = options.effort ?? selected?.defaultReasoningEffort;
    this.config = {
      provider: "claude", displayName: "Claude", models,
      ...(selectedModel ? { model: selectedModel } : {}),
      ...(selectedEffort && selectedEffort !== "none" ? { effort: selectedEffort } : {}),
      capabilities: { modelSelection: models.length > 0, effortSelection: models.some((model) => model.supportedReasoningEfforts.length > 0), steering: false, interruption: true, approvals: true, structuredQuestions: true },
    };
    this.eventQueue.push({ type: "agent.started", threadId });
    return { threadId };
  }

  configuration(): AgentConfig {
    return { ...this.config, capabilities: { ...this.config.capabilities }, models: this.config.models.map((model) => ({ ...model, supportedReasoningEfforts: model.supportedReasoningEfforts.map((effort) => ({ ...effort })) })) };
  }

  async sendPrompt(prompt: AgentPrompt): Promise<{ turnId: string }> {
    if (!this.query || !this.threadId) throw new Error("Claude adapter is not started");
    if (this.activeTurnId) throw new Error("A Claude turn is already active; queue or interrupt it first");
    if (prompt.model && prompt.model !== this.config.model) { await this.query.setModel(prompt.model); this.config.model = prompt.model; }
    if (prompt.effort && prompt.effort !== this.config.effort) {
      await this.query.applyFlagSettings({ effortLevel: prompt.effort as "low" | "medium" | "high" | "xhigh" | "max" });
      this.config.effort = prompt.effort;
    }
    const turnId = randomUUID();
    this.activeTurnId = turnId;
    this.normalizer.turnId = turnId;
    this.eventQueue.push({ type: "turn.started", threadId: this.threadId, turnId });
    this.inputQueue.push({ type: "user", message: { role: "user", content: prompt.text }, parent_tool_use_id: null, session_id: this.threadId, uuid: prompt.promptId as `${string}-${string}-${string}-${string}-${string}` });
    return { turnId };
  }

  async steer(_prompt: AgentPrompt): Promise<{ turnId: string }> {
    throw new Error("Claude steering is disabled until active-turn semantics are verified; queue the prompt instead");
  }

  async interrupt(): Promise<void> {
    if (!this.query || !this.activeTurnId) return;
    this.interruptedTurnId = this.activeTurnId;
    await this.query.interrupt();
    this.cancelPending("Turn interrupted");
  }

  async resolveApproval(requestId: string | number, decision: ApprovalDecision): Promise<void> {
    const id = String(requestId);
    const pending = this.pendingPermissions.get(id);
    if (!pending) throw new Error(`Approval request ${id} is no longer pending`);
    this.pendingPermissions.delete(id); pending.cleanup();
    if (decision === "accept") pending.resolve({ behavior: "allow", updatedInput: pending.input });
    else pending.resolve({ behavior: "deny", message: decision === "cancel" ? "Turn cancelled by user" : "Tool use declined by user", ...(decision === "cancel" ? { interrupt: true } : {}) });
    this.eventQueue.push({ type: "approval.resolved", requestId: id, decision });
    if (decision === "cancel") await this.interrupt();
  }

  async resolveInput(requestId: string, answers: AgentInputAnswers | null): Promise<void> {
    const pending = this.pendingInputs.get(requestId);
    if (!pending) throw new Error(`Input request ${requestId} is no longer pending`);
    this.pendingInputs.delete(requestId); pending.cleanup();
    if (!answers) {
      pending.resolve({ behavior: "deny", message: "Question cancelled by user" });
      this.eventQueue.push({ type: "input.cancelled", requestId, reason: "Cancelled by user" });
      return;
    }
    const byQuestion: Record<string, string> = {};
    for (const question of pending.questions) {
      const answer = answers[question.id];
      if (answer !== undefined) byQuestion[question.question] = Array.isArray(answer) ? answer.join(", ") : answer;
    }
    pending.resolve({ behavior: "allow", updatedInput: { ...pending.input, answers: byQuestion } });
    this.eventQueue.push({ type: "input.answered", requestId, answers });
  }

  events(): AsyncIterable<AgentEvent> { return this.eventQueue; }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelPending("Claude adapter stopped");
    this.inputQueue.close();
    this.query?.close();
    await this.consumeTask?.catch(() => undefined);
    this.query = undefined;
    this.eventQueue.close();
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.query as Query) {
        const normalized = normalizeClaudeMessage(message, this.normalizer);
        for (let event of normalized) {
          if (event.type === "agent.started") continue;
          // The SDK currently reports an internal diagnostic error as part of
          // some successful interrupt sequences. The requested interruption is
          // represented by the terminal turn event, not as an agent failure.
          if (event.type === "agent.error" && this.interruptedTurnId === this.normalizer.turnId) continue;
          if (event.type === "agent.error") event = { ...event, message: this.redact(event.message) };
          if (event.type === "turn.completed") {
            if (this.interruptedTurnId === event.turnId) event = { ...event, status: "interrupted" };
            this.activeTurnId = undefined; this.normalizer.turnId = undefined; this.interruptedTurnId = undefined;
            this.cancelPending("Turn completed before the request was answered");
          }
          this.eventQueue.push(event);
        }
      }
    } catch (error) {
      const failure = new Error(this.redact(error instanceof Error ? error.message : String(error)));
      this.eventQueue.push({ type: "agent.error", message: failure.message });
    } finally {
      if (this.threadId && !this.stopped) {
        if (this.activeTurnId) {
          this.eventQueue.push({ type: "turn.completed", threadId: this.threadId, turnId: this.activeTurnId, status: "process-exited" });
          this.activeTurnId = undefined; this.normalizer.turnId = undefined; this.interruptedTurnId = undefined;
        }
        this.eventQueue.push({ type: "agent.exited", exitCode: null, signal: null });
      }
      this.cancelPending("Claude process exited");
    }
  }

  private async requestToolPermission(toolName: string, input: JsonObject, options: Parameters<CanUseTool>[2]): Promise<PermissionResult> {
    try { await assertToolPathsWithinWorkspace(this.cwd, toolName, input); }
    catch (error) { return { behavior: "deny", message: error instanceof Error ? error.message : String(error) }; }
    if (toolName === "AskUserQuestion") return this.requestStructuredInput(input, options);
    if (["Read", "Glob", "Grep"].includes(toolName)) return { behavior: "allow", updatedInput: input };
    const requestId = options.requestId || randomUUID();
    const existing = this.pendingPermissions.get(requestId);
    if (existing) return existing.promise;
    let settle!: (result: PermissionResult) => void;
    const promise = new Promise<PermissionResult>((resolve) => { settle = resolve; });
    {
      const abort = () => { if (!this.pendingPermissions.delete(requestId)) return; settle({ behavior: "deny", message: "Permission request aborted" }); };
      options.signal.addEventListener("abort", abort, { once: true });
      const resolve = settle;
      this.pendingPermissions.set(requestId, { input, ...(options.suggestions ? { suggestions: options.suggestions } : {}), resolve, promise, cleanup: () => options.signal.removeEventListener("abort", abort) });
      if (options.signal.aborted) abort();
      if (!this.pendingPermissions.has(requestId)) return promise;
      this.eventQueue.push({ type: "approval.requested", requestId, approvalKind: `claude.tool.${toolName}`, details: { toolName, displayName: options.displayName ?? toolDisplayName(toolName), title: options.title ?? `Allow Claude to use ${toolDisplayName(toolName)}?`, description: options.description, reason: options.decisionReason, input, summary: toolSummary(toolName, input), suggestions: options.suggestions ?? [] } });
    }
    return promise;
  }

  private requestStructuredInput(input: JsonObject, options: Parameters<CanUseTool>[2]): Promise<PermissionResult> {
    const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
    const requestId = options.requestId || randomUUID();
    const questions: AgentQuestion[] = rawQuestions.slice(0, 4).flatMap((raw, index) => {
      const question = object(raw); const questionText = text(question?.question); if (!questionText) return [];
      const rawOptions = Array.isArray(question?.options) ? question.options : [];
      return [{
        id: `${requestId}:${index}`,
        header: text(question?.header)?.slice(0, 12) || `Question ${index + 1}`,
        question: questionText,
        options: rawOptions.slice(0, 4).flatMap((rawOption) => { const option = object(rawOption); const label = text(option?.label); if (!label) return []; const preview = text(option?.preview); return [{ label, description: text(option?.description) ?? "", ...(preview ? { preview } : {}) }]; }),
        multiSelect: question?.multiSelect === true,
        allowFreeform: true,
      }];
    });
    if (!questions.length) return Promise.resolve({ behavior: "deny", message: "Claude produced an invalid structured question" });
    const existing = this.pendingInputs.get(requestId);
    if (existing) return existing.promise;
    let settle!: (result: PermissionResult) => void;
    const promise = new Promise<PermissionResult>((resolve) => { settle = resolve; });
    {
      const abort = () => { if (!this.pendingInputs.delete(requestId)) return; settle({ behavior: "deny", message: "Input request aborted" }); };
      options.signal.addEventListener("abort", abort, { once: true });
      const resolve = settle;
      this.pendingInputs.set(requestId, { input, questions, resolve, promise, cleanup: () => options.signal.removeEventListener("abort", abort) });
      if (options.signal.aborted) abort();
      if (!this.pendingInputs.has(requestId)) return promise;
      this.eventQueue.push({ type: "input.requested", requestId, toolUseId: options.toolUseID, questions });
    }
    return promise;
  }

  private cancelPending(message: string): void {
    for (const [requestId, pending] of this.pendingPermissions) { pending.cleanup(); pending.resolve({ behavior: "deny", message }); this.pendingPermissions.delete(requestId); }
    for (const [requestId, pending] of this.pendingInputs) { pending.cleanup(); pending.resolve({ behavior: "deny", message }); this.eventQueue.push({ type: "input.cancelled", requestId, reason: message }); this.pendingInputs.delete(requestId); }
  }

  private redact(message: string): string {
    let redacted = message.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[REDACTED]");
    const key = this.options.environment?.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
    if (key) redacted = redacted.split(key).join("[REDACTED]");
    return redacted;
  }
}
