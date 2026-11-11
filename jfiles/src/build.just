import "../common.just"

# Build Rust server for production
build:
  cd {{ROOT}} && cargo build --release

# Build WASM module (release)
build-wasm:
  cd {{ROOT}} && wasm-pack build crates/wasm --mode no-install --target web --out-dir ../../apps/web/public/wasm --release

# Build WASM module (dev, faster)
build-wasm-dev:
  cd {{ROOT}} && wasm-pack build crates/wasm --mode no-install --target web --out-dir ../../apps/web/public/wasm --dev

# Rebuild the committed proof-of-work solver (apps/web/public/pow) and its source hash
pow-wasm:
  cd {{ROOT}} && sh crates/pow-wasm/build.sh

# Build the API server binary
build-api:
  cd {{ROOT}} && cargo build --release --bin server

# Build Next.js for production (standalone)
build-frontend: deps
  cd {{ROOT}} && bun run build
  @echo "Copying static assets for standalone build..."
  cd {{WEB}} && rm -rf .next/standalone/apps/web/.next/static .next/standalone/apps/web/public
  cd {{WEB}} && cp -r .next/static .next/standalone/apps/web/.next/static
  cd {{WEB}} && cp -r public .next/standalone/apps/web/public

# Usage: just src build-static https://api.example.com
[doc("Build the static frontend baked with a remote API URL (for an api-only server)")]
build-static api_url: deps build-wasm
  cd {{ROOT}} && STATIC_EXPORT=true NEXT_PUBLIC_API_URL={{api_url}} bun run build
  cd {{WEB}} && cp out/index.html out/404.html
  @echo "Static site in {{WEB}}/out (API: {{api_url}}); serve it on any static host."

# Build everything for production (full mode)
build-all: build-wasm build-api build-frontend
  @echo ""
  @echo "Production build complete!"
  @echo "  API binary:  {{CARGO_TARGET}}/release/server"
  @echo "  WASM:        {{WEB}}/public/wasm/"
  @echo "  Frontend:    {{WEB}}/.next/standalone/"
  @echo ""
  @echo "Run with: just src start-prod"

# Check Rust code without building
check:
  cd {{ROOT}} && cargo check

# Run every check a commit needs (formatting, lints, types, all tests, build)
gates: deps
  cd {{ROOT}} && cargo fmt --all --check
  cd {{ROOT}} && cargo clippy --workspace {{DESKTOP_CRATES}} --all-targets -- -D warnings
  cd {{ROOT}} && bunx @taplo/cli@0.7.0 fmt --check
  cd {{ROOT}} && bunx eslint . --ignore-pattern '.superpowers/**'
  cd {{ROOT}} && bunx tsc --noEmit --incremental false -p apps/web
  cd {{ROOT}} && bunx prettier --check "**/*.{ts,tsx,js,jsx,json,md,mjs}" {{PRETTIER_IGNORES}}
  cd {{ROOT}} && cargo test --workspace {{DESKTOP_CRATES}}
  cd {{ROOT}} && bun test scripts
  cd {{WEB}} && bun test app
  cd {{ROOT}} && bun run build

# Format and lint all code
fmt: deps
  cd {{ROOT}} && cargo clippy --workspace {{DESKTOP_CRATES}} --all-targets --fix --allow-dirty -- -D warnings
  cd {{ROOT}} && cargo fmt --all
  cd {{ROOT}} && bunx @taplo/cli@0.7.0 fmt
  cd {{ROOT}} && bunx eslint . --ignore-pattern '.superpowers/**' --fix
  cd {{ROOT}} && bunx prettier --write "**/*.{ts,tsx,js,jsx,json,md,mjs}" {{PRETTIER_IGNORES}}

# Check formatting and linting without changes
fmt-check: deps
  cd {{ROOT}} && cargo fmt --check --all
  cd {{ROOT}} && cargo clippy --workspace {{DESKTOP_CRATES}} --all-targets -- -D warnings
  cd {{ROOT}} && bunx @taplo/cli@0.7.0 fmt --check
  cd {{ROOT}} && bunx eslint . --ignore-pattern '.superpowers/**'
  cd {{ROOT}} && bunx prettier --check "**/*.{ts,tsx,js,jsx,json,md,mjs}" {{PRETTIER_IGNORES}}

# Format Rust only
fmt-rust:
  cd {{ROOT}} && cargo clippy --workspace {{DESKTOP_CRATES}} --all-targets --fix --allow-dirty -- -D warnings
  cd {{ROOT}} && cargo fmt --all
  cd {{ROOT}} && bunx @taplo/cli@0.7.0 fmt

# Format TypeScript/frontend only
fmt-ts: deps
  cd {{ROOT}} && bunx eslint . --ignore-pattern '.superpowers/**' --fix
  cd {{ROOT}} && bunx prettier --write "**/*.{ts,tsx,js,jsx,json,md,mjs}" {{PRETTIER_IGNORES}}

# Build Docker image
docker:
  cd {{ROOT}} && docker build -t rchat .

# Run Docker container
docker-run:
  cd {{ROOT}} && docker compose up

# Run Docker container (detached)
docker-up:
  cd {{ROOT}} && docker compose up -d

# Stop Docker container
docker-down:
  cd {{ROOT}} && docker compose down

# Clean build artifacts
clean:
  cd {{ROOT}} && cargo clean
  cd {{WEB}} && rm -rf .next out public/wasm
  cd {{ROOT}} && rm -rf node_modules/.cache

# Refresh the bundled public STUN list (assets/stun_servers.json) from always-online-stun
refresh-stun:
  cd {{ROOT}} && bun assets/refresh_stun.ts

# Refresh the bundled Public Suffix List (crates/fed/data/public_suffix_list.dat) from publicsuffix.org
refresh-psl:
  cd {{ROOT}} && bun scripts/refresh_psl.ts
