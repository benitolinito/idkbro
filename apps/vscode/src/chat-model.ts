import type { AgentConfig, AgentEvent, AgentInputAnswers, AgentQuestion, QueuedPrompt, RoomParticipant, RoomServerMessage, WorkspaceDiff } from "@multicode/protocol";

export type ConnectionState = "idle" | "starting" | "connected" | "stopping" | "error";
export type TimelineKind = "user" | "assistant" | "reasoning" | "command" | "diff" | "system" | "error" | "approval" | "input";

export interface TimelineItem {
  id: string;
  kind: TimelineKind;
  title?: string;
  text: string;
  status?: string;
  timestamp: string;
  startedAt?: string;
  finishedAt?: string;
  turnId?: string;
  command?: string;
  durationMs?: number;
  approval?: {
    requestId: string | number;
    approvalKind: string;
    command?: string;
    cwd?: string;
    reason?: string;
  };
  input?: { requestId: string; questions: AgentQuestion[]; answers?: AgentInputAnswers };
  changes?: {
    additions: number;
    deletions: number;
    files: Array<{ path: string; additions: number; deletions: number; binary?: boolean }>;
  };
}

type TimelineMetadata = Partial<Pick<TimelineItem, "timestamp" | "startedAt" | "finishedAt" | "turnId" | "command" | "durationMs" | "changes">>;

export interface ParticipantView {
  name: string;
  host: boolean;
  synced: boolean;
}

export interface ChatSnapshot {
  connection: ConnectionState;
  mode?: "host" | "join";
  roomId?: string;
  roomLabel?: string;
  participants: ParticipantView[];
  queue: Array<{ id: string; name: string; text: string; owned: boolean; model?: string; effort?: string }>;
  activePrompt?: { id: string; name: string; text: string };
  agentConfig?: AgentConfig;
  activeTurnIds: string[];
  timeline: TimelineItem[];
  canApprove: boolean;
  canReturnToStart: boolean;
}

const maxTimelineItems = 300;

function promptView(prompt: QueuedPrompt, selfId?: string) {
  return {
    id: prompt.promptId,
    name: prompt.participantName,
    text: prompt.text,
    owned: Boolean(selfId && prompt.participantId === selfId),
    ...(prompt.model ? { model: prompt.model } : {}),
    ...(prompt.effort ? { effort: prompt.effort } : {}),
  };
}

export class ChatModel {
  private connection: ConnectionState = "idle";
  private mode: "host" | "join" | undefined;
  private roomId: string | undefined;
  private roomLabel: string | undefined;
  private readonly participants = new Map<string, RoomParticipant>();
  private queue: QueuedPrompt[] = [];
  private activePrompt: QueuedPrompt | undefined;
  private agentConfig: AgentConfig | undefined;
  private selfId: string | undefined;
  private readonly timeline: TimelineItem[] = [];
  private readonly reasoningItems = new Map<string, { turnId: string; text: string; completed: boolean }>();
  private readonly turnStartedAt = new Map<string, string>();

  start(mode: "host" | "join", roomLabel?: string): void {
    this.connection = "starting";
    this.mode = mode;
    this.roomId = undefined;
    this.roomLabel = roomLabel;
    this.participants.clear();
    this.queue = [];
    this.activePrompt = undefined;
    this.agentConfig = undefined;
    this.selfId = undefined;
    this.reasoningItems.clear();
    this.turnStartedAt.clear();
    this.timeline.splice(0);
    this.add("system", mode === "host" ? "Starting a shared agent room…" : "Joining the shared agent room…");
  }

  ready(roomLabel: string): void {
    this.connection = "connected";
    this.roomLabel = roomLabel;
  }

  stopping(): void {
    this.connection = "stopping";
    this.add("system", "Stopping the room…");
  }

