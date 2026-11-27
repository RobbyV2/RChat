---
title: Limits and errors
description: Rate limit buckets, the error body and its reason kinds, and the answers to a busy server.
sidebar:
  order: 4
---

## The error body

Every error the API itself raises is JSON:

```json
{
  "error": "Sending too fast, try again in a moment",
  "reason": { "kind": "rate", "retry_after": 3 }
}
```

`error` is a short text for people. `reason` is for programs and is present on most errors:

| `kind`        | Meaning                                                      | Other fields                                                |
| ------------- | ------------------------------------------------------------ | ----------------------------------------------------------- |
| `off_site`    | Turned off for this site.                                    | `control`: the setting, a key of `GET /api/v1/settings`     |
| `off_account` | Turned off for this account.                                 | `control`                                                   |
| `off_server`  | Turned off in this server by its owner or staff.             | `control`                                                   |
| `off_app`     | Turned off for this app by its author or the server's owner. | `control`                                                   |
| `app`         | An app's own rule or action refused.                         | The app's message is the `error` text                       |
| `limit`       | The caller reached a limit.                                  | `control`: the limit, such as `upload_max_mib`              |
| `capacity`    | The site or a shared resource is full right now.             | `control`                                                   |
| `invalid`     | A value in the request is wrong.                             | `field`: the value's name                                   |
| `rate`        | Too many requests.                                           | `retry_after`: seconds, also in the `Retry-After` header    |
| `conflict`    | Someone else changed it, or the name is taken.               |                                                             |
| `sign_in`     | The session ended.                                           |                                                             |
| `unavailable` | The server can't do it right now.                            | `retry_after`                                               |
| `locked`      | A moderator locked it.                                       | `until`: Unix seconds                                       |
| `confirm`     | Refused until the caller confirms.                           | `control`: what to confirm, `channel`: the channel it opens |

An error without `reason` is a denial about a server, channel or message the caller can't open, or an error whose kind is unset. The status codes and `error` texts are the same with and without it. A malformed JSON body gets a plain-text 400, 415 or 422 from the framework.

## Rate limit buckets

Every `/api` route except `/api/v1/health` and `/api/v1/ready` counts in a general bucket per client address. Some routes count in a second, stricter bucket too.

| Bucket  | Routes                                                                                                                                                                                           | Settings (default)                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| General | Every API route                                                                                                                                                                                  | `RATE_LIMIT_PER_SECOND` (10), `RATE_LIMIT_BURST` (60)              |
| Strict  | Requests that cost the server more or guard accounts: sign-up, sign-in, recovery, password changes, uploads, new servers and others. The REST API reference names the buckets of each operation. | `RATE_LIMIT_STRICT_PER_SECOND` (2), `RATE_LIMIT_STRICT_BURST` (30) |
| Invites | Invite previews, joining a server and webhook posts, each counted apart                                                                                                                          | `RATE_LIMIT_INVITE_PER_SECOND` (2), `RATE_LIMIT_INVITE_BURST` (30) |

A request past a bucket answers `429 {"error": "Too Many Requests! Wait for 3s", "reason": {"kind": "rate", "retry_after": 3}}` with `Retry-After: 3`. Behind a proxy, the client address comes from `X-Forwarded-For` only from the addresses in `TRUSTED_PROXIES`.

Other limits count per account:

- Messages (channel, thread and DM messages, forwards and polls) refill at `MESSAGE_RATE_PER_MINUTE` (2400) a minute after a burst of `MESSAGE_RATE_BURST` (100). Guests count per client address.
- Rare requests, the ones a person makes a few times a day (sign-ups, display names, password and recovery changes, new, renamed and deleted servers, server passwords, webhooks, config links, P2P backups and bindings), allow `RARE_REQUESTS_PER_HOUR` (20) an hour and `RARE_REQUESTS_PER_DAY` (100) a day of each kind.
- Lookups (member lists, mention suggestions, searches, profile cards) and message searches have their own per-minute limits, listed under Limits in the [settings reference](/docs/reference/settings/).

With `REDIS_URL` set, message rates, friend requests, joins and invite previews count across all copies of the instance.

## A busy server

When the database does not answer in time, a request answers `503 {"error": "Server busy, try again in a moment", "reason": {"kind": "unavailable", "retry_after": 1}}` with `Retry-After: 1`. Any other failure of the server answers `500 {"error": "Something went wrong"}` and logs its cause.
