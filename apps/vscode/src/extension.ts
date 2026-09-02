import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { hostApprovalCliArgs } from "./approval.js";
import { MultiCodeChatView } from "./chat-view.js";
import { CollaborationBridge } from "./collaboration.js";
import { parseWorkspaceFileReference } from "./file-link.js";
import { hostingRepositoryWarning, resolveHostingDirectory } from "./host-workspace.js";
import { roomSessionFromOutput, roomTokenFromOutput, roomWorkspaceFromOutput } from "./output-parser.js";
import { workspaceHandoffId, workspaceHandoffSecretKey, type WorkspaceHandoff } from "./workspace-handoff.js";
import { shouldOpenAsSoleWorkspaceRoot } from "./workspace-root.js";
import type { AgentInputAnswers, AgentProvider, ApprovalDecision } from "@multicode/protocol";
import { inspectManagedRoomWorktree, inspectRepository, type MirroredWorkspaceState } from "@multicode/workspace";

type SessionMode = "host" | "join";
type ClaudeAuthentication = "subscription" | "apiKey";

interface CliCommand {
  executable: string;
  prefixArgs: string[];
}

const workspaceHandoffsKey = "multicode.workspace-handoffs.v1";
const claudeApiKeySecret = "multicode.claude-api-key";
const claudeAuthenticationMigrationKey = "multicode.claude-authentication-migrated.v1";

