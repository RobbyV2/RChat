---
title: Servers
description: Creating and joining servers, invites and passwords, server settings and moderation.
sidebar:
  order: 2
---

A server is a group of channels with its own members and roles. Hosted servers live on an instance, and [P2P servers](/docs/use/p2p/) on their members' devices. Every instance starts with a built-in server, `rchat`, that new accounts join unless the instance changed its default servers.

## Joining and creating

Add a server in the server rail opens a dialog with Create and Join tabs. The server name doubles as its invite code: Join takes a server name or an invite link, with the server's password when it has one. Who may create servers and how people join them at all are site settings.

A server's managers choose how people join it under Server settings → Access:

| Mode       | Who can join                                                      |
| ---------- | ----------------------------------------------------------------- |
| `name`     | Anyone who knows the name.                                        |
| `invite`   | People with an invite link, or with a password the managers made. |
| `password` | People with the name and the server's password.                   |
| `closed`   | Nobody new. Members stay.                                         |

To anyone without access, a password-protected or invite-only server answers like a server that does not exist. Access also sets whether people who aren't members can read the server, and whether guests may chat or join voice there.

## Server settings

The gear next to the server name opens Server settings, and so does a right-click (long-press on a phone) on the server in the rail. Each person sees the sections their permissions reach:

| Section         | What it holds                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Invites         | The invite link, for everyone who can open the settings.                                                                      |
| Overview        | Name, about text, icon, picture, banner and name colors.                                                                      |
| Widgets         | Chat and voice channels other sites can embed.                                                                                |
| System messages | Where join and leave messages go.                                                                                             |
| Uploads         | How long files posted in the server are kept, within the instance's limit.                                                    |
| Server profiles | What members may set in their own profile in this server.                                                                     |
| Access          | Join mode, passwords, public reading and guest participation.                                                                 |
| Roles           | Roles, their permissions, looks and order.                                                                                    |
| Channels        | Channels and categories, with permissions per role and per member.                                                            |
| Members         | Members, their roles, and admins.                                                                                             |
| Bans            | Banned accounts.                                                                                                              |
| Integrations    | Webhooks: incoming ones post into a channel, outgoing ones send the server's events to a URL, where the instance allows them. |
| Audit log       | Who changed what, kept for `AUDIT_KEEP_DAYS` (90 by default).                                                                 |
| Delete server   | For members who hold Delete server, in every server but the built-in one.                                                     |

[Channels and roles](/docs/use/channels-and-roles/) lists the permissions that open each part.

## Moderation

Members with the matching permissions kick, ban and time out members, and delete and pin messages. A timeout lasts from 1 second to 28 days. Until it ends, the member reads the server and can't send, react, edit, start threads, vote, type or join voice, and their DMs stay as they are. Moderation actions land in the server's audit log.
