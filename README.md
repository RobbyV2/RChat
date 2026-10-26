<p align="center">
  <img src="assets/rchat_logo.png" alt="RChat" width="440">
</p>

<p align="center">
  <a href="https://github.com/RobbyV2/RChat/actions/workflows/ci.yml"><img src="https://github.com/RobbyV2/RChat/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/RobbyV2/RChat/pkgs/container/rchat"><img src="https://img.shields.io/badge/ghcr-nightly-4f46e5" alt="Nightly image"></a>
  <img src="https://img.shields.io/badge/Rust-axum-b7410e" alt="Rust">
  <img src="https://img.shields.io/badge/Next.js-16-black" alt="Next.js">
  <img src="https://img.shields.io/badge/storage-sqlite%20%7C%20postgres-336791" alt="Storage">
</p>

# RChat

Anonymous chat with a Discord-style layout and Google Material 3 dark theme. Servers, channels, and direct messages update live over a WebSocket. Everything runs locally; no external APIs, no telemetry, no email.

## Setup

Prerequisites: Rust (stable), Bun, wasm-pack, and the just command runner.

```bash
cp .env.local.example .env.local
just src install
just src dev
```

Fill out `.env.local` after renaming; the defaults work as-is for local development. Open http://localhost:3000. The first account registered becomes the hidden site admin.

Production: `just src prod`. API-only backend: `just src api`.

## Deployment modes

- Full (default): one Rust server on port 3000 serves `/api` and proxies everything else to the Next.js server. `just src prod`.
- Split: run the Rust API headless anywhere with `APP_MODE=api-only`, and deploy the frontend as a static site baked with that API's URL. The static bundle talks to the API over CORS and connects its WebSocket to the same host, so the two halves can live on different origins.

```bash
# on the API host (no UI, serves only /api)
APP_MODE=api-only just src api

# build the static frontend against that API (outputs to out/)
just src build-static https://api.your-host.com
# or preview it locally: just src static https://api.your-host.com
```

The static build inlines `NEXT_PUBLIC_API_URL`; every request and the WebSocket target it directly. `out/` is plain files for any static host (an `index.html` copy is written to `404.html` so deep links like `/s/rchat/1/` boot the app). Guest and public-server browsing work cross-origin; authenticated media loaded via `<img>` needs the API on the same site or a public server, since image tags cannot send the bearer token.

Docker (nightly image, published by CI and matching the `nightly` git tag):

```bash
docker run -p 3000:3000 -v rchat-data:/data ghcr.io/robbyv2/rchat:nightly
```

Or `docker compose up` to build locally.

## Scaling

The same image and binary run either as one process (everything above, the default) or as many processes sharing one Postgres, each serving a subset of service roles behind any HTTP load balancer that routes by path. Realtime state (presence, voice rooms, calls, P2P hosting) is shared through an optional Redis-protocol server: Redis, Valkey, KeyDB and Dragonfly all work.

```
                                 browsers
                                    |
    +-------------------------------+--------------------------------+
    |     HTTP load balancer (nginx, Ingress, ALB), routes by path     |
    +----+-----------+------------+-------------+-----------+----+---+
         |           |            |             |           |    |
      /api/ws      /api       /api/media   /api/search      /   /peerjs
         |           |            |             |           |    |
    gateway xN    api xN      media xN      search xN    web xN  peerjs x1
         |           |            |             |           |
         +-----------+------+-----+-------------+-----------+
                            |      embeds xN, jobs xN (no HTTP traffic)
                            |             |
             +--------------+-------------+
             |                            |
     Postgres (all data)        Valkey / Redis (realtime log, snapshot,
                                embed job queue, locks)
```

| Role      | Serves or runs                                                                    |
| --------- | --------------------------------------------------------------------------------- |
| `api`     | every `/api` REST route not listed below, plus Swagger                            |
| `gateway` | `/api/ws` (the WebSocket)                                                         |
| `media`   | `POST /api/media` uploads and `GET /api/media/{id}` downloads                     |
| `search`  | `/api/search` and `/api/server_search`                                            |
| `embeds`  | the URL unfurl worker                                                             |
| `jobs`    | the expired media sweeper, the stale row sweeper and the voice idle sweeper       |
| `web`     | proxies everything outside `/api` to the bundled Next.js server (`APP_MODE=full`) |

