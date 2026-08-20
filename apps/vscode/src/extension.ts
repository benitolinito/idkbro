import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { MultiCodeChatView } from "./chat-view.js";
import { CollaborationBridge } from "./collaboration.js";
import { roomTokenFromOutput, roomWorkspaceFromOutput } from "./output-parser.js";

type SessionMode = "host" | "join";

interface CliCommand {
  executable: string;
  prefixArgs: string[];
}

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
  private readonly collaboration: CollaborationBridge;

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
  }

  async host(): Promise<void> {
    if (!this.ensureIdle()) return;
    const cwd = this.workspaceDirectory();
    if (!cwd) return;

    const config = vscode.workspace.getConfiguration("multicode");
    const name = config.get<string>("displayName")?.trim() || this.defaultName();
    const relay = config.get<string>("relayUrl")?.trim();
    const args = ["host", "--name", name];
    if (relay) args.push("--relay", relay);
    this.startSession("host", args, cwd);
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

    const config = vscode.workspace.getConfiguration("multicode");
    const name = config.get<string>("displayName")?.trim() || this.defaultName();
    const relay = config.get<string>("relayUrl")?.trim();
    const args = ["join", code.trim(), "--name", name];
    if (relay) args.push("--relay", relay);
    this.roomCode = code.trim();
    this.startSession("join", args, this.workspaceDirectory(false));
    this.collaboration.connect(relay || "wss://multicode.luisagd.com", code.trim(), name);
  }

  async sendPrompt(): Promise<void> {
    if (!this.process) {
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
    if (!this.process?.stdin.writable) {
      void vscode.window.showWarningMessage("Join or host a MultiCode room before sending a prompt.");
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
    if (!this.process) return;
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
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) return;
    const proposal = vscode.Uri.joinPath(root, ".multicode-agent-conflict.patch");
    try {
      await vscode.workspace.fs.stat(proposal);
      await vscode.window.showTextDocument(proposal, { preview: false });
    } catch {
      void vscode.window.showInformationMessage("There is no pending agent conflict proposal in this room.");
    }
  }

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
      this.process = undefined;
      this.mode = undefined;
      this.roomCode = undefined;
      this.roomWorkspace = undefined;
      this.collaboration.disconnect();
      this.chat.stopped(unexpected ? `Session ended unexpectedly (${signal ?? `code ${code ?? "unknown"}`})` : "Room closed");
      this.setIdle();
      void vscode.commands.executeCommand("setContext", "multicode.connected", false);
      if (unexpected) void vscode.window.showErrorMessage("The MultiCode session ended unexpectedly. See the MultiCode output for details.");
    });
  }

  private handleOutput(text: string): void {
    this.output.append(text);
    this.recentOutput = `${this.recentOutput}${text}`.slice(-2_000);
    const parsedWorkspace = roomWorkspaceFromOutput(this.recentOutput);
    if (parsedWorkspace && !this.roomWorkspace) {
      const roomWorkspace = parsedWorkspace.trim();
      if (path.isAbsolute(roomWorkspace)) this.roomWorkspace = roomWorkspace;
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
        const relay = vscode.workspace.getConfiguration("multicode").get<string>("relayUrl")?.trim() || "wss://multicode.luisagd.com";
        this.collaboration.connect(relay, this.roomCode, this.defaultName());
      }
    } else if (this.recentOutput.includes("Joined room")) {
      this.status.text = `$(people) MultiCode: ${this.roomCode ?? "joined"}`;
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
    if (!this.process) return true;
    void vscode.window.showWarningMessage("A MultiCode session is already running. Stop it before starting another.");
    return false;
  }

  private validRoomToken(value: string): boolean {
    return /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}\.[A-Za-z0-9_-]{40,}$/i.test(value.trim());
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
  );
}

export function deactivate(): void {}
