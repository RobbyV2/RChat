---
title: Files
description: How P2P attachments move between devices, in P2P chats and in chats on an instance.
sidebar:
  order: 4
---

P2P files never touch the instance. They stay in the sender's browser and move straight to the people who open them.

## In P2P DMs and P2P servers

A file is split into 1 MiB blocks and named by a root hash over the block hashes (`blobs.ts`). The message that carries it signs that hash. Blocks move over a separate encrypted pipe per session (`rcp1b`), opened when a file moves, and transfers never hold up chat. Every block is checked against its hash before it is stored. A download can take blocks from several holders at once, and it resumes after a disconnect or a reload.

A holder serves a file only to a contact who shares a conversation with a live message that carries it, and checks that again for every block. A deleted message stops its file from being served. The sender makes thumbnails, and the receiver checks them again before it shows one.

## Profile pictures

A P2P identity sets a picture in Settings → P2P, and one per P2P server in its server profile. The device crops the image and makes 128 and 512 pixel files of at most 256 KiB each, as an instance does for an upload. The profile names both files by hash: `pic` beside the signed profile sent to contacts and in the `profile` write of each server, and `rpic` for a picture of one server. Only the device that made a picture serves its files: to the mutual contacts of its owner, and to the joined members of a server that shows it. A hash that someone else names as their picture fetches nothing from a device that holds that file for another reason. A receiver shows a file only when its bytes are a PNG or JPEG image.

## In channels and DMs on an instance

With `P2P_ATTACHMENTS` on, people can attach P2P files to messages in channels and DMs of the instance. The message goes through the instance, and the file stays in the sender's tab:

1. The sender's tab announces the files it holds with the `p2p_hosting` WebSocket frame.
2. A reader asks with `p2p_peer` for the message's file. The instance checks that the reader may see the message and answers with the hoster's peer id and a short-lived download token.
3. The reader's browser connects to the hoster's tab over WebRTC and downloads the file, which the hoster serves only with a valid token.

A file is available while the sender is online and still holds it. The sender picks an expiry when sending, or keeps it until removed. Uploads to the instance itself follow its upload limits and file expiry.

## Connections and privacy

A direct WebRTC connection shows each side the other's IP address. With connection helpers off, devices connect only directly. With a relay (the instance's built-in relay, or your own TURN servers), media and files may pass through it, still encrypted. Settings → General → Connection helpers chooses between them.
