# MultiCode

> Shared-change test: **If you can read this, the README update reached the other user.** (September 1, 2026)

MultiCode lets a team co-prompt one Codex or Claude session running against the host's local repository. Participants share the prompt queue, streamed agent activity, approvals, structured questions, change previews, and an encrypted read-only mirror of the host's latest workspace version.

The public relay defaults to `wss://multicode.luisagd.com`, so the normal workflow uses short room codes instead of network configuration or accounts.

Only the host needs the repository, Git, and the selected coding-agent CLI. Participants can join from VS Code or the MultiCode CLI without cloning the project.

## How it works

```text
Host + Agent ── outbound WSS ──▶ multicode.luisagd.com ◀── outbound WSS ── Collaborator
```

- The host owns the repository, agent worktree, proposals, and workspace commits.
- The relay generates a random `XXXXX-XXXXX` locator; a separate high-entropy invitation secret encrypts application payloads end to end.
- Each originating IP can host at most five active rooms.
- Observer, prompter, and reviewer capabilities are controlled by the host.
- Prompts from all participants execute through one FIFO queue. Any participant with prompter access can edit, remove, or steer any queued prompt, including one submitted by the host.
- The selected agent runs in a temporary isolated worktree; accepted results are applied only to the host checkout.
- VS Code participants receive the host's published file tree in a separate MultiCode-managed mirror; their existing folders are never overwritten.
- The public relay sees routing metadata and encrypted payload sizes, not prompts, agent output, previews, proposals, or workspace contents.

## Requirements

