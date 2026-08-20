import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  AgentAdapter,
  AgentEvent,
  AgentPrompt,
  AgentStartOptions,
  ApprovalDecision,
} from "@multicode/protocol";

type JsonObject = Record<string, unknown>;

interface JsonRpcMessage extends JsonObject {
  id?: string | number;
  method?: string;
  params?: JsonObject;
  result?: JsonObject;
  error?: { code?: number; message?: string };
}

interface PendingRequest {
  resolve: (result: JsonObject) => void;
  reject: (error: Error) => void;
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
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

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

export function normalizeCodexMessage(message: JsonRpcMessage): AgentEvent | undefined {
  const params = object(message.params);

  if (message.method === "item/reasoning/summaryTextDelta" && params) {
    return {
      type: "agent.reasoning.delta",
      threadId: string(params.threadId) ?? "",
      turnId: string(params.turnId) ?? "",
      itemId: string(params.itemId) ?? "",
      text: string(params.delta) ?? "",
    };
  }

  if (message.method === "item/agentMessage/delta" && params) {
    return {
      type: "agent.message.delta",
      threadId: string(params.threadId) ?? "",
      turnId: string(params.turnId) ?? "",
      itemId: string(params.itemId) ?? "",
      text: string(params.delta) ?? "",
    };
  }

  if (message.method === "turn/started" && params) {
    const turn = object(params.turn);
    return {
      type: "turn.started",
      threadId: string(params.threadId) ?? "",
      turnId: string(turn?.id) ?? "",
    };
  }

  if (message.method === "turn/completed" && params) {
    const turn = object(params.turn);
    const status = string(turn?.status);
    return {
      type: "turn.completed",
      threadId: string(params.threadId) ?? "",
      turnId: string(turn?.id) ?? "",
      ...(status ? { status } : {}),
    };
  }

  if (message.method === "item/commandExecution/outputDelta" && params) {
    return {
      type: "command.output",
      threadId: string(params.threadId) ?? "",
      turnId: string(params.turnId) ?? "",
      itemId: string(params.itemId) ?? "",
      text: string(params.delta) ?? "",
    };
  }

  if ((message.method === "item/started" || message.method === "item/completed") && params) {
    const item = object(params.item);
    if (item?.type === "agentMessage") {
      if (message.method === "item/completed") {
        return {
          type: "agent.message.completed",
          threadId: string(params.threadId) ?? "",
          turnId: string(params.turnId) ?? "",
          itemId: string(item.id) ?? "",
          text: string(item.text) ?? "",
        };
      }
      return undefined;
    }

    if (item?.type === "reasoning") {
      if (message.method === "item/completed") {
        const summary = Array.isArray(item.summary)
          ? item.summary.filter((part): part is string => typeof part === "string").join("\n")
          : "";
        return {
          type: "agent.reasoning.completed",
          threadId: string(params.threadId) ?? "",
          turnId: string(params.turnId) ?? "",
          itemId: string(item.id) ?? "",
          text: summary,
        };
      }
      return undefined;
    }

    if (item?.type === "commandExecution") {
      if (message.method === "item/started") {
        const cwd = string(item.cwd);
        return {
          type: "command.started",
          threadId: string(params.threadId) ?? "",
          turnId: string(params.turnId) ?? "",
          itemId: string(item.id) ?? "",
          command: string(item.command) ?? "",
          ...(cwd ? { cwd } : {}),
        };
      }
      const output = string(item.aggregatedOutput);
      return {
        type: "command.exited",
        threadId: string(params.threadId) ?? "",
        turnId: string(params.turnId) ?? "",
        itemId: string(item.id) ?? "",
        exitCode: numberOrNull(item.exitCode),
        ...(output ? { output } : {}),
      };
    }
  }

  if (message.method?.endsWith("/requestApproval") && message.id !== undefined && params) {
    return {
      type: "approval.requested",
      requestId: message.id,
      approvalKind: message.method,
      details: params,
    };
  }

  return undefined;
}

export class CodexAppServerAdapter implements AgentAdapter {
  private process: ChildProcessWithoutNullStreams | undefined;
  private readonly eventQueue = new AsyncEventQueue<AgentEvent>();
  private readonly pending = new Map<string | number, PendingRequest>();
  private nextRequestId = 1;
  private threadId: string | undefined;
  private activeTurnId: string | undefined;

  constructor(private readonly executable = "codex") {}

  async start(options: AgentStartOptions): Promise<{ threadId: string }> {
    if (this.process) throw new Error("Codex adapter has already started");

    this.process = spawn(this.executable, ["app-server", "--stdio"], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.on("error", (error) => this.fail(error));
    this.process.on("exit", (exitCode, signal) => {
      this.eventQueue.push({ type: "agent.exited", exitCode, signal });
      this.fail(new Error(`Codex exited${exitCode === null ? "" : ` with code ${exitCode}`}`));
      this.eventQueue.close();
    });
    this.process.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8").trim();
      if (message) this.eventQueue.push({ type: "agent.error", message });
    });

    const lines = createInterface({ input: this.process.stdout });
    lines.on("line", (line) => this.handleLine(line));

    await this.request("initialize", {
      clientInfo: { name: "multicode", title: "MultiCode", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});

    const result = await this.request("thread/start", {
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
    });
    const thread = object(result.thread);
    const threadId = string(thread?.id);
    if (!threadId) throw new Error("Codex thread/start returned no thread ID");

    this.threadId = threadId;
    this.eventQueue.push({ type: "agent.started", threadId });
    return { threadId };
  }

  async sendPrompt(prompt: AgentPrompt): Promise<{ turnId: string }> {
    if (!this.threadId) throw new Error("Codex adapter is not started");
    if (this.activeTurnId) throw new Error("A Codex turn is already active; queue or interrupt it first");

    const result = await this.request("turn/start", {
      threadId: this.threadId,
      clientUserMessageId: prompt.promptId,
      input: [{ type: "text", text: prompt.text }],
      summary: "auto",
    });
    const turn = object(result.turn);
    const turnId = string(turn?.id);
    if (!turnId) throw new Error("Codex turn/start returned no turn ID");
    this.activeTurnId = turnId;
    return { turnId };
  }

  async interrupt(): Promise<void> {
    if (!this.threadId || !this.activeTurnId) return;
    await this.request("turn/interrupt", {
      threadId: this.threadId,
      turnId: this.activeTurnId,
    });
    this.activeTurnId = undefined;
  }

  async resolveApproval(requestId: string | number, decision: ApprovalDecision): Promise<void> {
    this.write({ id: requestId, result: { decision } });
  }

  events(): AsyncIterable<AgentEvent> {
    return this.eventQueue;
  }

  async stop(): Promise<void> {
    if (!this.process) return;
    this.process.kill("SIGTERM");
    this.process = undefined;
  }

  private async request(method: string, params: JsonObject): Promise<JsonObject> {
    const id = this.nextRequestId++;
    const result = new Promise<JsonObject>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.write({ id, method, params });
    return result;
  }

  private notify(method: string, params: JsonObject): void {
    this.write({ method, params });
  }

  private write(message: JsonRpcMessage): void {
    if (!this.process?.stdin.writable) throw new Error("Codex app-server is not writable");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.eventQueue.push({ type: "agent.error", message: `Invalid JSON from Codex: ${line}` });
      return;
    }

    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "Codex request failed"));
      else pending.resolve(object(message.result) ?? {});
      return;
    }

    if (message.method === "turn/completed") this.activeTurnId = undefined;
    const event = normalizeCodexMessage(message);
    if (event) this.eventQueue.push(event);
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
