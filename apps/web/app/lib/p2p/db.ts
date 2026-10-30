import { deleteDB, openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb'
import type { Contact } from './contacts'
import type { Cert, KeyPair, Profile, Revocation, Succession } from './keys'

// P2P data lives only in this browser, in one IndexedDB database per instance and account. Each
// schema version adds its stores in UPGRADES; later tasks append theirs (rooms, events, ...).

export interface SelfRecord {
  id: 'me'
  ik: KeyPair
  dk: KeyPair
  cert: Cert
  // Our certified devices, newest first, the current one included.
  certs: Cert[]
  revocations: Revocation[]
  profile: Profile
  // Set after an identity reset that the old key signed.
  succession: Succession | null
  // Retry suffix of our peer id (0 = none).
  suffix: number
  created: number
  // This browser's identity moved to another device: it may no longer sign anything.
  moved: { at: number; successor: string } | null
}

export interface P2pSchema extends DBSchema {
  self: { key: string; value: SelfRecord }
  contacts: { key: string; value: Contact; indexes: { state: string } }
  meta: { key: string; value: unknown }
}

export type P2pDatabase = IDBPDatabase<P2pSchema>

type Upgrade = (
  db: P2pDatabase,
  tx: IDBPTransaction<P2pSchema, ('self' | 'contacts' | 'meta')[], 'versionchange'>
) => void

export const UPGRADES: Upgrade[] = [
  db => {
    db.createObjectStore('self', { keyPath: 'id' })
    const contacts = db.createObjectStore('contacts', { keyPath: 'ik' })
    contacts.createIndex('state', 'state')
    db.createObjectStore('meta')
  },
]

export const DB_VERSION = UPGRADES.length

export const dbName = (instance: string, account: string) => `rchat-p2p:${instance}:${account}`

// `onBlocking` runs when another tab needs a newer schema or deletes the database; closing lets
// it go ahead.
export const openP2pDb = (name: string, onBlocking: () => void = () => {}) =>
  openDB<P2pSchema>(name, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, tx) {
      for (let v = oldVersion; v < DB_VERSION; v += 1) UPGRADES[v](db, tx)
      void tx.objectStore('meta').put(DB_VERSION, 'schema')
    },
    blocking: onBlocking,
  })

export class P2pStore {
  closed = false

  private constructor(readonly db: P2pDatabase) {}

  static async open(name: string, onBlocking?: () => void) {
    let store: P2pStore | null = null
    const db = await openP2pDb(name, () => {
      store?.close()
      onBlocking?.()
    })
    store = new P2pStore(db)
    return store
  }

  close() {
    this.closed = true
    this.db.close()
  }

  self(): Promise<SelfRecord | undefined> {
    return this.db.get('self', 'me')
  }

  async putSelf(rec: SelfRecord) {
    await this.db.put('self', rec)
  }

  // Read-modify-write in one transaction: `fn` gets the stored record, never a cached copy, so a
  // stale writer can't undo a newer change. It must be synchronous; null writes nothing. Returns
  // what is stored afterwards.
  async updateSelf(fn: (cur: SelfRecord | undefined) => SelfRecord | null) {
    const tx = this.db.transaction('self', 'readwrite')
    const cur = await tx.store.get('me')
    const next = fn(cur)
    if (next) await tx.store.put(next)
    await tx.done
    return next ?? cur
  }

  async updateContact(ik: string, fn: (cur: Contact | undefined) => Contact | null) {
    const tx = this.db.transaction('contacts', 'readwrite')
    const cur = await tx.store.get(ik)
    const next = fn(cur)
    if (next && next.ik !== ik) throw new Error('contact key mismatch')
    if (next) await tx.store.put(next)
    await tx.done
    return next ?? cur
  }

  // Deletes the contact only if it still matches.
  async deleteContactIf(ik: string, keep: (cur: Contact) => boolean) {
    const tx = this.db.transaction('contacts', 'readwrite')
    const cur = await tx.store.get(ik)
    const gone = cur !== undefined && !keep(cur)
    if (gone) await tx.store.delete(ik)
    await tx.done
    return gone
  }

  contacts(): Promise<Contact[]> {
    return this.db.getAll('contacts')
  }

  contact(ik: string): Promise<Contact | undefined> {
    return this.db.get('contacts', ik)
  }

  async putContact(c: Contact) {
    await this.db.put('contacts', c)
  }

  async deleteContact(ik: string) {
    await this.db.delete('contacts', ik)
  }

  // A contact that moved to a new identity: one transaction, so it is never lost or doubled.
  // `make` sees the stored old record and may refuse (null), for example when it was blocked.
  async replaceContact(oldIk: string, make: (old: Contact) => Contact | null) {
    const tx = this.db.transaction('contacts', 'readwrite')
    const old = await tx.store.get(oldIk)
    const next = old ? make(old) : null
    let done: Contact | null = null
    if (next && !(await tx.store.get(next.ik))) {
      await tx.store.delete(oldIk)
      await tx.store.put(next)
      done = next
    }
    await tx.done
    return done
  }

  meta<T>(key: string): Promise<T | undefined> {
    return this.db.get('meta', key) as Promise<T | undefined>
  }

  async setMeta(key: string, value: unknown) {
    await this.db.put('meta', value, key)
  }

  async counts() {
    return { contacts: await this.db.count('contacts') }
  }
}

export const removeP2pDb = (name: string) => deleteDB(name)
