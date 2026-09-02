# MultiCode for VS Code

Host or join a shared Codex or Claude session without leaving VS Code. The extension includes a MultiCode activity-bar view with streaming reasoning and responses, command, tool, question, and diff cards, participants, prompt queue state, and room controls. Raw process activity remains available in the **MultiCode** output channel.

## Commands

- **MultiCode: Host Room** chooses an agent, leases the clean checkout, creates one temporary agent worktree, stays in the current window, and copies the complete encrypted invite token.
- Starting from a legacy v2 MultiCode room worktree discards its shared/agent worktrees and switches the same window back to the original repository before hosting.
- **MultiCode: Join Room** joins the shared agent conversation and adds a separate MultiCode-managed mirror of the host's latest workspace version without modifying the current workspace.
- **MultiCode: Open Chat** opens the shared conversation sidebar.
- **MultiCode: Send Prompt** adds a prompt to the shared FIFO queue.
- **MultiCode: Stop or Leave Room** ends the current process.
- **MultiCode: Check Setup** runs the CLI diagnostics.
- **MultiCode: Select Claude Authentication** chooses the host's local Claude subscription or explicit API-key billing.
- **MultiCode: Configure Claude API Key** stores a BYOK Anthropic key in VS Code SecretStorage.
- **MultiCode: Forget Claude API Key** removes the stored BYOK key.
- **MultiCode: Open Agent Preview (Not Merged)** opens the encrypted read-only patch beside the editor.
- **MultiCode: Open Agent Conflict Proposal** opens a pending encrypted proposal without applying it.

The packaged extension includes the MultiCode CLI. During development it also detects this repository's built CLI. Set `multicode.executable` only when you want to use a different CLI installation.

Hosts need a clean Git repository and the selected agent CLI. Participants can join from any VS Code window without cloning the host repository. MultiCode decrypts verified host checkpoints into an isolated managed mirror, adds it to the Explorer, and preserves the synthetic room base as `HEAD` so shared changes appear in Source Control; it never overwrites the participant's existing folder. Local edits inside the mirror pause later synchronization rather than being discarded. Claude is an external-binary MVP: enable `multicode.experimentalClaude`, install the Claude CLI, and run `claude auth login`. The extension uses that local subscription login by default without reading or copying its credentials. API-key authentication remains available through SecretStorage. At the start of each subscription-backed room, the host confirms that allowed participant prompts consume the host account's limits. Claude steering stays hidden until its active-turn behavior is verified; queue and interrupt remain available.
