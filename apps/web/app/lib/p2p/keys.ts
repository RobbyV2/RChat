import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { isRecord } from '../bytes'
import { b64u, bytesOf, canonicalBytes, concat, nfc, utf8 } from './canonical'

// Identity key (IK): the long-term "who"; its id is the base64url public key (43 chars).
// Device key (DK): one per browser profile; it runs handshakes and signs events. The IK
// certifies each DK. Every signature covers a domain tag plus the canonical JSON of the record,
// so a signature made for one kind of record never verifies as another.

export const TAG = {
  cert: 'rchat-p2p-cert1\0',
  revoke: 'rchat-p2p-revoke1\0',
  profile: 'rchat-p2p-profile1\0',
  succession: 'rchat-p2p-succ1\0',
  peer: 'rchat-p2p-peer\0',
  bind: 'rchat-p2p-bind1\0',
  offer: 'rchat-p2p-offer1\0',
} as const

export interface KeyPair {
  sk: Uint8Array
  pk: Uint8Array
}

export const newKeyPair = (): KeyPair => {
  const { secretKey, publicKey } = ed25519.keygen()
  return { sk: secretKey, pk: publicKey }
}

export const publicOf = (sk: Uint8Array) => ed25519.getPublicKey(sk)

export const keyId = (pk: Uint8Array) => b64u(pk)

// A public key must be a canonical encoding of a point outside the small-order subgroup: a
// small-order key "signs" for anyone.
const strongKey = (pk: Uint8Array) => {
  try {
    return !ed25519.Point.fromBytes(pk, false).isSmallOrder()
  } catch {
    return false
  }
}

export const keyBytes = (id: unknown) => {
  const b = bytesOf(id, 32)
  return b && strongKey(b) ? b : null
}

export const isKeyId = (id: unknown): id is string => keyBytes(id) !== null

const SIG_LEN = 64

export const signTagged = (sk: Uint8Array, tag: string, body: unknown) =>
  b64u(ed25519.sign(concat(utf8(tag), canonicalBytes(body)), sk))

export const verifyTagged = (pk: string, tag: string, body: unknown, sig: unknown) => {
  const key = keyBytes(pk)
  const s = bytesOf(sig, SIG_LEN)
  if (!key || !s) return false
  try {
    return ed25519.verify(s, concat(utf8(tag), canonicalBytes(body)), key, { zip215: false })
  } catch {
    return false
  }
}

export const sign = (sk: Uint8Array, msg: Uint8Array) => ed25519.sign(msg, sk)

export const verify = (pk: Uint8Array, msg: Uint8Array, sig: Uint8Array) => {
  try {
    return (
      sig.length === SIG_LEN && strongKey(pk) && ed25519.verify(sig, msg, pk, { zip215: false })
    )
  } catch {
    return false
  }
}

const isInt = (x: unknown, min = 0): x is number => Number.isSafeInteger(x) && (x as number) >= min

