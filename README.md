# Proxy Tunnel Logger

A lightweight Bun full-stack HTTP forward proxy and passthrough `CONNECT` tunnel logger with JSONL persistence and a real-time web inspector.

## Features

- **Forward HTTP Proxy** (`PROXY_PORT`, default `8080`): Streams requests and responses byte-for-byte (`decompress: false`, `redirect: "manual"`), strips hop-by-hop headers, and supports incremental SSE / chunked streaming without buffering.
- **Passthrough HTTPS / TCP `CONNECT` Tunnel**: No MITM or custom CA required. Logs target `host:port`, duration, status, and bidirectional byte counts (`bytesUp` / `bytesDown`).
- **Optional Reverse Proxy Mode**: Set `UPSTREAM=https://api.example.com` to forward origin-form requests to a fixed upstream.
- **JSONL Persistence**: Append-only serialized `logs.jsonl` with no retention limit. Text payloads are stored as `utf8`; binary/compressed payloads are stored raw as `base64`.
- **Full-Stack Web UI** (`UI_PORT`, default `3000`): Served via Bun HTML imports with live SSE updates, newest-first pagination, search/status filtering, unredacted headers, server-side `gzip`/`deflate`/`br`/`zstd` decompression for display, parsed SSE event timeline, and JSONL export.

## Configuration

| Variable | Local Default | Docker Default | Description |
| --- | --- | --- | --- |
| `PROXY_HOST` | `127.0.0.1` | `0.0.0.0` | Proxy listen address |
| `PROXY_PORT` | `8080` | `8080` | Proxy listen port |
| `UI_HOST` | `127.0.0.1` | `0.0.0.0` | Web UI listen address |
| `UI_PORT` | `3000` | `3000` | Web UI listen port |
| `DATA_DIR` | `./data` | `/data` | Directory containing `logs.jsonl` |
| `MAX_BODY_BYTES` | `10485760` (10 MiB) | `10485760` (10 MiB) | Per-body capture cap in JSONL (`0` = unlimited) |
| `UPSTREAM` | unset | unset | Optional reverse-proxy target origin |

## Run Locally

```bash
bun install
cp .env.example .env # optional: customize ports or DATA_DIR
bun run start
```

Test with `curl`:

```bash
curl -x http://127.0.0.1:8080 http://httpbin.org/get
curl -x http://127.0.0.1:8080 https://example.com
```

Open the Web UI at `http://127.0.0.1:3000`.

## Build & Run with Docker

Pull from GHCR (published via GitHub Actions on `main` and `v*` tags):

```bash
docker run --rm -p 8080:8080 -p 3000:3000 -v "$(pwd)/data:/data" ghcr.io/finleyge/proxy-tunnel-logger:latest
```

Or build locally:

```bash
docker build -t proxy-tunnel-logger .
docker run --rm -p 8080:8080 -p 3000:3000 -v "$(pwd)/data:/data" proxy-tunnel-logger
```
