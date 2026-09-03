#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { homedir, networkInterfaces, userInfo } from "node:os";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import chalk, { chalkStderr } from "chalk";
import { Command } from "commander";
import { createAgentAdapter } from "@multicode/agent-adapters";
import { LocalIpcServer, loadOrCreateRoomSecret, requestLocalIpc, roomSecret, writeSessionToken } from "@multicode/session-core";
import {
  isSensitiveWorkspacePath,
  checkpointChunkBytes,
  parseApprovalRequestId,
  type AgentEvent,
  type AgentInputAnswers,
  type AgentProvider,
  type ApprovalDecision,
  type CollaborationEvent,
  type Capability,
  type RelayServerMessage,
  type RoomServerMessage,
  type RoomParticipant,
  type WorkspaceDiff,
  type WorkspaceDiffFile,
  type WorkspaceCheckpoint,
  type WorkspaceCheckpointDescriptor,
} from "@multicode/protocol";
import { PostgresRelayRoomStore, RelayServer, RoomRelay } from "@multicode/relay";
import {
  closeDirectHostedWorkspace,
  cleanupLegacyHostedWorkspace,
  cleanupParticipantWorkspace,
  createPortableWorkspaceCheckpoint,
  createWorkspaceCheckpoint,
  encryptWorkspaceCheckpointBundle,
  inspectManagedRoomWorktree,
  inspectRepository,
  prepareDirectHostedWorkspace,
  sanitizeRoomId,
  type DirectHostedWorkspace,
} from "@multicode/workspace";
import WebSocket from "ws";
import { discoverLiveSessionForWorkspace } from "./live-session.js";
import { claudeAuthMode, claudeEnvironment, preflightClaudeAuthentication, readClaudeAuthStatus, type ClaudeAuthMode } from "./claude-auth.js";
import { renderTerminalMarkdown } from "./markdown.js";
import { parseWorkspaceNumstat } from "./workspace-diff.js";
import { runInteractiveCli } from "./ui.js";

const execFileAsync = promisify(execFile);
const defaultRelayUrl = process.env.MULTICODE_RELAY_URL ?? "wss://multicode.luisagd.com";
const inviteAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
let activeAgentDisplayName = "Agent";

function agentProvider(value: string): AgentProvider {
  if (value === "codex" || value === "claude") return value;
  throw new Error(`Unsupported agent provider: ${value}. Use codex or claude.`);
}

function agentExecutable(provider: AgentProvider, configured?: string): string {
  return configured?.trim() || (provider === "claude" ? process.env.MULTICODE_CLAUDE_EXECUTABLE?.trim() : process.env.MULTICODE_CODEX_EXECUTABLE?.trim()) || provider;
}

function adapterFor(providerValue: string, executablePath?: string, authModeValue?: string) {
  const provider = agentProvider(providerValue);
  const executable = agentExecutable(provider, executablePath);
  const environment = provider === "claude" ? claudeEnvironment(claudeAuthMode(authModeValue), process.env) : { ...process.env };
  return createAgentAdapter({ provider, executablePath: executable, environment });
}

function claudeAuthDetail(source: string, subscriptionType?: string): string {
  if (source === "subscription") return subscriptionType ? `Claude subscription (${subscriptionType})` : "Claude subscription";
  if (source === "api-key") return "Anthropic API key";
  if (source === "oauth") return "OAuth credential (billing source unverified)";
  if (source === "signed-out") return "not signed in";
  return "credential source could not be verified";
}

async function preflightAgentAuthentication(provider: AgentProvider, executablePath: string | undefined, authModeValue: string | undefined): Promise<ClaudeAuthMode | undefined> {
  if (provider !== "claude") return undefined;
  const mode = claudeAuthMode(authModeValue);
  const executable = agentExecutable(provider, executablePath);
  const status = await preflightClaudeAuthentication(executable, mode, process.env);
  if (status) console.log(out.success(`${out.label("Claude authentication")} ${out.muted(claudeAuthDetail(status.source, status.subscriptionType))}`));
  return mode;
}

function localInviteCode(): string { const bytes = randomBytes(10); const value = [...bytes].map((byte) => inviteAlphabet[byte % inviteAlphabet.length]).join(""); return `${value.slice(0, 5)}-${value.slice(5)}`; }

const out = {
  success: (message: string) => `${chalk.green("✓")} ${message}`,
  warning: (message: string) => `${chalk.yellow("!")} ${message}`,
  label: (label: string) => chalk.bold(label),
  value: (value: string) => chalk.cyan(value),
  muted: (value: string) => chalk.dim(value),
  command: (value: string) => chalk.cyan(value),
};

const err = {
  success: (message: string) => `${chalkStderr.green("✓")} ${message}`,
  error: (message: string) => `${chalkStderr.red("✗")} ${message}`,
  info: (symbol: string, message: string) => `${chalkStderr.cyan(symbol)} ${message}`,
  warning: (message: string) => `${chalkStderr.yellow("!")} ${message}`,
  label: (label: string) => chalkStderr.bold(label),
  value: (value: string) => chalkStderr.cyan(value),
  muted: (value: string) => chalkStderr.dim(value),
};

const streamingReasoningItems = new Set<string>();
const streamingAssistantItems = new Map<string, { turnId: string; text: string }>();

function finishAssistantMessage(itemId: string, completedText?: string): void {
  const buffered = streamingAssistantItems.get(itemId);
  streamingAssistantItems.delete(itemId);
  if (!buffered) process.stdout.write(`\n${chalk.green("●")} ${chalk.bold(activeAgentDisplayName)}\n`);
  const rendered = renderTerminalMarkdown(completedText || buffered?.text || "");
  if (rendered) process.stdout.write(`${rendered}\n`);
}

function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return value === "accept" || value === "decline" || value === "cancel";
}

function structuredAnswerCommand(value: string): { requestId: string; answers: AgentInputAnswers | null } | undefined {
  const match = /^\/answer\s+(\S+)\s+([\s\S]+)$/.exec(value);
  if (!match) return undefined;
  const requestId = match[1] as string;
  const raw = (match[2] as string).trim();
  if (raw === "cancel") return { requestId, answers: null };
  return { requestId, answers: parseAgentInputAnswers(JSON.parse(raw) as unknown) };
}

function parseAgentInputAnswers(parsed: unknown): AgentInputAnswers | null {
  if (parsed === null) return null;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Structured answers must be a JSON object or 'cancel'");
  for (const [questionId, answer] of Object.entries(parsed as Record<string, unknown>)) {
    if (!questionId || questionId.length > 512) throw new Error("Structured answer question IDs must be 1–512 characters");
    if (typeof answer === "string") { if (answer.length > 10_000) throw new Error("Structured answers must be at most 10,000 characters"); continue; }
    if (!Array.isArray(answer) || answer.length > 20 || !answer.every((item) => typeof item === "string" && item.length <= 1_000)) throw new Error("Each structured answer must be a string or string array");
  }
  return parsed as AgentInputAnswers;
}

function denyUnsupportedStructuredInput(
  event: Extract<AgentEvent, { type: "input.requested" }>,
  participants: Map<string, RoomParticipant>,
  resolve: (requestId: string, answers: AgentInputAnswers | null) => Promise<void>,
): void {
  if (process.stdin.isTTY || process.env.MULTICODE_TUI_CHILD === "1" || [...participants.values()].some((participant) => participant.capabilities.includes("reviewer") && participant.protocolCapabilities?.includes("structured-input-v1"))) return;
  const timer = setTimeout(() => {
    if ([...participants.values()].some((participant) => participant.capabilities.includes("reviewer") && participant.protocolCapabilities?.includes("structured-input-v1"))) return;
    void resolve(event.requestId, null).catch(() => undefined);
    console.error(err.warning("Claude's question was cancelled because no connected reviewer supports structured input."));
  }, 1_500);
  timer.unref();
}

async function versionOf(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { encoding: "utf8" });
    return (stdout || stderr).trim().split("\n").at(-1) ?? null;
  } catch {
    return null;
  }
}

