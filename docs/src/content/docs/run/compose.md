---
title: Docker Compose
description: The scaled example with containers per role behind nginx, Postgres and Valkey.
sidebar:
  order: 4
---

`deploy/compose.scale.yml` runs the server roles in containers of their own behind nginx, with one Postgres 16 and one Valkey (any Redis-protocol server works).

1. Put hex passwords in `deploy/.env` (`openssl rand -hex 24`). They go into connection URLs:

   ```sh
   POSTGRES_PASSWORD=...
   VALKEY_PASSWORD=...
   RCHAT_PUBLIC_URL=https://chat.example.com
   ```

2. Start it:

   ```sh
   docker compose -f deploy/compose.scale.yml up -d
   ```

3. Open http://localhost:8080. nginx publishes only this port (`RCHAT_HTTP_PORT`), and sends `/peerjs` to the `peerjs` container.

| Service                                                      | Role                                                                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `api`, `gateway`, `media`, `search`, `embeds`, `jobs`, `web` | Containers per role (`RCHAT_ROLES`); `api`, `gateway` and `web` start with two each. `web` also serves `/docs`.                |
| `peerjs`                                                     | The separate PeerJS server.                                                                                                    |
| `relay`                                                      | The STUN and TURN relay, only with `--profile relay` and `RCHAT_RELAY_ENABLED=true`. It publishes UDP 3478 and 49160 to 49415. |
| `nginx`                                                      | The proxy (`deploy/nginx.conf`).                                                                                               |
| `postgres`, `valkey`                                         | On the backend network only.                                                                                                   |

The services trust `X-Forwarded-For` only from the edge network (`RCHAT_EDGE_SUBNET`, 10.240.80.0/24 by default). These `RCHAT_` settings in `deploy/.env` reach the containers: `RCHAT_PUBLIC_URL`, `RCHAT_PUBLIC_PEERJS_URL`, `RCHAT_INSTANCE_NAME`, `RCHAT_ALLOWED_HOSTS`, `RCHAT_PUBLIC_STUN`, `RCHAT_RELAY_ENABLED`, `RCHAT_RELAY_HOST` and `RCHAT_RELAY_PUBLIC_IP`. `RCHAT_IMAGE` picks the image (`ghcr.io/robbyv2/rchat:weekly` by default).

Scale a role with `--scale`, for example `docker compose -f deploy/compose.scale.yml up -d --scale gateway=4`. See [Scaling](/docs/run/scaling/) for the roles.