// Exactly these keys (optional ones may be missing), so unsigned extras can't ride along.
const onlyKeys = (x: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every(k => k in x) &&
  Object.keys(x).every(k => required.includes(k) || optional.includes(k))

export const LABEL_MAX = 64
export const NAME_MAX = 32

// ----- Device certificate -----

export interface Cert {
  v: 1
  ik: string
  dk: string
  created: number
  label: string
  sig: string
}

export const certBody = ({ v, ik, dk, created, label }: Cert) => ({ v, ik, dk, created, label })

export const signCert = (ik: KeyPair, dk: Uint8Array, created: number, label: string): Cert => {
  const body = {
    v: 1 as const,
    ik: keyId(ik.pk),
    dk: keyId(dk),
    created,
    label: nfc(label).slice(0, LABEL_MAX),
  }
  return { ...body, sig: signTagged(ik.sk, TAG.cert, body) }
}

export const isCert = (x: unknown): x is Cert => {
  if (!isRecord(x) || !onlyKeys(x, ['v', 'ik', 'dk', 'created', 'label', 'sig'])) return false
  const { v, ik, dk, created, label } = x
  return (
    v === 1 &&
    isKeyId(ik) &&
    isKeyId(dk) &&
    isInt(created) &&
    typeof label === 'string' &&
    label.length <= LABEL_MAX
  )
}

export const verifyCert = (x: unknown, ik?: string): x is Cert => {
  if (!isCert(x) || (ik !== undefined && x.ik !== ik)) return false
  try {
    return verifyTagged(x.ik, TAG.cert, certBody(x), x.sig)
  } catch {
    return false
  }
}

// ----- Device revocation -----

export interface Revocation {
  v: 1
  ik: string
  dk: string
  revoked_at: number
  successor?: string
  sig: string
}

const revocationBody = ({ v, ik, dk, revoked_at, successor }: Revocation) =>
  successor === undefined ? { v, ik, dk, revoked_at } : { v, ik, dk, revoked_at, successor }

export const signRevocation = (
  ik: KeyPair,
  dk: string,
  revokedAt: number,
  successor?: string
): Revocation => {
  const body: Omit<Revocation, 'sig'> = { v: 1, ik: keyId(ik.pk), dk, revoked_at: revokedAt }
  if (successor !== undefined) body.successor = successor
  return { ...body, sig: signTagged(ik.sk, TAG.revoke, body) }
}

export const verifyRevocation = (x: unknown, ik?: string): x is Revocation => {
  if (!isRecord(x) || !onlyKeys(x, ['v', 'ik', 'dk', 'revoked_at', 'sig'], ['successor']))
    return false
  const r = x as unknown as Revocation
  if (
    r.v !== 1 ||
    !isKeyId(r.ik) ||
    !isKeyId(r.dk) ||
    !isInt(r.revoked_at) ||
    (r.successor !== undefined && !isKeyId(r.successor)) ||
    (ik !== undefined && r.ik !== ik)
  )
    return false
  try {
    return verifyTagged(r.ik, TAG.revoke, revocationBody(r), r.sig)
  } catch {
    return false
  }
}

// The devices an identity may use now: certified and not revoked.
export const liveCerts = (certs: Cert[], revocations: Revocation[]) => {
  const revoked = new Set(revocations.map(r => r.dk))
  return certs.filter(c => !revoked.has(c.dk))
}

// ----- Profile -----

export interface Profile {
  v: 1
  ik: string
  name: string
  color?: string
  updated: number
  sig: string
}

const COLOR = /^#[0-9a-f]{6}$/

// Trimmed, NFC, without control characters, at most NAME_MAX characters.
export const cleanName = (raw: string) =>
  [
    ...nfc(raw)
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
      .trim(),
  ]
    .slice(0, NAME_MAX)
    .join('')
    .trim()

const profileBody = ({ v, ik, name, color, updated }: Profile) =>
  color === undefined ? { v, ik, name, updated } : { v, ik, name, color, updated }

export const signProfile = (
  ik: KeyPair,
  name: string,
  updated: number,
  color?: string
): Profile => {
  const body: Omit<Profile, 'sig'> = { v: 1, ik: keyId(ik.pk), name: cleanName(name), updated }
  if (color !== undefined && COLOR.test(color)) body.color = color
  return { ...body, sig: signTagged(ik.sk, TAG.profile, body) }
}

export const verifyProfile = (x: unknown, ik?: string): x is Profile => {
  if (!isRecord(x) || !onlyKeys(x, ['v', 'ik', 'name', 'updated', 'sig'], ['color'])) return false
  const p = x as unknown as Profile
  if (
    p.v !== 1 ||
    !isKeyId(p.ik) ||
    typeof p.name !== 'string' ||
    p.name !== cleanName(p.name) ||
    !p.name ||
    !isInt(p.updated) ||
    (p.color !== undefined && (typeof p.color !== 'string' || !COLOR.test(p.color))) ||
    (ik !== undefined && p.ik !== ik)
  )
    return false
  try {
    return verifyTagged(p.ik, TAG.profile, profileBody(p), p.sig)
  } catch {
    return false
  }
}

// ----- Succession: an identity reset signed by the old and the new key -----

export interface Succession {
  v: 1
  old: string
  new: string
  at: number
  sig_old: string
  sig_new: string
}

const successionBody = (s: Succession) => ({ v: s.v, old: s.old, new: s.new, at: s.at })

export const signSuccession = (old: KeyPair, next: KeyPair, at: number): Succession => {
  const body = { v: 1 as const, old: keyId(old.pk), new: keyId(next.pk), at }
  return {
    ...body,
    sig_old: signTagged(old.sk, TAG.succession, body),
    sig_new: signTagged(next.sk, TAG.succession, body),
  }
}

export const verifySuccession = (x: unknown): x is Succession => {
  if (!isRecord(x) || !onlyKeys(x, ['v', 'old', 'new', 'at', 'sig_old', 'sig_new'])) return false
  const s = x as unknown as Succession
  if (s.v !== 1 || !isKeyId(s.old) || !isKeyId(s.new) || s.old === s.new || !isInt(s.at))
    return false
  const body = successionBody(s)
  try {
    return (
      verifyTagged(s.old, TAG.succession, body, s.sig_old) &&
      verifyTagged(s.new, TAG.succession, body, s.sig_new)
    )
  } catch {
    return false
  }
}

// ----- Account binding proof -----

// What POST /api/identity/p2p_binding wants signed by the identity key: the tag, the account
// (`user@host`), a zero byte and the time (unix seconds, decimal). The instance only vouches for
// a key that signed this, so nobody binds someone else's key to their account.
export const bindingMessage = (sub: string, ts: number) =>
  concat(utf8(TAG.bind), utf8(sub), utf8('\0'), utf8(String(ts)))

export const bindingProof = (ik: KeyPair, sub: string, ts: number) =>
  b64u(ed25519.sign(bindingMessage(sub, ts), ik.sk))

// ----- Fingerprint and peer ids -----

const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('')

// The first 20 bytes of SHA-256(IK), as 10 groups of 4 hex digits.
export const fingerprint = (ik: string) => {
  const key = keyBytes(ik)
  if (!key) return ''
  return (hex(sha256(key).subarray(0, 20)).match(/.{4}/g) ?? []).join(' ')
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567'

export const base32 = (b: Uint8Array) => {
  let out = ''
  let bits = 0
  let acc = 0
  for (const byte of b) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31]
      bits -= 5
    }
    acc &= (1 << bits) - 1
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31]
  return out
}

// The rendezvous id on the PeerServer. It reveals nothing about the identity, and only someone
// holding the device key can complete a handshake on it.
export const peerId = (dk: Uint8Array | string): string => {
  const key = typeof dk === 'string' ? keyBytes(dk) : dk
  if (!key) throw new Error('bad device key')
  return `rcp-${base32(sha256(concat(utf8(TAG.peer), key))).slice(0, 26)}`
}

export const SUFFIX_MAX = 3

// Squatting on an id only blocks it, so the owner retries with -1, -2, -3.
export const withSuffix = (id: string, n: number) => (n === 0 ? id : `${id}-${n}`)

export const peerIds = (dk: string) => {
  const base = peerId(dk)
  return Array.from({ length: SUFFIX_MAX + 1 }, (_, n) => withSuffix(base, n))
}

// The id without a retry suffix.
export const baseId = (id: string) => id.replace(/-[1-9]$/, '')
