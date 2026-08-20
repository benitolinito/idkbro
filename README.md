# MultiCode

MultiCode lets multiple people collaborate around one coding-agent session from VS Code or the terminal. The host runs Codex in the current workspace; everyone can submit prompts and receives the same verified code checkpoints in real time.

The public relay defaults to `wss://multicode.luisagd.com`, so the normal workflow uses short room codes instead of network configuration or accounts.

> [!IMPORTANT]
> MultiCode is an early release. It includes a VS Code extension, CLI, and self-hosted relay, but there is no browser client or managed persistence yet.

## How it works

```text
Host + Codex ── outbound WSS ──▶ multicode.luisagd.com ◀── outbound WSS ── Collaborator
```

- Only the host runs Codex and writes to the authoritative workspace.
- The relay generates a random `XXXXX-XXXXX` room code.
- Each originating IP can host at most five active rooms.
- Anyone with a room code can join and submit prompts.
- Prompts from all participants execute through one FIFO queue.
- Every participant checkout follows the same synchronized room branch and commit.
- Late joiners receive the participants, active prompt, queue, and latest workspace checkpoint.

## Requirements

- [Node.js](https://nodejs.org/) 20 or newer
- Hosting: Git, an authenticated Codex CLI, and a repository with at least one commit
- VS Code: version 1.96 or newer
- Joining: a clone containing the host's base commit; Codex is not required

## VS Code extension

Build and install the extension from this checkout:

```bash
npm install
npm run build
npm run package -w multicode-vscode
code --install-extension apps/vscode/multicode-vscode-0.3.2.vsix
```

Reload VS Code after installation. Open the Command Palette with <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> or <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>, then use:

- **MultiCode: Host Room** — start Codex in the current workspace and copy the new room code to the clipboard.
- **MultiCode: Join Room** — connect with a shared `XXXXX-XXXXX` room code.
- **MultiCode: Open Chat** — open the shared Codex-style conversation sidebar.
- **MultiCode: Send Prompt** — add a prompt to the room's shared FIFO queue.
- **MultiCode: Check Setup** — check Node.js, Git, Codex, and the current repository.
- **MultiCode: Stop or Leave Room** — end the current host or participant session.

Room activity appears in the MultiCode sidebar as a shared conversation with participants, queue state, streaming reasoning and responses, commands, and workspace diffs. The **MultiCode** output channel keeps the raw process logs, and the status bar shows the current connection. The packaged VSIX includes the MultiCode CLI; hosts still need Git and an authenticated Codex CLI installed locally.

Settings are available for the participant display name, relay URL, and an optional custom MultiCode executable. See [`apps/vscode`](apps/vscode) for extension development details.

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

Check the hosting environment from the repository you want Codex to modify:

```bash
multicode doctor
```

## Everyday workflow

### 1. Start a room

From the Git repository you want to work on:

```bash
multicode host
```

MultiCode creates isolated shared/agent worktrees, connects to the Raspberry Pi authority, and prints one complete invite token:

```text
Room token: K7MNP-4XQ2R.<room-secret>
```

Type prompts into the host terminal at any time.

### 2. Join the room

The other person pastes the complete token:

```bash
multicode join K7MNP-4XQ2R.<room-secret>
```

Both people can now submit prompts and see the same agent activity. Press <kbd>Ctrl</kbd>+<kbd>C</kbd> to leave or stop the room.

Use names when desired:

```bash
multicode host --name "Ada"
multicode join K7MNP-4XQ2R.<room-secret> --name "Grace"
```

> [!WARNING]
> A room code is a temporary bearer credential. Anyone with the code can submit prompts to that room. Stop the host to invalidate it.

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

The container is published only on the Pi's loopback interface:

```text
127.0.0.1:7337 -> multicode-relay:7337
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
curl https://multicode.luisagd.com/health
```

Expected response:

```json
{"ok":true,"rooms":0,"uptimeSeconds":12}
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

The host and Codex use MultiCode-owned isolated worktrees. The original checkout
is never switched, stashed, reset, or cleaned.

Participants receive an isolated room worktree and acknowledge encrypted
checkpoints only after the Pi relay has durably recorded them. If the Pi is
unreachable, host and join pause and retry; they never fork state locally.

Ignored files are neither synchronized nor removed. Room creation and joining are rejected during a merge, rebase, cherry-pick, or revert.

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

| Package | Responsibility |
| --- | --- |
| `@multicode/cli` | Local, hosted, and participant commands |
| `@multicode/protocol` | Shared schemas and event types |
| `@multicode/workspace` | Git inspection, checkpoints, branch backup, and synchronization |
| `@multicode/agent-adapters` | Codex app-server integration |
| `@multicode/relay` | Embedded and standalone WebSocket relays |
| `multicode-vscode` | VS Code commands, session output, and status-bar controls |

## Current limitations

- Only the Codex adapter is available.
- Relay state is held in memory; restarting it closes active rooms.
- A remote room closes if its host disconnects.
- Approval requests are reported but cannot be resolved interactively through the CLI.
- There is no browser client, automatic reconnect, or event replay after disconnect.
- Participant room-branch and backup-ref cleanup is manual.
