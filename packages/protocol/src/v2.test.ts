import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { chunkBytes, decodeBinaryFrame, encodeBinaryFrame, maxFrameBytes, protocolVersion } from "./index.js";

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
});
