---
title: Site administration
description: The admin page of the instance and what each section changes.
sidebar:
  order: 12
---

The first account of an instance is its site admin. That account opens Site administration from the button of that name in the server rail. Nothing in the app shows anyone else that an account is the site admin.

| Section     | What it holds                                                                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview    | Counts of accounts and servers, the sign-up choice, accounts with temporary passwords and a summary of the server config.                                                                                                 |
| Features    | The site switches, grouped as Accounts, Servers, Privacy, Messages and files, Calls, P2P, Safety, Widgets, Encryption and This site's app. Turn off all P2P turns off P2P, P2P attachments and P2P backups in one change. |
| Branding    | Instance name, app name, short name, about text, links, the sign-in note, the instances the app suggests, images, and announcements.                                                                                      |
| Users       | Accounts: Create Account, New Temporary Password, Sign Out Everywhere, Remove Backup Phrase, Add to Server, Ban Site-wide and Delete User.                                                                                |
| Servers     | Every server with its channels, roles, members and bans. Also the default servers new accounts join, creating a server for an account, and the built-in server.                                                           |
| Audit log   | What the site admin and the server config changed, newest first.                                                                                                                                                          |
| Config      | The settings and limits of the server config, marked Pinned or Differs, and this copy's database pools and index builds.                                                                                                  |
| Danger zone | Delete a message for everyone, by its id.                                                                                                                                                                                 |

Each row of Features names its setting, for example `FEATURE_DOCS` for Documentation under This site's app. The [settings reference](/docs/reference/settings/) marks every setting the page can change with "Also on the admin page". A value set in `.env.local` applies at the next start, and an unchanged one leaves the page's choice. Settings listed in `SETTINGS_PINNED` follow the file at every start and are read-only on the page.

Changes reach open apps at once through the `settings_changed` event.
