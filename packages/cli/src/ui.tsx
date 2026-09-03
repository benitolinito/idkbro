import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useWindowSize } from "ink";
import stripAnsi from "strip-ansi";

type Screen = "launcher" | "join" | "session" | "exited";

export type SessionChoice = "host-codex" | "host-claude" | "join";

export interface InteractiveCliOptions {
  entryPath: string;
  cwd?: string;
  name?: string;
}

interface SessionProcess {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  stdin: NodeJS.WritableStream;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

type SpawnSession = (args: string[]) => SessionProcess;

const choices: Array<{ value: SessionChoice; title: string; description: string }> = [
  { value: "host-codex", title: "Host with Codex", description: "Share a Codex session from this repository" },
  { value: "host-claude", title: "Host with Claude", description: "Share a Claude session from this repository" },
  { value: "join", title: "Join a room", description: "Connect with a complete encrypted room token" },
];

const maxOutputCharacters = 120_000;

export function sanitizeTerminalOutput(value: string): string {
  return stripAnsi(value).replace(/\r(?!\n)/g, "\n");
}

export function maskRoomToken(value: string): string {
  const [code, secret] = value.split(".", 2);
  if (!secret) return value ? "•".repeat(Math.min(value.length, 48)) : "";
  return `${code}.${"•".repeat(Math.min(secret.length, 24))}`;
}

export function inferSessionStatus(value: string): string | undefined {
  if (/ready for prompts|joined room|connected to room/i.test(value)) return "connected";
  if (/relay unavailable|reconnecting|connection (?:closed|lost)/i.test(value)) return "reconnecting";
  return undefined;
}

function trimOutput(value: string): string {
  return value.length > maxOutputCharacters ? value.slice(-maxOutputCharacters) : value;
}

function defaultSpawn(options: InteractiveCliOptions): SpawnSession {
  return (args) => spawn(process.execPath, [options.entryPath, ...args], {
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, NO_COLOR: "1", MULTICODE_TUI_CHILD: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
}

function Logo(): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">MULTICODE</Text>
      <Text dimColor>Collaborative coding agents, one shared session.</Text>
    </Box>
  );
}

function Launcher({ selected }: { selected: number }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Logo />
      <Text bold>What would you like to do?</Text>
      <Box flexDirection="column" marginTop={1}>
        {choices.map((choice, index) => (
          <Box key={choice.value}>
            <Text {...(selected === index ? { color: "cyan" as const } : {})} bold={selected === index}>
              {selected === index ? "❯ " : "  "}{choice.title}
            </Text>
            <Text dimColor>  {choice.description}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑/↓ select  enter confirm  q quit</Text>
      </Box>
    </Box>
  );
}

function JoinPrompt({ token }: { token: string }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Logo />
      <Text bold>Join a room</Text>
      <Text dimColor>Paste the complete room token. Its secret remains local to this process.</Text>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
        <Text color="cyan">token  </Text>
        <Text>{maskRoomToken(token) || "Paste room token…"}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>enter join  esc back</Text>
      </Box>
    </Box>
  );
}

function SessionView({
  title,
  status,
  output,
  draft,
  stopped,
}: {
  title: string;
  status: string;
  output: string;
  draft: string;
  stopped: boolean;
}): React.JSX.Element {
  const { rows = 24, columns = 80 } = useWindowSize();
  const visibleLines = useMemo(() => {
    const reservedRows = 9;
    const limit = Math.max(5, rows - reservedRows);
    return output.replace(/\r/g, "").split("\n").slice(-limit).join("\n");
  }, [output, rows]);

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} justifyContent="space-between">
        <Text bold color="cyan">MULTICODE</Text>
        <Text>{title}</Text>
        <Text color={stopped ? "yellow" : "green"}>● {status}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} paddingX={1} paddingY={1}>
        <Text>{visibleLines || "Starting room…"}</Text>
      </Box>
      {!stopped ? (
        <Box borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text color="cyan" bold>❯ </Text>
          <Text>{draft || "Ask MultiCode to do something…"}</Text>
          <Text inverse> </Text>
        </Box>
      ) : null}
      <Box paddingX={1} justifyContent="space-between">
        <Text dimColor>{stopped ? "q quit" : "enter send  esc clear  ctrl+c stop"}</Text>
        <Text dimColor>/interrupt  /participants  /approve</Text>
      </Box>
    </Box>
  );
}

