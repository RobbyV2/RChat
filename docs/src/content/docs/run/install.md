---
title: Install and first run
description: Prerequisites, the first start from source, and where the app, the API and these docs open.
sidebar:
  order: 1
---

An instance is one server process that serves the web app, the API, realtime connections, P2P signaling and these docs from one address. It runs on Linux, Windows and macOS, from source or as the Docker image.

## Prerequisites

- Rust (stable)
- Bun 1.4 or newer
- [just](https://github.com/casey/just) 1.37 or newer

## First run

```sh
cp .env.local.example .env.local
just src install
just src dev
```

`just src install` runs `bun install` and installs three Rust tools: `wasm-pack` 0.15.0 and `wasm-bindgen-cli` 0.2.129 for the WebAssembly module, and `tauri-cli` 2.12.2 for the desktop and mobile apps.

`just src dev` builds the WebAssembly module, starts the Next.js dev server on `PORT` (3001), and starts the Rust server on `SERVER_PORT` (3000), which answers the API and passes every other page to Next.js. Open http://localhost:3000. The first account registered there becomes the site admin.

## Docs

The server serves this site at `/docs` once it is built: `bun run build:docs` writes it to `docs/dist`, and http://localhost:3000/docs/ then shows it. `just src docs` builds it and serves it alone at http://localhost:4321/docs/. The site switch `FEATURE_DOCS` and the folder setting `DOCS_DIR` are in the [settings reference](/docs/reference/settings/).

## Settings

The server takes each setting from its environment, else from the first `.env.local`, then `.env`, in the folder it starts in or a folder above it. `.env.local.example` documents every setting, and the [settings reference](/docs/reference/settings/) lists them with their defaults and ranges. A setting with a value it does not take stops the server at start and names the variable.

Settings marked "Also on the admin page" in the reference can also change while the server runs, under Site administration. At a start, a value changed in the file is applied, and an unchanged one leaves the admin page's choice. `SETTINGS_PINNED` makes listed settings follow the file at every start and read-only on the admin page.

## Browsers

The web app supports current Chrome, Edge and Firefox. Safari and iOS work from version 16.4.
