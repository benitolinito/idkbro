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
  z.object({
    type: z.literal("workspace.checkpoint.request"),
    sequence: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("collab.publish"),
    event: z.object({
      id: z.string().uuid(),
      kind: z.enum(["document.update", "presence.update", "agent.preview"]),
      payload: z.string().min(1).max(256 * 1024),
    }),
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

export const checkpointChunkBytes = 128 * 1024;
export const maxCheckpointBytes = 32 * 1024 * 1024;
export const maxCheckpointChunks = Math.ceil(maxCheckpointBytes / checkpointChunkBytes);

export const workspaceCheckpointDescriptorSchema = workspaceCheckpointSchema.omit({ bundle: true }).extend({
  bundleBytes: z.number().int().nonnegative().max(maxCheckpointBytes),
  bundleHash: z.string().regex(/^[a-f0-9]{64}$/),
  chunkCount: z.number().int().positive().max(maxCheckpointChunks),
});

export const workspaceCheckpointChunkSchema = z.object({
  sequence: z.number().int().positive(),
  index: z.number().int().nonnegative().max(maxCheckpointChunks - 1),
  data: z.string().min(1).max(Math.ceil(checkpointChunkBytes / 3) * 4),
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
    type: z.literal("relay.workspace.checkpoint.start"),
    checkpoint: workspaceCheckpointDescriptorSchema,
    targetParticipantId: z.string().min(1).max(128).optional(),
  }),
  z.object({
    type: z.literal("relay.workspace.checkpoint.chunk"),
    chunk: workspaceCheckpointChunkSchema,
    targetParticipantId: z.string().min(1).max(128).optional(),
  }),
  z.object({
    type: z.literal("relay.workspace.checkpoint.complete"),
    sequence: z.number().int().positive(),
    targetParticipantId: z.string().min(1).max(128).optional(),
  }),
  z.object({
    type: z.literal("relay.prompt.failed"),
    promptId: z.string().min(1),
    message: z.string().min(1).max(1_000),
  }),
  z.object({
    type: z.literal("relay.collab.event"),
    event: z.object({
      id: z.string().uuid(),
      kind: z.enum(["document.update", "presence.update", "agent.preview"]),
      payload: z.string().min(1).max(256 * 1024),
    }),
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

export interface WorkspaceCheckpointDescriptor {
  sequence: number;
  baseCommit: string;
  commit: string;
  ref: string;
  bundleBytes: number;
  bundleHash: string;
  chunkCount: number;
  createdAt: string;
}

export interface WorkspaceCheckpointChunk {
  sequence: number;
  index: number;
  data: string;
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
  | { type: "relay.workspace.checkpoint.start"; checkpoint: WorkspaceCheckpointDescriptor; targetParticipantId?: string }
  | { type: "relay.workspace.checkpoint.chunk"; chunk: WorkspaceCheckpointChunk; targetParticipantId?: string }
  | { type: "relay.workspace.checkpoint.complete"; sequence: number; targetParticipantId?: string }
  | { type: "relay.prompt.failed"; promptId: string; message: string }
  | { type: "relay.collab.event"; event: CollaborationEvent };

export interface CollaborationEvent {
  id: string;
  kind: "document.update" | "presence.update" | "agent.preview";
  payload: string;
}

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
      latestCheckpoint: WorkspaceCheckpointDescriptor | WorkspaceCheckpoint | null;
      collabHistory: CollaborationEvent[];
    }
  | { type: "participant.joined"; participant: RoomParticipant }
  | { type: "participant.left"; participantId: string; name: string }
  | { type: "prompt.queued"; prompt: QueuedPrompt; position: number }
  | { type: "prompt.started"; prompt: QueuedPrompt }
  | { type: "agent.event"; event: AgentEvent }
  | { type: "workspace.diff"; diff: WorkspaceDiff }
  | { type: "workspace.checkpoint"; checkpoint: WorkspaceCheckpoint }
  | { type: "workspace.checkpoint.start"; checkpoint: WorkspaceCheckpointDescriptor }
  | { type: "workspace.checkpoint.chunk"; chunk: WorkspaceCheckpointChunk }
  | { type: "workspace.checkpoint.complete"; sequence: number }
  | { type: "workspace.checkpoint.request"; participantId: string; sequence: number }
  | { type: "collab.event"; event: CollaborationEvent }
  | { type: "participant.synced"; participantId: string; sequence: number; commit: string }
  | { type: "room.error"; message: string; fatal?: boolean };

// Protocol v2 deliberately keeps routing metadata separate from encrypted payloads.
// Relays may validate limits and ordering without learning workspace content.
export const protocolVersion = 2 as const;
export const maxFrameBytes = 256 * 1024;

export const v2PayloadTypeSchema = z.enum([
  "session.hello", "session.welcome", "session.resume", "session.error", "session.goodbye",
  "member.joined", "member.left", "member.capability", "presence.update",
  "manifest.snapshot", "manifest.operation", "manifest.ack", "manifest.resync",
  "document.subscribe", "document.unsubscribe", "document.snapshot", "document.update", "document.ack", "document.resync",
  "agent.prompt", "agent.event", "agent.preview", "agent.completed", "agent.failed",
  "workspace.prepare", "workspace.part", "workspace.finalize", "workspace.abort", "workspace.proposal",
  "blob.chunk", "blob.complete",
]);

export const envelopeV2Schema = z.object({
  protocolVersion: z.literal(protocolVersion),
  roomId: z.string().min(1).max(128),
  sessionEpoch: z.string().min(16).max(256),
  messageId: z.string().uuid(),
  actorId: z.string().min(1).max(128),
  sequence: z.number().int().nonnegative().optional(),
  correlationId: z.string().uuid().optional(),
  payloadType: v2PayloadTypeSchema,
  payloadLength: z.number().int().nonnegative().max(maxFrameBytes).optional(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export type EnvelopeV2 = z.infer<typeof envelopeV2Schema>;
export type V2PayloadType = z.infer<typeof v2PayloadTypeSchema>;

export const binaryFrameHeaderSchema = envelopeV2Schema.extend({
  payloadLength: z.number().int().min(1).max(maxFrameBytes),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  chunkIndex: z.number().int().nonnegative(),
  chunkCount: z.number().int().positive().max(16_384),
});
export type BinaryFrameHeader = z.infer<typeof binaryFrameHeaderSchema>;

export interface BinaryFrame {
  header: BinaryFrameHeader;
  payload: Uint8Array;
}

export function encodeBinaryFrame(frame: BinaryFrame): Uint8Array {
  const header = binaryFrameHeaderSchema.parse(frame.header);
  if (frame.payload.byteLength !== header.payloadLength) throw new Error("Binary frame length does not match header");
  const encodedHeader = new TextEncoder().encode(JSON.stringify(header));
  if (encodedHeader.byteLength > 16_384) throw new Error("Binary frame header exceeds 16 KiB");
  const result = new Uint8Array(4 + encodedHeader.byteLength + frame.payload.byteLength);
  new DataView(result.buffer).setUint32(0, encodedHeader.byteLength);
  result.set(encodedHeader, 4);
  result.set(frame.payload, 4 + encodedHeader.byteLength);
  return result;
}

export function decodeBinaryFrame(value: Uint8Array): BinaryFrame {
  if (value.byteLength < 5) throw new Error("Binary frame is too short");
  const headerLength = new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(0);
  if (headerLength < 2 || headerLength > 16_384 || 4 + headerLength >= value.byteLength) throw new Error("Invalid binary frame header length");
  const header = binaryFrameHeaderSchema.parse(JSON.parse(new TextDecoder().decode(value.slice(4, 4 + headerLength))));
  const payload = value.slice(4 + headerLength);
  if (payload.byteLength !== header.payloadLength) throw new Error("Binary frame payload length does not match header");
  return { header, payload };
}

export function chunkBytes(payload: Uint8Array, chunkSize = maxFrameBytes): Uint8Array[] {
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > maxFrameBytes) throw new Error("Invalid chunk size");
  if (!payload.byteLength) return [new Uint8Array()];
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < payload.byteLength; offset += chunkSize) chunks.push(payload.slice(offset, offset + chunkSize));
  return chunks;
}
