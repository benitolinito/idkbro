# MultiCode website

The marketing site is plain HTML, CSS, and JavaScript served by nginx.

Test change verified September 1, 2026.

## Production deployment

The website and relay share `multicode.luisagd.com`. nginx serves the website
and forwards the relay's `/host`, `/rooms/*`, and `/health` routes over the
private Compose network.

From the repository root, start the existing MultiCode deployment:

```bash
docker compose -f deploy/compose.yaml up -d --build
```

The existing Cloudflare Tunnel target remains:

```text
http://localhost:7337
```

The public website is available at <https://multicode.luisagd.com/> and the
existing `wss://multicode.luisagd.com` relay URL continues to work.

## Run without Docker

Serve the `website` directory with any static file server. For example:

```bash
python3 -m http.server 18473 --directory website
```
