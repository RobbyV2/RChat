<p align="center">
  <img src="assets/rchat_logo.png" alt="RChat" width="440">
</p>

<p align="center">
  <a href="https://github.com/RobbyV2/RChat/actions/workflows/ci.yml"><img src="https://github.com/RobbyV2/RChat/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/RobbyV2/RChat/pkgs/container/rchat"><img src="https://img.shields.io/badge/ghcr-nightly-4f46e5" alt="Nightly image"></a>
  <img src="https://img.shields.io/badge/Rust-axum-b7410e" alt="Rust">
  <img src="https://img.shields.io/badge/Next.js-16-black" alt="Next.js">
  <img src="https://img.shields.io/badge/storage-sqlite%20%7C%20postgres-336791" alt="Storage">
</p>

# RChat

RChat is an anonymous chat app with a layout like Discord. It runs on your own machine. It uses no external services, no email and no tracking.

<p align="center">
  <img src="docs/screenshots/chat-dark.png" alt="A server channel in the dark theme with a join notice, mentions, replies, reactions, a forwarded message, a pin notice and online members" width="900">
</p>

Browsers: current Chrome, Edge and Firefox. Safari and iOS need version 16.4 or newer.

## Features

| Feature                | What it does                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Servers and channels   | Make servers with text channels, voice channels and threads.                                                          |
| Roles                  | Give members roles with a color and permissions. A member cannot give more permissions than they have.                |
| Voice, video and share | Talk in voice channels. Turn on your camera or share your screen.                                                     |
| Direct messages        | Send private messages. Start voice or video calls in a DM.                                                            |
| P2P calls              | Call over a direct link between browsers.                                                                             |
| P2P attachments        | Send files of any size from your browser. The server stores only the name, size and hash. Works when uploads are off. |
| Relay servers          | Help calls and P2P files connect through STUN and TURN. Off by default. Relay only hides your IP address.             |
| Uploads                | Upload files and images up to 25 MB. The server deletes them after one day. The site admin can turn them off.         |
| Text only mode         | Turn off uploads and P2P attachments. Then messages can contain only text and emoji.                                  |
| Link previews          | Show a card for links in a message. The server gets the preview, not your browser.                                    |
| Mentions               | Type `@name` to ping a person. The app highlights messages that mention you.                                          |
| Reactions              | React to a message with an emoji. Your own reactions show in blue.                                                    |
| Emoji picker           | Search emoji by name. The picker keeps your frequent emoji and skin tone.                                             |
| Replies                | Reply to a message. You can choose to ping the author or not.                                                         |
| Edit messages          | Edit your message. Type `s/old/new` to fix your last message quickly.                                                 |
| Forwarding             | Forward a message to a different channel or DM. Open a public server as a preview before you join.                    |
| Pins                   | Pin important messages. Open all pins from the channel header.                                                        |
| Join and leave notices | Show a notice when a member joins or leaves. Server admins choose the channel or turn notices off.                    |
| Restricted channels    | Let only some roles or members see a channel or send in it.                                                           |
| Slow mode              | Set a wait time between messages in a channel.                                                                        |
| Server passwords       | Use a permanent password, temporary passwords or tickets with a use limit. Close the server to new members.           |
| Private servers        | A server with a password stays hidden from people who are not members.                                                |
| Invite links           | Paste an invite link to show a join card. Open it to see a full invite page.                                          |
| Mini profiles          | Click a name to see roles, bio, join dates and a quick DM box.                                                        |
| Moderation             | Kick and ban members. The site admin can delete users, servers and messages.                                          |
| Notifications          | Choose all messages, mentions only or nothing per server or channel. Mute for a time. Get desktop alerts.             |
| Organize               | Drag servers and DMs into your order. Drop a server on another to make a folder. Pin DMs.                             |
| Search                 | Search messages with date filters. Search for servers by name.                                                        |
| Sync config            | Export your settings and layout as text, a file, a share link or a QR code. Import them on a different device.        |
| Appear offline         | Hide your online status from other people.                                                                            |
| Streamer mode          | Blur names on screen while you stream. Hover to show a name.                                                          |
| Guests                 | Read public servers without an account. Guests cannot send messages.                                                  |
| Accounts               | Sign in with a text password or with 7 words in order. No email and no phone number.                                  |
| Themes                 | Use the dark or the light theme. Install the app as a PWA.                                                            |
| Profanity filter       | The site admin turns the filter on or off for messages, names, file names and bios.                                   |
| Multiple instances     | Each instance has its own name and identity. The login page lets you pick a different instance.                       |

<p align="center">
  <img src="docs/screenshots/replies-reactions-forward.png" alt="A mention, a reply, reactions with your own reaction in blue, and a forwarded message card" width="440">
  <img src="docs/screenshots/emoji-picker.png" alt="The emoji picker with frequent emoji and categories" width="440">
