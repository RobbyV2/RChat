---
title: Settings and privacy
description: What each settings section holds, streamer mode, links, notifications and moving settings between devices.
sidebar:
  order: 8
---

Settings opens from the gear in the server rail, and a search finds any row. App settings live in this browser, per account. Privacy choices are stored with your account on the instance.

| Section         | What it holds                                                                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Profile         | The signed-in account and the instance it is on, your profile, sign-in (password, sign-in methods, backup phrase, deleting the account) and the instance's details.                 |
| Privacy         | Who can DM you and send you friend requests, who can see your profile, link warnings and blocked users.                                                                             |
| General         | Appear offline, typing indicators, the profanity display filter, spoilers, connection helpers and your relays, announcements, theme, animations, streamer mode and the desktop app. |
| Notifications   | Desktop notifications, and custom settings for servers and DMs.                                                                                                                     |
| Command palette | What the palette's search index keeps.                                                                                                                                              |
| Sync config     | Export, import or share your settings.                                                                                                                                              |
| P2P             | Your P2P identity, files, devices and storage on this device.                                                                                                                       |
| About and help  | These docs, how accounts, files, calls and servers work on the instance, keyboard shortcuts and moderation.                                                                         |

## What some rows do

- Appear offline (General): you never appear online to others.
- Typing indicators (General): off hides when others type and stops sending yours.
- Filter profanity (General): masks profanity in the messages and names you see, P2P chats included. It changes only what you see, never what is stored or sent.
- Links (Privacy): a warning before outside links open, removal of tracking parameters, and domains you trust.
- Streamer mode (General): blurs server names, usernames and DM names until you hover over them.

The instance may also filter profanity in server content before it is posted, when its admin turned that on. DMs, passwords and P2P content are never filtered by the instance.

## Sync config

Sync config exports your settings as an encrypted file, a QR code or a share link that expires, and imports them on another device. You choose which sections go along. A P2P identity can travel in an export too. Importing it into an app stores the identity key there, and whoever controls that app can read your P2P messages and act as you. The app asks you to confirm that you trust it.
