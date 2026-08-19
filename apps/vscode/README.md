# MultiCode for VS Code

Host or join a shared Codex session without leaving VS Code. The extension runs the existing MultiCode CLI, streams activity into the **MultiCode** output channel, and lets you submit prompts from the Command Palette or status bar.

## Commands

- **MultiCode: Host Room** creates an isolated Git worktree and prints a room code.
- **MultiCode: Join Room** joins with a `XXXXX-XXXXX` room code.
- **MultiCode: Send Prompt** adds a prompt to the shared FIFO queue.
- **MultiCode: Stop or Leave Room** ends the current process.
- **MultiCode: Check Setup** runs the CLI diagnostics.

The packaged extension includes the MultiCode CLI. During development it also detects this repository's built CLI. Set `multicode.executable` only when you want to use a different CLI installation.

Open a Git repository with at least one commit before hosting. Git and an authenticated Codex CLI are required for hosts; collaborators only need MultiCode.
