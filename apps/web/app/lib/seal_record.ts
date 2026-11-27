// The sealed record framing shared with the instance: `0x52 | version | key id u32 BE | nonce |
// ciphertext | tag(16)`. Version 1 is the instance's (XChaCha20-Poly1305, a 24-byte nonce);
// version 2 is a device's (AES-256-GCM, a 12-byte nonce), which this module seals and opens.

export const MAGIC = 0x52
export const SERVER_RECORD = 1
export const DEVICE_RECORD = 2
export const HEADER_LEN = 6
export const TAG_LEN = 16
const NONCE_LEN: Record<number, number> = { [SERVER_RECORD]: 24, [DEVICE_RECORD]: 12 }
export const DEVICE_NONCE_LEN = 12

export interface RecordHeader {
  version: number
  keyId: number
  nonceLen: number
}

const utf8 = new TextEncoder()

const joined = (label: string, parts: readonly string[]) => {
  const chunks = [utf8.encode(label), ...parts.map(p => utf8.encode(p))]
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0) + parts.length)
  let at = 0
  chunks.forEach((chunk, i) => {
    if (i > 0) out[at++] = 0
    out.set(chunk, at)
    at += chunk.length
  })
  return out
}

// "rchat-row1\0" table "\0" column "\0" binding "\0" key_id
export const rowAad = (table: string, column: string, binding: string, keyId: number) =>
  joined('rchat-row1', [table, column, binding, String(keyId)])

// "rchat-dek1\0" purpose "\0" gen "\0" kek_id
export const dekAad = (purpose: string, generation: number, kekId: string) =>
  joined('rchat-dek1', [purpose, String(generation), kekId])

// "rchat-dev1\0" store "\0" key "\0" room
export const deviceAad = (store: string, key: string, room: string) =>
  joined('rchat-dev1', [store, key, room])

// The header of a sealed record, or null for bytes that are not one.
export function recordHeader(record: Uint8Array): RecordHeader | null {
  if (record.length < HEADER_LEN || record[0] !== MAGIC) return null
  const version = record[1]
  const nonceLen = NONCE_LEN[version]
  if (nonceLen === undefined || record.length < HEADER_LEN + nonceLen + TAG_LEN) return null
  const keyId = new DataView(record.buffer, record.byteOffset, record.byteLength).getUint32(2)
  return { version, keyId, nonceLen }
}

const buffer = (bytes: Uint8Array) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

export async function sealDevice(
  key: CryptoKey,
  keyId: number,
  aad: Uint8Array,
  plain: Uint8Array,
  nonce: Uint8Array = crypto.getRandomValues(new Uint8Array(DEVICE_NONCE_LEN))
): Promise<Uint8Array> {
  if (nonce.length !== DEVICE_NONCE_LEN) throw new Error('a device nonce is 12 bytes')
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: buffer(nonce), additionalData: buffer(aad), tagLength: 128 },
      key,
      buffer(plain)
    )
  )
  const out = new Uint8Array(HEADER_LEN + DEVICE_NONCE_LEN + sealed.length)
  out[0] = MAGIC
  out[1] = DEVICE_RECORD
  new DataView(out.buffer).setUint32(2, keyId)
  out.set(nonce, HEADER_LEN)
  out.set(sealed, HEADER_LEN + DEVICE_NONCE_LEN)
  return out
}

// The plaintext of a device record, or null when the key, the associated data or the bytes do
// not match.
export async function openDevice(
  key: CryptoKey,
  aad: Uint8Array,
  record: Uint8Array
): Promise<Uint8Array | null> {
  const head = recordHeader(record)
  if (head?.version !== DEVICE_RECORD) return null
  const nonce = record.subarray(HEADER_LEN, HEADER_LEN + DEVICE_NONCE_LEN)
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: buffer(nonce), additionalData: buffer(aad), tagLength: 128 },
      key,
      buffer(record.subarray(HEADER_LEN + DEVICE_NONCE_LEN))
    )
    return new Uint8Array(plain)
  } catch {
    return null
  }
}
