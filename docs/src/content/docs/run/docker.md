---
title: Docker
description: The server image, its tags, volume, ports and build arguments.
sidebar:
  order: 3
---

```sh
docker run -p 3000:3000 -v rchat-data:/data ghcr.io/robbyv2/rchat:latest
```

Open http://localhost:3000. `latest` is the newest stable release and `weekly` the newest weekly build. The image holds the server, the web app, these docs and the separate PeerJS server, and runs as user 10001.

| Setting in the image | Value                                    |
| -------------------- | ---------------------------------------- |
| `APP_MODE`           | `full`                                   |
| `HOST`               | `0.0.0.0`                                |
| `SERVER_PORT`        | `3000`, the published port               |
| `PORT`               | `3001`, the web app inside the container |
| `DATABASE_URL`       | `/data/rchat.db`, in the volume          |

Pass other settings with `-e NAME=value`. The health check calls `/api/health`. The image also exposes UDP 3478 and 49160 to 49415 for the built-in relay, which stays off unless `RELAY_ENABLED` is on.

An account from the command line, also while the container runs:

```sh
docker exec <container> /app/server user create <name>
```

A data volume that belongs to root stops the container at start, and the log prints the `chown` command that fixes it once.

## Building the image

`docker compose up` builds the image from the repository (`docker-compose.yml`) and starts it on port 3000. `just src docker` builds it as `rchat`. Build arguments:

| Argument                                             | Effect                                                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `DOCS_BUILD=off`                                     | Leaves these docs out of the image. `/docs` then answers with a page saying they are not built. |
| `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL`          | Build the web app for an API on another address.                                                |
| `NEXT_PUBLIC_PEERJS_HOST`, `NEXT_PUBLIC_PEERJS_PORT` | Build the web app for a separate PeerJS server, which the container then starts too.            |
