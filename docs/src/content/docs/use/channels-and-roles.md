---
title: Channels and roles
description: Text and voice channels, categories, threads, channel options, roles and permissions.
sidebar:
  order: 3
---

## Channels

A server holds text and voice channels, listed under categories. Channel names are unique within a server and hold up to 100 characters. Right-click a channel (long-press on a phone) for its actions.

In a text channel, messages support replies, mentions, reactions, edits, pins, forwarding, polls, link previews, file uploads with alt text, and spoilers written as `||text||`. A message can start a thread, where replies collect apart from the channel. Mentions reach a person by `@username`. `@everyone`, `@here` and role mentions take the Mention everyone permission, unless a role is mentionable.

Channel options, set by people who manage channels:

| Option             | Effect                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| Topic              | Plain text under the channel name, up to 1024 characters.                                                 |
| Slow mode          | Seconds between two messages of one member, 0 to 21600. Members with Bypass slow mode are exempt.         |
| Text only          | New messages may contain text only. Links stay readable as text, and earlier messages keep what they had. |
| Restricted viewing | Only the roles and members a rule lets view the channel, and people who manage channels, see it.          |
| Restricted sending | Only the roles and members a rule lets send, and people who manage channels, can post.                    |
| Sensitive          | The app asks before it opens the channel.                                                                 |

Anyone can also mark a channel sensitive on their own device. That consent stays on that device and in that profile.

A channel keeps up to `CHANNEL_PINS_MAX` pins (100 by default). Members without Read history see only the messages sent after they joined.

## Roles

Roles carry permissions and looks. Every member holds @everyone, which starts with the permissions marked Everyone in the [permissions reference](/docs/reference/permissions/). A member's other roles add to it.

- Order: a higher role ranks higher, and a member ranks by the highest role they hold. Kicks, bans and timeouts reach only members ranked below the moderator.
- Looks: a name color, an emoji icon after the name, and whether members show in a group of their own in the member list (for the first 10 such roles).
- Mentionable roles can be mentioned by anyone who can send in a channel.
- Channel permissions can also be set per role or per member on a channel, to allow or deny a bit there.

Separate permissions split an owner's work: Manage server for settings, Manage invites, Manage roles for editing roles, Assign roles for handing them out, Manage admins for making admins, and Delete server.
