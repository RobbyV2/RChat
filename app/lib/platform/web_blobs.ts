import type { BlobStore } from './blobs'

const DB = 'rchat_blobs'
const STORE = 'blobs'

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
  },
}
