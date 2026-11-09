import "../common.just"

# Run all Rust tests (the desktop crates need WebKitGTK; CI tests them separately)
test:
  cd {{ROOT}} && cargo test --workspace {{DESKTOP_CRATES}}

# Run WASM tests
test-wasm:
  cd {{ROOT}} && wasm-pack test --headless --chrome crates/wasm

# Run frontend unit tests
test-ui: deps
  cd {{ROOT}} && bun run test:ui

# Run the release script tests
test-scripts: deps
  cd {{ROOT}} && bun test scripts
