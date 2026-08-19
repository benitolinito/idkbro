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

