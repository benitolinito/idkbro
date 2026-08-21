# MultiCode

MultiCode lets multiple people edit a real VS Code workspace while sharing one isolated Codex session. Human text edits synchronize through authoritative Yjs documents; Git checkpoints are used only for bootstrap, recovery, compaction, and export.

The public relay defaults to `wss://multicode.luisagd.com`, so the normal workflow uses short room codes instead of network configuration or accounts.

> [!IMPORTANT]
> MultiCode currently supports regular UTF-8 text files up to 96 KiB. Binary collaboration, symlinks, offline editing, and browser clients are intentionally outside the first release.

## How it works

```text
Host + Codex ── outbound WSS ──▶ multicode.luisagd.com ◀── outbound WSS ── Collaborator
```

- The host session daemon is the sole authority for manifests, Yjs documents, sequencing, permissions, proposals, and workspace commits.
- The relay generates a random `XXXXX-XXXXX` locator; a separate high-entropy invitation secret encrypts application payloads end to end.
- Each originating IP can host at most five active rooms.
- Viewers, editors, prompters, and reviewers are independent capabilities controlled by the host.
- Prompts from all participants execute through one FIFO queue.
- Every user works in a validated MultiCode-owned worktree; original checkouts are never switched, reset, stashed, or cleaned.
- Human edits are durably committed before broadcast. Multi-file Codex results are buffered and finalized as one logical workspace transaction.
- The public relay sees routing metadata and encrypted payload sizes, not source, prompts, agent output, previews, proposals, or checkpoint contents.

## Requirements

- [Node.js](https://nodejs.org/) 22.5 or newer (the session journal uses the built-in SQLite API in WAL mode)
- Hosting: Git, an authenticated Codex CLI, and a repository with at least one commit
- VS Code: version 1.96 or newer
- Joining: a clone containing the host's base commit; Codex is not required

## VS Code extension

Download the latest packaged extension from
[GitHub Releases](https://github.com/benitolinito/idkbro/releases/latest), or
build and install it from this checkout:

```bash
npm install
npm run build
npm run package -w multicode-vscode
code --install-extension apps/vscode/multicode-vscode-0.4.2.vsix
```

Reload VS Code after installation. Open the Command Palette with <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> or <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>, then use:

- **MultiCode: Host Room** — start Codex and open its isolated shared worktree in a new connected window without replacing the original checkout.
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

MultiCode creates isolated shared/agent worktrees, starts the host authority, connects outbound to the untrusted relay, and prints one complete invite token:

```text
Room token: K7MNP-4XQ2R.<room-secret>
```

Type prompts into the host terminal at any time.

### 2. Join the room

The other person pastes the complete token:

```bash
multicode join K7MNP-4XQ2R.<room-secret>
```

Both people can now edit normal VS Code buffers, submit prompts, see participant presence, and follow encrypted agent activity. Press <kbd>Ctrl</kbd>+<kbd>C</kbd> to leave or stop the room.

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
{ "ok": true, "rooms": 0, "uptimeSeconds": 12 }
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
Hosting from a MultiCode-managed `shared` or `agent` worktree is rejected to
prevent accidentally nesting one room inside another.

Participants receive an isolated room worktree. Bootstrap checkpoints are streamed from
the host in bounded 128 KiB chunks and verified by byte count, SHA-256 hash, Git
bundle verification, and expected commit before application. The relay retains
only checkpoint metadata, so a late joiner explicitly requests the current
bundle from the host.

A checkpoint never resets a dirty participant room worktree. Live document and manifest updates do not use Git resets. Preserve or export
those local changes first, then resynchronize. Leaving a room preserves its
worktree by default; remove a clean preserved worktree explicitly with
`multicode cleanup <room-id>`, or use `--force` only when its local changes may
be discarded.

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

| Package                     | Responsibility                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| `@multicode/cli`            | Host daemon/controller and authenticated thin-client commands                                     |
| `@multicode/protocol`       | Shared schemas and event types                                                                    |
| `@multicode/session-core`   | SQLite WAL journal, encrypted recovery snapshots, manifests, Yjs documents, and authenticated IPC |
| `@multicode/workspace`      | Safe worktrees, bootstrap checkpoints, B/A/H merges, proposals, and transactional application     |
| `@multicode/agent-adapters` | Codex app-server integration                                                                      |
| `@multicode/relay`          | Embedded and standalone WebSocket relays                                                          |
| `multicode-vscode`          | VS Code commands, session output, and status-bar controls                                         |

## Current limitations

- Only the Codex adapter is available, and only one Codex turn or pending proposal is allowed at a time.
- The host device must remain online. A transient host relay connection can resume, but rooms do not survive the host device being offline.
- Collaborative files must be regular UTF-8 files no larger than 96 KiB. Binary files and symlinks remain checkpoint/export-only.
- Undo uses normal VS Code behavior; MultiCode does not promise per-user CRDT undo.
- Conflict resolution is host-driven: reviewers inspect the encrypted proposal, manually resolve the shared files, then retry against the newest human state.
- Relay process restarts are not persisted as live WebSocket rooms; host-local authoritative state and acknowledged edits remain recoverable from SQLite.
