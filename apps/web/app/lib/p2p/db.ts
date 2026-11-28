import { time } from '../platform/time'
import { deleteDB, openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb'
import type { Contact } from './contacts'
import type { PicWire } from './pictures'
import type { Summary } from './acl/summary'
import type { RoomExtras } from '../profile_fields'
import type { PackedRec } from './acl_room'
import type { Core, Wire } from './event_v1'
import type { WireV2 } from './event_v2'
import type { Cert, KeyPair, Profile, Revocation, Succession } from './keys'
import { deviceKeys } from '../platform'
import { Sealing, sealedDb, sealingOf, vaultOf } from './sealed_db'

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
  // Devices of ours that are not ours any more: disowned as lost or stolen, or signed out by
  // recovery. What they signed is never offered to re-apply.
  lost?: string[]
  // The account badge, when the user turned it on: the binding the instance signed for this
  // identity key (`token`, null until the first one arrives) and when it was fetched. `exp` is
  // when the newest one handed out expires: peers may show the badge until then, also after it
  // is turned off.
  badge?: OwnBadge | null
  // Our profile picture, as our profile carries it (pictures.ts).
  pic?: PicWire | null
}

export interface OwnBadge {
  on: boolean
  token: string | null
  ik: string
  sub: string
  at: number
  exp: number
}

// A browser whose identity moved keeps the public halves (its history stays readable), never
// the secrets: nothing left here can sign for the identity again.
export const withoutSecrets = (s: SelfRecord): SelfRecord => ({
  ...s,
  ik: { pk: s.ik.pk, sk: new Uint8Array(0) },
  dk: { pk: s.dk.pk, sk: new Uint8Array(0) },
})

export const hasSecrets = (s: SelfRecord) => s.ik.sk.length > 0 && s.dk.sk.length > 0

// What a server's evaluator last made of its ACL events (acl_room.ts Summary), shown at once on a
// cold start while the evaluator rebuilds from the stored admission records. `impl` is the
// version of the evaluator and record format, `rules` the server's rules version; a cache of
// another implementation is ignored.
export interface Carry {
  from: string
  roles: Record<string, string>
  state: 'running' | 'waiting' | 'failed' | 'done'
  why?: string
  // The upgrade it carries, its `migrate` chunks, the finished steps, and the roles given back
  // (member and old role id).
  up?: string
  chunks?: Record<string, unknown>[]
  done?: string[]
  given?: string[]
}

export interface ServerCache {
  impl: number
  // The summary's shape (acl_room.ts SUM_SHAPE): a cache of another shape isn't shown.
  shape?: number
  rules: number | null
  count: number
  sum: Summary
}

// Unread messages and pings of one server channel. `threads`: the pings on thread replies, per
// thread root (counted in `pings` too); reading the channel leaves them, reading the thread clears
// them.
export interface ChanCounts {
  unread: number
  pings: number
  readSeq: number
  threads?: Record<string, number>
}

