import { createStore } from 'zustand/vanilla'
import {
  canReadSharedStorage,
  defaultEndpoints,
  localKeys,
  readLocal,
  writeLocal,
} from '../instances'
import { migrateBook, parseBook, type Book } from './book'
import { time } from '../platform/time'

type Edit = (current: Book) => Book
export const BOOK_COORDINATION_ERROR =
  'This browser cannot safely add a saved account while account storage is unavailable.'

// Read/write transactions on the same object store execute exclusively, even
// across renderer processes. Touch the store before running the synchronous
// localStorage edit, so it happens while this transaction actually holds the lock.
function withBookTransaction(factory: IDBFactory, commit: () => Book): Promise<Book> {
  return new Promise((resolve, reject) => {
    const request = factory.open('rchat-account-book', 1)
    let abandoned = false
    const unavailable = () => {
      abandoned = true
      timeout()
      reject(new Error(BOOK_COORDINATION_ERROR))
    }
    // Opening can wait behind a pending delete without receiving "blocked".
    const timeout = time().after(3000, unavailable)
    request.onerror = request.onblocked = unavailable
    request.onupgradeneeded = () => {
      if (abandoned) request.transaction?.abort()
      else request.result.createObjectStore('writers')
    }
    request.onsuccess = () => {
      timeout()
      const db = request.result
      if (abandoned) {
        db.close()
        return
      }
      try {
        const tx = db.transaction('writers', 'readwrite')
        let result: Book
        tx.onabort = () => {
          db.close()
          reject(tx.error ?? new Error(BOOK_COORDINATION_ERROR))
        }
        tx.oncomplete = () => {
          db.close()
          resolve(result)
        }
        tx.objectStore('writers').get('book').onsuccess = () => {
          try {
            result = commit()
          } catch (error) {
            tx.abort()
            reject(error)
          }
        }
      } catch (error) {
        db.close()
        reject(error)
      }
    }
  })
}

export function createBookStore(project: (book: Book) => Book = b => b) {
  let volatile: Book | null = null
  const read = () => {
    const raw = readLocal('rchat_book')
    return raw === null
      ? (volatile ??
          migrateBook(localKeys('rchat_'), readLocal, defaultEndpoints()?.origin ?? null))
      : parseBook(raw)
  }
  const book = createStore<Book>(() => project(read()))
  const pending: Edit[] = []
  const publish = (base = read()) =>
    book.setState(project(pending.reduce((b, apply) => apply(b), base)), true)
  if (typeof window !== 'undefined')
    window.addEventListener?.('storage', event => {
      if (event.key === 'rchat_book' || event.key === null) publish()
    })
  const updateBook = (apply: Edit, onReadOnly?: () => void, optimistic = true) => {
    const edit: Edit = b => apply(b)
    const preview: Edit = optimistic ? edit : b => b
    pending.push(preview)
    let result: Book | undefined
    const finish = (next: Book) => {
      result = next
      pending.splice(pending.indexOf(preview), 1)
      publish(next)
      return next
    }
    const readOnly = () => {
      volatile = null
      onReadOnly?.()
      return finish(read())
    }
    const commit = () => {
      if (result) return result
      const next = edit(read())
      const raw = JSON.stringify(next)
      if (writeLocal('rchat_book', raw) && readLocal('rchat_book') === raw) volatile = null
      else if (canReadSharedStorage()) return readOnly()
      else volatile = next
      return finish(next)
    }

    // Synthetic windows in store tests and server renders have no browser tabs.
    if (typeof window === 'undefined') return commit()
    let locks: LockManager | undefined
    let idb: IDBFactory | undefined
    try {
      locks = window.navigator?.locks
    } catch {
      /* Restricted browsing context. */
    }
    try {
      idb = window.indexedDB
    } catch {
      /* Restricted browsing context. */
    }
    if (!idb && !locks && !window.document) return commit()
    publish()

    const withoutLock = () => {
      if (result) return result
      // A tab with no persistent storage can still keep its own volatile session.
      // When storage is shared, an unlocked writer cannot safely reserve a slot.
      if (!canReadSharedStorage()) {
        volatile = edit(volatile ?? read())
        return finish(volatile)
      }
      return readOnly()
    }
    const transaction = (fallback: () => Book) =>
      idb ? withBookTransaction(idb, commit).catch(fallback) : fallback()
    // A Web Locks participant also joins the IDB queue. A second tab can have
    // Web Locks disabled on the same storage origin.
    return locks
      ? locks.request('rchat_book', () => transaction(commit)).catch(() => transaction(withoutLock))
      : transaction(withoutLock)
  }
  // Enrollment edits can also update a pinned manifest. Run them only while holding the lock.
  const updateStoredBook = (apply: Edit) => updateBook(apply, undefined, false)
  return { book, updateBook, updateStoredBook, readStoredBook: read, refreshBook: () => publish() }
}