export function InteractiveCli({
  options,
  spawnSession = defaultSpawn(options),
}: {
  options: InteractiveCliOptions;
  spawnSession?: SpawnSession;
}): React.JSX.Element {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>("launcher");
  const [selected, setSelected] = useState(0);
  const [token, setToken] = useState("");
  const [draft, setDraft] = useState("");
  const [output, setOutput] = useState("");
  const [status, setStatus] = useState("starting");
  const [title, setTitle] = useState("Host · Codex");
  const child = useRef<SessionProcess | undefined>(undefined);

  const appendOutput = (chunk: unknown): void => {
    const text = sanitizeTerminalOutput(String(chunk));
    setOutput((current) => trimOutput(`${current}${text}`));
    const nextStatus = inferSessionStatus(text);
    if (nextStatus) setStatus(nextStatus);
  };

  const startSession = (choice: SessionChoice, roomToken?: string): void => {
    let args: string[];
    if (choice === "join") {
      args = ["join", roomToken ?? token, ...(options.name ? ["--name", options.name] : [])];
      setTitle("Participant");
    } else {
      const provider = choice === "host-claude" ? "claude" : "codex";
      args = ["host", "--agent", provider, ...(options.name ? ["--name", options.name] : [])];
      setTitle(`Host · ${provider === "claude" ? "Claude" : "Codex"}`);
    }
    setOutput("");
    setDraft("");
    setStatus("starting");
    setScreen("session");
    const running = spawnSession(args);
    child.current = running;
    running.stdout.on("data", appendOutput);
    running.stderr.on("data", appendOutput);
    running.once("error", (error) => {
      appendOutput(`\n✗ ${error.message}\n`);
      setStatus("failed");
      setScreen("exited");
    });
    running.once("exit", (code, signal) => {
      appendOutput(`\n${code === 0 ? "✓" : "✗"} Session ended${signal ? ` (${signal})` : code === null ? "" : ` (exit ${code})`}\n`);
      setStatus(code === 0 ? "stopped" : "failed");
      setScreen("exited");
      child.current = undefined;
    });
  };

  useEffect(() => () => {
    if (child.current?.exitCode === null && child.current.signalCode === null) child.current.kill("SIGTERM");
  }, []);

  useInput((input, key) => {
    if (screen === "launcher") {
      if (key.upArrow) setSelected((current) => (current + choices.length - 1) % choices.length);
      else if (key.downArrow) setSelected((current) => (current + 1) % choices.length);
      else if (input === "q" || key.escape) exit();
      else if (key.return) {
        const choice = choices[selected]?.value ?? "host-codex";
        if (choice === "join") setScreen("join"); else startSession(choice);
      }
      return;
    }

    if (screen === "join") {
      if (key.escape) { setToken(""); setScreen("launcher"); return; }
      if (key.return) { if (token.trim()) startSession("join", token.trim()); return; }
      if (key.backspace || key.delete) setToken((current) => current.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setToken((current) => `${current}${input}`.trimStart());
      return;
    }

    if (screen === "exited") {
      if (input === "q" || key.escape || key.return) exit();
      return;
    }

    if (key.ctrl && input === "c") {
      setStatus("stopping");
      child.current?.kill("SIGINT");
      return;
    }
    if (key.escape) { setDraft(""); return; }
    if (key.return) {
      const value = draft.trim();
      if (!value) return;
      child.current?.stdin.write(`${value}\n`);
      setOutput((current) => trimOutput(`${current}\nYou\n${value}\n`));
      setDraft("");
      setStatus("connected");
      return;
    }
    if (key.backspace || key.delete) setDraft((current) => current.slice(0, -1));
    else if (input && !key.ctrl && !key.meta) setDraft((current) => `${current}${input}`);
  });

  if (screen === "launcher") return <Launcher selected={selected} />;
  if (screen === "join") return <JoinPrompt token={token} />;
  return <SessionView title={title} status={status} output={output} draft={draft} stopped={screen === "exited"} />;
}

export async function runInteractiveCli(options: InteractiveCliOptions): Promise<void> {
  const instance = render(<InteractiveCli options={options} />, {
    exitOnCtrlC: false,
    incrementalRendering: true,
    maxFps: 20,
    alternateScreen: true,
  });
  await instance.waitUntilExit();
}
