---
title: Commits and rules
description: How commits look, and the rules every change keeps.
sidebar:
  order: 4
---

## Commits

- One commit per feature or fix, with a title of a few words (for example `Staff hiding`) and no body.
- Commits land on `main` only, with linear history and without force pushes.
- Every commit passes the [gates](/docs/contribute/gates/) on its exact tree.

## Rules every change keeps

- Hosted servers and P2P rooms (and hosted and P2P DMs) get each feature in the same commit, through one shared implementation where the logic is the same.
- The app reaches outside services at runtime only when the operator or user sets one up (S3, single sign-on, public STUN, relays). No request leaving the app carries anyone's email, name or other personal data.
- Everything an instance serves, and everything instances say to each other, uses HTTPS and WebSocket on its one public address. Only WebRTC between clients goes elsewhere. Services on other protocols (the STUN and TURN relay, the media server) are off by default.
- Every endpoint that touches a server, channel or message checks access through the access gate (`apps/server/src/api/access.rs`), and denials are uniform 404s.
- Invariants hold by construction: access, grants and similar properties are values that only the deciding code can make, and the code that relies on them takes such a value.
- Realtime events never carry unbounded user lists. Member and server lists load 50 at a time.
- Schema changes go into both the SQLite and Postgres schemas, with migrations for new columns. Columns and tables are never dropped or renamed.
- New REST endpoints have `#[utoipa::path]` with `///` docs and are registered in `openapi.rs`. API text is plain ASCII.
- Icon-only controls have a hover `title` and an `aria-label`. Usernames, display names and server names have the `streamer` class. Every message, channel, DM and server action is reachable by right-click on desktop and by long-press on touch.
- Light and dark themes both look right, and every screen works on a phone.
- Client settings live in localStorage per account through `writeLocal` and `home.scoped(...)` in `apps/web/app/lib/store.ts`, versioned and parsed defensively.
- Platform APIs (notifications, badges, clipboard, share, storage, files) go through the interfaces in `apps/web/app/lib/platform/`.
- UI copy is short and plain. The app never names itself, except in onboarding.

## Code style

Match the surrounding code with almost no comments. Rust uses exhaustive destructuring and `match`. TypeScript uses small functional components with zustand selectors, and styles use Tailwind with the Material 3 color tokens of `apps/web/app/globals.css`.
