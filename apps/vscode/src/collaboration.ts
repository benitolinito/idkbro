import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import WebSocket from "ws";
import * as Y from "yjs";
import type { AgentEvent, QueuedPrompt, RoomServerMessage } from "@multicode/protocol";

interface EncryptedUpdate { file: string; nonce: string; tag: string; ciphertext: string; }
const maxCollaborativeTextBytes = 96 * 1024;
const execFileAsync = promisify(execFile);
interface CollaborationWireEvent {
  kind: string;
  payload: string;
  actorId?: string | undefined;
  transactionId?: string | undefined;
  partIndex?: number | undefined;
  partCount?: number | undefined;
}

export class CollaborationBridge implements vscode.Disposable {
  private readonly statusChanged = new vscode.EventEmitter<"connecting" | "connected" | "reconnecting" | "disconnected">();
  readonly onDidChangeStatus = this.statusChanged.event;
  private socket: WebSocket | undefined;
  private readonly docs = new Map<string, Y.Doc>();
  private readonly readyDocuments = new Set<string>();
  private readonly subscribedDocuments = new Set<string>();
  private readonly pendingLocalText = new Map<string, string>();
  private readonly documentIdentity = new Map<string, { fileId: string; documentEpoch: number }>();
  private readonly suppressed = new Set<string>();
  private readonly disposables: vscode.Disposable[];
  private readonly presenceDecorations = new Map<string, vscode.TextEditorDecorationType>();
  private readonly presenceExpiry = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly participantNames = new Map<string, string>();
  private readonly previewOutput = vscode.window.createOutputChannel("MultiCode Preview");
  private readonly previewChanged = new vscode.EventEmitter<vscode.Uri>();
  private readonly previewUri = vscode.Uri.parse("multicode-preview:/Codex changes.patch");
  private previewText = "Codex has not produced a preview yet.";
  private readonly proposalChanged = new vscode.EventEmitter<vscode.Uri>();
  private readonly proposalUri = vscode.Uri.parse("multicode-proposal:/Pending Codex proposal.patch");
  private proposalText = "There is no pending Codex proposal.";
  private key: Buffer | undefined;
  private promptKey: Buffer | undefined;
  private relayUrl = "";
  private inviteToken = "";
  private displayName = "";
  private requestedRole: "viewer" | "editor" = "editor";
  private canEdit = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private applyingRemoteManifest = 0;
  private latestPreviewRevision = 0;
  private latestPreviewTurn = "";
  private welcomed = false;
  private selfId = "";
  private readonly workspaceTransactions = new Map<string, { partCount: number; parts: Map<number, CollaborationWireEvent>; timer: ReturnType<typeof setTimeout> }>();
  private readonly externalChangeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly recentStructuralPaths = new Map<string, number>();
  private readonly ignoredPaths = new Map<string, boolean>();

