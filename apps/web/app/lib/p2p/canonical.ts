import { fromBase64Url, isRecord, toBase64Url } from '../bytes'

// Canonical JSON, the RFC 8785 (JCS) subset every signed P2P record is hashed and signed over:
// keys sorted by UTF-16 code units, no whitespace, JSON.stringify string escaping, integers only
// (within +-(2^53 - 1)). Floats, -0, non-finite numbers, undefined and strings that are not NFC
// are refused, so two clients can never disagree about the bytes of a record.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export class CanonicalError extends Error {}

const fail = (why: string): never => {
  throw new CanonicalError(why)
}

// A lone surrogate has no UTF-8 form, so the bytes would differ between encoders.
const wellFormed = (s: string) => {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1)
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false
      i += 1
    } else if (c >= 0xdc00 && c <= 0xdfff) return false
  }
  return true
}

const str = (s: string) => {
  if (!wellFormed(s)) fail('string has a lone surrogate')
  if (s.normalize('NFC') !== s) fail('string is not NFC')
  return JSON.stringify(s)
}

const byUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export const canonical = (value: unknown): string => {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isSafeInteger(value)) fail('only safe integers are allowed')
      if (Object.is(value, -0)) fail('-0 is not allowed')
      return String(value)
    case 'string':
      return str(value)
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
      if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype)
        fail('only plain objects are allowed')
      const rec = value as Record<string, unknown>
      const keys = Object.keys(rec).sort(byUnits)
      return `{${keys
        .map(k => {
          if (rec[k] === undefined) fail(`undefined value at ${k}`)
          return `${str(k)}:${canonical(rec[k])}`
        })
        .join(',')}}`
    }
    default:
      return fail(`${typeof value} is not JSON`)
  }
}

const enc = new TextEncoder()
const dec = new TextDecoder('utf-8', { fatal: true })

export const utf8 = (s: string) => enc.encode(s)

export const fromUtf8 = (b: Uint8Array) => dec.decode(b)

export const canonicalBytes = (value: unknown) => utf8(canonical(value))

// Parses text that must already be canonical: whitespace, unsorted or duplicate keys, floats and
// non-NFC strings all fail, because re-encoding would not give the same text back.
export const parseCanonical = (text: string): Json => {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return fail('not JSON')
  }
  if (canonical(v) !== text) fail('not canonical')
  return v as Json
}

export const parseCanonicalBytes = (b: Uint8Array): Json => {
  let text: string
  try {
    text = fromUtf8(b)
  } catch {
    return fail('not UTF-8')
  }
  return parseCanonical(text)
}

export const b64u = (b: Uint8Array) => toBase64Url(b)

const B64U = /^[A-Za-z0-9_-]*$/

// Strict: only the URL alphabet, no padding, and the text must be the one encoding of its bytes.
export const fromB64u = (text: string): Uint8Array => {
  if (typeof text !== 'string' || !B64U.test(text) || text.length % 4 === 1) fail('not base64url')
  let out: Uint8Array
  try {
    out = fromBase64Url(text)
  } catch {
    return fail('not base64url')
  }
  if (toBase64Url(out) !== text) fail('not canonical base64url')
  return out
}

// A b64u string of exactly `len` bytes, or null.
export const bytesOf = (text: unknown, len: number): Uint8Array | null => {
  if (typeof text !== 'string') return null
  try {
    const b = fromB64u(text)
    return b.length === len ? b : null
  } catch {
    return null
  }
}

export const nfc = (s: string) => s.normalize('NFC')

export const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export const equalBytes = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i += 1) d |= a[i] ^ b[i]
  return d === 0
}

export const randomBytes = (n: number) => {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return b
}

// Forward compatibility (constraints): a parser checks the keys it knows and ignores the rest, so
// fields a newer peer adds never make a frame, event or card invalid.
export const hasKeys = (x: Record<string, unknown>, keys: readonly string[]) =>
  keys.every(k => k in x)

// Only the known keys of `x` that are present, for parsers that hand on a cleaned copy.
export const pickKeys = <T>(x: Record<string, unknown>, keys: readonly string[]): T =>
  Object.fromEntries(keys.filter(k => x[k] !== undefined).map(k => [k, x[k]])) as T
