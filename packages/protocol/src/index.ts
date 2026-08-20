import { z } from "zod";

export const actorTypeSchema = z.enum(["human", "agent", "system"]);

export const roomEventTypeSchema = z.enum([
  "room.created",
  "room.stopped",
  "participant.joined",
  "participant.left",
  "controller.claimed",
  "controller.transferred",
  "controller.expired",
  "prompt.proposed",
  "prompt.approved",
  "prompt.rejected",
  "prompt.sent",
  "agent.started",
  "agent.message.delta",
  "agent.message.completed",
  "agent.reasoning.delta",
  "agent.reasoning.completed",
  "agent.interrupted",
  "agent.exited",
  "turn.started",
  "turn.completed",
  "command.started",
  "command.output",
  "command.exited",
  "approval.requested",
  "approval.resolved",
  "file.changed",
  "diff.updated",
]);

export const roomEventSchema = z.object({
  eventId: z.string().min(1),
  roomId: z.string().min(1),
  sequenceNumber: z.number().int().nonnegative().nullable(),
  eventType: roomEventTypeSchema,
  actorId: z.string().min(1),
  actorType: actorTypeSchema,
  timestamp: z.string().datetime(),
  payload: z.record(z.string(), z.unknown()),
});

export const controllerActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("prompt.dispatch"),
    actionId: z.string().min(1),
    promptId: z.string().min(1),
    text: z.string().min(1),
    controllerId: z.string().min(1),
    controllerEpoch: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("agent.interrupt"),
    actionId: z.string().min(1),
    controllerId: z.string().min(1),
    controllerEpoch: z.number().int().positive(),
  }),
]);

export type ActorType = z.infer<typeof actorTypeSchema>;
export type RoomEventType = z.infer<typeof roomEventTypeSchema>;
export type RoomEvent = z.infer<typeof roomEventSchema>;
export type ControllerAction = z.infer<typeof controllerActionSchema>;

export interface AgentPrompt {
  promptId: string;
  text: string;
}

export type ApprovalDecision = "accept" | "decline" | "cancel";

export type AgentEvent =
  | { type: "agent.started"; threadId: string }
  | { type: "turn.started"; threadId: string; turnId: string }
  | { type: "turn.completed"; threadId: string; turnId: string; status?: string }
  | { type: "agent.message.delta"; threadId: string; turnId: string; itemId: string; text: string }
  | { type: "agent.message.completed"; threadId: string; turnId: string; itemId: string; text: string }
  | { type: "agent.reasoning.delta"; threadId: string; turnId: string; itemId: string; text: string }
  | { type: "agent.reasoning.completed"; threadId: string; turnId: string; itemId: string; text: string }
  | { type: "command.started"; threadId: string; turnId: string; itemId: string; command: string; cwd?: string }
  | { type: "command.output"; threadId: string; turnId: string; itemId: string; text: string }
  | { type: "command.exited"; threadId: string; turnId: string; itemId: string; exitCode: number | null; output?: string }
  | { type: "approval.requested"; requestId: string | number; approvalKind: string; details: Record<string, unknown> }
  | { type: "agent.error"; message: string }
  | { type: "agent.exited"; exitCode: number | null; signal: string | null };

export interface AgentStartOptions {
  cwd: string;
  model?: string;
}

export interface AgentAdapter {
  start(options: AgentStartOptions): Promise<{ threadId: string }>;
  sendPrompt(prompt: AgentPrompt): Promise<{ turnId: string }>;
  interrupt(): Promise<void>;
  resolveApproval(requestId: string | number, decision: ApprovalDecision): Promise<void>;
  events(): AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
}

export const roomClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("room.join"),
    token: z.string().min(1),
    name: z.string().trim().min(1).max(64),
  }),
  z.object({
    type: z.literal("prompt.submit"),
    promptId: z.string().min(1),
    text: z.string().trim().min(1).max(100_000),
  }),
  z.object({
    type: z.literal("workspace.ack"),
    sequence: z.number().int().positive(),
    commit: z.string().min(1).max(128),
  }),
]);

export type RoomClientMessage = z.infer<typeof roomClientMessageSchema>;

export const workspaceDiffSchema = z.object({
  revision: z.string().min(1),
  text: z.string().max(250_000),
  truncated: z.boolean(),
  createdAt: z.string().datetime(),
});

export const workspaceCheckpointSchema = z.object({
  sequence: z.number().int().positive(),
  baseCommit: z.string().min(1).max(128),
  commit: z.string().min(1).max(128),
  ref: z.string().min(1).max(256),
  bundle: z.string().min(1).max(32 * 1024 * 1024),
  createdAt: z.string().datetime(),
});

export const relayHostMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("relay.room.create"),
    name: z.string().trim().min(1).max(64),
  }),
  z.object({
    type: z.literal("prompt.submit"),
    promptId: z.string().min(1),
    text: z.string().trim().min(1).max(100_000),
  }),
  z.object({
    type: z.literal("relay.agent.event"),
    event: z.object({ type: z.string().min(1) }).passthrough(),
  }),
  z.object({
    type: z.literal("relay.workspace.diff"),
    diff: workspaceDiffSchema,
  }),
  z.object({
    type: z.literal("relay.workspace.checkpoint"),
    checkpoint: workspaceCheckpointSchema,
  }),
  z.object({
    type: z.literal("relay.prompt.failed"),
    promptId: z.string().min(1),
    message: z.string().min(1).max(1_000),
  }),
]);

export interface RoomParticipant {
  id: string;
  name: string;
  joinedAt: string;
  host: boolean;
  synced: boolean;
}

export interface QueuedPrompt {
  promptId: string;
  participantId: string;
  participantName: string;
  text: string;
  submittedAt: string;
}

export interface WorkspaceDiff {
  revision: string;
  text: string;
  truncated: boolean;
  createdAt: string;
}

export interface WorkspaceCheckpoint {
  sequence: number;
  baseCommit: string;
  commit: string;
  ref: string;
  bundle: string;
  createdAt: string;
}

export type RelayHostMessage =
  | {
      type: "relay.room.create";
      name: string;
    }
  | { type: "prompt.submit"; promptId: string; text: string }
  | { type: "relay.agent.event"; event: AgentEvent }
  | { type: "relay.workspace.diff"; diff: WorkspaceDiff }
  | { type: "relay.workspace.checkpoint"; checkpoint: WorkspaceCheckpoint }
  | { type: "relay.prompt.failed"; promptId: string; message: string };

export type RelayServerMessage =
  | RoomServerMessage
  | { type: "relay.room.created"; roomId: string; code: string };

export type RoomServerMessage =
  | {
      type: "room.welcome";
      roomId: string;
      selfId: string;
      participants: RoomParticipant[];
      activePrompt: QueuedPrompt | null;
      queue: QueuedPrompt[];
      latestDiff: WorkspaceDiff | null;
      latestCheckpoint: WorkspaceCheckpoint | null;
    }
  | { type: "participant.joined"; participant: RoomParticipant }
  | { type: "participant.left"; participantId: string; name: string }
  | { type: "prompt.queued"; prompt: QueuedPrompt; position: number }
  | { type: "prompt.started"; prompt: QueuedPrompt }
  | { type: "agent.event"; event: AgentEvent }
  | { type: "workspace.diff"; diff: WorkspaceDiff }
  | { type: "workspace.checkpoint"; checkpoint: WorkspaceCheckpoint }
  | { type: "participant.synced"; participantId: string; sequence: number; commit: string }
  | { type: "room.error"; message: string; fatal?: boolean };
