#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { Command } from "commander";
import { CodexAppServerAdapter } from "@multicode/agent-adapters";
import type { AgentEvent } from "@multicode/protocol";
import { createTaskWorktree, inspectRepository } from "@multicode/workspace";

const execFileAsync = promisify(execFile);

async function versionOf(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { encoding: "utf8" });
    return (stdout || stderr).trim().split("\n").at(-1) ?? null;
  } catch {
    return null;
  }
}

async function doctor(): Promise<void> {
  const [gitVersion, codexVersion] = await Promise.all([
    versionOf("git", ["--version"]),
    versionOf("codex", ["--version"]),
  ]);

  const checks = [
    { name: "Node.js", ok: Number(process.versions.node.split(".")[0]) >= 20, detail: process.version },
    { name: "Git", ok: Boolean(gitVersion), detail: gitVersion ?? "not found" },
    { name: "Codex CLI", ok: Boolean(codexVersion), detail: codexVersion ?? "not found" },
  ];

  for (const check of checks) {
    console.log(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`);
  }

  try {
    const repository = await inspectRepository(process.cwd());
    console.log(`✓ Repository: ${repository.root}`);
    console.log(`  HEAD: ${repository.head.slice(0, 12)}${repository.dirty ? " (uncommitted changes excluded)" : ""}`);
  } catch (error) {
    console.log(`- Repository: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

function printAgentEvent(event: AgentEvent): void {
  switch (event.type) {
    case "agent.message.delta":
      process.stdout.write(event.text);
      break;
    case "command.output":
      process.stdout.write(event.text);
      break;
    case "approval.requested":
      console.error(`\nApproval required locally (${event.approvalKind}, request ${event.requestId}).`);
      console.error("Interactive approval handling is the next implementation slice; leaving the request pending.");
      break;
    case "agent.error":
      console.error(`\n[codex] ${event.message}`);
      break;
    default:
      console.error(`\n[${event.type}] ${JSON.stringify(event)}`);
  }
}

async function createRoom(options: {
  agent: string;
  prompt?: string;
  model?: string;
  dryRun?: boolean;
}): Promise<void> {
  if (options.agent !== "codex") throw new Error("Only the codex adapter is available in this milestone");

  const repository = await inspectRepository(process.cwd());
  console.log(`✓ Repository: ${repository.root}`);
  if (repository.dirty) console.log("! Uncommitted changes will not be included; the room starts from HEAD.");
  if (repository.operationInProgress) throw new Error("Finish the current Git operation before creating a room");

  if (options.dryRun) {
    console.log(`✓ Base commit: ${repository.head}`);
    console.log("✓ Repository is ready for an isolated room");
    return;
  }

  const roomId = randomUUID().split("-")[0] as string;
  const worktree = await createTaskWorktree({ cwd: repository.root, roomId });
  console.log(`✓ Branch: ${worktree.branch}`);
  console.log(`✓ Worktree: ${worktree.path}`);

  const adapter = new CodexAppServerAdapter();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.error("\nStopping local room...");
    await adapter.stop();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());

  const eventTask = (async () => {
    for await (const event of adapter.events()) printAgentEvent(event);
  })();

  const { threadId } = await adapter.start({ cwd: worktree.path, ...(options.model ? { model: options.model } : {}) });
  console.log(`✓ Codex thread: ${threadId}`);

  if (options.prompt) {
    await adapter.sendPrompt({ promptId: randomUUID(), text: options.prompt });
  } else {
    console.log("Room is running locally. Pass --prompt to begin a turn.");
  }

  await eventTask;
}

const program = new Command()
  .name("multicode")
  .description("Collaborate around a local coding-agent session")
  .version("0.1.0");

program.command("doctor").description("Check local prerequisites").action(doctor);

const room = program.command("room").description("Manage collaboration rooms");
room
  .command("create")
  .description("Create an isolated local agent room")
  .option("--agent <agent>", "agent adapter", "codex")
  .option("--prompt <prompt>", "send an initial prompt")
  .option("--model <model>", "override the configured Codex model")
  .option("--dry-run", "validate the repository without creating a worktree")
  .action(createRoom);

program.parseAsync().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

