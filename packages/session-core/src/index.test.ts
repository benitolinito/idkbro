import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createHostIdentity,
  decryptPayload,
  deriveRoomKey,
  encryptPayload,
  LocalIpcServer,
  loadOrCreateRoomSecret,
  loadOrCreateSessionEpoch,
  requestLocalIpc,
  roomSecret,
  signCapability,
  utf8,
  verifyCapability,
} from "./index.js";

describe("session utilities", () => {
  it("encrypts payloads with a room-epoch key", () => {
    const key = deriveRoomKey(roomSecret(), "room", "epoch");
    const encrypted = encryptPayload(key, utf8("secret source"), "room:event");
    expect(new TextDecoder().decode(decryptPayload(key, encrypted, "room:event"))).toBe("secret source");
    expect(() => decryptPayload(key, encrypted, "other:event")).toThrow();
  });

  it("keeps host authority distinct from the shared room key", () => {
    const identity = createHostIdentity();
    const capability = utf8(JSON.stringify({ roomId: "room", actorId: randomUUID(), role: "collaborator" }));
    expect(verifyCapability(identity.publicKey, capability, signCapability(identity, capability))).toBe(true);
  });

  it("persists room secrets and rejects configuration drift", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "multicode-session-identity-"));
    const epochFile = path.join(directory, "epoch");
    const secretFile = path.join(directory, "secret");
    const epoch = await loadOrCreateSessionEpoch(epochFile);
    const secret = await loadOrCreateRoomSecret(secretFile);
    expect(await loadOrCreateSessionEpoch(epochFile, epoch)).toBe(epoch);
    expect(await loadOrCreateRoomSecret(secretFile, secret)).toBe(secret);
    await expect(loadOrCreateSessionEpoch(epochFile, "different-epoch-value")).rejects.toThrow(/does not match/);
    await expect(loadOrCreateRoomSecret(secretFile, roomSecret())).rejects.toThrow(/does not match/);
  });
});

describe("authenticated room IPC", () => {
  it("accepts the private token and rejects another token", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "multicode-ipc-"));
    const socketPath = path.join(directory, "room.sock");
    const server = new LocalIpcServer("correct-token", async (payload) => ({ echo: payload }));
    await server.listen(socketPath);
    try {
      expect(await requestLocalIpc(socketPath, "correct-token", "hello")).toEqual({ echo: "hello" });
      await expect(requestLocalIpc(socketPath, "wrong-token", "hello")).rejects.toThrow(/Unauthorized/);
    } finally {
      await server.close();
    }
  });
});
