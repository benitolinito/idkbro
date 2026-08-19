# MultiCode

MultiCode lets multiple people collaborate around one coding-agent session. The host runs Codex in an isolated Git worktree; everyone can submit prompts and watch agent output, commands, and workspace diffs in real time.

The public relay defaults to `wss://multicode.luisagd.com`, so the normal workflow uses short room codes instead of network configuration or accounts.

> [!IMPORTANT]
> MultiCode is an early terminal-based release. It includes a self-hosted relay, but there is no browser client or managed persistence yet.

## How it works

```text
Host + Codex ── outbound WSS ──▶ multicode.luisagd.com ◀── outbound WSS ── Collaborator
```

- Only the host runs Codex and owns the repository worktree.
- The relay generates a random `XXXXX-XXXXX` room code.
- Each originating IP can host at most five active rooms.
- Anyone with a room code can join and submit prompts.
- Prompts from all participants execute through one FIFO queue.
- Late joiners receive the participants, active prompt, queue, and latest diff.

## Requirements

- [Node.js](https://nodejs.org/) 20 or newer
- Hosting: Git, an authenticated Codex CLI, and a repository with at least one commit
- Joining: a built MultiCode checkout; Codex and the host's repository are not required

## Setup

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

MultiCode creates an isolated worktree, starts Codex, connects to `multicode.luisagd.com`, and prints a room code:

```text
Room code: K7MNP-4XQ2R
```

Type prompts into the host terminal at any time.

### 2. Join the room

The other person pastes the code:

```bash
multicode join K7MNP-4XQ2R
```

Both people can now submit prompts and see the same agent activity. Press <kbd>Ctrl</kbd>+<kbd>C</kbd> to leave or stop the room.

Use names when desired:

```bash
multicode host --name "Ada"
multicode join K7MNP-4XQ2R --name "Grace"
```

> [!WARNING]
> A room code is a temporary bearer credential. Anyone with the code can submit prompts to that room. Stop the host to invalidate it.

## Self-host the relay on a Raspberry Pi

The included deployment is a completely separate Compose project. It does not modify or join an existing Compose project or Docker network.

### 1. Clone and start it

```bash
git clone https://github.com/benitolinito/idkbro ~/multicode-relay
cd ~/multicode-relay

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
```

The relay uses Cloudflare's `CF-Connecting-IP` header when enforcing the per-IP limit and falls back to the direct socket address outside Cloudflare.

## Advanced usage

Override the public relay:

```bash
MULTICODE_RELAY_URL=wss://another-relay.example.com multicode host
multicode join K7MNP-4XQ2R --relay wss://another-relay.example.com
```

Host directly without the central relay:

```bash
multicode room host \
  --local \
  --listen 0.0.0.0 \
  --port 7337
```

Run `multicode --help` for the full command tree. During development, every command can also be run without linking by using `npm run multicode -- <command>` from the MultiCode checkout.

## Git safety model

Each hosted session starts on a new `multicode/<room-id>` branch created from the repository's committed `HEAD`. Uncommitted and untracked changes are excluded. Room creation is rejected during a merge, rebase, cherry-pick, or revert.

Worktrees are created under `~/.multicode/worktrees/`. Existing room worktrees and branches are not automatically removed when the process stops.

## Development

```bash
npm run build      # Compile every package
npm run typecheck  # Run TypeScript project checks
npm test           # Build and run the Vitest suite
npm run clean      # Remove TypeScript build outputs
```

| Package | Responsibility |
| --- | --- |
| `@multicode/cli` | Local, hosted, and participant commands |
| `@multicode/protocol` | Shared schemas and event types |
| `@multicode/workspace` | Git inspection and isolated worktree creation |
| `@multicode/agent-adapters` | Codex app-server integration |
| `@multicode/relay` | Embedded and standalone WebSocket relays |

## Current limitations

- Only the Codex adapter is available.
- Relay state is held in memory; restarting it closes active rooms.
- A remote room closes if its host disconnects.
- Approval requests are reported but cannot be resolved interactively through the CLI.
- There is no browser client, automatic reconnect, or event replay after disconnect.
- Worktree and branch cleanup is manual.
