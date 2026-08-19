import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import * as vscode from "vscode";

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
  private stopping = false;
  private recentOutput = "";

  constructor(private readonly context: vscode.ExtensionContext) {
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

  async join(): Promise<void> {
    if (!this.ensureIdle()) return;
    const code = await vscode.window.showInputBox({
      title: "Join a MultiCode room",
      prompt: "Enter the room code shared by the host",
      placeHolder: "K7MNP-4XQ2R",
      ignoreFocusOut: true,
      validateInput: (value) => this.validRoomCode(value) ? undefined : "Enter a 10-character MultiCode room code",
    });
    if (!code) return;

    const config = vscode.workspace.getConfiguration("multicode");
    const name = config.get<string>("displayName")?.trim() || this.defaultName();
    const relay = config.get<string>("relayUrl")?.trim();
    const args = ["join", this.normalizeRoomCode(code), "--name", name];
    if (relay) args.push("--relay", relay);
    this.roomCode = this.normalizeRoomCode(code);
    this.startSession("join", args, this.workspaceDirectory(false));
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
    if (prompt?.trim()) this.process.stdin.write(`${prompt.trim()}\n`);
  }

  async doctor(): Promise<void> {
    const cwd = this.workspaceDirectory(false);
    this.output.clear();
    this.output.show(true);
    this.output.appendLine("$ multicode doctor\n");
    const command = this.cliCommand();
    const child = spawn(command.executable, [...command.prefixArgs, "doctor"], { cwd, env: process.env });
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
    this.status.text = "$(sync~spin) MultiCode: stopping";
    this.process.kill("SIGINT");
    const activeProcess = this.process;
    setTimeout(() => {
      if (this.process === activeProcess) activeProcess.kill("SIGTERM");
    }, 10_000);
  }

  dispose(): void {
    if (this.process) this.process.kill("SIGTERM");
    this.output.dispose();
    this.status.dispose();
  }

  private startSession(mode: SessionMode, args: string[], cwd: string): void {
    const command = this.cliCommand();
    this.mode = mode;
    this.stopping = false;
    this.recentOutput = "";
    this.output.clear();
    this.output.show(true);
    this.output.appendLine(`$ multicode ${args.join(" ")}\n`);
    this.status.text = `$(sync~spin) MultiCode: ${mode === "host" ? "hosting" : "joining"}`;
    this.status.tooltip = "Open MultiCode output";
    this.status.command = "multicode.sendPrompt";
    void vscode.commands.executeCommand("setContext", "multicode.connected", true);

    const child = spawn(command.executable, [...command.prefixArgs, ...args], { cwd, env: process.env });
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
      this.setIdle();
      void vscode.commands.executeCommand("setContext", "multicode.connected", false);
      if (unexpected) void vscode.window.showErrorMessage("The MultiCode session ended unexpectedly. See the MultiCode output for details.");
    });
  }

  private handleOutput(text: string): void {
    this.output.append(text);
    this.recentOutput = `${this.recentOutput}${text}`.slice(-2_000);
    if (this.mode === "host") {
      const match = this.recentOutput.match(/Room code:\s*([A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5})/i);
      if (match?.[1]) {
        this.roomCode = match[1].toUpperCase();
        this.status.text = `$(broadcast) MultiCode: ${this.roomCode}`;
        this.status.tooltip = "Click to send a prompt";
        void vscode.env.clipboard.writeText(this.roomCode);
        void vscode.window.showInformationMessage(`MultiCode room ${this.roomCode} is ready. The code was copied to your clipboard.`);
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

  private validRoomCode(value: string): boolean {
    return /^[A-HJ-NP-Z2-9]{5}-?[A-HJ-NP-Z2-9]{5}$/i.test(value.trim());
  }

  private normalizeRoomCode(value: string): string {
    const compact = value.trim().replace(/-/g, "").toUpperCase();
    return `${compact.slice(0, 5)}-${compact.slice(5)}`;
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
    vscode.commands.registerCommand("multicode.host", () => controller.host()),
    vscode.commands.registerCommand("multicode.join", () => controller.join()),
    vscode.commands.registerCommand("multicode.sendPrompt", () => controller.sendPrompt()),
    vscode.commands.registerCommand("multicode.doctor", () => controller.doctor()),
    vscode.commands.registerCommand("multicode.stop", () => controller.stop()),
  );
}

export function deactivate(): void {}
