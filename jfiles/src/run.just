import "../common.just"

# Full mode (default)

# Run full-stack development (Rust proxy + Next.js dev)
dev: deps
  #!/usr/bin/env bash
  set -euo pipefail
  cd "{{ROOT}}"
  echo "Building WASM (dev)..."
  wasm-pack build crates/wasm --mode no-install --target web --out-dir ../../apps/web/public/wasm --dev
  trap 'kill 0' SIGINT
  {{DOTENVX}} bash -c 'FRONTEND_HOST=${FRONTEND_HOST:-127.0.0.1} exec bun run dev' 2>&1 | sed 's/^/[WEB] /' &
  {{DOTENVX}} bash -c 'bun deploy/peer/server.mjs --wanted && exec bun deploy/peer/server.mjs' 2>&1 | sed 's/^/[PEER] /' &
  sleep 2
  {{DOTENVX}} cargo run --bin server 2>&1 | sed 's/^/[RUST] /' &
  wait

# Usage: just src prod, just src prod rebuild, just src prod reuse
[doc("Build and run full-stack production; asks to reuse the last build when nothing changed")]
prod mode="ask": deps
  #!/usr/bin/env bash
  set -euo pipefail
  cd "{{ROOT}}"
  case "{{mode}}" in ask|rebuild|reuse) ;; *) echo "Usage: just src prod [ask|rebuild|reuse]"; exit 2 ;; esac
  server_bin="{{CARGO_TARGET}}/release/server"
  stamp_file="{{CARGO_TARGET}}/release/.rchat-prod-stamp"
  tree_stamp() {
    {
      git rev-parse HEAD
      git diff HEAD --binary
      git ls-files --others --exclude-standard -z | xargs -0 -r sha256sum
      for f in .env .env.local .env.production .env.production.local; do
        if [ -f "$f" ]; then sha256sum "$f"; fi
      done
      env | grep '^NEXT_PUBLIC_' | sort || true
    } | sha256sum | cut -d' ' -f1
  }
  stamp=$(tree_stamp)
  build=1
  if [ "{{mode}}" != rebuild ] && [ -f "$stamp_file" ] && [ "$(cat "$stamp_file")" = "$stamp" ] \
    && [ -x "$server_bin" ] && [ -f apps/web/.next/standalone/apps/web/server.js ]; then
    if [ "{{mode}}" = reuse ]; then
      build=0
    elif [ -t 0 ]; then
      echo "Nothing changed since the last production build."
      read -r -p "Rebuild everything [r] or start the last build [S]? " answer
      case "$answer" in [rR]*) build=1 ;; *) build=0 ;; esac
    fi
  elif [ "{{mode}}" = reuse ]; then
    echo "The last production build is missing or out of date. Rebuilding."
  fi
  if [ "$build" = 1 ]; then
    rm -f "$stamp_file"
    echo "Building WASM..."
    wasm-pack build crates/wasm --mode no-install --target web --out-dir ../../apps/web/public/wasm --release
    echo "Building frontend..."
    {{DOTENVX}} bun run build
    rm -rf apps/web/.next/standalone/apps/web/public apps/web/.next/standalone/apps/web/.next/static
    cp -r apps/web/public apps/web/.next/standalone/apps/web/
    cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/
    echo "Building backend..."
    cargo build --release --bin server
    tree_stamp > "$stamp_file"
  else
    echo "Starting the last production build."
  fi
  echo "Starting servers..."
  trap 'kill 0' SIGINT
  {{DOTENVX}} bash -c 'HOSTNAME=${FRONTEND_HOST:-127.0.0.1} exec bun ./apps/web/.next/standalone/apps/web/server.js' 2>&1 | sed 's/^/[WEB] /' &
  {{DOTENVX}} bash -c 'bun deploy/peer/server.mjs --wanted && exec bun deploy/peer/server.mjs' 2>&1 | sed 's/^/[PEER] /' &
  sleep 2
  {{DOTENVX}} "$server_bin" 2>&1 | sed 's/^/[RUST] /' &
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
frontend: deps
  cd {{ROOT}} && APP_MODE=api-only {{DOTENVX}} bun run dev

# Run Next.js production server
frontend-prod: deps
  cd {{ROOT}} && {{DOTENVX}} bun run start

# Static mode: frontend only, with a remote api-only server

# Usage: just src static https://api.example.com
[doc("Preview the static build locally against a remote API")]
static api_url: deps build-wasm
  #!/usr/bin/env bash
  set -euo pipefail
  cd "{{ROOT}}"
  STATIC_EXPORT=true NEXT_PUBLIC_API_URL={{api_url}} bun run build
  cp apps/web/out/index.html apps/web/out/404.html
  echo "Serving apps/web/out/ at http://localhost:{{env_var_or_default('PORT', '3001')}} (API: {{api_url}})"
  bunx serve apps/web/out -l {{env_var_or_default('PORT', '3001')}} -s

# Run production (assumes already built)
start-prod: deps
  #!/usr/bin/env bash
  cd "{{ROOT}}"
  trap 'kill 0' SIGINT
  {{DOTENVX}} bash -c 'HOSTNAME=${FRONTEND_HOST:-127.0.0.1} exec bun ./apps/web/.next/standalone/apps/web/server.js' 2>&1 | sed 's/^/[WEB] /' &
  {{DOTENVX}} bash -c 'bun deploy/peer/server.mjs --wanted && exec bun deploy/peer/server.mjs' 2>&1 | sed 's/^/[PEER] /' &
  sleep 2
  {{DOTENVX}} "{{CARGO_TARGET}}/release/server" 2>&1 | sed 's/^/[RUST] /' &
  wait
