---
title: Events and signatures
description: The signed event formats of P2P DMs and P2P servers, how they are checked and how they stay compatible.
sidebar:
  order: 3
---

Everything said in a P2P room is a signed event. An event has a core, which is hashed and signed, and content, which sits outside the core and is bound to it by its hash `ch`. A redaction drops the content and keeps the core and signature: the event stays verifiable and stays in the room's DAG.

The event id is the base64url SHA-256 of a domain tag and the canonical JSON of the core. The device key signs a second tag and the id. A device checks every event in full before it stores it.

## DM events (format 1)

Defined in `apps/web/app/lib/p2p/event_v1.ts`.

| Field           | Meaning                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| `v`             | `1`                                                                                                    |
| `room`          | The room id.                                                                                           |
| `type`          | `msg`, `edit`, `redact`, `react`, `pin`, `move` or `call`.                                             |
| `sender`, `dev` | The identity key and the device key.                                                                   |
| `ts`            | The sender's clock in milliseconds. Devices show it at most 5 minutes ahead of when the event arrived. |
| `depth`, `prev` | One more than the deepest head, and up to 10 room heads the sender saw.                                |
| `ch`            | The hash of the content.                                                                               |

Tags: `rchat-p2p-ev1` for the id, `rchat-p2p-sig1` for the signature. A message body holds up to 4000 characters, 20 mentions and 50 files. A `move` event, written by a new device after a device move, vouches for the events the old device made before it.

## Server events (format 2)

Defined in `event_v2.ts`. A P2P server is the DAG that grows from its genesis event, and the server id is the genesis event's id.

| Field            | Meaning                                                                          |
| ---------------- | -------------------------------------------------------------------------------- |
| `v`              | `2`                                                                              |
| `srv`            | The server id; absent only on the genesis.                                       |
| `t`, `L`         | The event type, and its layer: `a` for the ACL, `c` for content.                 |
| `a`, `dev`       | The author's identity key and the signing device.                                |
| `seq`            | Counts the device's events in the server, strictly increasing.                   |
| `ap`             | The ACL heads the author knew.                                                   |
| `aprev`, `iprev` | The device's previous ACL event, and the identity's previous identity operation. |
| `prev`, `cprev`  | Content parents in display order, and the device's previous content event.       |
| `ts`, `ch`       | The time and the content hash.                                                   |

Tags: `rchat-p2p-ev2` and `rchat-p2p-sig2`. Content events are `msg`, `edit`, `redact`, `react`, `pin`, `call` and `move`, posted in a channel. ACL events cover membership (`add`, `uninvite`, `join`, `leave`, `kick`, `ban`, `unban`, `timeout`), roles (`role_create`, `role_move`, `role_bits`, `role_del`, `assign`), channels and their permissions (`channel`, `chperm`), invite codes (`code`, `code_revoke`), settings and profiles (`settings`, `profile`) and keys (`device_add`, `device_revoke`, `primary_rotate`, `revoke`, `upgrade`, `migrate`).

Admission computes authority from the event's position in the ACL DAG: whether the author held the permission (see the [permission bits](/docs/reference/permissions/)) at the ACL heads in `ap`. A member who is timed out can still delete in a channel, and nothing else. Concurrent ACL changes resolve the same way on every device.

## Revoked devices

An event signed by a device that was revoked later, with a time before the revocation, cannot be told apart from a backdated event made with a stolen key. A device keeps such an event only when it already had it, or when a good device of the sender vouches for it.

## Compatibility

Every parser follows one rule: fields, operations and kinds it does not know are ignored without a strike. Fields it does not know are kept, being signed and hashed, and never read. An event of a type it does not know is checked, stored and synced like any other and never shown. The DAG stays whole when a newer device writes one. Strikes are only for malformed known fields, bad signatures, abuse volume or requests the sender is not entitled to.
