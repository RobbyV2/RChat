import { sha256 } from '@noble/hashes/sha2.js'
import { isRecord } from '../bytes'
import { b64u, bytesOf, canonicalBytes, concat, hasKeys, utf8, isInt } from './canonical'
import type { ProofHeader } from './acl/admit'
import { aclContentOk, RULES_VERSION, type AclContent, type AclEv } from './acl/rules'
import type { ContentEv } from './acl/visibility'
import { AGREED } from './limits'
import { isKeyId, keyBytes, keyId, sign, verify, type KeyPair } from './keys'
import {
  contentHash,
  isEventId,
  isTypeName,
  checkContent,
  contentMax,
  sizeOf,
  type Author,
  type Content,
} from './content'

// ----- Format v2 (P2P servers, ACL spec §1.2) -----

// The known content kinds, all posted in a channel (§1.4); other kinds are opaque.
export const CHANNEL_CONTENT: readonly string[] = [
  'msg',
  'edit',
  'redact',
  'react',
  'pin',
  'call',
  'move',
]

// What this browser signs again from a new key when a rotation drops its old one (spec 3.9).
export const RESIGN_CONTENT = ['msg', 'edit', 'redact', 'react', 'pin']

// A v2 core: every server event, ACL (`L` "a") or content (`L` "c"), signed by a device. Nothing
// the sender asserts about authority is in it; admission computes everything from the position.
export interface CoreV2 {
  v: 2
  // the server id (the genesis event's id); absent only on the genesis
  srv?: string
  t: string
  L: 'a' | 'c'
  a: string
  dev: string
  // per (srv, dev), strictly increasing over all the device's events in the server
  seq: number
  // ACL parents: the ACL heads the author knew (absent only on the genesis)
  ap?: string[]
  // ACL events: the device's previous ACL event; identity ops: the identity's previous one
  aprev?: string
  iprev?: string
  // content events: content parents (display order) and the device's previous content event
  prev?: string[]
  cprev?: string
  ts: number
  ch: string
}

export interface WireV2 {
  ev: CoreV2
  c: Record<string, unknown> | null
  sig: string
}

export const TAG_EVENT2 = 'rchat-p2p-ev2\0'

export const TAG_SIG2 = 'rchat-p2p-sig2\0'

export const LIMITS2 = {
  core: 2048,
  aclContent: 4096,
  migrateContent: 16 * 1024,
  ap: AGREED.ap,
  prev: 10,
}

export const eventIdBytes2 = (core: CoreV2) =>
  sha256(concat(utf8(TAG_EVENT2), canonicalBytes(core)))

export const eventId2 = (core: CoreV2) => b64u(eventIdBytes2(core))

const sigInput2 = (idBytes: Uint8Array) => concat(utf8(TAG_SIG2), idBytes)

export interface ChainFields {
  seq: number
  ap?: string[]
  aprev?: string
  iprev?: string
  prev?: string[]
  cprev?: string
}

// Signs a new v2 event. `srv` is null for the genesis.
export const buildEvent2 = (
  author: Author,
  srv: string | null,
  t: string,
  L: 'a' | 'c',
  content: Record<string, unknown>,
  chain: ChainFields,
  ts: number
): { id: string; wire: WireV2 } => {
  const core: CoreV2 = {
    v: 2,
    t,
    L,
    a: keyId(author.ik.pk),
    dev: keyId(author.dk.pk),
    seq: chain.seq,
    ts,
    ch: contentHash(content as Content),
  }
  if (srv !== null) core.srv = srv
  if (chain.ap) core.ap = chain.ap.slice(0, LIMITS2.ap)
  if (chain.aprev !== undefined) core.aprev = chain.aprev
  if (chain.iprev !== undefined) core.iprev = chain.iprev
  if (L === 'c') core.prev = (chain.prev ?? []).slice(0, LIMITS2.prev)
  if (chain.cprev !== undefined) core.cprev = chain.cprev
  const idBytes = eventIdBytes2(core)
  const sig = b64u(sign(author.dk.sk, sigInput2(idBytes)))
  return { id: b64u(idBytes), wire: { ev: core, c: content, sig } }
}

