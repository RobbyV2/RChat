#!/bin/sh
# Rebuilds the committed solver module (apps/web/public/pow/rchat_pow.wasm) and its source hash.
# The toolchain and every profile key the bytes depend on are named here and nowhere else, so the
# workspace's profiles can't change the module. This file is part of the source hash.
set -eu
cd "$(dirname "$0")/../.."
cargo +1.99.1 build -p rchat-pow-wasm --release --target wasm32-unknown-unknown \
  --config 'profile.release.opt-level=3' \
  --config 'profile.release.lto=true' \
  --config 'profile.release.codegen-units=1' \
  --config 'profile.release.panic="abort"' \
  --config 'profile.release.strip=true' \
  --config 'profile.release.debug=false' \
  --config 'profile.release.debug-assertions=false' \
  --config 'profile.release.overflow-checks=false' \
  --config 'profile.release.incremental=false'
mkdir -p apps/web/public/pow
install -m 644 "${CARGO_TARGET_DIR:-target}/wasm32-unknown-unknown/release/rchat_pow_wasm.wasm" \
  apps/web/public/pow/rchat_pow.wasm
POW_WASM_WRITE=1 cargo test -p rchat-pow-wasm --test sidecar