  stopped(message = "Room closed"): void {
    this.connection = "idle";
    this.mode = undefined;
    this.roomId = undefined;
    this.roomLabel = undefined;
    this.participants.clear();
    this.queue = [];
    this.activePrompt = undefined;
    this.agentConfig = undefined;
    this.selfId = undefined;
    this.reasoningItems.clear();
    this.turnStartedAt.clear();
    this.add("system", message);
  }

  reset(): void {
    this.connection = "idle";
    this.mode = undefined;
    this.roomId = undefined;
    this.roomLabel = undefined;
    this.participants.clear();
    this.queue = [];
    this.activePrompt = undefined;
    this.agentConfig = undefined;
    this.selfId = undefined;
    this.reasoningItems.clear();
    this.turnStartedAt.clear();
    this.timeline.splice(0);
  }

  fail(message: string): void {
    this.connection = "error";
    this.add("error", message);
  }

  submitted(name: string, text: string): void {
    this.add("user", text, name);
  }

  handle(message: RoomServerMessage): void {
    switch (message.type) {
      case "room.welcome":
        this.connection = "connected";
        this.roomId = message.roomId;
        this.selfId = message.selfId;
        this.roomLabel ??= message.roomId;
        this.participants.clear();
        for (const participant of message.participants) this.participants.set(participant.id, participant);
        this.queue = [...message.queue];
        this.activePrompt = message.activePrompt ?? undefined;
        this.agentConfig = message.agentConfig;
        if (message.activePrompt) this.addPrompt(message.activePrompt);
        if (message.latestDiff) this.handleWorkspaceDiff(message.latestDiff);
        this.add("system", `Connected to room ${message.roomId}`);
        break;
      case "participant.joined":
        this.participants.set(message.participant.id, message.participant);
        this.add("system", `${message.participant.name} joined`);
        break;
      case "participant.left":
        this.participants.delete(message.participantId);
        this.add("system", `${message.name} left`);
        break;
      case "participant.capabilities": {
        const participant = this.participants.get(message.participantId);
        if (participant) this.participants.set(message.participantId, { ...participant, capabilities: [...message.capabilities] });
        break;
      }
      case "participant.synced": {
        const participant = this.participants.get(message.participantId);
        if (participant) this.participants.set(message.participantId, { ...participant, synced: true });
        break;
      }
      case "prompt.queued":
        if (!this.queue.some((prompt) => prompt.promptId === message.prompt.promptId)) this.queue.push(message.prompt);
        break;
      case "prompt.updated": {
        const index = this.queue.findIndex((prompt) => prompt.promptId === message.prompt.promptId);
        if (index >= 0) this.queue[index] = message.prompt;
        break;
      }
      case "prompt.removed":
        this.queue = this.queue.filter((prompt) => prompt.promptId !== message.promptId);
        break;
      case "prompt.steered":
        this.queue = this.queue.filter((prompt) => prompt.promptId !== message.prompt.promptId);
        this.addPrompt(message.prompt);
        break;
      case "prompt.steer":
        break;
      case "prompt.started":
        this.queue = this.queue.filter((prompt) => prompt.promptId !== message.prompt.promptId);
        this.activePrompt = message.prompt;
        this.addPrompt(message.prompt);
        break;
      case "agent.config":
        this.agentConfig = message.config;
        break;
      case "agent.event":
        this.handleAgent(message.event);
        break;
      case "workspace.diff":
        this.handleWorkspaceDiff(message.diff);
        break;
      case "workspace.checkpoint":
        this.add("system", `Workspace checkpoint ${message.checkpoint.sequence} · ${message.checkpoint.commit.slice(0, 12)}`);
        break;
      case "collab.event":
      case "collab.rate_limited":
      case "collab.rejected":
        break;
      case "room.error":
        if (message.fatal) this.connection = "error";
        this.addError(message.message);
        break;
    }
  }

