// The device's client id for one instance (`X-Trust-Client`): 16 random bytes as 22 base64url
// characters, made once per instance origin and sent only to that origin. It names no person
// and no account.

interface Storage {
  get(key: string): string | null
  set(key: string, value: string): void
}

type Random = (bytes: Uint8Array) => Uint8Array

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

// 16 bytes leave 4 unused bits in the last character; the server refuses them set.
export const clientIdOk = (id: unknown): id is string =>
  typeof id === 'string' && /^[A-Za-z0-9_-]{21}[AQgw]$/.test(id)

export const clientIdKey = (origin: string): string => `rchat_trust_client@${origin}`

export const newClientId = (random: Random = bytes => crypto.getRandomValues(bytes)): string => {
  const b = random(new Uint8Array(16))
  let out = ''
  for (let i = 0; i < 15; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2]
    out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63]
  }
  return out + ALPHABET[b[15] >> 2] + ALPHABET[(b[15] & 3) << 4]
}

const stored = (raw: string | null): string | null => {
  if (!raw) return null
  try {
    const s: unknown = JSON.parse(raw)
    const id =
      typeof s === 'object' && s !== null && 'v' in s && s.v === 1 && 'id' in s ? s.id : null
    return clientIdOk(id) ? id : null
  } catch {
    return null
  }
}

const kept = (storage: Storage, key: string): string | null => {
  try {
    return stored(storage.get(key))
  } catch {
    return null
  }
}

// The id kept for `origin`, made and kept when there is none or the kept value is bad. Storage
// that can't be read or written still gives an id, for this run.
export const clientId = (storage: Storage, origin: string, random?: Random): string => {
  const key = clientIdKey(origin)
  const known = kept(storage, key)
  if (known) return known
  const id = newClientId(random)
  try {
    storage.set(key, JSON.stringify({ v: 1, id }))
  } catch {
    return id
  }
  return id
}

// The header value for a request to `url`: the id for the instance's own origin, null for any
// other.
export const clientIdFor = (url: string, origin: string, id: string): string | null => {
  try {
    return new URL(url, origin).origin === new URL(origin).origin ? id : null
  } catch {
    return null
  }
}
