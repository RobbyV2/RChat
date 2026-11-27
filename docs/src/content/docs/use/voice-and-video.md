---
title: Voice and video
description: Voice channels, calls in DMs, video and screen share, and how calls connect.
sidebar:
  order: 5
---

## Voice channels and calls

Joining a voice channel connects you to everyone in it. A voice channel holds up to `VOICE_ROOM_MAX` people (25 by default). A call in a DM rings the other person, with or without video. Voice channels and calls support video and screen share, and each person mutes their mic or deafens their sound. Server staff can mute guests in voice or take them out of it, and a timed-out member stays muted until the timeout ends.

A voice room or call with one person left ends after `VOICE_IDLE_SECS` (60 by default). The site admin can turn calls through the instance off (`FEATURE_CALLS`), which also ends running calls. P2P calls follow the P2P switch (`FEATURE_P2P`).

## How calls connect

Audio and video go between browsers over WebRTC. The instance relays the signaling to set up each connection and, by default, nothing else.

Settings → General → Connection helpers decides how far that goes:

- Use connection helpers: lets calls and P2P files connect across networks through the STUN servers and relay the instance offers. Helpers see your IP address, and what passes through them stays encrypted. Without helpers, devices connect only directly, which works on one network.
- Use relay only for P2P: sends everything through a TURN relay. Others then see only the relay's address, and calls may have more delay. It works when the instance runs a relay or you add your own.
- Your relays: your own STUN or TURN servers. Each side uses its own relays, and the app asks before it connects through someone else's relay that you don't know.

A direct connection shows both sides the other's IP address. A peer can always skip relays, and relay only is the one setting that hides your address.

## Instance options

The instance's operator decides what it offers: public STUN servers (`PUBLIC_STUN`), the built-in STUN and TURN relay on its own UDP ports (`RELAY_ENABLED`), other STUN or TURN servers (`ICE_SERVERS`), and a media server that forwards streams in larger calls (`SFU_ENABLED`, then the `FEATURE_SFU` switch). All of them are off by default.
