# Load harness

Run from the repository root.

## Postgres and the server

```sh
docker run -d --name rchat-load-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55411:5432 postgres:16-alpine \
  -c shared_preload_libraries=pg_stat_statements -c shared_buffers=1GB
until docker exec rchat-load-pg pg_isready -U postgres -h 127.0.0.1; do sleep 1; done
docker exec rchat-load-pg psql -U postgres -c 'CREATE EXTENSION pg_stat_statements'
cargo build --release --bin server
DATABASE_URL=postgres://postgres:pw@127.0.0.1:55411/postgres SERVER_PORT=3411 PORT=3412 \
  APP_MODE=api-only TRUST_PROXY=true RATE_LIMIT_PER_SECOND=100000 RATE_LIMIT_BURST=100000 \
  target/release/server &
export SERVER_PID=$!
```

For `client.ts`, start the server with `APP_MODE=full` instead, and the web app on `PORT`:

```sh
bun run build
cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/
cp -r apps/web/public apps/web/.next/standalone/apps/web/
PORT=3412 HOST=127.0.0.1 bun run start &
```

## Seed

The password must be `load-pass-1`. Register `admin` first, then `pwref`.

```sh
for u in admin pwref; do
  curl -s -H 'Content-Type: application/json' http://127.0.0.1:3411/api/v1/auth/register \
    -d "{\"username\":\"$u\",\"password\":\"load-pass-1\",\"avatar_kind\":\"identicon\"}" >/dev/null
done
docker exec -i rchat-load-pg psql -U postgres < scripts/load/seed.sql
```

The last row shows users 5002, servers 201, messages 1000002 and wrong_counts 0.

## Scripts

```sh
mkdir -p "$HOME/rchat-load"
export BASE=http://127.0.0.1:3411 PG_CONTAINER=rchat-load-pg OUT="$HOME/rchat-load/results.txt"
bun scripts/load/run.ts
PHASES=storm,presence,send bun scripts/load/run.ts
bun scripts/load/join.ts
bun scripts/load/count.ts
bun scripts/load/perms.ts
bun scripts/load/mem.ts
bun scripts/load/client.ts
```

Run `mem.ts` against a freshly started server. `PHASES` with `presence` or `send` must have `storm` before them.

| Variable                   | Used by                        | Meaning                                                                                                                                                                      |
| -------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BASE`                     | all                            | Server address. Required.                                                                                                                                                    |
| `WS_BASE`                  | all                            | WebSocket address of the sockets. Default: `BASE` with `/api/v1/ws`. Set it to another copy for cross-copy delivery (sends and the presence phase's new users go to `BASE`). |
| `SERVER_PID`               | all                            | Server process, for its CPU and RSS. Required by `mem.ts`.                                                                                                                   |
| `PG_CONTAINER`             | `count.ts`, `perms.ts`         | Postgres container with `pg_stat_statements`. Required there.                                                                                                                |
| `OUT`                      | all                            | File the results are appended to. `client.ts` also saves screenshots next to it.                                                                                             |
| `PHASES`                   | `run.ts`                       | Comma list of `login`, `ready`, `storm`, `presence`, `send`, `members`, `search`, `unreads`. Default: all.                                                                   |
| `CONC`                     | `join.ts`                      | Concurrent joins. Default 200.                                                                                                                                               |
| `SOCKETS`                  | `run.ts`, `perms.ts`, `mem.ts` | Sockets to open. Default 1000.                                                                                                                                               |
| `FROM`                     | `mem.ts`                       | First user number. Default 2000 (light users); 1000 for users in 200 servers.                                                                                                |
| `VIEW`                     | `mem.ts`                       | Server the sockets view. Default none.                                                                                                                                       |
| `HOLD`                     | `mem.ts`                       | Seconds to keep the sockets open after measuring. Default 0.                                                                                                                 |
| `PLAYWRIGHT_BROWSERS_PATH` | `client.ts`                    | Where Chromium is. Default `~/.cache/ms-playwright`.                                                                                                                         |

## Upgrade check

```sh
bun scripts/load/upgrade.ts --old <old server binary> --new target/debug/server --db sqlite \
  --check "$HOME/rchat-load/check.sql"
bun scripts/load/upgrade.ts --old <old server binary> --new target/debug/server --db postgres \
  --pg-url postgres://postgres:pw@127.0.0.1:55411/postgres --check "$HOME/rchat-load/check.sql"
```

Statements in the check file end with `;` at the end of a line, optionally followed by a `--` comment.
More than one statement per line is rejected. Each must return at least one row, and the first column
of every row must be true.
