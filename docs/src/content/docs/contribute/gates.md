---
title: Gates
description: The checks every commit passes before it lands.
sidebar:
  order: 2
---

`just src gates` runs these checks from the repository root, in this order:

```sh
cargo fmt --all --check
cargo clippy --workspace --exclude rchat-desktop --exclude tauri-plugin-rchat-share --all-targets -- -D warnings
bunx @taplo/cli@0.7.0 fmt --check $(git ls-files '*.toml')
bunx eslint .
bunx tsc --noEmit --incremental false -p apps/web
bunx prettier --check "**/*.{ts,tsx,js,jsx,json,md,mjs}" --ignore-path .gitignore --ignore-path .prettierignore --ignore-path .git/info/exclude
cargo test --workspace --exclude rchat-desktop --exclude tauri-plugin-rchat-share
bun test scripts
bun run test:ui
bun run build
```

The web tests load the WebAssembly module that `bun run build:wasm` writes, so build it once before them. `cargo fmt --all` and `bunx prettier --write <files>` fix the formatting the checks report. The desktop crates (`rchat-desktop`, `tauri-plugin-rchat-share`) build only with the WebKitGTK headers installed, and CI checks them in a job of their own. `bun run build:docs` builds this site, and the `docs` workflow builds it on every push.

## CI

`.github/workflows/ci.yml` runs the same checks on every push and pull request (`checks.yml`), then the desktop, mobile and Docker builds on pushes to `main`. Commit messages and pull request labels can skip the heavy jobs (`scripts/ci-flags.sh`).
