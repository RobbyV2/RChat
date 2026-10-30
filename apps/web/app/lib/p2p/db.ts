import { deleteDB, openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb'
import type { Contact } from './contacts'
import type { Core, Wire } from './event'
import type { Cert, KeyPair, Profile, Revocation, Succession } from './keys'
import type { Membership } from './state'

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
  // A P2P export was made here: sending pauses until the user resumes, so nothing written here
  // is left behind by the move.
  moving?: { at: number } | null
  // The last P2P export from here; a move without one is unexpected.
  exported?: number | null
  // When we saw signs that another device uses this identity.
  alert?: number | null
  // Transfer files already imported into this identity (their ids).
  imports?: string[]
}

// A browser whose identity moved keeps the public halves (its history stays readable), never
// the secrets: nothing left here can sign for the identity again.
export const withoutSecrets = (s: SelfRecord): SelfRecord => ({
  ...s,
  ik: { pk: s.ik.pk, sk: new Uint8Array(0) },
  dk: { pk: s.dk.pk, sk: new Uint8Array(0) },
})

export const hasSecrets = (s: SelfRecord) => s.ik.sk.length > 0 && s.dk.sk.length > 0

// What resolution last made of a server's state events (resolve.ts), so it isn't replayed on
// every start: the state as (state key, event id) pairs, the state heads, the rejected events
// (all of them: later events are checked against them), events lost in merges, and accepted
// membership events with the membership before them. `count` is the number of state events it
// covers and `rules` the version of the rules it was made under; a different one means it is
// stale.
export interface ServerCache {
  rules?: number
  count: number
  entries: [string, string][]
  heads: string[]
  rejected: string[]
  lost?: string[]
  transitions: [string, Membership | null][]
  joins: [string, string][]
  gaps?: number
  flagged?: [string, number][]
  power?: [string, string][]
}

// Unread messages and pings of one server channel.
export interface ChanCounts {
  unread: number
  pings: number
  readSeq: number
}

// A conversation (DM) or a P2P server. Its events are the source of truth; this record caches the
// DAG frontier and the counters the room list shows.
export interface RoomRecord {
  id: string
  kind: 'dm' | 'server'
  // The other member of a DM ('' for a server).
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
  // P2P servers: the name to show before the state arrives, the resolution cache, counters per
  // channel, and when we were let in or are still joining (redeemed a code, accepted an invite).
  name?: string
  server?: ServerCache | null
  chans?: Record<string, ChanCounts>
  // `ev`: the invite an admitting member signed for us when we redeemed a code. It enters the
  // room (ours to store) once we have the room's state, and we join right after.
  joining?: { at: number; via: 'code' | 'invite'; ev?: Wire } | null
  // When we joined: older history that arrives later isn't counted as unread.
  since?: number
  // An invite from a contact we haven't answered: who sent it and their invite event.
  invite?: { from: string; at: number; wire: Wire } | null
  // Our own chain in the room (note section 6): our latest event, its number and window count,
  // and our latest state event.
  mine?: {
    last: string
    dseq: number
    ts: number
    dwin: number
    sprev?: string
    sseq?: number
  } | null
  // Members seen equivocating here (two events with one number), and the first such number:
  // their messages from there on aren't shown.
  flagged?: Record<string, number>
  // Bans in the resolved state: since when (by our clock) each has stood, and whether what the
  // banned member wrote and never showed has been purged.
  bans?: Record<string, { ban: string; since: number; purged?: true }>
}

export interface EventRecord {
  id: string
  room: string
  type: Core['type']
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
  // P2P servers: the channel of a message, state events (`state: 1`, with their state key), and
  // a redaction made with Manage messages.
  chan?: string
  state?: 1
  skey?: string
  mod?: true
  // P2P servers: a message from someone who wasn't a member when it arrived and isn't an
  // ancestor of their removal (soft-failed): the removal (`true` from older builds). It stays
  // hidden even if they come back, unless that removal is overturned.
  soft?: true | string
  // P2P servers: the content of a banned member's hidden event was purged here (only the header
  // the DAG needs is left). Never served: a peer asks someone else.
  purged?: true
  // P2P servers: the sender's chain number, and along their state events the hourly count and
  // whether they left since they last joined (note section 6).
  dseq?: number
  cw?: number
  cl?: true
  // Root hashes of the files a live message carries (dropped when it is redacted), and the same
  // as `fileKey`s, so the serving gate is one index lookup whatever else is stored.
  atts?: string[]
  files?: string[]
}