  constructor(private readonly onRoomMessage?: (message: RoomServerMessage) => void) {
    const diskWatcher = vscode.workspace.createFileSystemWatcher("**/*");
    this.disposables = [
      diskWatcher,
      this.previewChanged,
      this.proposalChanged,
      vscode.workspace.registerTextDocumentContentProvider("multicode-preview", { onDidChange: this.previewChanged.event, provideTextDocumentContent: () => this.previewText }),
      vscode.workspace.registerTextDocumentContentProvider("multicode-proposal", { onDidChange: this.proposalChanged.event, provideTextDocumentContent: () => this.proposalText }),
      diskWatcher.onDidChange((uri) => this.scheduleExternalChange(uri)),
      diskWatcher.onDidCreate((uri) => this.scheduleExternalStructure("create", uri)),
      diskWatcher.onDidDelete((uri) => this.scheduleExternalStructure("delete", uri)),
      vscode.workspace.onDidChangeTextDocument((event) => void this.localChange(event)),
      vscode.workspace.onDidOpenTextDocument((document) => this.subscribe(document)),
      vscode.workspace.onDidCloseTextDocument((document) => {
        const file = this.file(document);
        if (file) this.subscribedDocuments.delete(file);
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => this.publishPresence(event.textEditor.document, event.selections)),
      vscode.workspace.onDidCreateFiles((event) => { for (const file of event.files) { this.markStructural(file); void this.publishCreate(file); } }),
      vscode.workspace.onDidRenameFiles((event) => { if (!this.applyingRemoteManifest) for (const file of event.files) { this.markStructural(file.oldUri); this.markStructural(file.newUri); void this.publishRename(file.oldUri, file.newUri); } }),
      vscode.workspace.onDidDeleteFiles((event) => { if (!this.applyingRemoteManifest) for (const file of event.files) { this.markStructural(file); const filePath = this.relativeFile(file); if (filePath) void this.isIgnored(filePath).then((ignored) => { if (!ignored) this.publishManifestOperation({ type: "delete", path: filePath }); }); } }),
    ];
  }

  connect(relayUrl: string, inviteToken: string, name: string, requestedRole: "viewer" | "editor" = "editor"): void {
    if (
      this.relayUrl === relayUrl
      && this.inviteToken === inviteToken
      && this.displayName === name
      && this.requestedRole === requestedRole
      && (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING)
    ) return;

    const localBuffers = requestedRole === "viewer" ? [] : vscode.workspace.textDocuments.flatMap((document) => {
      const file = this.file(document);
      return file ? [[file, document.getText()] as const] : [];
    });
    this.disconnect();
    for (const [file, contents] of localBuffers) this.pendingLocalText.set(file, contents);
    this.relayUrl = relayUrl; this.inviteToken = inviteToken; this.displayName = name; this.requestedRole = requestedRole; this.canEdit = requestedRole === "editor";
    this.latestPreviewRevision = 0; this.latestPreviewTurn = ""; this.welcomed = false;
    this.statusChanged.fire("connecting");
    const [code, secret] = inviteToken.split(".", 2);
    if (!code || !secret) throw new Error("Invalid MultiCode room token");
    this.key = Buffer.from(hkdfSync("sha256", Buffer.from(secret, "base64url"), Buffer.from(code), Buffer.from("multicode/v2/editor"), 32));
    this.promptKey = Buffer.from(hkdfSync("sha256", Buffer.from(secret, "base64url"), Buffer.from(code.replace(/-/g, "").toUpperCase()), Buffer.from("multicode/v2/transport"), 32));
    const base = new URL(relayUrl); base.pathname = `${base.pathname.replace(/\/$/, "")}/rooms/${code}`;
    const socket = new WebSocket(base);
    this.socket = socket;
    socket.on("open", () => { this.statusChanged.fire("connected"); socket.send(JSON.stringify({ type: "room.join", token: code, name, requestedRole })); });
    socket.on("message", (data) => void this.receive(data.toString()));
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (this.inviteToken) {
        this.statusChanged.fire("reconnecting");
        this.reconnectTimer = setTimeout(() => this.connect(this.relayUrl, this.inviteToken, this.displayName, this.requestedRole), 5_000);
      }
    });
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const socket = this.socket; this.socket = undefined; this.key = undefined; this.promptKey = undefined; this.inviteToken = ""; this.welcomed = false;
    for (const doc of this.docs.values()) doc.destroy();
    this.docs.clear(); this.readyDocuments.clear(); this.subscribedDocuments.clear(); this.pendingLocalText.clear(); this.documentIdentity.clear();
    for (const actorId of [...this.presenceDecorations.keys()]) this.clearPresence(actorId);
    this.participantNames.clear();
    for (const transaction of this.workspaceTransactions.values()) clearTimeout(transaction.timer); this.workspaceTransactions.clear();
    for (const timer of this.externalChangeTimers.values()) clearTimeout(timer); this.externalChangeTimers.clear();
    this.selfId = "";
    this.statusChanged.fire("disconnected");
    socket?.close();
  }
  dispose(): void { this.disconnect(); this.statusChanged.dispose(); for (const decoration of this.presenceDecorations.values()) decoration.dispose(); this.presenceDecorations.clear(); this.previewOutput.dispose(); for (const disposable of this.disposables) disposable.dispose(); }
  async showPreview(): Promise<void> { await vscode.window.showTextDocument(this.previewUri, { preview: false, viewColumn: vscode.ViewColumn.Beside }); }
  async showProposal(): Promise<void> { await vscode.window.showTextDocument(this.proposalUri, { preview: false, viewColumn: vscode.ViewColumn.Beside }); }
  sendPrompt(text: string): boolean {
    if (!this.promptKey || this.socket?.readyState !== WebSocket.OPEN) return false;
    const promptId = crypto.randomUUID(); const nonce = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", this.promptKey, nonce); cipher.setAAD(Buffer.from(`prompt:${promptId}`)); const ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    const sealed = JSON.stringify({ version: 1, nonce: nonce.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") });
    this.socket.send(JSON.stringify({ type: "prompt.submit", promptId, text: sealed })); return true;
  }

  private file(document: vscode.TextDocument): string | undefined {
    return this.relativeFile(document.uri);
  }
  private relativeFile(uri: vscode.Uri): string | undefined {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root || uri.scheme !== "file") return undefined;
    const relative = path.relative(root, uri.fsPath).split(path.sep).join("/");
    return !relative || relative.startsWith("../") || path.posix.isAbsolute(relative) ? undefined : relative;
  }
  private document(file: string): Y.Doc {
    let doc = this.docs.get(file);
    if (!doc) { doc = new Y.Doc(); this.docs.set(file, doc); }
    return doc;
  }
  private async localChange(event: vscode.TextDocumentChangeEvent): Promise<void> {
    const file = this.file(event.document); if (!file || this.suppressed.has(file)) return;
    if (await this.isIgnored(file)) return;
    if (!this.canEdit) { const doc = this.docs.get(file); if (doc) await this.renderDocument(file, doc.getText("content").toString()); return; }
    if (!this.readyDocuments.has(file)) {
      this.pendingLocalText.set(file, event.document.getText());
      this.subscribe(event.document);
      return;
    }
    if (!this.key || this.socket?.readyState !== WebSocket.OPEN) {
      this.pendingLocalText.set(file, event.document.getText());
      return;
    }
    const doc = this.document(file); const text = doc.getText("content");
    let update: Uint8Array | undefined;
    const listener = (value: Uint8Array) => { update = value; }; doc.on("update", listener);
    doc.transact(() => {
      for (const change of [...event.contentChanges].sort((left, right) => right.rangeOffset - left.rangeOffset)) {
        if (change.rangeLength) text.delete(change.rangeOffset, change.rangeLength);
        if (change.text) text.insert(change.rangeOffset, change.text);
      }
    }, "local");
    doc.off("update", listener);
    if (!update) return;
    this.sendDocumentUpdate(file, update);
  }
  private async receive(raw: string): Promise<void> {
    const message = JSON.parse(raw) as RoomServerMessage;
    this.notifyRoomMessage(message);
    if (message.type === "room.welcome") {
      this.selfId = message.selfId ?? "";
      for (const participant of message.participants ?? []) this.participantNames.set(participant.id, participant.name);
      if (Array.isArray((message as any).collabHistory)) for (const event of (message as any).collabHistory) await this.applyEvent(event);
      this.welcomed = true;
      for (const document of vscode.workspace.textDocuments) this.subscribe(document);
      return;
    }
    if (message.type === "participant.joined" && message.participant) { this.participantNames.set(message.participant.id, message.participant.name); return; }
    if (message.type === "participant.capabilities" && message.participantId === this.selfId) { this.canEdit = message.capabilities?.includes("editor") ?? false; if (!this.canEdit) this.resynchronizeOpenDocuments(); return; }
    if (message.type === "participant.left" && message.participantId) { this.clearPresence(message.participantId); this.participantNames.delete(message.participantId); return; }
    if (message.type === "room.error" && message.message?.startsWith("Collaboration update rejected:")) { this.resynchronizeOpenDocuments(); return; }
    if (message.type !== "collab.event" || !message.event || !this.key) return;
    await this.applyEvent(message.event);
  }
  private notifyRoomMessage(message: RoomServerMessage): void {
    if (!this.onRoomMessage) return;
    if (message.type === "agent.encrypted") {
      if (!this.promptKey) return;
      try {
        const event = JSON.parse(new TextDecoder().decode(this.openTransport(message.payload))) as AgentEvent;
        this.onRoomMessage({ type: "agent.event", event });
      } catch { /* Ignore malformed or stale encrypted agent output. */ }
      return;
    }
    if (!this.promptKey) { this.onRoomMessage(message); return; }
    try {
      if (message.type === "prompt.queued" || message.type === "prompt.started") {
        this.onRoomMessage({ ...message, prompt: this.openPrompt(message.prompt) });
        return;
      }
      if (message.type === "room.welcome") {
        this.onRoomMessage({
          ...message,
          activePrompt: message.activePrompt ? this.openPrompt(message.activePrompt) : null,
          queue: message.queue.map((prompt) => this.openPrompt(prompt)),
        });
        return;
      }
      this.onRoomMessage(message);
    } catch { /* Do not expose ciphertext in the shared conversation if decryption fails. */ }
  }
  private openPrompt(prompt: QueuedPrompt): QueuedPrompt {
    return { ...prompt, text: new TextDecoder().decode(this.openTransport(prompt.text, `prompt:${prompt.promptId}`)) };
  }
  private openTransport(sealed: string, aad?: string): Uint8Array {
    const value = JSON.parse(sealed) as { version?: unknown; nonce?: unknown; tag?: unknown; ciphertext?: unknown };
    if (value.version !== 1 || typeof value.nonce !== "string" || typeof value.tag !== "string" || typeof value.ciphertext !== "string") throw new Error("Invalid encrypted transport payload");
    const decipher = createDecipheriv("aes-256-gcm", this.promptKey as Buffer, Buffer.from(value.nonce, "base64url"));
    if (aad) decipher.setAAD(new TextEncoder().encode(aad));
    decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
    return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64url")), decipher.final()]));
  }
  private async applyEvent(event: CollaborationWireEvent): Promise<void> {
    if (!this.key) return;
    if (event.kind === "workspace.commit.prepare") { this.prepareWorkspaceTransaction(event); return; }
    if (event.kind === "workspace.commit.finalize") { await this.finalizeWorkspaceTransaction(event); return; }
    if (event.transactionId !== undefined) {
      if (event.partIndex === undefined || event.partCount === undefined) throw new Error("Invalid workspace transaction part");
      const transaction = this.workspaceTransactions.get(event.transactionId) ?? this.createWorkspaceTransaction(event.transactionId, event.partCount);
      if (transaction.partCount !== event.partCount) throw new Error("Workspace transaction part count changed");
      transaction.parts.set(event.partIndex, event); return;
    }
    if (event.kind === "presence.update") { if (event.actorId && event.actorId !== this.selfId) this.applyPresence(event.actorId, event.payload); return; }
    if (event.kind === "agent.preview") {
      const encrypted = JSON.parse(Buffer.from(event.payload, "base64url").toString()) as EncryptedUpdate;
      if (encrypted.file !== "__preview__") throw new Error("Invalid agent preview");
      const preview = JSON.parse(Buffer.from(this.decrypt(encrypted)).toString()) as { turnId: string; revision: number; diff: { text: string } };
      if (preview.turnId === this.latestPreviewTurn && preview.revision <= this.latestPreviewRevision) return;
      this.latestPreviewTurn = preview.turnId; this.latestPreviewRevision = preview.revision;
      this.previewText = `# Preview — not merged\n# Turn ${preview.turnId} · revision ${preview.revision}\n\n${preview.diff.text || "No changed files."}`;
      this.previewChanged.fire(this.previewUri); void vscode.commands.executeCommand("setContext", "multicode.hasPreview", true);
      this.previewOutput.clear(); this.previewOutput.append(preview.diff.text); return;
    }
    if (event.kind === "agent.proposal") {
      const encrypted = JSON.parse(Buffer.from(event.payload, "base64url").toString()) as EncryptedUpdate;
      if (encrypted.file !== "__proposal__") throw new Error("Invalid agent proposal");
      const proposal = JSON.parse(Buffer.from(this.decrypt(encrypted)).toString()) as { turnId: string; patchText: string; truncated?: boolean };
      this.proposalText = `# Pending Codex proposal — not merged\n# Turn ${proposal.turnId}${proposal.truncated ? " · preview truncated" : ""}\n\n${proposal.patchText}`;
      this.proposalChanged.fire(this.proposalUri); void vscode.commands.executeCommand("setContext", "multicode.hasProposal", true); return;
    }
    if (event.kind === "manifest.operation") { await this.applyManifestEvent(event.payload); return; }
    if (event.kind === "document.snapshot") { await this.applyDocumentSnapshot(event.payload); return; }
    if (event.kind !== "document.update") return;
    const encrypted = JSON.parse(Buffer.from(event.payload, "base64url").toString()) as EncryptedUpdate;
    if (encrypted.file !== "__document__") throw new Error("Invalid document update");
    const value = JSON.parse(Buffer.from(this.decrypt(encrypted)).toString()) as { file?: unknown; fileId?: unknown; documentEpoch?: unknown; update?: unknown };
    if (typeof value.file !== "string" || typeof value.fileId !== "string" || typeof value.documentEpoch !== "number" || typeof value.update !== "string") throw new Error("Invalid document update");
    if (!this.readyDocuments.has(value.file)) { this.subscribeFile(value.file); return; }
    const identity = this.documentIdentity.get(value.file);
    if (!identity || identity.fileId !== value.fileId || identity.documentEpoch !== value.documentEpoch) {
      this.readyDocuments.delete(value.file); this.subscribedDocuments.delete(value.file); this.subscribeFile(value.file); return;
    }
    const update = Buffer.from(value.update, "base64url"); const doc = this.document(value.file);
    Y.applyUpdate(doc, update, "remote");
    await this.renderDocument(value.file, doc.getText("content").toString());
  }
  private subscribe(document: vscode.TextDocument): void {
    const file = this.file(document);
    if (!file || /(^|\/)(\.git|node_modules|dist|build|\.cache|coverage)(\/|$)/.test(file) || /(^|\/)\.env(?:\.|$)/.test(file) || /(^|\/)(id_(rsa|dsa|ecdsa|ed25519)|[^/]*\.(pem|key|p12|pfx))$/i.test(file)) return;
    void this.isIgnored(file).then((ignored) => { if (!ignored) this.subscribeFile(file); });
  }
  private subscribeFile(file: string): void {
    if (!this.welcomed || this.subscribedDocuments.has(file) || !this.key || this.socket?.readyState !== WebSocket.OPEN) return;
    this.subscribedDocuments.add(file);
    const payload = Buffer.from(JSON.stringify(this.encrypt("__control__", new TextEncoder().encode(JSON.stringify({ file }))))).toString("base64url");
    this.socket.send(JSON.stringify({ type: "collab.publish", event: { id: crypto.randomUUID(), kind: "document.subscribe", payload } }));
  }
  private async applyDocumentSnapshot(payload: string): Promise<void> {
    const encrypted = JSON.parse(Buffer.from(payload, "base64url").toString()) as EncryptedUpdate;
    if (encrypted.file !== "__snapshot__") throw new Error("Invalid document snapshot");
    const snapshot = JSON.parse(Buffer.from(this.decrypt(encrypted)).toString()) as { file?: unknown; fileId?: unknown; documentEpoch?: unknown; update?: unknown };
    if (typeof snapshot.file !== "string" || typeof snapshot.fileId !== "string" || typeof snapshot.documentEpoch !== "number" || typeof snapshot.update !== "string") throw new Error("Invalid document snapshot");
    const old = this.docs.get(snapshot.file); old?.destroy();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(snapshot.update, "base64url"), "snapshot");
    this.docs.set(snapshot.file, doc); this.readyDocuments.add(snapshot.file); this.subscribedDocuments.add(snapshot.file);
    this.documentIdentity.set(snapshot.file, { fileId: snapshot.fileId, documentEpoch: snapshot.documentEpoch });
    const canonical = doc.getText("content").toString();
    const pending = this.pendingLocalText.get(snapshot.file);
    this.pendingLocalText.delete(snapshot.file);
    if (pending !== undefined && pending !== canonical) {
      let update: Uint8Array | undefined;
      const listener = (value: Uint8Array) => { update = value; };
      doc.on("update", listener);
      doc.transact(() => {
        const text = doc.getText("content");
        text.delete(0, text.length);
        if (pending) text.insert(0, pending);
      }, "pending-local");
      doc.off("update", listener);
      if (update) this.sendDocumentUpdate(snapshot.file, update);
      return;
    }
    if (pending === undefined) await this.renderDocument(snapshot.file, canonical);
  }
  private sendDocumentUpdate(file: string, update: Uint8Array): void {
    if (!this.key || this.socket?.readyState !== WebSocket.OPEN) return;
    const identity = this.documentIdentity.get(file);
    if (!identity) { this.readyDocuments.delete(file); this.subscribedDocuments.delete(file); this.subscribeFile(file); return; }
    const plaintext = new TextEncoder().encode(JSON.stringify({ file, ...identity, update: Buffer.from(update).toString("base64url") }));
    const payload = Buffer.from(JSON.stringify(this.encrypt("__document__", plaintext))).toString("base64url");
    this.socket.send(JSON.stringify({ type: "collab.publish", event: { id: crypto.randomUUID(), kind: "document.update", payload } }));
  }
  private async renderDocument(file: string, contents: string): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri; if (!root) return;
    const uri = vscode.Uri.joinPath(root, ...file.split("/"));
    const open = await vscode.workspace.openTextDocument(uri);
    if (open.getText() === contents) { if (open.isDirty) await open.save(); return; }
    this.suppressed.add(file);
    try {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(open.positionAt(0), open.positionAt(open.getText().length)), contents);
      if (!await vscode.workspace.applyEdit(edit)) throw new Error(`Could not apply collaborative update to ${file}`);
      await open.save();
    }
    finally { this.suppressed.delete(file); }
  }
  private resynchronizeOpenDocuments(): void {
    for (const document of vscode.workspace.textDocuments) {
      const file = this.file(document);
      if (file) this.pendingLocalText.set(file, document.getText());
    }
    for (const doc of this.docs.values()) doc.destroy();
    this.docs.clear(); this.readyDocuments.clear(); this.subscribedDocuments.clear(); this.documentIdentity.clear();
    for (const document of vscode.workspace.textDocuments) this.subscribe(document);
  }
  private prepareWorkspaceTransaction(event: CollaborationWireEvent): void {
    const encrypted = JSON.parse(Buffer.from(event.payload, "base64url").toString()) as EncryptedUpdate;
    if (encrypted.file !== "__transaction__") throw new Error("Invalid workspace transaction");
    const metadata = JSON.parse(Buffer.from(this.decrypt(encrypted)).toString()) as { transactionId?: unknown; partCount?: unknown };
    if (typeof metadata.transactionId !== "string" || !Number.isInteger(metadata.partCount) || (metadata.partCount as number) < 1) throw new Error("Invalid workspace transaction");
    this.createWorkspaceTransaction(metadata.transactionId, metadata.partCount as number);
  }
  private createWorkspaceTransaction(transactionId: string, partCount: number): { partCount: number; parts: Map<number, CollaborationWireEvent>; timer: ReturnType<typeof setTimeout> } {
    const existing = this.workspaceTransactions.get(transactionId); if (existing) return existing;
    const transaction = { partCount, parts: new Map<number, CollaborationWireEvent>(), timer: setTimeout(() => { this.workspaceTransactions.delete(transactionId); this.resynchronizeOpenDocuments(); }, 15_000) };
    this.workspaceTransactions.set(transactionId, transaction); return transaction;
  }
  private async finalizeWorkspaceTransaction(event: CollaborationWireEvent): Promise<void> {
    const encrypted = JSON.parse(Buffer.from(event.payload, "base64url").toString()) as EncryptedUpdate;
    if (encrypted.file !== "__transaction__") throw new Error("Invalid workspace transaction finalize");
    const metadata = JSON.parse(Buffer.from(this.decrypt(encrypted)).toString()) as { transactionId?: unknown; partCount?: unknown };
    if (typeof metadata.transactionId !== "string" || !Number.isInteger(metadata.partCount)) throw new Error("Invalid workspace transaction finalize");
    const transaction = this.workspaceTransactions.get(metadata.transactionId);
    if (!transaction || transaction.partCount !== metadata.partCount || transaction.parts.size !== transaction.partCount) { this.resynchronizeOpenDocuments(); return; }
    clearTimeout(transaction.timer); this.workspaceTransactions.delete(metadata.transactionId);
    for (let index = 0; index < transaction.partCount; index += 1) {
      const part = transaction.parts.get(index); if (!part) { this.resynchronizeOpenDocuments(); return; }
      const { transactionId: _transactionId, partIndex: _partIndex, partCount: _partCount, ...committed } = part;
      await this.applyEvent(committed);
    }
  }
  private encrypt(file: string, update: Uint8Array): EncryptedUpdate {
    const nonce = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", this.key as Buffer, nonce); const ciphertext = Buffer.concat([cipher.update(update), cipher.final()]);
    return { file, nonce: nonce.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") };
  }
  private async publishCreate(uri: vscode.Uri): Promise<void> {
    if (this.applyingRemoteManifest || !this.canEdit) return;
    const file = this.relativeFile(uri); if (!file) return;
    if (await this.isIgnored(file)) return;
    try {
      const contents = await vscode.workspace.fs.readFile(uri);
      if (contents.byteLength > maxCollaborativeTextBytes) return;
      this.publishManifestOperation({ type: "create", path: file, content: new TextDecoder("utf-8", { fatal: true }).decode(contents) });
    } catch { /* Binary, oversized, or transient files are outside the first-release manifest. */ }
  }
  private async publishRename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    const sourcePath = this.relativeFile(oldUri); const destinationPath = this.relativeFile(newUri); if (!sourcePath || !destinationPath) return;
    const [sourceIgnored, destinationIgnored] = await Promise.all([this.isIgnored(sourcePath), this.isIgnored(destinationPath)]);
    if (sourceIgnored && destinationIgnored) return;
    if (sourceIgnored) { await this.publishCreate(newUri); return; }
    if (destinationIgnored) { this.publishManifestOperation({ type: "delete", path: sourcePath }); return; }
    this.publishManifestOperation({ type: "rename", sourcePath, destinationPath });
  }
  private scheduleExternalChange(uri: vscode.Uri): void {
    if (this.applyingRemoteManifest) return;
    const file = this.relativeFile(uri); if (!file || /(^|\/)(\.git|node_modules|dist|build|\.cache|coverage)(\/|$)/.test(file) || /(^|\/)\.env(?:\.|$)/.test(file)) return;
    if (path.posix.basename(file) === ".gitignore") this.ignoredPaths.clear();
    const existing = this.externalChangeTimers.get(file); if (existing) clearTimeout(existing);
    this.externalChangeTimers.set(file, setTimeout(() => { this.externalChangeTimers.delete(file); void this.importExternalChange(uri, file); }, 150));
  }
  private markStructural(uri: vscode.Uri): void { const file = this.relativeFile(uri); if (file) this.recentStructuralPaths.set(file, Date.now() + 1_000); }
  private scheduleExternalStructure(operation: "create" | "delete", uri: vscode.Uri): void {
    if (this.applyingRemoteManifest) return;
    const file = this.relativeFile(uri); if (!file) return;
    setTimeout(() => {
      const expires = this.recentStructuralPaths.get(file) ?? 0;
      if (expires >= Date.now()) return;
      this.recentStructuralPaths.delete(file);
      void this.isIgnored(file).then((ignored) => { if (ignored) return; if (operation === "create") void this.publishCreate(uri); else this.publishManifestOperation({ type: "delete", path: file }); });
    }, 250);
  }
  private async importExternalChange(uri: vscode.Uri, file: string): Promise<void> {
    try {
      if (await this.isIgnored(file)) return;
      if (!this.canEdit) { const doc = this.docs.get(file); if (doc) await this.renderDocument(file, doc.getText("content").toString()); return; }
      const open = vscode.workspace.textDocuments.find((document) => this.file(document) === file);
      if (open?.isDirty) { void vscode.window.showWarningMessage(`MultiCode did not import an external write to ${file} because the editor has unsaved changes.`); return; }
      const bytes = await vscode.workspace.fs.readFile(uri); if (bytes.byteLength > maxCollaborativeTextBytes) return;
      const contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!this.readyDocuments.has(file)) { this.pendingLocalText.set(file, contents); this.subscribeFile(file); return; }
      const doc = this.document(file); const text = doc.getText("content"); if (text.toString() === contents) return;
      let update: Uint8Array | undefined; const listener = (value: Uint8Array) => { update = value; }; doc.on("update", listener);
      doc.transact(() => { text.delete(0, text.length); if (contents) text.insert(0, contents); }, "external"); doc.off("update", listener);
      if (update) this.sendDocumentUpdate(file, update);
    } catch { /* Ignore transient, binary, deleted, and unsupported external writes. */ }
  }
  private async isIgnored(file: string): Promise<boolean> {
    if (/(^|\/)(\.git|node_modules|dist|build|\.cache|coverage)(\/|$)/.test(file) || /(^|\/)\.env(?:\.|$)/.test(file) || /(^|\/)(id_(rsa|dsa|ecdsa|ed25519)|[^/]*\.(pem|key|p12|pfx))$/i.test(file)) return true;
    const cached = this.ignoredPaths.get(file); if (cached !== undefined) return cached;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; if (!root) return true;
    try { await execFileAsync("git", ["-C", root, "check-ignore", "-q", "--", file]); this.ignoredPaths.set(file, true); return true; }
    catch (error) { const ignored = (error as NodeJS.ErrnoException & { code?: number }).code === 1 ? false : true; this.ignoredPaths.set(file, ignored); return ignored; }
  }
  private async applyManifestEvent(payload: string): Promise<void> {
    const encrypted = JSON.parse(Buffer.from(payload, "base64url").toString()) as EncryptedUpdate;
    if (encrypted.file !== "__manifest__") throw new Error("Invalid manifest event");
    const operation = JSON.parse(Buffer.from(this.decrypt(encrypted)).toString()) as
      | { type: "create"; path: string; content: string }
      | { type: "rename"; sourcePath: string; destinationPath: string }
      | { type: "delete"; path: string };
    const root = vscode.workspace.workspaceFolders?.[0]?.uri; if (!root) return;
    const roomUri = (file: string): vscode.Uri => {
      if (!file || file.includes("\\") || path.posix.normalize(file) !== file || file.startsWith("../") || path.posix.isAbsolute(file)) throw new Error("Invalid manifest path");
      return vscode.Uri.joinPath(root, ...file.split("/"));
    };
    this.applyingRemoteManifest += 1;
    try {
      if (operation.type === "create") {
        const destination = roomUri(operation.path); this.markStructural(destination); await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(destination, ".."));
        await vscode.workspace.fs.writeFile(destination, new TextEncoder().encode(operation.content));
      }
      else if (operation.type === "rename") {
        const source = roomUri(operation.sourcePath); const destination = roomUri(operation.destinationPath); this.markStructural(source); this.markStructural(destination); await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(destination, ".."));
        await vscode.workspace.fs.rename(source, destination, { overwrite: false });
      }
      else if (operation.type === "delete") { const target = roomUri(operation.path); this.markStructural(target); await vscode.workspace.fs.delete(target, { recursive: false, useTrash: false }); }
      else throw new Error("Unsupported manifest operation");
    } catch (error) {
      if (!(error instanceof vscode.FileSystemError) || error.code !== "FileNotFound" || operation.type === "create") throw error;
    } finally {
      this.applyingRemoteManifest -= 1;
    }
    if (operation.type === "rename") {
      const doc = this.docs.get(operation.sourcePath); if (doc) { this.docs.delete(operation.sourcePath); this.docs.set(operation.destinationPath, doc); }
      const identity = this.documentIdentity.get(operation.sourcePath); if (identity) { this.documentIdentity.delete(operation.sourcePath); this.documentIdentity.set(operation.destinationPath, identity); }
      if (this.readyDocuments.delete(operation.sourcePath)) this.readyDocuments.add(operation.destinationPath);
      if (this.subscribedDocuments.delete(operation.sourcePath)) this.subscribedDocuments.add(operation.destinationPath);
      const pending = this.pendingLocalText.get(operation.sourcePath); if (pending !== undefined) { this.pendingLocalText.delete(operation.sourcePath); this.pendingLocalText.set(operation.destinationPath, pending); }
    } else if (operation.type === "delete") {
      this.docs.get(operation.path)?.destroy(); this.docs.delete(operation.path); this.documentIdentity.delete(operation.path);
      this.readyDocuments.delete(operation.path); this.subscribedDocuments.delete(operation.path); this.pendingLocalText.delete(operation.path);
    }
  }
  private publishManifestOperation(operation: { type: "create"; path: string; content: string } | { type: "rename"; sourcePath: string; destinationPath: string } | { type: "delete"; path: string }): void {
    if (!this.canEdit || !this.key || this.socket?.readyState !== WebSocket.OPEN) return;
    const payload = Buffer.from(JSON.stringify(this.encrypt("__manifest__", new TextEncoder().encode(JSON.stringify(operation))))).toString("base64url");
    this.socket.send(JSON.stringify({ type: "collab.publish", event: { id: crypto.randomUUID(), kind: "manifest.operation", payload } }));
  }
  private publishPresence(document: vscode.TextDocument, selections: readonly vscode.Selection[]): void {
    const file = this.file(document); if (!file || !this.key || this.socket?.readyState !== WebSocket.OPEN) return;
    const update = Buffer.from(JSON.stringify({ file, selections: selections.map((selection) => [selection.start.line, selection.start.character, selection.end.line, selection.end.character]) }));
    const payload = Buffer.from(JSON.stringify(this.encrypt("__presence__", update))).toString("base64url");
    this.socket.send(JSON.stringify({ type: "collab.publish", event: { id: crypto.randomUUID(), kind: "presence.update", payload } }));
  }
  private async applyPresence(actorId: string, payload: string): Promise<void> {
    try {
      const encrypted = JSON.parse(Buffer.from(payload, "base64url").toString()) as EncryptedUpdate;
      const value = JSON.parse(Buffer.from(this.decrypt(encrypted)).toString()) as { file: string; selections: number[][] };
      const editor = vscode.window.visibleTextEditors.find((candidate) => this.file(candidate.document) === value.file);
      if (!editor) return;
      let decoration = this.presenceDecorations.get(actorId);
      if (!decoration) {
        const palette = ["rgba(85,170,255,.24)", "rgba(255,130,170,.24)", "rgba(110,220,150,.24)", "rgba(245,190,70,.24)", "rgba(180,130,255,.24)"];
        const color = palette[[...actorId].reduce((sum, character) => sum + character.charCodeAt(0), 0) % palette.length] ?? palette[0] as string;
        decoration = vscode.window.createTextEditorDecorationType({ backgroundColor: color, border: "1px solid", borderColor: color });
        this.presenceDecorations.set(actorId, decoration);
      }
      const name = this.participantNames.get(actorId) ?? "Collaborator";
      editor.setDecorations(decoration, value.selections.map(([sl, sc, el, ec]) => ({ range: new vscode.Range(new vscode.Position(sl ?? 0, sc ?? 0), new vscode.Position(el ?? 0, ec ?? 0)), hoverMessage: name })));
      const existing = this.presenceExpiry.get(actorId); if (existing) clearTimeout(existing);
      this.presenceExpiry.set(actorId, setTimeout(() => this.clearPresence(actorId), 15_000));
    } catch { /* Ignore malformed or stale ephemeral presence. */ }
  }
  private clearPresence(actorId: string): void {
    const timer = this.presenceExpiry.get(actorId); if (timer) clearTimeout(timer); this.presenceExpiry.delete(actorId);
    const decoration = this.presenceDecorations.get(actorId); decoration?.dispose(); this.presenceDecorations.delete(actorId);
  }
  private decrypt(value: EncryptedUpdate): Uint8Array {
    const decipher = createDecipheriv("aes-256-gcm", this.key as Buffer, Buffer.from(value.nonce, "base64url")); decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
    return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64url")), decipher.final()]));
  }
}
