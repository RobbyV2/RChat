---
title: P2P contacts and servers
description: P2P identities, contacts, DMs, P2P servers, calls and files that live on your devices.
sidebar:
  order: 6
---

P2P chats live on the devices of the people in them. The instance helps devices find each other and never stores or reads the messages. P2P is on unless the site admin turned it off (`FEATURE_P2P`). The [P2P protocol](/docs/p2p/identities/) pages describe how it works.

## Your P2P identity

The Peer-to-peer tile in the server rail opens your P2P contacts. The first time, Add a P2P identity creates one on this device, with a recovery phrase or without one. The identity is stored in this browser: to move it to another device, export an encrypted copy from Settings → Sync config. Safari on iPhone and iPad may delete site data after 7 days without a visit, and an installed app keeps it longer.

An account can show an account badge on its P2P identity ("Confirmed as alice@host"), signed by its instance.

## Contacts and DMs

Add contact takes another person's code (Show my code shows yours, also as a QR code). The contact gets a request and sees it the next time you are both online. Accepting it makes you contacts, and you can start a P2P DM. Requests from people you haven't added land in Message requests, where you accept, ignore or block them.

Verify a contact by comparing safety numbers or scanning each other's QR code. A contact who shows a new key is marked "New key: verify before you trust it".

## P2P servers

Create or join a P2P server from the server rail. A P2P server has channels, roles, permissions, threads, pins, reactions, voice and moderation like a hosted server. Invite people makes an invite code (shown as a QR code too), and Join with a code joins one. Members sync with each other directly: a server stays available while any member who holds it is online.

## Calls and files

P2P DMs and P2P servers have voice and video calls and file attachments, all between devices. A file stays on the sender's device and moves straight to the people who open it, in 1 MiB blocks checked against their hash. Members you connect with can see your IP address unless you use relay only (Settings → General → Connection helpers).

Hosted channels and DMs can carry P2P attachments too, when the instance allows them: the message goes through the instance, and the file stays in the sender's browser while it is open.

## Storage

Everything P2P is in this browser's storage, per instance and account. Settings → P2P shows your identity, devices, files and the storage they take on this device. The menu of the P2P contacts page removes P2P data from this browser.
