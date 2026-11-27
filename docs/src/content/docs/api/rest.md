---
title: REST API
description: Conventions of the REST API and where its reference comes from.
sidebar:
  order: 2
---

The [REST API reference](/docs/reference/api/) lists every endpoint with its parameters, bodies, answers and errors. It is generated from the OpenAPI document the server builds from its own handlers. A running instance serves the same document at `/api/v1/openapi.json`, and Swagger UI at `/api/v1/swagger-ui` unless `SWAGGER_UI` is `off`. Both answer only requests with a session token. Site administration endpoints are left out of the document.

## Conventions

- Paths start with `/api/v1`. `/api/...` without a version is the latest version.
- Bodies are JSON. Timestamps are Unix seconds unless a field says otherwise.
- Server names and usernames match case-insensitively by their lowercase form. Answers carry the lowercase `name` or `username` and a `display_name`.
- List endpoints answer with a JSON array. When more items follow, the `X-Next-Cursor` header holds an opaque cursor for the `cursor` query parameter of the next page. The header is absent on the last page. Each endpoint states its page size.

## Servers you can't open

Without access, a password-protected server is indistinguishable from one that does not exist. Every endpoint that takes a server name answers both with `404 {"error": "Server not found or wrong password"}`. Endpoints that take a channel or message id answer `404 {"error": "Not found"}` for ids that do not exist, that you cannot see, or that belong to a server you cannot open. A ban answers 403 only after access was proven. `GET /api/v1/servers/{name}/available` is the one endpoint that tells whether a name is taken.

While the instance's `server_joining` is `invites` or `nobody`, servers without a password are hidden the same way from people who are not members.

## Events

Most writes also emit realtime events to the connections that may see the change. Each operation in the reference names the events it emits, and [Realtime events](/docs/api/realtime/) lists them all.

## The instance

| Path                     | Answers                                              |
| ------------------------ | ---------------------------------------------------- |
| `GET /api/v1/instance`   | The instance's name, id, addresses and limits.       |
| `GET /api/v1/settings`   | The site switches, without a token.                  |
| `GET /.well-known/rchat` | Discovery for other instances and apps.              |
| `GET /api/v1/health`     | 200 while the process runs.                          |
| `GET /api/v1/ready`      | 200 while the instance takes traffic, 503 otherwise. |
