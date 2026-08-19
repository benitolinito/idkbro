# MultiCode

MultiCode is a CLI-first collaboration layer for running coding agents in isolated Git worktrees. It provides a shared event protocol, repository safety checks, and a structured adapter for the Codex app server.

> [!IMPORTANT]
> MultiCode is an early, local-only vertical slice. The collaboration relay, browser room, and interactive approval handling are not implemented yet.

## What works today

- Checks the local Node.js, Git, and Codex CLI setup.
- Inspects the current Git repository and detects unfinished operations.
- Creates a dedicated `multicode/<room-id>` branch and worktree from the current `HEAD`.
- Starts Codex through its app-server protocol and streams agent and command events.
- Normalizes agent activity into a provider-independent event model.

## Requirements

- [Node.js](https://nodejs.org/) 20 or newer
- Git
- An installed and authenticated Codex CLI
- A Git repository with at least one commit

Run the built-in environment check after setup to confirm that the required tools are available.

## Getting started

Install dependencies and build all workspace packages:

```bash
npm install
npm run build
```

Check the environment from the Git repository you want MultiCode to work with:

```bash
node packages/cli/dist/index.js doctor
```

Validate that a room can be created without changing anything:

```bash
node packages/cli/dist/index.js room create --dry-run
```

Start a local Codex room and send its first prompt:

```bash
node packages/cli/dist/index.js room create \
  --agent codex \
  --prompt "Summarize this repository"
```

MultiCode creates the room worktree under `~/.multicode/worktrees/` and prints its branch, path, and Codex thread ID. Press <kbd>Ctrl</kbd>+<kbd>C</kbd> to stop the local room.

### Room options

```text
--agent <agent>    Agent adapter to use (currently only codex)
--prompt <prompt>  Initial prompt to send to the agent
--model <model>    Override the configured Codex model
--dry-run          Validate the repository without creating a worktree
```

Run `node packages/cli/dist/index.js --help` for the full command tree.

## Git safety model

Each room starts on a new branch created from the repository's current committed `HEAD`. Uncommitted and untracked changes are deliberately excluded, and room creation is rejected while a merge, rebase, cherry-pick, or revert is in progress.

This keeps the agent's changes isolated from the working copy where MultiCode was launched. Existing room worktrees and branches are not automatically removed when the process stops.

## Development

```bash
npm run build      # Compile every package
npm run typecheck  # Run TypeScript project checks
npm test           # Build and run the Vitest suite
npm run clean      # Remove TypeScript build outputs
```

The repository is an npm workspaces monorepo:

| Package | Responsibility |
| --- | --- |
| `@multicode/cli` | Commands for diagnostics and local room creation |
| `@multicode/protocol` | Shared room schemas, controller actions, and agent event types |
| `@multicode/workspace` | Git inspection, room ID sanitization, and isolated worktree creation |
| `@multicode/agent-adapters` | Agent integrations and Codex app-server event normalization |

## Current limitations

- Only the Codex adapter is available.
- Rooms are local processes; there is no relay or browser client yet.
- Approval requests are reported but cannot be resolved interactively through the CLI.
- A room started without `--prompt` cannot accept a later prompt through the current CLI.
- Worktree and branch cleanup is manual.

## Roadmap

The protocol and local execution layer are intended to support the next milestones: a collaboration relay, a browser-based room, controller handoff, prompt proposals, approval resolution, and live diff updates.
