import { sha512 } from '@noble/hashes/sha2.js'
import { isRecord } from '../bytes'
import { b64u, bytesOf, canonical, concat, fromB64u, parseCanonical, utf8 } from './canonical'
import { isKeyId, keyBytes } from './keys'
import { LOCAL } from './limits'

// Safety numbers (Signal's construction): per identity, SHA-512 iterated 5200 times over the
// version and the key, cut to 30 digits; the pair's number is both halves sorted by key, 60
// digits in 12 groups of 5. Both sides compute the same number.

const ITERATIONS = 5200
const VERSION = new Uint8Array([0, 0])
const STABLE = utf8('rchat-p2p')

const half = (ik: Uint8Array) => {
  let h = sha512(concat(VERSION, ik, STABLE))
  for (let i = 0; i < ITERATIONS; i += 1) h = sha512(concat(h, ik))
  let digits = ''
  for (let c = 0; c < 6; c += 1) {
    const at = c * 5
    let n = 0
    for (let j = 0; j < 5; j += 1) n = n * 256 + h[at + j]
    digits += String(n % 100000).padStart(5, '0')
  }
  return digits
}

const cache = new Map<string, string>()

const halfOf = (ik: string) => {
  const hit = cache.get(ik)
  if (hit) return hit
  const key = keyBytes(ik)
  if (!key) throw new Error('bad identity key')
  const d = half(key)
  if (cache.size > LOCAL.misc.safetyCache) cache.clear()
  cache.set(ik, d)
  return d
}

export const safetyDigits = (a: string, b: string) => {
  const [x, y] = a < b ? [a, b] : [b, a]
  return halfOf(x) + halfOf(y)
}

export const safetyGroups = (a: string, b: string) => safetyDigits(a, b).match(/.{5}/g) ?? []

// ----- QR verification -----

export const VERIFY_PREFIX = 'rcv1.'
const NONCE_LEN = 16

export interface VerifyPayload {
  // The identity showing the code, the one it expects to scan it, and a one-time nonce.
  a: string
  b: string
  n: string
}

export const verifyCode = (mine: string, theirs: string, nonce: Uint8Array) =>
  VERIFY_PREFIX + b64u(utf8(canonical({ a: mine, b: theirs, n: b64u(nonce) })))

export const parseVerifyCode = (text: string): VerifyPayload | null => {
  const t = text.trim()
  if (!t.startsWith(VERIFY_PREFIX) || t.length > 400) return null
  try {
    const v = parseCanonical(new TextDecoder().decode(fromB64u(t.slice(VERIFY_PREFIX.length))))
    if (!isRecord(v) || Object.keys(v).length !== 3) return null
    const { a, b, n } = v
    if (!isKeyId(a) || !isKeyId(b) || bytesOf(n, NONCE_LEN) === null) return null
    return { a, b, n: n as string }
  } catch {
    return null
  }
}

export type VerifyCheck = 'ok' | 'not_them' | 'not_me' | 'bad'

// Run by the scanner: the code must come from the contact being verified and name us.
export const checkVerifyCode = (text: string, me: string, them: string): VerifyCheck => {
  const p = parseVerifyCode(text)
  if (!p) return 'bad'
  if (p.a !== them) return 'not_them'
  if (p.b !== me) return 'not_me'
  return 'ok'
}

export const verifyCheckText = (c: VerifyCheck) =>
  c === 'ok'
    ? 'Verified'
    : c === 'not_them'
      ? "That code belongs to someone else. Don't mark this contact as verified."
      : c === 'not_me'
        ? 'That code was made for someone else.'
        : "That isn't a verification code"

export const NONCE_BYTES = NONCE_LEN
