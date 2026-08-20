import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { CollaborativeDocuments, createHostIdentity, decryptPayload, deriveRoomKey, encryptPayload, HostSession, roomSecret, signCapability, utf8, verifyCapability, type DurableJournal, type EncryptedPayload } from "./index.js";

describe("session cryptography", () => {
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
});

describe("collaborative documents", () => {
  it("converges Yjs updates across documents", () => {
    const first = new CollaborativeDocuments();
    const second = new CollaborativeDocuments();
    const text = first.document("file").getText("content");
    text.insert(0, "hello");
    second.apply("file", first.snapshot("file"));
    expect(second.document("file").getText("content").toString()).toBe("hello");
  });
});

describe("host session durability", () => {
  it("does not apply an update until its encrypted journal entry commits", async () => {
    const journal: DurableJournal = { append: async (envelope, payload: EncryptedPayload) => ({ roomId: envelope.roomId, sequence: 1, envelope: { ...envelope, sequence: 1 }, payload, createdAt: new Date().toISOString() }) };
    const session = new HostSession("room", "epoch", roomSecret(), journal);
    const source = new Y.Doc(); source.getText("content").insert(0, "durable");
    await session.applyDocumentUpdate("ada", "file", Y.encodeStateAsUpdate(source));
    expect(session.documents.document("file").getText("content").toString()).toBe("durable");
  });
});

describe("encrypted collaboration payloads", () => {
  it("cannot be decrypted with another room secret", () => {
    const first = deriveRoomKey(roomSecret(), "room", "epoch");
    const second = deriveRoomKey(roomSecret(), "room", "epoch");
    const payload = encryptPayload(first, utf8("Yjs update"), "room:message");
    expect(new TextDecoder().decode(decryptPayload(first, payload, "room:message"))).toBe("Yjs update");
    expect(() => decryptPayload(second, payload, "room:message")).toThrow();
  });
});
