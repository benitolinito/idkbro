# MultiCode for VS Code

Host or join a shared Codex session without leaving VS Code. The extension includes a MultiCode activity-bar view with a shared conversation, streaming reasoning and responses, command and diff cards, participants, prompt queue state, and room controls. Raw process activity remains available in the **MultiCode** output channel.

## Commands

- **MultiCode: Host Room** creates isolated shared and Codex worktrees, opens the shared workspace, and copies the complete encrypted invite token.
- **MultiCode: Join Room** creates an isolated participant worktree without switching or resetting the original checkout.
- **MultiCode: Open Chat** opens the shared conversation sidebar.
- **MultiCode: Send Prompt** adds a prompt to the shared FIFO queue.
- **MultiCode: Stop or Leave Room** ends the current process.
- **MultiCode: Check Setup** runs the CLI diagnostics.
- **MultiCode: Open Codex Preview (Not Merged)** opens the encrypted read-only patch beside the editor.
- **MultiCode: Open Agent Conflict Proposal** opens a pending encrypted proposal without applying it.

The packaged extension includes the MultiCode CLI. During development it also detects this repository's built CLI. Set `multicode.executable` only when you want to use a different CLI installation.

Open a clone of the same Git repository before hosting or joining. Hosts also need an authenticated Codex CLI. Bootstrap uses a verified checkpoint; live UTF-8 text and file operations use the host's durable Yjs/manifest authority. Original checkouts stay untouched, and room worktrees are preserved on leave for recovery or export.
