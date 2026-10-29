import "../common.just"

# Build Rust server for production
build:
  cd {{ROOT}} && cargo build --release

# Build WASM module (release)
build-wasm:
  cd {{ROOT}} && wasm-pack build crates/wasm --target web --out-dir ../../apps/web/public/wasm --release

# Build WASM module (dev, faster)
build-wasm-dev:
  cd {{ROOT}} && wasm-pack build crates/wasm --target web --out-dir ../../apps/web/public/wasm --dev

# Build the API server binary
build-api:
  cd {{ROOT}} && cargo build --release --bin server

# Build Next.js for production (standalone)
build-frontend:
  cd {{ROOT}} && bun run build
  @echo "Copying static assets for standalone build..."
  cd {{WEB}} && cp -r .next/static .next/standalone/apps/web/.next/static
  cd {{WEB}} && cp -r public .next/standalone/apps/web/public

# Build static frontend baked with a remote API URL (connects to an api-only server)
# Usage: just src build-static https://api.example.com
build-static api_url:
  cd {{ROOT}} && STATIC_EXPORT=true NEXT_PUBLIC_API_URL={{api_url}} bun run build
  cd {{WEB}} && cp out/index.html out/404.html
  @echo "Static site in {{WEB}}/out (API: {{api_url}}); serve it on any static host."

# Build everything for production (full mode)
build-all: build-wasm build-api build-frontend
  @echo ""
  @echo "Production build complete!"
  @echo "  API binary:  {{ROOT}}/target/release/server"
  @echo "  WASM:        {{WEB}}/public/wasm/"
  @echo "  Frontend:    {{WEB}}/.next/standalone/"
  @echo ""
  @echo "Run with: just src prod"

# Check Rust code without building
check:
  cd {{ROOT}} && cargo check

# Format and lint all code
fmt:
  cd {{ROOT}} && cargo clippy --all-targets --all-features --fix --allow-dirty -- -D warnings
  cd {{ROOT}} && cargo fmt --all
  cd {{ROOT}} && taplo fmt
  cd {{ROOT}} && bunx prettier --write "**/*.{ts,tsx,js,jsx,json,md,mjs}"

# Check formatting and linting without changes
fmt-check:
  cd {{ROOT}} && cargo fmt --check --all
  cd {{ROOT}} && cargo clippy --all-targets --all-features -- -D warnings
  cd {{ROOT}} && taplo fmt --check
  cd {{ROOT}} && bunx prettier --check "**/*.{ts,tsx,js,jsx,json,md,mjs}"

# Format Rust only
fmt-rust:
  cd {{ROOT}} && cargo clippy --all-targets --all-features --fix --allow-dirty -- -D warnings
  cd {{ROOT}} && cargo fmt --all
  cd {{ROOT}} && taplo fmt

# Format TypeScript/frontend only
fmt-ts:
  cd {{ROOT}} && bun run lint --fix
  cd {{ROOT}} && bunx prettier --write "**/*.{ts,tsx,js,jsx,json,md,mjs}"

# Build Docker image
docker:
  cd {{ROOT}} && docker build -t rust-next .

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
