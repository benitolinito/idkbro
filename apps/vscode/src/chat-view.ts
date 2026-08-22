import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { AgentInputAnswers, RoomServerMessage } from "@multicode/protocol";
import type { ApprovalDecision } from "@multicode/protocol";
import { ChatModel } from "./chat-model.js";
import { renderChatMarkdown } from "./markdown.js";
import { renderWorkspaceDiff } from "./syntax-highlight.js";

export interface ChatActions {
  back(): void | Promise<void>;
  host(): void | Promise<void>;
  join(token?: string): void | Promise<void>;
  stop(): void | Promise<void>;
  submit(text: string, settings: { model?: string; effort?: string }): void | Promise<void>;
  updateQueuedPrompt(promptId: string, text: string, settings: { model?: string; effort?: string }): void | Promise<void>;
  removeQueuedPrompt(promptId: string): void | Promise<void>;
  steerQueuedPrompt(promptId: string): void | Promise<void>;
  approve(requestId: string | number, decision: ApprovalDecision): void | Promise<void>;
  answer(requestId: string, answers: AgentInputAnswers | null): void | Promise<void>;
  copyInvite(): void | Promise<void>;
  openOutput(): void | Promise<void>;
  reviewChanges(): void | Promise<void>;
  openChangedFile(file: string): void | Promise<void>;
}

type WebviewMessage =
  | { type: "ready" }
  | { type: "back" }
  | { type: "host" }
  | { type: "join"; token?: string }
  | { type: "stop" }
  | { type: "submit"; text?: string; model?: string; effort?: string }
  | { type: "queueUpdate"; promptId?: string; text?: string; model?: string; effort?: string }
  | { type: "queueRemove"; promptId?: string }
  | { type: "queueSteer"; promptId?: string }
  | { type: "approval"; requestId?: string | number; decision?: ApprovalDecision }
  | { type: "input"; requestId?: string; answers?: AgentInputAnswers | null }
  | { type: "copyInvite" }
  | { type: "openOutput" }
  | { type: "reviewChanges" }
  | { type: "openChangedFile"; file?: string }
  | { type: "openLink"; href?: string };

function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return value === "accept" || value === "decline" || value === "cancel";
}

