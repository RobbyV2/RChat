# Working on RChat

Rules for agents changing this repo (local file, not in git). They bind every change. The product rules and P2P rules are in `README.md` ("Product rules"); they bind too.

## Layout

- `apps/server`: Rust axum server. Schema in `src/db/schema.rs` and `src/db/migrate.rs`, WS hub `src/ws/`, REST in `src/api/` (OpenAPI registry `src/api/openapi.rs`, access gate `src/api/access.rs`).
- `apps/web`: Next.js 16 client. Zustand store `app/lib/store.ts`, API client `app/lib/api.ts`, theme tokens `app/globals.css`, platform adapters `app/lib/platform/` (web, desktop, mobile).
- `crates/wasm`: shared Rust compiled to WebAssembly for the client.
- `apps/desktop/src-tauri`: Tauri shell for desktop and mobile.
- Untracked workflow state of a running agent session may live in `.superpowers/` (listed in `.git/info/exclude`). Never commit it.

## Commits and branches

- One commit per feature or fix. The message is a few-word title (for example `Staff hiding`), with no body, no trailers and no `Co-Authored-By` or other attribution lines.
- Only `main`, with linear history. Don't leave side branches or worktrees behind. Temporary worktrees go on persistent disk, never `/tmp`.
- Push each tested, reviewed commit to `origin main` (owner's rule). Never force-push, never tag unless asked.

## Gates (all must pass before a commit)

```
cargo fmt --all
cargo clippy --all-targets -- -D warnings
cargo test
bunx eslint . --ignore-pattern '.superpowers/**'
bun test scripts
cd apps/web && bun test app
bunx prettier --write <changed files>
bunx prettier --check "**/*.{ts,tsx,js,jsx,json,md,mjs}" --ignore-path .gitignore --ignore-path .prettierignore --ignore-path .git/info/exclude
bun run build
```

Build output goes where the machine's own user-level instructions say. Without such instructions, use the defaults (`target/`, `apps/web/.next`).

## Code style

- Match the surrounding code. Almost no comments. Rust uses exhaustive destructuring and `match`. TypeScript uses small functional components with zustand selectors.
- Tailwind with the Material 3 color tokens from `globals.css` (`bg-surface-container-high`, `text-on-surface-variant`, ...). Light and dark themes must both look right, and mobile must work.
- New logic gets unit tests:
  - Rust: `#[tokio::test]` with `temp_state` from `apps/server/src/api/mod.rs`.
  - Web: pure logic in `apps/web/app/lib/*.ts`, with tests in `app/lib/__tests__/`.
- UI changes are also checked in a real browser at desktop 1280x800 and mobile 390x844, in dark and light. Multi-user features get a two-account test.

## Database and migrations

- Every schema change goes into both `SQLITE_SCHEMA` and `POSTGRES_SCHEMA`. New columns on existing tables also go into `MIGRATIONS`, with `BACKFILLS` when old rows need values. Use `$1` placeholders.
- Create indexes on new columns only after the columns are reconciled. Never drop or rename columns or tables, and never rewrite existing data destructively.
- Each schema change gets a Rust test that starts from the old schema with data, runs the real init twice, and checks the new columns, their defaults and the old rows.
- It also gets a real upgrade check on both SQLite and Postgres: run the previous build, create data, then start the new build on the same databases.

## API

- New REST endpoints get `#[utoipa::path]` with `///` docs and are registered in `openapi.rs`.
- Every endpoint that touches a server, channel or message resolves access only through the access gate. Denials are uniform 404s.
- API text is plain ASCII: OpenAPI docs, error messages, and server-generated strings in responses and WS payloads.

## Docs

- Docs (README, CLAUDE.md, env example comments) keep only what the reader needs to use, set up, run or deploy the app: versions, paths, commands, settings, limits, defaults.
- Cut reasons, consequences, implementation details, edge cases, history and side notes, unless the reader needs them to act or to avoid a mistake.

## Product copy

- UI copy is short and plain: no em dashes. The app never names itself, except in onboarding.

## Running locally

- Copy `.env.local.example` to `.env.local` (APP_MODE=full; the Rust server on `SERVER_PORT` proxies to Next on `PORT`).
- Start `cargo run --bin server` and `bun run dev` with your own `SERVER_PORT`, `PORT` and `DATABASE_URL` set in the command.
- Stop only the processes you started, by PID. Never use `pkill -f` or `killall` patterns.
