---
title: What is stored where
description: What a device keeps of P2P identities, chats and files, and what an instance keeps.
sidebar:
  order: 5
---

## On each device

All P2P data lives in the browser, in one IndexedDB database per instance and account (`db.ts`). Another browser, profile or device holds nothing until it receives it from a peer or from an export.

| Store                                   | What it holds                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `self`, `idents`                        | Your identities: keys, device certificates and key chains.                                        |
| `contacts`                              | Contact cards and their state (outgoing, incoming, mutual).                                       |
| `rooms`, `events`, `children`, `outbox` | DM and server rooms, their signed events and the events waiting to reach peers.                   |
| `blobs`, `blob_parts`, `blob_hashes`    | Attachments, in 1 MiB blocks.                                                                     |
| `codes`                                 | Invite codes of P2P servers.                                                                      |
| `dropped`                               | Ids of P2P server events this device let go of, fetched again only when another event cites them. |
| `search`                                | The local search index.                                                                           |
| `meta`                                  | Settings and checks this browser made, such as account badge results.                             |

Browsers may evict site data under storage pressure. The app asks the browser to keep it (`navigator.storage.persist()`), and Safari on iPhone and iPad may still delete it after 7 days without a visit. An installed app keeps it longer. Settings → Sync config exports an encrypted copy of an identity, and the app shows the space P2P data takes in Settings → P2P.

## On the instance

P2P messages, files and room state stay off the instance. It keeps:

- The PeerJS registrations of connected tabs, in memory while they are connected.
- For a P2P file attached to a message on the instance: the message, with the file's name, size, type, hash and expiry.
- Per account, at most 8 identity records (`/api/v1/me/p2p_identity`): the creation record and key chain of identities made with a recovery phrase. They hold no secrets, and only the account reads them back.
- Sealed P2P backups uploaded to `/api/v1/me/p2p_backup`, while `FEATURE_P2P_BACKUP` is on, within `P2P_BACKUP_MAX_MIB` per version and `P2P_BACKUP_TOTAL_MIB` per account.

Account badges are signed on request and not stored. The instance profanity filter never reads or changes P2P content or P2P file names. Each person's own display filter only changes what they see.