  snapshot(): ChatSnapshot {
    const byName = new Map<string, ParticipantView>();
    for (const participant of this.participants.values()) {
      const key = participant.name.toLocaleLowerCase();
      const current = byName.get(key);
      byName.set(key, {
        name: participant.name,
        host: Boolean(current?.host || participant.host),
        synced: Boolean(current?.synced || participant.synced),
      });
    }
    return {
      connection: this.connection,
      ...(this.mode ? { mode: this.mode } : {}),
      ...(this.roomId ? { roomId: this.roomId } : {}),
      ...(this.roomLabel ? { roomLabel: this.roomLabel } : {}),
      participants: [...byName.values()].sort((a, b) => Number(b.host) - Number(a.host) || a.name.localeCompare(b.name)),
      queue: this.queue.map((prompt) => promptView(prompt, this.selfId)),
      ...(this.activePrompt ? { activePrompt: promptView(this.activePrompt, this.selfId) } : {}),
      ...(this.agentConfig ? { agentConfig: this.cloneAgentConfig(this.agentConfig) } : {}),
      activeTurnIds: [...this.turnStartedAt.keys()],
      timeline: this.timeline.map((item) => ({
        ...item,
        ...(item.approval ? { approval: { ...item.approval } } : {}),
        ...(item.input ? { input: { ...item.input, questions: item.input.questions.map((question) => ({ ...question, options: question.options.map((option) => ({ ...option })) })), ...(item.input.answers ? { answers: { ...item.input.answers } } : {}) } } : {}),
        ...(item.changes ? { changes: { ...item.changes, files: item.changes.files.map((file) => ({ ...file })) } } : {}),
      })),
      canApprove: this.mode === "host" || Boolean(this.selfId && this.participants.get(this.selfId)?.capabilities.includes("reviewer")),
      canReturnToStart: this.connection === "idle" && this.timeline.length > 0,
    };
  }

  private cloneAgentConfig(config: AgentConfig): AgentConfig {
    return {
      ...config,
      models: config.models.map((model) => ({
        ...model,
        supportedReasoningEfforts: model.supportedReasoningEfforts.map((option) => ({ ...option })),
      })),
    };
  }

  private addError(message: string): void {
    const last = this.timeline.at(-1);
    if (last?.kind === "error" && last.text === message) return;
    this.add("error", message);
  }

  private handleWorkspaceDiff(diff: WorkspaceDiff): void {
    const files = diff.files?.map((file) => ({ ...file })) ?? [];
    this.upsert(
      `diff:${diff.revision}`,
      "diff",
      diff.text || "No tracked workspace changes.",
      "Workspace changes",
      diff.truncated ? "truncated" : undefined,
      undefined,
      files.length ? {
        changes: {
          additions: diff.additions ?? files.reduce((total, file) => total + file.additions, 0),
          deletions: diff.deletions ?? files.reduce((total, file) => total + file.deletions, 0),
          files,
        },
      } : undefined,
    );
  }

  approvalSubmitting(requestId: string | number): void {
    const item = this.find(`approval:${requestId}`);
    if (item) item.status = "resolving";
  }

  approvalFailed(requestId: string | number, message: string): void {
    const item = this.find(`approval:${requestId}`);
    if (item) item.status = "pending";
    this.add("error", `Approval ${requestId} was not sent: ${message}`, "Approval");
  }

  inputSubmitting(requestId: string): void { const item = this.find(`input:${requestId}`); if (item) item.status = "resolving"; }
  inputFailed(requestId: string, message: string): void { const item = this.find(`input:${requestId}`); if (item) item.status = "pending"; this.add("error", `Input ${requestId} was not sent: ${message}`, "Input"); }

