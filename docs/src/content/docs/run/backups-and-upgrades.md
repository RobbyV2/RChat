---
title: Backups and upgrades
description: What to back up, and how a new release changes the database.
sidebar:
  order: 11
---

## What to back up

An instance keeps its state in three places:

- The database (`DATABASE_URL`): accounts, servers, messages, settings, the instance id and its keys, and uploads unless they go to S3.
- The S3 bucket, when uploads go there.
- The secrets you set outside the database (`PASSWORD_PEPPER`, `RELAY_SECRET`, `P2P_SECRET`, `INSTANCE_SIGNING_KEY`, `SCIM_TOKEN`, OIDC client secrets) and your `.env.local`.

The server does not back itself up. Back up SQLite with `sqlite3 rchat.db ".backup rchat-backup.db"`, which copies a consistent snapshot while the server runs, and Postgres with `pg_dump`. Changing `PASSWORD_PEPPER` after the first start ends every temporary server password and ticket: keep it with the database.

P2P chats and files are not on the instance: each person's devices hold them (see [What is stored where](/docs/p2p/storage/)).

## Upgrades

A new release upgrades the schema when it starts: it adds tables, columns and indexes, and never drops or renames any. Indexes on large tables (`messages`, `reactions`, `members` and others) build in the background after the start, and Site administration → Config shows their progress.

A database that a newer release upgraded refuses older builds: the server stops at start with `the database has schema version N, but this build only knows version M`. Run that release or a newer one. With several copies, upgrade all of them together.

Releases are on GitHub: stable releases, and weekly pre-releases every Monday (`weekly-YYYY-MM-DD`). The Docker tags follow them: `latest` and `weekly`.
