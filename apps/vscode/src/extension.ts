import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { MultiCodeChatView } from "./chat-view.js";
import { CollaborationBridge } from "./collaboration.js";
import { resolveHostingDirectory } from "./host-workspace.js";
import { roomTokenFromOutput, roomWorkspaceFromOutput } from "./output-parser.js";
import { workspaceHandoffId, workspaceHandoffSecretKey, type WorkspaceHandoff } from "./workspace-handoff.js";

type SessionMode = "host" | "join";

interface CliCommand {
  executable: string;
  prefixArgs: string[];
}

const workspaceHandoffsKey = "multicode.workspace-handoffs.v1";

class MultiCodeController implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel("MultiCode");
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 25);
  private process: ChildProcessWithoutNullStreams | undefined;
  private mode: SessionMode | undefined;
  private roomCode: string | undefined;
  private roomWorkspace: string | undefined;
  private stopping = false;
  private recentOutput = "";
  readonly chat: MultiCodeChatView;
  private roomWorkspaceReady = false;
  private pendingCollaboration: { relay: string; token: string; name: string; role: "viewer" | "editor" } | undefined;
  private readonly collaboration: CollaborationBridge;
  private openingRoomWorkspace: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.chat = new MultiCodeChatView(context.extensionUri, {
      host: () => this.host(),
      join: (token) => this.join(token),
      stop: () => this.stop(),
      submit: (text) => this.submitPrompt(text),
      copyInvite: () => this.copyInvite(),
      openOutput: () => this.openOutput(),
    });
    this.collaboration = new CollaborationBridge((message) => this.chat.handle(message));
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
    const workspaceDirectory = this.workspaceDirectory();
    if (!workspaceDirectory) return;
    const cwd = await resolveHostingDirectory(workspaceDirectory);

    const config = vscode.workspace.getConfiguration("multicode");
    const name = config.get<string>("displayName")?.trim() || this.defaultName();
    const relay = config.get<string>("relayUrl")?.trim();
    const args = ["host", "--name", name];
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
    this.roomCode = token;
    this.roomWorkspace = workspace;
    this.roomWorkspaceReady = true;
    this.collaboration.setWorkspaceRoot(vscode.Uri.file(workspace));
    this.chat.start(handoff.mode, handoff.roomLabel);
    this.chat.ready(handoff.roomLabel);
    this.status.text = `$(people) MultiCode: ${handoff.roomLabel}`;
    this.status.tooltip = "Click to send a prompt";
    this.status.command = "multicode.sendPrompt";
    void vscode.commands.executeCommand("setContext", "multicode.connected", true);
    this.collaboration.connect(handoff.relay, token, handoff.name, handoff.role);
    this.openChat();
  }

  async join(providedToken?: string): Promise<void> {
    if (!this.ensureIdle()) return;
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
    const role = await vscode.window.showQuickPick([
      { label: "Editor", description: "Edit files and submit prompts", role: "editor" as const },
      { label: "Viewer", description: "Observe files, presence, and agent activity", role: "viewer" as const },
    ], { title: "Choose room access", ignoreFocusOut: true });
    if (!role) return;

    const config = vscode.workspace.getConfiguration("multicode");
    const name = config.get<string>("displayName")?.trim() || this.defaultName();
    const relay = config.get<string>("relayUrl")?.trim();
    const invite = code.trim(); const args = ["join", invite, "--name", name];
    args.push("--bootstrap-only");
    if (role.role === "viewer") args.push("--viewer");
    if (relay) args.push("--relay", relay);
    this.roomCode = code.trim();
    this.startSession("join", args, this.workspaceDirectory(false));
    let collaborationRelay = relay || "wss://multicode.luisagd.com"; let collaborationToken = invite;
    if (/^wss?:\/\//i.test(invite)) {
      const url = new URL(invite); collaborationToken = new URLSearchParams(url.hash.replace(/^#/, "")).get("token") ?? "";
      url.hash = ""; url.search = ""; url.pathname = url.pathname.replace(/\/rooms\/[^/]+\/?$/, ""); collaborationRelay = url.toString();
    }
    this.pendingCollaboration = { relay: collaborationRelay, token: collaborationToken, name, role: role.role };
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

  async submitPrompt(text: string): Promise<void> {
    const prompt = text.trim();
    if (!prompt) return;
    if (this.roomWorkspaceReady && this.collaboration.sendPrompt(prompt)) return;
    if (!this.process?.stdin.writable) {
      void vscode.window.showWarningMessage("MultiCode is reconnecting; the prompt was not sent.");
      return;
    }
    this.process.stdin.write(`${prompt}\n`);
  }

  async copyInvite(): Promise<void> {
    if (!this.roomCode) return;
    await vscode.env.clipboard.writeText(this.roomCode);
    void vscode.window.showInformationMessage("MultiCode invite token copied.");
  }

  openOutput(): void {
    this.output.show(true);
  }

  openChat(): void {
    void vscode.commands.executeCommand(`${MultiCodeChatView.viewType}.focus`);
  }

  async doctor(): Promise<void> {
    const cwd = this.workspaceDirectory(false);
    this.output.clear();
    this.output.show(true);
    this.output.appendLine("$ multicode doctor\n");
    const command = this.cliCommand();
    const child = spawn(command.executable, [...command.prefixArgs, "doctor"], { cwd, env: this.sessionEnvironment() });
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
      this.collaboration.disconnect(); this.roomWorkspaceReady = false; this.setIdle(); void vscode.commands.executeCommand("setContext", "multicode.connected", false); return;
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
    this.roomWorkspaceReady = false;
    this.openingRoomWorkspace = undefined;
    this.pendingCollaboration = undefined;
    this.collaboration.disconnect();
    this.output.clear();
    this.output.appendLine(`$ multicode ${args.join(" ")}\n`);
    this.chat.start(mode, mode === "join" ? this.roomCode?.slice(0, 11) : undefined);
    this.openChat();
    this.status.text = `$(sync~spin) MultiCode: ${mode === "host" ? "hosting" : "joining"}`;
    this.status.tooltip = "Open MultiCode output";
    this.status.command = "multicode.sendPrompt";
    void vscode.commands.executeCommand("setContext", "multicode.connected", true);

    const child = spawn(command.executable, [...command.prefixArgs, ...args], { cwd, env: this.sessionEnvironment() });
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
        this.status.tooltip = "Live collaboration continues through the room workspace";
      } else {
        void this.forgetWorkspaceHandoff();
        this.mode = undefined;
        this.roomCode = undefined;
        this.roomWorkspace = undefined;
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
    if (this.mode === "join" && /Workspace synchronized/i.test(this.recentOutput) && this.roomWorkspace) {
      this.roomWorkspaceReady = true; this.connectCollaborationWhenSafe();
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
        this.pendingCollaboration = { relay, token: this.roomCode, name, role: "editor" };
        this.connectCollaborationWhenSafe();
      }
    } else if (this.recentOutput.includes("Joined room")) {
      this.status.text = `$(people) MultiCode: ${this.roomCode ?? "joined"}`;
    }
  }

  private connectCollaborationWhenSafe(): void {
    if (!this.roomWorkspaceReady || !this.pendingCollaboration) return;
    const pending = this.pendingCollaboration;
    this.pendingCollaboration = undefined;
    this.collaboration.connect(pending.relay, pending.token, pending.name, pending.role);
    void this.openRoomWorkspace(pending);
  }

  private async openRoomWorkspace(connection: { relay: string; token: string; name: string; role: "viewer" | "editor" }): Promise<void> {
    const workspace = this.roomWorkspace;
    if (!workspace || this.openingRoomWorkspace === workspace) return;
    this.openingRoomWorkspace = workspace;
    const id = workspaceHandoffId(workspace);
    const handoff: WorkspaceHandoff = {
      workspace,
      relay: connection.relay,
      name: connection.name,
      role: connection.role,
      mode: this.mode ?? "join",
      roomLabel: connection.token.slice(0, 11),
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
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(workspace), { forceNewWindow: true });
    } catch (error) {
      this.openingRoomWorkspace = undefined;
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`\nUnable to open the room workspace: ${message}`);
      void vscode.window.showWarningMessage("The room is running, but MultiCode could not open its isolated workspace. See the MultiCode output for details.");
    }
  }

  private async forgetWorkspaceHandoff(): Promise<void> {
    const workspace = this.roomWorkspace;
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

  private cliCommand(): CliCommand {
    const configured = vscode.workspace.getConfiguration("multicode").get<string>("executable", "multicode").trim();
    if (configured !== "multicode") return { executable: configured, prefixArgs: [] };

    const bundledCli = path.join(this.context.extensionPath, "dist/multicode-cli.cjs");
    if (existsSync(bundledCli)) return { executable: "node", prefixArgs: [bundledCli] };
    const developmentCli = path.resolve(this.context.extensionPath, "../../packages/cli/dist/index.js");
    if (existsSync(developmentCli)) return { executable: "node", prefixArgs: [developmentCli] };
    return { executable: configured, prefixArgs: [] };
  }

  private sessionEnvironment(): NodeJS.ProcessEnv {
    const env = { ...process.env };
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
    vscode.commands.registerCommand("multicode.stop", () => controller.stop()),
    vscode.commands.registerCommand("multicode.openProposal", () => controller.openProposal()),
    vscode.commands.registerCommand("multicode.openPreview", () => controller.openPreview()),
  );
}

export function deactivate(): void {}