class MultiCodeController implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel("MultiCode");
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 25);
  private process: ChildProcessWithoutNullStreams | undefined;
  private mode: SessionMode | undefined;
  private roomCode: string | undefined;
  private roomWorkspace: string | undefined;
  private roomSessionId: string | undefined;
  private stopping = false;
  private agentProvider: AgentProvider = "codex";
  private claudeApiKey: string | undefined;
  private claudeAuthentication: ClaudeAuthentication | undefined;
  private reviewerGrantPending = false;
  private recentOutput = "";
  readonly chat: MultiCodeChatView;
  private roomWorkspaceReady = false;
  private pendingCollaboration: { relay: string; token: string; name: string; role: "viewer" | "participant" } | undefined;
  private activeCollaboration: { relay: string; token: string; name: string; role: "viewer" | "participant" } | undefined;
  private readonly collaboration: CollaborationBridge;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.chat = new MultiCodeChatView(context.extensionUri, {
      back: () => this.backToStart(),
      host: () => this.host(),
      join: (token) => this.join(token),
      stop: () => this.stop(),
      submit: (text, settings) => this.submitPrompt(text, settings),
      updateAgentSettings: (model, effort) => this.updateAgentSettings(model, effort),
      updateQueuedPrompt: (promptId, text, settings) => this.updateQueuedPrompt(promptId, text, settings),
      removeQueuedPrompt: (promptId) => this.removeQueuedPrompt(promptId),
      steerQueuedPrompt: (promptId) => this.steerQueuedPrompt(promptId),
      approve: (requestId, decision) => this.resolveApproval(requestId, decision),
      answer: (requestId, answers) => this.resolveInput(requestId, answers),
      copyInvite: () => this.copyInvite(),
      openOutput: () => this.openOutput(),
      reviewChanges: () => this.reviewChanges(),
      openChangedFile: (file) => this.openChangedFile(file),
      openWorkspaceFile: (reference) => this.openWorkspaceFile(reference),
    });
    this.collaboration = new CollaborationBridge((message) => {
      if (message.type === "agent.config") {
        this.agentProvider = message.config.provider;
        void this.updateWorkspaceHandoffProvider(message.config.provider);
      }
      if (message.type === "room.welcome" && this.mode === "host") {
        const self = message.participants.find((participant) => participant.id === message.selfId);
        if (self && !self.capabilities.includes("reviewer")) void this.grantHostReviewer(self.id);
      }
      this.chat.handle(message);
      if (message.type === "agent.event" && message.event.type === "turn.completed") {
        void vscode.commands.executeCommand("git.refresh");
      }
    }, (turnId, revision, diff) => this.chat.previewWorkspaceDiff(turnId, revision, diff),
    (workspace) => this.workspaceSynchronized(workspace), context.globalStorageUri.fsPath,
    (event, details) => this.output.appendLine(`[${new Date().toISOString()}] ${event} ${JSON.stringify(details)}`));
    this.status.name = "MultiCode";
    this.status.command = "multicode.host";
    this.setIdle();
    this.status.show();
    this.context.subscriptions.push(this.collaboration.onDidChangeStatus((status) => {
      if (!this.roomWorkspaceReady) return;
      this.status.text = status === "connected" ? `$(people) MultiCode: ${this.roomCode?.slice(0, 11) ?? "connected"}` : `$(sync~spin) MultiCode: ${status}`;
    }));
  }

  async host(): Promise<void> {
    if (!this.ensureIdle()) return;
    await this.migrateClaudeAuthentication();
    const workspaceDirectory = this.workspaceDirectory();
    if (!workspaceDirectory) return;
    const cwd = await this.ensureDirectWorkspace(workspaceDirectory);
    if (!cwd) return;

    try {
      const warning = hostingRepositoryWarning(await inspectRepository(cwd));
      if (warning) {
        await vscode.window.showWarningMessage(warning, { modal: true });
        return;
      }
    } catch {
      // Let the CLI surface its more specific repository validation error.
    }

    const config = vscode.workspace.getConfiguration("multicode");
    const configuredProvider = config.get<AgentProvider>("defaultAgent", "codex");
    const experimentalClaude = config.get<boolean>("experimentalClaude", false) || configuredProvider === "claude";
    const providers = [
      { label: "Codex", description: "OpenAI Codex app-server", provider: "codex" as const },
      ...(experimentalClaude ? [{ label: "Claude", description: "Anthropic Claude Agent SDK (experimental)", provider: "claude" as const }] : []),
    ];
    providers.sort((left, right) => Number(right.provider === configuredProvider) - Number(left.provider === configuredProvider));
    const selection = await vscode.window.showQuickPick(providers, { placeHolder: "Choose the coding agent for this room", ignoreFocusOut: true });
    if (!selection) return;
    this.agentProvider = selection.provider;
    if (selection.provider !== "claude") this.claudeAuthentication = undefined;
    const providerExecutable = config.get<string>(selection.provider === "claude" ? "claudeExecutable" : "codexExecutable")?.trim();
    if (selection.provider === "claude") {
      this.claudeAuthentication = config.get<ClaudeAuthentication>("claudeAuthentication", "subscription");
      if (this.claudeAuthentication === "apiKey") {
        this.claudeApiKey = await this.context.secrets.get(claudeApiKeySecret);
        if (!this.claudeApiKey) {
          if (!await this.configureClaudeApiKey()) return;
          this.claudeApiKey = await this.context.secrets.get(claudeApiKeySecret);
        }
      } else if (!await this.prepareClaudeSubscription(providerExecutable || "claude")) {
        return;
      }
    }
    const name = config.get<string>("displayName")?.trim() || this.defaultName();
    const relay = config.get<string>("relayUrl")?.trim();
    const args = ["host", "--agent", selection.provider, "--name", name];
    if (selection.provider === "claude") args.push("--claude-auth", this.claudeAuthentication === "apiKey" ? "api-key" : "subscription");
    if (providerExecutable) args.push("--agent-executable", providerExecutable);
    if (relay) args.push("--relay", relay);
    this.startSession("host", args, cwd);
  }

  async restoreWorkspaceSession(): Promise<void> {
    if (this.process || this.roomWorkspaceReady) return;
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspace) return;
    const handoffs = this.context.globalState.get<Record<string, WorkspaceHandoff>>(workspaceHandoffsKey, {});
    const handoff = handoffs[workspaceHandoffId(workspace)];
    if (!handoff || path.resolve(handoff.workspace) !== path.resolve(workspace)) return;
    const token = await this.context.secrets.get(workspaceHandoffSecretKey(workspace));
    if (!token || !this.validRoomToken(token)) return;

    this.mode = handoff.mode;
    this.agentProvider = handoff.provider ?? "codex";
    this.roomCode = token;
    this.roomWorkspace = workspace;
    this.roomSessionId = handoff.roomId;
    this.roomWorkspaceReady = true;
    this.collaboration.setWorkspaceRoot(vscode.Uri.file(workspace));
    this.chat.start(handoff.mode, handoff.roomLabel);
    this.chat.ready(handoff.roomLabel);
    this.status.text = `$(people) MultiCode: ${handoff.roomLabel}`;
    this.status.tooltip = "Click to send a prompt";
    this.status.command = "multicode.sendPrompt";
    void vscode.commands.executeCommand("setContext", "multicode.connected", true);
    this.activeCollaboration = { relay: handoff.relay, token, name: handoff.name, role: handoff.role };
    this.collaboration.connect(handoff.relay, token, handoff.name, handoff.role, handoff.mode === "host" ? "daemon" : "extension");
    this.openChat();
  }

  async join(providedToken?: string): Promise<void> {
    if (!this.ensureIdle()) return;
    const cwd = this.workspaceDirectory(false);
    const code = providedToken ?? await vscode.window.showInputBox({
        title: "Join a MultiCode room",
        prompt: "Paste the room token shared by the host",
        placeHolder: "K7MNP-4XQ2R.<room-secret>",
        ignoreFocusOut: true,
        validateInput: (value) => this.validRoomToken(value) ? undefined : "Paste the complete MultiCode room token",
    });
    if (!code) return;
    if (!this.validRoomToken(code)) {
      void vscode.window.showErrorMessage("Paste the complete MultiCode room token.");
      return;
    }
    const config = vscode.workspace.getConfiguration("multicode");
    const name = config.get<string>("displayName")?.trim() || this.defaultName();
    const relay = config.get<string>("relayUrl")?.trim();
    const invite = code.trim(); const args = ["join", invite, "--name", name];
    args.push("--bootstrap-only");
    if (relay) args.push("--relay", relay);
    this.roomCode = code.trim();
    this.startSession("join", args, cwd);
    let collaborationRelay = relay || "wss://multicode.luisagd.com"; let collaborationToken = invite;
    if (/^wss?:\/\//i.test(invite)) {
      const url = new URL(invite); collaborationToken = new URLSearchParams(url.hash.replace(/^#/, "")).get("token") ?? "";
      url.hash = ""; url.search = ""; url.pathname = url.pathname.replace(/\/rooms\/[^/]+\/?$/, ""); collaborationRelay = url.toString();
    }
    this.pendingCollaboration = { relay: collaborationRelay, token: collaborationToken, name, role: "participant" };
  }

  async sendPrompt(): Promise<void> {
    if (!this.process && !this.roomWorkspaceReady) {
      const action = await vscode.window.showInformationMessage("Join or host a MultiCode room first.", "Host", "Join");
      if (action === "Host") await this.host();
      if (action === "Join") await this.join();
      return;
    }
    const prompt = await vscode.window.showInputBox({
      title: "Send a prompt to MultiCode",
      prompt: "Prompts from all participants run in queue order",
      ignoreFocusOut: true,
    });
    if (prompt?.trim()) await this.submitPrompt(prompt);
  }

  async submitPrompt(text: string, settings: { model?: string; effort?: string } = {}): Promise<void> {
    const prompt = text.trim();
    if (!prompt) return;
    if (this.roomWorkspaceReady && this.collaboration.sendPrompt(prompt, settings)) return;
    if (!this.process?.stdin.writable) {
      void vscode.window.showWarningMessage("MultiCode is reconnecting; the prompt was not sent.");
      return;
    }
    this.process.stdin.write(`${prompt}\n`);
  }

  updateAgentSettings(model: string, effort: string): void {
    if (this.collaboration.updateAgentSettings(model, effort)) return;
    void vscode.window.showWarningMessage("MultiCode is reconnecting; the shared agent settings were not updated.");
  }

  updateQueuedPrompt(promptId: string, text: string, settings: { model?: string; effort?: string } = {}): void {
    if (text.trim() && this.collaboration.updateQueuedPrompt(promptId, text.trim(), settings)) return;
    void vscode.window.showWarningMessage("MultiCode is reconnecting; the queued prompt was not updated.");
  }

  removeQueuedPrompt(promptId: string): void {
    if (this.collaboration.removeQueuedPrompt(promptId)) return;
    void vscode.window.showWarningMessage("MultiCode is reconnecting; the queued prompt was not removed.");
  }

  steerQueuedPrompt(promptId: string): void {
    if (this.collaboration.steerQueuedPrompt(promptId)) return;
    void vscode.window.showWarningMessage("MultiCode is reconnecting; the steer was not sent.");
  }

  async resolveApproval(requestId: string | number, decision: ApprovalDecision): Promise<void> {
    if (this.mode === "host" && this.roomWorkspace) {
      await this.runCliCommand(hostApprovalCliArgs(this.roomSessionId, requestId, decision), this.roomWorkspace);
      return;
    }
    if (this.collaboration.resolveApproval(requestId, decision)) return;
    throw new Error("MultiCode is reconnecting; the approval was not sent");
  }

  async resolveInput(requestId: string, answers: AgentInputAnswers | null): Promise<void> {
    if (this.mode === "host" && this.roomWorkspace) {
      await this.runCliCommand(["answer", requestId, answers === null ? "cancel" : JSON.stringify(answers), ...(this.roomSessionId ? ["--session", this.roomSessionId] : [])], this.roomWorkspace);
      return;
    }
    if (this.collaboration.resolveInput(requestId, answers)) return;
    throw new Error("MultiCode is reconnecting; the answer was not sent");
  }

  async configureClaudeApiKey(): Promise<boolean> {
    const value = await vscode.window.showInputBox({
      title: "Configure Claude API Key",
      prompt: "Enter an Anthropic API key. It is stored in VS Code SecretStorage and only injected into the local host process.",
      password: true,
      ignoreFocusOut: true,
    });
    if (!value?.trim()) return false;
    await this.context.secrets.store(claudeApiKeySecret, value.trim());
    await vscode.workspace.getConfiguration("multicode").update("claudeAuthentication", "apiKey", vscode.ConfigurationTarget.Global);
    this.claudeAuthentication = "apiKey";
    void vscode.window.showInformationMessage("Claude API key stored securely for local MultiCode hosting.");
    return true;
  }

  async selectClaudeAuthentication(): Promise<void> {
    const current = vscode.workspace.getConfiguration("multicode").get<ClaudeAuthentication>("claudeAuthentication", "subscription");
    const options = [
      { label: "Claude subscription", description: "Use the account signed in through the local Claude CLI", value: "subscription" as const },
      { label: "Anthropic API key", description: "Use an API key stored in VS Code SecretStorage", value: "apiKey" as const },
    ];
    options.sort((left, right) => Number(right.value === current) - Number(left.value === current));
    const selected = await vscode.window.showQuickPick(options, { placeHolder: "Choose how MultiCode authenticates Claude", ignoreFocusOut: true });
    if (!selected) return;
    if (selected.value === "apiKey" && !await this.context.secrets.get(claudeApiKeySecret)) {
      await this.configureClaudeApiKey();
      return;
    }
    await vscode.workspace.getConfiguration("multicode").update("claudeAuthentication", selected.value, vscode.ConfigurationTarget.Global);
    this.claudeAuthentication = selected.value;
    void vscode.window.showInformationMessage(selected.value === "subscription" ? "MultiCode will use your local Claude subscription login." : "MultiCode will use your stored Anthropic API key.");
  }

  async forgetClaudeApiKey(): Promise<void> {
    await this.context.secrets.delete(claudeApiKeySecret);
    this.claudeApiKey = undefined;
    void vscode.window.showInformationMessage("MultiCode's stored Anthropic API key was removed.");
  }

  async migrateClaudeAuthentication(): Promise<void> {
    if (this.context.globalState.get<boolean>(claudeAuthenticationMigrationKey)) return;
    const config = vscode.workspace.getConfiguration("multicode");
    const inspected = config.inspect<ClaudeAuthentication>("claudeAuthentication");
    const explicitlyConfigured = inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
    if (!explicitlyConfigured && await this.context.secrets.get(claudeApiKeySecret)) {
      await config.update("claudeAuthentication", "apiKey", vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage("MultiCode preserved your existing Claude API-key authentication. You can switch to your local Claude subscription with “MultiCode: Select Claude Authentication”.");
    }
    await this.context.globalState.update(claudeAuthenticationMigrationKey, true);
  }

  async copyInvite(): Promise<void> {
    if (!this.roomCode) return;
    await vscode.env.clipboard.writeText(this.roomCode);
    void vscode.window.showInformationMessage("MultiCode invite token copied.");
  }

  openOutput(): void {
    this.output.show(true);
  }

  async reviewChanges(): Promise<void> {
    await vscode.commands.executeCommand("git.refresh");
    await vscode.commands.executeCommand("workbench.view.scm");
  }

  async openChangedFile(file: string): Promise<void> {
    const root = path.resolve(this.roomWorkspace ?? this.workspaceDirectory(false));
    const target = path.resolve(root, file);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      void vscode.window.showWarningMessage("MultiCode refused to open a change outside the room workspace.");
      return;
    }
    const uri = vscode.Uri.file(target);
    const commands = await vscode.commands.getCommands(true);
    if (commands.includes("git.openChange")) {
      await vscode.commands.executeCommand("git.openChange", uri);
      return;
    }
    try { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri)); }
    catch { await this.reviewChanges(); }
  }

  async openWorkspaceFile(reference: string): Promise<void> {
    const parsed = parseWorkspaceFileReference(reference);
    if (!parsed) return;
    const root = path.resolve(this.roomWorkspace ?? this.workspaceDirectory(false));
    const target = path.resolve(root, parsed.file);
    try {
      const realRoot = realpathSync.native(root);
      const realTarget = realpathSync.native(target);
      const relative = path.relative(realRoot, realTarget);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        void vscode.window.showWarningMessage("MultiCode refused to open a link outside the room workspace.");
        return;
      }
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(realTarget));
      const line = Math.min(Math.max(0, (parsed.line ?? 1) - 1), Math.max(0, document.lineCount - 1));
      const maxColumn = document.lineAt(line).text.length;
      const column = Math.min(Math.max(0, (parsed.column ?? 1) - 1), maxColumn);
      const position = new vscode.Position(line, column);
      await vscode.window.showTextDocument(document, { preview: true, selection: new vscode.Range(position, position) });
    } catch {
      void vscode.window.showWarningMessage(`MultiCode could not open ${parsed.file}.`);
    }
  }

  openChat(): void {
    void vscode.commands.executeCommand(`${MultiCodeChatView.viewType}.focus`);
  }

  async doctor(): Promise<void> {
    const cwd = this.workspaceDirectory(false);
    this.output.clear();
    this.output.show(true);
    const provider = vscode.workspace.getConfiguration("multicode").get<AgentProvider>("defaultAgent", "codex");
    this.agentProvider = provider;
    if (provider === "claude") {
      this.claudeAuthentication = vscode.workspace.getConfiguration("multicode").get<ClaudeAuthentication>("claudeAuthentication", "subscription");
      if (this.claudeAuthentication === "apiKey") this.claudeApiKey = await this.context.secrets.get(claudeApiKeySecret);
    }
    this.output.appendLine(`$ multicode doctor --agent ${provider}\n`);
    const command = this.cliCommand();
    const configuredExecutable = vscode.workspace.getConfiguration("multicode").get<string>(provider === "claude" ? "claudeExecutable" : "codexExecutable")?.trim();
    const child = spawn(command.executable, [...command.prefixArgs, "doctor", "--agent", provider, ...(provider === "claude" ? ["--claude-auth", this.claudeAuthentication === "apiKey" ? "api-key" : "subscription"] : []), ...(configuredExecutable ? ["--agent-executable", configuredExecutable] : [])], { cwd, env: this.sessionEnvironment(true) });
    this.claudeApiKey = undefined;
    child.stdout.on("data", (data: Buffer) => this.output.append(data.toString()));
    child.stderr.on("data", (data: Buffer) => this.output.append(data.toString()));
    child.once("error", (error) => this.reportLaunchError(error));
    child.once("close", (code) => {
      this.output.appendLine(`\nMultiCode doctor exited with code ${code ?? "unknown"}.`);
    });
  }

  async stop(): Promise<void> {
    if (!this.process) {
      await this.forgetWorkspaceHandoff();
      this.collaboration.disconnect(); this.roomWorkspaceReady = false; this.roomSessionId = undefined; this.mode = undefined; this.roomCode = undefined; this.roomWorkspace = undefined; this.chat.stopped(); this.setIdle(); void vscode.commands.executeCommand("setContext", "multicode.connected", false); return;
    }
    this.stopping = true;
    this.chat.stopping();
    this.status.text = "$(sync~spin) MultiCode: stopping";
    this.process.kill("SIGINT");
    const activeProcess = this.process;
    setTimeout(() => {
      if (this.process === activeProcess) activeProcess.kill("SIGTERM");
    }, 10_000);
  }

  async openProposal(): Promise<void> {
    await this.collaboration.showProposal();
  }

  async openPreview(): Promise<void> { await this.collaboration.showPreview(); }

  dispose(): void {
    if (this.process) this.process.kill("SIGTERM");
    this.chat.dispose();
    this.collaboration.dispose();
    this.output.dispose();
    this.status.dispose();
  }

  private startSession(mode: SessionMode, args: string[], cwd: string): void {
    const command = this.cliCommand();
    this.mode = mode;
    this.stopping = false;
    this.recentOutput = "";
    this.roomWorkspace = undefined;
    this.roomSessionId = undefined;
    this.roomWorkspaceReady = false;
    this.pendingCollaboration = undefined;
    this.activeCollaboration = undefined;
    this.collaboration.disconnect();
    this.output.clear();
    this.output.appendLine(`$ multicode ${args.join(" ")}\n`);
    this.chat.start(mode, mode === "join" ? this.roomCode?.slice(0, 11) : undefined);
    this.openChat();
    this.status.text = `$(sync~spin) MultiCode: ${mode === "host" ? "hosting" : "joining"}`;
    this.status.tooltip = this.agentProvider === "claude" ? `Open MultiCode output\nClaude authentication: ${this.claudeAuthentication === "apiKey" ? "Anthropic API key" : "local subscription"}` : "Open MultiCode output";
    this.status.command = "multicode.sendPrompt";
    void vscode.commands.executeCommand("setContext", "multicode.connected", true);

    const child = spawn(command.executable, [...command.prefixArgs, ...args], { cwd, env: this.sessionEnvironment(mode === "host") });
    this.claudeApiKey = undefined;
    this.process = child;
    child.stdout.on("data", (data: Buffer) => this.handleOutput(data.toString()));
    child.stderr.on("data", (data: Buffer) => this.handleOutput(data.toString()));
    child.once("error", (error) => this.reportLaunchError(error));
    child.once("close", (code, signal) => {
      if (this.process !== child) return;
      this.output.appendLine(`\nMultiCode ${mode} session ended (${signal ?? `code ${code ?? "unknown"}`}).`);
      const unexpected = !this.stopping && code !== 0;
      const continueParticipantSession = !this.stopping && mode === "join" && this.roomWorkspaceReady;
      this.process = undefined;
      this.pendingCollaboration = undefined;
      if (continueParticipantSession) {
        this.chat.ready(this.roomCode?.slice(0, 11) ?? "connected");
        this.status.text = `$(people) MultiCode: ${this.roomCode?.slice(0, 11) ?? "connected"}`;
        this.status.tooltip = "Open the shared agent room";
      } else {
        void this.forgetWorkspaceHandoff();
        this.mode = undefined;
        this.roomCode = undefined;
        this.roomWorkspace = undefined;
        this.roomSessionId = undefined;
        this.roomWorkspaceReady = false;
        this.collaboration.disconnect();
        this.chat.stopped(unexpected ? `Session ended unexpectedly (${signal ?? `code ${code ?? "unknown"}`})` : "Room closed");
        this.setIdle();
        void vscode.commands.executeCommand("setContext", "multicode.connected", false);
      }
      if (unexpected) void vscode.window.showErrorMessage("The MultiCode session ended unexpectedly. See the MultiCode output for details.");
    });
  }

  private handleOutput(text: string): void {
    this.output.append(text);
    this.recentOutput = `${this.recentOutput}${text}`.slice(-2_000);
    const parsedWorkspace = roomWorkspaceFromOutput(this.recentOutput);
    const parsedSession = roomSessionFromOutput(this.recentOutput);
    if (parsedSession) this.roomSessionId = parsedSession;
    if (parsedWorkspace) {
      const roomWorkspace = parsedWorkspace.trim();
      if (path.isAbsolute(roomWorkspace)) {
        this.roomWorkspace = roomWorkspace;
        this.collaboration.setWorkspaceRoot(vscode.Uri.file(roomWorkspace));
      }
      if (path.isAbsolute(roomWorkspace) && (this.mode === "host" || /Workspace synchronized/i.test(this.recentOutput))) {
        this.roomWorkspaceReady = true;
        this.connectCollaborationWhenSafe();
      }
    }
    if (this.mode === "host") {
      const token = roomTokenFromOutput(this.recentOutput);
      if (token && token !== this.roomCode) {
        this.roomCode = token;
        this.chat.ready(this.roomCode.slice(0, 11));
        this.status.text = `$(broadcast) MultiCode: ${this.roomCode.slice(0, 11)}`;
        this.status.tooltip = "Click to send a prompt";
        void vscode.env.clipboard.writeText(this.roomCode);
        void vscode.window.showInformationMessage("MultiCode room is ready. Its invite token was copied to your clipboard.");
        const config = vscode.workspace.getConfiguration("multicode");
        const relay = config.get<string>("relayUrl")?.trim() || "wss://multicode.luisagd.com";
        const name = config.get<string>("displayName")?.trim() || this.defaultName();
        this.pendingCollaboration = { relay, token: this.roomCode, name, role: "participant" };
        this.connectCollaborationWhenSafe();
      }
    } else if (this.recentOutput.includes("Joined room")) {
      this.roomWorkspace ??= this.workspaceDirectory(false);
      this.roomWorkspaceReady = true;
      this.connectCollaborationWhenSafe();
      this.status.text = `$(people) MultiCode: ${this.roomCode ?? "joined"}`;
    }
  }

  private connectCollaborationWhenSafe(): void {
    if (!this.roomWorkspaceReady || !this.pendingCollaboration) return;
    const pending = this.pendingCollaboration;
    this.pendingCollaboration = undefined;
    this.activeCollaboration = pending;
    this.collaboration.connect(pending.relay, pending.token, pending.name, pending.role, this.mode === "host" ? "daemon" : "extension", false);
    void this.persistWorkspaceHandoff(pending);
  }

  private async workspaceSynchronized(workspace: MirroredWorkspaceState): Promise<void> {
    if (this.mode !== "join") return;
    const previousWorkspace = this.roomWorkspace;
    if (previousWorkspace && path.resolve(previousWorkspace) !== path.resolve(workspace.root)) {
      await this.forgetWorkspaceHandoff(previousWorkspace);
    }
    this.roomWorkspace = workspace.root;
    this.roomSessionId = workspace.roomId;
    this.roomWorkspaceReady = true;
    this.collaboration.setWorkspaceRoot(vscode.Uri.file(workspace.root));
    if (this.activeCollaboration) await this.persistWorkspaceHandoff(this.activeCollaboration);
    this.status.text = `$(check) MultiCode: synced ${workspace.commit.slice(0, 8)}`;
    this.status.tooltip = `Shared workspace synchronized at version ${workspace.sequence}`;

    const uri = vscode.Uri.file(workspace.root);
    const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    if (shouldOpenAsSoleWorkspaceRoot(roots, workspace.root)) {
      this.status.text = "$(sync~spin) MultiCode: opening shared workspace";
      await vscode.commands.executeCommand("vscode.openFolder", uri, { forceNewWindow: false });
      return;
    }
    void vscode.commands.executeCommand("git.refresh");
  }

  private async persistWorkspaceHandoff(connection: { relay: string; token: string; name: string; role: "viewer" | "participant" }): Promise<void> {
    const workspace = this.roomWorkspace;
    if (!workspace) return;
    const id = workspaceHandoffId(workspace);
    const handoff: WorkspaceHandoff = {
      workspace,
      relay: connection.relay,
      name: connection.name,
      role: connection.role,
      mode: this.mode ?? "join",
      provider: this.agentProvider,
      roomLabel: connection.token.slice(0, 11),
      ...(this.roomSessionId ? { roomId: this.roomSessionId } : {}),
      updatedAt: Date.now(),
    };
    try {
      await this.context.secrets.store(workspaceHandoffSecretKey(workspace), connection.token);
      const existing = this.context.globalState.get<Record<string, WorkspaceHandoff>>(workspaceHandoffsKey, {});
      const recent = Object.fromEntries(
        Object.entries({ ...existing, [id]: handoff })
          .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
          .slice(0, 20),
      );
      await this.context.globalState.update(workspaceHandoffsKey, recent);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`\nUnable to save the room handoff: ${message}`);
      void vscode.window.showWarningMessage("The room is running, but MultiCode could not save its reconnect state. See the MultiCode output for details.");
    }
  }

  private async forgetWorkspaceHandoff(workspaceOverride?: string): Promise<void> {
    const workspace = workspaceOverride ?? this.roomWorkspace;
    if (!workspace) return;
    const id = workspaceHandoffId(workspace);
    const existing = this.context.globalState.get<Record<string, WorkspaceHandoff>>(workspaceHandoffsKey, {});
    if (existing[id]) {
      const remaining = { ...existing };
      delete remaining[id];
      await this.context.globalState.update(workspaceHandoffsKey, remaining);
    }
    await this.context.secrets.delete(workspaceHandoffSecretKey(workspace));
  }

  private async updateWorkspaceHandoffProvider(provider: AgentProvider): Promise<void> {
    const workspace = this.roomWorkspace;
    if (!workspace) return;
    const id = workspaceHandoffId(workspace);
    const existing = this.context.globalState.get<Record<string, WorkspaceHandoff>>(workspaceHandoffsKey, {});
    const handoff = existing[id];
    if (!handoff || handoff.provider === provider) return;
    await this.context.globalState.update(workspaceHandoffsKey, { ...existing, [id]: { ...handoff, provider, updatedAt: Date.now() } });
  }

  private async grantHostReviewer(participantId: string): Promise<void> {
    if (this.reviewerGrantPending) return;
    this.reviewerGrantPending = true;
    try {
      await this.runCliCommand(["grant", participantId, "reviewer", ...(this.roomSessionId ? ["--session", this.roomSessionId] : [])], this.roomWorkspace ?? this.workspaceDirectory(false));
    } catch (error) {
      this.output.appendLine(`\nUnable to grant the host review controls: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.reviewerGrantPending = false;
    }
  }

  private cliCommand(): CliCommand {
    const configured = vscode.workspace.getConfiguration("multicode").get<string>("executable", "multicode").trim();
    if (configured !== "multicode") return { executable: configured, prefixArgs: [] };

    const bundledCli = path.join(this.context.extensionPath, "dist/multicode-cli.cjs");
    if (existsSync(bundledCli)) return { executable: "node", prefixArgs: [bundledCli] };
    const developmentCli = path.resolve(this.context.extensionPath, "../../packages/cli/dist/index.js");
    if (existsSync(developmentCli)) return { executable: "node", prefixArgs: [developmentCli] };
    return { executable: configured, prefixArgs: [] };
  }

  private runCliCommand(args: string[], cwd: string): Promise<void> {
    const command = this.cliCommand();
    return new Promise((resolve, reject) => {
      const child = spawn(command.executable, [...command.prefixArgs, ...args], { cwd, env: this.sessionEnvironment() });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (data: Buffer) => { const text = data.toString(); stdout += text; this.output.append(text); });
      child.stderr.on("data", (data: Buffer) => { const text = data.toString(); stderr += text; this.output.append(text); });
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error((stderr || stdout || `MultiCode exited with code ${code ?? "unknown"}`).trim())));
    });
  }

  private sessionEnvironment(includeClaudeKey = false): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    if (includeClaudeKey && this.agentProvider === "claude" && this.claudeApiKey) env.ANTHROPIC_API_KEY = this.claudeApiKey;
    const configured = vscode.workspace.getConfiguration("multicode").get<string>("codexExecutable")?.trim();
    let codexDirectory = configured && path.isAbsolute(configured) && existsSync(configured)
      ? path.dirname(configured)
      : undefined;

    if (!codexDirectory) {
      const codexExtension = vscode.extensions.getExtension("openai.chatgpt");
      if (codexExtension) {
        const binRoot = path.join(codexExtension.extensionPath, "bin");
        try {
          for (const entry of readdirSync(binRoot, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const directory = path.join(binRoot, entry.name);
            const executable = path.join(directory, process.platform === "win32" ? "codex.exe" : "codex");
            if (existsSync(executable)) { codexDirectory = directory; break; }
          }
        } catch { /* The Codex extension may use a different installation layout. */ }
      }
    }

    if (codexDirectory) {
      const pathKey = Object.keys(env).find((key) => key.toLocaleLowerCase() === "path") ?? "PATH";
      env[pathKey] = [codexDirectory, env[pathKey]].filter(Boolean).join(path.delimiter);
    }
    return env;
  }

  private async prepareClaudeSubscription(executable: string): Promise<boolean> {
    let status: { loggedIn?: boolean; authMethod?: string } | undefined;
    try {
      status = await this.readClaudeAuthStatus(executable);
    } catch (error) {
      const selection = await vscode.window.showWarningMessage(
        `MultiCode could not verify the local Claude login: ${error instanceof Error ? error.message : String(error)}`,
        { modal: true, detail: "You can continue and let the Agent SDK validate the login, or open a terminal to sign in first." },
        "Continue",
        "Open Sign-In Terminal",
      );
      if (selection === "Open Sign-In Terminal") this.openClaudeSignInTerminal(executable);
      if (selection !== "Continue") return false;
    }

    if (status && status.loggedIn !== true) {
      const selection = await vscode.window.showErrorMessage("Claude is not signed in on this machine. Sign in before hosting with your subscription.", "Open Sign-In Terminal");
      if (selection === "Open Sign-In Terminal") this.openClaudeSignInTerminal(executable);
      return false;
    }
    if (status?.authMethod === "api_key") {
      const selection = await vscode.window.showErrorMessage("Claude resolved an API key instead of a subscription login. Sign in with your Claude account, or select API-key authentication explicitly.", "Open Sign-In Terminal", "Select Authentication");
      if (selection === "Open Sign-In Terminal") this.openClaudeSignInTerminal(executable);
      if (selection === "Select Authentication") await this.selectClaudeAuthentication();
      return false;
    }

    const accepted = await vscode.window.showWarningMessage(
      "This room will use your locally signed-in Claude account. Prompts submitted by allowed collaborators will count against that account's limits.",
      { modal: true, detail: "Room prompts and shared workspace content are sent to Anthropic under the host account's data settings. Claude tool actions still require the configured approvals." },
      "Host Room",
    );
    return accepted === "Host Room";
  }

  private readClaudeAuthStatus(executable: string): Promise<{ loggedIn?: boolean; authMethod?: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, ["auth", "status", "--json"], { env: this.sessionEnvironment() });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (callback: () => void): void => { if (settled) return; settled = true; clearTimeout(timer); callback(); };
      const timer = setTimeout(() => { child.kill("SIGTERM"); finish(() => reject(new Error("authentication check timed out"))); }, 5_000);
      child.stdout.on("data", (data: Buffer) => { if (stdout.length < 64 * 1024) stdout += data.toString(); });
      child.stderr.on("data", (data: Buffer) => { if (stderr.length < 4 * 1024) stderr += data.toString(); });
      child.once("error", (error) => finish(() => reject(error)));
      child.once("close", (code) => finish(() => {
        try {
          const parsed = JSON.parse(stdout) as Record<string, unknown>;
          resolve({
            ...(typeof parsed.loggedIn === "boolean" ? { loggedIn: parsed.loggedIn } : {}),
            ...(typeof parsed.authMethod === "string" ? { authMethod: parsed.authMethod } : {}),
          });
        } catch {
          reject(new Error(code !== 0 ? (stderr || `Claude exited with code ${code ?? "unknown"}`).trim() : "Claude returned an unreadable authentication status"));
        }
      }));
    });
  }

  private openClaudeSignInTerminal(executable: string): void {
    const terminal = vscode.window.createTerminal({ name: "Claude Sign In", shellPath: executable, shellArgs: ["auth", "login"], env: this.sessionEnvironment() });
    terminal.show();
  }

  private workspaceDirectory(required = true): string {
    const directory = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (directory) return directory;
    if (required) void vscode.window.showErrorMessage("Open a Git repository before hosting a MultiCode room.");
    return process.cwd();
  }

  private ensureIdle(): boolean {
    if (!this.process && !this.roomWorkspaceReady) return true;
    void vscode.window.showWarningMessage("A MultiCode session is already running. Stop it before starting another.");
    return false;
  }

  private async backToStart(): Promise<void> {
    if (this.process || this.roomWorkspaceReady) throw new Error("Stop the active MultiCode session before returning to the start screen");
    await this.forgetWorkspaceHandoff();
    this.collaboration.disconnect();
    this.mode = undefined;
    this.roomCode = undefined;
    this.roomWorkspace = undefined;
    this.roomSessionId = undefined;
    this.roomWorkspaceReady = false;
    this.pendingCollaboration = undefined;
    this.activeCollaboration = undefined;
    this.stopping = false;
    this.recentOutput = "";
    this.setIdle();
    void vscode.commands.executeCommand("setContext", "multicode.connected", false);
  }

  private validRoomToken(value: string): boolean {
    const input = value.trim();
    if (/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}\.[A-Za-z0-9_-]{40,}$/i.test(input)) return true;
    try { const url = new URL(input); const token = new URLSearchParams(url.hash.replace(/^#/, "")).get("token") ?? ""; return (url.protocol === "ws:" || url.protocol === "wss:") && /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}\.[A-Za-z0-9_-]{40,}$/i.test(token); } catch { return false; }
  }

  private defaultName(): string {
    try {
      return userInfo().username;
    } catch {
      return "participant";
    }
  }

  private async ensureDirectWorkspace(directory: string): Promise<string | undefined> {
    const managed = await inspectManagedRoomWorktree(directory).catch(() => null);
    const original = managed?.repositoryRoot ?? await resolveHostingDirectory(directory);
    if (path.resolve(original) === path.resolve(directory)) return original;
    if (managed?.version === 2) {
      try {
        await this.runCliCommand(["cleanup", managed.roomId, "--force"], original);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.output.appendLine(`\nUnable to remove the legacy room worktrees: ${message}`);
        void vscode.window.showErrorMessage("MultiCode could not remove the legacy room worktrees. See the MultiCode output for details.");
        return undefined;
      }
      await vscode.window.showInformationMessage("Legacy room worktrees were removed. Reopen Host or Join after this window switches to the original checkout.");
    } else {
      await vscode.window.showInformationMessage("MultiCode uses the original checkout directly. Reopen Host or Join after this window switches folders.");
    }
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(original), { forceNewWindow: false });
    return undefined;
  }

  private reportLaunchError(error: Error): void {
    this.output.appendLine(`\nUnable to launch MultiCode: ${error.message}`);
    this.chat.fail(`Unable to launch MultiCode: ${error.message}`);
    void vscode.window.showErrorMessage(
      "Unable to launch the MultiCode CLI. Run npm run setup:cli or set multicode.executable in Settings.",
      "Open Settings",
    ).then((selection) => {
      if (selection === "Open Settings") void vscode.commands.executeCommand("workbench.action.openSettings", "multicode.executable");
    });
  }

  private setIdle(): void {
    this.status.text = "$(broadcast) MultiCode";
    this.status.tooltip = "Host a MultiCode room";
    this.status.command = "multicode.host";
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const controller = new MultiCodeController(context);
  void controller.migrateClaudeAuthentication().catch((error: unknown) => {
    void vscode.window.showWarningMessage(`MultiCode could not migrate Claude authentication settings: ${error instanceof Error ? error.message : String(error)}`);
  });
  void controller.restoreWorkspaceSession().catch((error: unknown) => {
    void vscode.window.showWarningMessage(`MultiCode could not restore this room connection: ${error instanceof Error ? error.message : String(error)}`);
  });
  context.subscriptions.push(
    controller,
    vscode.window.registerWebviewViewProvider(MultiCodeChatView.viewType, controller.chat, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("multicode.host", () => controller.host()),
    vscode.commands.registerCommand("multicode.join", () => controller.join()),
    vscode.commands.registerCommand("multicode.openChat", () => controller.openChat()),
    vscode.commands.registerCommand("multicode.sendPrompt", () => controller.sendPrompt()),
    vscode.commands.registerCommand("multicode.doctor", () => controller.doctor()),
    vscode.commands.registerCommand("multicode.selectClaudeAuthentication", () => controller.selectClaudeAuthentication()),
    vscode.commands.registerCommand("multicode.configureClaudeApiKey", () => controller.configureClaudeApiKey()),
    vscode.commands.registerCommand("multicode.forgetClaudeApiKey", () => controller.forgetClaudeApiKey()),
    vscode.commands.registerCommand("multicode.stop", () => controller.stop()),
    vscode.commands.registerCommand("multicode.openProposal", () => controller.openProposal()),
    vscode.commands.registerCommand("multicode.openPreview", () => controller.openPreview()),
  );
}

export function deactivate(): void {}
