import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { RoomServerMessage } from "@multicode/protocol";
import type { ApprovalDecision } from "@multicode/protocol";
import { ChatModel } from "./chat-model.js";
import { renderChatMarkdown } from "./markdown.js";

export interface ChatActions {
  back(): void | Promise<void>;
  host(): void | Promise<void>;
  join(token?: string): void | Promise<void>;
  stop(): void | Promise<void>;
  submit(text: string, settings: { model?: string; effort?: string }): void | Promise<void>;
  approve(requestId: string | number, decision: ApprovalDecision): void | Promise<void>;
  copyInvite(): void | Promise<void>;
  openOutput(): void | Promise<void>;
}

type WebviewMessage =
  | { type: "ready" }
  | { type: "back" }
  | { type: "host" }
  | { type: "join"; token?: string }
  | { type: "stop" }
  | { type: "submit"; text?: string; model?: string; effort?: string }
  | { type: "approval"; requestId?: string | number; decision?: ApprovalDecision }
  | { type: "copyInvite" }
  | { type: "openOutput" }
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
      case "submit": {
        const text = message.text?.trim();
        if (text) await this.actions.submit(text, {
          ...(message.model?.trim() ? { model: message.model.trim() } : {}),
          ...(message.effort?.trim() ? { effort: message.effort.trim() } : {}),
        });
        break;
      }
    }
  }

  private publish(): void {
    if (this.disposed || !this.view) return;
    const state = this.model.snapshot();
    const renderedState = {
      ...state,
      timeline: state.timeline.map((item) => item.kind === "user" || item.kind === "assistant" || item.kind === "reasoning"
        ? { ...item, markdownHtml: renderChatMarkdown(item.text) }
        : item),
    };
    this.view.badge = state.connection === "connected" && state.participants.length > 0
      ? { value: state.participants.length, tooltip: `${state.participants.length} collaborator${state.participants.length === 1 ? "" : "s"}` }
      : undefined;
    void this.view.webview.postMessage({ type: "state", state: renderedState });
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(18).toString("base64");
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>MultiCode</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font: 13px/1.45 var(--vscode-font-family); overflow: hidden; }
    button, textarea, input, select { font: inherit; }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; border-radius: 5px; padding: 7px 11px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); }
    button.icon { padding: 5px 8px; background: transparent; color: var(--vscode-foreground); }
    button.icon:hover { background: var(--vscode-toolbar-hoverBackground); }
    button:disabled { opacity: .45; cursor: default; }
    #app { height: 100vh; display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto; }
    header { padding: 10px 12px 8px; border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border)); }
    .topline { display: flex; align-items: center; gap: 8px; }
    .brand { font-weight: 700; letter-spacing: .2px; flex: 1; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-disabledForeground); }
    .dot.connected { background: var(--vscode-testing-iconPassed); box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-testing-iconPassed) 18%, transparent); }
    .dot.starting, .dot.stopping { background: var(--vscode-debugIcon-startForeground); animation: pulse 1.2s infinite; }
    .dot.error { background: var(--vscode-testing-iconFailed); }
    @keyframes pulse { 50% { opacity: .35; } }
    .room { margin-top: 5px; color: var(--vscode-descriptionForeground); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #people { display: flex; align-items: center; gap: 5px; padding: 8px 12px; min-height: 40px; overflow-x: auto; border-bottom: 1px solid var(--vscode-panel-border); }
    .person { display: inline-flex; align-items: center; gap: 5px; padding: 3px 7px 3px 3px; border-radius: 999px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); white-space: nowrap; font-size: 11px; }
    .avatar { width: 20px; height: 20px; display: grid; place-items: center; border-radius: 50%; background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-weight: 700; }
    .host { color: var(--vscode-charts-yellow); margin-left: 1px; }
    #conversation { overflow-y: auto; padding: 12px 10px 22px; scroll-behavior: smooth; }
    .empty { height: 100%; display: grid; place-content: center; text-align: center; color: var(--vscode-descriptionForeground); padding: 24px; }
    .empty-logo { margin: 0 auto 12px; width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-size: 20px; font-weight: 800; }
    .empty h2 { color: var(--vscode-foreground); font-size: 15px; margin: 0 0 6px; }
    .empty p { margin: 0 0 14px; }
    .actions { display: flex; justify-content: center; gap: 8px; }
    .join-form { display: none; margin-top: 10px; gap: 6px; }
    .join-form.visible { display: flex; }
    .join-form input { min-width: 0; flex: 1; }
    .item { margin: 0 0 12px; }
    .meta { display: flex; align-items: center; gap: 6px; color: var(--vscode-descriptionForeground); font-size: 11px; margin: 0 3px 4px; }
    .meta strong { color: var(--vscode-foreground); }
    .bubble { border: 1px solid var(--vscode-panel-border); border-radius: 9px; padding: 9px 10px; overflow-wrap: anywhere; }
    .user .bubble { background: color-mix(in srgb, var(--vscode-button-background) 18%, transparent); border-color: color-mix(in srgb, var(--vscode-button-background) 45%, var(--vscode-panel-border)); }
    .assistant .bubble { background: var(--vscode-editor-background); }
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
    .markdown a { color: var(--vscode-textLink-foreground); text-decoration: none; }
    .markdown a:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
    .markdown hr { border: 0; border-top: 1px solid var(--vscode-panel-border); margin: 10px 0; }
    .markdown table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; margin: 7px 0; }
    .markdown th, .markdown td { padding: 4px 7px; border: 1px solid var(--vscode-panel-border); text-align: left; }
    details.card { border: 1px solid var(--vscode-panel-border); border-radius: 7px; background: var(--vscode-editor-background); }
    details.card summary { padding: 7px 9px; cursor: pointer; color: var(--vscode-descriptionForeground); user-select: none; }
    details.card pre { margin: 0; padding: 8px 9px; border-top: 1px solid var(--vscode-panel-border); white-space: pre-wrap; overflow-wrap: anywhere; font: 11px/1.45 var(--vscode-editor-font-family); max-height: 280px; overflow: auto; }
    details.activity-card { border: 0; background: transparent; }
    details.activity-card > summary { display: flex; align-items: center; gap: 6px; width: fit-content; max-width: 100%; padding: 4px; cursor: pointer; color: var(--vscode-descriptionForeground); user-select: none; }
    details.activity-card > summary::-webkit-details-marker, details.activity-step > summary::-webkit-details-marker { display: none; }
    .activity-chevron { display: inline-block; flex: none; color: var(--vscode-descriptionForeground); font-size: 10px; transition: transform 120ms ease; }
    details.activity-card[open] > summary .activity-chevron, details.activity-step[open] > summary .step-chevron { transform: rotate(90deg); }
    .activity-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-weight: 600; }
    .activity-card.running .activity-label { animation: thinkingPulse 1.4s ease-in-out infinite; }
    .thinking-dots { display: inline-flex; gap: 2px; margin-left: -3px; }
    .thinking-dots span { width: 2px; height: 2px; border-radius: 50%; background: var(--vscode-descriptionForeground); animation: thinkingDot 1.2s ease-in-out infinite; }
    .thinking-dots span:nth-child(2) { animation-delay: 150ms; }
    .thinking-dots span:nth-child(3) { animation-delay: 300ms; }
    .activity-card:not(.running) .thinking-dots { display: none; }
    .activity-steps { margin: 2px 0 0 9px; padding: 1px 0 1px 10px; border-left: 1px solid var(--vscode-panel-border); }
    details.activity-step { border: 0; background: transparent; }
    details.activity-step > summary { display: grid; grid-template-columns: 13px minmax(0, 1fr) 10px; align-items: center; gap: 5px; min-height: 25px; padding: 2px 4px; cursor: pointer; color: var(--vscode-descriptionForeground); user-select: none; border-radius: 4px; }
    details.activity-step > summary:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
    .step-status { width: 13px; text-align: center; font-size: 11px; }
    .activity-step.failed .step-status { color: var(--vscode-errorForeground); }
    .step-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
    .step-chevron { color: var(--vscode-descriptionForeground); font-size: 9px; transition: transform 120ms ease; }
    details.activity-step > pre.step-output { margin: 0 0 3px 18px; padding: 5px 7px; border: 0; color: var(--vscode-descriptionForeground); background: var(--vscode-textCodeBlock-background); border-radius: 4px; white-space: pre-wrap; overflow-wrap: anywhere; font: 11px/1.45 var(--vscode-editor-font-family); max-height: 220px; overflow: auto; }
    details.activity-step > .step-markdown { margin: 1px 0 5px 18px; padding: 4px 7px; color: var(--vscode-descriptionForeground); border-left: 1px solid var(--vscode-panel-border); font-size: 11px; }
    @keyframes thinkingPulse { 50% { opacity: .45; } }
    @keyframes thinkingDot { 0%, 65%, 100% { opacity: .25; transform: translateY(0); } 35% { opacity: 1; transform: translateY(-2px); } }
    @media (prefers-reduced-motion: reduce) { .activity-card.running .activity-label, .thinking-dots span { animation: none; } }
    .system, .error { display: flex; gap: 7px; align-items: flex-start; color: var(--vscode-descriptionForeground); font-size: 11px; padding: 3px 4px; }
    .error { color: var(--vscode-errorForeground); }
    .approval { padding: 9px; border-radius: 7px; color: var(--vscode-editorWarning-foreground); background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); font-size: 11px; }
    .approval-head { display: flex; align-items: center; gap: 6px; font-weight: 700; }
    .approval-status { margin-left: auto; color: var(--vscode-descriptionForeground); font-weight: 400; }
    .approval-body { margin-top: 6px; color: var(--vscode-foreground); white-space: pre-wrap; overflow-wrap: anywhere; }
    .approval-actions { display: flex; gap: 6px; margin-top: 9px; }
    .approval-actions button { padding: 5px 9px; }
    #queue { display: none; margin: 8px 10px 0; border: 1px solid var(--vscode-panel-border); border-radius: 7px; padding: 7px 9px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    #queue.visible { display: block; }
    #queue strong { color: var(--vscode-foreground); }
    footer { padding: 8px 10px 10px; background: var(--vscode-sideBar-background); border-top: 1px solid var(--vscode-panel-border); }
    .composer { position: relative; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 9px; background: var(--vscode-input-background); padding: 8px 8px 7px; }
    .composer:focus-within { border-color: var(--vscode-focusBorder); }
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
        <textarea id="prompt" placeholder="Ask Codex or describe a change…" aria-label="Prompt"></textarea>
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
    let state = { connection: 'idle', participants: [], queue: [], timeline: [] };
    const savedComposer = vscode.getState() || {};
    let selectedModel = typeof savedComposer.model === 'string' ? savedComposer.model : '';
    let selectedEffort = typeof savedComposer.effort === 'string' ? savedComposer.effort : '';
    let joinVisible = false;
    const expandedActivities = new Set();
    const collapsedActivities = new Set();
    const expandedSteps = new Set();
    const collapsedSteps = new Set();

    const post = (type, extra = {}) => vscode.postMessage({ type, ...extra });
    const node = (tag, className, text) => { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; };
    const markdownNode = (className, html) => { const value = node('div', className); value.innerHTML = html || ''; return value; };
    const initials = name => name.split(/\\s+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join('') || '?';
    const isActivity = item => item.kind === 'reasoning' || item.kind === 'command';
    const isFailure = item => item.kind === 'command' && item.status?.startsWith('exit');
    const elapsed = milliseconds => {
      const seconds = Math.max(0, Math.round((milliseconds || 0) / 1000));
      if (seconds < 60) return seconds + 's';
      const minutes = Math.floor(seconds / 60);
      return minutes + 'm ' + (seconds % 60) + 's';
    };
    const shortCommand = command => {
      const compact = (command || 'command').replace(/\\s+/g, ' ').trim();
      return compact.length > 72 ? compact.slice(0, 69) + '…' : compact;
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
        const option = node('option', '', config?.model || 'Default model'); option.value = config?.model || '';
        elements.model.append(option);
      } else {
        for (const model of models) {
          const option = node('option', '', model.displayName); option.value = model.model; option.title = model.description || model.displayName;
          elements.model.append(option);
        }
      }
      elements.model.value = selectedModel;
      elements.model.title = models.find(model => model.model === selectedModel)?.description || 'Model';

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
      const enabled = state.connection === 'connected';
      elements.model.disabled = !enabled || (!models.length && !config?.model);
      elements.effort.disabled = !enabled || !config || !efforts.length;
      rememberComposer();
    }

    function renderPeople() {
      elements.people.replaceChildren();
      if (!state.participants.length) { elements.people.style.display = 'none'; return; }
      elements.people.style.display = 'flex';
      for (const person of state.participants) {
        const chip = node('span', 'person');
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
      if (!count) return;
      elements.queue.append(node('strong', '', count + ' queued'), document.createTextNode(' · ' + state.queue.map(item => item.name).join(', ')));
    }

    function renderActivity(items) {
      const runningCommand = items.find(item => item.kind === 'command' && item.status === 'running');
      const running = Boolean(runningCommand || items.some(item => item.status === 'running'));
      const failed = items.some(isFailure);
      const startedAt = Math.min(...items.map(item => Date.parse(item.timestamp)).filter(Number.isFinite));
      const finishedTimes = items.map(item => Date.parse(item.finishedAt || '')).filter(Number.isFinite);
      const finishedAt = finishedTimes.length ? Math.max(...finishedTimes) : undefined;
      const duration = finishedAt === undefined || !Number.isFinite(startedAt) ? undefined : elapsed(finishedAt - startedAt);
      const activityId = 'activity:' + (items[0]?.turnId || items[0]?.id || 'unknown');
      const details = node('details', 'activity-card ' + (running ? 'running' : 'completed') + (failed ? ' failed' : ''));
      if ((running && !collapsedActivities.has(activityId)) || (!running && expandedActivities.has(activityId))) details.setAttribute('open', '');

      let label = duration ? 'Worked for ' + duration : 'Worked';
      if (failed) label += ' · command failed';
      if (runningCommand) label = 'Running ' + shortCommand(runningCommand.command);
      else if (running) label = 'Thinking…';
      const summary = node('summary');
      summary.setAttribute('aria-label', label + (details.open ? ', hide activity' : ', show activity'));
      const dots = node('span', 'thinking-dots');
      dots.setAttribute('aria-hidden', 'true');
      dots.append(node('span'), node('span'), node('span'));
      summary.append(node('span', 'activity-chevron', '▶'), node('span', 'activity-label', label), dots);
      summary.addEventListener('click', () => {
        if (details.open) {
          expandedActivities.delete(activityId);
          collapsedActivities.add(activityId);
        } else {
          expandedActivities.add(activityId);
          collapsedActivities.delete(activityId);
        }
      });
      details.addEventListener('toggle', () => summary.setAttribute('aria-label', label + (details.open ? ', hide activity' : ', show activity')));

      const steps = node('div', 'activity-steps');
      for (const item of items) {
        const stepFailed = isFailure(item);
        const stepRunning = item.status === 'running';
        const step = node('details', 'activity-step' + (stepFailed ? ' failed' : '') + (stepRunning ? ' running' : ''));
        if ((stepFailed && !collapsedSteps.has(item.id)) || expandedSteps.has(item.id)) step.setAttribute('open', '');

        let stepLabel;
        if (item.kind === 'reasoning') stepLabel = stepRunning ? 'Thinking…' : 'Thought';
        else if (stepRunning) stepLabel = 'Running ' + shortCommand(item.command);
        else if (stepFailed) stepLabel = 'Failed ' + shortCommand(item.command) + ' · ' + item.status;
        else stepLabel = 'Ran ' + shortCommand(item.command) + (item.durationMs === undefined ? '' : ' in ' + elapsed(item.durationMs));

        const stepSummary = node('summary');
        stepSummary.append(
          node('span', 'step-status', stepRunning ? '◌' : stepFailed ? '×' : '✓'),
          node('span', 'step-label', stepLabel),
          node('span', 'step-chevron', '▶'),
        );
        stepSummary.addEventListener('click', () => {
          if (step.open) {
            expandedSteps.delete(item.id);
            collapsedSteps.add(item.id);
          } else {
            expandedSteps.add(item.id);
            collapsedSteps.delete(item.id);
          }
        });
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
      if (item.kind === 'approval') {
        const head = node('div', 'approval-head');
        head.append(node('span', '', '!'), node('span', '', item.title || 'Approval required'));
        if (item.status) head.append(node('span', 'approval-status', item.status));
        wrap.append(head, node('div', 'approval-body', item.text));
        if (item.approval && state.canApprove && item.status === 'pending') {
          const actions = node('div', 'approval-actions');
          const allow = node('button', '', 'Allow'); allow.onclick = () => post('approval', { requestId: item.approval.requestId, decision: 'accept' });
          const decline = node('button', 'secondary', 'Decline'); decline.onclick = () => post('approval', { requestId: item.approval.requestId, decision: 'decline' });
          const cancel = node('button', 'secondary', 'Cancel turn'); cancel.onclick = () => post('approval', { requestId: item.approval.requestId, decision: 'cancel' });
          actions.append(allow, decline, cancel); wrap.append(actions);
        }
        return wrap;
      }
      if (item.kind === 'user' || item.kind === 'assistant') {
        const meta = node('div', 'meta');
        meta.append(node('strong', '', item.title || (item.kind === 'assistant' ? 'Codex' : 'You')));
        if (item.status && item.status !== 'completed') meta.append(node('span', '', item.status));
        wrap.append(meta, markdownNode('bubble markdown', item.markdownHtml));
        return wrap;
      }
      if (item.kind === 'diff') {
        const details = node('details', 'card');
        details.open = item.status === 'running';
        const label = (item.title || item.kind) + (item.status && item.status !== 'completed' ? ' · ' + item.status : '');
        details.append(node('summary', '', label), node('pre', '', item.text));
        wrap.append(details);
        return wrap;
      }
      const icon = item.kind === 'error' ? '×' : item.kind === 'approval' ? '!' : '•';
      wrap.append(node('span', '', icon), node('span', '', (item.title ? item.title + ': ' : '') + item.text));
      return wrap;
    }

    function renderEmpty() {
      const empty = node('section', 'empty');
      empty.append(node('div', 'empty-logo', 'M'), node('h2', '', 'Code together with Codex'), node('p', '', 'Host a room or join a teammate’s session.'));
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
      const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
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
          wrap.append(renderActivity(activity));
          box.append(wrap);
          index = next;
        }
      }
      if (nearBottom) requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
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
      renderModelControls(); renderPeople(); renderQueue(); renderConversation();
    }

    function submitPrompt() {
      const text = elements.prompt.value.trim();
      if (!text || state.connection !== 'connected') return;
      post('submit', {
        text,
        model: state.agentConfig && selectedModel ? selectedModel : undefined,
        effort: state.agentConfig && selectedEffort ? selectedEffort : undefined,
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
    window.addEventListener('message', event => { if (event.data?.type === 'state') { state = event.data.state; render(); } });
    post('ready'); render();
  </script>
</body>
</html>`;
  }
}
