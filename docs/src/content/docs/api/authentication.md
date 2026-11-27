---
title: Authentication
description: Session tokens, temporary passwords, guests, guest grants and the SCIM token.
sidebar:
  order: 1
---

The REST API lives under `/api/v1` on the instance's address. A path under `/api` without a version resolves to the latest version, currently `v1`. Requests from other origins work with a token and no cookies: the server answers CORS requests from any origin and never allows credentials.

## Session tokens

`POST /api/v1/auth/register` creates an account and `POST /api/v1/auth/login` signs in to one. Both take a `username` and exactly one of `password` (any non-empty text) or `words` (the account's 7 words, in the order chosen), and answer with `{token, user}`.

```sh
curl -s https://chat.example.com/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username": "alice", "password": "correct horse"}'
```

Send the token on every request as `Authorization: Bearer <token>`. A token is 64 hex characters and stays valid until one of these ends it:

- `POST /api/v1/auth/logout` with that token. It also closes the token's WebSocket connections.
- A password change from another session of the account.
- A sign-in with the account's backup phrase (`POST /api/v1/auth/recovery`). It ends every earlier session.
- `SESSION_MAX_AGE_SECS` or `SESSION_IDLE_SECS`, when the instance sets them (both are 0, no limit, by default).

Sign-up answers 404 unless `registration` is `open` and `password_login` is on in `GET /api/v1/settings`. With single sign-on set up, `GET /api/v1/auth/oidc/{provider}/start` starts a provider sign-in and `POST /api/v1/auth/oidc/exchange` turns its one-time code into a session token.

## Login limits

Each account admits one login or recovery attempt every 3 seconds (429 `Wait 3 seconds between attempts`) and 1000 attempts per UTC day, successful ones included. Past that, the account answers 423 until the next UTC day. Sign-ups count as rare requests: 20 an hour and 100 a day per client address by default (`RARE_REQUESTS_PER_HOUR`, `RARE_REQUESTS_PER_DAY`).

## Temporary passwords

`server user create` and `server user reset-password` set a temporary password on an account (see [Accounts from the command line](/docs/run/accounts-cli/)). `GET /api/v1/me` reports such a session with `password_temporary`. While `password_change` in `GET /api/v1/settings` is `required`, or once the temporary password expired, every request of that session except `GET /api/v1/me`, `POST /api/v1/me/password` and `POST /api/v1/auth/logout` answers 403 `Change your password first` with reason `off_account` and control `password_change`. Its WebSocket connections close with code 4403. `POST /api/v1/me/password` with the temporary password as `current` lifts this.

## Guests

People without an account read servers as guests while the instance has `guests_enabled` on. Endpoints whose reference lists an optional security requirement accept requests without a token for them. An unknown token on such an endpoint counts as no token.

For a password-protected server, guests send a guest grant too: `POST /api/v1/servers/{name}/guest_access` with the password answers with one, and requests carry grants in the `X-Guest-Grant` header (comma separated, up to 100). Guest grants expire after `GUEST_GRANT_DAYS` without use (30 by default).

## WebSocket

`GET /api/v1/ws` takes the token in its first frame, `{"type": "auth", "token": "<token>"}`, within 10 seconds. A frame without a token connects as a guest. See [Realtime events](/docs/api/realtime/).

## SCIM

The provisioning endpoints under `/scim/v2` take the instance's `SCIM_TOKEN` as a bearer token. See [Single sign-on](/docs/run/sso/).