async function doctor(options: { agent?: string; agentExecutable?: string; claudeAuth?: string } = {}): Promise<void> {
  const provider = agentProvider(options.agent ?? "codex");
  const executable = agentExecutable(provider, options.agentExecutable);
  const [gitVersion, agentVersion] = await Promise.all([
    versionOf("git", ["--version"]),
    versionOf(executable, ["--version"]),
  ]);

  const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split(".").map(Number);
  let claudeCheck: { name: string; ok: boolean; detail: string } | undefined;
  if (provider === "claude") {
    try {
      const mode = claudeAuthMode(options.claudeAuth);
      const environment = claudeEnvironment(mode, process.env);
      if (mode === "api-key") {
        claudeCheck = { name: "Claude authentication", ok: true, detail: "Anthropic API key configured" };
      } else {
        const status = await readClaudeAuthStatus(executable, environment);
        const wrongSource = mode === "subscription" && status.source === "api-key";
        claudeCheck = {
          name: "Claude authentication",
          ok: status.loggedIn && !wrongSource,
          detail: wrongSource ? "API key detected; subscription mode requires `claude auth login`" : claudeAuthDetail(status.source, status.subscriptionType),
        };
      }
    } catch (error) {
      claudeCheck = { name: "Claude authentication", ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  const checks = [
    { name: "Node.js", ok: nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 5), detail: process.version },
    { name: "Git", ok: Boolean(gitVersion), detail: gitVersion ?? "not found" },
    { name: `${provider === "claude" ? "Claude" : "Codex"} CLI`, ok: Boolean(agentVersion), detail: agentVersion ?? `not found (${executable})` },
    ...(claudeCheck ? [claudeCheck] : []),
  ];

  for (const check of checks) {
    const icon = check.ok ? chalk.green("✓") : chalk.red("✗");
    console.log(`${icon} ${out.label(check.name)} ${out.muted(check.detail)}`);
  }

  try {
    const repository = await inspectRepository(process.cwd());
    console.log(out.success(`${out.label("Repository")} ${out.value(repository.root)}`));
    console.log(`  ${out.muted("HEAD")} ${repository.head.slice(0, 12)}${repository.dirty ? out.muted(" (uncommitted changes excluded)") : ""}`);
  } catch (error) {
    console.log(`${chalk.red("✗")} ${out.label("Repository")} ${error instanceof Error ? error.message : String(error)}`);
  }

  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

function printAgentEvent(event: AgentEvent): void {
  switch (event.type) {
    case "agent.reasoning.delta":
      if (!streamingReasoningItems.has(event.itemId)) {
        streamingReasoningItems.add(event.itemId);
        process.stdout.write(`\n${chalk.cyan("◆")} ${chalk.bold("Thinking")}\n`);
      }
      process.stdout.write(chalk.dim(event.text));
      break;
    case "agent.reasoning.completed":
      if (streamingReasoningItems.delete(event.itemId)) {
        process.stdout.write("\n");
      } else if (event.text) {
        process.stdout.write(`\n${chalk.cyan("◆")} ${chalk.bold("Thinking")}\n${chalk.dim(event.text)}\n`);
      }
      break;
    case "agent.message.delta": {
      if (!streamingAssistantItems.has(event.itemId)) {
        process.stdout.write(`\n${chalk.green("●")} ${chalk.bold(activeAgentDisplayName)}\n`);
      }
      const current = streamingAssistantItems.get(event.itemId);
      streamingAssistantItems.set(event.itemId, { turnId: event.turnId, text: `${current?.text ?? ""}${event.text}` });
      break;
    }
    case "agent.message.completed":
      finishAssistantMessage(event.itemId, event.text);
      break;
    case "command.output":
      process.stdout.write(event.text);
      break;
    case "tool.started":
      console.error(`\n${err.info("◆", `${err.label(event.displayName)} ${err.muted(event.summary)}`)}`);
      break;
    case "tool.output":
      if (event.text) console.error(err.muted(event.text));
      break;
    case "tool.completed":
      console.error(event.status === "completed" ? err.success(`${event.displayName} completed`) : err.warning(`${event.displayName} ${event.status}`));
      break;
    case "approval.requested":
      console.error(`\n${err.warning(`${err.label("Approval required on the host")} ${err.muted(`(${event.approvalKind}, request ${event.requestId})`)}`)}`);
      console.error(err.muted(`  Resolve with /approve ${event.requestId} accept|decline|cancel, or grant a participant reviewer capability.`));
      break;
    case "approval.resolved":
      console.error(`\n${err.success(`${err.label("Approval resolved")} ${err.muted(`(request ${event.requestId}: ${event.decision})`)}`)}`);
      break;
    case "input.requested":
      console.error(`\n${err.warning(`${err.label("Input required on the host")} ${err.muted(`(request ${event.requestId})`)}`)}`);
      for (const question of event.questions) console.error(`  ${question.id}: ${question.question} [${question.options.map((option) => option.label).join(" | ")}]`);
      console.error(err.muted(`  Resolve with /answer ${event.requestId} {"${event.questions[0]?.id ?? "question"}":"answer"}, or /answer ${event.requestId} cancel.`));
      break;
    case "input.answered":
      console.error(`\n${err.success(`${err.label("Input answered")} ${err.muted(`(request ${event.requestId})`)}`)}`);
      break;
    case "input.cancelled":
      console.error(`\n${err.warning(`${err.label("Input cancelled")} ${err.muted(`(request ${event.requestId})`)}`)}`);
      break;
    case "agent.error":
      console.error(`\n${err.error(`${err.label(activeAgentDisplayName)} ${event.message}`)}`);
      break;
    case "turn.completed":
      for (const [itemId, item] of streamingAssistantItems) {
        if (item.turnId === event.turnId) finishAssistantMessage(itemId);
      }
      console.error(`\n${err.success(`${err.label("Turn completed")}${event.status ? err.muted(` (${event.status})`) : ""}`)}`);
      break;
    default:
      break;
  }
}

function printRoomMessage(message: RoomServerMessage, includeAgent = true): void {
  switch (message.type) {
    case "room.welcome":
      console.log(out.success(`${out.label("Joined room")} ${out.value(message.roomId)}`));
      console.log(`  ${out.muted("Participants")} ${message.participants.map((participant) => participant.name).join(", ")}`);
      if (message.activePrompt) console.log(`  ${out.muted("Active prompt")} ${out.label(message.activePrompt.participantName)}: ${message.activePrompt.text}`);
      if (message.queue.length) console.log(`  ${chalk.yellow(message.queue.length)} ${out.muted("prompt(s) waiting")}`);
      if (message.latestDiff) printWorkspaceDiff(message.latestDiff);
      break;
    case "participant.joined":
      console.error(`\n${err.info("+", `${err.label(message.participant.name)} joined the room`)}`);
      break;
    case "participant.left":
      console.error(`\n${err.muted(`− ${message.name} left the room`)}`);
      break;
    case "prompt.queued":
      console.error(`\n${err.info("→", `${err.label(message.prompt.participantName)} queued prompt ${err.muted(`#${message.position}`)}: ${message.prompt.text}`)}`);
      break;
    case "prompt.started":
      console.error(`\n${err.info("▶", `${err.label(message.prompt.participantName)}: ${message.prompt.text}`)}`);
      break;
    case "prompt.updated":
      console.error(`\n${err.info("✎", `${err.label(message.prompt.participantName)} updated a queued prompt: ${message.prompt.text}`)}`);
      break;
    case "prompt.removed":
      console.error(`\n${err.muted(`− Queued prompt ${message.promptId} removed`)}`);
      break;
    case "prompt.steered":
      console.error(`\n${err.info("↪", `${err.label(message.prompt.participantName)} steered: ${message.prompt.text}`)}`);
      break;
    case "prompt.steer":
      break;
    case "agent.event":
      if (includeAgent) printAgentEvent(message.event);
      break;
    case "workspace.diff":
      printWorkspaceDiff(message.diff);
      break;
    case "workspace.checkpoint":
      console.error(`\n${err.info("↻", `${err.label("Workspace checkpoint")} ${message.checkpoint.sequence} ${err.muted(message.checkpoint.commit.slice(0, 12))}`)}`);
      break;
    case "workspace.checkpoint.available":
      console.error(`\n${err.info("↻", `${err.label("Workspace version available")} ${message.checkpoint.sequence} ${err.muted(message.checkpoint.commit.slice(0, 12))}`)}`);
      break;
    case "participant.syncing":
      break;
    case "participant.synced":
      console.error(`\n${err.success(`${err.label("Participant synchronized")} ${err.muted(`checkpoint ${message.sequence}`)}`)}`);
      break;
    case "room.error":
      console.error(`\n${err.error(`${err.label("Room error")} ${message.message}`)}`);
      break;
  }
}

function decryptPromptMessage(message: RoomServerMessage, key: Buffer): RoomServerMessage {
  if (message.type === "prompt.queued" || message.type === "prompt.started" || message.type === "prompt.updated" || message.type === "prompt.steered" || message.type === "prompt.steer") return { ...message, prompt: { ...message.prompt, text: openPrompt(key, message.prompt.promptId, message.prompt.text) } };
  if (message.type !== "room.welcome") return message;
  return {
    ...message,
    activePrompt: message.activePrompt ? { ...message.activePrompt, text: openPrompt(key, message.activePrompt.promptId, message.activePrompt.text) } : null,
    queue: message.queue.map((prompt) => ({ ...prompt, text: openPrompt(key, prompt.promptId, prompt.text) })),
  };
}

function printWorkspaceDiff(diff: WorkspaceDiff): void {
  console.error(`\n${chalkStderr.cyan("──")} ${err.label("Workspace changes")} ${err.muted(`after ${diff.revision}${diff.truncated ? " · truncated" : ""}`)} ${chalkStderr.cyan("──")}`);
  console.error(diff.text || "No tracked workspace changes.");
  console.error(chalkStderr.cyan("────────────────────────"));
}

async function untrackedFileSummary(cwd: string, file: string): Promise<WorkspaceDiffFile> {
  try {
    const contents = await readFile(safeRoomFile(cwd, file).target);
    if (contents.includes(0)) return { path: file, additions: 0, deletions: 0, binary: true };
    const text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
    const additions = text ? text.split(/\r\n|\n|\r/).length - (/\r\n$|[\n\r]$/.test(text) ? 1 : 0) : 0;
    return { path: file, additions, deletions: 0 };
  } catch {
    return { path: file, additions: 0, deletions: 0, binary: true };
  }
}

async function readWorkspaceDiff(cwd: string, revision: string): Promise<WorkspaceDiff> {
  const maxLength = 96_000;
  let combined: string;
  let files: WorkspaceDiffFile[] = [];
  try {
    const [status, diff, numstat, untracked] = await Promise.all([
      execFileAsync("git", ["--no-optional-locks", "status", "--short"], { cwd, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }),
      execFileAsync("git", ["--no-optional-locks", "diff", "--no-ext-diff", "--unified=3", "HEAD", "--"], {
        cwd,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      }),
      execFileAsync("git", ["--no-optional-locks", "diff", "--no-ext-diff", "--numstat", "-z", "HEAD", "--"], { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }),
      execFileAsync("git", ["--no-optional-locks", "ls-files", "--others", "--exclude-standard", "-z"], { cwd, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }),
    ]);
    combined = [`Status:\n${status.stdout.trim() || "(clean)"}`, diff.stdout.trim()].filter(Boolean).join("\n\n");
    files = parseWorkspaceNumstat(numstat.stdout).filter((file) => file.path.length <= 2_048).slice(0, 64);
    const trackedPaths = new Set(files.map((file) => file.path));
    const untrackedPaths = untracked.stdout.split("\0").filter((file) => file && file.length <= 2_048 && !trackedPaths.has(file)).slice(0, 64 - files.length);
    files.push(...await Promise.all(untrackedPaths.map((file) => untrackedFileSummary(cwd, file))));
  } catch (error) {
    combined = `Unable to read workspace diff: ${error instanceof Error ? error.message : String(error)}`;
  }
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);
  return {
    revision,
    text: combined.slice(0, maxLength),
    truncated: combined.length > maxLength,
    createdAt: new Date().toISOString(),
    additions,
    deletions,
    files,
  };
}

interface EncryptedContentPayload {
  file: string;
  nonce: string;
  tag: string;
  ciphertext: string;
}

function transportKey(secret: string, roomCode: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "base64url"), Buffer.from(roomCode.replace(/-/g, "").toUpperCase()), Buffer.from("multicode/v2/transport"), 32));
}

function sealTransport(key: Buffer, plaintext: Uint8Array, aad?: string): string {
  const nonce = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, nonce); if (aad) cipher.setAAD(new TextEncoder().encode(aad)); const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return JSON.stringify({ version: 1, nonce: nonce.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") });
}

function openTransport(key: Buffer, sealed: string, aad?: string): Uint8Array {
  const value = JSON.parse(sealed) as { version?: unknown; nonce?: unknown; tag?: unknown; ciphertext?: unknown };
  if (value.version !== 1 || typeof value.nonce !== "string" || typeof value.tag !== "string" || typeof value.ciphertext !== "string") throw new Error("Invalid encrypted transport payload");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.nonce, "base64url")); if (aad) decipher.setAAD(new TextEncoder().encode(aad)); decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
  return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64url")), decipher.final()]));
}

function sealPrompt(key: Buffer, promptId: string, text: string): string { return sealTransport(key, new TextEncoder().encode(text), `prompt:${promptId}`); }
function openPrompt(key: Buffer, promptId: string, text: string): string { return new TextDecoder().decode(openTransport(key, text, `prompt:${promptId}`)); }
function sealInputAnswers(key: Buffer, requestId: string, answers: AgentInputAnswers | null): string { return sealTransport(key, new TextEncoder().encode(JSON.stringify({ answers })), `input:${requestId}`); }
function openInputAnswers(key: Buffer, requestId: string, payload: string): AgentInputAnswers | null {
  const decoded = JSON.parse(new TextDecoder().decode(openTransport(key, payload, `input:${requestId}`))) as unknown;
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded) || !("answers" in decoded)) throw new Error("Encrypted input response has no answers");
  return parseAgentInputAnswers((decoded as { answers: unknown }).answers);
}

