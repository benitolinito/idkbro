import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import path from "node:path";
import * as vscode from "vscode";
import WebSocket from "ws";
import * as Y from "yjs";

interface EncryptedUpdate { file: string; nonce: string; tag: string; ciphertext: string; }

export class CollaborationBridge implements vscode.Disposable {
  private socket: WebSocket | undefined;
  private readonly docs = new Map<string, Y.Doc>();
  private readonly suppressed = new Set<string>();
  private readonly disposables: vscode.Disposable[];
  private readonly remoteSelectionDecoration = vscode.window.createTextEditorDecorationType({ backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"), border: "1px solid", borderColor: new vscode.ThemeColor("editor.findMatchBorder") });
  private readonly previewOutput = vscode.window.createOutputChannel("MultiCode Preview");
  private key: Buffer | undefined;
  private relayUrl = "";
  private inviteToken = "";
  private displayName = "";
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.disposables = [
      vscode.workspace.onDidChangeTextDocument((event) => void this.localChange(event.document)),
      vscode.window.onDidChangeTextEditorSelection((event) => this.publishPresence(event.textEditor.document, event.selections)),
    ];
  }

  connect(relayUrl: string, inviteToken: string, name: string): void {
    this.disconnect();
    this.relayUrl = relayUrl; this.inviteToken = inviteToken; this.displayName = name;
    const [code, secret] = inviteToken.split(".", 2);
    if (!code || !secret) throw new Error("Invalid MultiCode room token");
    this.key = Buffer.from(hkdfSync("sha256", Buffer.from(secret, "base64url"), Buffer.from(code), Buffer.from("multicode/v2/editor"), 32));
    const base = new URL(relayUrl); base.pathname = `${base.pathname.replace(/\/$/, "")}/rooms/${code}`;
    this.socket = new WebSocket(base);
    this.socket.on("open", () => this.socket?.send(JSON.stringify({ type: "room.join", token: code, name })));
    this.socket.on("message", (data) => void this.receive(data.toString()));
    this.socket.on("close", () => { if (this.inviteToken) { this.reconnectTimer = setTimeout(() => this.connect(this.relayUrl, this.inviteToken, this.displayName), 5_000); } });
  }

  disconnect(): void { if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; const socket = this.socket; this.socket = undefined; this.key = undefined; this.inviteToken = ""; socket?.close(); }
  dispose(): void { this.disconnect(); this.remoteSelectionDecoration.dispose(); this.previewOutput.dispose(); for (const disposable of this.disposables) disposable.dispose(); }

  private file(document: vscode.TextDocument): string | undefined {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root && document.uri.scheme === "file" ? path.relative(root, document.uri.fsPath).split(path.sep).join("/") : undefined;
  }
  private document(file: string, text = ""): Y.Doc {
    let doc = this.docs.get(file);
    if (!doc) { doc = new Y.Doc(); doc.getText("content").insert(0, text); this.docs.set(file, doc); }
    return doc;
  }
  private async localChange(document: vscode.TextDocument): Promise<void> {
    const file = this.file(document); if (!file || this.suppressed.has(file) || !this.key || this.socket?.readyState !== WebSocket.OPEN) return;
    const doc = this.document(file, document.getText()); const text = doc.getText("content");
    let update: Uint8Array | undefined;
    const listener = (value: Uint8Array) => { update = value; }; doc.on("update", listener);
    doc.transact(() => { text.delete(0, text.length); text.insert(0, document.getText()); }, "local"); doc.off("update", listener);
    if (!update) return;
    this.socket.send(JSON.stringify({ type: "collab.publish", event: { id: crypto.randomUUID(), kind: "document.update", payload: Buffer.from(JSON.stringify(this.encrypt(file, update))).toString("base64url") } }));
  }
  private async receive(raw: string): Promise<void> {
    const message = JSON.parse(raw) as { type?: string; event?: { kind: string; payload: string } };
    if (message.type === "room.welcome" && Array.isArray((message as any).collabHistory)) {
      for (const event of (message as any).collabHistory) await this.applyEvent(event);
      return;
    }
    if (message.type !== "collab.event" || !message.event || !this.key) return;
    await this.applyEvent(message.event);
  }
  private async applyEvent(event: { kind: string; payload: string }): Promise<void> {
    if (!this.key) return;
    if (event.kind === "presence.update") { this.applyPresence(event.payload); return; }
    if (event.kind === "agent.preview") { this.previewOutput.clear(); this.previewOutput.append(Buffer.from(event.payload, "base64url").toString()); return; }
    if (event.kind !== "document.update") return;
    const encrypted = JSON.parse(Buffer.from(event.payload, "base64url").toString()) as EncryptedUpdate;
    const update = this.decrypt(encrypted); const doc = this.document(encrypted.file);
    Y.applyUpdate(doc, update, "remote");
    const root = vscode.workspace.workspaceFolders?.[0]?.uri; if (!root) return;
    const uri = vscode.Uri.joinPath(root, ...encrypted.file.split("/")); const open = await vscode.workspace.openTextDocument(uri);
    this.suppressed.add(encrypted.file);
    try {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(open.positionAt(0), open.positionAt(open.getText().length)), doc.getText("content").toString());
      await vscode.workspace.applyEdit(edit);
    }
    finally { setTimeout(() => this.suppressed.delete(encrypted.file), 50); }
  }
  private encrypt(file: string, update: Uint8Array): EncryptedUpdate {
    const nonce = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", this.key as Buffer, nonce); const ciphertext = Buffer.concat([cipher.update(update), cipher.final()]);
    return { file, nonce: nonce.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") };
  }
  private publishPresence(document: vscode.TextDocument, selections: readonly vscode.Selection[]): void {
    const file = this.file(document); if (!file || !this.key || this.socket?.readyState !== WebSocket.OPEN) return;
    const update = Buffer.from(JSON.stringify({ file, selections: selections.map((selection) => [selection.start.line, selection.start.character, selection.end.line, selection.end.character]) }));
    const payload = Buffer.from(JSON.stringify(this.encrypt("__presence__", update))).toString("base64url");
    this.socket.send(JSON.stringify({ type: "collab.publish", event: { id: crypto.randomUUID(), kind: "presence.update", payload } }));
  }
  private async applyPresence(payload: string): Promise<void> {
    try {
      const encrypted = JSON.parse(Buffer.from(payload, "base64url").toString()) as EncryptedUpdate;
      const value = JSON.parse(Buffer.from(this.decrypt(encrypted)).toString()) as { file: string; selections: number[][] };
      const editor = vscode.window.visibleTextEditors.find((candidate) => this.file(candidate.document) === value.file);
      if (!editor) return;
      editor.setDecorations(this.remoteSelectionDecoration, value.selections.map(([sl, sc, el, ec]) => new vscode.Range(new vscode.Position(sl ?? 0, sc ?? 0), new vscode.Position(el ?? 0, ec ?? 0))));
    } catch { /* Ignore malformed or stale ephemeral presence. */ }
  }
  private decrypt(value: EncryptedUpdate): Uint8Array {
    const decipher = createDecipheriv("aes-256-gcm", this.key as Buffer, Buffer.from(value.nonce, "base64url")); decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
    return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64url")), decipher.final()]));
  }
}
