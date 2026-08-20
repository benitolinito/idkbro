import type { AgentEvent, QueuedPrompt, RoomParticipant, RoomServerMessage } from "@multicode/protocol";

export type ConnectionState = "idle" | "starting" | "connected" | "stopping" | "error";
export type TimelineKind = "user" | "assistant" | "reasoning" | "command" | "diff" | "system" | "error" | "approval";

export interface TimelineItem {
  id: string;
  kind: TimelineKind;
  title?: string;
  text: string;
  status?: string;
  timestamp: string;
}

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
  queue: Array<{ id: string; name: string; text: string }>;
  activePrompt?: { id: string; name: string; text: string };
  timeline: TimelineItem[];
}

const maxTimelineItems = 300;

function promptView(prompt: QueuedPrompt) {
  return { id: prompt.promptId, name: prompt.participantName, text: prompt.text };
}

export class ChatModel {
  private connection: ConnectionState = "idle";
  private mode: "host" | "join" | undefined;
  private roomId: string | undefined;
  private roomLabel: string | undefined;
  private readonly participants = new Map<string, RoomParticipant>();
  private queue: QueuedPrompt[] = [];
  private activePrompt: QueuedPrompt | undefined;
  private readonly timeline: TimelineItem[] = [];

  start(mode: "host" | "join", roomLabel?: string): void {
    this.connection = "starting";
    this.mode = mode;
    this.roomId = undefined;
    this.roomLabel = roomLabel;
    this.participants.clear();
    this.queue = [];
    this.activePrompt = undefined;
    this.timeline.splice(0);
    this.add("system", mode === "host" ? "Starting a shared Codex room…" : "Joining the shared Codex room…");
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
    this.add("system", message);
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
        this.roomLabel ??= message.roomId;
        this.participants.clear();
        for (const participant of message.participants) this.participants.set(participant.id, participant);
        this.queue = [...message.queue];
        this.activePrompt = message.activePrompt ?? undefined;
        if (message.activePrompt) this.addPrompt(message.activePrompt);
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
      case "participant.synced": {
        const participant = this.participants.get(message.participantId);
        if (participant) this.participants.set(message.participantId, { ...participant, synced: true });
        break;
      }
      case "prompt.queued":
        if (!this.queue.some((prompt) => prompt.promptId === message.prompt.promptId)) this.queue.push(message.prompt);
        break;
      case "prompt.started":
        this.queue = this.queue.filter((prompt) => prompt.promptId !== message.prompt.promptId);
        this.activePrompt = message.prompt;
        this.addPrompt(message.prompt);
        break;
      case "agent.event":
        this.handleAgent(message.event);
        break;
      case "workspace.diff":
        this.upsert(`diff:${message.diff.revision}`, "diff", message.diff.text || "No tracked workspace changes.", "Workspace changes", message.diff.truncated ? "truncated" : undefined);
        break;
      case "workspace.checkpoint":
        this.add("system", `Workspace checkpoint ${message.checkpoint.sequence} · ${message.checkpoint.commit.slice(0, 12)}`);
        break;
      case "collab.event":
        break;
      case "room.error":
        this.fail(message.message);
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
      queue: this.queue.map(promptView),
      ...(this.activePrompt ? { activePrompt: promptView(this.activePrompt) } : {}),
      timeline: this.timeline.map((item) => ({ ...item })),
    };
  }

  private handleAgent(event: AgentEvent): void {
    switch (event.type) {
      case "agent.reasoning.delta":
        this.append(`reasoning:${event.itemId}`, "reasoning", event.text, "Thinking");
        break;
      case "agent.reasoning.completed":
        this.complete(`reasoning:${event.itemId}`, "reasoning", event.text, "Thinking");
        break;
      case "agent.message.delta":
        this.append(`message:${event.itemId}`, "assistant", event.text, "Codex");
        break;
      case "agent.message.completed":
        this.complete(`message:${event.itemId}`, "assistant", event.text, "Codex");
        break;
      case "command.started":
        this.upsert(`command:${event.itemId}`, "command", event.command, "Command", "running");
        break;
      case "command.output":
        this.append(`command:${event.itemId}`, "command", event.text, "Command", "running");
        break;
      case "command.exited":
        this.upsert(`command:${event.itemId}`, "command", event.output ?? this.find(`command:${event.itemId}`)?.text ?? "", "Command", event.exitCode === 0 ? "completed" : `exit ${event.exitCode ?? "unknown"}`);
        break;
      case "approval.requested":
        this.upsert(`approval:${event.requestId}`, "approval", "Interactive approval is not available yet. Approve or decline from the host when support is added.", "Approval required", "pending");
        break;
      case "turn.completed":
        this.activePrompt = undefined;
        this.add("system", `Turn completed${event.status ? ` · ${event.status}` : ""}`);
        break;
      case "agent.error":
        this.add("error", event.message, "Codex");
        break;
      case "agent.started":
        this.add("system", "Codex connected");
        break;
      case "agent.exited":
        this.add("error", `Codex exited${event.exitCode === null ? "" : ` with code ${event.exitCode}`}`);
        break;
      case "turn.started":
        break;
    }
  }

  private addPrompt(prompt: QueuedPrompt): void {
    const id = `prompt:${prompt.promptId}`;
    if (!this.find(id)) this.upsert(id, "user", prompt.text, prompt.participantName);
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

  private upsert(id: string, kind: TimelineKind, text: string, title?: string, status?: string): void {
    const current = this.find(id);
    if (current) {
      current.text = text;
      if (status) current.status = status;
      else delete current.status;
      return;
    }
    this.timeline.push({ id, kind, text, ...(title ? { title } : {}), ...(status ? { status } : {}), timestamp: new Date().toISOString() });
    if (this.timeline.length > maxTimelineItems) this.timeline.splice(0, this.timeline.length - maxTimelineItems);
  }
}
