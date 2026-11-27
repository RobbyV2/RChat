---
title: Rooms and sessions
description: How P2P devices find each other, open encrypted sessions and keep server rooms in sync.
sidebar:
  order: 2
---

P2P DMs and P2P servers run between browsers. The instance relays WebRTC signaling (PeerJS at `/peerjs` on its own address) and, when it offers them, STUN and TURN for connections across networks. It never sees the content: every byte between devices is encrypted by the devices themselves.

## Transport

A device registers a peer on the PeerJS server of its home instance and opens reliable binary data channels to other devices: `rcp1` for messages and `rcp1b` for attachments, opened when a file moves. ICE servers come from `GET /api/v1/p2p/ice`: the instance's STUN list and, with the built-in relay on, TURN credentials that last one hour. A person can add their own relays in Settings.

## Handshake

A session starts with a SIGMA-I handshake over the data channel (`handshake.ts`). The signaling server relays the SDP and could sit in the middle of DTLS. Confidentiality never relies on DTLS:

1. The initiator sends an ephemeral X25519 key and a nonce.
2. The responder answers with its own and, encrypted, its device certificate and a signature by its device key over a transcript bound to both peer ids.
3. The initiator sends its certificate and signature, encrypted.

The responder proves its device key first, and the initiator's identity travels encrypted after that: an active prober that answers a dial learns nothing about who dialed. Traffic keys come from HKDF over the shared secret and the transcript.

After the handshake, frames are `type (1 byte) | length (4 bytes) | payload`. Data frames use AES-256-GCM with a 96-bit counter nonce per direction, and a frame whose counter is not exactly the next one is refused: frames can't be replayed, dropped or reordered unnoticed (`frames.ts`). Both sides then exchange `hello` and typed messages. A device that sends malformed frames or abuses the session collects strikes and is dropped. Fields, operations and kinds a device does not know are ignored without a strike.

## DMs

A P2P DM is a room of two identities. Its events form a DAG: each event names the room heads it saw as `prev`, and both devices sync the events the other lacks when they meet. Calls in a DM are signaled over the same encrypted session (`signal.ts`), which binds the media keys to the device keys.

## P2P servers

A P2P server is a room many members share, identified by the id of its genesis event. It keeps two DAGs: the ACL (roles, members, invites, bans and settings) and the content (messages, edits, reactions, pins). Each event states the ACL heads its author knew, and every device computes from that position whether the author was entitled to it. Nothing an author asserts about their own authority counts.

Nobody connects to everyone. A member links a room with a bounded number of sessions, picks part of them itself and draws candidates at random, weighted towards members it shares more rooms with, moderators and members it already has a session with. Events spread hop by hop over these links (`gossip.ts`). Presence and typing travel one hop and only between joined members of that room.

People join with invite codes. A member serves another member only what belongs to their history: everything, only events since they joined, only the ACL (an invited person, or one redeeming a code), or nothing (`server/serve.ts`).
