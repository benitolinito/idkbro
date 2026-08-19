# MultiCode

MultiCode is a CLI-first collaboration layer for local coding agents. This repository currently contains the first vertical slice: shared event schemas, Git repository/worktree safety, and a structured Codex app-server adapter.

## Development

```bash
npm install
npm run build
npm test
node packages/cli/dist/index.js doctor
```

Start a local Codex room from a Git repository:

```bash
node packages/cli/dist/index.js room create --agent codex --prompt "Summarize this repository"
```

The current milestone is intentionally local-only. The collaboration relay and browser room will consume the protocol introduced here.

