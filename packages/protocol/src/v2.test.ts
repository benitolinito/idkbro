import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  checkpointChunkBytes,
  chunkBytes,
  decodeBinaryFrame,
  encodeBinaryFrame,
  maxFrameBytes,
  protocolVersion,
  roomClientMessageSchema,
  workspaceCheckpointChunkSchema,
  workspaceCheckpointDescriptorSchema,
} from "./index.js";

describe("protocol v2 binary frames", () => {
  it("round-trips a bounded binary frame", () => {
    const payload = new TextEncoder().encode("shared document update");
    const frame = encodeBinaryFrame({
      header: { protocolVersion, roomId: "room", sessionEpoch: "e".repeat(16), messageId: randomUUID(), actorId: "ada", payloadType: "document.update", payloadLength: payload.length, payloadHash: createHash("sha256").update(payload).digest("hex"), chunkIndex: 0, chunkCount: 1 },
      payload,
    });
    expect(new TextDecoder().decode(decodeBinaryFrame(frame).payload)).toBe("shared document update");
  });

  it("splits large payloads without exceeding the frame quota", () => {
    const chunks = chunkBytes(new Uint8Array(maxFrameBytes * 2 + 1));
    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([maxFrameBytes, maxFrameBytes, 1]);
  });

  it("bounds checkpoint chunks and accepts explicit late-join requests", () => {
    expect(workspaceCheckpointDescriptorSchema.parse({
      sequence: 1,
      baseCommit: "base",
      commit: "checkpoint",
      ref: "refs/multicode/checkpoints/room",
      bundleBytes: checkpointChunkBytes,
      bundleHash: "a".repeat(64),
      chunkCount: 1,
      createdAt: new Date().toISOString(),
    }).chunkCount).toBe(1);
    expect(workspaceCheckpointChunkSchema.safeParse({ sequence: 1, index: 0, data: "a".repeat(checkpointChunkBytes * 2) }).success).toBe(false);
    expect(roomClientMessageSchema.parse({ type: "workspace.checkpoint.request", sequence: 1 }).type).toBe("workspace.checkpoint.request");
  });
});