export class MultiCodeChatView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = "multicode.chatView";

  private readonly model = new ChatModel();
  private view: vscode.WebviewView | undefined;
  private disposed = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly actions: ChatActions,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: WebviewMessage) => void this.receive(message));
    view.onDidDispose(() => { if (this.view === view) this.view = undefined; });
    this.publish();
  }

  start(mode: "host" | "join", roomLabel?: string): void { this.model.start(mode, roomLabel); this.publish(); }
  ready(roomLabel: string): void { this.model.ready(roomLabel); this.publish(); }
  stopping(): void { this.model.stopping(); this.publish(); }
  stopped(message?: string): void { this.model.stopped(message); this.publish(); }
  fail(message: string): void { this.model.fail(message); this.publish(); }
  submitted(name: string, text: string): void { this.model.submitted(name, text); this.publish(); }
  handle(message: RoomServerMessage): void { this.model.handle(message); this.publish(); }

  dispose(): void {
    this.disposed = true;
    this.view = undefined;
  }

  private async receive(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case "ready": this.publish(); break;
      case "back": await this.actions.back(); this.model.reset(); this.publish(); break;
      case "host": await this.actions.host(); break;
      case "join": await this.actions.join(message.token?.trim() || undefined); break;
      case "stop": await this.actions.stop(); break;
      case "copyInvite": await this.actions.copyInvite(); break;
      case "openOutput": await this.actions.openOutput(); break;
      case "reviewChanges": await this.actions.reviewChanges(); break;
      case "openChangedFile": if (message.file?.trim()) await this.actions.openChangedFile(message.file.trim()); break;
      case "openLink": {
        const href = message.href?.trim();
        if (!href) break;
        try {
          const uri = vscode.Uri.parse(href, true);
          if (uri.scheme === "http" || uri.scheme === "https" || uri.scheme === "mailto") await vscode.env.openExternal(uri);
        } catch {
          // Ignore malformed or unsupported links from rendered chat content.
        }
        break;
      }
      case "approval": {
        if ((typeof message.requestId !== "string" && typeof message.requestId !== "number") || !isApprovalDecision(message.decision)) break;
        this.model.approvalSubmitting(message.requestId); this.publish();
        try { await this.actions.approve(message.requestId, message.decision); }
        catch (error) { this.model.approvalFailed(message.requestId, error instanceof Error ? error.message : String(error)); this.publish(); }
        break;
      }
      case "input": {
        if (!message.requestId) break;
        this.model.inputSubmitting(message.requestId); this.publish();
        try { await this.actions.answer(message.requestId, message.answers ?? null); }
        catch (error) { this.model.inputFailed(message.requestId, error instanceof Error ? error.message : String(error)); this.publish(); }
        break;
      }
      case "submit": {
        const text = message.text?.trim();
        if (text) await this.actions.submit(text, {
          ...(message.model?.trim() ? { model: message.model.trim() } : {}),
          ...(message.effort?.trim() ? { effort: message.effort.trim() } : {}),
        });
        break;
      }
      case "queueUpdate": {
        const promptId = message.promptId?.trim();
        const text = message.text?.trim();
        if (promptId && text) await this.actions.updateQueuedPrompt(promptId, text, {
          ...(message.model?.trim() ? { model: message.model.trim() } : {}),
          ...(message.effort?.trim() ? { effort: message.effort.trim() } : {}),
        });
        break;
      }
      case "queueRemove":
        if (message.promptId?.trim()) await this.actions.removeQueuedPrompt(message.promptId.trim());
        break;
      case "queueSteer":
        if (message.promptId?.trim()) await this.actions.steerQueuedPrompt(message.promptId.trim());
        break;
    }
  }

  private publish(): void {
    if (this.disposed || !this.view) return;
    const state = this.model.snapshot();
    const renderedState = {
      ...state,
      timeline: state.timeline.map((item) => {
        if (item.kind === "user" || item.kind === "assistant" || item.kind === "reasoning") {
          return { ...item, markdownHtml: renderChatMarkdown(item.text) };
        }
        if (item.kind === "diff") return { ...item, diffHtml: renderWorkspaceDiff(item.text) };
        return item;
      }),
    };
    this.view.badge = state.connection === "connected" && state.participants.length > 0
      ? { value: state.participants.length, tooltip: `${state.participants.length} collaborator${state.participants.length === 1 ? "" : "s"}` }
      : undefined;
    void this.view.webview.postMessage({ type: "state", state: renderedState });
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(18).toString("base64");
    const squareLogoUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "multicode-square.svg"));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource}`,
    ].join("; ");
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>MultiCode</title>
  <style>
    :root {
      color-scheme: light dark;
      --motion-fast: 120ms;
      --motion-medium: 200ms;
      --motion-slow: 280ms;
      --motion-ease: cubic-bezier(.2, .8, .2, 1);
      --motion-ease-out: cubic-bezier(.16, 1, .3, 1);
    }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font: 13px/1.45 var(--vscode-font-family); overflow: hidden; }
    button, textarea, input, select { font: inherit; }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; border-radius: 5px; padding: 7px 11px; cursor: pointer; transition: color var(--motion-fast) ease, background-color var(--motion-fast) ease, border-color var(--motion-fast) ease, opacity var(--motion-fast) ease, transform var(--motion-fast) var(--motion-ease); }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:active:not(:disabled) { transform: scale(.97); }
    button.secondary { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); }
    button.icon { padding: 5px 8px; background: transparent; color: var(--vscode-foreground); }
    button.icon:hover { background: var(--vscode-toolbar-hoverBackground); }
    button:disabled { opacity: .45; cursor: default; }
    #app { height: 100vh; display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto; }
    header { padding: 10px 12px 8px; border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border)); }
    .topline { display: flex; align-items: center; gap: 8px; }
    .brand { font-weight: 700; letter-spacing: .2px; flex: 1; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-disabledForeground); transition: background-color var(--motion-medium) ease, box-shadow var(--motion-medium) ease, opacity var(--motion-medium) ease; }
    .dot.connected { background: var(--vscode-testing-iconPassed); box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-testing-iconPassed) 18%, transparent); }
    .dot.starting, .dot.stopping { background: var(--vscode-debugIcon-startForeground); animation: pulse 1.2s infinite; }
    .dot.error { background: var(--vscode-testing-iconFailed); }
    @keyframes pulse { 50% { opacity: .35; } }
    .room { margin-top: 5px; color: var(--vscode-descriptionForeground); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #people { display: flex; align-items: center; gap: 5px; padding: 8px 12px; min-height: 40px; overflow-x: auto; border-bottom: 1px solid var(--vscode-panel-border); }
    .person { display: inline-flex; align-items: center; gap: 5px; padding: 3px 7px 3px 3px; border-radius: 999px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); white-space: nowrap; font-size: 11px; }
    .person.entering { animation: chipEnter var(--motion-medium) var(--motion-ease-out) both; }
    .avatar { width: 20px; height: 20px; display: grid; place-items: center; border-radius: 50%; background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-weight: 700; }
    .host { color: var(--vscode-charts-yellow); margin-left: 1px; }
    #conversation { overflow-y: auto; padding: 12px 10px 22px; scroll-behavior: auto; overflow-anchor: none; }
    .empty { height: 100%; display: grid; place-content: center; text-align: center; color: var(--vscode-descriptionForeground); padding: 24px; animation: emptyEnter var(--motion-slow) var(--motion-ease-out) both; }
    .empty-logo { display: block; margin: 0 auto 12px; width: 44px; height: 44px; }
    .empty h2 { color: var(--vscode-foreground); font-size: 15px; margin: 0 0 6px; }
    .empty p { margin: 0 0 14px; }
    .actions { display: flex; justify-content: center; gap: 8px; }
    .join-form { display: none; margin-top: 10px; gap: 6px; }
    .join-form.visible { display: flex; animation: revealDown var(--motion-medium) var(--motion-ease-out) both; }
    .join-form input { min-width: 0; flex: 1; }
    .item { margin: 0 0 12px; }
    .item.entering { animation: itemEnter var(--motion-slow) var(--motion-ease-out) both; will-change: opacity, transform; }
    .item.user, .item.assistant { position: relative; margin-bottom: 28px; }
    .meta { display: flex; align-items: center; gap: 6px; color: var(--vscode-descriptionForeground); font-size: 11px; margin: 0 3px 4px; }
    .meta strong { color: var(--vscode-foreground); }
    .bubble { border: 1px solid var(--vscode-panel-border); border-radius: 9px; padding: 9px 10px; overflow-wrap: anywhere; }
    .user .bubble { background: color-mix(in srgb, var(--vscode-button-background) 18%, transparent); border-color: color-mix(in srgb, var(--vscode-button-background) 45%, var(--vscode-panel-border)); }
    .assistant .bubble { background: var(--vscode-editor-background); }
    .message-time { position: absolute; top: calc(100% + 4px); left: 3px; height: 18px; color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 18px; opacity: 0; visibility: hidden; pointer-events: none; transition: opacity 100ms ease; }
    .user .message-time { right: 3px; left: auto; text-align: right; }
    .item.user:hover .message-time, .item.assistant:hover .message-time, .item.user:focus-within .message-time, .item.assistant:focus-within .message-time { opacity: 1; visibility: visible; }
    .markdown { white-space: normal; overflow-wrap: anywhere; }
    .markdown > :first-child { margin-top: 0; }
    .markdown > :last-child { margin-bottom: 0; }
    .markdown p { margin: 0 0 8px; }
    .markdown h1, .markdown h2, .markdown h3, .markdown h4, .markdown h5, .markdown h6 { margin: 12px 0 6px; color: var(--vscode-foreground); line-height: 1.25; }
    .markdown h1 { font-size: 17px; } .markdown h2 { font-size: 15px; } .markdown h3 { font-size: 14px; }
    .markdown ul, .markdown ol { margin: 5px 0 8px; padding-left: 20px; }
    .markdown li { margin: 2px 0; }
    .markdown blockquote { margin: 7px 0; padding: 1px 0 1px 9px; border-left: 2px solid var(--vscode-textBlockQuote-border, var(--vscode-panel-border)); color: var(--vscode-descriptionForeground); }
    .markdown code { padding: 1px 4px; border-radius: 3px; color: var(--vscode-textPreformat-foreground); background: var(--vscode-textCodeBlock-background); font: 11px/1.45 var(--vscode-editor-font-family); }
    .markdown pre { margin: 7px 0; padding: 8px 9px; max-height: 300px; overflow: auto; border-radius: 5px; background: var(--vscode-textCodeBlock-background); }
    .markdown pre code { padding: 0; background: transparent; white-space: pre; }
    .tok-keyword { color: var(--vscode-symbolIcon-keywordForeground, #c586c0); }
    .tok-string { color: var(--vscode-symbolIcon-stringForeground, #ce9178); }
    .tok-number { color: var(--vscode-symbolIcon-numberForeground, #b5cea8); }
    .tok-comment { color: var(--vscode-descriptionForeground, #6a9955); font-style: italic; }
    .tok-function { color: var(--vscode-symbolIcon-functionForeground, #dcdcaa); }
    .tok-type { color: var(--vscode-symbolIcon-classForeground, #4ec9b0); }
    .tok-property { color: var(--vscode-symbolIcon-propertyForeground, #9cdcfe); }
    .tok-constant { color: var(--vscode-symbolIcon-constantForeground, #569cd6); }
    .tok-operator { color: var(--vscode-symbolIcon-operatorForeground, #d4d4d4); }
    .markdown a { color: var(--vscode-textLink-foreground); text-decoration: none; }
    .markdown a:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
    .markdown hr { border: 0; border-top: 1px solid var(--vscode-panel-border); margin: 10px 0; }
    .markdown table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; margin: 7px 0; }
    .markdown th, .markdown td { padding: 4px 7px; border: 1px solid var(--vscode-panel-border); text-align: left; }
    details.card { border: 1px solid var(--vscode-panel-border); border-radius: 7px; background: var(--vscode-editor-background); }
    details.card summary { padding: 7px 9px; cursor: pointer; color: var(--vscode-descriptionForeground); user-select: none; }
    details.card pre { margin: 0; padding: 8px 9px; border-top: 1px solid var(--vscode-panel-border); white-space: pre-wrap; overflow-wrap: anywhere; font: 11px/1.45 var(--vscode-editor-font-family); max-height: 280px; overflow: auto; }
    details.change-card { overflow: hidden; border: 1px solid var(--vscode-panel-border); border-radius: 10px; background: var(--vscode-editor-background); transition: border-color var(--motion-fast) ease, background-color var(--motion-fast) ease; }
    details.change-card > summary { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; align-items: center; gap: 9px; min-height: 54px; padding: 8px 9px; cursor: pointer; user-select: none; }
    details.change-card > summary::-webkit-details-marker { display: none; }
    .change-icon { display: grid; place-items: center; width: 25px; height: 25px; border: 1px solid var(--vscode-descriptionForeground); border-radius: 6px; color: var(--vscode-descriptionForeground); font: 700 14px/1 var(--vscode-editor-font-family); }
    .change-overview { min-width: 0; }
    .change-title { overflow: hidden; color: var(--vscode-foreground); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
    .change-totals { display: flex; gap: 5px; margin-top: 1px; font: 12px/1.3 var(--vscode-editor-font-family); }
    .additions { color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950); }
    .deletions { color: var(--vscode-gitDecoration-deletedResourceForeground, #f47067); }
    button.change-review { align-self: center; padding: 5px 9px; color: var(--vscode-foreground); background: transparent; border: 1px solid var(--vscode-panel-border); border-radius: 7px; font-size: 11px; }
    button.change-review:hover { background: var(--vscode-toolbar-hoverBackground); }
    .change-files { border-top: 1px solid var(--vscode-panel-border); padding: 4px 0; }
    .change-file-entry + .change-file-entry { border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 55%, transparent); }
    button.change-file { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 6px; width: 100%; padding: 7px 10px; color: var(--vscode-descriptionForeground); background: transparent; border: 0; border-radius: 0; text-align: left; }
    button.change-file:hover { background: var(--vscode-list-hoverBackground); }
    button.change-file[aria-expanded="true"] { background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground)); }
    .change-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .change-file-name { color: var(--vscode-foreground); }
    .change-count { min-width: 25px; text-align: right; font: 12px/1.3 var(--vscode-editor-font-family); }
    .change-binary { grid-column: 2 / 4; color: var(--vscode-descriptionForeground); font: 10px/1.3 var(--vscode-editor-font-family); text-transform: uppercase; }
    .diff-preview { max-height: 390px; overflow: auto; border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-textCodeBlock-background); }
    .change-file-preview .diff-file-heading { display: none; }
    .diff-file-preview + .diff-file-preview { border-top: 1px solid var(--vscode-panel-border); }
    .diff-file-heading { position: sticky; top: 0; z-index: 1; padding: 6px 9px; overflow: hidden; color: var(--vscode-descriptionForeground); background: var(--vscode-editor-background); font: 10px/1.4 var(--vscode-editor-font-family); text-overflow: ellipsis; white-space: nowrap; }
    .diff-lines { min-width: max-content; width: 100%; padding: 3px 0; }
    .diff-line { display: grid; grid-template-columns: 12px 34px 34px minmax(max-content, 1fr); min-height: 20px; border-left: 3px solid transparent; font: 11px/20px var(--vscode-editor-font-family); }
    .diff-line code { display: block; padding: 0 10px 0 7px; color: var(--vscode-editor-foreground); white-space: pre; }
    .diff-marker { color: var(--vscode-editorLineNumber-foreground); text-align: center; user-select: none; }
    .diff-gutter { padding-right: 6px; color: var(--vscode-editorLineNumber-foreground); text-align: right; user-select: none; }
    .diff-add { border-left-color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950); background: var(--vscode-diffEditor-insertedLineBackground, rgba(46, 160, 67, .18)); }
    .diff-delete { border-left-color: var(--vscode-gitDecoration-deletedResourceForeground, #f47067); background: var(--vscode-diffEditor-removedLineBackground, rgba(248, 81, 73, .18)); }
    .diff-add .diff-marker, .diff-add .diff-gutter { color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950); }
    .diff-delete .diff-marker, .diff-delete .diff-gutter { color: var(--vscode-gitDecoration-deletedResourceForeground, #f47067); }
    .diff-meta { grid-template-columns: 46px 34px minmax(max-content, 1fr); color: var(--vscode-descriptionForeground); background: color-mix(in srgb, var(--vscode-textLink-foreground) 7%, transparent); }
    .diff-meta code { color: var(--vscode-descriptionForeground); font-style: italic; }
    .diff-preview-truncated { padding: 7px 9px; color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-panel-border); font-size: 10px; }
    details.activity-card { border: 0; background: transparent; }
    details.activity-card > summary { display: grid; grid-template-columns: 18px minmax(0, auto) auto 10px; align-items: center; gap: 6px; width: fit-content; max-width: 100%; min-height: 28px; padding: 3px 4px; cursor: pointer; color: var(--vscode-descriptionForeground); user-select: none; border-radius: 5px; }
    details.activity-card > summary:hover { background: var(--vscode-list-hoverBackground); }
    details.activity-card > summary::-webkit-details-marker, details.activity-step > summary::-webkit-details-marker { display: none; }
    .activity-chevron { display: inline-block; grid-column: -1; flex: none; color: var(--vscode-descriptionForeground); font-size: 10px; transition: transform 120ms ease; }
    details.activity-card[open] > summary .activity-chevron, details.activity-step[open] > summary .step-chevron { transform: rotate(90deg); }
    .activity-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 12px; font-weight: 600; }
    .activity-timer { color: color-mix(in srgb, var(--vscode-descriptionForeground) 78%, transparent); font: 11px/1.3 var(--vscode-editor-font-family); white-space: nowrap; }
    .activity-glyph { display: grid; place-items: center; width: 17px; height: 17px; color: var(--vscode-descriptionForeground); opacity: .86; }
    .activity-glyph svg { width: 16px; height: 16px; overflow: visible; fill: none; stroke: currentColor; stroke-width: 1.45; stroke-linecap: round; stroke-linejoin: round; }
    .activity-card.running > summary .activity-label, .activity-step.running .step-label {
      color: transparent;
      background: linear-gradient(90deg, var(--vscode-descriptionForeground) 15%, var(--vscode-foreground) 42%, var(--vscode-descriptionForeground) 68%);
      background-size: 220% 100%;
      background-clip: text;
      -webkit-background-clip: text;
      animation: activeText 1.8s linear infinite;
      animation-delay: var(--active-text-delay, 0ms);
    }
    .activity-card.running > summary .activity-glyph, .activity-step.running .activity-glyph { animation: activeGlyph 1.6s ease-in-out infinite; animation-delay: var(--active-glyph-delay, 0ms); }
    .activity-steps { margin: 1px 0 0; padding: 0; }
    details.activity-step { border: 0; background: transparent; }
    details.activity-step.entering { animation: activityEnter var(--motion-medium) var(--motion-ease-out) both; }
    details.activity-step > summary { display: grid; grid-template-columns: 18px minmax(0, 1fr) 10px; align-items: center; gap: 6px; min-height: 28px; padding: 3px 4px; cursor: pointer; color: var(--vscode-descriptionForeground); user-select: none; border-radius: 5px; }
    details.activity-step > summary:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
    .activity-step.failed .activity-glyph, .activity-step.failed .step-label { color: var(--vscode-errorForeground); }
    .step-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
    .step-chevron { color: var(--vscode-descriptionForeground); font-size: 9px; transition: transform 120ms ease; }
    details.activity-step > pre.step-output { width: 100%; margin: 0 0 4px; padding: 7px 9px; border: 0; color: var(--vscode-descriptionForeground); background: var(--vscode-textCodeBlock-background); border-radius: 5px; white-space: pre-wrap; overflow-wrap: anywhere; font: 11px/1.45 var(--vscode-editor-font-family); max-height: 220px; overflow: auto; }
    details.activity-step > .step-markdown { width: 100%; margin: 1px 0 5px; padding: 6px 9px; color: var(--vscode-descriptionForeground); background: var(--vscode-textCodeBlock-background); border-left: 2px solid var(--vscode-panel-border); border-radius: 0 5px 5px 0; font-size: 11px; }
    @keyframes activeText { from { background-position: 100% 0; } to { background-position: -120% 0; } }
    @keyframes activeGlyph { 0%, 100% { opacity: .46; } 50% { opacity: 1; } }
    @keyframes activityEnter { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes itemEnter { from { opacity: 0; transform: translateY(7px) scale(.995); } to { opacity: 1; transform: translateY(0) scale(1); } }
    @keyframes chipEnter { from { opacity: 0; transform: translateX(-5px) scale(.96); } to { opacity: 1; transform: translateX(0) scale(1); } }
    @keyframes emptyEnter { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes revealDown { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
    .system, .error { display: flex; gap: 7px; align-items: flex-start; color: var(--vscode-descriptionForeground); font-size: 11px; padding: 3px 4px; }
    .error { color: var(--vscode-errorForeground); }
    .approval { overflow: hidden; border: 1px solid var(--vscode-panel-border); border-radius: 10px; background: var(--vscode-editor-background); font-size: 12px; }
    .approval-main { display: flex; min-width: 0; flex-direction: column; gap: 8px; padding: 13px 13px 10px; }
    .approval-head { display: flex; min-width: 0; align-items: center; gap: 7px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .approval-icon { display: grid; width: 18px; height: 18px; flex: none; place-items: center; color: var(--vscode-descriptionForeground); }
    .approval-icon svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.45; stroke-linecap: round; stroke-linejoin: round; }
    .approval-kind { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .approval-status { margin-left: auto; padding: 1px 6px; border-radius: 999px; color: var(--vscode-descriptionForeground); background: var(--vscode-badge-background); font-size: 10px; text-transform: capitalize; }
    .approval-title { color: var(--vscode-foreground); font-size: 13px; font-weight: 600; line-height: 1.35; }
    .approval-cwd { margin-top: -4px; overflow: hidden; color: var(--vscode-descriptionForeground); font: 10px/1.4 var(--vscode-editor-font-family); text-overflow: ellipsis; white-space: nowrap; }
    .approval-command { margin: 0; padding: 9px 10px; max-height: 180px; overflow: auto; border-radius: 6px; color: var(--vscode-textPreformat-foreground); background: var(--vscode-textCodeBlock-background); white-space: pre-wrap; overflow-wrap: anywhere; font: 11px/1.5 var(--vscode-editor-font-family); }
    .approval-reason { color: var(--vscode-foreground); line-height: 1.45; overflow-wrap: anywhere; }
    .approval-reason-label { display: block; margin-bottom: 2px; color: var(--vscode-descriptionForeground); font-size: 10px; }
    .approval-actions { display: flex; align-items: center; gap: 7px; padding: 8px 13px 12px; }
    .approval-actions-right { display: flex; gap: 7px; margin-left: auto; }
    .approval-actions button { min-height: 28px; padding: 5px 10px; border-radius: 6px; font-size: 11px; }
    .approval-actions button.approval-cancel { padding-inline: 4px; color: var(--vscode-descriptionForeground); background: transparent; }
    .approval-actions button.approval-cancel:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    .approval-actions button.approval-deny { color: var(--vscode-foreground); background: transparent; border: 1px solid var(--vscode-panel-border); }
    .approval-actions button.approval-deny:hover { background: var(--vscode-toolbar-hoverBackground); }
    .approval-actions button.approval-allow { font-weight: 600; }
    .approval-waiting { padding: 0 13px 12px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .input { overflow: hidden; border: 1px solid var(--vscode-panel-border); border-radius: 10px; background: var(--vscode-editor-background); font-size: 12px; }
    .input-main { display: grid; gap: 12px; padding: 13px; }
    .input-question { display: grid; gap: 7px; }
    .input-question strong { font-size: 12px; }
    .input-option { display: grid; grid-template-columns: auto minmax(0,1fr); gap: 7px; align-items: start; padding: 6px 7px; border-radius: 6px; background: var(--vscode-list-inactiveSelectionBackground); }
    .input-option small { display: block; color: var(--vscode-descriptionForeground); }
    .input-freeform { width: 100%; min-height: 58px; resize: vertical; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 5px; padding: 6px; }
    .input-actions { display: flex; justify-content: flex-end; gap: 7px; padding: 0 13px 12px; }
    #queue { display: none; margin: 8px 10px 0; color: var(--vscode-descriptionForeground); font-size: 11px; }
    #queue.visible { display: block; animation: revealDown var(--motion-medium) var(--motion-ease-out) both; }
    .queue-head { display: flex; align-items: center; gap: 6px; padding: 0 4px 6px; }
    .queue-head strong { color: var(--vscode-foreground); font-weight: 600; }
    .queue-list { display: grid; gap: 6px; }
    .queue-card { min-width: 0; overflow: hidden; border: 1px solid var(--vscode-panel-border); border-radius: 9px; background: color-mix(in srgb, var(--vscode-sideBar-background) 82%, var(--vscode-editor-background)); }
    .queue-card.entering { animation: itemEnter var(--motion-medium) var(--motion-ease-out) both; }
    .queue-row { display: flex; min-width: 0; align-items: center; gap: 8px; padding: 8px 9px; }
    .queue-index { flex: none; color: var(--vscode-descriptionForeground); font-size: 10px; }
    .queue-copy { min-width: 0; flex: 1; }
    .queue-text { overflow: hidden; color: var(--vscode-foreground); font-size: 12px; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
    .queue-meta { margin-top: 2px; overflow: hidden; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
    .queue-actions { display: flex; flex: none; align-items: center; gap: 2px; }
    button.queue-action { padding: 4px 6px; color: var(--vscode-descriptionForeground); background: transparent; font-size: 11px; }
    button.queue-action:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    button.queue-steer { color: var(--vscode-foreground); font-weight: 600; }
    .queue-editor { display: grid; gap: 7px; padding: 8px 9px 9px; border-top: 1px solid var(--vscode-panel-border); }
    .queue-editor textarea { min-height: 58px; padding: 7px 8px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); resize: vertical; }
    .queue-editor-actions { display: flex; justify-content: flex-end; gap: 5px; }
    .queue-editor-actions button { padding: 4px 8px; font-size: 11px; }
    footer { padding: 8px 10px 10px; background: var(--vscode-sideBar-background); border-top: 1px solid var(--vscode-panel-border); }
    .composer { position: relative; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 9px; background: var(--vscode-input-background); padding: 8px 8px 7px; transition: border-color var(--motion-fast) ease, box-shadow var(--motion-medium) ease; }
    .composer:focus-within { border-color: var(--vscode-focusBorder); box-shadow: 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder) 22%, transparent); }
    textarea, input { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 5px; padding: 7px 8px; outline: none; }
    textarea { display: block; width: 100%; min-height: 48px; max-height: 150px; resize: none; border: 0; padding: 1px; }
    textarea:focus, input:focus { border-color: var(--vscode-focusBorder); }
    .composerbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 6px; }
    .pickers { display: flex; align-items: center; min-width: 0; gap: 2px; }
    .picker { min-width: 0; max-width: 150px; color: var(--vscode-descriptionForeground); background: transparent; border: 0; border-radius: 5px; padding: 3px 20px 3px 5px; outline: none; cursor: pointer; font-size: 11px; text-overflow: ellipsis; }
    .picker:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    .picker:focus { color: var(--vscode-foreground); outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .picker:disabled { opacity: .5; cursor: default; }
    #effort { max-width: 105px; }
    .send { min-width: 34px; border-radius: 7px; font-weight: 700; }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; animation: none !important; transition: none !important; }
    }
  </style>
</head>
<body>
  <div id="app">
    <header>
      <div class="topline"><span id="dot" class="dot"></span><button id="back" class="icon" title="Return to host or join">← Back</button><span class="brand">MultiCode</span><button id="copy" class="icon" title="Copy invite token">Copy invite</button><button id="stop" class="icon" title="Stop or leave room">Stop</button><button id="output" class="icon" title="Open raw output">Logs</button></div>
      <div id="room" class="room">Not connected</div>
    </header>
    <div><div id="people"></div><div id="queue"></div></div>
    <main id="conversation"></main>
    <footer>
      <div class="composer">
        <textarea id="prompt" placeholder="Ask the agent or describe a change…" aria-label="Prompt"></textarea>
        <div class="composerbar">
          <div class="pickers">
            <select id="model" class="picker" aria-label="Model" title="Model"></select>
            <select id="effort" class="picker" aria-label="Reasoning level" title="Reasoning level"></select>
          </div>
          <button id="send" class="send" title="Send prompt (Enter)">↑</button>
        </div>
      </div>
    </footer>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const elements = Object.fromEntries(['dot','back','room','people','queue','conversation','prompt','model','effort','send','copy','stop','output'].map(id => [id, document.getElementById(id)]));
    let state = { connection: 'idle', participants: [], queue: [], activeTurnIds: [], timeline: [] };
    const savedComposer = vscode.getState() || {};
    let selectedModel = typeof savedComposer.model === 'string' ? savedComposer.model : '';
    let selectedEffort = typeof savedComposer.effort === 'string' ? savedComposer.effort : '';
    let joinVisible = false;
    let editingQueuePromptId = '';
    let queuedPromptDraft = '';
    const expandedActivities = new Set();
    const collapsedActivities = new Set();
    const expandedSteps = new Set();
    const collapsedChangeCards = new Set();
    const expandedDiffFiles = new Set();
    const collapsedSteps = new Set();
    const seenActivitySteps = new Set();
    const seenTimelineItems = new Set();
    const seenQueueItems = new Set();
    const seenParticipants = new Set();
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let liveTimerTimeout;
    let conversationRenderVersion = 0;
    let scrollAnimationFrame;

    const post = (type, extra = {}) => vscode.postMessage({ type, ...extra });
    const node = (tag, className, text) => { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; };
    const markdownNode = (className, html) => { const value = node('div', className); value.innerHTML = html || ''; return value; };
    const enterOnce = (element, seen, key) => {
      if (seen.has(key)) return;
      seen.add(key);
      element.classList.add('entering');
    };
    const restoreSummaryAnchor = (summary, anchorTop) => {
      const shift = summary.getBoundingClientRect().top - anchorTop;
      if (Math.abs(shift) > 0.5) elements.conversation.scrollTop += shift;
    };
    const toggleDetailsInPlace = (event, details, summary) => {
      event.preventDefault();
      const opening = details.dataset.motionOpen === undefined
        ? !details.open
        : details.dataset.motionOpen !== 'true';
      details.dataset.motionOpen = String(opening);
      const anchorTop = summary.getBoundingClientRect().top;
      summary.focus({ preventScroll: true });
      const startHeight = details.getBoundingClientRect().height;
      details.getAnimations().forEach(animation => animation.cancel());
      if (opening) details.open = true;
      const endHeight = opening ? details.scrollHeight : summary.getBoundingClientRect().height;
      if (reducedMotion.matches || Math.abs(endHeight - startHeight) < 1) {
        details.open = opening;
        delete details.dataset.motionOpen;
        restoreSummaryAnchor(summary, anchorTop);
        return opening;
      }
      details.style.overflow = 'hidden';
      details.style.height = startHeight + 'px';
      const animation = details.animate(
        [{ height: startHeight + 'px' }, { height: endHeight + 'px' }],
        { duration: opening ? 210 : 170, easing: 'cubic-bezier(.2, .8, .2, 1)' },
      );
      const cleanup = () => {
        if (!opening) details.open = false;
        if (details.dataset.motionOpen === String(opening)) delete details.dataset.motionOpen;
        details.style.removeProperty('height');
        details.style.removeProperty('overflow');
        restoreSummaryAnchor(summary, anchorTop);
      };
      animation.addEventListener('finish', cleanup, { once: true });
      animation.addEventListener('cancel', () => {
        details.style.removeProperty('height');
        details.style.removeProperty('overflow');
      }, { once: true });
      return opening;
    };
    const togglePreviewInPlace = (preview, row) => {
      const opening = preview.dataset.motionOpen === undefined
        ? preview.hidden
        : preview.dataset.motionOpen !== 'true';
      preview.dataset.motionOpen = String(opening);
      const startHeight = preview.getBoundingClientRect().height;
      preview.getAnimations().forEach(animation => animation.cancel());
      if (opening) preview.hidden = false;
      const endHeight = opening ? Math.min(preview.scrollHeight, 390) : 0;
      row.setAttribute('aria-expanded', String(opening));
      if (reducedMotion.matches) {
        preview.hidden = !opening;
        delete preview.dataset.motionOpen;
        return opening;
      }
      preview.style.overflow = 'hidden';
      const animation = preview.animate(
        [
          { height: startHeight + 'px', opacity: opening ? 0 : 1 },
          { height: endHeight + 'px', opacity: opening ? 1 : 0 },
        ],
        { duration: opening ? 210 : 160, easing: 'cubic-bezier(.2, .8, .2, 1)' },
      );
      animation.addEventListener('finish', () => {
        preview.hidden = !opening;
        if (preview.dataset.motionOpen === String(opening)) delete preview.dataset.motionOpen;
        preview.style.removeProperty('overflow');
      }, { once: true });
      animation.addEventListener('cancel', () => preview.style.removeProperty('overflow'), { once: true });
      return opening;
    };
    const smoothScrollToBottom = box => {
      if (scrollAnimationFrame !== undefined) cancelAnimationFrame(scrollAnimationFrame);
      if (reducedMotion.matches) {
        box.scrollTop = box.scrollHeight;
        return;
      }
      const start = box.scrollTop;
      const target = Math.max(0, box.scrollHeight - box.clientHeight);
      const distance = target - start;
      if (Math.abs(distance) < 1) return;
      const startedAt = performance.now();
      const duration = Math.min(240, Math.max(140, Math.abs(distance) * 0.45));
      const tick = now => {
        const progress = Math.min(1, (now - startedAt) / duration);
        const eased = 1 - Math.pow(1 - progress, 3);
        box.scrollTop = start + distance * eased;
        if (progress < 1) scrollAnimationFrame = requestAnimationFrame(tick);
        else scrollAnimationFrame = undefined;
      };
      scrollAnimationFrame = requestAnimationFrame(tick);
    };
    const initials = name => name.split(/\\s+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join('') || '?';
    const isActivity = item => item.kind === 'reasoning' || item.kind === 'command';
    const isFailure = item => item.kind === 'command' && item.status?.startsWith('exit');
    const elapsed = milliseconds => {
      const seconds = Math.max(0, Math.floor((milliseconds || 0) / 1000));
      if (seconds < 60) return seconds + 's';
      const minutes = Math.floor(seconds / 60);
      return minutes + 'm ' + (seconds % 60) + 's';
    };
    const shortCommand = command => {
      const compact = (command || 'command').replace(/\\s+/g, ' ').trim();
      return compact.length > 72 ? compact.slice(0, 69) + '…' : compact;
    };
    const messageTime = timestamp => {
      const date = new Date(timestamp);
      if (!Number.isFinite(date.getTime())) return { short: '', full: '' };
      return {
        short: new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date),
        full: new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long' }).format(date),
      };
    };
    const commandPresentation = (command, running) => {
      const compact = shortCommand(command);
      const lower = compact.toLowerCase();
      const isRead = ['cat ', 'sed ', 'head ', 'tail ', 'bat '].some(prefix => lower.startsWith(prefix) || lower.includes(' ' + prefix));
      const pathToken = compact.split(' ').find(token => token.includes('/') && token.includes('.'));
      const cleanPath = pathToken?.replace(/^['\"]+|['\",;:)]+$/g, '');
      const fileName = cleanPath?.split('/').pop();
      if (isRead && fileName) return { glyph: 'read', label: (running ? 'Reading ' : 'Read ') + fileName };
      const rgIndex = lower.startsWith('rg ') ? 0 : lower.indexOf(' rg ');
      if (rgIndex >= 0) {
        const afterRg = compact.slice(rgIndex + (rgIndex === 0 ? 3 : 4));
        const query = afterRg.split(' ').find(token => token && !token.startsWith('-'))?.replace(/^['\"]+|['\",;]+$/g, '');
        return { glyph: 'search', label: (running ? 'Searching for ' : 'Searched for ') + (query || 'matches') };
      }
      return { glyph: 'terminal', label: (running ? 'Running ' : 'Ran ') + compact };
    };
    const activityPresentation = (item, running) => item.kind === 'reasoning'
      ? { glyph: 'thinking', label: running ? 'Thinking' : 'Thought' }
      : commandPresentation(item.command, running);
    const activityGlyph = kind => {
      const glyph = node('span', 'activity-glyph ' + kind);
      glyph.setAttribute('aria-hidden', 'true');
      const icons = {
        read: '<svg viewBox="0 0 18 18"><path d="M2.5 3.2c2-.1 3.6.5 5 1.7v10c-1.4-1.2-3-1.8-5-1.7zM15.5 3.2c-2-.1-3.6.5-5 1.7v10c1.4-1.2 3-1.8 5-1.7zM9 5v10"/></svg>',
        search: '<svg viewBox="0 0 18 18"><circle cx="7.5" cy="7.5" r="4.8"/><path d="m11 11 4 4"/></svg>',
        terminal: '<svg viewBox="0 0 18 18"><rect x="2" y="3" width="14" height="12" rx="2"/><path d="m5 7 2 2-2 2M9.5 11h3"/></svg>',
        thinking: '<svg viewBox="0 0 18 18"><path d="M9 2.5v2M9 13.5v2M2.5 9h2M13.5 9h2M4.4 4.4l1.4 1.4M12.2 12.2l1.4 1.4M13.6 4.4l-1.4 1.4M5.8 12.2l-1.4 1.4"/><circle cx="9" cy="9" r="2.6"/></svg>',
      };
      glyph.innerHTML = icons[kind] || icons.terminal;
      return glyph;
    };
    const syncLiveTimers = () => {
      if (liveTimerTimeout !== undefined) clearTimeout(liveTimerTimeout);
      const tick = () => {
        const timers = document.querySelectorAll('.activity-timer[data-started-at]');
        if (!timers.length) { liveTimerTimeout = undefined; return; }
        const now = Date.now();
        let nextTick = 1000;
        for (const timer of timers) {
          const startedAt = Number(timer.dataset.startedAt);
          if (!Number.isFinite(startedAt)) continue;
          const runningFor = Math.max(0, now - startedAt);
          timer.textContent = 'for ' + elapsed(runningFor);
          nextTick = Math.min(nextTick, 1000 - (runningFor % 1000));
        }
        liveTimerTimeout = setTimeout(tick, Math.max(50, nextTick));
      };
      tick();
    };

    const effortLabel = effort => ({ none: 'None', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' })[effort] || effort;
    const rememberComposer = () => vscode.setState({ model: selectedModel, effort: selectedEffort });

    function renderModelControls() {
      const config = state.agentConfig;
      const models = Array.isArray(config?.models) ? config.models : [];
      if (!selectedModel) selectedModel = config?.model || models.find(model => model.isDefault)?.model || models[0]?.model || '';
      if (models.length && !models.some(model => model.model === selectedModel)) selectedModel = config?.model || models.find(model => model.isDefault)?.model || models[0]?.model || '';

      elements.model.replaceChildren();
      if (!models.length) {
        const fallbackModel = config?.model || selectedModel || '';
        const option = node('option', '', fallbackModel || 'Default model'); option.value = fallbackModel;
        elements.model.append(option);
      } else {
        for (const model of models) {
          const option = node('option', '', model.displayName); option.value = model.model; option.title = model.description || model.displayName;
          elements.model.append(option);
        }
      }
      elements.model.value = selectedModel;
      elements.model.title = models.find(model => model.model === selectedModel)?.description || 'Model';
      elements.model.style.display = config?.capabilities?.modelSelection === false ? 'none' : '';

      const selected = models.find(model => model.model === selectedModel);
      const efforts = selected?.supportedReasoningEfforts?.length
        ? selected.supportedReasoningEfforts
        : ['low', 'medium', 'high', 'xhigh'].map(reasoningEffort => ({ reasoningEffort, description: '' }));
      if (!selectedEffort || !efforts.some(option => option.reasoningEffort === selectedEffort)) {
        selectedEffort = (selectedModel === config?.model ? config?.effort : undefined) || selected?.defaultReasoningEffort || efforts[0]?.reasoningEffort || '';
      }
      elements.effort.replaceChildren();
      for (const effort of efforts) {
        const option = node('option', '', effortLabel(effort.reasoningEffort)); option.value = effort.reasoningEffort; option.title = effort.description || effortLabel(effort.reasoningEffort);
        elements.effort.append(option);
      }
      elements.effort.value = selectedEffort;
      elements.effort.title = efforts.find(option => option.reasoningEffort === selectedEffort)?.description || 'Reasoning level';
      elements.effort.style.display = config?.capabilities?.effortSelection === false ? 'none' : '';
      const enabled = state.connection === 'connected';
      elements.model.disabled = !enabled;
      elements.effort.disabled = !enabled || !efforts.length;
      rememberComposer();
    }

    function renderPeople() {
      elements.people.replaceChildren();
      if (!state.participants.length) { elements.people.style.display = 'none'; return; }
      elements.people.style.display = 'flex';
      for (const person of state.participants) {
        const chip = node('span', 'person');
        enterOnce(chip, seenParticipants, person.name);
        chip.append(node('span', 'avatar', initials(person.name)), node('span', '', person.name));
        if (person.host) chip.append(node('span', 'host', '◆'));
        chip.title = person.host ? 'Host' : (person.synced ? 'Synchronized' : 'Synchronizing');
        elements.people.append(chip);
      }
    }

    function renderQueue() {
      const count = state.queue.length;
      elements.queue.className = count ? 'visible' : '';
      elements.queue.replaceChildren();
      if (!count) { editingQueuePromptId = ''; queuedPromptDraft = ''; return; }
      if (editingQueuePromptId && !state.queue.some(item => item.id === editingQueuePromptId)) { editingQueuePromptId = ''; queuedPromptDraft = ''; }

      const head = node('div', 'queue-head');
      head.append(node('strong', '', count + (count === 1 ? ' prompt queued' : ' prompts queued')), node('span', '', 'Runs in order'));
      const list = node('div', 'queue-list');
      state.queue.forEach((item, index) => {
        const card = node('div', 'queue-card');
        enterOnce(card, seenQueueItems, item.id);
        const row = node('div', 'queue-row');
        row.append(node('span', 'queue-index', String(index + 1)));
        const copy = node('div', 'queue-copy');
        copy.append(node('div', 'queue-text', item.text));
        const settings = [item.name, item.model, item.effort ? effortLabel(item.effort) : ''].filter(Boolean).join(' · ');
        copy.append(node('div', 'queue-meta', settings));
        row.append(copy);

        if (item.owned) {
          const actions = node('div', 'queue-actions');
          const edit = node('button', 'queue-action', 'Edit');
          edit.title = 'Edit queued prompt';
          edit.addEventListener('click', () => { editingQueuePromptId = item.id; queuedPromptDraft = item.text; renderQueue(); });
          const remove = node('button', 'queue-action', '×');
          remove.title = 'Remove queued prompt';
          remove.setAttribute('aria-label', 'Remove queued prompt');
          remove.addEventListener('click', () => post('queueRemove', { promptId: item.id }));
          if (state.agentConfig?.capabilities?.steering !== false) {
            const steer = node('button', 'queue-action queue-steer', '↪ Steer');
            steer.title = state.activeTurnIds?.length ? 'Send this prompt into the active turn' : 'Steer is available while the agent is working';
            steer.disabled = !state.activeTurnIds?.length;
            steer.addEventListener('click', () => post('queueSteer', { promptId: item.id }));
            actions.append(steer);
          }
          actions.append(edit, remove);
          row.append(actions);
        }
        card.append(row);

        if (item.owned && editingQueuePromptId === item.id) {
          const editor = node('div', 'queue-editor');
          const textarea = node('textarea');
          textarea.value = queuedPromptDraft;
          textarea.setAttribute('aria-label', 'Edit queued prompt');
          textarea.addEventListener('input', () => { queuedPromptDraft = textarea.value; save.disabled = !queuedPromptDraft.trim(); });
          const editorActions = node('div', 'queue-editor-actions');
          const cancel = node('button', 'secondary', 'Cancel');
          cancel.addEventListener('click', () => { editingQueuePromptId = ''; queuedPromptDraft = ''; renderQueue(); });
          const save = node('button', '', 'Save');
          save.disabled = !queuedPromptDraft.trim();
          save.addEventListener('click', () => {
            const text = queuedPromptDraft.trim();
            if (!text) return;
            post('queueUpdate', { promptId: item.id, text, model: item.model, effort: item.effort });
            editingQueuePromptId = ''; queuedPromptDraft = ''; renderQueue();
          });
          editorActions.append(cancel, save);
          editor.append(textarea, editorActions);
          card.append(editor);
          requestAnimationFrame(() => textarea.focus({ preventScroll: true }));
        }
        list.append(card);
      });
      elements.queue.append(head, list);
    }

    function renderActivity(items) {
      const runningCommand = items.find(item => item.kind === 'command' && item.status === 'running');
      const turnRunning = items.some(item => item.turnId && state.activeTurnIds?.includes(item.turnId));
      const running = Boolean(turnRunning || runningCommand || items.some(item => item.status === 'running'));
      const failed = items.some(isFailure);
      const startedAt = Math.min(...items.map(item => Date.parse(item.startedAt || item.timestamp)).filter(Number.isFinite));
      const finishedTimes = items.map(item => Date.parse(item.finishedAt || '')).filter(Number.isFinite);
      const finishedAt = finishedTimes.length ? Math.max(...finishedTimes) : undefined;
      const duration = finishedAt === undefined || !Number.isFinite(startedAt) ? undefined : elapsed(finishedAt - startedAt);
      const activityId = 'activity:' + (items[0]?.turnId || items[0]?.id || 'unknown');
      const details = node('details', 'activity-card ' + (running ? 'running' : 'completed') + (failed ? ' failed' : ''));
      details.dataset.activityId = activityId;
      if (running && Number.isFinite(startedAt)) {
        const runningFor = Math.max(0, Date.now() - startedAt);
        details.style.setProperty('--active-text-delay', '-' + (runningFor % 1800) + 'ms');
        details.style.setProperty('--active-glyph-delay', '-' + (runningFor % 1600) + 'ms');
      }
      if ((running && !collapsedActivities.has(activityId)) || (!running && expandedActivities.has(activityId))) details.setAttribute('open', '');

      let label = running ? 'Working' : (duration ? 'Worked for ' + duration : 'Worked');
      if (failed) label += ' · command failed';
      const summary = node('summary');
      summary.setAttribute('aria-label', label + (details.open ? ', hide activity' : ', show activity'));
      summary.append(activityGlyph('thinking'), node('span', 'activity-label', label));
      if (running && Number.isFinite(startedAt)) {
        const timer = node('span', 'activity-timer', 'for ' + elapsed(Date.now() - startedAt));
        timer.dataset.startedAt = String(startedAt);
        timer.setAttribute('aria-hidden', 'true');
        summary.append(timer);
      }
      summary.append(node('span', 'activity-chevron', '▶'));
      const rememberActivityOpen = open => {
        if (open) {
          expandedActivities.add(activityId);
          collapsedActivities.delete(activityId);
        } else {
          expandedActivities.delete(activityId);
          collapsedActivities.add(activityId);
        }
      };
      summary.addEventListener('click', event => {
        const opening = toggleDetailsInPlace(event, details, summary);
        rememberActivityOpen(opening);
      });
      details.addEventListener('toggle', () => {
        rememberActivityOpen(details.open);
        summary.setAttribute('aria-label', label + (details.open ? ', hide activity' : ', show activity'));
      });

      const steps = node('div', 'activity-steps');
      for (const item of items) {
        const stepFailed = isFailure(item);
        const stepRunning = item.status === 'running';
        const entering = !seenActivitySteps.has(item.id);
        const step = node('details', 'activity-step' + (stepFailed ? ' failed' : '') + (stepRunning ? ' running' : '') + (entering ? ' entering' : ''));
        seenActivitySteps.add(item.id);
        if (stepRunning) {
          const stepStartedAt = Date.parse(item.startedAt || item.timestamp);
          if (Number.isFinite(stepStartedAt)) {
            const runningFor = Math.max(0, Date.now() - stepStartedAt);
            step.style.setProperty('--active-text-delay', '-' + (runningFor % 1800) + 'ms');
            step.style.setProperty('--active-glyph-delay', '-' + (runningFor % 1600) + 'ms');
          }
        }
        if ((stepFailed && !collapsedSteps.has(item.id)) || expandedSteps.has(item.id)) step.setAttribute('open', '');

        const stepPresentation = activityPresentation(item, stepRunning);
        let stepLabel = stepPresentation.label;
        if (stepFailed) stepLabel = 'Failed ' + shortCommand(item.command) + ' · ' + item.status;
        else if (!stepRunning && item.kind === 'command' && item.durationMs !== undefined) stepLabel += ' · ' + elapsed(item.durationMs);

        const stepSummary = node('summary');
        stepSummary.append(
          activityGlyph(stepPresentation.glyph),
          node('span', 'step-label', stepLabel),
          node('span', 'step-chevron', '▶'),
        );
        const rememberStepOpen = open => {
          if (open) {
            expandedSteps.add(item.id);
            collapsedSteps.delete(item.id);
          } else {
            expandedSteps.delete(item.id);
            collapsedSteps.add(item.id);
          }
        };
        stepSummary.addEventListener('click', event => {
          const opening = toggleDetailsInPlace(event, step, stepSummary);
          rememberStepOpen(opening);
        });
        step.addEventListener('toggle', () => rememberStepOpen(step.open));
        const body = item.text || (item.kind === 'command' ? (stepRunning ? 'Waiting for output…' : 'Command completed without output.') : 'No reasoning summary.');
        step.append(stepSummary, item.kind === 'reasoning'
          ? markdownNode('step-markdown markdown', item.markdownHtml)
          : node('pre', 'step-output', body));
        steps.append(step);
      }
      details.append(summary, steps);
      return details;
    }

    function renderItem(item) {
      const wrap = node('article', 'item ' + item.kind);
      wrap.dataset.timelineKey = item.id;
      enterOnce(wrap, seenTimelineItems, item.id);
      if (item.kind === 'input') {
        const request = item.input;
        const main = node('div', 'input-main');
        const head = node('div', 'approval-head');
        head.append(node('span', 'approval-kind', 'Agent question'));
        if (item.status && item.status !== 'pending') head.append(node('span', 'approval-status', item.status));
        main.append(head);
        const controls = [];
        for (const question of request?.questions || []) {
          const section = node('div', 'input-question');
          section.append(node('strong', '', question.question));
          const group = [];
          for (const option of question.options || []) {
            const label = node('label', 'input-option');
            const control = document.createElement('input');
            control.type = question.multiSelect ? 'checkbox' : 'radio';
            control.name = 'question-' + question.id;
            control.value = option.label;
            const copy = node('span', '', option.label);
            if (option.description) copy.append(node('small', '', option.description));
            label.append(control, copy); section.append(label); group.push(control);
          }
          let freeform;
          if (question.allowFreeform) {
            freeform = node('textarea', 'input-freeform');
            freeform.placeholder = 'Or type another answer';
            section.append(freeform);
          }
          controls.push({ question, group, freeform }); main.append(section);
        }
        wrap.append(main);
        if (request && state.canApprove && item.status === 'pending') {
          const actions = node('div', 'input-actions');
          const cancel = node('button', 'secondary', 'Cancel'); cancel.onclick = () => post('input', { requestId: request.requestId, answers: null });
          const submit = node('button', '', 'Submit'); submit.onclick = () => {
            const answers = {};
            for (const entry of controls) {
              const selected = entry.group.filter(control => control.checked).map(control => control.value);
              const freeform = entry.freeform?.value.trim();
              if (freeform) answers[entry.question.id] = freeform;
              else if (entry.question.multiSelect) answers[entry.question.id] = selected;
              else if (selected[0]) answers[entry.question.id] = selected[0];
            }
            post('input', { requestId: request.requestId, answers });
          };
          actions.append(cancel, submit); wrap.append(actions);
        } else if (item.status === 'pending') wrap.append(node('div', 'approval-waiting', 'Waiting for a reviewer to answer…'));
        return wrap;
      }
      if (item.kind === 'approval') {
        const approval = item.approval || {};
        const command = approval.command;
        const cwd = approval.cwd;
        const reason = approval.reason;
        const commandRequest = typeof command === 'string' && command.length > 0;
        const main = node('div', 'approval-main');
        const head = node('div', 'approval-head');
        const icon = node('span', 'approval-icon');
        icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = commandRequest
          ? '<svg viewBox="0 0 18 18"><rect x="2" y="3" width="14" height="12" rx="2"/><path d="m5 7 2 2-2 2M9.5 11h3"/></svg>'
          : '<svg viewBox="0 0 18 18"><path d="M9 2.5 15 5v4.2c0 3.2-2.2 5.4-6 6.3-3.8-.9-6-3.1-6-6.3V5z"/><path d="M9 6v3.5M9 12.5h.01"/></svg>';
        const agentName = state.agentConfig?.displayName || 'Agent';
        head.append(icon, node('span', 'approval-kind', commandRequest ? 'Command approval' : agentName + ' approval'));
        if (item.status && item.status !== 'pending') head.append(node('span', 'approval-status', item.status));
        main.append(head, node('div', 'approval-title', commandRequest ? 'Allow ' + agentName + ' to run this command?' : 'Allow ' + agentName + ' to continue?'));
        if (cwd) {
          const cwdNode = node('div', 'approval-cwd', cwd);
          cwdNode.title = cwd;
          main.append(cwdNode);
        }
        if (commandRequest) main.append(node('pre', 'approval-command', command));
        if (reason) {
          const reasonNode = node('div', 'approval-reason');
          reasonNode.append(node('span', 'approval-reason-label', 'Reason'), document.createTextNode(reason));
          main.append(reasonNode);
        } else if (!commandRequest) {
          main.append(node('div', 'approval-reason', item.text));
        }
        wrap.append(main);
        if (item.approval && state.canApprove && item.status === 'pending') {
          const actions = node('div', 'approval-actions');
          const cancel = node('button', 'approval-cancel', 'Cancel turn'); cancel.onclick = () => post('approval', { requestId: item.approval.requestId, decision: 'cancel' });
          const right = node('div', 'approval-actions-right');
          const deny = node('button', 'approval-deny', 'Deny'); deny.onclick = () => post('approval', { requestId: item.approval.requestId, decision: 'decline' });
          const allow = node('button', 'approval-allow', 'Allow once'); allow.onclick = () => post('approval', { requestId: item.approval.requestId, decision: 'accept' });
          right.append(deny, allow); actions.append(cancel, right); wrap.append(actions);
        } else if (item.status === 'pending') {
          wrap.append(node('div', 'approval-waiting', 'Waiting for host approval…'));
        }
        return wrap;
      }
      if (item.kind === 'user' || item.kind === 'assistant') {
        const meta = node('div', 'meta');
        meta.append(node('strong', '', item.title || (item.kind === 'assistant' ? (state.agentConfig?.displayName || 'Agent') : 'You')));
        if (item.status && item.status !== 'completed') meta.append(node('span', '', item.status));
        const formattedTime = messageTime(item.timestamp);
        const time = node('time', 'message-time', formattedTime.short);
        time.dateTime = item.timestamp;
        time.title = formattedTime.full;
        time.setAttribute('aria-label', formattedTime.full ? 'Sent ' + formattedTime.full : 'Message time unavailable');
        wrap.append(meta, markdownNode('bubble markdown', item.markdownHtml), time);
        return wrap;
      }
      if (item.kind === 'diff') {
        if (item.changes?.files?.length) {
          const details = node('details', 'change-card');
          if (!collapsedChangeCards.has(item.id)) details.setAttribute('open', '');
          const summary = node('summary');
          const fileCount = item.changes.files.length;
          const overview = node('div', 'change-overview');
          overview.append(node('div', 'change-title', 'Edited ' + fileCount + ' file' + (fileCount === 1 ? '' : 's')));
          const totals = node('div', 'change-totals');
          totals.append(node('span', 'additions', '+' + item.changes.additions), node('span', 'deletions', '-' + item.changes.deletions));
          overview.append(totals);
          const review = node('button', 'change-review', 'Review');
          review.title = 'Open Source Control';
          review.onclick = event => { event.preventDefault(); event.stopPropagation(); post('reviewChanges'); };
          summary.append(node('span', 'change-icon', '±'), overview, review);
          summary.addEventListener('click', event => {
            const opening = toggleDetailsInPlace(event, details, summary);
            if (opening) collapsedChangeCards.delete(item.id);
            else collapsedChangeCards.add(item.id);
          });
          details.addEventListener('toggle', () => {
            if (details.open) collapsedChangeCards.delete(item.id);
            else collapsedChangeCards.add(item.id);
          });
          const files = node('div', 'change-files');
          const diffTemplate = node('div');
          diffTemplate.innerHTML = item.diffHtml || '';
          const diffSections = new Map([...diffTemplate.querySelectorAll('.diff-file-preview')].map(section => [section.querySelector('.diff-file-heading')?.textContent || '', section]));
          for (const file of item.changes.files) {
            const entry = node('div', 'change-file-entry');
            const row = node('button', 'change-file');
            const diffSection = diffSections.get(file.path);
            row.title = diffSection ? 'Show diff for ' + file.path : 'Open ' + file.path;
            const separator = file.path.lastIndexOf('/');
            const pathLabel = node('span', 'change-path');
            if (separator >= 0) pathLabel.append(node('span', 'change-file-dir', file.path.slice(0, separator + 1)));
            pathLabel.append(node('span', 'change-file-name', file.path.slice(separator + 1)));
            row.append(pathLabel);
            if (file.binary) row.append(node('span', 'change-binary', 'binary'));
            else row.append(node('span', 'change-count additions', '+' + file.additions), node('span', 'change-count deletions', '-' + file.deletions));
            if (diffSection) {
              const previewKey = item.id + ':' + file.path;
              const preview = node('div', 'diff-preview change-file-preview');
              preview.append(diffSection.cloneNode(true));
              const setPreviewOpen = open => {
                preview.hidden = !open;
                row.setAttribute('aria-expanded', String(open));
                if (open) expandedDiffFiles.add(previewKey); else expandedDiffFiles.delete(previewKey);
              };
              setPreviewOpen(expandedDiffFiles.has(previewKey));
              row.onclick = event => {
                event.preventDefault(); event.stopPropagation();
                const anchorTop = row.getBoundingClientRect().top;
                const opening = togglePreviewInPlace(preview, row);
                if (opening) expandedDiffFiles.add(previewKey); else expandedDiffFiles.delete(previewKey);
                row.focus({ preventScroll: true });
                const restoreAnchor = () => { elements.conversation.scrollTop += row.getBoundingClientRect().top - anchorTop; };
                restoreAnchor(); requestAnimationFrame(restoreAnchor);
              };
              entry.append(row, preview);
            } else {
              row.onclick = event => { event.preventDefault(); event.stopPropagation(); post('openChangedFile', { file: file.path }); };
              entry.append(row);
            }
            files.append(entry);
          }
          const truncatedNotice = diffTemplate.querySelector('.diff-preview-truncated');
          if (truncatedNotice) files.append(truncatedNotice.cloneNode(true));
          details.append(summary, files);
          wrap.append(details);
          return wrap;
        }
        const details = node('details', 'card');
        details.open = item.status === 'running';
        const label = (item.title || item.kind) + (item.status && item.status !== 'completed' ? ' · ' + item.status : '');
        const summary = node('summary', '', label);
        summary.addEventListener('click', event => toggleDetailsInPlace(event, details, summary));
        details.append(summary, node('pre', '', item.text));
        wrap.append(details);
        return wrap;
      }
      const icon = item.kind === 'error' ? '×' : item.kind === 'approval' ? '!' : '•';
      wrap.append(node('span', '', icon), node('span', '', (item.title ? item.title + ': ' : '') + item.text));
      return wrap;
    }

    function renderEmpty() {
      const empty = node('section', 'empty');
      const logo = node('img', 'empty-logo');
      logo.src = '${squareLogoUri}';
      logo.alt = '';
      logo.setAttribute('aria-hidden', 'true');
      empty.append(logo, node('h2', '', 'Code together with an agent'), node('p', '', 'Host a Codex or Claude room, or join a teammate’s session.'));
      const actions = node('div', 'actions');
      const host = node('button', '', 'Host room'); host.onclick = () => post('host');
      const join = node('button', 'secondary', 'Join room'); join.onclick = () => { joinVisible = !joinVisible; renderConversation(); };
      actions.append(host, join); empty.append(actions);
      const form = node('div', 'join-form' + (joinVisible ? ' visible' : ''));
      const input = node('input'); input.placeholder = 'XXXXX-XXXXX.room-secret';
      const submit = node('button', '', 'Join'); submit.onclick = () => post('join', { token: input.value });
      input.onkeydown = event => { if (event.key === 'Enter') submit.click(); };
      form.append(input, submit); empty.append(form);
      return empty;
    }

    function renderConversation() {
      const box = elements.conversation;
      const renderVersion = ++conversationRenderVersion;
      const previousScrollTop = box.scrollTop;
      const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
      const previousRects = new Map([...box.children]
        .filter(child => child.dataset.timelineKey)
        .map(child => [child.dataset.timelineKey, child.getBoundingClientRect()]));
      const anchor = [...box.children].find(child => child.offsetTop + child.offsetHeight > previousScrollTop);
      const anchorKey = anchor?.dataset.timelineKey;
      const anchorOffset = anchor ? anchor.offsetTop - previousScrollTop : 0;
      box.replaceChildren();
      if (state.connection === 'idle' && state.timeline.length <= 1) box.append(renderEmpty());
      else {
        for (let index = 0; index < state.timeline.length;) {
          const item = state.timeline[index];
          if (!isActivity(item)) {
            box.append(renderItem(item));
            index += 1;
            continue;
          }
          const activity = [item];
          let next = index + 1;
          while (next < state.timeline.length && isActivity(state.timeline[next]) && (!item.turnId || !state.timeline[next].turnId || state.timeline[next].turnId === item.turnId)) {
            activity.push(state.timeline[next]);
            next += 1;
          }
          const wrap = node('article', 'item activity');
          const activityKey = 'activity:' + (activity[0]?.turnId || activity[0]?.id || 'unknown');
          wrap.dataset.timelineKey = activityKey;
          enterOnce(wrap, seenTimelineItems, activityKey);
          wrap.append(renderActivity(activity));
          box.append(wrap);
          index = next;
        }
      }
      const restoreScroll = () => {
        if (renderVersion !== conversationRenderVersion) return;
        if (nearBottom) return;
        const restoredAnchor = anchorKey ? [...box.children].find(child => child.dataset.timelineKey === anchorKey) : undefined;
        box.scrollTop = restoredAnchor ? restoredAnchor.offsetTop - anchorOffset : previousScrollTop;
      };
      restoreScroll();
      requestAnimationFrame(() => {
        if (renderVersion !== conversationRenderVersion) return;
        if (nearBottom) {
          smoothScrollToBottom(box);
          return;
        }
        restoreScroll();
        if (reducedMotion.matches) return;
        for (const child of box.children) {
          const previousRect = previousRects.get(child.dataset.timelineKey);
          if (!previousRect || child.classList.contains('entering')) continue;
          const nextRect = child.getBoundingClientRect();
          const deltaY = previousRect.top - nextRect.top;
          if (Math.abs(deltaY) < 1 || Math.abs(deltaY) > box.clientHeight) continue;
          child.animate(
            [{ transform: 'translateY(' + deltaY + 'px)' }, { transform: 'translateY(0)' }],
            { duration: 180, easing: 'cubic-bezier(.2, .8, .2, 1)' },
          );
        }
      });
    }

    function render() {
      elements.dot.className = 'dot ' + state.connection;
      elements.room.textContent = state.connection === 'idle' ? 'Not connected' : (state.roomLabel || (state.mode === 'host' ? 'Starting room…' : 'Joining room…'));
      elements.back.style.display = state.canReturnToStart ? '' : 'none';
      elements.copy.style.display = state.mode === 'host' && state.connection === 'connected' ? '' : 'none';
      elements.stop.style.display = ['starting','connected','stopping','error'].includes(state.connection) ? '' : 'none';
      const enabled = state.connection === 'connected';
      elements.prompt.disabled = !enabled;
      elements.send.disabled = !enabled || !elements.prompt.value.trim();
      renderModelControls(); renderPeople(); renderQueue(); renderConversation(); syncLiveTimers();
    }

    function submitPrompt() {
      const text = elements.prompt.value.trim();
      if (!text || state.connection !== 'connected') return;
      post('submit', {
        text,
        model: selectedModel || undefined,
        effort: selectedEffort || undefined,
      }); elements.prompt.value = ''; elements.prompt.style.height = ''; elements.send.disabled = true;
    }

    elements.prompt.addEventListener('input', () => {
      elements.prompt.style.height = 'auto'; elements.prompt.style.height = Math.min(elements.prompt.scrollHeight, 150) + 'px';
      elements.send.disabled = state.connection !== 'connected' || !elements.prompt.value.trim();
    });
    elements.prompt.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submitPrompt(); } });
    elements.model.addEventListener('change', () => { selectedModel = elements.model.value; selectedEffort = ''; renderModelControls(); });
    elements.effort.addEventListener('change', () => { selectedEffort = elements.effort.value; rememberComposer(); });
    elements.send.onclick = submitPrompt;
    elements.back.onclick = () => { joinVisible = false; post('back'); };
    elements.copy.onclick = () => post('copyInvite');
    elements.stop.onclick = () => post('stop');
    elements.output.onclick = () => post('openOutput');
    elements.conversation.addEventListener('click', event => {
      const link = event.target instanceof Element ? event.target.closest('.markdown a[href]') : null;
      if (!link) return;
      const href = link.getAttribute('href');
      if (!href || href.startsWith('#')) return;
      event.preventDefault();
      post('openLink', { href });
    });
    window.addEventListener('message', event => {
      if (event.data?.type !== 'state') return;
      const nextState = event.data.state;
      if (state.timeline.length && !nextState.timeline.length) {
        seenTimelineItems.clear();
        seenActivitySteps.clear();
        seenQueueItems.clear();
        seenParticipants.clear();
      }
      state = nextState;
      render();
    });
    post('ready'); render();
  </script>
</body>
</html>`;
  }
}
