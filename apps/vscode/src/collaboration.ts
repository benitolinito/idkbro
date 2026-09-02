import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import * as vscode from "vscode";
import WebSocket from "ws";
import { workspaceDiffSchema } from "@multicode/protocol";
import type {
  AgentEvent,
  AgentInputAnswers,
  ApprovalDecision,
  CollaborationEvent,
  QueuedPrompt,
  RoomServerMessage,
  WorkspaceCheckpointDescriptor,
  WorkspaceDiff,
} from "@multicode/protocol";
import { applyPortableWorkspaceCheckpoint, decryptWorkspaceCheckpointBundle, type MirroredWorkspaceState } from "@multicode/workspace";

interface EncryptedPayload {
  file: string;
  nonce: string;
  tag: string;
  ciphertext: string;
}

/**
 * Thin room client for shared agent sessions.
 *
 * Workspace editing intentionally does not pass through this bridge. The host
 * owns the coding workspace; participants share prompts, agent activity,
 * approvals, and read-only agent previews only.
 */
export class CollaborationBridge implements vscode.Disposable {
  private readonly statusChanged = new vscode.EventEmitter<"connecting" | "connected" | "reconnecting" | "disconnected">();
  readonly onDidChangeStatus = this.statusChanged.event;

  private readonly previewOutput = vscode.window.createOutputChannel("MultiCode Preview");
  private readonly previewChanged = new vscode.EventEmitter<vscode.Uri>();
  private readonly previewUri = vscode.Uri.parse("multicode-preview:/Agent changes.patch");
  private previewText = "The agent has not produced a preview yet.";
  private readonly proposalChanged = new vscode.EventEmitter<vscode.Uri>();
  private readonly proposalUri = vscode.Uri.parse("multicode-proposal:/Pending agent proposal.patch");
  private proposalText = "There is no pending agent proposal.";
  private readonly disposables: vscode.Disposable[];

  private socket: WebSocket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private relayUrl = "";
  private inviteToken = "";
  private displayName = "";
  private requestedRole: "viewer" | "participant" = "participant";
  private contentKey: Buffer | undefined;
  private promptKey: Buffer | undefined;
  private welcomed = false;
  private latestPreviewRevision = 0;
  private latestPreviewTurn = "";
  private receiveTail: Promise<void> = Promise.resolve();
  private roomId = "";
  private workspaceDiskOwner: "daemon" | "extension" = "extension";
  private requestedCheckpointSequence = 0;
  private checkpointTransfer: { descriptor: WorkspaceCheckpointDescriptor; chunks: Buffer[]; nextIndex: number; receivedBytes: number } | undefined;

  constructor(
    private readonly onRoomMessage?: (message: RoomServerMessage) => void,
    private readonly onAgentPreview?: (turnId: string, revision: number, diff: WorkspaceDiff) => void,
    private readonly onWorkspaceSynchronized?: (workspace: MirroredWorkspaceState) => void | Promise<void>,
    private readonly workspaceDataDirectory?: string,
    private readonly onDiagnostic?: (event: string, details: Record<string, unknown>) => void,
    private readonly onFatalRoomError?: (message: string) => void | Promise<void>,
  ) {
    this.disposables = [
      this.previewChanged,
      this.proposalChanged,
      vscode.workspace.registerTextDocumentContentProvider("multicode-preview", {
        onDidChange: this.previewChanged.event,
        provideTextDocumentContent: () => this.previewText,
      }),
      vscode.workspace.registerTextDocumentContentProvider("multicode-proposal", {
        onDidChange: this.proposalChanged.event,
        provideTextDocumentContent: () => this.proposalText,
      }),
    ];
  }

  connect(
    relayUrl: string,
    inviteToken: string,
    name: string,
    requestedRole: "viewer" | "participant" = "participant",
    workspaceDiskOwner: "daemon" | "extension" = "extension",
    _captureLocalText?: boolean,
  ): void {
    if (
      this.relayUrl === relayUrl
      && this.inviteToken === inviteToken
      && this.displayName === name
      && this.requestedRole === requestedRole
      && (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING)
    ) return;

    this.closeSocket();
    this.relayUrl = relayUrl;
    this.inviteToken = inviteToken;
    this.displayName = name;
    this.requestedRole = requestedRole;
    this.workspaceDiskOwner = workspaceDiskOwner;
    this.latestPreviewRevision = 0;
    this.latestPreviewTurn = "";
    this.welcomed = false;
    this.roomId = "";
    this.requestedCheckpointSequence = 0;
    this.checkpointTransfer = undefined;
    this.deriveKeys(inviteToken);
    this.diagnostic("connection.requested", { relay: this.safeRelayLabel(relayUrl), room: inviteToken.split(".", 1)[0], role: requestedRole, workspaceDiskOwner });
    this.openConnection("connecting");
  }