// A conversation (DM) or a P2P server. Its events are the source of truth; this record caches the
// DAG frontier and the counters the room list shows.
export interface RoomRecord {
  id: string
  kind: 'dm' | 'server'
  // P2P servers: what we set for ourselves in this server, written into our `profile` there.
  profile?: RoomExtras
  // What resets of our profile there cleared out of `profile`, kept in case they stop counting.
  profileGone?: RoomExtras
  // When this device sent its `profile` writes of the last hour there.
  profileAt?: number[]
  // The other member of a DM ('' for a server).
  peer: string
  // Events without known children, deepest first.
  heads: { id: string; depth: number }[]
  // Parents we have not seen (bounded); fetched from peers.
  missing: string[]
  maxDepth: number
  count: number
  // P2P servers: the ACL events among `count` (the content budgets don't count them).
  acount?: number
  // Arrival counter: every stored event takes the next number. Unread counts go by arrival.
  lastSeq: number
  readSeq: number
  unread: number
  pings: number
  // A DM's unseen pings on thread replies, per thread root (not in `pings`): reading the thread
  // clears them.
  threads?: Record<string, number>
  // Newest message, for the room list.
  lastTs: number
  // The room reached its event or byte cap on this device.
  full: boolean
  fullWhy?: 'events' | 'bytes'
  // Bytes of the events stored (a room stored without it starts at 0).
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
  // `resync`: a member whose device dropped the room's events takes them again from `from`, the
  // members it knew; it is in as soon as the state it gets says so.
  joining?: { at: number; via: 'code' | 'invite' | 'resync'; ev?: WireV2; from?: string[] } | null
  // When we joined: older history that arrives later isn't counted as unread.
  since?: number
  // When a cascade took our membership (no removal of ours): an invite brings us back in.
  cascade?: number | null
  // Transfer: the new copy this server was transferred to, and the copy a new one
  // follows (its messages show above this one's).
  next?: string
  prev?: string
  // The new owner's carry-over of the copy it follows (server.ts carryOver): role ids old to new,
  // and how far it got.
  carry?: Carry
  // A member's acknowledgements of the carry-over into this copy (server.ts ackCarry): the
  // owners' ACL count at the last one, and how many.
  acks?: { base: number; n: number; max?: number }
  // P2P servers, an old copy after a transfer: each device's last message seq we held
  // when we heard of the upgrade.
  archive?: Record<string, number>
  // P2P servers, a new copy: the most acknowledgements its carry-over may get.
  carryMax?: number
  // P2P servers: this device's key conflicts with another copy of it here.
  conflict?: string
  // P2P servers: when each channel became viewable to us while we were in (its history from
  // before then arrives as nothing new).
  viewFrom?: Record<string, number>
  // An invite from a contact we haven't answered: who sent it and their invite (`add`) event.
  invite?: { from: string; at: number; wire: WireV2 } | null
  // Causes that hide content (removals, bans that hide everything, moderators'
  // redactions): since when (by our clock) each has stood in the state here (S4).
  causes?: Record<string, number>
  // A server made under rules this build doesn't run (test builds): shown read-only.
  legacy?: true
}

// A stored event. DMs hold v1 events (`wire` a Wire); P2P servers hold v2 events, read
// through `serverWire`, with `layer`, the signing device and its seq, and for an admitted ACL event
// its admission order and record.
export interface EventRecord {
  // Rules under which this content was admitted, when the room supports text-only channels.
  contentRules?: number
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
  // P2P servers: the channel of a content event, the thread root of a thread reply, the layer, the
  // device and its seq, and for an admitted ACL event its admission order and record (acl_room.ts).
  chan?: string
  thread?: string
  layer?: 'a' | 'c'
  dev?: string
  dseq?: number
  aseq?: number
  acl?: PackedRec
  // Imported from a transfer file: checked and decided on the next start.
  imp?: true
  // Stored sealed and didn't open here (sealed_db.ts): only the plain fields are real, the wire
  // has no content. Never sent to peers, exported, or stored over the record.
  unreadable?: true
  // P2P servers: the content of a hidden event was purged here, or evicted for space (only its
  // header is left). Never served: a peer asks someone else. `evicted`: a body that
  // showed, evicted for space: fetched again only when it is viewed.
  purged?: true
  evicted?: true
  // P2P servers: when a purged or evicted body came back (not evicted again for
  // DAG.backGraceMs).
  back?: number
  // Root hashes of the files a live message carries (dropped when it is redacted), and the same
  // as `fileKey`s, so the serving gate is one index lookup whatever else is stored.
  atts?: string[]
  files?: string[]
}

// What storage keeps of a P2P server event it dropped: its id, and for an ACL
// event whose header stays, the header (its core and signature, the content `acl/` keeps) with
// its admission order and record. A dropped id is fetched again only when something cites it.
export interface DroppedRecord {
  id: string
  room: string
  layer: 'a' | 'c'
  aseq?: number
  hdr?: WireV2
  acl?: PackedRec
  // Imported from a transfer file: checked on the next start.
  imp?: true
}

export const fileKey = (room: string, sender: string, h: string) => `${room}\n${sender}\n${h}`

// An event record carrying exactly these files (none: no file fields at all).
export const withFiles = (r: EventRecord, atts: string[]): EventRecord => {
  const { atts: _a, files: _f, ...rest } = r
  return atts.length ? { ...rest, atts, files: atts.map(h => fileKey(r.room, r.sender, h)) } : rest
}

// A file this browser holds or is fetching. The sender's own file is kept whole in `file`
// unless sealed rooms refer to it; a downloaded one, and a sealed one, lives in `blob_parts`, one
// verified 1 MiB block per record, and is put together only when it is opened or saved.
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
  // `data` is a device record of the block (sealed_files.ts).
  sealed?: true
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

// A word of a P2P server message (search.ts): one row per word and message, keyed
// `[room, word, message id]`; its value is the start of the message's sort key (time and depth;
// the id ends it), so hits come newest first without reading the events.
export type SearchKey = [string, string, string]

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

