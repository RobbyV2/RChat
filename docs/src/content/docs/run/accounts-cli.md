---
title: Accounts from the command line
description: Creating accounts and resetting passwords with the server binary, also while it runs.
sidebar:
  order: 7
---

The server binary manages accounts in the instance's database. It reads the same settings as the server (`DATABASE_URL` and the others) and works while the server runs.

```sh
server user create <name>
server user create <name> --display-name "Dana R."
server user reset-password <name>
```

From source, run it as `cargo run --bin server -- user create <name>`. In Docker it is `docker exec <container> /app/server user create <name>`. The [command line reference](/docs/reference/command-line/) lists every flag.

`user create` makes the account with a temporary password and prints it once. The new account joins the instance's default servers. The first account of an instance becomes the site admin, also while sign-up is closed (`AUTH_REGISTRATION=closed` or `sso`). An instance without open sign-up gets its admin this way.

`user reset-password` sets a new temporary password on an account and signs out all its sessions. A running server closes the account's open connections within about a minute.

## Temporary passwords

A temporary password signs in for `TEMP_PASSWORD_HOURS` (72 by default, 0 for no expiry). `TEMP_PASSWORD_CHANGE` sets what the account does next:

- `required` (default): the account can only choose its own password until it does.
- `encouraged`: the account is asked to choose one, and is held to it once the temporary password expires.

Site administration → Users does the same from the browser: Create Account and New Temporary Password.