function encryptedWorkspaceCheckpoint(key: Buffer, checkpoint: WorkspaceCheckpoint): WorkspaceCheckpoint {
  const encrypted = encryptWorkspaceCheckpointBundle(key, checkpoint.sequence, Buffer.from(checkpoint.bundle, "base64"));
  return { ...checkpoint, bundle: encrypted.toString("base64") };
}

function workspaceCheckpointDescriptor(checkpoint: WorkspaceCheckpoint): { descriptor: WorkspaceCheckpointDescriptor; bundle: Buffer } {
  const bundle = Buffer.from(checkpoint.bundle, "base64");
  return {
    descriptor: {
      sequence: checkpoint.sequence,
      baseCommit: checkpoint.baseCommit,
      commit: checkpoint.commit,
      ref: checkpoint.ref,
      bundleBytes: bundle.byteLength,
      bundleHash: createHash("sha256").update(bundle).digest("hex"),
      chunkCount: Math.ceil(bundle.byteLength / checkpointChunkBytes),
      createdAt: checkpoint.createdAt,
    },
    bundle,
  };
}

function sendRemoteWorkspaceCheckpoint(
  send: (message: unknown) => void,
  checkpoint: WorkspaceCheckpoint,
  targetParticipantId?: string,
): void {
  const { descriptor, bundle } = workspaceCheckpointDescriptor(checkpoint);
  send({ type: "relay.workspace.checkpoint.start", checkpoint: descriptor, ...(targetParticipantId ? { targetParticipantId } : {}) });
  for (let index = 0; index < descriptor.chunkCount; index += 1) {
    send({
      type: "relay.workspace.checkpoint.chunk",
      chunk: {
        sequence: checkpoint.sequence,
        index,
        data: bundle.subarray(index * checkpointChunkBytes, (index + 1) * checkpointChunkBytes).toString("base64"),
      },
      ...(targetParticipantId ? { targetParticipantId } : {}),
    });
  }
  send({ type: "relay.workspace.checkpoint.complete", sequence: checkpoint.sequence, ...(targetParticipantId ? { targetParticipantId } : {}) });
}

function serializeWorkspaceCheckpointPublisher(
  publish: (force?: boolean, targetParticipantId?: string) => Promise<void>,
): (force?: boolean, targetParticipantId?: string) => Promise<void> {
  let tail: Promise<void> = Promise.resolve();
  return (force, targetParticipantId) => {
    const result = tail.then(() => publish(force, targetParticipantId));
    tail = result.catch(() => undefined);
    return result;
  };
}
function sealAgentEvent(key: Buffer, event: AgentEvent): string {
  const safe = { ...event } as AgentEvent & { text?: string; output?: string; truncated?: boolean };
  if (typeof safe.text === "string" && safe.text.length > 96_000) { safe.text = safe.text.slice(0, 96_000); safe.truncated = true; }
  if (typeof safe.output === "string" && safe.output.length > 96_000) { safe.output = safe.output.slice(0, 96_000); safe.truncated = true; }
  return sealTransport(key, new TextEncoder().encode(JSON.stringify(safe)));
}
function safeRoomFile(root: string, file: string): { fileId: string; target: string } {
  if (!file || file.includes("\0") || file.includes("\\") || path.posix.isAbsolute(file)) throw new Error("Invalid collaborative file path");
  const normalized = path.posix.normalize(file);
  if (normalized !== file || normalized === "." || normalized.startsWith("../") || /^[A-Za-z]:/.test(normalized)) throw new Error("Collaborative file path escapes the room workspace");
  const target = path.resolve(root, ...normalized.split("/"));
  const canonicalRoot = path.resolve(root);
  if (!target.startsWith(`${canonicalRoot}${path.sep}`)) throw new Error("Workspace file path escapes the room workspace");
  return { fileId: normalized, target };
}

class RoomAuthority {
  private workspaceTail: Promise<void> = Promise.resolve();

  private constructor(private readonly contentKey: Buffer) {}

  static async create(options: {
    roomId: string;
    contentSalt: string;
    secret: string;
    workspacePath: string;
    sessionDirectory: string;
  }): Promise<RoomAuthority> {
    const secret = await loadOrCreateRoomSecret(path.join(options.sessionDirectory, "room-secret"), options.secret);
    return new RoomAuthority(
      Buffer.from(hkdfSync("sha256", Buffer.from(secret, "base64url"), Buffer.from(options.contentSalt), Buffer.from("multicode/v2/content"), 32)),
    );
  }

  withWorkspaceLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueueWorkspace(operation);
  }

  async close(): Promise<void> { await this.workspaceTail; }

  previewEvent(turnId: string, revision: number, diff: WorkspaceDiff): CollaborationEvent {
    return this.encryptedEvent("agent.preview", "__preview__", new TextEncoder().encode(JSON.stringify({ turnId, revision, diff })));
  }

  proposalEvent(turnId: string, patchText: string): CollaborationEvent {
    const truncated = patchText.length > 96_000;
    return this.encryptedEvent("agent.proposal", "__proposal__", new TextEncoder().encode(JSON.stringify({ turnId, status: "pending", patchText: truncated ? patchText.slice(0, 96_000) : patchText, truncated })));
  }

  private encryptedEvent(kind: "agent.preview" | "agent.proposal", file: string, payload: Uint8Array): CollaborationEvent {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.contentKey, nonce);
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    const encrypted: EncryptedContentPayload = {
      file,
      nonce: nonce.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };
    return {
      id: randomUUID(),
      kind,
      payload: Buffer.from(JSON.stringify(encrypted)).toString("base64url"),
      actorId: "host",
      committedAt: new Date().toISOString(),
    };
  }

  private enqueueWorkspace<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.workspaceTail.then(operation);
    this.workspaceTail = result.then(() => undefined, () => undefined);
    return result;
  }
}


class AgentPreviewWatcher {
  private watcher: FSWatcher | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private reconcileTimer: ReturnType<typeof setInterval> | undefined;
  private revision = 0;
  private turnId = "idle";

  constructor(private readonly workspacePath: string, private readonly publish: (turnId: string, revision: number, diff: WorkspaceDiff) => Promise<void> | void) {}

  start(): void {
    try {
      this.watcher = watch(this.workspacePath, { recursive: true }, (_event, filename) => {
        const file = filename?.toString().split(path.sep).join("/") ?? "";
        if (!file || /(^|\/)(\.git|node_modules|dist|build|\.cache|coverage)(\/|$)/.test(file) || isSensitiveWorkspacePath(file)) return;
        this.schedule();
      });
    } catch { /* Periodic reconciliation below is the portable watcher fallback. */ }
    this.reconcileTimer = setInterval(() => this.schedule(), 2_000);
    this.reconcileTimer.unref();
  }

  beginTurn(turnId: string): void { this.turnId = turnId; this.revision = 0; this.schedule(); }
  reconcileNow(): void { this.schedule(0); }
  close(): void { this.watcher?.close(); this.watcher = undefined; if (this.timer) clearTimeout(this.timer); if (this.reconcileTimer) clearInterval(this.reconcileTimer); }

