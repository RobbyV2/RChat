---
title: Scaling
description: Server roles, Redis, Postgres pools and read replicas for instances with more load.
sidebar:
  order: 10
---

One process with all roles fits most instances. For more load, run several copies of the same image or binary on one Postgres database and one Redis server, and split the work with roles. Both examples, [Docker Compose](/docs/run/compose/) and [Kubernetes](/docs/run/kubernetes/), are set up this way.

## Roles

`RCHAT_ROLES` (or `--roles`) is `all` or a comma list. Without it, `APP_MODE=full` runs every role and `APP_MODE=api-only` every role except `web`.

| Role      | Serves                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------ |
| `api`     | The REST API, SCIM, `/.well-known` and `/docs`.                                                              |
| `gateway` | Realtime connections at `/api/v1/ws`.                                                                        |
| `media`   | Uploads and downloads at `/api/v1/media`.                                                                    |
| `search`  | Message and server search.                                                                                   |
| `embeds`  | Link preview fetches.                                                                                        |
| `jobs`    | Background work: sweeps of expired files and sessions, resumed deletions, voice timeouts, outgoing webhooks. |
| `web`     | The web app (through the Next.js server) and `/docs`.                                                        |
| `relay`   | The STUN and TURN relay, when `RELAY_ENABLED` is on.                                                         |
| `sfu`     | The media server for calls, when `SFU_ENABLED` is on.                                                        |

A process that runs only part of the backend refuses to start unless `DATABASE_URL` is Postgres and `REDIS_URL` is set. `/api/v1/health` and `/api/v1/ready` answer on every role.

## Shared state

- `REDIS_URL` carries realtime events between copies, and makes message rates, friend requests, invite previews and joins count across them. Use a password and a private network: the server connects to Redis without TLS.
- P2P signaling at `/peerjs` is per process. With several copies, set `PEERJS_BUILTIN=false` on all of them and send `/peerjs` to one separate PeerJS server (`deploy/peer`).
- Start every copy with the same settings, and upgrade all copies together.
- With `WS_SOCKETS_MAX` set, run the `gateway` role on copies of its own: a copy that holds that many connections answers `/api/v1/ready` with 503.

## Postgres

Every copy has its own pool (`DATABASE_MAX_CONNECTIONS`, two per core from 8 to 32 by default). Keep Postgres `max_connections` above the sum of the pools plus room for maintenance. Site administration → Config shows this copy's pools and index builds.

`DATABASE_REPLICA_URLS` lists streaming replicas (up to 16) for the copies that serve searches and older pages. Give each replica a replication slot and at least the primary's `max_connections`, and drop its slot when you retire it. `DATABASE_REPLICA_MAX_LAG_MS` (2000) is the largest replay delay at which a copy still reads from a replica.

Large installations keep uploads in S3 (see [Database and file storage](/docs/run/storage/)).