export type Invalid2 = 'shape' | 'size' | 'server' | 'signature' | 'content'

export type Checked2 = { ok: true; id: string; wire: WireV2 } | { ok: false; why: Invalid2 }

const ids = (x: unknown, min: number, max: number) =>
  Array.isArray(x) &&
  x.length >= min &&
  x.length <= max &&
  new Set(x).size === x.length &&
  x.every(isEventId)

const isCore2 = (x: unknown): x is CoreV2 => {
  if (!isRecord(x) || !hasKeys(x, ['v', 't', 'L', 'a', 'dev', 'seq', 'ts', 'ch'])) return false
  const genesis = x.t === 'genesis'
  const acl = x.L === 'a'
  return (
    x.v === 2 &&
    isTypeName(x.t) &&
    (acl || x.L === 'c') &&
    (!genesis || acl) &&
    isKeyId(x.a) &&
    isKeyId(x.dev) &&
    isInt(x.seq) &&
    isInt(x.ts) &&
    typeof x.ch === 'string' &&
    bytesOf(x.ch, 32) !== null &&
    (genesis
      ? x.srv === undefined && x.ap === undefined && x.seq === 0
      : typeof x.srv === 'string' && bytesOf(x.srv, 32) !== null && ids(x.ap, 1, LIMITS2.ap)) &&
    (x.aprev === undefined || (acl && isEventId(x.aprev))) &&
    (x.iprev === undefined || (acl && isEventId(x.iprev))) &&
    (acl ? x.prev === undefined : ids(x.prev ?? [], 0, LIMITS2.prev)) &&
    (x.cprev === undefined || (!acl && isEventId(x.cprev)))
  )
}

// The id a v2 event claims, when its core is well formed.
export const claimedId2 = (raw: unknown): string | null => {
  if (!isRecord(raw) || !isCore2(raw.ev)) return null
  try {
    return eventId2(raw.ev)
  } catch {
    return null
  }
}

// A signed core of the same server (one side of a proof), verified.
const signedHeader = (x: unknown, srv: string | null): x is { ev: CoreV2; sig: string } => {
  if (!isRecord(x) || !isCore2(x.ev) || x.ev.t === 'genesis' || x.ev.srv !== srv) return false
  const s = bytesOf(x.sig, 64)
  const pk = keyBytes(x.ev.dev)
  try {
    return !!s && !!pk && verify(pk, sigInput2(eventIdBytes2(x.ev)), s)
  } catch {
    return false
  }
}

// A dropped event's header or a proof side: the core of server `srv` with id `id`, signed by its
// device (the signature covers the core, so content the header left out doesn't matter).
export const headerOk = (id: string, x: unknown, srv: string): x is { ev: CoreV2; sig: string } => {
  if (!signedHeader(x, srv)) return false
  try {
    return eventId2(x.ev) === id
  } catch {
    return false
  }
}

export const TAG_UPGRADE = 'rchat-p2p-upgrade2\0'

const upgradeInput = (srv: string, g: unknown) =>
  concat(utf8(TAG_UPGRADE), utf8(srv), utf8('\0'), canonicalBytes(g))

// A co-owner's countersignature of an upgrade of server `srv` to the new genesis `g` (§3.8).
export const signUpgrade = (ik: KeyPair, srv: string, g: unknown) =>
  b64u(sign(ik.sk, upgradeInput(srv, g)))

export const upgradeSigOk = (ik: string, srv: string, g: unknown, sig: unknown) => {
  const pk = keyBytes(ik)
  const sb = bytesOf(sig, 64)
  try {
    return !!pk && !!sb && verify(pk, upgradeInput(srv, g), sb)
  } catch {
    return false
  }
}

// Identity records (§1.1): a device revocation is signed by the identity's primary or recovery
// key over (srv, dk, seen), any member may relay it; a rotation by its recovery key over the
// record, its position (iprev) and the device that posts it, which must be the identity's (two
// relayed copies of one record would contest it, §2.3). Until identities have separate recovery
// and primary keys, the identity key plays both.
export const TAG_REVOKE = 'rchat-p2p-revoke2\0'