  private schedule(delay = 200): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.reconcile().catch((error: unknown) => console.error(err.warning(`Agent preview reconciliation failed: ${error instanceof Error ? error.message : String(error)}`))); }, delay);
  }

  private async reconcile(): Promise<void> {
    const candidateRevision = this.revision + 1;
    const first = await readWorkspaceDiff(this.workspacePath, `${this.turnId}:${candidateRevision}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await readWorkspaceDiff(this.workspacePath, `${this.turnId}:${candidateRevision}`);
    if (createHash("sha256").update(first.text).digest("hex") !== createHash("sha256").update(second.text).digest("hex")) { this.schedule(); return; }
    this.revision = candidateRevision;
    await this.publish(this.turnId, candidateRevision, second);
  }
}

class HostWorkspaceWatcher {
  private watcher: FSWatcher | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private reconcileTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly workspacePath: string, private readonly publish: () => Promise<void>) {}

  start(): void {
    try {
      this.watcher = watch(this.workspacePath, { recursive: true }, (_event, filename) => {
        const file = filename?.toString().split(path.sep).join("/") ?? "";
        if (!file || /(^|\/)(\.git|node_modules|dist|build|\.cache|coverage)(\/|$)/.test(file) || isSensitiveWorkspacePath(file)) return;
        this.schedule();
      });
    } catch { /* Periodic reconciliation below is the portable watcher fallback. */ }
    this.reconcileTimer = setInterval(() => this.schedule(0), 2_000);
    this.reconcileTimer.unref();
  }

  close(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.timer) clearTimeout(this.timer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
  }

  private schedule(delay = 1_000): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.publish().catch((error: unknown) => console.error(err.warning(`Workspace synchronization failed: ${error instanceof Error ? error.message : String(error)}`)));
    }, delay);
  }
}

async function prepareRoom(dryRun = false, includeSensitive = false): Promise<{
  roomId: string;
  workspacePath?: string;
  baseCommit?: string;
}> {
  const repository = await inspectRepository(process.cwd());
  const managedWorktree = await inspectManagedRoomWorktree(repository.root);
  if (managedWorktree) {
    throw new Error(`Refusing to host from a MultiCode ${managedWorktree.role} worktree. Open the original repository at ${managedWorktree.repositoryRoot}`);
  }
  const tracked = (await execFileAsync("git", ["-C", repository.root, "ls-files", "-z"], { encoding: "utf8" })).stdout.split("\0").filter(Boolean);
  const sensitive = tracked.filter(isSensitiveWorkspacePath);
  if (sensitive.length && !includeSensitive) throw new Error(`Tracked sensitive files require explicit confirmation: ${sensitive.slice(0, 5).join(", ")}. Re-run with --include-sensitive only if every participant may receive them.`);
  console.log(out.success(`${out.label("Repository")} ${out.value(repository.root)}`));
  if (repository.dirty) throw new Error("Commit or stash all tracked and untracked changes before starting a room");
  if (repository.operationInProgress) throw new Error("Finish the current Git operation before creating a room");
  if (dryRun) {
    console.log(out.success(`${out.label("Base commit")} ${out.muted(repository.head)}`));
    console.log(out.success("Repository is ready for a shared agent room"));
    return { roomId: "dry-run" };
  }

  const roomId = randomUUID().split("-")[0] as string;
  console.log(out.success(`${out.label("Workspace")} ${out.value(repository.root)}`));
  console.log(out.success(`${out.label("Branch")} ${out.value(repository.branch ?? "detached HEAD")}`));
  return { roomId, workspacePath: repository.root, baseCommit: repository.head };
}

async function prepareHostedWorkspace(roomId: string): Promise<DirectHostedWorkspace> {
  const room = await prepareDirectHostedWorkspace({ cwd: process.cwd(), roomId });
  console.log(out.success(`${out.label("Room workspace")} ${out.value(room.workspacePath)}`));
  console.log(out.success(`${out.label("Room session")} ${out.value(room.roomId)}`));
  return room;
}

async function createRoom(options: { agent: string; agentExecutable?: string; claudeAuth?: string; prompt?: string; model?: string; effort?: string; dryRun?: boolean; includeSensitive?: boolean }): Promise<void> {
  const provider = agentProvider(options.agent);
  if (!options.dryRun) await preflightAgentAuthentication(provider, options.agentExecutable, options.claudeAuth);
  const room = await prepareRoom(options.dryRun, options.includeSensitive);
  if (options.dryRun || !room.workspacePath) return;
  const hosted = await prepareHostedWorkspace(room.roomId);

  const adapter = adapterFor(provider, options.agentExecutable, options.claudeAuth);
  try {
    const stop = installStopHandlers(async () => {
      console.error(`\n${err.info("■", "Stopping local room…")}`);
      await adapter.stop();
    });
    const eventTask = (async () => {
      for await (const event of adapter.events()) printAgentEvent(event);
    })();
    const { threadId } = await adapter.start({ cwd: hosted.workspacePath, ...(options.model ? { model: options.model } : {}), ...(options.effort ? { effort: options.effort } : {}) });
    activeAgentDisplayName = adapter.configuration().displayName;
    console.log(out.success(`${out.label(`${activeAgentDisplayName} thread`)} ${out.muted(threadId)}`));
    if (options.prompt) await adapter.sendPrompt({ promptId: randomUUID(), text: options.prompt });
    else console.log(`${out.muted("Room is running locally. Pass")} ${out.command("--prompt")} ${out.muted("to begin a turn.")}`);
    try {
      await eventTask;
    } finally {
      stop();
      await adapter.stop();
    }
  } finally {
    await adapter.stop().catch(() => undefined);
    await closeDirectHostedWorkspace(hosted);
  }
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`Invalid port: ${value}`);
  return port;
}

function defaultPublicHost(listenHost: string): string {
  if (listenHost !== "0.0.0.0" && listenHost !== "::") return listenHost;
  for (const addresses of Object.values(networkInterfaces())) {
    const address = addresses?.find((candidate) => candidate.family === "IPv4" && !candidate.internal);
    if (address) return address.address;
  }
  return "localhost";
}

function inviteUrl(options: { publicUrl?: string; listenHost: string; port: number; roomId: string; token: string }): string {
  const base = options.publicUrl ?? `ws://${defaultPublicHost(options.listenHost)}:${options.port}`;
  const url = new URL(base);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("--public-url must use ws:// or wss://");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/rooms/${options.roomId}`;
  url.hash = new URLSearchParams({ token: options.token }).toString();
  return url.toString();
}

function remoteUrl(base: string, path: string): URL {
  const url = new URL(base);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("Relay URL must use ws:// or wss://");
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol === "ws:" && !loopback) throw new Error("Remote relays must use wss:// to protect room traffic");
  url.hash = "";
  url.search = "";
  url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`;
  return url;
}

function promptInput(onLine: (line: string) => void): Interface {
  const input = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  input.on("line", (line) => {
    const text = line.trim();
    if (text) onLine(text);
  });
  return input;
}

function installStopHandlers(stop: () => Promise<void>): () => void {
  let stopping = false;
  const handler = () => {
    if (stopping) return;
    stopping = true;
    void stop();
  };
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
  return () => {
    process.removeListener("SIGINT", handler);
    process.removeListener("SIGTERM", handler);
  };
}

interface HostRoomOptions {
  agent: string;
  agentExecutable?: string;
  claudeAuth?: string;
  prompt?: string;
  model?: string;
  effort?: string;
  name: string;
  listen: string;
  port: string;
  publicUrl?: string;
  relay?: string;
  local?: boolean;
  includeSensitive?: boolean;
}

async function hostRoom(options: HostRoomOptions): Promise<void> {
  if (options.local && options.relay) throw new Error("Use either --local or --relay, not both");
  const provider = agentProvider(options.agent);
  await preflightAgentAuthentication(provider, options.agentExecutable, options.claudeAuth);
  const configuredRelay = options.relay ?? defaultRelayUrl;
  if (!options.local) {
    await hostRemoteRoom({ ...options, relay: configuredRelay });
    return;
  }
  const prepared = await prepareRoom(false, options.includeSensitive);
  if (!prepared.workspacePath || !prepared.baseCommit) return;
  const hosted = await prepareHostedWorkspace(prepared.roomId);
  let hostedClosed = false;
  const closeHosted = async (): Promise<void> => {
    if (hostedClosed) return;
    hostedClosed = true;
    await closeDirectHostedWorkspace(hosted);
  };
  try {
  const workspacePath = hosted.workspacePath;
  const baseCommit = hosted.baseCommit;
  const participantCode = localInviteCode();
  const sessionSecret = roomSecret();
  const localTransportKey = transportKey(sessionSecret, participantCode);
  const authority = await RoomAuthority.create({
    roomId: prepared.roomId,
    contentSalt: participantCode,
    secret: sessionSecret,
    workspacePath,
    sessionDirectory: hosted.sessionDirectory,
  });
  let checkpointSequence = 0;
  let checkpointParent = baseCommit;
  const adapter = adapterFor(provider, options.agentExecutable, options.claudeAuth);
  const roomParticipants = new Map<string, RoomParticipant>();
  let latestSharedCheckpoint: WorkspaceCheckpoint | undefined;
  let publishCheckpoint: (force?: boolean, targetParticipantId?: string) => Promise<void> = async () => { throw new Error("Workspace checkpoint publishing is not ready"); };
  const token = participantCode;
  const relay = new RoomRelay({
    roomId: prepared.roomId,
    token,
    hostName: options.name,
    onPrompt: async (prompt) => {
      await publishCheckpoint();
      let promptText = prompt.text; try { promptText = openPrompt(localTransportKey, prompt.promptId, prompt.text); } catch { /* Host-local input is already plaintext. */ }
      await adapter.sendPrompt({
        promptId: prompt.promptId,
        text: promptText,
        ...(prompt.model ? { model: prompt.model } : {}),
        ...(prompt.effort ? { effort: prompt.effort } : {}),
      });
    },
    onSteer: async (prompt) => {
      let promptText = prompt.text; try { promptText = openPrompt(localTransportKey, prompt.promptId, prompt.text); } catch { /* Host-local input is already plaintext. */ }
      await adapter.steer({ promptId: prompt.promptId, text: promptText });
    },
    onApproval: async (_participant, requestId, decision) => adapter.resolveApproval(requestId, decision),
    onInput: async (_participant, requestId, answers, payload) => adapter.resolveInput(requestId, payload ? openInputAnswers(localTransportKey, requestId, payload) : answers ?? null),
    onCheckpointRequest: (participantId) => publishCheckpoint(false, participantId),
    onRoomEvent: (message) => {
      if (message.type === "participant.joined") roomParticipants.set(message.participant.id, message.participant);
      if (message.type === "participant.left") roomParticipants.delete(message.participantId);
      if (message.type === "participant.capabilities") { const participant = roomParticipants.get(message.participantId); if (participant) participant.capabilities = message.capabilities; }
      printRoomMessage(decryptPromptMessage(message, localTransportKey), false);
    },
  });
  const ipcToken = await writeSessionToken(path.join(hosted.sessionDirectory, "token"));
  const ipc = new LocalIpcServer(ipcToken, async (payload) => {
    const request = payload as { type?: string; text?: string; model?: string; effort?: string; participantId?: string; capabilities?: Capability[]; requestId?: string | number; decision?: unknown; answers?: AgentInputAnswers | null };
    if (request.type === "status") return { roomId: prepared.roomId, mode: "local", workspacePath, participants: [...roomParticipants.values()], pendingProposal: null };
    if (request.type === "prompt" && request.text) {
      const promptId = randomUUID();
      relay.submitHostPrompt(sealPrompt(localTransportKey, promptId, request.text), promptId, {
        ...(typeof request.model === "string" ? { model: request.model } : {}),
        ...(typeof request.effort === "string" ? { effort: request.effort } : {}),
      });
      return { queued: true };
    }
    if (request.type === "interrupt") { await adapter.interrupt(); return { interrupted: true }; }
    if (request.type === "approval.resolve" && request.requestId !== undefined && isApprovalDecision(request.decision)) { await adapter.resolveApproval(request.requestId, request.decision); return { resolved: true }; }
    if (request.type === "input.resolve" && typeof request.requestId === "string") { await adapter.resolveInput(request.requestId, request.answers ?? null); return { resolved: true }; }
    if (request.type === "capabilities" && request.participantId && request.capabilities) { relay.setParticipantCapabilities(request.participantId, request.capabilities); return { updated: true }; }
    if (request.type === "proposal.discard" || request.type === "proposal.retry") throw new Error("Direct rooms do not create merge proposals");
    throw new Error("Unsupported session command");
  });
  await ipc.listen(process.platform === "win32" ? `\\\\.\\pipe\\multicode-${prepared.roomId}` : path.join(hosted.sessionDirectory, "daemon.sock"));
  const previewWatcher = new AgentPreviewWatcher(workspacePath, async (turnId, revision, diff) => {
    relay.publishCollaborationEvent(authority.previewEvent(turnId, revision, diff));
  });
  const publishCheckpointNow = async (force = false, targetParticipantId?: string): Promise<void> => {
    if (targetParticipantId) {
      if (!latestSharedCheckpoint) throw new Error("No workspace checkpoint is available yet");
      relay.publishWorkspaceCheckpoint(latestSharedCheckpoint, targetParticipantId);
      return;
    }
    const published = await authority.withWorkspaceLock(async () => {
      const checkpoint = await createWorkspaceCheckpoint({
        cwd: workspacePath,
        roomId: prepared.roomId,
        sequence: checkpointSequence + 1,
        baseCommit,
        parentCommit: checkpointParent,
        force,
      });
      if (!checkpoint) return undefined;
      checkpointSequence = checkpoint.sequence;
      checkpointParent = checkpoint.commit;
      const portable = await createPortableWorkspaceCheckpoint({
        cwd: workspacePath,
        roomId: prepared.roomId,
        sequence: checkpoint.sequence,
        baseCommit,
        sourceCommit: checkpoint.commit,
      });
      return encryptedWorkspaceCheckpoint(localTransportKey, portable);
    });
    if (!published) return;
    latestSharedCheckpoint = published;
    relay.publishWorkspaceCheckpoint(latestSharedCheckpoint);
  };
  publishCheckpoint = serializeWorkspaceCheckpointPublisher(publishCheckpointNow);
  const workspaceWatcher = new HostWorkspaceWatcher(workspacePath, () => publishCheckpoint());

  const eventTask = (async () => {
    for await (const event of adapter.events()) {
      printAgentEvent(event);
      if (event.type === "input.requested") denyUnsupportedStructuredInput(event, roomParticipants, (requestId, answers) => adapter.resolveInput(requestId, answers));
      if (event.type === "turn.started") previewWatcher.beginTurn(event.turnId);
      if (event.type === "turn.completed") {
        await publishCheckpoint();
        const diff = await readWorkspaceDiff(workspacePath, event.turnId);
        relay.publishWorkspaceDiff(diff);
        relay.publishAgentEvent(event);
        continue;
      }
      if (event.type === "command.exited") previewWatcher.reconcileNow();
      relay.publishAgentEvent(event);
    }
    await new Promise<void>(() => undefined);
  })();
  let input: Interface | undefined;
  let cleanupSignals: () => void = () => undefined;
  let shutdownTask: Promise<void> | undefined;
  let stopping = false;
  const shutdown = (): Promise<void> => {
    shutdownTask ??= (async () => {
      stopping = true;
      input?.close();
      previewWatcher.close();
      workspaceWatcher.close();
      await ipc.close();
      await relay.close();
      await adapter.stop();
      await authority.close();
    })();
    return shutdownTask;
  };

  try {
    const { threadId } = await adapter.start({
      cwd: workspacePath,
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
    });
    activeAgentDisplayName = adapter.configuration().displayName;
    relay.publishAgentConfig(adapter.configuration());
    console.log(out.success(`${out.label(`${activeAgentDisplayName} thread`)} ${out.muted(threadId)}`));
    previewWatcher.start();

    const bound = await relay.listen({ host: options.listen, port: parsePort(options.port) });
    await publishCheckpoint(true);
    workspaceWatcher.start();
    const invite = inviteUrl({
      ...(options.publicUrl ? { publicUrl: options.publicUrl } : {}),
      listenHost: options.listen,
      port: bound.port,
      roomId: prepared.roomId,
      token: `${participantCode}.${sessionSecret}`,
    });
    console.log(out.success(`${out.label("Room")} ${out.value(prepared.roomId)} ${out.muted("listening on")} ${out.value(`${options.listen}:${bound.port}`)}`));
    console.log(`\n${out.label("Invite someone with")}`);
    console.log(`  ${out.command(`multicode room join '${invite}' --name 'Their name'`)}`);
    if (!options.publicUrl && options.listen === "127.0.0.1") {
      console.log(`\n${out.warning("Local-only listener.")} ${out.muted("Use")} ${out.command("--listen 0.0.0.0")} ${out.muted("for trusted LAN access or")} ${out.command("--public-url")} ${out.muted("with a secure tunnel.")}`);
    }
    console.log(`\n${chalk.green("●")} ${out.label("Ready for prompts")} ${out.muted("Type a prompt and press Enter. Shared prompts run in queue order.")}`);

    input = promptInput((text) => {
      if (text === "/interrupt") { void adapter.interrupt(); return; }
      const approvalCommand = /^\/approve\s+(\S+)\s+(accept|decline|cancel)$/.exec(text); if (approvalCommand) { void adapter.resolveApproval(parseApprovalRequestId(approvalCommand[1] as string), approvalCommand[2] as ApprovalDecision).catch((error: unknown) => console.error(err.error(error instanceof Error ? error.message : String(error)))); return; }
      if (text.startsWith("/answer ")) { try { const answer = structuredAnswerCommand(text); if (answer) void adapter.resolveInput(answer.requestId, answer.answers).catch((error: unknown) => console.error(err.error(error instanceof Error ? error.message : String(error)))); } catch (error) { console.error(err.error(error instanceof Error ? error.message : String(error))); } return; }
      if (text === "/participants") { for (const participant of roomParticipants.values()) console.error(`${participant.id}  ${participant.name}  [${participant.capabilities.join(", ")}]`); return; }
      const capabilityCommand = /^\/(grant|revoke)\s+(\S+)\s+(viewer|prompter|reviewer)$/.exec(text);
      if (capabilityCommand) {
        const participant = [...roomParticipants.values()].find((candidate) => candidate.id === capabilityCommand[2] || candidate.name === capabilityCommand[2]);
        if (!participant) { console.error(err.warning("Participant not found.")); return; }
        const capability = capabilityCommand[3] as Capability; const capabilities = new Set(participant.capabilities);
        if (capabilityCommand[1] === "grant") capabilities.add(capability); else capabilities.delete(capability);
        relay.setParticipantCapabilities(participant.id, [...capabilities]); return;
      }
      if (text.startsWith("/proposal")) { console.error(err.muted("Direct rooms do not create merge proposals.")); return; }
      const promptId = randomUUID(); relay.submitHostPrompt(sealPrompt(localTransportKey, promptId, text), promptId);
    });
    cleanupSignals = installStopHandlers(async () => {
      console.error(`\n${err.info("■", "Stopping shared room…")}`);
      await shutdown();
    });
    if (options.prompt) { const promptId = randomUUID(); relay.submitHostPrompt(sealPrompt(localTransportKey, promptId, options.prompt), promptId); }
    await eventTask;
  } finally {
    cleanupSignals();
    await shutdown();
  }
  } finally {
    await closeHosted();
  }
}

async function openWebSocket(url: URL): Promise<WebSocket> {
  let announced = false;
  for (;;) {
    const socket = new WebSocket(url);
    try {
      await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
      return socket;
    } catch {
      socket.terminate();
      if (!announced) { console.error(err.warning("Relay unavailable; waiting for it to come back…")); announced = true; }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
}

async function createRemoteRoom(
  socket: WebSocket,
  options: { name: string },
): Promise<Extract<RelayServerMessage, { type: "relay.room.created" }>> {
  return new Promise((resolve, reject) => {
    const closed = () => reject(new Error("Relay disconnected before creating the room"));
    const receive = (data: WebSocket.RawData) => {
      let message: RelayServerMessage;
      try {
        message = JSON.parse(data.toString()) as RelayServerMessage;
      } catch {
        reject(new Error("Relay returned invalid JSON"));
        return;
      }
      if (message.type === "relay.room.created") {
        socket.off("message", receive);
        socket.off("close", closed);
        resolve(message);
      } else if (message.type === "room.error") {
        socket.off("message", receive);
        socket.off("close", closed);
        reject(new Error(message.message));
      }
    };
    socket.on("message", receive);
    socket.once("close", closed);
    socket.send(JSON.stringify({
      type: "relay.room.create",
      name: options.name,
    }));
  });
}

async function resumeRemoteRoom(relayUrl: string, roomId: string, resumeToken: string, timeoutMs = 25_000): Promise<WebSocket> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const candidate = new WebSocket(remoteUrl(relayUrl, "/host"));
    try {
      await new Promise<void>((resolve, reject) => { candidate.once("open", resolve); candidate.once("error", reject); });
      const resumed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Relay resume timed out")), 5_000);
        const receive = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as RelayServerMessage;
          if (message.type === "relay.room.created" && message.resumed) { clearTimeout(timer); candidate.off("message", receive); resolve(); }
          else if (message.type === "room.error" && message.fatal) { clearTimeout(timer); candidate.off("message", receive); reject(new Error(message.message)); }
        };
        candidate.on("message", receive);
      });
      candidate.send(JSON.stringify({ type: "relay.room.resume", roomId, resumeToken }));
      await resumed; return candidate;
    } catch (error) { lastError = error; candidate.terminate(); await new Promise((resolve) => setTimeout(resolve, 1_000)); }
  }
  throw lastError instanceof Error ? lastError : new Error("Could not resume the remote room");
}

