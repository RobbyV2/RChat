//! The env file: every line of `.env.local.example`, in order, with each setting's line tied to
//! its item. `env_example` writes the file.

use crate::Setting;
use crate::items::*;

/// A line of the env file.
pub enum Line {
    /// A comment line, `#` included.
    Note(&'static str),
    /// `NAME=value`: a value the file sets.
    Set(&'static Setting, &'static str),
    /// `# NAME=value`: the default or an example, commented out.
    Shown(&'static Setting, &'static str),
}

/// The id per-provider settings are shown with.
pub const PROVIDER_EXAMPLE: &str = "authentik";

const fn n(text: &'static str) -> Line {
    Line::Note(text)
}

const fn set(setting: &'static Setting, value: &'static str) -> Line {
    Line::Set(setting, value)
}

const fn shown(setting: &'static Setting, value: &'static str) -> Line {
    Line::Shown(setting, value)
}

/// The blocks of the env file, which blank lines separate.
pub const BLOCKS: &[&[Line]] = &[
    &[
        n(
            r##"# Copy to .env.local. A line that starts with "# KEY=" shows the default or an example."##,
        ),
        n(
            r##"# Lines marked "Admin page" are settings the site admin page can also change while the server runs."##,
        ),
        n(
            "# At a start, a value you changed here is applied. An unchanged one leaves the admin page's choice.",
        ),
        n(
            "# Start every copy with the same settings. A start without a value forgets it, and the next start that sets it applies it again.",
        ),
        n(
            "# A setting with a value it does not take stops the server at start and names the variable.",
        ),
        n(
            "# Put a value with spaces or quotes in single quotes, or in double quotes if it has a single quote. A line the server can't read stops it at start and names the line.",
        ),
        n(
            "# Names listed here follow this file at every start and are read-only in the admin page. all means every such setting set here.",
        ),
        shown(&SETTINGS_PINNED.setting, "AUTH_REGISTRATION,FEATURE_P2P"),
    ],
    &[
        n("# App"),
        n("# full serves the API and the app. api-only serves only the API."),
        set(&APP_MODE.setting, "full"),
        n("# Use 0.0.0.0 for remote access."),
        set(&HOST.setting, "127.0.0.1"),
        n("# The public port."),
        set(&SERVER_PORT.setting, "3000"),
        n("# The internal Next.js port."),
        set(&PORT.setting, "3001"),
        n("# Change only if Next.js runs on another machine."),
        shown(&FRONTEND_HOST.setting, "127.0.0.1"),
        n("# Where non-API requests go in full mode. Default: http://127.0.0.1:${PORT}"),
        shown(&SERVER_PROXY_URL.setting, "http://127.0.0.1:3001"),
        n("# API address for a frontend apart from the API (build time)."),
        shown(&NEXT_PUBLIC_API_URL.setting, "http://localhost:3000"),
        n("# WebSocket address when it is not on the API origin (build time)."),
        shown(&NEXT_PUBLIC_WS_URL.setting, "https://gateway.example.com"),
    ],
    &[
        n("# Instance"),
        n("# Admin page: the name people see for your instance, 1 to 64 characters."),
        shown(&INSTANCE_NAME.setting, "RChat"),
        n(
            "# Admin page: the name of the app this instance serves, up to 64 characters. Empty means the instance name.",
        ),
        shown(&BRAND_APP_NAME.setting, ""),
        n(
            "# Admin page: the app's short name for home screens, up to 16 characters. Empty means the app name.",
        ),
        shown(&BRAND_SHORT_NAME.setting, ""),
        n("# Admin page: text about the app, up to 1000 characters."),
        shown(&BRAND_ABOUT.setting, ""),
        n(
            r##"# Admin page: up to 4 links shown with the about text and under the sign-in form, as JSON in single quotes. Each has a label of 1 to 32 characters and an https address, for example '[{"label":"Help","url":"https://help.example.com"}]'."##,
        ),
        shown(&BRAND_LINKS.setting, "[]"),
        n("# Admin page: a note under the sign-in form, up to 300 characters."),
        shown(&BRAND_LOGIN_NOTE.setting, ""),
        n(
            "# Admin page: up to 20 instances the app suggests when someone adds one, as JSON in single quotes. mode is add (after the app's own list) or replace. Each instance has an http or https address and a label of up to 32 characters.",
        ),
        shown(
            &INSTANCE_SUGGESTIONS.setting,
            r##"'{"mode":"add","list":[]}'"##,
        ),
        n(
            "# The address people open, with its port when it isn't 443. Set it in production. Other instances know this instance by it, port included.",
        ),
        shown(&PUBLIC_URL.setting, "https://chat.example.com"),
        n("# Host names the instance answers for when PUBLIC_URL is not set."),
        shown(&ALLOWED_HOSTS.setting, "chat.example.com"),
        n("# For an API, WebSocket or PeerJS server on another address."),
        shown(&PUBLIC_API_URL.setting, "https://api.example.com/api"),
        shown(&PUBLIC_WS_URL.setting, "wss://gateway.example.com"),
        shown(
            &PUBLIC_PEERJS_URL.setting,
            "https://chat.example.com/peerjs",
        ),
        n("# Ed25519 seeds (base64url, comma separated) or PEM. Default: a key in the database."),
        shown(&INSTANCE_SIGNING_KEY.setting, ""),
        n(
            "# Ports other instances may use for the identities this one accepts, comma separated, 1 to 65535. Empty means any port; 443 means only the default HTTPS port.",
        ),
        shown(&OTHER_INSTANCE_PORTS.setting, ""),
    ],
    &[
        n("# Database"),
        n(
            "# A sqlite file or a postgres:// URL. Use Postgres for more than one process. Postgres channel search needs the btree_gist and intarray extensions, or the right to create them.",
        ),
        shown(&DATABASE_URL.setting, "rchat.db"),
        n(
            "# Postgres pool size per process, 1 to 1000. Default: two per core, from 8 to 32. Every copy has its own pool: copies times pool must stay under Postgres max_connections.",
        ),
        shown(&DATABASE_MAX_CONNECTIONS.setting, ""),
        n("# Connections the pool keeps open, 0 to 1000."),
        shown(&DATABASE_MIN_CONNECTIONS.setting, "0"),
        n("# Seconds to wait for a free connection, 1 to 3600."),
        shown(&DATABASE_ACQUIRE_TIMEOUT_SECS.setting, "10"),
        n("# Postgres: seconds a statement may run, 0 to 3600. 0 means no limit."),
        shown(&DATABASE_STATEMENT_TIMEOUT_SECS.setting, "60"),
        n(
            "# Postgres streaming read replicas, up to 16 comma-separated postgres:// addresses. Unset by default. Set it on the copies serving searches and older pages. Give each replica a replication slot (drop it when retiring the replica) and at least the primary's max_connections.",
        ),
        shown(
            &DATABASE_REPLICA_URLS.setting,
            "postgres://rchat:password@replica:5432/rchat",
        ),
        n("# Connections per replica per server process, 1 to 1000."),
        shown(&DATABASE_REPLICA_MAX_CONNECTIONS.setting, "8"),
        n("# Maximum replica replay delay in milliseconds, 100 to 600000."),
        shown(&DATABASE_REPLICA_MAX_LAG_MS.setting, "2000"),
        n(
            "# Sqlite read pool size, 0 to 64. Default: CPU count, at least 2 and at most 8. 0 sends reads to the writer.",
        ),
        shown(&DATABASE_READ_CONNECTIONS.setting, "4"),
        n(
            "# Postgres: async or sync. async commits read marks and other bookkeeping without waiting for the disk.",
        ),
        shown(&DATABASE_LIGHT_COMMITS.setting, "async"),
        n("# Postgres: memory in MiB for building an index in the background, 16 to 16384."),
        shown(&DATABASE_INDEX_BUILD_MIB.setting, "256"),
    ],
    &[
        n("# Secrets"),
        n("# Changing it after first start ends every temporary server password and ticket."),
        shown(&PASSWORD_PEPPER.setting, ""),
        n(
            "# Any secret also reads NAME_FILE=/path. Set one here to keep it out of the database; same value on all processes.",
        ),
        shown(&PASSWORD_PEPPER_FILE.setting, "/run/secrets/rchat_pepper"),
        n("# Signs relay (TURN) logins. Changing it ends relay logins within an hour."),
        shown(&RELAY_SECRET.setting, ""),
        n("# Signs P2P file tokens. Changing it ends the tokens that were given out."),
        shown(&P2P_SECRET.setting, ""),
    ],
    &[
        n("# Encryption at rest"),
        n(
            "# Root keys as id:key, comma separated; the first is used, every listed key still opens. Make one with: server keys new",
        ),
        n(
            "# To change the root key, put the new one first (k2:...,k1:...) on every copy; data keys move under it (on Postgres without Redis, run server keys rewrap once every copy has it), then k1 can go. When ENCRYPTION_KEYS replaces rchat.db.keys, give its key a new id; the file keeps opening until the admin page says it can be deleted.",
        ),
        n(
            "# Unset: the first server or DM that turns on encrypted storage makes rchat.db.keys beside the SQLite file. Back it up.",
        ),
        n(
            "# Stored secrets are encrypted with the key service (below), else ENCRYPTION_KEYS, else ACCOUNT_SECRETS_KEY, else a key kept in the database.",
        ),
        shown(&ENCRYPTION_KEYS.setting, "k1:"),
        n(
            "# A file holding the same value. On Postgres, name a file that does not exist yet to have one made there.",
        ),
        shown(&ENCRYPTION_KEYS_FILE.setting, "/run/secrets/rchat_keys"),
        n(
            "# A key service that wraps the data keys, ahead of ENCRYPTION_KEYS: the Transit engine of Vault or OpenBao, https (http only on this machine). Set all three. Make the key first; the token needs update on transit/encrypt/<key> and transit/decrypt/<key>. It is asked at start and when data keys are made; a start that can't reach it stops. Data keys move under it the way they move under a new first key, and stay there: keep these settings while they do. Keep the key's older versions until server keys rotate has run after rotating it in Vault.",
        ),
        shown(
            &ENCRYPTION_KMS_URL.setting,
            "https://vault.internal:8200/v1/transit",
        ),
        shown(&ENCRYPTION_KMS_KEY.setting, "rchat"),
        n("# A file holding the token, read again on every use."),
        shown(
            &ENCRYPTION_KMS_TOKEN_FILE.setting,
            "/run/secrets/vault_token",
        ),
        n(
            "# Keys for stored secrets only (signing key, pepper, relay, P2P and webhook secrets, pending sign-ins), in the same form. The key service and ENCRYPTION_KEYS win over it.",
        ),
        shown(&ACCOUNT_SECRETS_KEY.setting, "k1:"),
        n(
            "# on starts even when a key is missing; what it encrypted stays unreadable. If a key leaked, rotate data keys too: server keys rotate [--purpose P], or the admin page. The old data keys are destroyed a day after.",
        ),
        n(
            "# A stored pepper or signing key under a missing key still stops the start unless PASSWORD_PEPPER or INSTANCE_SIGNING_KEY is set. Relay and P2P secrets are made again.",
        ),
        shown(&ENCRYPTION_ALLOW_LOST.setting, "off"),
        n(
            "# on makes every server and DM store new messages encrypted, and new profile descriptions and P2P backups too, and nobody can turn it off. It needs a key (above). off leaves it to each server, each DM and the admin page.",
        ),
        shown(&ENCRYPTION_REQUIRED.setting, "off"),
        n(
            "# How search finds encrypted messages. keyed: through keyed pieces of text, which show which encrypted messages of a channel share pieces. scan: no pieces are stored; search opens encrypted messages one by one and may need more pages.",
        ),
        shown(&SEARCH_SEALED.setting, "keyed"),
        n(
            "# On Postgres keep log_statement, auto_explain and log_min_duration_statement off: they can log message text that is not stored encrypted.",
        ),
        n(
            "# age recipients (age1...) server db backup encrypts to, comma separated. Make a pair with age-keygen and keep the identity off the server. The root keys go in only with --with-keys.",
        ),
        shown(&BACKUP_RECIPIENTS.setting, ""),
        n(
            "# server keys unseal stores the messages, files and copies the keys encrypted plain again; stored secrets keep needing the keys. On SQLite, server db compact (with the server stopped) then rewrites the file without the old pages.",
        ),
    ],
    &[
        n("# Storage"),
        n("# Set the first four to store uploads in an S3 bucket."),
        shown(&S3_ENDPOINT.setting, "http://127.0.0.1:9000"),
        shown(&S3_BUCKET.setting, "rchat"),
        shown(&S3_ACCESS_KEY.setting, ""),
        shown(&S3_SECRET_KEY.setting, ""),
        shown(&S3_REGION.setting, "us-east-1"),
    ],
    &[
        n("# Uploads"),
        n(
            "# Largest upload in MiB, 1 to 512. Raise your proxy's body size to match (client_max_body_size 26m in deploy/nginx.conf).",
        ),
        shown(&UPLOAD_MAX_MIB.setting, "25"),
        n(
            "# Most MiB one account uploads in a day, 0 to 1048576. 0 means no limit. A file removed sooner frees its space.",
        ),
        shown(&UPLOAD_BUDGET_MIB.setting, "2048"),
        n(
            "# Most MiB of files one server keeps longer than 1 day through its file expiry setting, 0 to 1048576. 0 means no limit.",
        ),
        n("# Files that do not fit are still posted and are removed after 1 day."),
        shown(&UPLOAD_SERVER_KEPT_MIB.setting, "8192"),
        n(
            "# Most MiB of such files across all servers whose file expiry one account set, 0 to 1048576. 0 means no limit.",
        ),
        shown(&UPLOAD_OWNER_KEPT_MIB.setting, "16384"),
        n(
            "# Most MiB of upload bodies in memory at once, 32 to 1048576, and at least UPLOAD_MAX_MIB.",
        ),
        n("# Give it at least twice UPLOAD_MAX_MIB. One account holds at most a quarter of it,"),
        n("# three uploads (up to half of it) or one upload, whichever is most."),
        shown(&UPLOAD_BUFFER_MIB.setting, "256"),
        n(
            "# Admin page: the longest file expiry a server may choose, 0 to 365 days. 0 means no limit, and servers may keep files until removed. Files are removed 1 day after upload unless their server chose otherwise.",
        ),
        shown(&UPLOAD_EXPIRY_MAX_DAYS.setting, "0"),
    ],
    &[
        n("# Messages"),
        n("# Longest message in characters, 1 to 100000."),
        shown(&MESSAGE_MAX_CHARS.setting, "4000"),
        n(
            "# Messages one account, or the guests of one address, send per minute after the burst, 0 to 100000. 0 turns the limit off. All copies count together when REDIS_URL is set.",
        ),
        shown(&MESSAGE_RATE_PER_MINUTE.setting, "2400"),
        n(
            "# Messages one account, or the guests of one address, send at once, 0 to 100000. 0 turns the limit off.",
        ),
        shown(&MESSAGE_RATE_BURST.setting, "100"),
        n(
            "# Admin page: scheduled messages, which this site sends for people at a time they pick, on or off. Off stops new ones. Scheduled ones still send.",
        ),
        shown(&FEATURE_SCHEDULED_MESSAGES.setting, "on"),
        n(
            "# Scheduled messages one account can have waiting, 0 to 10000. 0 means no limit. Lowering it removes none.",
        ),
        shown(&SCHEDULED_PER_ACCOUNT.setting, "100"),
        n("# Pinned messages one channel or direct conversation can have, 1 to 1000."),
        shown(&CHANNEL_PINS_MAX.setting, "100"),
        n("# People one message can ping by name, 1 to 400. Names past it are not pinged."),
        shown(&MESSAGE_USER_MENTIONS_MAX.setting, "20"),
        n("# Roles one message can ping, 1 to 1000. Roles past it are not pinged."),
        shown(&MESSAGE_ROLE_MENTIONS_MAX.setting, "20"),
        n("# Online people one @here pings, 1 to 10000."),
        shown(&HERE_RECIPIENTS_MAX.setting, "500"),
        n("# Days to keep pings, 1 to 3650."),
        shown(&PING_KEEP_DAYS.setting, "30"),
    ],
    &[
        n("# Scaling"),
        n(
            "# Many copies share one Postgres database and one Redis server (REDIS_URL on every copy, PEERJS_BUILTIN set to false, deploy/peer serving /peerjs). Upgrade all copies together.",
        ),
        n(
            "# all, or a list of api, gateway, media, search, embeds, jobs, web, relay, sfu. Default: from APP_MODE.",
        ),
        shown(&RCHAT_ROLES.setting, "all"),
        n(
            "# Use a password and a private network. No TLS (rediss://). With it, message rates, friend requests, invite previews and joins count across all copies.",
        ),
        shown(&REDIS_URL.setting, "redis://:change-me@127.0.0.1:6379"),
        n(
            "# With an encryption key that every copy holds (ENCRYPTION_KEYS), Redis keeps realtime entries and queued jobs encrypted once every copy runs a build that opens them.",
        ),
        n("# Key prefix, so many deployments can share one Redis."),
        shown(&REDIS_PREFIX.setting, "rchat"),
        n("# Entries kept in the realtime stream, 1000 to 100000000. Same value on all processes."),
        shown(&REDIS_HUB_MAXLEN.setting, "100000"),
        n("# Proxy addresses or CIDR ranges. Their X-Forwarded-For gives the client address."),
        shown(&TRUSTED_PROXIES.setting, "10.0.0.0/8,192.0.2.10"),
        n("# Trust X-Forwarded-For from all peers. Prefer TRUSTED_PROXIES."),
        shown(&TRUST_PROXY.setting, "false"),
        n(
            "# Docker only: on runs the separate PeerJS server in this container too. Default: only when",
        ),
        n(
            "# PEERJS_BUILTIN is off, or PEERJS_PORT, PUBLIC_PEERJS_URL or a NEXT_PUBLIC_PEERJS setting is set.",
        ),
        shown(&RCHAT_PEERJS.setting, "on"),
    ],
    &[
        n("# Limits"),
        n("# A limit outside its range stops the server at start."),
        n("# Requests per second per IP, 1 to 1000."),
        shown(&RATE_LIMIT_PER_SECOND.setting, "10"),
        n("# Requests per IP in a burst, 1 to 1000000."),
        shown(&RATE_LIMIT_BURST.setting, "60"),
        n(
            "# Sign-in, sign-up, recovery, password and upload requests per second per IP, 1 to 1000.",
        ),
        shown(&RATE_LIMIT_STRICT_PER_SECOND.setting, "2"),
        n("# Those requests per IP in a burst, 1 to 1000000."),
        shown(&RATE_LIMIT_STRICT_BURST.setting, "30"),
        n(
            "# Invite previews, joins and webhook posts per second per IP, each counted apart, 1 to 1000.",
        ),
        shown(&RATE_LIMIT_INVITE_PER_SECOND.setting, "2"),
        n("# Those requests per IP in a burst, 1 to 1000000."),
        shown(&RATE_LIMIT_INVITE_BURST.setting, "30"),
        n(
            "# Password hashes at once, 0 to 1024. 0 means every core but a quarter. A quarter of the cores (at least one) is kept for sign-ins on top. Peak memory is about ARGON2_MEMORY_KIB times both together.",
        ),
        shown(&ARGON2_PERMITS.setting, "0"),
        n(
            "# Memory of one new password hash in KiB, 4096 to 1048576. Stored hashes keep the cost they were made with.",
        ),
        shown(&ARGON2_MEMORY_KIB.setting, "19456"),
        n("# Passes of one new password hash, 1 to 64."),
        shown(&ARGON2_ITERATIONS.setting, "2"),
        n("# Lanes of one new password hash, 1 to 16."),
        shown(&ARGON2_PARALLELISM.setting, "1"),
        n(
            "# Server password checks waiting or running at once, 1 to 100000. Past it the answer is 429.",
        ),
        shown(&SERVER_PASSWORD_QUEUE_MAX.setting, "64"),
        n("# Of those per client address, 1 to 100000."),
        shown(&SERVER_PASSWORD_QUEUE_PER_ADDRESS.setting, "16"),
        n("# Of those per network (an IPv4 /24 or IPv6 /48), 1 to 100000."),
        shown(&SERVER_PASSWORD_QUEUE_PER_NETWORK.setting, "32"),
        n("# Realtime connections per account, 1 to 10000. The oldest closes past it."),
        shown(&WS_CONNECTIONS_PER_USER.setting, "20"),
        n("# New realtime connections per account in a burst, 1 to 10000."),
        shown(&WS_CONNECT_BURST.setting, "20"),
        n("# New realtime connections per account per minute after the burst, 1 to 60000."),
        shown(&WS_CONNECTS_PER_MINUTE.setting, "30"),
        n(
            "# Realtime connections per client address and process, 1 to 1000000. Shared addresses count together.",
        ),
        shown(&WS_SOCKETS_PER_IP.setting, "200"),
        n(
            "# Guest connections per client address and process, 0 to 1000000. 0 turns guest connections off.",
        ),
        shown(&WS_GUEST_SOCKETS_PER_IP.setting, "50"),
        n(
            "# Guest connections per process, all addresses together, 0 to 1000000. 0 turns them off.",
        ),
        shown(&WS_GUEST_SOCKETS_MAX.setting, "2000"),
        n(
            "# Realtime connections one copy holds, all addresses together, 0 to 10000000. 0 means no limit. Past it new ones get 503 and /api/ready answers 503, so run the gateway role on copies of its own.",
        ),
        shown(&WS_SOCKETS_MAX.setting, "0"),
        n(
            "# Events waiting for one realtime connection, 16 to 65536. Past it the client is told to load again.",
        ),
        shown(&WS_INBOX_FRAMES.setting, "512"),
        n("# Frames waiting to be written to one realtime connection, 16 to 65536."),
        shown(&WS_OUT_FRAMES.setting, "256"),
        n(
            "# Seconds a realtime connection may take to accept a frame before it is closed, 1 to 600.",
        ),
        shown(&WS_SEND_TIMEOUT_SECS.setting, "10"),
        n("# KiB of read buffer per realtime connection, 4 to 65536."),
        shown(&WS_READ_BUFFER_KIB.setting, "128"),
        n("# KiB a realtime connection buffers before it writes, 0 to 65536."),
        shown(&WS_WRITE_BUFFER_KIB.setting, "128"),
        n(
            "# Most KiB a realtime connection buffers while its client reads slowly, 0 to 1048576. 0 means no limit. Otherwise more than WS_WRITE_BUFFER_KIB.",
        ),
        shown(&WS_MAX_WRITE_BUFFER_KIB.setting, "0"),
        n(
            "# Accounts each realtime pace keeps per process, 100 to 10000000. Past it the one paced longest ago is forgotten.",
        ),
        shown(&WS_PACED_USERS_MAX.setting, "10000"),
        n("# Channel access entries kept per process, 1000 to 10000000."),
        shown(&WS_CHANNEL_SLOTS.setting, "100000"),
        n(
            "# Follow-up jobs (ended calls, resent events) waiting per process, 0 to 1000000. 0 means no limit. Past it they wait together and still run.",
        ),
        shown(&HUB_AFTERMATH_MAX.setting, "0"),
        n(
            "# Presence changes waiting to reach friends per process, 0 to 1000000. 0 means no limit. Past it each person's latest change waits.",
        ),
        shown(&HUB_SHOWN_MAX.setting, "0"),
        n(
            "# Milliseconds before a client's first realtime reconnect, doubling with each try, 100 to 60000.",
        ),
        shown(&RECONNECT_BASE_MS.setting, "1000"),
        n(
            "# Most milliseconds between realtime reconnects, 1000 to 3600000, and at least RECONNECT_BASE_MS.",
        ),
        shown(&RECONNECT_CAP_MS.setting, "30000"),
        n(
            "# Fewest milliseconds before a realtime reconnect, 0 to 60000, and at most RECONNECT_BASE_MS.",
        ),
        shown(&RECONNECT_FLOOR_MS.setting, "250"),
        n(
            "# Most milliseconds clients wait at random before they reload after a server-wide resync, 0 to 600000.",
        ),
        shown(&RESYNC_JITTER_MS.setting, "10000"),
        n(
            "# Most milliseconds clients wait at random before they reload the open view after a reconnect, 0 to 600000.",
        ),
        shown(&CATCH_UP_DELAY_MS.setting, "5000"),
        n(
            "# Lookups count per account and process, and per client address for people without an account. Past a limit the answer is 429 with Retry-After.",
        ),
        n(
            "# Member list pages and member facts per minute, 10 to 10000. 30 at once at the default.",
        ),
        shown(&LOOKUP_LIST_PER_MINUTE.setting, "120"),
        n("# Mention suggestions per minute, 10 to 10000. 20 at once at the default."),
        shown(&LOOKUP_TYPEAHEAD_PER_MINUTE.setting, "300"),
        n("# Server and user searches per minute, 1 to 1000. 10 at once at the default."),
        shown(&LOOKUP_SEARCH_PER_MINUTE.setting, "30"),
        n("# Profile cards per minute, 10 to 10000. 30 at once at the default."),
        shown(&LOOKUP_PROFILE_PER_MINUTE.setting, "120"),
        n("# Member searches in server settings per minute, 1 to 1000. 10 at once at the default."),
        shown(&LOOKUP_MEMBER_SEARCH_PER_MINUTE.setting, "30"),
        n(
            r##"# Misses per hour (profile cards that answer "not found", blocks of names whose card you may not see, bans of non-members) before every lookup by name is refused for the rest of the hour, 0 to 100000. 0 means no limit."##,
        ),
        shown(&LOOKUP_MISSES_PER_HOUR.setting, "200"),
        n(
            "# Message searches count per account and process, and per client address for people without an account.",
        ),
        n(
            "# Message searches per minute, 1 to 1000. 10 at once at the default. Past it the answer is 429 with Retry-After.",
        ),
        shown(&MESSAGE_SEARCH_PER_MINUTE.setting, "30"),
        n(
            "# Message searches one account or address runs at the same time, 1 to 100. Past it a search waits up to 5 s for one to end, a newer search takes the place of one that waits, and then the answer is 429 with Retry-After.",
        ),
        shown(&MESSAGE_SEARCH_AT_ONCE.setting, "1"),
        n(
            "# Message searches the process runs at the same time, 1 to 1000. Default: half the read connections, at least 1. Past it a search waits up to 2 s for one to end, and then the answer is 503 with Retry-After.",
        ),
        n(
            "# Former-member lists share these places, one list per caller. Lists reserve a reader when there are two or more. A refusal is 429 with Retry-After.",
        ),
        n(
            "# With a single reader, one list can run. Other reads can wait for its query, as can writes when SQLite shares its writer for reads.",
        ),
        shown(&MESSAGE_SEARCH_CONCURRENT_LIMIT.setting, "4"),
        n(
            "# Rare requests (sign-ups, display name, password and recovery changes, server names, new and deleted servers, server passwords, webhooks, config links, P2P backups, identity records and bindings) count per kind, per account and process, and per client address for sign-ups and recovery. Past a limit the answer is 429 with Retry-After.",
        ),
        n("# Rare requests of one kind per hour, 0 to 10000. 0 means no limit."),
        shown(&RARE_REQUESTS_PER_HOUR.setting, "20"),
        n("# Rare requests of one kind per day, 0 to 100000. 0 means no limit."),
        shown(&RARE_REQUESTS_PER_DAY.setting, "100"),
        n(
            "# The general rate limit and password budgets count per client address. Behind a proxy, set TRUSTED_PROXIES.",
        ),
    ],
    &[
        n("# Guests"),
        n("# Admin page: reading servers without an account, on or off."),
        shown(&GUESTS_ENABLED.setting, "true"),
        n("# Admin page: guest text in servers that opt in, on or off."),
        shown(&GUEST_CHAT_ENABLED.setting, "off"),
        n("# Admin page: guest voice in servers that opt in, on or off."),
        shown(&GUEST_VOICE_ENABLED.setting, "off"),
        n("# Days until an unused guest password grant expires, 1 to 3650."),
        shown(&GUEST_GRANT_DAYS.setting, "30"),
        n("# Live guest grants per server password, 1 to 1000000."),
        shown(&GUEST_GRANTS_PER_PASSWORD.setting, "2000"),
        n(
            "# Live guest grants per server password and network (an IPv4 /24 or IPv6 /48), 1 to 1000000.",
        ),
        shown(&GUEST_GRANTS_PER_NETWORK.setting, "50"),
        n("# Guest grants one network gets per hour, across servers, 1 to 1000000."),
        shown(&GUEST_GRANT_MINTS_PER_NETWORK.setting, "60"),
    ],
    &[
        n("# Sign-in providers"),
        n("# Sign-in providers (OIDC): ids of a-z and 0-9, comma separated. Needs PUBLIC_URL."),
        n("# At the provider, register <API>/auth/oidc/<id>/callback as the redirect URI and"),
        n(
            "# <API>/auth/oidc/<id>/backchannel_logout for logout. <API> is PUBLIC_API_URL or PUBLIC_URL/api.",
        ),
        shown(&OIDC_PROVIDERS.setting, "authentik"),
        n("# Per provider, with the id in capitals. https, or http on localhost."),
        shown(
            &OIDC_ID_ISSUER.setting,
            "https://auth.example.com/application/o/rchat/",
        ),
        shown(&OIDC_ID_CLIENT_ID.setting, ""),
        n("# Unset for a public client. Supply the secret directly or by file."),
        shown(&OIDC_ID_CLIENT_SECRET.setting, ""),
        shown(&OIDC_ID_CLIENT_SECRET_FILE.setting, ""),
        n("# Button label. Default: the id."),
        shown(&OIDC_ID_NAME.setting, "Authentik"),
        shown(&OIDC_ID_SCOPES.setting, "'openid profile'"),
        shown(&OIDC_ID_USERNAME_CLAIM.setting, "preferred_username"),
        shown(&OIDC_ID_DISPLAY_CLAIM.setting, "name"),
        shown(&OIDC_ID_GROUPS_CLAIM.setting, "groups"),
        n("# Only these groups may sign in. Default: everyone."),
        shown(&OIDC_ID_ALLOWED_GROUPS.setting, "staff,contractors"),
        n("# Create an account at the first sign-in."),
        shown(&OIDC_ID_AUTO_CREATE.setting, "true"),
        n("# The display name follows the provider at each sign-in."),
        shown(&OIDC_ID_SYNC_PROFILE.setting, "true"),
        n(
            "# Signing out also ends the provider session. Register PUBLIC_URL/login as the post-logout URI.",
        ),
        shown(&OIDC_ID_END_SESSION.setting, "false"),
        n("# How the client secret is sent: basic or post."),
        shown(&OIDC_ID_TOKEN_AUTH.setting, "basic"),
    ],
    &[
        n("# Okta Web app: use https://<org>.okta.com/oauth2/default. Add a groups claim to the"),
        n("# authorization server's ID token and set OIDC_OKTA_SCOPES='openid profile groups'."),
        n("# RChat takes the login before @ for the username. Leave OIDC_OKTA_END_SESSION=false."),
        n("# For SCIM, use PUBLIC_URL/scim/v2, userName as the unique identifier, HTTP Header"),
        n("# authentication and Push Groups for SSO_GROUP_MAP."),
        n(
            "# Auth0 Regular Web Application: keep the trailing slash in https://<tenant>.<region>.auth0.com/.",
        ),
        n(
            "# Set OIDC_AUTH0_TOKEN_AUTH=post or configure the app for Basic. To send groups, add a namespaced",
        ),
        n(
            "# ID token claim in a Post Login Action and set OIDC_AUTH0_GROUPS_CLAIM to its full name.",
        ),
        n("# Auth0 accounts come from the first sign-in (OIDC_AUTH0_AUTO_CREATE), not SCIM."),
    ],
    &[
        n("# Provisioning (SCIM 2.0)"),
        n(
            "# The provider's SCIM base URL is PUBLIC_URL/scim/v2, with this bearer token (32 characters or more).",
        ),
        n("# Also reads SCIM_TOKEN_FILE."),
        shown(&SCIM_TOKEN.setting, ""),
        n(
            "# What a SCIM delete does: deactivate (suspend, keep data) or delete (delete the account).",
        ),
        shown(&SCIM_DELETE.setting, "deactivate"),
        n("# Sign-ins from this provider link to SCIM accounts by username."),
        shown(&SCIM_PROVIDER.setting, "okta"),
        n("# Group to the servers it joins and the roles it grants. Roles given by hand stay."),
        shown(
            &SSO_GROUP_MAP.setting,
            r##"'{"engineering":[{"server":"eng","role":"Developer"},{"server":"lobby"}]}'"##,
        ),
    ],
    &[
        n("# Attachments"),
        n("# Admin page: file uploads to this instance, on or off."),
        shown(&FEATURE_FILE_UPLOADS.setting, "on"),
        n(
            "# Admin page: P2P attachments, on or off. P2P files stay in the sender's browser and have no size limit.",
        ),
        shown(&P2P_ATTACHMENTS.setting, "true"),
    ],
    &[
        n("# Servers"),
        n("# Admin page: who can create servers, everyone, nobody or some."),
        shown(&SERVER_CREATION.setting, "everyone"),
        n(
            r##"# Admin page: who "some" means, a comma list of usernames and server:role entries (for example alice,lobby:Staff), up to 500."##,
        ),
        shown(&SERVER_CREATORS.setting, ""),
        n(
            "# Admin page: how people join servers, everyone, invites or nobody. invites needs a server password or a ticket. Members stay.",
        ),
        n(
            "# Under invites and nobody, only members can open a server without a password: it can't be read by its name either, unless its owner turns on public reading.",
        ),
        shown(&SERVER_JOINING.setting, "everyone"),
        n("# Admin page: server search, on or off."),
        shown(&SERVER_SEARCH.setting, "on"),
        n(
            "# Admin page: whether a server's owner can let people who aren't members read it, on or off. Off: only members read servers.",
        ),
        shown(&PUBLIC_READING.setting, "on"),
        n(
            "# Admin page: the servers every new account joins, in order: none, or up to 10 server names. Guests start in the ones anyone can read.",
        ),
        shown(&DEFAULT_SERVERS.setting, "rchat"),
        n(
            "# Servers one account can be in, creating one included, 0 to 1000000. 0 means no limit. Lowering it removes nobody.",
        ),
        shown(&SERVERS_PER_ACCOUNT.setting, "1000"),
        n(
            "# Members one server can have, 0 to 100000000. 0 means no limit. Lowering it removes nobody.",
        ),
        shown(&SERVER_MEMBERS_MAX.setting, "0"),
        n(
            "# New servers one network (an IPv4 address or an IPv6 /48) creates a day, 0 to 1000000. 0 means no limit. All copies count together when REDIS_URL is set.",
        ),
        shown(&SERVERS_PER_NETWORK_PER_DAY.setting, "0"),
        n("# Channels one server can have, 1 to 10000."),
        shown(&SERVER_CHANNELS_MAX.setting, "500"),
        n("# Channel categories one server can have, 1 to 1000."),
        shown(&SERVER_CATEGORIES_MAX.setting, "100"),
        n("# Channel separators one server can have, 1 to 1000."),
        shown(&SERVER_SEPARATORS_MAX.setting, "50"),
        n("# Roles one server can have, 1 to 10000."),
        shown(&SERVER_ROLES_MAX.setting, "250"),
        n("# Days to keep server audit log entries, 1 to 36500."),
        shown(&AUDIT_KEEP_DAYS.setting, "90"),
    ],
    &[
        n("# Direct messages and friends"),
        n(
            "# Admin page: who can start a direct conversation, everyone, friends or nobody. Existing conversations keep working.",
        ),
        shown(&DM_CREATION.setting, "everyone"),
        n(
            "# Admin page: new friend requests, on or off. Pending requests can still be answered, and friends stay.",
        ),
        shown(&FEATURE_FRIEND_REQUESTS.setting, "on"),
        n("# Friends one account can have, 1 to 10000."),
        shown(&FRIENDS_MAX.setting, "1000"),
        n(
            "# Pending friend requests one account can receive, 1 to 10000. Past it new ones are refused.",
        ),
        shown(&FRIEND_REQUESTS_IN_MAX.setting, "1000"),
    ],
    &[
        n("# Privacy"),
        n(
            "# Admin page: who can see a profile (description, banner, account age), everyone, public_servers or shared.",
        ),
        n(
            "# shared: people who share a server, a direct conversation or a friendship with the account. public_servers: also everyone, for accounts in a server anyone can read.",
        ),
        n(
            "# Names next to messages and in member lists always show. Set everyone before upgrading from 0.3.x to keep profiles open to all.",
        ),
        shown(&PROFILE_VISIBILITY.setting, "shared"),
        n(
            r##"# Admin page: what accounts may choose for "Who can see your profile and find you by name", any, narrower or site."##,
        ),
        n(
            "# any: friends only, people who share a server, or everyone, wider or narrower than PROFILE_VISIBILITY. narrower: only narrower. site: everyone follows PROFILE_VISIBILITY.",
        ),
        shown(&PROFILE_CHOICES.setting, "any"),
    ],
    &[
        n("# Accounts"),
        n(
            r##"# Admin page: who can sign up with a password, open, sso or closed. Closed or sso before any account exists: create yours with "server user create <name>"."##,
        ),
        n(
            "# The first account becomes site admin. Create yours before enabling provisioning or opening sign-up.",
        ),
        shown(&AUTH_REGISTRATION.setting, "open"),
        n(
            "# Admin page: password sign-in, on or off. Off stops new passwords, sign-up included. Existing passwords still work.",
        ),
        shown(&AUTH_PASSWORD_LOGIN.setting, "on"),
        n(
            "# Admin page: what an account that signed in with a temporary password must do, required or encouraged. required: it can only choose its own password. encouraged: it is asked to, and must once the temporary password expires.",
        ),
        shown(&TEMP_PASSWORD_CHANGE.setting, "required"),
        n(
            "# Admin page: how long a temporary password signs in, 0 to 720 hours. 0 means it never expires.",
        ),
        shown(&TEMP_PASSWORD_HOURS.setting, "72"),
        n(
            "# Sign-ups from one network (an IPv4 address or an IPv6 /48) a day, 0 to 1000000. 0 means no limit. All copies count together when REDIS_URL is set.",
        ),
        shown(&SIGNUPS_PER_NETWORK_PER_DAY.setting, "0"),
        n("# Seconds a session lasts after sign-in, 0 to 315360000. 0 means no limit."),
        shown(&SESSION_MAX_AGE_SECS.setting, "0"),
        n(
            "# Seconds a session lasts without a request the user made, 0 to 315360000. 0 means no limit. Otherwise at least 300.",
        ),
        shown(&SESSION_IDLE_SECS.setting, "0"),
        n("# Admin page: changing display names, on or off."),
        shown(&FEATURE_DISPLAY_NAMES.setting, "on"),
        n("# Admin page: the tour for new accounts, on or off."),
        shown(&FEATURE_ONBOARDING.setting, "on"),
        n("# Admin page: setting and resetting backup phrases, on or off."),
        shown(&FEATURE_BACKUP_PHRASE.setting, "on"),
    ],
    &[
        n("# P2P"),
        n(
            "# Admin page: P2P servers and conversations in the app, on or off. Off hides them and keeps data on devices.",
        ),
        n("# With P2P attachments off too, the server stops P2P signaling (/peerjs)."),
        shown(&FEATURE_P2P.setting, "on"),
        n(
            r##"# P2P device limits as JSON in single quotes: "local." and a name from assets/p2p_limits.json, to a number in its range, for example '{"local.gossip.perRoom": 16}'. Devices read them when P2P starts."##,
        ),
        n(
            "# Each refresh is at most half its expiry: local.gossip.typingRelayMs of local.gossip.typingMs, local.session.pingMs of local.session.deadMs, local.gossip.presenceMs of local.gossip.presenceTtl, local.voice.refreshMs of local.voice.ttlMs, local.voice.relayMs of local.voice.ttlMs, local.voice.gapMs of local.voice.ttlMs. And local.voice.refreshMs plus local.voice.relayMs is at most local.voice.lostMs, and local.voice.gapMs plus local.voice.refreshMs is less than local.voice.lostMs. A name set alone is checked against the defaults of the others.",
        ),
        shown(&P2P_LIMITS.setting, "{}"),
    ],
    &[
        n("# Other instances"),
        n(
            "# Admin page: adding other instances in the web app this site serves, on or off. The desktop and mobile apps and other web apps ignore it.",
        ),
        shown(&FEATURE_CLIENT_OTHER_INSTANCES.setting, "on"),
    ],
    &[
        n("# Server profiles"),
        n(
            "# Admin page: a name, avatar, banner and description members set per server, on or off.",
        ),
        shown(&FEATURE_SERVER_PROFILES.setting, "on"),
    ],
    &[
        n("# Profile pictures"),
        n(
            "# Admin page: uploaded profile pictures, on or off. Off stops uploads and shows the built-in avatars.",
        ),
        shown(&FEATURE_PROFILE_PICTURES.setting, "on"),
        n(
            "# Largest profile picture upload in MiB, 1 to 64. A picture is cropped to a square and kept at 64, 128 and 512 pixels.",
        ),
        shown(&AVATAR_UPLOAD_MAX_MIB.setting, "8"),
        n(
            "# Admin page: animated pictures, on or off. Off keeps only the first frame of an animated upload.",
        ),
        shown(&FEATURE_ANIMATED_PROFILE_PICTURES.setting, "on"),
        n(
            "# Most frames of an animated picture, 2 to 2000. An animation past a bound is refused, never cut.",
        ),
        shown(&AVATAR_ANIMATION_MAX_FRAMES.setting, "250"),
        n("# Longest animated picture in seconds, 1 to 120."),
        shown(&AVATAR_ANIMATION_MAX_SECS.setting, "20"),
        n(
            "# Most decoded megapixels of an animated picture over all its frames (width x height x frames), 1 to 4000.",
        ),
        shown(&AVATAR_ANIMATION_MAX_MEGAPIXELS.setting, "400"),
    ],
    &[
        n("# Docs"),
        n("# Admin page: the documentation at /docs, on or off."),
        shown(&FEATURE_DOCS.setting, "on"),
        n(
            "# Admin page: the docs may run requests as the accounts people hold on this site, on or off.",
        ),
        shown(&FEATURE_INTERACTIVE_DOCS.setting, "on"),
        n(
            "# The folder of the built documentation (bun run build:docs), relative to the folder the server starts in.",
        ),
        shown(&DOCS_DIR.setting, "docs/dist"),
        n(
            "# off skips building the documentation in just src prod and just src build-all (build time). For the Docker image, pass it as --build-arg DOCS_BUILD=off.",
        ),
        shown(&DOCS_BUILD.setting, "on"),
    ],
    &[
        n("# Member lists"),
        n(
            "# Admin page: who is in each server, their presence and mention suggestions, on or off.",
        ),
        shown(&FEATURE_MEMBER_LISTS.setting, "on"),
    ],
    &[
        n("# Profanity"),
        n(
            "# Admin page: the instance filter, on or off. Each account's own display filter is separate and on by default.",
        ),
        shown(&PROFANITY_FILTER.setting, "off"),
        n(
            "# Admin page: what the instance filter checks when on: all, none, or a list: messages, links, usernames, server_names, channel_names, role_names, file_names, bios, channel_topics, category_names.",
        ),
        shown(&PROFANITY_TARGETS.setting, "all"),
        n(
            "# Admin page: strict file names, on or off. On also checks file names and the paths of links like message text, extension included. Only matters while the filter is on and file_names is in PROFANITY_TARGETS.",
        ),
        shown(&PROFANITY_STRICT_FILE_NAMES.setting, "off"),
    ],
    &[
        n("# Previews"),
        n("# Admin page: link previews, on or off."),
        shown(&FEATURE_LINK_PREVIEWS.setting, "on"),
        n("# Days to keep link previews that no message uses, 1 to 3650."),
        shown(&EMBED_CACHE_DAYS.setting, "30"),
        n("# Link preview fetches at once, 1 to 1024."),
        shown(&EMBED_FETCHES.setting, "16"),
        n("# Link preview fetches waiting, 1 to 100000. Past it new links get no preview."),
        shown(&EMBED_QUEUE.setting, "256"),
        n("# MiB of cached preview images, 1 to 1048576. Past it the oldest are dropped."),
        shown(&PREVIEW_CACHE_MIB.setting, "128"),
        n("# Cached preview images, 1 to 10000000. Past it the oldest are dropped."),
        shown(&PREVIEW_CACHE_ROWS.setting, "20000"),
        n("# Days to keep a cached preview image, 1 to 3650."),
        shown(&PREVIEW_CACHE_DAYS.setting, "7"),
    ],
    &[
        n("# Webhooks"),
        n("# Admin page: on or off. Lets servers POST events to URLs their managers choose."),
        shown(&OUTGOING_WEBHOOKS.setting, "false"),
        n(
            "# Admin page: incoming webhooks, on or off. Off: none can be created and none post. Existing ones are kept.",
        ),
        shown(&FEATURE_INCOMING_WEBHOOKS.setting, "on"),
        n("# Posts per incoming webhook every 2 seconds, 1 to 10000."),
        shown(&WEBHOOK_HOOK_BURST.setting, "5"),
        n("# Webhook posts per channel per minute, all its webhooks together, 1 to 100000."),
        shown(&WEBHOOK_CHANNEL_PER_MINUTE.setting, "30"),
        n("# Incoming webhooks one channel can have, 1 to 1000."),
        shown(&CHANNEL_WEBHOOKS_MAX.setting, "15"),
        n("# Incoming webhooks one server can have, 1 to 10000."),
        shown(&SERVER_WEBHOOKS_MAX.setting, "100"),
        n("# Outgoing webhooks one server can have, 1 to 1000."),
        shown(&SERVER_OUTGOING_WEBHOOKS_MAX.setting, "10"),
        n(
            "# Outgoing deliveries waiting per webhook, 1 to 1000000. Past it new events are dropped.",
        ),
        shown(&WEBHOOK_QUEUE_MAX.setting, "1000"),
        n("# Outgoing deliveries at once per process, 1 to 1024."),
        shown(&WEBHOOK_WORKERS.setting, "16"),
        n(
            "# Tries of one outgoing delivery, 1 to 100. Waits between them: 10 s, 30 s, 2 min, 10 min, then 30 min.",
        ),
        shown(&WEBHOOK_ATTEMPTS.setting, "6"),
        n("# Days to keep the delivery log, 1 to 3650."),
        shown(&WEBHOOK_LOG_DAYS.setting, "7"),
        n("# Finished deliveries kept in the log per webhook, 1 to 100000."),
        shown(&WEBHOOK_LOG_KEPT.setting, "100"),
        n(
            "# Hosts webhooks may reach on private addresses. Use host:port: a bare host opens every port.",
        ),
        shown(
            &WEBHOOK_ALLOWED_HOSTS.setting,
            "hooks.internal.example:8443,127.0.0.1:9000",
        ),
        n("# Plain http for the allowed hosts only."),
        shown(&WEBHOOK_ALLOW_HTTP.setting, "false"),
    ],
    &[
        n("# Voice"),
        n("# Seconds until a voice room or call with one person ends, 5 to 86400."),
        shown(&VOICE_IDLE_SECS.setting, "60"),
        n("# Most people in one voice channel, 0 to 10000. 0 means no limit."),
        shown(&VOICE_ROOM_MAX.setting, "25"),
    ],
    &[
        n("# Calls"),
        n(
            "# Admin page: voice channels and calls through this server, on or off. Off ends running calls. P2P calls follow FEATURE_P2P.",
        ),
        shown(&FEATURE_CALLS.setting, "on"),
    ],
    &[
        n("# Media server (SFU) for calls"),
        n("# Optional: run it, on or off. It runs in processes with the sfu role."),
        shown(&SFU_ENABLED.setting, "false"),
        n("# Admin page: calls use the media server when it runs, on or off."),
        shown(&FEATURE_SFU.setting, "off"),
        n("# Most people in one call through it, 2 to 10000."),
        shown(&SFU_MAX_PARTICIPANTS.setting, "100"),
        n("# Most forwarded streams per process, 1 to 1000000."),
        shown(&SFU_MAX_STREAMS.setting, "2000"),
        n("# KiB/s per account, 1 to 1048576."),
        shown(&SFU_USER_KIB_PER_SEC.setting, "4096"),
    ],
    &[
        n("# PeerJS"),
        n(
            "# One public address is enough. A proxy answers on PUBLIC_URL's domain and port and sends every",
        ),
        n(
            "# path to SERVER_PORT, with the WebSocket upgrade. Calls and P2P files (WebRTC) go between browsers.",
        ),
        n(
            "# P2P signaling (PeerJS) is at /peerjs on the server's own port: on or off. Off needs the",
        ),
        n("# separate PeerJS server (deploy/peer) and a proxy that sends /peerjs to it."),
        shown(&PEERJS_BUILTIN.setting, "true"),
        n("# The port of a separate PeerJS server. Browsers then dial this port, not /peerjs."),
        shown(&PEERJS_PORT.setting, "9001"),
        n(
            "# PeerJS connections per client address, 0 to 1000000. Each tab uses two. 0 turns the limit off.",
        ),
        shown(&PEERJS_PEERS_PER_IP.setting, "50"),
        n("# PeerJS connections in all, 1 to 1000000."),
        shown(&PEERJS_CONCURRENT_LIMIT.setting, "5000"),
        n(
            "# Separate PeerJS server only: the instance's settings address. The server asks it every 30 seconds",
        ),
        n("# and stops signaling while P2P and P2P attachments are both off."),
        shown(
            &PEERJS_SETTINGS_URL.setting,
            "http://127.0.0.1:3000/api/v1/settings",
        ),
        n(
            "# PeerJS port for the browser (build time). Default: the address the instance gives. Setting",
        ),
        n("# this or the host below keeps the separate PeerJS server."),
        shown(&NEXT_PUBLIC_PEERJS_PORT.setting, "9001"),
        n("# PeerJS host for the browser (build time). Default: the address the instance gives."),
        shown(&NEXT_PUBLIC_PEERJS_HOST.setting, "peer.example.com"),
    ],
    &[
        n("# Relay"),
        n("# Give calls public STUN servers from assets/stun_servers.json."),
        shown(&PUBLIC_STUN.setting, "false"),
        n("# How many, 1 to 4."),
        shown(&PUBLIC_STUN_COUNT.setting, "3"),
        n(
            "# Optional: run the built-in STUN and TURN relay. It uses UDP RELAY_PORT and UDP RELAY_MIN_PORT to",
        ),
        n("# RELAY_MAX_PORT, not the public port. Use the same RELAY_ values on all processes."),
        shown(&RELAY_ENABLED.setting, "false"),
        n("# TURN needs RELAY_PUBLIC_IP."),
        shown(&RELAY_TURN.setting, "true"),
        n("# Default: the instance host."),
        shown(&RELAY_HOST.setting, "relay.example.com"),
        shown(&RELAY_PORT.setting, "3478"),
        shown(&RELAY_PUBLIC_IP.setting, "203.0.113.10"),
        n("# Reserve the port range: sysctl -w net.ipv4.ip_local_reserved_ports=49160-49415"),
        shown(&RELAY_MIN_PORT.setting, "49160"),
        shown(&RELAY_MAX_PORT.setting, "49415"),
        n(
            "# Relay allocations in all, 1 to 65535 and at most the size of the port range. Default: the size of the port range.",
        ),
        shown(&RELAY_MAX_ALLOCATIONS.setting, "256"),
        n(
            "# Relay allocations per account, 1 to 65535. Each relayed P2P session, call or voice participant uses one.",
        ),
        shown(&RELAY_USER_ALLOCATIONS.setting, "64"),
        n("# KiB/s per account, 1 to 10485760."),
        shown(&RELAY_USER_KIB_PER_SEC.setting, "1024"),
        n("# KiB/s for the full relay, 1 to 10485760."),
        shown(&RELAY_MAX_KIB_PER_SEC.setting, "65536"),
        n("# Addresses the relay never sends to. Add the other public addresses of your servers."),
        shown(
            &RELAY_DENIED_PEERS.setting,
            "198.51.100.0/24,2001:db8:1::/48",
        ),
        n("# Let the relay reach private addresses. LAN and development only."),
        shown(&RELAY_ALLOW_PRIVATE.setting, "false"),
        n(
            "# Your own STUN or TURN servers as JSON in single quotes. Every account gets them as they are. Prefer the built-in relay.",
        ),
        shown(
            &ICE_SERVERS.setting,
            r##"'[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]'"##,
        ),
    ],
    &[
        n("# Reports"),
        n("# Admin page: reports to a server's moderators, on or off."),
        shown(&FEATURE_SERVER_REPORTS.setting, "on"),
        n("# Admin page: reports to the instance, on or off."),
        shown(&FEATURE_INSTANCE_REPORTS.setting, "on"),
        n(
            r##"# Admin page: the report categories and their fields. A path to a JSON file: {"forms": [...]}, as the admin page saves them."##,
        ),
        shown(&REPORT_FORMS_FILE.setting, "/etc/rchat/report_forms.json"),
        n(
            "# Hours before one person can report the same account or its messages again, 0 to 8760. 0 means no wait.",
        ),
        shown(&REPORT_SAME_TARGET_HOURS.setting, "72"),
        n("# Different accounts one person can report per day, 0 to 10000. 0 means no cap."),
        shown(&REPORT_TARGETS_PER_DAY.setting, "3"),
        n("# Reports one person can send per week, 0 to 100000. 0 means no cap."),
        shown(&REPORT_MAX_PER_WEEK.setting, "10"),
        n("# Bug reports and feedback one person can send per week, 0 to 100000. 0 means no cap."),
        shown(&REPORT_FEEDBACK_PER_WEEK.setting, "10"),
        n("# Days to keep closed reports, 0 to 3650. 0 keeps them forever."),
        shown(&REPORT_RETENTION_DAYS.setting, "180"),
    ],
    &[
        n("# Encryption"),
        n("# Admin page: end-to-end encryption, on or off."),
        shown(&E2EE.setting, "off"),
        n("# Guests in one encrypted group, 0 to 5000. 0 means no guests."),
        shown(&E2EE_GUESTS_PER_GROUP.setting, "500"),
        n("# Days to keep encryption key material for catching up, 1 to 69."),
        shown(&E2EE_KEY_RETENTION_DAYS.setting, "30"),
        n("# Admin page: compliance archive in new encrypted spaces, on or off."),
        shown(&E2EE_COMPLIANCE.setting, "off"),
    ],
    &[
        n("# P2P backups"),
        n(
            "# Most MiB of one P2P backup version, 0 to 512, at most UPLOAD_BUFFER_MIB. 0 turns backups off. Raise your proxy's body size to match.",
        ),
        shown(&P2P_BACKUP_MAX_MIB.setting, "64"),
        n(
            "# Most MiB of P2P backups an account keeps, 0 to 1048576. 0 for no total. Keep it at least 35 times the typical backup.",
        ),
        shown(&P2P_BACKUP_TOTAL_MIB.setting, "256"),
        n("# Admin page: P2P backup uploads, on or off. Off keeps stored backups readable."),
        shown(&FEATURE_P2P_BACKUP.setting, "on"),
    ],
    &[
        n("# Widgets"),
        n("# Admin page: embeddable widgets, on or off."),
        shown(&WIDGETS.setting, "on"),
        n("# Admin page: sending from widgets and Quick join, on or off."),
        shown(&FEATURE_WIDGET_CHAT.setting, "on"),
        n("# Admin page: read-only widget links, on or off."),
        shown(&FEATURE_WIDGET_READ_LINKS.setting, "on"),
        n("# Quick joins per client address per hour, 1 to 10000."),
        shown(&WIDGET_QUICK_JOINS_PER_HOUR.setting, "10"),
        n("# Live viewers per widget and process, 0 to 1000000. 0 means no cap."),
        shown(&WIDGET_VIEWERS_MAX.setting, "5000"),
        n("# Admin page: widgets for P2P servers through a bridge, on or off."),
        shown(&WIDGET_BRIDGE.setting, "off"),
        n("# P2P servers the bridge belongs to, 1 to 10000."),
        shown(&WIDGET_BRIDGE_SERVERS_MAX.setting, "50"),
    ],
    &[
        n("# Logs"),
        n("# Swagger UI at /api/v1/swagger-ui. It needs a login token."),
        shown(&SWAGGER_UI.setting, "false"),
        shown(&RUST_LOG.setting, "info"),
    ],
];