  /** The host checkout remains external; participant mirrors are managed separately. */
  setWorkspaceRoot(_root: vscode.Uri | undefined): void {}

  disconnect(): void {
    this.inviteToken = "";
    this.relayUrl = "";
    this.displayName = "";
    this.welcomed = false;
    this.roomId = "";
    this.requestedCheckpointSequence = 0;
    this.checkpointTransfer = undefined;
    this.contentKey = undefined;
    this.promptKey = undefined;
    this.closeSocket();
    this.statusChanged.fire("disconnected");
  }

  dispose(): void {
    this.disconnect();
    this.statusChanged.dispose();
    this.previewOutput.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }

  async showPreview(): Promise<void> {
    await vscode.window.showTextDocument(this.previewUri, { preview: false, viewColumn: vscode.ViewColumn.Beside });
  }

  async showProposal(): Promise<void> {
    await vscode.window.showTextDocument(this.proposalUri, { preview: false, viewColumn: vscode.ViewColumn.Beside });
  }

  sendPrompt(text: string, settings: { model?: string; effort?: string } = {}): boolean {
    if (!this.promptKey || this.socket?.readyState !== WebSocket.OPEN) return false;
    const promptId = crypto.randomUUID();
    this.socket.send(JSON.stringify({ type: "prompt.submit", promptId, text: this.sealPrompt(promptId, text), ...settings }));
    this.diagnostic("queue.prompt_submitted", { promptId, model: settings.model, effort: settings.effort, textLength: text.length });
    return true;
  }