export const fileKey = (room: string, sender: string, h: string) => `${room}\n${sender}\n${h}`

// An event record carrying exactly these files (none: no file fields at all).
export const withFiles = (r: EventRecord, atts: string[]): EventRecord => {
  const { atts: _a, files: _f, ...rest } = r
  return atts.length ? { ...rest, atts, files: atts.map(h => fileKey(r.room, r.sender, h)) } : rest
}

// A file this browser holds or is fetching (note section 5). The sender's own file is kept
// whole in `file`; a downloaded one lives in `blob_parts`, one verified 1 MiB block per record,
// and is put together only when it is opened or saved.
export interface BlobRecord {
  h: string
  size: number
  // The block hashes are stored (in `blob_hashes`, written once) and were checked against `h`.
  hashed: boolean
  // Blocks stored in blob_parts.
  have: number
  done: boolean
  file?: Blob
  // What the first bytes say it is (sniff.ts), once known; never what the sender claimed.
  type: string | null
  // Sent from here.
  own: boolean
  // The user (or auto-download) asked for it: an unfinished download resumes when a holder is
  // online.
  wanted: boolean
  created: number
  lastUsed: number
}

// Block hashes of a file, HASH_PAGE per page (32 bytes each, in block order).
export interface HashPage {
  h: string
  page: number
  data: Uint8Array
}

export interface PartRecord {
  h: string
  block: number
  data: Blob
}

// What we know of a P2P server member who isn't a contact: devices and profile, all signed by
// their identity key (from member events and their hello).
export interface IdentRecord {
  ik: string
  certs: Cert[]
  revocations: Revocation[]
  profile: Profile | null
  updated: number
}

// An invite code we issued: the secret stays on this device (the room only holds its hash).
export interface CodeRecord {
  hash: string
  room: string
  secret: string
  exp: number
  label: string
  created: number
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
      att: string
      file: string
      room_chan_sort: [string, string, string]
      room_state: [string, number]
      room_dseq: [string, string, number]
    }
  }
  children: { key: [string, string]; value: { parent: string; child: string } }
  outbox: { key: string; value: OutboxRecord; indexes: { room: string } }
  blobs: { key: string; value: BlobRecord; indexes: { created: number } }
  blob_parts: { key: [string, number]; value: PartRecord }
  blob_hashes: { key: [string, number]; value: HashPage }
  idents: { key: string; value: IdentRecord }
  codes: { key: string; value: CodeRecord; indexes: { room: string } }
}

export type P2pDatabase = IDBPDatabase<P2pSchema>

export type StoreName =
  | 'self'
  | 'contacts'
  | 'meta'
  | 'rooms'
  | 'events'
  | 'children'
  | 'outbox'
  | 'blobs'
  | 'blob_parts'
  | 'blob_hashes'
  | 'idents'
  | 'codes'

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
  (db, tx) => {
    tx.objectStore('events').createIndex('att', 'atts', { multiEntry: true })
    tx.objectStore('events').createIndex('file', 'files', { multiEntry: true })
    db.createObjectStore('blobs', { keyPath: 'h' }).createIndex('created', 'created')
    db.createObjectStore('blob_parts', { keyPath: ['h', 'block'] })
    db.createObjectStore('blob_hashes', { keyPath: ['h', 'page'] })
  },
  (db, tx) => {
    tx.objectStore('events').createIndex('room_chan_sort', ['room', 'chan', 'sortKey'])
    tx.objectStore('events').createIndex('room_state', ['room', 'state'])
    tx.objectStore('events').createIndex('room_dseq', ['room', 'sender', 'dseq'])
    db.createObjectStore('idents', { keyPath: 'ik' })
    db.createObjectStore('codes', { keyPath: 'hash' }).createIndex('room', 'room')
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

  async updateBlob(h: string, fn: (cur: BlobRecord | undefined) => BlobRecord | null) {
    const tx = this.db.transaction('blobs', 'readwrite')
    const cur = await tx.store.get(h)
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
