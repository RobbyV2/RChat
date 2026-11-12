export const DIGITS = 6
export const PERIOD = 30
export const RECOVERY_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'
export const RECOVERY_LEN = 10
export const RECOVERY_LOW = 2

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export const base32Encode = (bytes: Uint8Array): string => {
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

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

export const groupKeyText = (key: string) =>
  (
    key
      .toUpperCase()
      .replace(/[\s-]/g, '')
      .match(/.{1,4}/g) ?? []
  ).join(' ')

export const groupedKey = (secret: Uint8Array) => groupKeyText(base32Encode(secret))

export const otpauthUri = (issuer: string, account: string, secret: Uint8Array) => {
  const enc = encodeURIComponent
  return `otpauth://totp/${enc(issuer)}:${enc(account)}?secret=${base32Encode(secret)}&issuer=${enc(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD}`
}

export const issuerLabel = (name: string, host: string) =>
  name.toLowerCase() === host.toLowerCase() ? host : `${name} (${host})`

export const cleanCode = (input: string): string | null => {
  const code = input.replace(/\s/g, '')
  return /^\d{6}$/.test(code) ? code : null
}

export const groupCode = (input: string) => {
  const digits = input.replace(/\D/g, '').slice(0, DIGITS)
  return digits.length > 3 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits
}

export const codeComplete = (input: string) => cleanCode(input) !== null

export const cleanRecovery = (input: string): string | null => {
  const code = input.toLowerCase().replace(/[\s-]/g, '')
  if (code.length !== RECOVERY_LEN) return null
  return [...code].every(ch => RECOVERY_ALPHABET.includes(ch)) ? code : null
}

export const recoveryLeftLine = (left: number): string | null => {
  if (left > RECOVERY_LOW) return null
  if (left <= 0) return 'You have no recovery codes left.'
  return `You have ${left} recovery ${left === 1 ? 'code' : 'codes'} left.`
}

export const recoveryLine = (index: number, count: number, code: string) =>
  `Recovery code ${index + 1} of ${count}: ${code.replace('-', ' ')}`

export const recoveryFileName = (host: string) =>
  `${host.toLowerCase().replace(/[^a-z0-9.-]+/g, '-')}-recovery-codes.txt`

export const recoveryText = (codes: string[]) => codes.map(c => `${c}\n`).join('')
