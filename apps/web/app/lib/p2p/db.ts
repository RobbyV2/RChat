import { deleteDB, openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb'
import type { Contact } from './contacts'
import type { EvType, Wire } from './event'
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

// A conversation. Its events are the source of truth; this record caches the DAG frontier and
// the counters the room list shows.
export interface RoomRecord {
  id: string
  kind: 'dm'
  // The other member of a DM.
  peer: string
  // Events without known children, deepest first.
  heads: { id: string; depth: number }[]
  // Parents we have not seen (bounded); fetched from peers.
  missing: string[]
  maxDepth: number
  count: number
  // Arrival counter: every stored event takes the next number. Unread counts go by arrival.
  lastSeq: number
  readSeq: number
  unread: number
  pings: number
  // Newest message, for the room list.
  lastTs: number
  // The room reached its event or byte cap on this device.
  full: boolean
  fullWhy?: 'events' | 'bytes'
  // Bytes of the events stored (rooms from before this count start at 0).
  bytes?: number
  // When the other side last said its storage is full (cleared once it stores again).
  peerFull?: number | null
  created: number
}

export interface EventRecord {
  id: string
  room: string
  type: EvType
  sender: string
  wire: Wire
  // Events that point at another one (edit, redact, react, pin) and replies.
  target?: string
  reply?: string
  depth: number
  effTs: number
  sortKey: string
  receivedAt: number
  seq: number
  // Content removed by a redaction (or never received).
  redacted: boolean
}

export interface OutboxRecord {
  id: string
  room: string
  created: number
  // Identities that have the event.
  deliveredTo: string[]
  // It can never be delivered as it is (refused by the other side, or invalid): shown with
  // Retry and Delete instead of waiting.
  failed?: boolean
}

export interface P2pSchema extends DBSchema {
  self: { key: string; value: SelfRecord }
  contacts: { key: string; value: Contact; indexes: { state: string } }
  meta: { key: string; value: unknown }
  rooms: { key: string; value: RoomRecord; indexes: { peer: string } }
  events: {
    key: string
    value: EventRecord
    indexes: {
      room_sort: [string, string]
      room_type_sort: [string, string, string]
      room_target: [string, string]
      room_reply: [string, string]
      room_seq: [string, number]
    }
  }
  children: { key: [string, string]; value: { parent: string; child: string } }
  outbox: { key: string; value: OutboxRecord; indexes: { room: string } }
}

export type P2pDatabase = IDBPDatabase<P2pSchema>

export type StoreName = 'self' | 'contacts' | 'meta' | 'rooms' | 'events' | 'children' | 'outbox'

type Upgrade = (
  db: P2pDatabase,
  tx: IDBPTransaction<P2pSchema, StoreName[], 'versionchange'>
) => void

export const UPGRADES: Upgrade[] = [
  db => {
    db.createObjectStore('self', { keyPath: 'id' })
    const contacts = db.createObjectStore('contacts', { keyPath: 'ik' })
    contacts.createIndex('state', 'state')
    db.createObjectStore('meta')
  },
  db => {
    db.createObjectStore('rooms', { keyPath: 'id' }).createIndex('peer', 'peer')
    const events = db.createObjectStore('events', { keyPath: 'id' })
    events.createIndex('room_sort', ['room', 'sortKey'])
    events.createIndex('room_type_sort', ['room', 'type', 'sortKey'])
    events.createIndex('room_target', ['room', 'target'])
    events.createIndex('room_reply', ['room', 'reply'])
    events.createIndex('room_seq', ['room', 'seq'])
    db.createObjectStore('children', { keyPath: ['parent', 'child'] })
    db.createObjectStore('outbox', { keyPath: 'id' }).createIndex('room', 'room')
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
    return {
      contacts: await this.db.count('contacts'),
      rooms: await this.db.count('rooms'),
      events: await this.db.count('events'),
    }
  }

  rooms(): Promise<RoomRecord[]> {
    return this.db.getAll('rooms')
  }

  room(id: string): Promise<RoomRecord | undefined> {
    return this.db.get('rooms', id)
  }

  async updateRoom(id: string, fn: (cur: RoomRecord | undefined) => RoomRecord | null) {
    const tx = this.db.transaction('rooms', 'readwrite')
    const cur = await tx.store.get(id)
    const next = fn(cur)
    if (next) await tx.store.put(next)
    await tx.done
    return next ?? cur
  }

  event(id: string): Promise<EventRecord | undefined> {
    return this.db.get('events', id)
  }

  outbox(room: string): Promise<OutboxRecord[]> {
    return this.db.getAllFromIndex('outbox', 'room', room)
  }
}

export const removeP2pDb = (name: string) => deleteDB(name)
