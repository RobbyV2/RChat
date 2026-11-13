import { memoryRecords } from './memory_records'
import { PAGE, type RecordStore, type RecordTable, type Stored } from './records'

const STORE = 'records'
const BY_TIME = 'by_time'

// A connection closes itself when another tab deletes the database, and says so through
// `closed`, so the delete is not held up and the next use opens it again.
const openDb = (idb: IDBFactory, name: string, closed: () => void) =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const req = idb.open(name, 1)
    req.onupgradeneeded = () =>
      req.result.createObjectStore(STORE, { keyPath: 'id' }).createIndex(BY_TIME, ['at', 'id'])
    req.onsuccess = () => {
      const db = req.result
      db.onversionchange = () => {
        db.close()
        closed()
      }
      resolve(db)
    }
    req.onerror = () => reject(req.error ?? new Error('IndexedDB failed'))
    req.onblocked = () => reject(new Error('IndexedDB blocked'))
  })

// One transaction on the table's store; resolves with what `work` left in `out` once the
// transaction is through.
const within = <R>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore, out: { value: R }) => void,
  start: R
) =>
  new Promise<R>((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const out = { value: start }
    tx.oncomplete = () => resolve(out.value)
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB aborted'))
    work(tx.objectStore(STORE), out)
  })

// Deletes the records of `range`, from the newest, but for the first `skip`, and counts them.
// `then` runs once the walk is over.
const sweep = (
  store: IDBObjectStore,
  out: { value: number },
  range: IDBKeyRange | null,
  skip: number,
  then?: () => void
) => {
  const req = store.index(BY_TIME).openCursor(range, 'prev')
  let skipped = skip === 0
  req.onsuccess = () => {
    const cursor = req.result
    if (!cursor) return then?.()
    if (!skipped) {
      skipped = true
      cursor.advance(skip)
      return
    }
    cursor.delete()
    out.value += 1
    cursor.continue()
  }
}

const idbTable = <T extends Stored>(db: IDBDatabase): RecordTable<T> => ({
  put: records =>
    within<void>(
      db,
      'readwrite',
      store => {
        for (const r of records) store.put(r)
      },
      undefined
    ),
  list: ({ before, limit = PAGE } = {}) =>
    within<T[]>(
      db,
      'readonly',
      (store, out) => {
        if (limit <= 0) return
        const range = before ? IDBKeyRange.upperBound([before.at, before.id], true) : null
        const req = store.index(BY_TIME).openCursor(range, 'prev')
        req.onsuccess = () => {
          const cursor = req.result
          if (!cursor) return
          out.value.push(cursor.value as T)
          if (out.value.length < limit) cursor.continue()
        }
      },
      []
    ),
  delete: ids =>
    within<void>(
      db,
      'readwrite',
      store => {
        for (const id of ids) store.delete(id)
      },
      undefined
    ),
  prune: ({ olderThan, keep }) =>
    within<number>(
      db,
      'readwrite',
      (store, out) => {
        const byCount = () => {
          if (keep !== undefined) sweep(store, out, null, keep)
        }
        // Every key under `[olderThan]` is a record of an earlier time. The count is taken of
        // what is left after those went.
        if (olderThan === undefined) byCount()
        else sweep(store, out, IDBKeyRange.upperBound([olderThan], true), 0, byCount)
      },
      0
    ),
  clear: () => within<void>(db, 'readwrite', store => void store.clear(), undefined),
  count: () =>
    within<number>(
      db,
      'readonly',
      (store, out) => {
        const req = store.count()
        req.onsuccess = () => (out.value = req.result)
      },
      0
    ),
  durable: async () => true,
})

interface Opened {
  table: RecordTable<Stored>
  close: () => void
}

// Records in IndexedDB, one database per table. Where IndexedDB is missing or closed (some
// private modes), a table holds its records in memory and says so through `durable`.
export const webRecordsOn = (factory: () => IDBFactory | undefined): RecordStore => {
  const memory = memoryRecords()
  const opened = new Map<string, Promise<Opened>>()
  const idbOf = () => {
    try {
      return factory()
    } catch {
      return undefined
    }
  }
  const use = (name: string) => {
    const known = opened.get(name)
    if (known) return known
    const closed = () => {
      if (opened.get(name) === made) opened.delete(name)
    }
    const made = (async (): Promise<Opened> => {
      try {
        const idb = idbOf()
        if (idb) {
          const db = await openDb(idb, name, closed)
          return { table: idbTable<Stored>(db), close: () => db.close() }
        }
      } catch {
        // Held in memory instead.
      }
      return { table: memory.open<Stored>(name), close: () => {} }
    })()
    opened.set(name, made)
    return made
  }
  const open = <T extends Stored>(name: string): RecordTable<T> => {
    const on = async () => (await use(name)).table as unknown as RecordTable<T>
    return {
      put: async records => (await on()).put(records),
      list: async opts => (await on()).list(opts),
      delete: async ids => (await on()).delete(ids),
      prune: async opts => (await on()).prune(opts),
      clear: async () => (await on()).clear(),
      count: async () => (await on()).count(),
      durable: async () => (await on()).durable(),
    }
  }
  return {
    open,
    remove: async name => {
      const known = opened.get(name)
      opened.delete(name)
      await memory.remove(name)
      // An open connection would block the delete.
      if (known) (await known).close()
      const idb = idbOf()
      if (!idb) return
      // Other tabs close their connections when asked, so this waits for the delete itself.
      await new Promise<void>(resolve => {
        try {
          const req = idb.deleteDatabase(name)
          req.onsuccess = req.onerror = () => resolve()
        } catch {
          resolve()
        }
      })
    },
  }
}

export const webRecords: RecordStore = webRecordsOn(() =>
  typeof indexedDB === 'undefined' ? undefined : indexedDB
)
