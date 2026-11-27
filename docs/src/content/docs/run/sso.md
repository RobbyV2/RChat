---
title: Single sign-on
description: OIDC sign-in providers, SCIM provisioning and group mapping.
sidebar:
  order: 8
---

On a fresh database, create the local site admin with `server user create <name>` before you turn on single sign-on or provisioning: the first account of an instance becomes its site admin.

## Sign-in providers (OIDC)

`OIDC_PROVIDERS` lists provider ids (`a` to `z` and `0` to `9`, comma separated). Each provider reads its settings under its id in capitals, for example `OIDC_AUTHENTIK_ISSUER` for the id `authentik`:

| Setting                                                                                             | What it sets                                                                                                         |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `OIDC_<ID>_ISSUER`                                                                                  | The issuer URL: https, or http on localhost.                                                                         |
| `OIDC_<ID>_CLIENT_ID`, `OIDC_<ID>_CLIENT_SECRET`                                                    | The client. Leave the secret unset for a public client, or set it in a file named by `OIDC_<ID>_CLIENT_SECRET_FILE`. |
| `OIDC_<ID>_NAME`                                                                                    | The button label.                                                                                                    |
| `OIDC_<ID>_SCOPES`, `OIDC_<ID>_USERNAME_CLAIM`, `OIDC_<ID>_DISPLAY_CLAIM`, `OIDC_<ID>_GROUPS_CLAIM` | What to ask for and which claims hold the username, the display name and the groups.                                 |
| `OIDC_<ID>_ALLOWED_GROUPS`                                                                          | Only these groups may sign in.                                                                                       |
| `OIDC_<ID>_AUTO_CREATE`, `OIDC_<ID>_SYNC_PROFILE`                                                   | Create an account at the first sign-in, and follow the provider's display name.                                      |
| `OIDC_<ID>_END_SESSION`, `OIDC_<ID>_TOKEN_AUTH`                                                     | End the provider session on sign-out, and send the client secret by `basic` or `post`.                               |

Single sign-on works only with `PUBLIC_URL` set. At the provider, register `<API>/auth/oidc/<id>/callback` as the redirect URI and `<API>/auth/oidc/<id>/backchannel_logout` for logout, where `<API>` is `PUBLIC_API_URL` or `PUBLIC_URL` followed by `/api`. With `OIDC_<ID>_END_SESSION=true`, also register `PUBLIC_URL/login` as the post-logout URI.

`AUTH_REGISTRATION=sso` closes password sign-up and leaves new accounts to the providers. People can link and unlink providers on their own account in Settings → Profile → Sign-in.

## Provisioning (SCIM 2.0)

Set `SCIM_TOKEN` (32 characters or more, or `SCIM_TOKEN_FILE`) and enter `PUBLIC_URL/scim/v2` at the provider as its base URL, with that bearer token.

- `SCIM_DELETE`: `deactivate` (default) suspends a deleted user and keeps their data, `delete` deletes the account.
- `SCIM_PROVIDER`: sign-ins from this OIDC provider link to SCIM accounts by username.
- `SSO_GROUP_MAP`: JSON from a group to the servers it joins and the roles it grants, for example `'{"engineering":[{"server":"eng","role":"Developer"},{"server":"lobby"}]}'`. Roles given by hand stay.

The [settings reference](/docs/reference/settings/) has notes for Okta and Auth0. `deploy/authentik/README.md` walks through a local Authentik instance with sign-in, provisioning and group mapping.
