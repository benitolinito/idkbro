# MultiCode for VS Code

Host or join a shared Codex session without leaving VS Code. The extension includes a MultiCode activity-bar view with a shared conversation, streaming reasoning and responses, command and diff cards, participants, prompt queue state, and room controls. Raw process activity remains available in the **MultiCode** output channel.

## Commands

- **MultiCode: Host Room** runs Codex in the current workspace and prints a room code.
- **MultiCode: Join Room** safely switches this checkout to a synchronized room branch using a `XXXXX-XXXXX` room code.
- **MultiCode: Open Chat** opens the shared conversation sidebar.
- **MultiCode: Send Prompt** adds a prompt to the shared FIFO queue.
- **MultiCode: Stop or Leave Room** ends the current process.
- **MultiCode: Check Setup** runs the CLI diagnostics.

The packaged extension includes the MultiCode CLI. During development it also detects this repository's built CLI. Set `multicode.executable` only when you want to use a different CLI installation.

Open a clone of the same Git repository before hosting or joining. Hosts also need an authenticated Codex CLI. MultiCode preserves participant changes before switching branches, applies each verified host checkpoint, and restores the original branch when the participant leaves.