// A message this device sends later, while the app runs here (scheduled.ts). Never moved to
// another device.
export interface ScheduledRecord {
  // 16 random bytes, b64u.
  id: string
  // The draft key: room, room/ch, room#thread or room/ch#thread.
  key: string
  body: string
  // An event id.
  reply?: string
  at: number
  next: number
  created: number
  state: 'waiting' | 'sending' | 'failed' | 'missed'
  claim?: string
  claimedAt?: number
  error?: string
}

// A scheduled message of a room or DM that stores its events sealed, as stored: its body and
// reply are in the device record `box` (scheduled_rows.ts).
export type SealedScheduled = Omit<ScheduledRecord, 'body' | 'reply'> & { box: Uint8Array }

export type StoredScheduled = ScheduledRecord | SealedScheduled

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
      room_aseq: [string, number]
      room_sender_sort: [string, string, string]
      room_thread_sort: [string, string, string]
    }
  }
  children: { key: [string, string]; value: { parent: string; child: string } }
  outbox: { key: string; value: OutboxRecord; indexes: { room: string } }
  blobs: { key: string; value: BlobRecord; indexes: { created: number } }
  blob_parts: { key: [string, number]; value: PartRecord }
  blob_hashes: { key: [string, number]; value: HashPage }
  idents: { key: string; value: IdentRecord }
  codes: { key: string; value: CodeRecord; indexes: { room: string } }
  dropped: { key: string; value: DroppedRecord; indexes: { room: string } }
  search: { key: SearchKey; value: string }
  scheduled: { key: string; value: StoredScheduled; indexes: { key: string; next: number } }
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
  | 'dropped'
  | 'search'
  | 'scheduled'

// Where the search index rebuild stands (search.ts): `at` is the last event id indexed; the index
// is complete once `done`.
export interface SearchMeta {
  v: number
  done: boolean
  at: string
  // The cut the rows were made with (search.ts); an index that states none has 32 and 256.
  word?: number
  words?: number
}

// Bytes stored for every P2P server together (dag.ts), the search index included.
export const SERVER_TOTAL_BYTES = 'sbytes'

export const SEARCH_META = 'search'
export const SEARCH_V = 1
export const SEARCH_STALE: SearchMeta = { v: SEARCH_V, done: false, at: '' }

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
  (_db, tx) => {
    tx.objectStore('events').createIndex('room_aseq', ['room', 'aseq'])
  },
  db => {
    db.createObjectStore('dropped', { keyPath: 'id' }).createIndex('room', 'room')
  },
  (_db, tx) => {
    tx.objectStore('events').createIndex('room_sender_sort', ['room', 'sender', 'sortKey'])
  },
  (db, tx) => {
    tx.objectStore('events').createIndex('room_thread_sort', ['room', 'thread', 'sortKey'])
    db.createObjectStore('search')
    void tx.objectStore('meta').put(SEARCH_STALE, SEARCH_META)
  },
  db => {
    const s = db.createObjectStore('scheduled', { keyPath: 'id' })
    s.createIndex('key', 'key')
    s.createIndex('next', 'next')
  },
]

export const DB_VERSION = UPGRADES.length

export const dbName = (instance: string, account: string) => `rchat-p2p:${instance}:${account}`

// `onBlocking` runs when another tab needs a newer schema or deletes the database; closing lets
// it go ahead. Without `create`, a database that does not exist is never made: its first upgrade
// is aborted and the open answers null. Any other failure, an upgrade of a stored one too, throws.
const openRaw = async (name: string, create: boolean, onBlocking: () => void) => {
  let missing = false
  try {
    return await openDB<P2pSchema>(name, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, tx) {
        if (oldVersion === 0 && !create) {
          missing = true
          tx.done.catch(() => {})
          return tx.abort()
        }
        for (let v = oldVersion; v < DB_VERSION; v += 1) UPGRADES[v](db, tx)
        void tx.objectStore('meta').put(DB_VERSION, 'schema')
      },
      blocking: onBlocking,
    })
  } catch (e) {
    if (missing) return null
    throw e
  }
}