export const TAG_ROTATE = 'rchat-p2p-rotate2\0'

const revokeInput = (srv: string, c: { ik: unknown; dk: unknown; seen: unknown }) =>
  concat(
    utf8(TAG_REVOKE),
    utf8(srv),
    utf8('\0'),
    canonicalBytes({ ik: c.ik, dk: c.dk, seen: c.seen })
  )

const rotateInput = (
  srv: string,
  dev: string,
  iprev: string | undefined,
  c: { ik: unknown; pcert?: unknown; keep?: unknown; seen?: unknown }
) =>
  concat(
    utf8(TAG_ROTATE),
    utf8(srv),
    utf8('\0'),
    canonicalBytes({
      ik: c.ik,
      dev,
      iprev: iprev ?? '',
      pcert: c.pcert ?? '',
      keep: c.keep ?? [],
      seen: c.seen ?? {},
    })
  )

export const signRevocation2 = (ik: KeyPair, srv: string, dk: string, seen: number) =>
  b64u(sign(ik.sk, revokeInput(srv, { ik: keyId(ik.pk), dk, seen })))

export const signRotation2 = (
  ik: KeyPair,
  srv: string,
  dev: string,
  iprev: string | undefined,
  c: { pcert?: string; keep?: string[]; seen?: Record<string, number> }
) => b64u(sign(ik.sk, rotateInput(srv, dev, iprev, { ...c, ik: keyId(ik.pk) })))

const signedBy = (ik: unknown, msg: () => Uint8Array, sig: unknown) => {
  const pk = keyBytes(ik)
  const sb = bytesOf(sig, 64)
  try {
    return !!pk && !!sb && verify(pk, msg(), sb)
  } catch {
    return false
  }
}

const contentOk2 = (ev: CoreV2, c: Record<string, unknown>, rules: number) => {
  if (rules !== RULES_VERSION) return true
  if (ev.L === 'c') return checkContent(ev.t, c)
  if (!KNOWN_ACL.includes(ev.t)) return true
  if (!aclContentOk(ev.t, c)) return false
  const srv = ev.srv ?? null
  if (ev.t === 'device_revoke')
    return (
      srv !== null &&
      signedBy(
        c.ik,
        () => revokeInput(srv, c as { ik: unknown; dk: unknown; seen: unknown }),
        c.rec
      )
    )
  if (ev.t === 'primary_rotate')
    return (
      srv !== null &&
      c.ik === ev.a &&
      signedBy(c.ik, () => rotateInput(srv, ev.dev, ev.iprev, c as { ik: unknown }), c.rsig)
    )
  if (ev.t === 'proof')
    return (
      signedHeader(c.x, srv) &&
      signedHeader(c.y, srv) &&
      (c.x as { ev: CoreV2 }).ev.dev === (c.y as { ev: CoreV2 }).ev.dev
    )
  if (ev.t === 'upgrade') {
    if (!isRecord(c.g) || srv === null) return false
    const sigs = c.sigs ?? {}
    if (!isRecord(sigs)) return false
    for (const [ik, sg] of Object.entries(sigs)) {
      const pk = keyBytes(ik)
      const sb = bytesOf(sg, 64)
      try {
        if (!pk || !sb || !verify(pk, upgradeInput(srv, c.g), sb)) return false
      } catch {
        return false
      }
    }
  }
  return true
}

