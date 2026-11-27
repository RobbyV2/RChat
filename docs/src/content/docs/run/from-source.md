---
title: Deploy from source
description: Production builds from the repository, an API-only server and the web app on its own.
sidebar:
  order: 2
---

## Full instance

```sh
just src prod
```

The recipe builds the WebAssembly module, the Next.js app (standalone), these docs and the release server binary, then starts:

- The Next.js server on `PORT` (3001), bound to `FRONTEND_HOST` (127.0.0.1).
- The separate PeerJS server from `deploy/peer`, only when the settings ask for one: `PEERJS_BUILTIN=false`, or `PEERJS_PORT`, `PUBLIC_PEERJS_URL`, `NEXT_PUBLIC_PEERJS_HOST` or `NEXT_PUBLIC_PEERJS_PORT` set.
- The Rust server on `SERVER_PORT` (3000) at `HOST`.

Open `http://<HOST>:<SERVER_PORT>`, by default http://localhost:3000. When nothing changed since the last build, the recipe asks whether to start that build again. `just src prod rebuild` always builds, and `just src prod reuse` starts the last build without asking. `DOCS_BUILD=off` skips the docs, and the server then answers `/docs` with a page saying they are not built.

`just src build-all` builds the same pieces without starting them, and `just src start-prod` starts the last build. The server binary is at `target/release/server`.

## API only

`APP_MODE=api-only` serves the API, realtime connections, P2P signaling and `/docs`, without the web app. `just src api` runs it from source. The release archives `rchat-server_<version>_<platform>` hold this binary for Linux, macOS and Windows as `rchat-server`, which takes the same commands as `server`.

## The web app alone

```sh
just src build-client
```

The client-only build lands in `apps/web/out/`. Serve it on any static host that answers unknown paths with `index.html`. People choose the instances they use when they open it. `just src client` builds and serves it at http://localhost:3000 (`PORT` changes the port).

`just src build-static https://api.example.com` builds the web app for one API-only instance at that address.