- [Node.js](https://nodejs.org/) 22.5 or newer (the session journal uses the built-in SQLite API in WAL mode)
- Hosting: Git, either an authenticated Codex CLI or a Claude CLI signed in with a Claude subscription or configured with an Anthropic API key, and a repository with at least one commit
- VS Code: version 1.96 or newer
- Joining: VS Code or Node.js; no repository clone or agent installation is required

## VS Code extension

Download the latest packaged extension from
[GitHub Releases](https://github.com/benitolinito/idkbro/releases/latest), or
build and install it from this checkout:

```bash
npm install
npm run build
npm run package -w multicode-vscode
code --install-extension apps/vscode/multicode-vscode-0.4.10.vsix
```

Reload VS Code after installation. Open the Command Palette with <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> or <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>, then use:

- **MultiCode: Host Room** — choose Codex or experimental Claude and share its session from the current checkout.
- **MultiCode: Join Room** — connect with a shared `XXXXX-XXXXX` room code.
- **MultiCode: Open Chat** — open the shared agent conversation sidebar.
- **MultiCode: Send Prompt** — add a prompt to the room's shared FIFO queue.
- **MultiCode: Check Setup** — check Node.js, Git, the configured agent, authentication, and the current repository.
- **MultiCode: Select Claude Authentication** — choose the host's local Claude subscription or explicit API-key billing.
- **MultiCode: Configure Claude API Key** — store a BYOK Anthropic key in VS Code SecretStorage.
- **MultiCode: Forget Claude API Key** — remove the BYOK key from VS Code SecretStorage.
- **MultiCode: Stop or Leave Room** — end the current host or participant session.

Room activity appears in the MultiCode sidebar as a shared conversation with participants, queue state, synchronized model and reasoning-level controls, streaming reasoning and responses, commands, generic tools, structured questions, and workspace diffs. A change to either agent setting is reflected for the host and every connected participant, including users who join later. The **MultiCode** output channel keeps the raw process logs, and the status bar shows the current connection. The packaged VSIX includes the MultiCode CLI; hosts still need Git and the selected agent CLI installed locally.

Claude is currently an external-binary MVP. Install the Claude CLI, enable `multicode.experimentalClaude`, optionally set `multicode.claudeExecutable`, and run `claude auth login`. MultiCode uses that local login by default without reading, copying, or relaying its credentials. Hosts can instead select API-key authentication; the key is passed only to the local host subprocess and is not stored in settings, handoff state, or relay messages. Existing stored-key users remain on API-key authentication until they switch explicitly. Claude steering is intentionally hidden until active-turn semantics are verified; queue or interrupt instead.

Settings are available for the default agent, agent executable paths, participant display name, relay URL, and an optional custom MultiCode executable. See [`apps/vscode`](apps/vscode) for extension development details.

## CLI setup

```bash
git clone https://github.com/benitolinito/idkbro
cd idkbro
npm install
npm run build
npm link --workspace @multicode/cli
```

Or run the complete installation as one command:

```bash
npm run setup:cli
```

Check the hosting environment from the repository you want the agent to modify:

```bash
multicode doctor
multicode doctor --agent claude --claude-auth subscription
```

## Everyday workflow

### 1. Start a room

From the Git repository you want to work on:

```bash
multicode host
multicode host --agent claude --claude-auth subscription
```

For explicit pay-as-you-go API billing, set `ANTHROPIC_API_KEY` and use `--claude-auth api-key`. Direct CLI invocations retain `--claude-auth auto` as the compatibility default, so use an explicit mode when the billing source matters.

MultiCode leases the clean checkout, creates one temporary agent worktree, starts the host authority, connects outbound to the untrusted relay, and prints one complete invite token:

```text
Room token: K7MNP-4XQ2R.<room-secret>
```

Type prompts into the host terminal at any time.

### 2. Join the room

The other person pastes the complete token:

```bash
multicode join K7MNP-4XQ2R.<room-secret>
```

Participants can submit prompts and follow encrypted agent activity. VS Code opens a separate managed workspace containing the host's latest verified version as the participant window's sole root; the terminal CLI remains conversation-only. Press <kbd>Ctrl</kbd>+<kbd>C</kbd> to leave or stop the room.

Use names when desired:

```bash
multicode host --name "Ada"
multicode join K7MNP-4XQ2R.<room-secret> --name "Grace"
```

> [!WARNING]
> Share the complete token, not only its locator. The secret after the dot is the end-to-end encryption key and is never sent to the public relay.

Host-terminal controls include `/participants`, `/grant <id-or-name> <capability>`, `/revoke ...`, `/interrupt`, `/approve <request> accept|decline|cancel`, and `/proposal show|retry|discard`.

The same controls are available as authenticated thin-client commands:

```bash
multicode status [room-id]
multicode prompt "implement the next step" --session <room-id>
multicode interrupt --session <room-id>
multicode participants --session <room-id>
multicode grant <participant> reviewer --session <room-id>
multicode proposal show|resolve|discard --session <room-id>
multicode export <room-id> --format patch|branch|commit
multicode leave <room-id>
```

## Self-host the relay on a Raspberry Pi

> [!IMPORTANT]
> PostgreSQL is relay infrastructure, configured once by the relay operator. It
> is never a requirement for people who host or join a room from the CLI or VS Code.

The included deployment is a completely separate Compose project. It does not modify or join an existing Compose project or Docker network.

### 1. Clone and start it

```bash
git clone https://github.com/benitolinito/idkbro ~/multicode-relay
cd ~/multicode-relay
cp deploy/.env.example deploy/.env
# Edit deploy/.env and replace the database password.

docker compose -f deploy/compose.yaml up -d --build
```

nginx is published only on the Pi's loopback interface. It serves the website
at `/` and proxies the relay routes over the private Compose network:

```text
127.0.0.1:7337 -> multicode-website:80 -> multicode-relay:7337
```

Check it locally:

```bash
curl http://127.0.0.1:7337/health
docker compose -f deploy/compose.yaml logs -f
```

### 2. Route the existing Cloudflare Tunnel

Add this published application to the tunnel already running on the Pi:

```text
Hostname: multicode.luisagd.com
Service:  http://localhost:7337
```

The existing `cloudflared` container uses host networking, so it can reach the loopback-only port. No port forwarding, second tunnel container, or change to the existing `orange-git` Compose project is required.

Verify the public endpoint:

```bash
curl -I https://multicode.luisagd.com/
curl https://multicode.luisagd.com/health
```

Expected response:

```json
{ "ok": true, "rooms": 0, "participants": 0, "droppedPresenceEvents": 0, "uptimeSeconds": 12 }
```

### Relay operations

```bash
# Status
docker compose -f deploy/compose.yaml ps

# Update
git pull
docker compose -f deploy/compose.yaml up -d --build

# Stop only MultiCode
docker compose -f deploy/compose.yaml down
```

Optional limits can be changed in `deploy/.env`:

```dotenv
MULTICODE_MAX_ROOMS=100
MULTICODE_ROOMS_PER_IP=5
MULTICODE_MAX_PARTICIPANTS_PER_ROOM=32
TZ=America/New_York
MULTICODE_POSTGRES_USER=multicode
MULTICODE_POSTGRES_PASSWORD=use-a-long-random-secret
```

The relay uses Cloudflare's `CF-Connecting-IP` header when enforcing the per-IP limit and falls back to the direct socket address outside Cloudflare.

The host creates all room state automatically. Collaborators never configure
databases, worktrees, encryption keys, ports, or relay credentials.

Override the public relay:

```bash
MULTICODE_RELAY_URL=wss://another-relay.example.com multicode host
multicode join K7MNP-4XQ2R.<room-secret> --relay wss://another-relay.example.com
```

Run `multicode --help` for operator/development commands. End users only need
`multicode host` and `multicode join <full-token>`.

## Git safety model

The host keeps using the original checkout. MultiCode never moves its branch or resets its index, and a per-repository lease prevents two hosted rooms from owning the checkout at once. The selected agent uses one temporary detached worktree, which is removed when the host stops. Accepted agent changes appear as ordinary changes in the host working tree.

VS Code participants receive encrypted, self-contained workspace checkpoints in a separate MultiCode-managed repository. Its working tree mirrors the host while its synthetic base stays checked out, so the participant sees the shared modified, added, and deleted files in Source Control. A checkpoint is applied only when the mirror still matches its last synchronized projection, and it never resets or edits the participant's existing checkout. Room creation is rejected while the host repository is in the middle of a merge, rebase, cherry-pick, or revert.

## Development

```bash
npm run build      # Compile every package
npm run typecheck  # Run TypeScript project checks
npm test           # Build and run the Vitest suite
npm run clean      # Remove TypeScript build outputs
```

Build and package the VS Code extension:

```bash
npm run build
npm run package -w multicode-vscode
```

Publish a downloadable GitHub Release by updating the extension version and
pushing it to `main`:

```bash
npm version 0.4.0 --workspace multicode-vscode --no-git-tag-version
git add apps/vscode/package.json package-lock.json
git commit -m "release: v0.4.0"
git push
```

The workflow runs all checks and publishes the packaged VSIX when that version
does not already exist on the repository's Releases page. Further commits at
the same version only produce temporary Actions artifacts.

| Package                     | Responsibility                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `@multicode/cli`            | Host daemon/controller and authenticated thin-client commands                                        |
| `@multicode/protocol`       | Shared schemas and event types                                                                       |
| `@multicode/session-core`   | Host-local transaction journal, recovery state, and authenticated IPC                                 |
| `@multicode/workspace`      | Host checkout leases, agent worktrees, B/A/H merges, and transactional application                    |
| `@multicode/agent-adapters` | Provider-neutral Codex app-server and Claude Agent SDK integration                                   |
| `@multicode/relay`          | Embedded and standalone WebSocket relays                                                             |
| `multicode-vscode`          | VS Code commands, session output, and status-bar controls                                            |

## Current limitations

- Claude requires an external Claude CLI. Subscription login and explicit BYOK API-key authentication are supported; platform-specific Claude binaries are not bundled in the VSIX yet.
- Anthropic's treatment of third-party Agent SDK subscription usage may change. API-key authentication remains the predictable pay-as-you-go fallback.
- Claude active-turn steering remains disabled until its semantics are verified; queued prompts and interruption are supported.
- Only one regular agent turn or pending proposal is allowed at a time.
- The host device must remain online. A transient host relay connection can resume, but rooms do not survive the host device being offline.
- Participant mirrors are view-oriented; edits made inside a mirror are preserved locally but pause further synchronization instead of changing the host.
- Encrypted workspace mirrors are limited to 32 MiB per checkpoint and do not materialize ignored dependency directories or nested submodule checkouts.
- Conflict resolution is host-driven: reviewers inspect the encrypted proposal, and the host resolves the local files before retrying.
- Relay process restarts are not persisted as live WebSocket rooms; host-local authoritative state and acknowledged edits remain recoverable from SQLite.