async function hostRemoteRoom(options: HostRoomOptions): Promise<void> {
  const provider = agentProvider(options.agent);
  const relayUrl = options.relay ?? defaultRelayUrl;

  const adapter = adapterFor(provider, options.agentExecutable, options.claudeAuth);
  let socket: WebSocket | undefined;
  let input: Interface | undefined;
  let cleanupSignals: () => void = () => undefined;
  let shutdownTask: Promise<void> | undefined;
  let previewWatcher: AgentPreviewWatcher | undefined;
  let workspaceWatcher: HostWorkspaceWatcher | undefined;
  let ipc: LocalIpcServer | undefined;
  let authorityForShutdown: RoomAuthority | undefined;
  let hostedForShutdown: DirectHostedWorkspace | undefined;
  let stopping = false;
  const shutdown = (): Promise<void> => {
    shutdownTask ??= (async () => {
      stopping = true;
      input?.close();
      previewWatcher?.close();
      workspaceWatcher?.close();
      await ipc?.close();
      if (socket?.readyState === WebSocket.OPEN) socket.close(1000, "Host stopped room");
      await adapter.stop();
      await authorityForShutdown?.close();
      if (hostedForShutdown) await closeDirectHostedWorkspace(hostedForShutdown);
    })();
    return shutdownTask;
  };

  try {
    socket = await openWebSocket(remoteUrl(relayUrl, "/host"));
    const created = await createRemoteRoom(socket, { name: options.name });
    const sessionSecret = roomSecret();
    const relayTransportKey = transportKey(sessionSecret, created.code);
    const prepared = await prepareRoom(false, options.includeSensitive);
    if (!prepared.workspacePath || !prepared.baseCommit) return;
    const hosted = await prepareHostedWorkspace(created.roomId);
    hostedForShutdown = hosted;
    const workspacePath = hosted.workspacePath;
    const authority = await RoomAuthority.create({
      roomId: created.roomId,
      contentSalt: created.code,
      secret: sessionSecret,
      workspacePath,
      sessionDirectory: hosted.sessionDirectory,
    });
    authorityForShutdown = authority;
    const pendingRelayMessages: string[] = [];
    const sendToRelay = (message: unknown): void => {
      const encoded = JSON.stringify(message);
      if (socket?.readyState === WebSocket.OPEN) socket.send(encoded);
      else { pendingRelayMessages.push(encoded); if (pendingRelayMessages.length > 2_000) pendingRelayMessages.shift(); }
    };
    const flushRelayMessages = (): void => { while (socket?.readyState === WebSocket.OPEN && pendingRelayMessages.length) socket.send(pendingRelayMessages.shift() as string); };
    const baseCommit = hosted.baseCommit;
    let checkpointSequence = 0;
    let checkpointParent = baseCommit;
    const processedPromptIds = new Set<string>();
    const roomParticipants = new Map<string, RoomParticipant>();
    let latestSharedCheckpoint: WorkspaceCheckpoint | undefined;
    const ipcToken = await writeSessionToken(path.join(hosted.sessionDirectory, "token"));
    ipc = new LocalIpcServer(ipcToken, async (payload) => {
      const request = payload as { type?: string; text?: string; model?: string; effort?: string; participantId?: string; capabilities?: Capability[]; requestId?: string | number; decision?: unknown; answers?: AgentInputAnswers | null };
      if (request.type === "status") return { roomId: created.roomId, mode: "remote", workspacePath, participants: [...roomParticipants.values()], pendingProposal: null, relayConnected: socket?.readyState === WebSocket.OPEN };
      if (request.type === "prompt" && request.text) {
        const promptId = randomUUID();
        sendToRelay({
          type: "prompt.submit",
          promptId,
          text: sealPrompt(relayTransportKey, promptId, request.text),
          ...(request.model ? { model: request.model } : {}),
          ...(request.effort ? { effort: request.effort } : {}),
        });
        return { queued: true };
      }
      if (request.type === "interrupt") { await adapter.interrupt(); return { interrupted: true }; }
      if (request.type === "approval.resolve" && request.requestId !== undefined && isApprovalDecision(request.decision)) { await adapter.resolveApproval(request.requestId, request.decision); return { resolved: true }; }
      if (request.type === "input.resolve" && typeof request.requestId === "string") { await adapter.resolveInput(request.requestId, request.answers ?? null); return { resolved: true }; }
      if (request.type === "capabilities" && request.participantId && request.capabilities) { sendToRelay({ type: "relay.participant.capabilities", participantId: request.participantId, capabilities: request.capabilities }); return { updated: true }; }
      if (request.type === "proposal.discard" || request.type === "proposal.retry") throw new Error("Direct rooms do not create merge proposals");
      throw new Error("Unsupported session command");
    });
    await ipc.listen(process.platform === "win32" ? `\\\\.\\pipe\\multicode-${created.roomId}` : path.join(hosted.sessionDirectory, "daemon.sock"));
    previewWatcher = new AgentPreviewWatcher(workspacePath, async (turnId, revision, diff) => {
      sendToRelay({ type: "relay.collab.event", event: authority.previewEvent(turnId, revision, diff) });
    });
    const publishCheckpoint = serializeWorkspaceCheckpointPublisher(async (force = false, targetParticipantId?: string): Promise<void> => {
      if (targetParticipantId) {
        if (!latestSharedCheckpoint) throw new Error("No workspace checkpoint is available yet");
        sendRemoteWorkspaceCheckpoint(sendToRelay, latestSharedCheckpoint, targetParticipantId);
        return;
      }
      const published = await authority.withWorkspaceLock(async () => {
        const checkpoint = await createWorkspaceCheckpoint({ cwd: workspacePath, roomId: prepared.roomId, sequence: checkpointSequence + 1, baseCommit, parentCommit: checkpointParent, force });
        if (!checkpoint) return undefined;
        checkpointSequence = checkpoint.sequence;
        checkpointParent = checkpoint.commit;
        const portable = await createPortableWorkspaceCheckpoint({ cwd: workspacePath, roomId: prepared.roomId, sequence: checkpoint.sequence, baseCommit, sourceCommit: checkpoint.commit });
        return encryptedWorkspaceCheckpoint(relayTransportKey, portable);
      });
      if (!published) return;
      latestSharedCheckpoint = published;
      sendRemoteWorkspaceCheckpoint(sendToRelay, latestSharedCheckpoint);
    });
    workspaceWatcher = new HostWorkspaceWatcher(workspacePath, () => publishCheckpoint());
    const eventTask = (async () => {
      for await (const event of adapter.events()) {
        printAgentEvent(event);
        if (event.type === "input.requested") denyUnsupportedStructuredInput(event, roomParticipants, (requestId, answers) => adapter.resolveInput(requestId, answers));
        if (event.type === "turn.started") previewWatcher?.beginTurn(event.turnId);
        if (event.type === "turn.completed") {
          await publishCheckpoint();
          sendToRelay({ type: "relay.agent.encrypted", eventType: event.type, ...(event.status ? { status: event.status } : {}), payload: sealAgentEvent(relayTransportKey, event) });
        } else {
          if (event.type === "command.exited") previewWatcher?.reconcileNow();
          sendToRelay({ type: "relay.agent.encrypted", eventType: event.type, payload: sealAgentEvent(relayTransportKey, event) });
        }
      }
      await new Promise<void>(() => undefined);
    })();
    const { threadId } = await adapter.start({
      cwd: workspacePath,
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
    });
    activeAgentDisplayName = adapter.configuration().displayName;
    sendToRelay({ type: "relay.agent.config", config: adapter.configuration() });
    console.log(out.success(`${out.label(`${activeAgentDisplayName} thread`)} ${out.muted(threadId)}`));
    previewWatcher.start();
    await publishCheckpoint(true);
    workspaceWatcher.start();
    console.log(out.success(`${out.label("Remote room")} ${out.value(relayUrl)}`));
    const inviteToken = `${created.code}.${sessionSecret}`;
    console.log(`\n${out.label("Room token")} ${chalk.bold.cyan(inviteToken)}`);
    console.log(`\n${out.label("Invite someone with")}`);
    const relayArgument = relayUrl === defaultRelayUrl ? "" : ` --relay '${relayUrl}'`;
    console.log(`  ${out.command(`multicode join ${inviteToken}${relayArgument} --name 'Their name'`)}`);
    console.log(`\n${chalk.green("●")} ${out.label("Ready for prompts")} ${out.muted("Type a prompt and press Enter. Shared prompts run in queue order.")}`);

    const handleRelayMessage = (data: WebSocket.RawData) => {
      let message: RelayServerMessage;
      try {
        message = JSON.parse(data.toString()) as RelayServerMessage;
      } catch {
        console.error(err.error("Received an invalid message from the relay"));
        return;
      }
      if (message.type === "relay.room.created") return;
      if (message.type === "room.welcome") for (const participant of message.participants) if (!participant.host) roomParticipants.set(participant.id, participant);
      if (message.type === "participant.joined") roomParticipants.set(message.participant.id, message.participant);
      if (message.type === "participant.left") roomParticipants.delete(message.participantId);
      if (message.type === "participant.capabilities") { const participant = roomParticipants.get(message.participantId); if (participant) participant.capabilities = message.capabilities; }
      if (message.type === "workspace.checkpoint.request") {
        void publishCheckpoint(false, message.participantId).catch((error: unknown) => {
          console.error(err.error(`Unable to send requested checkpoint: ${error instanceof Error ? error.message : String(error)}`));
        });
        return;
      }
      if (message.type === "approval.submitted") { void adapter.resolveApproval(message.requestId, message.decision).catch((error: unknown) => console.error(err.error(`Approval failed: ${error instanceof Error ? error.message : String(error)}`))); return; }
      if (message.type === "input.submitted") {
        void Promise.resolve().then(() => adapter.resolveInput(message.requestId, message.payload ? openInputAnswers(relayTransportKey, message.requestId, message.payload) : message.answers ?? null)).catch((error: unknown) => console.error(err.error(`Input failed: ${error instanceof Error ? error.message : String(error)}`))); return;
      }
      if (message.type === "prompt.steer") {
        void adapter.steer({
          promptId: message.prompt.promptId,
          text: openPrompt(relayTransportKey, message.prompt.promptId, message.prompt.text),
        }).then(() => {
          sendToRelay({ type: "relay.prompt.steered", promptId: message.prompt.promptId });
        }).catch((error: unknown) => {
          const errorMessage = error instanceof Error ? error.message : String(error);
          sendToRelay({ type: "relay.prompt.steer.failed", promptId: message.prompt.promptId, message: errorMessage });
          console.error(err.error(`Could not steer the active turn: ${errorMessage}`));
        });
        return;
      }
      if (message.type === "prompt.started") {
        if (processedPromptIds.has(message.prompt.promptId)) { sendToRelay({ type: "relay.prompt.failed", promptId: message.prompt.promptId, message: "Duplicate prompt replay rejected" }); return; }
        processedPromptIds.add(message.prompt.promptId); if (processedPromptIds.size > 10_000) processedPromptIds.delete(processedPromptIds.keys().next().value as string);
        void (async () => {
          await publishCheckpoint();
          await adapter.sendPrompt({
            promptId: message.prompt.promptId,
            text: openPrompt(relayTransportKey, message.prompt.promptId, message.prompt.text),
            ...(message.prompt.model ? { model: message.prompt.model } : {}),
            ...(message.prompt.effort ? { effort: message.prompt.effort } : {}),
          });
        })().catch((error: unknown) => {
          sendToRelay({ type: "relay.prompt.failed", promptId: message.prompt.promptId, message: error instanceof Error ? error.message : String(error) });
        });
      }
      printRoomMessage(decryptPromptMessage(message, relayTransportKey), false);
      if (message.type === "room.error" && message.fatal) void shutdown();
    };

    const disconnected = new Promise<void>((resolve) => {
      const attach = (active: WebSocket): void => {
        active.on("message", handleRelayMessage);
        active.once("close", () => {
          if (stopping || socket !== active) { if (stopping) resolve(); return; }
          console.error(`\n${err.warning("Relay connection interrupted; attempting to resume the room…")}`);
          void resumeRemoteRoom(relayUrl, created.roomId, created.resumeToken).then(async (resumed) => {
            socket = resumed; attach(resumed); flushRelayMessages();
            await publishCheckpoint(true);
            console.error(err.success("Remote room resumed."));
          }).catch((error: unknown) => { console.error(err.error(`Remote room could not resume: ${error instanceof Error ? error.message : String(error)}`)); resolve(); });
        });
      };
      attach(socket as WebSocket);
    });
    input = promptInput((text) => {
      if (text === "/interrupt") { void adapter.interrupt(); return; }
      const approvalCommand = /^\/approve\s+(\S+)\s+(accept|decline|cancel)$/.exec(text); if (approvalCommand) { void adapter.resolveApproval(parseApprovalRequestId(approvalCommand[1] as string), approvalCommand[2] as ApprovalDecision).catch((error: unknown) => console.error(err.error(error instanceof Error ? error.message : String(error)))); return; }
      if (text.startsWith("/answer ")) { try { const answer = structuredAnswerCommand(text); if (answer) void adapter.resolveInput(answer.requestId, answer.answers).catch((error: unknown) => console.error(err.error(error instanceof Error ? error.message : String(error)))); } catch (error) { console.error(err.error(error instanceof Error ? error.message : String(error))); } return; }
      if (text === "/participants") { for (const participant of roomParticipants.values()) console.error(`${participant.id}  ${participant.name}  [${participant.capabilities.join(", ")}]`); return; }
      const capabilityCommand = /^\/(grant|revoke)\s+(\S+)\s+(viewer|prompter|reviewer)$/.exec(text);
      if (capabilityCommand) {
        const participant = [...roomParticipants.values()].find((candidate) => candidate.id === capabilityCommand[2] || candidate.name === capabilityCommand[2]);
        if (!participant) { console.error(err.warning("Participant not found.")); return; }
        const capability = capabilityCommand[3] as Capability; const capabilities = new Set(participant.capabilities);
        if (capabilityCommand[1] === "grant") capabilities.add(capability); else capabilities.delete(capability);
        sendToRelay({ type: "relay.participant.capabilities", participantId: participant.id, capabilities: [...capabilities] }); return;
      }
      if (text.startsWith("/proposal")) { console.error(err.muted("Direct rooms do not create merge proposals.")); return; }
      if (socket?.readyState !== WebSocket.OPEN) {
        console.error(err.warning("Not connected; prompt was not sent."));
        return;
      }
      const promptId = randomUUID(); sendToRelay({ type: "prompt.submit", promptId, text: sealPrompt(relayTransportKey, promptId, text) });
    });
    cleanupSignals = installStopHandlers(async () => {
      console.error(`\n${err.info("■", "Stopping remote room…")}`);
      await shutdown();
    });
    if (options.prompt) {
      const promptId = randomUUID(); sendToRelay({ type: "prompt.submit", promptId, text: sealPrompt(relayTransportKey, promptId, options.prompt) });
    }
    await Promise.race([eventTask, disconnected]);
  } finally {
    cleanupSignals();
    await shutdown();
  }
}

