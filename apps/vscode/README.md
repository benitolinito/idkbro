<p align="center">
  <img src="media/multicode-square.png" width="128" alt="MultiCode logo">
</p>

# MultiCode — Shared Codex & Claude Sessions

Pair-program with teammates through one shared Codex or Claude coding-agent session—without leaving VS Code.

[Install from the Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=benitolinito1.multicode-vscode) · [Documentation](https://github.com/benitolinito/idkbro) · [Report an issue](https://github.com/benitolinito/idkbro/issues)

## Start collaborating

1. Open a Git repository in VS Code.
2. Run **MultiCode: Host Room** from the Command Palette.
3. Send the copied invitation to your teammate. It contains the Marketplace install link and the encrypted room token.

Your teammate installs MultiCode, runs **MultiCode: Join Room**, and pastes the token. Only the host needs the repository and coding-agent CLI.

## One agent session, shared with your team

- **Host Codex or Claude locally.** Keep the agent, credentials, and authoritative checkout on the host's machine.
- **Share the prompt queue.** Teammates can submit, edit, remove, and steer queued prompts through one FIFO workflow.
- **Follow work live.** See streaming reasoning, responses, commands, tool activity, questions, approvals, and participant presence.
- **Review changes safely.** Participants receive encrypted, verified workspace previews in an isolated managed mirror.
- **Stay in control.** The host controls viewer, prompter, and reviewer capabilities and resolves sensitive approvals.

## How it works

```text
Host + Codex/Claude ── encrypted outbound WSS ──▶ MultiCode relay
                                                    ▲
                                                    │ encrypted outbound WSS
                                                    │
                                              Teammate in VS Code
```

The relay routes encrypted session traffic. Prompt contents, agent output, approvals, and workspace previews are encrypted end to end with the secret contained in the complete invitation token.

## Requirements

### Host

- VS Code 1.96 or newer
- Node.js 22.5 or newer
- Git and a repository with at least one commit
- An authenticated Codex CLI, or the Claude CLI signed in with a subscription or configured API key

### Participant

- VS Code 1.96 or newer
- The complete MultiCode invitation token
- No repository clone or agent installation required

## Commands

- **MultiCode: Host Room** — choose Codex or Claude and create an encrypted room.
- **MultiCode: Join Room** — join with a complete invitation token.
- **MultiCode: Open Chat** — open the shared-agent sidebar.
- **MultiCode: Send Prompt** — submit a prompt to the shared queue.
- **MultiCode: Stop or Leave Room** — end the current session.
- **MultiCode: Check Setup** — verify Node.js, Git, agent installation, authentication, and repository state.
- **MultiCode: Select Claude Authentication** — choose a local Claude subscription or API-key billing.
- **MultiCode: Open Agent Preview (Not Merged)** — inspect the encrypted read-only workspace preview.
- **MultiCode: Open Agent Conflict Proposal** — review a pending proposal without applying it.

## Security and privacy

- Agent credentials remain on the host's machine.
- API keys are never included in invitations or relayed session data.
- Invitation secrets are not sent to the public relay.
- Existing participant folders are never overwritten.
- Local participant edits pause synchronization instead of being discarded.

Treat the complete invitation token like a password: anyone who has it may attempt to join the room.

## Support

See [SUPPORT.md](SUPPORT.md) for troubleshooting and responsible vulnerability reporting. Release history is available in [CHANGELOG.md](CHANGELOG.md).

## License

MIT
