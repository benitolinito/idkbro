# MultiCode website

The marketing site is plain HTML, CSS, and JavaScript served by nginx.

## Run with Docker

From the repository root:

```bash
docker compose -f website/compose.yaml up --build
```

Open <http://localhost:8080>.

## Run without Docker

Serve the `website` directory with any static file server. For example:

```bash
python3 -m http.server 8080 --directory website
```