// Schema, sizes, id, `ch` and the device's signature: everything that needs no other event. The
// device's binding to its identity, the chains and authority are admission (acl/admit.ts).
// `srv`: the server the event must belong to; null to check a genesis on its own. `rules`: the
// server's rules version; content of a version this client doesn't know is not checked.
export const validate2 = (
  raw: unknown,
  srv: string | null,
  rules: number = RULES_VERSION
): Checked2 => {
  if (!isRecord(raw) || !hasKeys(raw, ['ev', 'c', 'sig'])) return { ok: false, why: 'shape' }
  const { ev, c, sig } = raw
  if (!isCore2(ev) || (c !== null && !isRecord(c))) return { ok: false, why: 'shape' }
  const cMax =
    ev.L === 'a'
      ? ev.t === 'migrate'
        ? LIMITS2.migrateContent
        : LIMITS2.aclContent
      : contentMax(c)
  if (sizeOf(ev) > LIMITS2.core || (c !== null && sizeOf(c) > cMax))
    return { ok: false, why: 'size' }
  if (ev.t === 'genesis' ? srv !== null : ev.srv !== srv) return { ok: false, why: 'server' }
  let idBytes: Uint8Array
  try {
    idBytes = eventIdBytes2(ev)
  } catch {
    return { ok: false, why: 'shape' }
  }
  const s = bytesOf(sig, 64)
  const pk = keyBytes(ev.dev)
  if (!s || !pk || !verify(pk, sigInput2(idBytes), s)) return { ok: false, why: 'signature' }
  if (c !== null) {
    if (!contentOk2(ev, c, rules)) return { ok: false, why: 'content' }
    let hash: string
    try {
      hash = contentHash(c as Content)
    } catch {
      return { ok: false, why: 'content' }
    }
    if (hash !== ev.ch) return { ok: false, why: 'content' }
  } else if (ev.L === 'a') return { ok: false, why: 'content' }
  return { ok: true, id: b64u(idBytes), wire: { ev, c, sig: sig as string } }
}

// The ACL types whose content has a schema (acl/rules.ts); others are stored and inert.
const KNOWN_ACL: readonly string[] = [
  'genesis',
  'add',
  'uninvite',
  'join',
  'leave',
  'kick',
  'ban',
  'unban',
  'role_create',
  'role_move',
  'role_bits',
  'role_del',
  'assign',
  'revoke',
  'channel',
  'chperm',
  'settings',
  'code',
  'code_revoke',
  'profile',
  'mark',
  'device_add',
  'device_revoke',
  'primary_rotate',
  'proof',
  'upgrade',
  'migrate',
]

// A proof side as the ACL core reads it (acl/admit.ts ProofHeader), from a verified signed core.
const proofHeaderOf = (x: { ev: CoreV2 }): ProofHeader => {
  const h: ProofHeader = { id: eventId2(x.ev), dev: x.ev.dev, seq: x.ev.seq, L: x.ev.L }
  if (x.ev.aprev !== undefined) h.aprev = x.ev.aprev
  if (x.ev.cprev !== undefined) h.cprev = x.ev.cprev
  if (x.ev.ap) h.ap = x.ev.ap
  return h
}

// A validated v2 ACL event as the ACL core reads it (a proof's sides as headers; a relayed
// device revocation acting for its `ik`, §1.6).
export const aclEvOf = (id: string, w: WireV2): AclEv => {
  const ik = w.c?.ik
  const relay = w.ev.t === 'device_revoke' && typeof ik === 'string' && ik !== w.ev.a
  const e: AclEv = {
    id,
    t: w.ev.t,
    a: relay ? ik : w.ev.a,
    dev: w.ev.dev,
    seq: w.ev.seq,
    ap: w.ev.ap ?? [],
    ts: w.ev.ts,
    c: (w.c ?? {}) as AclContent,
  }
  if (w.ev.t === 'proof' && w.c)
    e.c = {
      ...w.c,
      x: proofHeaderOf(w.c.x as { ev: CoreV2 }),
      y: proofHeaderOf(w.c.y as { ev: CoreV2 }),
    } as unknown as AclContent
  if (relay) e.relay = w.ev.a
  if (w.ev.aprev !== undefined) e.aprev = w.ev.aprev
  if (w.ev.iprev !== undefined) e.iprev = w.ev.iprev
  return e
}

// A validated v2 content event as content admission and visibility read it.
export const contentEvOf = (id: string, w: WireV2): ContentEv => {
  const m: ContentEv = {
    id,
    t: w.ev.t,
    a: w.ev.a,
    dev: w.ev.dev,
    seq: w.ev.seq,
    ap: w.ev.ap ?? [],
    ts: w.ev.ts,
    c: w.c,
  }
  if (w.ev.cprev !== undefined) m.cprev = w.ev.cprev
  return m
}