`RCHAT_ROLES` (or `--roles`) is `all` or a comma list such as `api,search`. When it is unset, `APP_MODE=full` means `all` and `APP_MODE=api-only` means every role except `web`. A list that runs only part of the backend (some but not all of `api`, `gateway`, `media`, `search`, `embeds`, `jobs`) means other processes run the rest, so such an instance refuses to start unless `REDIS_URL` and a Postgres `DATABASE_URL` are set; a `DATABASE_URL` or `REDIS_URL` that is set but empty is a startup error too, so a blank secret cannot silently fall back to sqlite or the in-process hub. Every instance answers `GET /api/health` (the process is up) and `GET /api/ready` (the database is reachable and, with `REDIS_URL`, the instance can both write to and read from the realtime bus and has caught up; 503 otherwise), both outside the rate limiter.

How the shared state works:

- Without `REDIS_URL` the hub stays in-process, exactly as in a single-node deployment. With it, every hub mutation (event broadcasts, presence, voice joins and leaves, calls, P2P hosting, the idle sweep, heartbeats) is appended to one Redis Stream (`{REDIS_PREFIX}:hub`, capped at about `REDIS_HUB_MAXLEN` entries, default 100000). Every instance replays that stream in order into its own copy of the realtime state, using the stream entry time as the clock, so all copies agree. Reads such as who is online or who is in a voice room stay local, and each instance delivers events to its own WebSocket connections with the usual per-connection filtering.
- Each instance numbers its own operations, and every copy only accepts increasing numbers. Once a later one of them has been applied, an earlier one that never showed up (a failed command in a pipeline, writes lost in a Redis failover) was applied nowhere and is reported as lost: whoever waited for it gets the fallback result, voice leaves and connection cleanup are posted again until they land, and the instance re-announces its connections' presence and P2P hosting, so no presence, voice or P2P ghosts are left behind. This, and an instance finding that the others purged it (it kept applying the stream, so its clients saw the purge), re-checks each connection's access but sends clients no `resync` hint, since no client event was lost. Lost broadcasts, forced offlines and voice evictions go to the instance's aftermath task, which checks each against the database and posts its current form again, in the original order, or drops it when it no longer holds: messages (with their link previews), resolved previews, call-log updates, channels, servers, admin flags, users and settings are re-read (a message deleted meanwhile is dropped, and one deleted while it is being posted again is followed by its deletion); a rename is dropped when the old name belongs to another server by now, a server deletion when the name was taken again, a ban when the account exists again, a join when the membership is gone, and a leave or kick when the user is a member again (the server's voice rooms are then re-checked against channel permissions instead); a lost P2P availability event skips the database check and is posted again at once, ahead of anything the instance posts after noticing the loss, unless the same instance already posted a later one for that hoster, so the newest one still lands last. Heartbeats bound the detection to about 5 seconds. The state snapshots record which numbers were skipped, so an instance that restores one tells its applied operations from its lost ones the same way.
- Appear offline holds cluster-wide: changing it broadcasts a `presence_mode` event over the bus, and every connection of that account, on whichever gateway, withdraws or restores its own presence; a connection that re-checks its access also re-reads the setting. Kicks, bans and server password changes that remove members go out as ordered bus events followed by a forced offline, so every gateway updates its connections' access, presence and voice rooms in the same order. An account password change revokes the account's other login tokens and broadcasts a `tokens_revoked` event over the bus; each connection of that account, on any gateway, checks its own token and closes when it is gone (a connection that missed the event finds out at its next access re-check, which also checks the token). When the database cannot answer that check, the connection fails closed: it is held back as described below and closed after 30 seconds unless a retry confirms the token.
- Instances heartbeat every 5 seconds. One that is silent for 30 seconds is purged: its users go offline, its voice occupants leave, its calls end and their call logs are finalized. A graceful shutdown (SIGTERM) removes its state immediately.
- A starting instance loads the latest state snapshot (`{REDIS_PREFIX}:hub:snapshot`, refreshed every 5 seconds by one instance) and replays the stream from there. It reports not ready and refuses WebSocket upgrades until it has caught up.
- An instance whose read position is no longer in the stream (it fell more than `REDIS_HUB_MAXLEN` entries behind and was trimmed past, or a failover lost entries) re-bootstraps from the newest snapshot the stream still covers, waiting up to 30 seconds for one before it replays what is left. Meanwhile it reports not ready and never writes a snapshot. If the stream was reset instead (Redis restarted without persistence), it keeps its state and continues at once, delivering everything written since the reset to its clients. After either, every connection re-checks its access (account, memberships, subscriptions, guest access, appear-offline setting) before re-announcing its presence, as it does when it falls behind its local event queue, and then sends its client the same `resync` hint, so the client reloads what it may have missed; if the database is unreachable at that moment, the connection stays open but is held back: it gets no server, channel or account-scoped events (no DMs, calls, signalling or events about the account itself, and P2P lookups and voice or call requests other than leaving are refused; only events every client gets, such as public profile updates, still arrive) while it retries with backoff (2 seconds, doubling; further errors before the next retry do not push it back), does not re-announce presence or P2P hosting until a retry succeeds, gets a `resync` hint once it does, and after 30 seconds of failures it is closed so the client reconnects and authenticates again (a connection whose account cannot be loaded is refused rather than treated as a guest). A connection follows a server rename only after the database confirms its membership in, or access to, the new name; when a server is created or renamed under a name the connection still holds (because it missed a rename or deletion of the server that had it), the connection checks that name against the database and reloads its access if the check fails. A rename whose new name no longer exists is followed as is, so a quick second rename still finds the server. Database errors during these checks hold the connection back the same way instead of dropping the server. Channel events are only delivered when the channel belongs to the server the event names, so an event or voice room still labelled with a reused name cannot reach the new server's members. However many connections hit one of these database errors, each kind is logged once and then summarized with a count at most every 10 seconds.
- With `REDIS_URL`, an instance without the `embeds` role queues URL unfurls on a Redis Stream consumer group (`{REDIS_PREFIX}:embeds`), which `embeds` instances work through; jobs left unacknowledged for 60 seconds are reclaimed, and a job delivered 3 times without success is dropped with a warning. Workers remove consumers that have been idle for 10 minutes with nothing pending (each process registers a new one). Without Redis, or on an instance with the role, unfurling runs inline as before. Run at least one `embeds` and one `jobs` instance.
- Each media sweep and stale row sweep tick takes a Redis `SET NX PX` lock, so several `jobs` instances are safe; the voice idle sweep is itself an ordered bus operation, so duplicates are harmless.
- The WebSocket server pings every 30 seconds so load balancer idle timeouts do not cut connections, and drops a connection that has been silent for 90 seconds. No sticky sessions are needed.

