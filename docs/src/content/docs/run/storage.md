---
title: Database and file storage
description: SQLite or Postgres, where uploads live, S3, and how long files stay.
sidebar:
  order: 9
---

## Database

`DATABASE_URL` is a SQLite file (`rchat.db` by default) or a `postgres://` URL. SQLite fits one server process. Several processes, or several copies of the server, share one Postgres database. The server creates and upgrades its schema at start.

Pools and timeouts are settings: `DATABASE_MAX_CONNECTIONS`, `DATABASE_ACQUIRE_TIMEOUT_SECS`, `DATABASE_STATEMENT_TIMEOUT_SECS` and the others under Database in the [settings reference](/docs/reference/settings/). Indexed channel search on Postgres uses the `btree_gist` and `intarray` extensions: install them, or let the server's database user create them.

## Uploads

Files uploaded to the instance live in the database by default. These four settings move them to an S3 bucket:

```sh
S3_ENDPOINT=https://s3.example.com
S3_BUCKET=rchat
S3_ACCESS_KEY=...
S3_SECRET_KEY=...
# S3_REGION=us-east-1
```

The server addresses the bucket by path (`https://s3.example.com/rchat/...`), which MinIO and most S3-compatible stores accept.

| Setting                    | Default | Limit                                                                         |
| -------------------------- | ------- | ----------------------------------------------------------------------------- |
| `UPLOAD_MAX_MIB`           | 25      | Largest upload, 1 to 512 MiB.                                                 |
| `UPLOAD_BUDGET_MIB`        | 2048    | MiB one account uploads in a day.                                             |
| `UPLOAD_EXPIRY_MAX_DAYS`   | 0       | The longest file expiry a server may choose, 0 to 365 days. 0 means no limit. |
| `FEATURE_FILE_UPLOADS`     | on      | Uploads to this instance at all.                                              |
| `AVATAR_UPLOAD_MAX_MIB`    | 8       | Largest profile picture upload, 1 to 64 MiB.                                  |
| `FEATURE_PROFILE_PICTURES` | on      | Uploaded profile pictures.                                                    |

A file is removed 1 day after upload unless its server chose a longer expiry. The message stays and shows that the file was removed. P2P attachments never reach the instance (see [Files](/docs/p2p/files/)).

Profile and server pictures live in the database. The server keeps a square crop of each at 64, 128 and 512 pixels and nothing else of the uploaded file. An animated upload also keeps animated GIFs at 128 and 512 pixels, within `AVATAR_ANIMATION_MAX_FRAMES` (250), `AVATAR_ANIMATION_MAX_SECS` (20) and `AVATAR_ANIMATION_MAX_MEGAPIXELS` (400, over all frames). An animation past a bound is refused. `FEATURE_ANIMATED_PROFILE_PICTURES=off` keeps only the first frame.

## Settings and keys

The database also holds the instance's id and signing key, the admin page's choices and the secrets the server generates. `PASSWORD_PEPPER`, `RELAY_SECRET`, `P2P_SECRET` and `INSTANCE_SIGNING_KEY` keep them out of the database when set. Set the same values on every copy of the server.
