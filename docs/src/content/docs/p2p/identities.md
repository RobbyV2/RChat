---
title: Identities
description: Identity keys, device keys, recovery keys, contact cards, safety numbers and account badges.
sidebar:
  order: 1
---

A P2P identity is an Ed25519 key pair that lives in the browser. It belongs to no instance: the instance relays signaling and can vouch for it, and it never holds the private keys. The formats are in `apps/web/app/lib/p2p/keys.ts`, `chain.ts`, `card.ts` and `safety.ts`.

## Keys

| Key               | What it does                                                                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity key (IK) | The long-term "who". Its id is the base64url public key, 43 characters.                                                                                    |
| Device key (DK)   | One per browser profile. It runs handshakes and signs events. The identity key certifies each device key with a certificate `{v, ik, dk, created, label}`. |
| Recovery key      | Present on identities made with a recovery phrase. It signs the identity's key chain.                                                                      |

An identity made with a recovery phrase has a key chain: a creation record signed by the identity key and the recovery key, then up to 8 chain records, each signed by the recovery key in force at that point. The chain lets the owner replace and revoke keys from the phrase. An identity made without a recovery phrase lives only on its devices, and an encrypted export from Sync config moves it to another device.

Every signature covers a domain tag and the canonical JSON of the record. A signature made for one kind of record never verifies as another. Canonical JSON is the RFC 8785 subset in `canonical.ts`: keys sorted by UTF-16 code units, no whitespace, integers only within 2^53 - 1, and strings in NFC. Records that break these rules are refused.

| Tag                                                                                                 | Signed record                                                                                     |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `rchat-p2p-cert1`                                                                                   | Device certificate                                                                                |
| `rchat-p2p-revoke1`                                                                                 | Device revocation                                                                                 |
| `rchat-p2p-profile1`                                                                                | Profile (name and picture)                                                                        |
| `rchat-p2p-succ1`                                                                                   | Succession to a new identity                                                                      |
| `rchat-p2p-bind1`                                                                                   | Proof for an account badge                                                                        |
| `rchat-p2p-ev1`, `rchat-p2p-sig1`                                                                   | DM events                                                                                         |
| `rchat-p2p-ev2`, `rchat-p2p-sig2`                                                                   | P2P server events                                                                                 |
| `rchat-p2p-create1`, `rchat-p2p-chain1`                                                             | The creation record and chain records of an identity with a key chain                             |
| `rchat-p2p-cert2`, `rchat-p2p-crevoke2`, `rchat-p2p-profile2`, `rchat-p2p-succ2`, `rchat-p2p-bind2` | Certificates, revocations, profiles, successions and badge proofs of an identity with a key chain |

## Contact cards

A contact card is `rcp1.` followed by base64url of the deflated canonical JSON. It carries the identity key, its device certificates, a claimed name and the instance whose signaling server the identity uses. Adding a card makes the contact outgoing until the other side accepts. An identity that reaches you first lands in Message requests, and accepting makes the contact mutual.

The name on a card is a claim. A name you choose for a contact replaces it on your device, and the safety number confirms the contact's key.

## Safety numbers

A safety number is 60 digits in 12 groups of 5. Each identity contributes 30 digits: SHA-512 iterated 5200 times over a version, the identity key (with the digest of the recovery key, when it has one) and a fixed string. Both sides sort the two halves by key and see the same number. Comparing it, or scanning the other device's QR code (`rcv1.`), confirms the contact.

## Account badges

An account on an instance can show "Confirmed as alice@host" on its P2P identity. `POST /api/v1/identity/p2p_binding` takes a signature by the identity key (or, for an identity with a key chain, by a primary key of one of its heads) and answers with a JWT that states `username@host` holds the key. The token lasts 7 days, and the app asks for a new one every day while the badge is on. Peers check it against `/.well-known/jwks.json` of the issuing instance. Nothing is stored: a binding can't be revoked before it expires.