Reference deployments:

- `deploy/compose.scale.yml`: postgres, valkey, api x2, gateway x2, media, search, embeds, jobs, web x2, peerjs and nginx, with the path routing and edge rate limits in `deploy/nginx.conf`. nginx shares the `edge` network (fixed subnet `RCHAT_EDGE_SUBNET`, default `10.240.80.0/24`; change it if it overlaps a local network) only with the services it proxies to, which trust forwarded headers from that subnet (`TRUSTED_PROXIES`); Postgres, Valkey, embeds and jobs are only on the `backend` network. Run `VALKEY_PASSWORD=$(openssl rand -hex 24) docker compose -f deploy/compose.scale.yml up -d` (or put `VALKEY_PASSWORD` in `deploy/.env`) and open http://localhost:8080 (`RCHAT_HTTP_PORT`; set `RCHAT_IMAGE` to use a locally built image).
- `deploy/k8s/`: a kustomize base with a Deployment and Service per role, password-protected Valkey with a NetworkPolicy, PeerJS, an Ingress with the same routing plus rate-limited `rchat-strict` and `rchat-invites` Ingresses, HPAs for api, gateway and web, and a ConfigMap and Secret. Copy `deploy/k8s/secrets.env.example` to `deploy/k8s/secrets.env` (gitignored), fill in `DATABASE_URL`, a strong `VALKEY_PASSWORD` (`openssl rand -hex 32`) and the matching `REDIS_URL`, then run `kubectl apply -k deploy/k8s`; a secretGenerator turns the file into `rchat-secrets`. Nothing ships a default password: kustomize refuses to build without the file, the role pods do not start without both URLs (missing or empty), and Valkey refuses an empty password. Replace the `TRUSTED_PROXIES` placeholder in `deploy/k8s/config.yaml` with the address range the ingress controller's pods use (usually the cluster pod CIDR; the node range if the controller runs with `hostNetwork`); the pods refuse to start until you do. `deploy/k8s/networkpolicy.yaml` admits only the ingress controller to the RChat pods (the roles never call each other; adjust its namespace and pod selectors if the controller is not a standard ingress-nginx install), so trusting the pod range trusts only the controller; like the Valkey policy it needs a CNI that enforces NetworkPolicy. Behind an L7 cloud balancer, configure the ingress-nginx controller as in `deploy/k8s/ingress-nginx.example.yaml` (see the client address note below).
- The image's start script launches only what the roles need: Next.js only with `web` (or `all`), the PeerServer only when the roles are unset or `all` (override with `RCHAT_PEERJS=on|off`), and `/app/start.sh peer` runs the PeerServer alone. It forwards SIGTERM so the server shuts down gracefully. `docker run ghcr.io/robbyv2/rchat:nightly` still runs everything in one container.
- Frontend: the Next.js standalone servers are stateless, so run any number behind the balancer, or serve the static export from a CDN. `NEXT_PUBLIC_API_URL` points REST at the API origin, `NEXT_PUBLIC_WS_URL` points the WebSocket at a gateway on another origin, and `NEXT_PUBLIC_PEERJS_HOST` and `NEXT_PUBLIC_PEERJS_PORT` locate the PeerServer. They are baked in at build time, e.g. `docker build --build-arg NEXT_PUBLIC_PEERJS_PORT=443 .` when `/peerjs` is routed through the balancer on 443.
- The PeerServer keeps its registry in memory, so run exactly one.

