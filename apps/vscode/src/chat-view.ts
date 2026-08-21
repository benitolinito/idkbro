import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { RoomServerMessage } from "@multicode/protocol";
import type { ApprovalDecision } from "@multicode/protocol";
import { ChatModel, type ChatSnapshot } from "./chat-model.js";

export interface ChatActions {
  host(): void | Promise<void>;
  join(token?: string): void | Promise<void>;
  stop(): void | Promise<void>;
  submit(text: string): void | Promise<void>;
  approve(requestId: string | number, decision: ApprovalDecision): void | Promise<void>;
  copyInvite(): void | Promise<void>;
  openOutput(): void | Promise<void>;
}

type WebviewMessage =
  | { type: "ready" }
  | { type: "host" }
  | { type: "join"; token?: string }
  | { type: "stop" }
  | { type: "submit"; text?: string }
  | { type: "approval"; requestId?: string | number; decision?: ApprovalDecision }
  | { type: "copyInvite" }
  | { type: "openOutput" };

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
      case "host": await this.actions.host(); break;
      case "join": await this.actions.join(message.token?.trim() || undefined); break;
      case "stop": await this.actions.stop(); break;
      case "copyInvite": await this.actions.copyInvite(); break;
      case "openOutput": await this.actions.openOutput(); break;
      case "approval": {
        if ((typeof message.requestId !== "string" && typeof message.requestId !== "number") || !isApprovalDecision(message.decision)) break;
        this.model.approvalSubmitting(message.requestId); this.publish();
        try { await this.actions.approve(message.requestId, message.decision); }
        catch (error) { this.model.approvalFailed(message.requestId, error instanceof Error ? error.message : String(error)); this.publish(); }
        break;
      }
      case "submit": {
        const text = message.text?.trim();
        if (text) await this.actions.submit(text);
        break;
      }
    }
  }

  private publish(): void {
    if (this.disposed || !this.view) return;
    const state = this.model.snapshot();
    this.view.badge = state.connection === "connected" && state.participants.length > 0
      ? { value: state.participants.length, tooltip: `${state.participants.length} collaborator${state.participants.length === 1 ? "" : "s"}` }
      : undefined;
    void this.view.webview.postMessage({ type: "state", state });
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
    button, textarea, input { font: inherit; }
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
    .bubble { border: 1px solid var(--vscode-panel-border); border-radius: 9px; padding: 9px 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .user .bubble { background: color-mix(in srgb, var(--vscode-button-background) 18%, transparent); border-color: color-mix(in srgb, var(--vscode-button-background) 45%, var(--vscode-panel-border)); }
    .assistant .bubble { background: var(--vscode-editor-background); }
    details.card { border: 1px solid var(--vscode-panel-border); border-radius: 7px; background: var(--vscode-editor-background); }
    details.card summary { padding: 7px 9px; cursor: pointer; color: var(--vscode-descriptionForeground); user-select: none; }
    details.card pre { margin: 0; padding: 8px 9px; border-top: 1px solid var(--vscode-panel-border); white-space: pre-wrap; overflow-wrap: anywhere; font: 11px/1.45 var(--vscode-editor-font-family); max-height: 280px; overflow: auto; }
    .reasoning details { opacity: .86; }
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
    .hint { color: var(--vscode-descriptionForeground); font-size: 10px; }
    .send { min-width: 34px; border-radius: 7px; font-weight: 700; }
  </style>
</head>
<body>
  <div id="app">
    <header>
      <div class="topline"><span id="dot" class="dot"></span><span class="brand">MultiCode</span><button id="copy" class="icon" title="Copy invite token">Copy invite</button><button id="stop" class="icon" title="Stop or leave room">Stop</button><button id="output" class="icon" title="Open raw output">Logs</button></div>
      <div id="room" class="room">Not connected</div>
    </header>
    <div><div id="people"></div><div id="queue"></div></div>
    <main id="conversation"></main>
    <footer>
      <div class="composer">
        <textarea id="prompt" placeholder="Ask Codex or describe a change…" aria-label="Prompt"></textarea>
        <div class="composerbar"><span class="hint">Enter to send · Shift+Enter for a new line</span><button id="send" class="send" title="Send prompt">↑</button></div>
      </div>
    </footer>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const elements = Object.fromEntries(['dot','room','people','queue','conversation','prompt','send','copy','stop','output'].map(id => [id, document.getElementById(id)]));
    let state = { connection: 'idle', participants: [], queue: [], timeline: [] };
    let joinVisible = false;

    const post = (type, extra = {}) => vscode.postMessage({ type, ...extra });
    const node = (tag, className, text) => { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; };
    const initials = name => name.split(/\\s+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join('') || '?';

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
        wrap.append(meta, node('div', 'bubble', item.text));
        return wrap;
      }
      if (item.kind === 'reasoning' || item.kind === 'command' || item.kind === 'diff') {
        const details = node('details', 'card');
        if (item.kind !== 'reasoning' || item.status === 'running') details.open = item.status === 'running';
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
      else for (const item of state.timeline) box.append(renderItem(item));
      if (nearBottom) requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
    }

    function render() {
      elements.dot.className = 'dot ' + state.connection;
      elements.room.textContent = state.connection === 'idle' ? 'Not connected' : (state.roomLabel || (state.mode === 'host' ? 'Starting room…' : 'Joining room…'));
      elements.copy.style.display = state.mode === 'host' && state.connection === 'connected' ? '' : 'none';
      elements.stop.style.display = ['starting','connected','stopping','error'].includes(state.connection) ? '' : 'none';
      const enabled = state.connection === 'connected';
      elements.prompt.disabled = !enabled;
      elements.send.disabled = !enabled || !elements.prompt.value.trim();
      renderPeople(); renderQueue(); renderConversation();
    }

    function submitPrompt() {
      const text = elements.prompt.value.trim();
      if (!text || state.connection !== 'connected') return;
      post('submit', { text }); elements.prompt.value = ''; elements.prompt.style.height = ''; elements.send.disabled = true;
    }

    elements.prompt.addEventListener('input', () => {
      elements.prompt.style.height = 'auto'; elements.prompt.style.height = Math.min(elements.prompt.scrollHeight, 150) + 'px';
      elements.send.disabled = state.connection !== 'connected' || !elements.prompt.value.trim();
    });
    elements.prompt.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submitPrompt(); } });
    elements.send.onclick = submitPrompt;
    elements.copy.onclick = () => post('copyInvite');
    elements.stop.onclick = () => post('stop');
    elements.output.onclick = () => post('openOutput');
    window.addEventListener('message', event => { if (event.data?.type === 'state') { state = event.data.state; render(); } });
    post('ready'); render();
  </script>
</body>
</html>`;
  }
}