  updateAgentSettings(model: string, effort: string): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN || !model || !effort) return false;
    this.socket.send(JSON.stringify({ type: "agent.settings.update", model, effort }));
    this.diagnostic("agent.settings_update_sent", { model, effort });
    return true;
  }

  updateQueuedPrompt(promptId: string, text: string, settings: { model?: string; effort?: string } = {}): boolean {
    if (!this.promptKey || this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ type: "prompt.update", promptId, text: this.sealPrompt(promptId, text), ...settings }));
    this.diagnostic("queue.prompt_update_sent", { promptId, model: settings.model, effort: settings.effort, textLength: text.length });
    return true;
  }

  removeQueuedPrompt(promptId: string): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ type: "prompt.remove", promptId }));
    this.diagnostic("queue.prompt_remove_sent", { promptId });
    return true;
  }

  steerQueuedPrompt(promptId: string): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ type: "prompt.steer", promptId }));
    this.diagnostic("queue.prompt_steer_sent", { promptId });
    return true;
  }

  resolveApproval(requestId: string | number, decision: ApprovalDecision): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ type: "approval.resolve", requestId, decision }));
    this.diagnostic("approval.response_sent", { requestId, decision });
    return true;
  }

  resolveInput(requestId: string, answers: AgentInputAnswers | null): boolean {
    if (!this.welcomed || !this.promptKey || this.socket?.readyState !== WebSocket.OPEN) return false;
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.promptKey, nonce);
    cipher.setAAD(Buffer.from(`input:${requestId}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ answers }), "utf8"), cipher.final()]);
    const payload = JSON.stringify({
      version: 1,
      nonce: nonce.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    });
    this.socket.send(JSON.stringify({ type: "input.resolve", requestId, payload }));
    this.diagnostic("input.response_sent", { requestId, cancelled: answers === null, answerFields: answers ? Object.keys(answers).length : 0 });
    return true;
  }

  private deriveKeys(inviteToken: string): void {
    const [code, secret] = inviteToken.split(".", 2);
    if (!code || !secret) throw new Error("Invalid MultiCode room token");
    this.contentKey = Buffer.from(hkdfSync("sha256", Buffer.from(secret, "base64url"), Buffer.from(code), Buffer.from("multicode/v2/content"), 32));
    this.promptKey = Buffer.from(hkdfSync("sha256", Buffer.from(secret, "base64url"), Buffer.from(code.replace(/-/g, "").toUpperCase()), Buffer.from("multicode/v2/transport"), 32));
  }

  private openConnection(status: "connecting" | "reconnecting"): void {
    if (!this.inviteToken) return;
    this.statusChanged.fire(status);
    const [code] = this.inviteToken.split(".", 1);
    if (!code) throw new Error("Invalid MultiCode room token");
    const base = new URL(this.relayUrl);
    base.pathname = `${base.pathname.replace(/\/$/, "")}/rooms/${code}`;
    const socket = new WebSocket(base);
    this.socket = socket;

    socket.on("open", () => {
      if (this.socket !== socket) return;
      this.statusChanged.fire("connected");
      this.diagnostic("connection.opened", { room: code, role: this.requestedRole });
      socket.send(JSON.stringify({
        type: "room.join",
        token: code,
        name: this.displayName,
        ...(this.requestedRole === "viewer" ? { requestedRole: "viewer" } : {}),
        protocolCapabilities: [
          "agent-config-v1",
          "generic-tools-v1",
          "structured-input-v1",
          ...(this.workspaceDiskOwner === "extension" && this.workspaceDataDirectory ? ["workspace-mirror-v1" as const] : []),
        ],
      }));
    });
    socket.on("message", (data) => {
      const raw = data.toString();
      this.receiveTail = this.receiveTail
        .then(async () => {
          if (this.socket === socket) await this.receive(raw);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.diagnostic("room.message_failed", { message });
          console.error(`MultiCode could not apply a room event: ${message}`);
          if (/workspace checkpoint|workspace mirror|shared workspace/i.test(message)) {
            this.requestedCheckpointSequence = 0;
            this.checkpointTransfer = undefined;
            void vscode.window.showErrorMessage(`MultiCode could not synchronize the shared workspace: ${message}`);
          }
        });
    });
    socket.on("close", (code, reason) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.welcomed = false;
      this.requestedCheckpointSequence = 0;
      this.checkpointTransfer = undefined;
      this.diagnostic("connection.closed", { code, reason: reason.toString().slice(0, 200), reconnecting: Boolean(this.inviteToken) });
      if (!this.inviteToken) return;
      this.statusChanged.fire("reconnecting");
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        this.openConnection("reconnecting");
      }, 5_000);
    });
  }

  private closeSocket(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  private async receive(raw: string): Promise<void> {
    const message = JSON.parse(raw) as RoomServerMessage;
    if (message.type !== "agent.encrypted" || !message.eventType.endsWith(".delta")) {
      this.diagnostic("room.message_received", { type: message.type, eventType: message.type === "agent.encrypted" ? message.eventType : undefined, bytes: Buffer.byteLength(raw) });
    }
    this.notifyRoomMessage(message);
    if (message.type === "room.welcome") {
      this.welcomed = true;
      this.roomId = message.roomId;
      this.diagnostic("room.welcomed", { roomId: message.roomId, selfId: message.selfId, participants: message.participants.length, queuedPrompts: message.queue.length, hasActivePrompt: Boolean(message.activePrompt), checkpointSequence: message.latestCheckpoint?.sequence });
      for (const event of message.collabHistory) await this.applyReadOnlyEvent(event, false);
      if (message.latestCheckpoint && "bundleBytes" in message.latestCheckpoint) this.requestWorkspaceCheckpoint(message.latestCheckpoint);
      return;
    }
    if (message.type === "workspace.checkpoint.available") {
      this.requestWorkspaceCheckpoint(message.checkpoint);
      return;
    }
    if (message.type === "workspace.checkpoint.start") {
      this.beginWorkspaceCheckpoint(message.checkpoint);
      return;
    }
    if (message.type === "workspace.checkpoint.chunk") {
      this.acceptWorkspaceCheckpointChunk(message.chunk);
      return;
    }
    if (message.type === "workspace.checkpoint.complete") {
      await this.completeWorkspaceCheckpoint(message.sequence);
      return;
    }
    if (message.type === "room.error" && message.fatal) {
      this.diagnostic("connection.fatal", { message: message.message });
      this.disconnect();
      await this.onFatalRoomError?.(message.message);
      return;
    }
    if (message.type === "room.error" && !message.fatal && /host connection interrupted/i.test(message.message)) {
      this.requestedCheckpointSequence = 0;
      this.checkpointTransfer = undefined;
      return;
    }
    if (message.type === "collab.event") await this.applyReadOnlyEvent(message.event);
  }

  private requestWorkspaceCheckpoint(checkpoint: WorkspaceCheckpointDescriptor): void {
    if (
      this.workspaceDiskOwner !== "extension"
      || !this.workspaceDataDirectory
      || this.socket?.readyState !== WebSocket.OPEN
      || checkpoint.sequence <= this.requestedCheckpointSequence
    ) return;
    this.requestedCheckpointSequence = checkpoint.sequence;
    this.diagnostic("workspace.checkpoint_requested", { sequence: checkpoint.sequence, commit: checkpoint.commit.slice(0, 12), bundleBytes: checkpoint.bundleBytes, chunkCount: checkpoint.chunkCount });
    this.socket.send(JSON.stringify({ type: "workspace.checkpoint.request", sequence: checkpoint.sequence }));
  }

  private beginWorkspaceCheckpoint(descriptor: WorkspaceCheckpointDescriptor): void {
    if (descriptor.sequence !== this.requestedCheckpointSequence) throw new Error("Received an unexpected workspace checkpoint");
    this.checkpointTransfer = { descriptor, chunks: [], nextIndex: 0, receivedBytes: 0 };
  }

  private acceptWorkspaceCheckpointChunk(chunk: { sequence: number; index: number; data: string }): void {
    const transfer = this.checkpointTransfer;
    if (!transfer || chunk.sequence !== transfer.descriptor.sequence || chunk.index !== transfer.nextIndex) throw new Error("Workspace checkpoint chunks arrived out of order");
    const decoded = Buffer.from(chunk.data, "base64");
    if (decoded.toString("base64") !== chunk.data) throw new Error("Workspace checkpoint chunk encoding is invalid");
    transfer.chunks.push(decoded);
    transfer.nextIndex += 1;
    transfer.receivedBytes += decoded.byteLength;
    if (transfer.receivedBytes > transfer.descriptor.bundleBytes) throw new Error("Workspace checkpoint exceeds its declared size");
  }

  private async completeWorkspaceCheckpoint(sequence: number): Promise<void> {
    const transfer = this.checkpointTransfer;
    this.checkpointTransfer = undefined;
    if (!transfer || sequence !== transfer.descriptor.sequence) throw new Error("Workspace checkpoint completion is invalid");
    const encrypted = Buffer.concat(transfer.chunks);
    if (
      transfer.nextIndex !== transfer.descriptor.chunkCount
      || encrypted.byteLength !== transfer.descriptor.bundleBytes
      || createHash("sha256").update(encrypted).digest("hex") !== transfer.descriptor.bundleHash
    ) throw new Error("Workspace checkpoint failed integrity validation");
    if (!this.promptKey || !this.workspaceDataDirectory || !this.roomId) throw new Error("Workspace checkpoint arrived before the room was ready");
    const bundle = decryptWorkspaceCheckpointBundle(this.promptKey, sequence, encrypted);
    const workspace = await applyPortableWorkspaceCheckpoint({
      dataDirectory: this.workspaceDataDirectory,
      roomId: this.roomId,
      checkpoint: {
        sequence,
        baseCommit: transfer.descriptor.baseCommit,
        commit: transfer.descriptor.commit,
        ref: transfer.descriptor.ref,
        bundle: bundle.toString("base64"),
        createdAt: transfer.descriptor.createdAt,
      },
    });
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "workspace.ack", sequence, commit: transfer.descriptor.commit }));
    this.diagnostic("workspace.checkpoint_applied", { sequence, commit: transfer.descriptor.commit.slice(0, 12), bundleBytes: encrypted.byteLength, chunks: transfer.nextIndex });
    await this.onWorkspaceSynchronized?.(workspace);
  }

  private diagnostic(event: string, details: Record<string, unknown>): void {
    this.onDiagnostic?.(event, details);
  }

  private safeRelayLabel(relayUrl: string): string {
    try { const url = new URL(relayUrl); return `${url.protocol}//${url.host}${url.pathname}`; }
    catch { return "invalid-relay-url"; }
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
    if (!this.promptKey) {
      this.onRoomMessage(message);
      return;
    }
    try {
      if (message.type === "prompt.queued" || message.type === "prompt.started" || message.type === "prompt.updated" || message.type === "prompt.steered" || message.type === "prompt.steer") {
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
    } catch { /* Do not expose ciphertext when room decryption fails. */ }
  }

  private sealPrompt(promptId: string, text: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.promptKey as Buffer, nonce);
    cipher.setAAD(Buffer.from(`prompt:${promptId}`));
    const ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return JSON.stringify({
      version: 1,
      nonce: nonce.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    });
  }

  private openPrompt(prompt: QueuedPrompt): QueuedPrompt {
    return { ...prompt, text: new TextDecoder().decode(this.openTransport(prompt.text, `prompt:${prompt.promptId}`)) };
  }

  private openTransport(sealed: string, aad?: string): Uint8Array {
    const value = JSON.parse(sealed) as { version?: unknown; nonce?: unknown; tag?: unknown; ciphertext?: unknown };
    if (value.version !== 1 || typeof value.nonce !== "string" || typeof value.tag !== "string" || typeof value.ciphertext !== "string") {
      throw new Error("Invalid encrypted transport payload");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.promptKey as Buffer, Buffer.from(value.nonce, "base64url"));
    if (aad) decipher.setAAD(new TextEncoder().encode(aad));
    decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
    return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64url")), decipher.final()]));
  }

  private async applyReadOnlyEvent(event: CollaborationEvent, notifyAgentPreview = true): Promise<void> {
    if (event.kind !== "agent.preview" && event.kind !== "agent.proposal") return;
    const encrypted = JSON.parse(Buffer.from(event.payload, "base64url").toString()) as EncryptedPayload;
    if (event.kind === "agent.preview") {
      if (encrypted.file !== "__preview__") throw new Error("Invalid agent preview");
      const preview = JSON.parse(Buffer.from(this.decryptContent(encrypted)).toString()) as { turnId?: unknown; revision?: unknown; diff?: unknown };
      if (typeof preview.turnId !== "string" || typeof preview.revision !== "number" || !Number.isInteger(preview.revision)) {
        throw new Error("Invalid agent preview metadata");
      }
      const parsedDiff = workspaceDiffSchema.parse(preview.diff);
      const diff: WorkspaceDiff = {
        revision: parsedDiff.revision,
        text: parsedDiff.text,
        truncated: parsedDiff.truncated,
        createdAt: parsedDiff.createdAt,
        ...(parsedDiff.additions !== undefined ? { additions: parsedDiff.additions } : {}),
        ...(parsedDiff.deletions !== undefined ? { deletions: parsedDiff.deletions } : {}),
        ...(parsedDiff.files ? { files: parsedDiff.files.map((file) => ({
          path: file.path,
          additions: file.additions,
          deletions: file.deletions,
          ...(file.binary !== undefined ? { binary: file.binary } : {}),
        })) } : {}),
      };
      if (preview.turnId === this.latestPreviewTurn && preview.revision <= this.latestPreviewRevision) return;
      this.latestPreviewTurn = preview.turnId;
      this.latestPreviewRevision = preview.revision;
      this.previewText = `# Preview — host workspace not modified\n# Turn ${preview.turnId} · revision ${preview.revision}\n\n${diff.text || "No changed files."}`;
      this.previewChanged.fire(this.previewUri);
      void vscode.commands.executeCommand("setContext", "multicode.hasPreview", true);
      this.previewOutput.clear();
      this.previewOutput.append(diff.text);
      if (notifyAgentPreview) this.onAgentPreview?.(preview.turnId, preview.revision, diff);
      return;
    }

    if (encrypted.file !== "__proposal__") throw new Error("Invalid agent proposal");
    const proposal = JSON.parse(Buffer.from(this.decryptContent(encrypted)).toString()) as { turnId?: unknown; patchText?: unknown; truncated?: unknown };
    if (typeof proposal.turnId !== "string" || typeof proposal.patchText !== "string") throw new Error("Invalid agent proposal");
    this.proposalText = `# Pending host review\n# Turn ${proposal.turnId}${proposal.truncated ? " · preview truncated" : ""}\n\n${proposal.patchText}`;
    this.proposalChanged.fire(this.proposalUri);
    void vscode.commands.executeCommand("setContext", "multicode.hasProposal", true);
  }

  private decryptContent(value: EncryptedPayload): Uint8Array {
    if (!this.contentKey) throw new Error("Room content key is unavailable");
    const decipher = createDecipheriv("aes-256-gcm", this.contentKey, Buffer.from(value.nonce, "base64url"));
    decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
    return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64url")), decipher.final()]));
  }
}