// The database `name` behind the handle that seals and opens the events of sealed rooms, or null
// as `openRaw` answers it. A `blocking` call that comes before the caller holds the handle closes
// the database here, and the caller hears of it once it has the handle.
const openSealed = async (name: string, create: boolean, onBlocking: () => void) => {
  let handed = false
  let early = false
  let opened: IDBPDatabase<P2pSchema> | null = null
  const raw = await openRaw(name, create, () => {
    if (handed) return onBlocking()
    early = true
    opened?.close()
  })
  if (!raw) return null
  opened = raw
  if (early) raw.close()
  const vault = vaultOf(raw as unknown as IDBPDatabase<unknown>)
  const sealing = new Sealing(raw as unknown as IDBPDatabase<unknown>, () => deviceKeys(vault))
  await sealing.load().catch((e: unknown) => {
    if (!early) throw e
  })
  handed = true
  if (early) time().after(0, onBlocking)
  return sealedDb(raw, sealing)
}

// The database `name`, made when there is none.
export const openP2pDb = async (name: string, onBlocking: () => void = () => {}) =>
  (await openSealed(name, true, onBlocking))!

export class P2pStore {
  closed = false

  private constructor(readonly db: P2pDatabase) {}

  private static async at(name: string, create: boolean, onBlocking?: () => void) {
    let store: P2pStore | null = null
    const db = await openSealed(name, create, () => {
      store?.close()
      onBlocking?.()
    })
    if (!db) return null
    store = new P2pStore(db)
    return store
  }

  // The database as it is stored; null when there is none (never made, or deleted).
  static open(name: string, onBlocking?: () => void) {
    return P2pStore.at(name, false, onBlocking)
  }

  // The database, made empty when there is none yet: only for a new identity or an import.
  static async create(name: string, onBlocking?: () => void) {
    return (await P2pStore.at(name, true, onBlocking))!
  }

  close() {
    this.closed = true
    this.db.close()
  }

  get name() {
    return this.db.name
  }

  // Which rooms and DMs of this database store their events sealed.
  get sealing() {
    return sealingOf(this.db) as Sealing
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

  // Reads and writes one meta value in a single transaction: `fn` answers the new value, or null
  // to keep what is there.
  async updateMeta(key: string, fn: (cur: unknown) => unknown) {
    const tx = this.db.transaction('meta', 'readwrite')
    const cur: unknown = await tx.store.get(key)
    const next = fn(cur)
    if (next !== null) await tx.store.put(next, key)
    await tx.done
    return next ?? cur
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

  // The first message from someone else that arrived after `seq`, outside threads: in a
  // conversation, by arrival; in one channel of a P2P server (`ch`, top level), newest first back
  // to the first one already read. It looks at `max` events at most.
  async firstMessageAfter(
    room: string,
    seq: number,
    me: string,
    ch?: string,
    max = 2000
  ): Promise<EventRecord | null> {
    const theirs = (r: EventRecord) => r.type === 'msg' && r.sender !== me && !r.redacted
    const tx = this.db.transaction('events')
    let found: EventRecord | null = null
    let seen = 0
    if (ch === undefined) {
      const range = IDBKeyRange.bound([room, seq + 1], [room, Infinity])
      for (
        let cur = await tx.store.index('room_seq').openCursor(range);
        cur && seen < max && !found;
        cur = await cur.continue()
      ) {
        seen += 1
        const r = cur.value
        if (theirs(r) && !(await dmRootOf(r, id => tx.store.get(id)))) found = r
      }
    } else {
      const range = IDBKeyRange.bound([room, ch, ''], [room, ch, '\uffff'])
      for (
        let cur = await tx.store.index('room_chan_sort').openCursor(range, 'prev');
        cur && seen < max;
        cur = await cur.continue()
      ) {
        seen += 1
        const r = cur.value
        if (r.thread !== undefined || r.type !== 'msg') continue
        if (r.seq <= seq) break
        if (theirs(r)) found = r
      }
    }
    await tx.done.catch(() => {})
    return found
  }
}

// The thread a message of a conversation replies in: its root, a top-level message of the same
// conversation. `get` reads events (within an open transaction, when one is).
export const dmRootOf = async (
  rec: Pick<EventRecord, 'room' | 'thread'>,
  get: (id: string) => Promise<EventRecord | undefined>
) => {
  if (!rec.thread) return null
  const r = await get(rec.thread)
  return r && r.room === rec.room && r.type === 'msg' && !r.thread ? rec.thread : null
}

export const removeP2pDb = (name: string) => deleteDB(name)

// The v2 event of a P2P server's stored record.
export const serverWire = (r: Pick<EventRecord, 'wire'>) => r.wire as unknown as WireV2
