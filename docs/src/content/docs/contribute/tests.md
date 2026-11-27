---
title: Tests
description: Where tests go and how to run them.
sidebar:
  order: 3
---

New logic gets unit tests next to the code it checks, and UI changes get a browser check.

## Server

Rust tests sit next to the code (`#[cfg(test)]` modules or a `tests.rs` beside the module). Tests that touch the database use `temp_state` from `apps/server/src/api/mod.rs`, which opens a fresh SQLite file:

```rust
#[tokio::test]
async fn the_switch_hides_it() {
    let (state, path) = temp_state("switch_hides").await;
    // ...
    done(state, path).await;
}
```

With `TEST_POSTGRES_URL` set to a `postgres://` URL, the tests that take it also run on an empty database of their own on that server. A schema change gets a test that starts from the old schema with data, runs the server's own start twice and checks the new columns, their defaults and the old rows.

Run them with `cargo test --workspace --exclude rchat-desktop --exclude tauri-plugin-rchat-share`, or one module with a name filter, for example `cargo test -p rust-next --lib server::docs`.

## Web

Pure logic lives in `apps/web/app/lib/*.ts` with its tests in `apps/web/app/lib/__tests__/`. `bun run test:ui` runs them in a random order and prints the seed when one fails. `SEED=<number> bun run test:ui` runs the same order again.

## Scripts and docs

`bun test scripts` runs the tests of the build files, release scripts and doc generators in `scripts/`. The reference pages of this site come from the code: when the server's OpenAPI document or command line changes, `just src docs-refs` writes `docs/generated` again, and a Rust test fails until it does.

## In a browser

UI changes are checked in a browser at 1280x800 and 390x844, in dark and light. The browser checks in `scripts/*_browser.ts` drive Playwright's Chromium through `playwright-core`. Features with more than one person get a check with two accounts.