Database:

- Multiple instances need Postgres. sqlite stays supported for single-node deployments only.
- Instances can boot at the same time: schema creation, column reconciliation and seeding run in one transaction under a Postgres advisory lock.
- Pool: `DATABASE_MAX_CONNECTIONS` (default 8 for Postgres, 1 for sqlite), `DATABASE_MIN_CONNECTIONS`, `DATABASE_ACQUIRE_TIMEOUT_SECS`. On sqlite that single connection is the only writer; reads (GET endpoints and auth) go to a separate read-only WAL pool of `DATABASE_READ_CONNECTIONS` connections (default: CPU count clamped to 2-8, `0` sends reads to the writer), so a long write no longer blocks readers. Keep instances x max connections under the server's `max_connections`, or put PgBouncer in between.
- Any Postgres-wire endpoint works: managed services (RDS and Aurora, Cloud SQL, Azure Database for PostgreSQL, Neon, Supabase) or an HA cluster behind a proxy (Patroni, Stolon or CloudNativePG behind HAProxy or PgBouncer, the Postgres counterpart of GitHub's MySQL `orchestrator` setup).
- PgBouncer session pooling works as is. Transaction pooling works with PgBouncer 1.21 or newer and `max_prepared_statements` above 0 (the default since 1.24 is 200), because sqlx always uses named prepared statements. `statement-cache-capacity=0` in the URL does not help: sqlx, through the Any driver too, still names every statement and only stops caching them, so transaction pooling fails with `prepared statement "sqlx_s_1" already exists`. Verified against PgBouncer 1.26.

The realtime bus is trusted: anything that can write to it can inject events to every client and rewrite presence, voice and call state. Keep it private and authenticated. Put the credentials in `REDIS_URL` (`redis://:password@host:6379` for `requirepass`, `redis://user:password@host:6379` for an ACL user; percent-encode special characters). TLS (`rediss://`) is not supported yet, so the Redis server must only be reachable over a private network. The compose file requires `VALKEY_PASSWORD` and never publishes Valkey on the host; the k8s base requires the Secret's `VALKEY_PASSWORD` and adds a NetworkPolicy that only admits the role pods to `rchat-valkey:6379` (it takes effect only with a CNI that enforces NetworkPolicy). Postgres is external to the k8s base, so restrict it on its side (security groups, `pg_hba.conf`).

What stays per instance: rate limit buckets (tower_governor keeps them in memory), the per-connection channel visibility cache, and inline unfurls in flight. The in-process limiter therefore allows N instances about N times its limit; the cluster-wide limit belongs at the edge. `deploy/nginx.conf` applies the strict backend limit (2 requests/s, burst 30, per client address, one bucket shared by the routes) to `/api/auth/`, `POST /api/me/password`, `POST /api/media` and `/api/servers/{name}/guest_access` with `limit_req`, plus the same limit in a bucket of its own to `/api/invites/` (the backends keep invite lookups in a separate bucket too, so invite cards cannot starve logins or uploads), and the k8s `rchat-strict` and `rchat-invites` Ingresses do the same with ingress-nginx `limit-rps` annotations (counted per controller pod). The per-username login throttle (3 seconds between attempts, lock after 1000 a day) lives in the database and is already shared by all instances.

Behind a load balancer, tell the instances which peers are proxies so rate limiting keys on the client address instead of the proxy's. `TRUSTED_PROXIES` (a comma list of IP addresses and CIDR ranges) is the safe way and what the reference deployments use. Forwarded headers (`X-Forwarded-For`, else `X-Real-IP`, else `Forwarded`) are honoured only when the TCP peer is in the list, so every trusted proxy must set `X-Forwarded-For` itself (overwrite it or append its peer address): one that only sets `X-Real-IP` or `Forwarded` while passing a client's `X-Forwarded-For` through lets the client pick its own key. The client is the right-most `X-Forwarded-For` hop that is not itself a trusted proxy, the rule of Express `trust proxy` with a list or Rails `trusted_proxies`. Entries a client wrote further left never matter, so proxies that append (nginx `$proxy_add_x_forwarded_for`, ingress-nginx `compute-full-forwarded-for`, HAProxy `option forwardfor`, cloud L7 balancers) are fine as long as each hop up to the first untrusted one is listed; a malformed hop ends the walk at the trusted proxy that sent it. Every other peer is keyed by its own address, and the first request from such a peer that carries forwarded headers is logged once, which usually means the list misses a proxy. `TRUST_PROXY=true` is the all-or-nothing alternative: it trusts any peer, so the client becomes the left-most hop. Use it only when the instances are unreachable except through a proxy that overwrites `X-Forwarded-For` with the client address (nginx `proxy_set_header X-Forwarded-For $remote_addr`, as `deploy/nginx.conf` does, or ingress-nginx with its defaults); `TRUSTED_PROXIES` wins when both are set. For ingress-nginx behind an L7 cloud balancer, set `use-forwarded-headers` together with `proxy-real-ip-cidr` (its default `0.0.0.0/0` trusts every hop and hands the controller the client-written entry; see `deploy/k8s/ingress-nginx.example.yaml`). The edge limits in `deploy/nginx.conf` key on nginx's peer address, so behind another balancer configure nginx's `real_ip_header`/`set_real_ip_from` for it first.

Scaling variables: `RCHAT_ROLES`, `REDIS_URL` (`redis://` with credentials; TLS `rediss://` is not supported yet, so keep Redis on a private network), `REDIS_PREFIX` (default `rchat`, lets deployments share one Redis), `REDIS_HUB_MAXLEN` (approximate cap of the realtime stream, default 100000, at least 1000; an instance that falls further behind re-bootstraps from a snapshot; set the same value on every instance and change it cluster-wide, because instances use it to tell a trimmed stream from a reset one), `TRUSTED_PROXIES`, `TRUST_PROXY`, `DATABASE_MAX_CONNECTIONS`, `DATABASE_MIN_CONNECTIONS`, `DATABASE_ACQUIRE_TIMEOUT_SECS`, `RCHAT_PEERJS` (start script), `RCHAT_EDGE_SUBNET` (compose file), and the build-time `NEXT_PUBLIC_WS_URL`, `NEXT_PUBLIC_PEERJS_HOST`, `NEXT_PUBLIC_PEERJS_PORT`. During a rolling upgrade that adds realtime event types, older instances skip bus entries they cannot parse and log a warning.

## Architecture

- `src/` is a Rust axum server on port 3000. It serves everything under `/api` and proxies all other paths to the Next.js dev or standalone server on port 3001.
- `app/` is a Next.js 16 app router frontend with Tailwind 4, zustand for state, react-markdown for message rendering, and lucide-react icons. Material 3 color tokens live as CSS variables in `app/globals.css`.
- Storage is sqlx over sqlite or postgres, selected by `DATABASE_URL`: a `postgres://` URL uses postgres, anything else is treated as a sqlite file path (WAL mode), default `rchat.db`. Users, tokens, servers, channels, members, messages, and media blobs all live in the database. MongoDB is not supported (no single Rust library covers it alongside SQL backends).
- `/api/ws` is a broadcast hub. Handlers write to the database, then broadcast typed events (messages, channel and server changes, membership, presence, bans, media removal). Each connection filters events to its member servers, guest subscriptions, and DMs.
- Presence is per server: a user is online only in the single server they are currently viewing.
- Rate limiting is per IP via tower_governor across `/api`, with a stricter layer on auth and media routes. A 60 second background task sweeps expired media in batches, and every 10 minutes the jobs role deletes guest grants unused for `GUEST_GRANT_DAYS` (default 30), login throttle rows older than 2 days and link previews older than `EMBED_CACHE_DAYS` (default 30) that no message uses.
- Profanity filtering (rustrict) runs server-side on usernames, server display names, channel names, and channel messages. DMs and passwords are exempt.
- The `wasm/` crate and `jfiles/` recipes are retained template infrastructure.

## Deliberate non-industry choices

These are intentional per the project spec. Site-level protections exist (per-IP rate limits, server-side validation); user-level protections are deliberately loose.

- No password rules. Any non-empty password is accepted, including a single character. There is no strength meter and no minimum length.
- Deterministic word passwords. As an alternative to text passwords, each username maps to a fixed set of 20 words: sha256 of the lowercase username seeds a ChaCha8 RNG that samples the `memorable-wordlist` crate. The user picks 7 of those 20 in order. Anyone can request any username's word set at `GET /api/auth/words/{username}`; the secret is the ordered selection, not the set.
- Unlimited but throttled logins. There is no attempt cap and no lockout on failures. Per username: attempts must be 3 seconds apart, and more than 1000 attempts in one day lock the account until the next day.
- Anonymous accounts. No email, no phone, no recovery flow. Usernames accept any characters. A lost password means a lost account.
- Unencrypted single sqlite file by default. All data, including uploaded file blobs, lives in one unencrypted `.db` file (or a postgres database via `DATABASE_URL`). Anyone with the file has everything.
- Public identifiers. Lowercased usernames are user IDs. Lowercased server names are server IDs and also the invite codes; knowing a server's name is sufficient to join or view it.
- Hidden site admins. The first registered account is the site admin. No badge or indicator reveals this anywhere; admin-only routes return 404 rather than 403 to non-admins so the panel's existence stays hidden.
- One-day media retention. Uploads are capped at 25MB and deleted exactly one day after posting. The message remains and renders a notice that the file was removed.
- Guest read-only access. A "Skip to RChat" button on the login page enters a guest mode with no account. Guests can view any server by name (their server list is kept in localStorage), receive live updates, and cannot send messages or appear in presence.
- Non-expiring tokens. Login tokens are random 32-byte values that never expire; they end only when revoked: a password change signs out the account's other sessions, and deleting or banning the account removes all of them. Guest grants (the token a guest gets after entering a server password) expire after `GUEST_GRANT_DAYS` (default 30) days unused; each use slides the window, and the stored last-use time is refreshed at most once a day per grant.

## Configuration

Environment variables, loaded from `.env.local` and `.env` (see `.env.local.example`): `APP_MODE` (full or api-only), `RCHAT_ROLES`, `REDIS_URL`, `REDIS_PREFIX`, `REDIS_HUB_MAXLEN`, `TRUSTED_PROXIES`, `TRUST_PROXY`, `DATABASE_MAX_CONNECTIONS`, `DATABASE_MIN_CONNECTIONS`, `DATABASE_ACQUIRE_TIMEOUT_SECS`, `DATABASE_READ_CONNECTIONS` (see Scaling), `GUEST_GRANT_DAYS`, `EMBED_CACHE_DAYS`, `VOICE_IDLE_SECS`, `VOICE_ROOM_MAX` (most people in one voice channel, default 25, 0 = no limit), `HOST`, `SERVER_PORT`, `PORT`, `DATABASE_URL`, `RATE_LIMIT_PER_SECOND`, `RATE_LIMIT_BURST`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION` (optional, default us-east-1; setting the other four S3 vars stores media blobs in the S3-compatible bucket at `media/{id}` instead of the database, path-style so minio works).