async function joinRoom(inviteOrCode: string, options: { name: string; relay?: string; viewer?: boolean; bootstrapOnly?: boolean }): Promise<void> {
  let url: URL;
  let token: string;
  let relayTransportKey: Buffer | undefined;
  if (/^wss?:\/\//i.test(inviteOrCode)) {
    url = new URL(inviteOrCode);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("Invite must use ws:// or wss://");
    const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
    token = fragment.get("token") ?? url.searchParams.get("token") ?? "";
    if (!token) throw new Error("Invite URL is missing its room token");
    const [urlCode, urlSecret] = token.split(".", 2);
    if (!urlSecret || !/^[A-Za-z0-9_-]{40,}$/.test(urlSecret)) throw new Error("Invalid room token");
    const canonicalCode = (urlCode ?? "").replace(/-/g, "").toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{10}$/.test(canonicalCode)) throw new Error("Invalid room code");
    const roomCode = `${canonicalCode.slice(0, 5)}-${canonicalCode.slice(5)}`;
    token = roomCode;
    relayTransportKey = transportKey(urlSecret, roomCode);
    url.hash = "";
    url.searchParams.delete("token");
  } else {
    const relayUrl = options.relay ?? defaultRelayUrl;
    const [roomCode, roomKey] = inviteOrCode.split(".", 2);
    if (!roomKey || !/^[A-Za-z0-9_-]{40,}$/.test(roomKey)) throw new Error("Invalid room token");
    const canonical = (roomCode ?? "").replace(/-/g, "").toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{10}$/.test(canonical)) throw new Error("Invalid room code");
    token = `${canonical.slice(0, 5)}-${canonical.slice(5)}`;
    relayTransportKey = transportKey(roomKey, token);
    url = remoteUrl(relayUrl, `/rooms/${token}`);
  }

  const socket = await openWebSocket(url);
  let joined = false;
  let input: Interface | undefined;

  const startPromptInput = (): void => {
    if (options.viewer || input) return;
    input = promptInput((text) => {
      if (socket.readyState !== WebSocket.OPEN) {
        console.error(err.warning("Not connected; prompt was not sent."));
        return;
      }
      const approval = /^\/approve\s+(\S+)\s+(accept|decline|cancel)$/.exec(text);
      if (approval) socket.send(JSON.stringify({ type: "approval.resolve", requestId: parseApprovalRequestId(approval[1] as string), decision: approval[2] }));
      else if (text.startsWith("/answer ")) {
        try {
          const answer = structuredAnswerCommand(text);
          if (answer) socket.send(JSON.stringify({ type: "input.resolve", requestId: answer.requestId, ...(relayTransportKey ? { payload: sealInputAnswers(relayTransportKey, answer.requestId, answer.answers) } : { answers: answer.answers }) }));
        } catch (error) {
          console.error(err.error(error instanceof Error ? error.message : String(error)));
        }
      } else {
        const promptId = randomUUID();
        socket.send(JSON.stringify({ type: "prompt.submit", promptId, text: relayTransportKey ? sealPrompt(relayTransportKey, promptId, text) : text }));
      }
    });
  };

  const closed = new Promise<void>((resolve, reject) => {
    socket.send(JSON.stringify({ type: "room.join", token, name: options.name, ...(options.viewer ? { requestedRole: "viewer" } : {}), protocolCapabilities: ["agent-config-v1", "generic-tools-v1", "structured-input-v1"] }));
    socket.on("message", (data) => {
      let message: RoomServerMessage;
      try {
        message = JSON.parse(data.toString()) as RoomServerMessage;
      } catch {
        console.error(err.error("Received an invalid message from the room"));
        return;
      }
      if (message.type === "agent.encrypted") {
        if (!relayTransportKey) { console.error(err.error("Received encrypted agent output without a room key")); return; }
        try { printAgentEvent(JSON.parse(new TextDecoder().decode(openTransport(relayTransportKey, message.payload))) as AgentEvent); }
        catch { console.error(err.error("Could not decrypt agent output")); }
      } else {
        printRoomMessage(relayTransportKey ? decryptPromptMessage(message, relayTransportKey) : message);
      }
      if (message.type === "room.welcome" && !joined) {
        joined = true;
        console.log(`${chalk.green("●")} ${out.label("Joined room")} ${out.value(message.roomId)}`);
        if (options.bootstrapOnly) {
          socket.close(1000, "Room connection handed off");
          return;
        }
        console.log(out.muted(options.viewer ? "Following the shared agent session." : "Type a prompt and press Enter to add it to the shared queue."));
        startPromptInput();
      }
      if (message.type === "room.error" && message.fatal) socket.close();
    });
    socket.once("error", reject);
    socket.once("close", (code, reason) => {
      input?.close();
      console.error(`\n${err.warning(`Disconnected from room${reason.length ? `: ${reason.toString()}` : ` (code ${code})`}`)}`);
      resolve();
    });
  });

  const cleanupSignals = installStopHandlers(async () => socket.close(1000, "Participant left"));
  try {
    await closed;
  } finally {
    cleanupSignals();
  }
}

