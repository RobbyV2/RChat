import "../common.just"

# Full mode (default)

# Run full-stack development (Rust proxy + Next.js dev)
dev:
  #!/usr/bin/env bash
  set -euo pipefail
  cd "{{ROOT}}"
  echo "Building WASM (dev)..."
  wasm-pack build crates/wasm --target web --out-dir ../../apps/web/public/wasm --dev
  trap 'kill 0' SIGINT
  {{DOTENVX}} bash -c 'FRONTEND_HOST=${FRONTEND_HOST:-127.0.0.1} exec bun run dev' 2>&1 | sed 's/^/[WEB] /' &
  {{DOTENVX}} bash -c 'bunx peer --port "${PEERJS_PORT:-9001}" --path /peerjs 2>&1 | { case "${RUST_LOG:-info}" in *debug*|*trace*) cat ;; *) grep --line-buffered -vE "Client (dis)?connected:" ;; esac; }' | sed 's/^/[PEER] /' &
  sleep 2
  {{DOTENVX}} cargo run --bin server 2>&1 | sed 's/^/[RUST] /' &
  wait

# Run full-stack production
prod:
  #!/usr/bin/env bash
  set -euo pipefail
  cd "{{ROOT}}"
  echo "Building WASM..."
  wasm-pack build crates/wasm --target web --out-dir ../../apps/web/public/wasm --release
  echo "Building frontend..."
  {{DOTENVX}} bun run build
  cp -r apps/web/public apps/web/.next/standalone/apps/web/ 2>/dev/null || true
  cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/ 2>/dev/null || true
  echo "Building backend..."
  cargo build --release --bin server
  echo "Starting servers..."
  trap 'kill 0' SIGINT
  {{DOTENVX}} bash -c 'HOSTNAME=${FRONTEND_HOST:-127.0.0.1} exec bun ./apps/web/.next/standalone/apps/web/server.js' 2>&1 | sed 's/^/[WEB] /' &
  {{DOTENVX}} bash -c 'bunx peer --port "${PEERJS_PORT:-9001}" --path /peerjs 2>&1 | { case "${RUST_LOG:-info}" in *debug*|*trace*) cat ;; *) grep --line-buffered -vE "Client (dis)?connected:" ;; esac; }' | sed 's/^/[PEER] /' &
  sleep 2
  {{DOTENVX}} ./target/release/server 2>&1 | sed 's/^/[RUST] /' &
  wait

# API-only mode

# Run API-only development (Rust API server only)
api:
  cd {{ROOT}} && APP_MODE=api-only {{DOTENVX}} cargo run --bin server

# Run API server in release mode
api-release:
  cd {{ROOT}} && APP_MODE=api-only {{DOTENVX}} cargo run --bin server --release

# Frontend only

# Run Next.js dev server only
frontend:
  cd {{ROOT}} && APP_MODE=api-only {{DOTENVX}} bun run dev

# Run Next.js production server
frontend-prod:
  cd {{ROOT}} && {{DOTENVX}} bun run start

# Static mode: frontend only, with a remote api-only server

# Preview the static build locally against a remote API.
# Usage: just src static https://api.example.com
static api_url:
  #!/usr/bin/env bash
  set -euo pipefail
  cd "{{ROOT}}"
  STATIC_EXPORT=true NEXT_PUBLIC_API_URL={{api_url}} bun run build
  cp apps/web/out/index.html apps/web/out/404.html
  echo "Serving apps/web/out/ at http://localhost:{{env_var_or_default('PORT', '3001')}} (API: {{api_url}})"
  bunx serve apps/web/out -l {{env_var_or_default('PORT', '3001')}} -s

# Run production (assumes already built)
start-prod:
  #!/usr/bin/env bash
  cd "{{ROOT}}"
  trap 'kill 0' SIGINT
  {{DOTENVX}} bash -c 'HOSTNAME=${FRONTEND_HOST:-127.0.0.1} exec bun ./apps/web/.next/standalone/apps/web/server.js' 2>&1 | sed 's/^/[WEB] /' &
  sleep 2
  {{DOTENVX}} ./target/release/server 2>&1 | sed 's/^/[RUST] /' &
  wait
