<p align="center">
  <img src="assets/rchat_logo.png" alt="RChat" width="440">
</p>

<p align="center">
  <a href="https://github.com/RobbyV2/RChat/actions/workflows/ci.yml"><img src="https://github.com/RobbyV2/RChat/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/RobbyV2/RChat/pkgs/container/rchat"><img src="https://img.shields.io/badge/ghcr-weekly-4f46e5" alt="Weekly image"></a>
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license">
  <img src="https://img.shields.io/badge/Rust-axum-b7410e" alt="Rust">
  <img src="https://img.shields.io/badge/Next.js-16-black" alt="Next.js">
  <img src="https://img.shields.io/badge/storage-sqlite%20%7C%20postgres-336791" alt="Storage">
</p>

# RChat

RChat is a semi-anonymous chat app with a layout like Discord. It runs on your own machine. It uses no external services, no email and no tracking.

<p align="center">
  <img src="docs/screenshots/chat-dark.png" alt="A server channel in the dark theme with a join notice, mentions, replies, reactions, a forwarded message, a pin notice and online members" width="900">
</p>

Runs on Linux, Windows, macOS, iOS, Android and in your browser.

## Features

- Servers with text channels, voice channels, threads, categories and roles
- Direct messages, friends and blocking
- Voice, video and screen share, in channels and in DMs
- P2P contacts, DMs, servers, calls and files, kept on the members' devices
- Replies, mentions, reactions, pins, forwarding, polls and link previews
- File uploads and text-only channels
- Restricted channels, slow mode, server passwords and invite links
- Moderation, a profanity filter and a site admin panel
- Guests who read public servers, and post or talk where allowed
- Chat and voice channels that other sites can embed
- Sensitive channels that ask before they open
- Spoilers and hidden previews
- Accounts with no email or phone number
- Search, a command palette, notification settings and settings sync
- Dark and light themes, a PWA, and desktop and mobile apps
- Many instances, each with its own name and identity

## Setup

Install Rust, Bun 1.4 or newer and [just](https://github.com/casey/just) 1.37 or newer (on Windows, use the installers on [rustup.rs](https://rustup.rs) and [bun.sh](https://bun.sh)):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
curl -fsSL https://bun.sh/install | bash
cargo install just
```

Then install the rest and start it:

```bash
cp .env.local.example .env.local
just src install
just src dev
```

`just src install` installs the JavaScript packages, the WebAssembly Rust target, wasm-pack, wasm-bindgen and the Tauri CLI. Open http://localhost:3000. The first account you register is the site admin. `just --list src` lists the other commands.

## Deployment

- From source: `just src prod` builds and serves it on http://localhost:3000 (`SERVER_PORT`).
- Docker: `docker run -p 3000:3000 -v rchat-data:/data ghcr.io/robbyv2/rchat:latest` serves it on http://localhost:3000 (`weekly` for the newest weekly build).
- Many copies with nginx, Postgres and Valkey: `docker compose -f deploy/compose.scale.yml up -d` serves it on http://localhost:8080. Its first lines say what to set.
- Kubernetes: fill in `deploy/k8s/secrets.env` (from `secrets.env.example`), the `REPLACE` values in `deploy/k8s/config.yaml` and the host in `deploy/k8s/ingress.yaml`, then `kubectl apply -k deploy/k8s`. It serves on that host.

A proxy in front answers on one HTTPS address, the one in `PUBLIC_URL`. It sends every path to `SERVER_PORT` and passes the WebSocket upgrade for `/api/ws` and `/peerjs`.

`server user create <name>` makes an account with a temporary password and `server user reset-password <name>` resets one, also while the server runs (Docker: `docker exec <container> /app/server user create <name>`).

Never run an older release on a database that a newer release upgraded.

### Sign-in (SSO)

OIDC sign-in and SCIM provisioning are set in [.env.local.example](.env.local.example). Create the local site admin with `server user create <name>` first. [deploy/authentik](deploy/authentik/README.md) is a local example.

### Run only the app

`just src client` builds the app alone and serves it on http://localhost:3000 (`PORT`), where you add the instances you use. `just src build-client` only builds it into `apps/web/out/`, to serve on a static host that returns `index.html` for unknown paths.

## Configuration

Every setting is in [.env.local.example](.env.local.example) with its default and range. Copy it to `.env.local`, or set the same names in the environment (`docker run -e NAME=value`). The Compose example reads `RCHAT_*` names from `deploy/.env`, and Kubernetes reads `deploy/k8s/config.yaml`.

| Variable               | Default     | What it does                                                                           |
| ---------------------- | ----------- | -------------------------------------------------------------------------------------- |
| `APP_MODE`             | `full`      | `full` serves the API and the app. `api-only` serves only the API.                     |
| `HOST`                 | `127.0.0.1` | The address the server listens on. Use `0.0.0.0` for remote access.                    |
| `SERVER_PORT`          | `3000`      | The public port.                                                                       |
| `DATABASE_URL`         | `rchat.db`  | A sqlite file, or a `postgres://` URL.                                                 |
| `PUBLIC_URL`           | none        | The address people open, for example `https://chat.example.com`.                       |
| `INSTANCE_NAME`        | `RChat`     | The name people see for your instance.                                                 |
| `AUTH_REGISTRATION`    | `open`      | Who can sign up with a password: `open`, `sso` or `closed`.                            |
| `FEATURE_FILE_UPLOADS` | `on`        | File uploads to this instance, `on` or `off`.                                          |
| `UPLOAD_MAX_MIB`       | `25`        | The largest upload in MiB. Raise your proxy's body size limit to match.                |
| `S3_ENDPOINT`          | none        | Stores uploads in an S3 bucket, with `S3_BUCKET`, `S3_ACCESS_KEY` and `S3_SECRET_KEY`. |
| `TRUSTED_PROXIES`      | none        | Proxy addresses to trust for the real client address. Set it behind a proxy.           |

## Desktop and mobile apps

The apps connect to an instance you enter on first launch. They need the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

- Desktop: `just src desktop` opens the app. `just src desktop-build` writes installers for your system to `target/release/bundle/`.
- Android: `just src mobile-init android`, then `just src android-build` writes an APK to `apps/desktop/src-tauri/gen/android/app/build/outputs/apk/`. Install it with `adb install <apk>`.
- iOS (on a Mac): `just src mobile-init ios`, then `just src ios-sideload` writes `apps/desktop/src-tauri/gen/apple/build/RChat_sideload.ipa`. Install it with a sideloading app such as AltStore or Sideloadly.

## Releases

Stable releases and weekly pre-releases (every Monday) are on [GitHub Releases](https://github.com/RobbyV2/RChat/releases): the apps, the web client alone, the server and `SHA256SUMS`.

## License

MIT. See [LICENSE](LICENSE).
