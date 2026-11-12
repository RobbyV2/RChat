// Authenticator codes for the browser runs and the rig's tests: RFC 6238 with SHA-1, 6 digits and
// 30 second steps, from the key or the otpauth URI the enrolment screen shows.
// Usage: bun scripts/identity/totp.ts <key or otpauth URI>
import { createHmac } from 'node:crypto'

export const DIGITS = 6
export const PERIOD = 30

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export const base32Decode = (text: string): Uint8Array | null => {
  const clean = text.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const i = B32.indexOf(ch)
    if (i < 0) return null
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

export const hotp = (secret: Uint8Array, counter: number, digits = DIGITS) => {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const mac = createHmac('sha1', Buffer.from(secret)).update(msg).digest()
  const off = mac[mac.length - 1] & 0x0f
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3]
  return String(bin % 10 ** digits).padStart(digits, '0')
}

export const stepAt = (unixSecs: number) => Math.floor(unixSecs / PERIOD)

export const totp = (secret: Uint8Array, unixSecs = Date.now() / 1000, digits = DIGITS) =>
  hotp(secret, stepAt(unixSecs), digits)

// The secret of an otpauth URI, or of the key as people copy it.
export const secretOf = (keyOrUri: string): Uint8Array | null => {
  if (!keyOrUri.startsWith('otpauth://')) return base32Decode(keyOrUri)
  try {
    const secret = new URL(keyOrUri).searchParams.get('secret')
    return secret === null ? null : base32Decode(secret)
  } catch {
    return null
  }
}

export const codeFor = (keyOrUri: string, unixSecs = Date.now() / 1000) => {
  const secret = secretOf(keyOrUri)
  return secret && secret.length > 0 ? totp(secret, unixSecs) : null
}

if (import.meta.main) {
  const code = codeFor(process.argv[2] ?? '')
  if (code === null) {
    console.error('usage: bun scripts/identity/totp.ts <key or otpauth URI>')
    process.exit(2)
  }
  console.log(code)
}
