import { sha256 } from '@noble/hashes/sha2.js'
import { b64u, utf8 } from './canonical'

// Block hashing for P2P attachments (note section 5): a file is split into 1 MiB blocks,
// `blocks[i] = SHA-256(block i)`, and the root is
// `h = SHA-256("rchat-p2p-blob1\0" || size (u64, big endian) || blocks...)`. Used by the hash
// worker and directly where there is no worker (tests).

export const TAG_BLOB = 'rchat-p2p-blob1\0'

export const BLOCK = 1024 * 1024

export const blockCount = (size: number) => Math.ceil(size / BLOCK)

const u64 = (n: number) => {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(n))
  return out
}

export const blobRoot = (size: number, blocks: Uint8Array[]) => {
  const h = sha256.create()
  h.update(utf8(TAG_BLOB))
  h.update(u64(size))
  for (const b of blocks) h.update(b)
  return b64u(h.digest())
}

// The same over the block hashes laid end to end (32 bytes each).
export const blobRootOf = (size: number, flat: Uint8Array) => {
  const h = sha256.create()
  h.update(utf8(TAG_BLOB))
  h.update(u64(size))
  h.update(flat)
  return b64u(h.digest())
}

// The root of an empty file: no blocks, size 0. The only zero-length root a message may carry.
export const EMPTY_ROOT = blobRoot(0, [])

// Block hashes are stored in pages of this many (32 bytes each), written once per file.
export const HASH_PAGE = 4096

export const digest = async (data: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource))

export interface Hashed {
  h: string
  size: number
  blocks: string[]
}

// Reads one block at a time, so a file of any size is hashed in constant memory.
export const hashBlob = async (
  blob: Blob,
  onProgress?: (done: number, total: number) => void
): Promise<Hashed> => {
  const n = blockCount(blob.size)
  const raw: Uint8Array[] = []
  for (let i = 0; i < n; i += 1) {
    const part = new Uint8Array(await blob.slice(i * BLOCK, (i + 1) * BLOCK).arrayBuffer())
    raw.push(await digest(part))
    onProgress?.(i + 1, n)
  }
  return { h: blobRoot(blob.size, raw), size: blob.size, blocks: raw.map(b64u) }
}

// The same for bytes already in memory (tests, small files).
export const hashBytes = async (data: Uint8Array) => {
  const raw: Uint8Array[] = []
  for (let at = 0; at < data.length; at += BLOCK)
    raw.push(await digest(data.subarray(at, at + BLOCK)))
  return { h: blobRoot(data.length, raw), size: data.length, blocks: raw.map(b64u) }
}