async function serveRelay(options: { host: string; port: string; maxRooms: string; roomsPerIp: string; maxParticipantsPerRoom: string }): Promise<void> {
  const maxRooms = Number(options.maxRooms);
  if (!Number.isInteger(maxRooms) || maxRooms < 1) throw new Error(`Invalid room limit: ${options.maxRooms}`);
  const maxRoomsPerIp = Number(options.roomsPerIp);
  if (!Number.isInteger(maxRoomsPerIp) || maxRoomsPerIp < 1) throw new Error(`Invalid per-IP room limit: ${options.roomsPerIp}`);
  const maxParticipantsPerRoom = Number(options.maxParticipantsPerRoom);
  if (!Number.isInteger(maxParticipantsPerRoom) || maxParticipantsPerRoom < 2) throw new Error(`Invalid participant limit: ${options.maxParticipantsPerRoom}`);
  const databaseUrl = process.env.MULTICODE_DATABASE_URL;
  const relay = new RelayServer({ maxRooms, maxRoomsPerIp, maxParticipantsPerRoom, ...(databaseUrl ? { store: new PostgresRelayRoomStore(databaseUrl) } : {}) });
  const bound = await relay.listen({ host: options.host, port: parsePort(options.port) });
  console.log(out.success(`${out.label("MultiCode relay")} ${out.value(`http://${bound.host}:${bound.port}`)}`));
  console.log(out.success(`${out.label("Health check")} ${out.value(`http://${bound.host}:${bound.port}/health`)}`));

  await new Promise<void>((resolve) => {
    const cleanupSignals = installStopHandlers(async () => {
      console.error(`\n${err.info("■", "Stopping relay…")}`);
      cleanupSignals();
      await relay.close();
      resolve();
    });
  });
}

async function cleanupRoomWorkspace(roomId: string, options: { force?: boolean }): Promise<void> {
  try {
    const removed = await cleanupParticipantWorkspace({ roomId, ...(options.force ? { force: true } : {}) });
    console.log(out.success(`${out.label("Removed room workspace")} ${out.value(removed)}`));
  } catch (participantError) {
    if (!options.force) throw participantError;
    try {
      const removed = await cleanupLegacyHostedWorkspace({ roomId });
      console.log(out.success(`${out.label("Removed legacy host worktrees")} ${out.value(`${removed.sharedPath}, ${removed.agentPath}`)}`));
    } catch {
      throw participantError;
    }
  }
}

interface LiveSessionStatus { roomId: string; mode: string; workspacePath: string; participants: RoomParticipant[]; pendingProposal: string | null; relayConnected?: boolean }

async function sessionDirectoryFor(roomId?: string): Promise<{ roomId: string; directory: string }> {
  const root = path.join(homedir(), ".multicode", "sessions");
  if (roomId) { const safe = sanitizeRoomId(roomId); return { roomId: safe, directory: path.join(root, safe) }; }
  return discoverLiveSessionForWorkspace(root, process.cwd());
}

async function liveSessionRequest<T>(roomId: string | undefined, payload: unknown, timeoutMs = 5_000): Promise<T> {
  const session = await sessionDirectoryFor(roomId); const token = (await readFile(path.join(session.directory, "token"), "utf8")).trim();
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\multicode-${session.roomId}` : path.join(session.directory, "daemon.sock");
  return requestLocalIpc<T>(socketPath, token, payload, timeoutMs);
}

async function showSessionStatus(roomId?: string): Promise<void> {
  const status = await liveSessionRequest<LiveSessionStatus>(roomId, { type: "status" });
  console.log(`${out.label("Room")} ${out.value(status.roomId)} ${out.muted(status.mode)}`);
  console.log(`${out.label("Workspace")} ${status.workspacePath}`);
  console.log(`${out.label("Relay")} ${status.relayConnected === false ? err.error("reconnecting") : out.success("connected")}`);
  console.log(`${out.label("Participants")} ${status.participants.length || "none"}`);
  if (status.pendingProposal) console.log(`${out.label("Pending proposal")} ${status.pendingProposal}`);
}

async function resolveLiveApproval(roomId: string | undefined, requestId: string, decision: string): Promise<void> {
  if (!isApprovalDecision(decision)) throw new Error("Approval decision must be accept, decline, or cancel");
  const parsedRequestId = parseApprovalRequestId(requestId);
  await liveSessionRequest(roomId, { type: "approval.resolve", requestId: parsedRequestId, decision });
  console.log(out.success(`${out.label("Approval resolved")} ${out.muted(`request ${requestId}: ${decision}`)}`));
}

async function resolveLiveInput(roomId: string | undefined, requestId: string, answerJson: string): Promise<void> {
  const command = structuredAnswerCommand(`/answer ${requestId} ${answerJson}`) as { requestId: string; answers: AgentInputAnswers | null };
  await liveSessionRequest(roomId, { type: "input.resolve", requestId: command.requestId, answers: command.answers });
  console.log(out.success(`${out.label("Input resolved")} ${out.muted(`request ${requestId}`)}`));
}

async function updateParticipantCapability(roomId: string | undefined, participantQuery: string, capability: Capability, grant: boolean): Promise<void> {
  const status = await liveSessionRequest<LiveSessionStatus>(roomId, { type: "status" });
  const participant = status.participants.find((candidate) => candidate.id === participantQuery || candidate.name === participantQuery);
  if (!participant) throw new Error("Participant not found"); const capabilities = new Set(participant.capabilities);
  if (grant) capabilities.add(capability); else capabilities.delete(capability);
  await liveSessionRequest(roomId, { type: "capabilities", participantId: participant.id, capabilities: [...capabilities] });
  console.log(out.success(`${grant ? "Granted" : "Revoked"} ${capability} ${grant ? "to" : "from"} ${participant.name}`));
}

async function exportRoom(roomId: string, options: { format: "patch" | "branch" | "commit"; output?: string; branch?: string }): Promise<void> {
  const session = await sessionDirectoryFor(roomId);
  const marker = JSON.parse(await readFile(path.join(session.directory, ".multicode-session.json"), "utf8")) as { repositoryRoot: string; sharedPath: string; baseCommit: string };
  const checkpoint = await createWorkspaceCheckpoint({ cwd: marker.sharedPath, roomId: session.roomId, sequence: Date.now(), baseCommit: marker.baseCommit, parentCommit: marker.baseCommit, force: true });
  if (!checkpoint) throw new Error("Could not capture room workspace");
  if (options.format === "commit") { console.log(checkpoint.commit); return; }
  if (options.format === "branch") {
    const branch = options.branch ?? `multicode/export-${session.roomId}`; await execFileAsync("git", ["-C", marker.repositoryRoot, "branch", branch, checkpoint.commit]); console.log(out.success(`${out.label("Exported branch")} ${out.value(branch)}`)); return;
  }
  const patchText = (await execFileAsync("git", ["-C", marker.repositoryRoot, "diff", "--binary", marker.baseCommit, checkpoint.commit], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })).stdout;
  const output = path.resolve(options.output ?? `multicode-${session.roomId}.patch`); await writeFile(output, patchText, "utf8"); console.log(out.success(`${out.label("Exported patch")} ${out.value(output)}`));
}

const defaultName = (() => {
  try {
    return userInfo().username;
  } catch {
    return "participant";
  }
})();

const program = new Command()
  .name("multicode")
  .description("Collaborate around a local coding-agent session")
  .version("0.2.0");

program.command("doctor").description("Check local prerequisites")
  .option("--agent <agent>", "agent provider: codex or claude", "codex")
  .option("--agent-executable <path>", "override the selected agent executable")
  .option("--claude-auth <mode>", "Claude authentication: subscription, api-key, or auto", "auto")
  .action(doctor);

const room = program.command("room", { hidden: true }).description("Internal room commands");
room
  .command("create")
  .description("Create a local agent room in the current workspace")
  .option("--agent <agent>", "agent adapter", "codex")
  .option("--agent-executable <path>", "override the selected agent executable")
  .option("--claude-auth <mode>", "Claude authentication: subscription, api-key, or auto", "auto")
  .option("--prompt <prompt>", "send an initial prompt")
  .option("--model <model>", "override the configured agent model")
  .option("--effort <effort>", "override the configured reasoning effort")
  .option("--dry-run", "validate the repository without starting an agent")
  .option("--include-sensitive", "explicitly include tracked credential-like files")
  .action(createRoom);

room
  .command("host")
  .description("Host an interactive room that other people can join")
  .option("--agent <agent>", "agent adapter", "codex")
  .option("--agent-executable <path>", "override the selected agent executable")
  .option("--claude-auth <mode>", "Claude authentication: subscription, api-key, or auto", "auto")
  .option("--prompt <prompt>", "queue an initial prompt")
  .option("--model <model>", "override the configured agent model")
  .option("--effort <effort>", "override the configured reasoning effort")
  .option("--name <name>", "host display name", defaultName)
  .option("--listen <address>", "address to listen on", "127.0.0.1")
  .option("--port <port>", "port to listen on; use 0 for any free port", "7337")
  .option("--public-url <url>", "public ws:// or wss:// base URL for invitations")
  .option("--relay <url>", "central relay ws:// or wss:// URL")
  .option("--local", "host directly instead of using the central relay")
  .option("--include-sensitive", "explicitly include tracked credential-like files")
  .action(hostRoom);

room
  .command("join")
  .description("Join a shared agent room using an invite URL")
  .argument("<invite-or-code>", "room code or invite URL printed by the host")
  .option("--name <name>", "participant display name", defaultName)
  .option("--relay <url>", "central relay URL (or set MULTICODE_RELAY_URL)")
  .option("--viewer", "follow the agent without prompt permissions")
  .option("--bootstrap-only", "validate the room and hand the connection to another client")
  .action(joinRoom);

program
  .command("host")
  .description(`Start a shared agent room through ${defaultRelayUrl}`)
  .option("--agent <agent>", "agent adapter", "codex")
  .option("--agent-executable <path>", "override the selected agent executable")
  .option("--claude-auth <mode>", "Claude authentication: subscription, api-key, or auto", "auto")
  .option("--prompt <prompt>", "queue an initial prompt")
  .option("--model <model>", "override the configured agent model")
  .option("--effort <effort>", "override the configured reasoning effort")
  .option("--name <name>", "host display name", defaultName)
  .option("--relay <url>", "override the central relay URL")
  .option("--viewer", "join without edit or prompt permissions")
  .option("--bootstrap-only", "prepare the room workspace and let another client own the live connection")
  .option("--include-sensitive", "explicitly include tracked credential-like files")
  .action((options) => hostRoom({ ...options, listen: "127.0.0.1", port: "7337" }));

program
  .command("join")
  .description(`Join a shared room through ${defaultRelayUrl}`)
  .argument("<full-token>", "complete room token printed by the host")
  .option("--name <name>", "participant display name", defaultName)
  .option("--relay <url>", "override the central relay URL")
  .option("--viewer", "follow the agent without prompt permissions")
  .option("--bootstrap-only", "validate the room and hand the connection to another client")
  .action(joinRoom);

program
  .command("cleanup")
  .description("Remove a preserved participant room workspace")
  .argument("<room-id>", "room identifier printed when joining")
  .option("--force", "remove the room workspace even when it contains local changes")
  .action(cleanupRoomWorkspace);

program.command("status").description("Show a live room's daemon status").argument("[room-id]").action(showSessionStatus);
program.command("prompt").description("Submit a prompt through a live room daemon").argument("<text>").option("--session <room-id>").action(async (text: string, options: { session?: string }) => { await liveSessionRequest(options.session, { type: "prompt", text }); console.log(out.success("Prompt queued")); });
program.command("interrupt").description("Interrupt the active agent turn").option("--session <room-id>").action(async (options: { session?: string }) => { await liveSessionRequest(options.session, { type: "interrupt" }); console.log(out.success("Interrupt requested")); });
program.command("approve").description("Resolve a pending agent approval on the host").argument("<request-id>").argument("<decision>", "accept, decline, or cancel").option("--session <room-id>").action(async (requestId: string, decision: string, options: { session?: string }) => resolveLiveApproval(options.session, requestId, decision));
program.command("answer").description("Answer a pending structured agent question").argument("<request-id>").argument("<answers>", "JSON object keyed by question ID, or cancel").option("--session <room-id>").action(async (requestId: string, answers: string, options: { session?: string }) => resolveLiveInput(options.session, requestId, answers));
program.command("participants").description("List participants and capabilities").option("--session <room-id>").action(async (options: { session?: string }) => { const status = await liveSessionRequest<LiveSessionStatus>(options.session, { type: "status" }); for (const participant of status.participants) console.log(`${participant.id}\t${participant.name}\t${participant.capabilities.join(",")}`); });
program.command("grant").description("Grant a participant capability").argument("<participant>").argument("<capability>").option("--session <room-id>").action(async (participant: string, capability: string, options: { session?: string }) => { if (!["viewer", "prompter", "reviewer"].includes(capability)) throw new Error("Invalid capability"); await updateParticipantCapability(options.session, participant, capability as Capability, true); });
program.command("revoke").description("Revoke a participant capability").argument("<participant>").argument("<capability>").option("--session <room-id>").action(async (participant: string, capability: string, options: { session?: string }) => { if (!["viewer", "prompter", "reviewer"].includes(capability)) throw new Error("Invalid capability"); await updateParticipantCapability(options.session, participant, capability as Capability, false); });
const proposal = program.command("proposal").description("Inspect or discard a pending agent proposal");
proposal.command("show").option("--session <room-id>").action(async (options: { session?: string }) => { const status = await liveSessionRequest<LiveSessionStatus>(options.session, { type: "status" }); if (!status.pendingProposal) throw new Error("No pending proposal"); console.log(await readFile(status.pendingProposal, "utf8")); });
proposal.command("discard").option("--session <room-id>").action(async (options: { session?: string }) => { await liveSessionRequest(options.session, { type: "proposal.discard" }); console.log(out.success("Proposal discarded")); });
proposal.command("resolve").description("Retry a manually resolved proposal against the newest human state").option("--session <room-id>").action(async (options: { session?: string }) => { await liveSessionRequest(options.session, { type: "proposal.retry" }, 30_000); console.log(out.success("Proposal resolved")); });
program.command("export").description("Export a preserved room as a patch, branch, or commit").argument("<room-id>").option("--format <format>", "patch, branch, or commit", "patch").option("--output <path>").option("--branch <name>").action(async (roomId: string, options: { format: string; output?: string; branch?: string }) => { if (!["patch", "branch", "commit"].includes(options.format)) throw new Error("Invalid export format"); await exportRoom(roomId, options as { format: "patch" | "branch" | "commit"; output?: string; branch?: string }); });
program.command("leave").description("Remove a preserved room workspace").argument("<room-id>").option("--force").action(cleanupRoomWorkspace);

const relay = program.command("relay", { hidden: true }).description("Run central relay infrastructure");
relay
  .command("serve")
  .description("Serve authenticated rooms for remote hosts and participants")
  .option("--host <address>", "address to listen on", process.env.MULTICODE_RELAY_HOST ?? "127.0.0.1")
  .option("--port <port>", "port to listen on", process.env.MULTICODE_RELAY_PORT ?? "7337")
  .option("--max-rooms <count>", "maximum concurrent rooms", process.env.MULTICODE_MAX_ROOMS ?? "100")
  .option("--rooms-per-ip <count>", "maximum active rooms per originating IP", process.env.MULTICODE_ROOMS_PER_IP ?? "5")
  .option("--max-participants-per-room <count>", "maximum participants per room, including the host", process.env.MULTICODE_MAX_PARTICIPANTS_PER_ROOM ?? "32")
  .action(serveRelay);

const shouldLaunchInteractiveUi = process.argv.length === 2
  && process.env.MULTICODE_TUI_CHILD !== "1"
  && process.stdin.isTTY
  && process.stdout.isTTY;

const execution = shouldLaunchInteractiveUi
  ? runInteractiveCli({ entryPath: process.argv[1] as string, cwd: process.cwd(), name: defaultName })
  : program.parseAsync();

execution.catch((error: unknown) => {
  console.error(err.error(`${err.label("Error")} ${error instanceof Error ? error.message : String(error)}`));
  process.exitCode = 1;
});
