# MultiCode for VS Code

Host or join a shared Codex session without leaving VS Code. The extension includes a MultiCode activity-bar view with a shared conversation, streaming reasoning and responses, command and diff cards, participants, prompt queue state, and room controls. Raw process activity remains available in the **MultiCode** output channel.

## Commands

- **MultiCode: Host Room** leases the clean checkout, creates one temporary Codex worktree, stays in the current window, and copies the complete encrypted invite token.
- Starting from a legacy v2 MultiCode room worktree discards its shared/agent worktrees and switches the same window back to the original repository before hosting or joining.
- **MultiCode: Join Room** synchronizes the room into the current clean checkout without moving its branch or resetting its index.
- **MultiCode: Open Chat** opens the shared conversation sidebar.
- **MultiCode: Send Prompt** adds a prompt to the shared FIFO queue.
- **MultiCode: Stop or Leave Room** ends the current process.
- **MultiCode: Check Setup** runs the CLI diagnostics.
- **MultiCode: Open Codex Preview (Not Merged)** opens the encrypted read-only patch beside the editor.
- **MultiCode: Open Agent Conflict Proposal** opens a pending encrypted proposal without applying it.

The packaged extension includes the MultiCode CLI. During development it also detects this repository's built CLI. Set `multicode.executable` only when you want to use a different CLI installation.

Open a clean clone of the same Git repository at the host's base commit before hosting or joining. Hosts also need an authenticated Codex CLI. Bootstrap uses a verified checkpoint; live UTF-8 text and file operations use the host's durable Yjs/manifest authority. Room changes appear directly in both users' local checkouts and remain there after leaving.