</p>
<p align="center">
  <img src="docs/screenshots/notification-menu.png" alt="The server menu with notification settings: all messages, only mentions or nothing" width="440">
  <img src="docs/screenshots/sync-config-qr.png" alt="The Sync config tab with a share link and its QR code" width="300">
</p>
<p align="center">
  <img src="docs/screenshots/chat-light.png" alt="The same channel in the light theme" width="600">
</p>
<p align="center">
  <img src="docs/screenshots/direct-messages-light.png" alt="A direct message in the light theme with call and P2P call buttons" width="600">
</p>
<p align="center">
  <img src="docs/screenshots/mobile-chat.png" alt="A channel on a phone" width="260">
  <img src="docs/screenshots/mobile-channels.png" alt="The server and channel list on a phone" width="260">
</p>

## Setup

You need Rust, Bun, wasm-pack and [just](https://github.com/casey/just).

Copy the example settings:

```bash
cp .env.local.example .env.local
```

Install the dependencies:

```bash
just src install
```

Start the app:

```bash
just src dev
```

Open http://localhost:3000. The first account you register is the site admin. Nobody else can see this.

## Deployment modes

Run everything in one process (the default):

```bash
just src prod
```

Run only the API:

```bash
APP_MODE=api-only just src api
```

Build the frontend as static files for that API. The files go to `out/`:

```bash
just src build-static https://api.example.com
```

Run the nightly Docker image:

```bash
docker run -p 3000:3000 -v rchat-data:/data ghcr.io/robbyv2/rchat:nightly
```

Build the image locally with `docker compose up`.

## Scaling

One process is enough for most groups. For more load, run many copies of the same image. All copies share one Postgres database and one Redis server. Valkey, KeyDB and Dragonfly also work.

Give each copy one or more roles with `RCHAT_ROLES`. The roles are `api`, `gateway`, `media`, `search`, `embeds`, `jobs`, `web` and `relay`. Your load balancer sends each path to the correct role.

There are two examples:

```bash
# Docker Compose with nginx
POSTGRES_PASSWORD=$(openssl rand -hex 24) VALKEY_PASSWORD=$(openssl rand -hex 24) \
  docker compose -f deploy/compose.scale.yml up -d

# Kubernetes (fill in deploy/k8s/secrets.env first)
kubectl apply -k deploy/k8s
```

Keep Redis on a private network. Anything that can write to Redis can send events to all users.

## Configuration

Put settings in `.env.local`. Refer to `.env.local.example` for all settings. These are the most useful ones:

| Variable          | Default     | What it does                                                                         |
| ----------------- | ----------- | ------------------------------------------------------------------------------------ |
| `APP_MODE`        | `full`      | `full` serves the API and the app. `api-only` serves only the API.                   |
| `HOST`            | `127.0.0.1` | The address the server listens on. Use `0.0.0.0` for remote access.                  |
| `SERVER_PORT`     | `3000`      | The public port.                                                                     |
| `DATABASE_URL`    | `rchat.db`  | A sqlite file, or a `postgres://` URL.                                               |
| `PUBLIC_URL`      | none        | The address people open, for example `https://chat.example.com`.                     |
| `INSTANCE_NAME`   | `RChat`     | The name people see for your instance.                                               |
| `GUESTS_ENABLED`  | `true`      | Lets people read public servers without an account.                                  |
| `P2P_ATTACHMENTS` | `true`      | Lets people send P2P attachments. The admin panel controls it after the first start. |
| `S3_ENDPOINT`     | none        | Stores uploads in an S3 bucket. Also set the bucket and keys.                        |
| `RCHAT_ROLES`     | `all`       | The roles this process runs (see Scaling).                                           |
| `REDIS_URL`       | none        | The shared Redis server for many processes.                                          |
| `TRUSTED_PROXIES` | none        | Proxy addresses to trust for the real client address.                                |
| `PUBLIC_STUN`     | `false`     | Gives calls a list of public STUN servers.                                           |
| `RELAY_ENABLED`   | `false`     | Starts the built-in STUN and TURN relay on UDP port 3478.                            |
| `RELAY_PUBLIC_IP` | none        | The public IP of the relay. TURN needs it.                                           |
| `VOICE_ROOM_MAX`  | `25`        | The most people in one voice channel. `0` means no limit.                            |

The relay uses UDP ports 49160 to 49415. Open them in the firewall. Reserve them so no other program uses them (`sysctl -w net.ipv4.ip_local_reserved_ports=49160-49415`).

Data is not encrypted at rest. Anyone with the database file can read all messages and files.
