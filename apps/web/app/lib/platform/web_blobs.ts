import type { BlobStore, BlobWriter } from './blobs'

const DB = 'rchat_blobs'
const STORE = 'blobs'
// Pieces of a file being written are collected in memory up to this size, then stored as one
// record, so a large download costs few transactions and little memory.
const PIECE_BYTES = 4 * 1024 * 1024

let opening: Promise<IDBDatabase> | null = null

const open = () => {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('No IndexedDB'))
      return
    }
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB failed'))
  }).catch((e: unknown) => {
    opening = null
    throw e
  })
  return opening
}

const run = async <T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest) => {
  const db = await open()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const req = fn(tx.objectStore(STORE))
    tx.oncomplete = () => resolve(req.result as T)
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB aborted'))
  })
}

// Pieces live under `key` + NUL + a zero-padded index, which sorts right after `key` itself.
const pieceKey = (key: string, n: number) => `${key}\u0000${String(n).padStart(8, '0')}`
const pieces = (key: string) => IDBKeyRange.bound(`${key}\u0000`, `${key}\u0001`, false, true)

const create = async (key: string): Promise<BlobWriter> => {
  await run<undefined>('readwrite', s => s.delete(pieces(key)))
  let held: Uint8Array[] = []
  let heldBytes = 0
  let count = 0
  const flush = async () => {
    if (!heldBytes) return
    const piece = new Blob(held as BlobPart[])
    held = []
    heldBytes = 0
    await run<IDBValidKey>('readwrite', s => s.put(piece, pieceKey(key, count)))
    count += 1
  }
  return {
    write: async chunk => {
      held.push(chunk)
      heldBytes += chunk.byteLength
      if (heldBytes >= PIECE_BYTES) await flush()
    },
    finish: async type => {
      await flush()
      const stored = await run<unknown[]>('readonly', s => s.getAll(pieces(key)))
      const blob = new Blob(
        stored.filter((p): p is Blob => p instanceof Blob),
        { type }
      )
      await run<IDBValidKey>('readwrite', s => s.put(blob, key))
      await run<undefined>('readwrite', s => s.delete(pieces(key)))
      const kept = await run<unknown>('readonly', s => s.get(key))
      return kept instanceof Blob ? kept : blob
    },
    abort: async () => {
      held = []
      heldBytes = 0
      await run<undefined>('readwrite', s => s.delete(pieces(key))).catch(() => {})
    },
  }
}

const room = async () => {
  try {
    const est = await navigator.storage?.estimate?.()
    if (!est || est.quota === undefined) return null
    return Math.max(0, est.quota - (est.usage ?? 0))
  } catch {
    return null
  }
}

export const webBlobs: BlobStore = {
  put: async (key, blob) => {
    await run<IDBValidKey>('readwrite', s => s.put(blob, key))
  },
  get: async key => {
    const got = await run<unknown>('readonly', s => s.get(key))
    return got instanceof Blob ? got : null
  },
  remove: async key => {
    await run<undefined>('readwrite', s => s.delete(key))
    await run<undefined>('readwrite', s => s.delete(pieces(key)))
  },
  create,
  clear: async prefix => {
    if (!prefix) return
    await run<undefined>('readwrite', s =>
      s.delete(IDBKeyRange.bound(prefix, `${prefix}\uffff`, false, true))
    )
  },
  room,
}