  private handleAgent(event: AgentEvent): void {
    const agentName = this.agentConfig?.displayName ?? "Agent";
    switch (event.type) {
      case "agent.reasoning.delta":
        this.updateReasoning(event.turnId, event.itemId, event.text, false);
        break;
      case "agent.reasoning.completed":
        this.updateReasoning(event.turnId, event.itemId, event.text, true);
        break;
      case "agent.message.delta":
        this.append(`message:${event.itemId}`, "assistant", event.text, agentName);
        break;
      case "agent.message.completed":
        this.complete(`message:${event.itemId}`, "assistant", event.text, agentName);
        break;
      case "command.started": {
        const startedAt = this.turnStartedAt.get(event.turnId);
        this.upsert(`command:${event.itemId}`, "command", "", "Command", "running", undefined, {
          turnId: event.turnId,
          command: event.command,
          ...(startedAt ? { startedAt } : {}),
        });
        break;
      }
      case "command.output":
        this.append(`command:${event.itemId}`, "command", event.text, "Command", "running");
        break;
      case "command.exited":
        {
          const current = this.find(`command:${event.itemId}`);
          const finishedAt = new Date().toISOString();
          this.upsert(
            `command:${event.itemId}`,
            "command",
            event.output ?? current?.text ?? "",
            "Command",
            event.exitCode === 0 ? "completed" : `exit ${event.exitCode ?? "unknown"}`,
            undefined,
            {
              turnId: event.turnId,
              ...(current?.command ? { command: current.command } : {}),
              finishedAt,
              ...(current ? { durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(current.timestamp)) } : {}),
            },
          );
        }
        break;
      case "tool.started": {
        const startedAt = this.turnStartedAt.get(event.turnId);
        this.upsert(`tool:${event.itemId}`, "command", "", event.displayName, "running", undefined, { turnId: event.turnId, command: event.summary, ...(startedAt ? { startedAt } : {}) });
        break;
      }
      case "tool.output":
        this.append(`tool:${event.itemId}`, "command", event.text, "Tool", "running");
        break;
      case "tool.completed": {
        const current = this.find(`tool:${event.itemId}`); const finishedAt = new Date().toISOString();
        this.upsert(`tool:${event.itemId}`, "command", event.output ?? current?.text ?? "", event.displayName, event.status, undefined, { turnId: event.turnId, ...(current?.command ? { command: current.command } : {}), finishedAt, ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}) });
        break;
      }
      case "approval.requested":
        this.upsert(`approval:${event.requestId}`, "approval", this.approvalText(event), "Approval required", "pending", {
          requestId: event.requestId,
          approvalKind: event.approvalKind,
          ...this.approvalDetails(event),
        });
        break;
      case "approval.resolved": {
        const current = this.find(`approval:${event.requestId}`);
        const status = event.decision === "accept" ? "approved" : event.decision === "decline" ? "declined" : "cancelled";
        this.upsert(`approval:${event.requestId}`, "approval", current?.text ?? `Request ${event.requestId}`, "Approval", status, current?.approval);
        break;
      }
      case "input.requested":
        { const activeTurnId = this.turnStartedAt.keys().next().value as string | undefined; this.upsert(`input:${event.requestId}`, "input", event.questions.map((question) => question.question).join("\n"), "Input required", "pending", undefined, activeTurnId ? { turnId: activeTurnId } : {}); }
        { const item = this.find(`input:${event.requestId}`); if (item) item.input = { requestId: event.requestId, questions: event.questions.map((question) => ({ ...question, options: question.options.map((option) => ({ ...option })) })) }; }
        break;
      case "input.answered": {
        const current = this.find(`input:${event.requestId}`); if (current) { current.status = "answered"; if (current.input) current.input.answers = { ...event.answers }; }
        break;
      }
      case "input.cancelled": { const current = this.find(`input:${event.requestId}`); if (current) current.status = "cancelled"; break; }
      case "turn.completed":
        this.activePrompt = undefined;
        for (const reasoning of this.reasoningItems.values()) {
          if (reasoning.turnId === event.turnId) reasoning.completed = true;
        }
        this.renderReasoning(event.turnId, new Date().toISOString());
        this.turnStartedAt.delete(event.turnId);
        break;
      case "agent.error":
        this.add("error", event.message, agentName);
        break;
      case "agent.started":
        this.add("system", `${agentName} connected`);
        break;
      case "agent.exited":
        this.add("error", `${agentName} exited${event.exitCode === null ? "" : ` with code ${event.exitCode}`}`);
        break;
      case "turn.started":
        this.turnStartedAt.set(event.turnId, new Date().toISOString());
        break;
    }
  }

  private addPrompt(prompt: QueuedPrompt): void {
    const id = `prompt:${prompt.promptId}`;
    if (!this.find(id)) this.upsert(id, "user", prompt.text, prompt.participantName, undefined, undefined, { timestamp: prompt.submittedAt });
  }

  private updateReasoning(turnId: string, itemId: string, text: string, completed: boolean): void {
    const current = this.reasoningItems.get(itemId);
    this.reasoningItems.set(itemId, {
      turnId,
      text: completed ? (text || current?.text || "") : `${current?.text ?? ""}${text}`,
      completed,
    });
    this.renderReasoning(turnId);
  }

  private renderReasoning(turnId: string, finishedAt?: string): void {
    const items = [...this.reasoningItems.values()].filter((item) => item.turnId === turnId);
    if (!items.length) return;
    const text = items.map((item) => item.text.trim()).filter(Boolean).join("\n\n");
    const startedAt = this.turnStartedAt.get(turnId);
    this.upsert(
      `reasoning:${turnId}`,
      "reasoning",
      text,
      "Thinking",
      items.every((item) => item.completed) ? "completed" : "running",
      undefined,
      {
        turnId,
        ...(startedAt ? { startedAt } : {}),
        ...(finishedAt ? { finishedAt } : {}),
      },
    );
  }

  private add(kind: TimelineKind, text: string, title?: string): void {
    this.upsert(`local:${Date.now()}:${Math.random()}`, kind, text, title);
  }

  private append(id: string, kind: TimelineKind, text: string, title?: string, status?: string): void {
    const current = this.find(id);
    this.upsert(id, kind, `${current?.text ?? ""}${text}`, title, status ?? current?.status);
  }

  private complete(id: string, kind: TimelineKind, text: string, title?: string): void {
    const current = this.find(id);
    this.upsert(id, kind, text || current?.text || "", title, "completed");
  }

  private find(id: string): TimelineItem | undefined {
    return this.timeline.find((item) => item.id === id);
  }

  private approvalText(event: Extract<AgentEvent, { type: "approval.requested" }>): string {
    const { command, cwd, reason } = this.approvalDetails(event);
    return [command ? `Command: ${command}` : undefined, cwd ? `Working directory: ${cwd}` : undefined, reason, !command && !cwd && !reason ? event.approvalKind : undefined].filter(Boolean).join("\n");
  }

  private approvalDetails(event: Extract<AgentEvent, { type: "approval.requested" }>): {
    command?: string;
    cwd?: string;
    reason?: string;
  } {
    const command = typeof event.details.command === "string" ? event.details.command : undefined;
    const cwd = typeof event.details.cwd === "string" ? event.details.cwd : undefined;
    const reason = typeof event.details.reason === "string" ? event.details.reason : undefined;
    return {
      ...(command ? { command } : {}),
      ...(cwd ? { cwd } : {}),
      ...(reason ? { reason } : {}),
    };
  }

  private upsert(id: string, kind: TimelineKind, text: string, title?: string, status?: string, approval?: TimelineItem["approval"], metadata?: TimelineMetadata): void {
    const current = this.find(id);
    if (current) {
      current.text = text;
      if (title) current.title = title;
      if (status) current.status = status;
      else delete current.status;
      if (approval) current.approval = { ...approval };
      if (metadata) Object.assign(current, metadata);
      return;
    }
    this.timeline.push({ id, kind, text, ...(title ? { title } : {}), ...(status ? { status } : {}), ...(approval ? { approval: { ...approval } } : {}), timestamp: metadata?.timestamp ?? new Date().toISOString(), ...metadata });
    if (this.timeline.length > maxTimelineItems) this.timeline.splice(0, this.timeline.length - maxTimelineItems);
  }
}
