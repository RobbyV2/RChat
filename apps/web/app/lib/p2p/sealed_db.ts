import { sleep } from '../clock'
import { time } from '../platform/time'
import type { IDBPDatabase } from 'idb'
import type { DeviceKey, DeviceKeys, KeyVault } from '../platform'
import { DEVICE_KEYS_META } from '../platform/device_keys'
import { deviceAad, deviceSearchKey, openDevice, recordHeader, sealDevice } from '../seal_record'
import { keyedWords, type Keyed } from './search_keys'

// Sealed event storage. A sealed room or DM keeps the `wire` of every event it stores as a device
// record (seal_record.ts) under this device's key; ids, room ids, senders, sort keys, channels and
// times stay as they are. The database handle the rest of the app uses seals on the way in and
// opens on the way out, so the code above it reads and writes whole events. A row says its own
// form, so a room switches any number of times, and a handle opened before anything was sealed
// reads what another one sealed since. What is stored sealed stays sealed: a record read from a
// sealed one is sealed again when it is written, whatever the switches say now.

const EVENTS = 'events'
const CHECK = 'check'

// The `meta` key of what is sealed here.
export const SEALED_META = 'sealed_rooms'

// The `meta` entries that belong to this device and never leave it or get replaced by an import:
// its device keys and what they sealed.
export const DEVICE_META: readonly string[] = [DEVICE_KEYS_META, SEALED_META]

interface Kept {
  v: 1
  // Every room and DM: the site requires it.
  all: boolean
  rooms: string[]
  // The device keys records here were sealed with.
  keys: number[]
  // A record under each of those keys, to tell a key that is still the same one.
  checks: Record<string, Uint8Array>
}

const kept = (value: unknown): Kept => {
  const blank: Kept = { v: 1, all: false, rooms: [], keys: [], checks: {} }
  if (typeof value !== 'object' || value === null) return blank
  const { v, all, rooms, keys, checks } = value as Partial<Kept>
  if (v !== 1) return blank
  const held: Record<string, Uint8Array> = {}
  if (typeof checks === 'object' && checks !== null)
    for (const [id, record] of Object.entries(checks))
      if (ArrayBuffer.isView(record)) held[id] = record
  return {
    v: 1,
    all: all === true,
    rooms: Array.isArray(rooms) ? rooms.filter(r => typeof r === 'string') : [],
    keys: Array.isArray(keys) ? keys.filter(k => Number.isInteger(k)) : [],
    checks: held,
  }
}

type Raw = IDBPDatabase<unknown>

interface Sealable {
  id: string
  room: string
  wire: unknown
}

const enc = new TextEncoder()
const dec = new TextDecoder()

const LOST_TRIES = 3
const LOST_PAUSE_MS = 250
const wait = (ms: number) => sleep(time(), ms)

export const isSealed = (v: unknown): v is Sealable & { wire: Uint8Array } =>
  typeof v === 'object' && v !== null && ArrayBuffer.isView((v as Sealable).wire)

// The mark of a record the handle read from a sealed one or wrote sealed. Copies made by spreading
// the record keep it; it is never stored, exported or sent.
const SEALED = Symbol('sealed')

type Marked = Record<typeof SEALED, true | undefined>

// Whether a record is stored sealed: it was read from a sealed record, or written sealed.
export const storedSealed = (v: unknown) =>
  isSealed(v) || (typeof v === 'object' && v !== null && (v as Marked)[SEALED] === true)

// Marks a record the way the handle just stored it.
const markStored = (v: unknown, sealed: boolean) => {
  if (typeof v !== 'object' || v === null) return
  if (sealed) (v as Marked)[SEALED] = true
  else delete (v as Marked)[SEALED]
}

interface Plain {
  room: string
  type?: string
  sender?: string
  depth?: number
  effTs?: number
  layer?: 'a' | 'c'
  dev?: string
  dseq?: number
}

// A stored record that doesn't open (damaged, or its key can't be read now), as the app reads it:
// its plain fields, and a wire without content or signature. It is never sent or stored again.
const unopened = <T extends Sealable>(rec: T): T => {
  const {
    room,
    type = '',
    sender = '',
    depth = 0,
    effTs = 0,
    layer,
    dev = '',
    dseq = 0,
  } = rec as T & Plain
  const ev =
    layer === undefined
      ? { v: 1, room, type, sender, dev, ts: effTs, depth, prev: [], ch: '' }
      : {
          v: 2,
          srv: room,
          t: type,
          L: layer,
          a: sender,
          dev,
          seq: dseq,
          ts: effTs,
          prev: [],
          ch: '',
        }
  return { ...rec, wire: { ev, c: null, sig: '' }, unreadable: true, [SEALED]: true }
}

// A record that didn't open, or one made from it (it keeps the empty signature): a write of it
// leaves the stored record as it is.
const unchanged = (v: unknown) =>
  typeof v === 'object' &&
  v !== null &&
  (v as { unreadable?: unknown }).unreadable === true &&
  (v as { wire?: { sig?: unknown } }).wire?.sig === ''

// A record that holds a whole event again, for instance with a wire a peer sent in place of one
// that didn't open.
const whole = <T>(v: T): T => {
  if (typeof v !== 'object' || v === null || !('unreadable' in v)) return v
  const { unreadable: _u, ...rest } = v as T & { unreadable?: unknown }
  return rest as T
}

// The keyed rows of the search index: those a message stored sealed gets now, under the current
// device key, and those of every device key that sealed here, which are found and taken out
// whatever the switches say now.
export interface SearchForm {
  keyed: Keyed | null
  every: readonly Keyed[]
}

export const PLAIN_FORM: SearchForm = { keyed: null, every: [] }

// Which rooms of one P2P database store their events sealed, and the keys that seal them.
export class Sealing {
  private rooms = new Set<string>()
  private all = false
  private used = new Set<number>()
  private checks: Record<string, Uint8Array> = {}
  private cur: DeviceKey | null = null
  // The search key of the current device key and of every one that sealed here.
  private search = new Map<number, Uint8Array>()
  private held = new Map<number, CryptoKey | null>()
  // Stored records that didn't open since this database was opened.
  unreadable = 0

  constructor(
    private raw: Raw,
    private keys: () => DeviceKeys
  ) {}

  // The database as it is stored, for what handles records it can't open.
  get stored() {
    return this.raw
  }

  async load() {
    const k = kept(await this.raw.get('meta', SEALED_META))
    this.rooms = new Set(k.rooms)
    this.all = k.all
    this.used = new Set(k.keys)
    this.checks = k.checks
    if (this.all || this.rooms.size || this.used.size) await this.ready().catch(() => {})
    for (const id of this.used) await this.key(id).catch(() => null)
  }

  // Whether new events of `room` are stored sealed.
  on(room: string) {
    return this.cur !== null && (this.all || this.rooms.has(room))
  }

  // The room's own switch, whatever the site requires.
  room(room: string) {
    return this.rooms.has(room)
  }

  get everything() {
    return this.all
  }

  // Whether a device key ever sealed records here.
  get sealedAny() {
    return this.used.size > 0
  }

  // Whether this device can keep a device key.
  async available() {
    try {
      await this.ready()
      return true
    } catch {
      return false
    }
  }

  private async ready() {
    if (this.cur) return this.cur
    const cur = await this.keys().current()
    const search = await deviceSearchKey(cur.key)
    if (this.cur) return this.cur
    this.cur = cur
    this.search.set(cur.id, search)
    this.held.set(cur.id, cur.key)
    return cur
  }

  // The keyed rows of the search index (`SearchForm`). `exact` is the length up to which query
  // words match whole words only.
  form(exact: number): SearchForm {
    const every = new Map([...this.search].map(([id, key]) => [id, keyedWords(key, id, exact)]))
    return { keyed: (this.cur && every.get(this.cur.id)) ?? null, every: [...every.values()] }
  }

  private async save() {
    const tx = this.raw.transaction('meta', 'readwrite')
    const value: Kept = {
      v: 1,
      all: this.all,
      rooms: [...this.rooms].sort(),
      keys: [...this.used].sort((a, b) => a - b),
      checks: this.checks,
    }
    await tx.store.put(value, SEALED_META)
    await tx.done
  }

  // Turns sealed storage of `room` on or off for the events stored from now on. Turning it on
  // needs a device key; it throws when this device can't keep one.
  async setRoom(room: string, on: boolean) {
    if (on === this.rooms.has(room)) return
    if (on) await this.note()
    if (on) this.rooms.add(room)
    else this.rooms.delete(room)
    await this.save()
  }

  // The site requires sealed storage: every room and DM.
  async setAll(on: boolean) {
    if (on === this.all) return
    if (on) await this.note()
    this.all = on
    await this.save()
  }

  // The key is recorded as used before the first record under it is written.
  private async note() {
    const cur = await this.ready()
    if (this.used.has(cur.id)) return
    this.used.add(cur.id)
    const aad = deviceAad(CHECK, String(cur.id), '')
    this.checks[String(cur.id)] = await sealDevice(cur.key, cur.id, aad, enc.encode(CHECK))
    await this.save()
  }

  // Whether a key that sealed records here is gone from this device, or is another key now. A
  // key that doesn't open is asked for again first: a store that fails a read answers like one
  // that never had the key.
  async lost(pause: (ms: number) => Promise<void> = wait) {
    for (const id of this.used) {
      let key = await this.key(id)
      for (let i = 1; !key && i < LOST_TRIES; i += 1) {
        await pause(LOST_PAUSE_MS * i)
        key = await this.key(id)
      }
      const check = this.checks[String(id)]
      if (!key) return true
      if (check && !(await openDevice(key, deviceAad(CHECK, String(id), ''), check))) return true
    }
    return false
  }

  // Forgets everything that was sealed, after its rows were removed.
  async reset() {
    this.rooms.clear()
    this.used.clear()
    this.checks = {}
    this.held.clear()
    this.cur = null
    this.search.clear()
    await this.save()
  }

  private async key(id: number) {
    const have = this.held.get(id)
    if (have !== undefined) return have
    const key = await this.keys()
      .byId(id)
      .catch(() => null)
    if (!key) return key
    if (this.used.has(id) && !this.search.has(id)) this.search.set(id, await deviceSearchKey(key))
    this.held.set(id, key)
    return key
  }

  // The stored form of an event record.
  async seal<T extends Sealable>(rec: T): Promise<T> {
    const cur = this.cur
    if (!cur || !this.needsSeal(rec)) return rec
    const wire = await sealDevice(
      cur.key,
      cur.id,
      deviceAad(EVENTS, rec.id, rec.room),
      enc.encode(JSON.stringify(rec.wire))
    )
    return { ...rec, wire }
  }

  // Whether a write of `rec` stores it sealed: its room is sealed, or it was stored sealed.
  needsSeal(rec: unknown) {
    if (typeof rec !== 'object' || rec === null || isSealed(rec)) return false
    const { room } = rec as Sealable
    return typeof room === 'string' && (this.on(room) || (this.cur !== null && storedSealed(rec)))
  }

  // A device record of `value` for the entry `key` of `store` in `room`, for what is kept beside
  // the events of a sealed room (the inbox rows of its pings); null while `room` stores its
  // events plain.
  async box(store: string, key: string, room: string, value: unknown): Promise<Uint8Array | null> {
    if (!this.on(room)) return null
    return this.sealBytes(store, key, room, enc.encode(JSON.stringify(value)))
  }

  // What a record `box` made holds; undefined, and counted, when it doesn't open.
  async unbox(store: string, key: string, room: string, record: Uint8Array): Promise<unknown> {
    const plain = await this.openBytes(store, key, room, record)
    const value = plain ? parsed(plain) : undefined
    if (plain && value === undefined) this.unreadable += 1
    return value
  }

  // The rooms whose own switch stores their events sealed.
  sealedRooms(): readonly string[] {
    return [...this.rooms]
  }

  // A device record of `plain` under the current key; null without one.
  async sealBytes(store: string, key: string, room: string, plain: Uint8Array) {
    const cur = this.cur
    return cur ? sealDevice(cur.key, cur.id, deviceAad(store, key, room), plain) : null
  }

  // What a device record holds; null, and counted, when it doesn't open.
  async openBytes(store: string, key: string, room: string, record: Uint8Array) {
    const id = recordHeader(record)?.keyId
    const held = id === undefined ? null : await this.key(id)
    const plain = held && (await openDevice(held, deviceAad(store, key, room), record))
    if (!plain) this.unreadable += 1
    return plain ?? null
  }

  // The event record a stored one holds. One that doesn't open reads as `unopened` and is
  // counted; a key that is gone is `lost()`'s to handle at the next start.
  async open<T>(rec: T): Promise<T> {
    if (!isSealed(rec)) return rec
    const id = recordHeader(rec.wire)?.keyId
    const key = id === undefined ? null : await this.key(id)
    const plain = key && (await openDevice(key, deviceAad(EVENTS, rec.id, rec.room), rec.wire))
    const wire = plain && parsed(plain)
    if (wire !== undefined && wire !== null) return { ...rec, wire, [SEALED]: true }
    this.unreadable += 1
    return unopened(rec)
  }
}

const parsed = (plain: Uint8Array): unknown => {
  try {
    return JSON.parse(dec.decode(plain)) as unknown
  } catch {
    return undefined
  }
}

// A site that requires encrypted storage has this device seal what it stores of every room and
// DM of its identities, whatever each room's own switch says. Only the site's answer changes
// it: settings that have not loaded (offline, or not yet) keep what is stored.
export const followSiteSeal = (sealing: Sealing, required: unknown) =>
  typeof required === 'boolean' ? sealing.setAll(required).catch(() => {}) : Promise.resolve()

const SEALINGS = new WeakMap<object, Sealing>()

// The sealing of a database handle `sealedDb` made.
export const sealingOf = (db: object): Sealing | undefined => SEALINGS.get(db)

// The keyed search rows of a database handle (see `Sealing.form`).
export const searchForm = (db: object, exact: number): SearchForm =>
  sealingOf(db)?.form(exact) ?? PLAIN_FORM

type Fn = (...args: unknown[]) => unknown
type Thing = Record<string | symbol, unknown>

const bound = (target: Thing, prop: string | symbol) => {
  const value = target[prop]
  return typeof value === 'function' ? (value as Fn).bind(target) : value
}

const call = (target: Thing, prop: string, args: unknown[]) =>
  (target[prop] as Fn).apply(target, args) as Promise<unknown>

// Waits for `work`, which is no database request, inside a transaction: requests on `store` keep
// the transaction open until it settles.
async function during<T>(store: Thing, work: Promise<T>): Promise<T> {
  let done: { value: T } | { error: unknown } | null = null as
    { value: T } | { error: unknown } | null
  work.then(
    value => {
      done = { value }
    },
    (error: unknown) => {
      done = { error }
    }
  )
  while (done === null) await call(store, 'count', [''])
  if ('error' in done) throw done.error
  return done.value
}

// The key a write of `rec` answers with when it leaves the stored record as it is.
const keyOf = (rec: unknown, key: unknown) => key ?? (rec as { id?: unknown } | null)?.id

const READS = new Set(['get', 'getAll'])
const WRITES = new Set(['put', 'add'])
const MOVES = new Set(['continue', 'advance', 'continuePrimaryKey'])

function inTx(s: Sealing, store: Thing) {
  const opened = async (value: unknown): Promise<unknown> => {
    if (Array.isArray(value)) {
      if (!value.some(isSealed)) return value
      const out: unknown[] = []
      for (const v of value) out.push(isSealed(v) ? await during(store, s.open(v)) : v)
      return out
    }
    return isSealed(value) ? during(store, s.open(value)) : value
  }
  const write = (target: Thing, prop: string, args: unknown[], key: unknown) => {
    const [rec, ...rest] = args
    if (unchanged(rec)) return Promise.resolve(key)
    const next = whole(rec)
    if (!s.needsSeal(next)) {
      markStored(rec, isSealed(next))
      return call(target, prop, [next, ...rest])
    }
    return during(store, s.seal(next as Sealable)).then(sealed => {
      markStored(rec, isSealed(sealed))
      return call(target, prop, [sealed, ...rest])
    })
  }
  const cursor = async (found: unknown): Promise<unknown> => {
    if (!found) return found
    const cur = found as Thing
    const value = await opened(cur.value)
    return new Proxy(cur, {
      get(target, prop) {
        if (prop === 'value') return value
        if (typeof prop === 'string' && MOVES.has(prop))
          return (...args: unknown[]) => call(target, prop, args).then(cursor)
        if (prop === 'update')
          return (...args: unknown[]) => write(target, 'update', args, target.primaryKey)
        return bound(target, prop)
      },
    })
  }
  const source = (found: Thing): Thing =>
    new Proxy(found, {
      get(target, prop) {
        if (typeof prop !== 'string') return bound(target, prop)
        if (READS.has(prop)) return (...args: unknown[]) => call(target, prop, args).then(opened)
        if (WRITES.has(prop))
          return (...args: unknown[]) => write(target, prop, args, keyOf(args[0], args[1]))
        if (prop === 'openCursor')
          return (...args: unknown[]) => call(target, prop, args).then(cursor)
        if (prop === 'index') return (name: unknown) => source(call(target, prop, [name]) as never)
        return bound(target, prop)
      },
    })
  return source(store)
}

function transaction(s: Sealing, tx: Thing): Thing {
  let events: Thing | null = null
  const store = () => (events ??= inTx(s, (tx.objectStore as Fn).call(tx, EVENTS) as Thing))
  return new Proxy(tx, {
    get(target, prop) {
      if (prop === 'objectStore')
        return (name: unknown) =>
          name === EVENTS ? store() : (target.objectStore as Fn).call(target, name)
      if (prop === 'store') {
        const names = target.objectStoreNames as { length: number; contains(n: string): boolean }
        return names.length === 1 && names.contains(EVENTS) ? store() : target.store
      }
      return bound(target, prop)
    },
  })
}

const DIRECT_READS = new Set(['get', 'getAll', 'getFromIndex', 'getAllFromIndex'])

// `raw` as the app uses it: event records pass through `sealing` on their way in and out.
export function sealedDb<D extends object>(raw: D, sealing: Sealing): D {
  const all = async (value: unknown): Promise<unknown> => {
    if (!Array.isArray(value)) return sealing.open(value)
    if (!value.some(isSealed)) return value
    return Promise.all(value.map(v => sealing.open(v)))
  }
  // A member set on the handle replaces it for every caller and stays off the database itself.
  const replaced = new Map<string | symbol, unknown>()
  const db = new Proxy(raw as Thing, {
    set(_target, prop, value) {
      replaced.set(prop, value)
      return true
    },
    get(target, prop) {
      if (replaced.has(prop)) return replaced.get(prop)
      if (typeof prop !== 'string') return bound(target, prop)
      if (prop === 'transaction')
        return (...args: unknown[]) => {
          const tx = (target.transaction as Fn).apply(target, args) as Thing
          const names = tx.objectStoreNames as { contains(n: string): boolean }
          return names.contains(EVENTS) ? transaction(sealing, tx) : tx
        }
      if (DIRECT_READS.has(prop))
        return (...args: unknown[]) =>
          args[0] === EVENTS ? call(target, prop, args).then(all) : call(target, prop, args)
      if (WRITES.has(prop))
        return async (...args: unknown[]) => {
          if (args[0] !== EVENTS) return call(target, prop, args)
          const [name, rec, ...rest] = args
          if (unchanged(rec)) return keyOf(rec, rest[0])
          const next = whole(rec)
          const value = sealing.needsSeal(next) ? await sealing.seal(next as Sealable) : next
          markStored(rec, isSealed(value))
          return call(target, prop, [name, value, ...rest])
        }
      return bound(target, prop)
    },
  }) as D
  SEALINGS.set(db, sealing)
  return db
}

// The vault of the device keys of a database: its own `meta` store.
export const vaultOf = (raw: Raw): KeyVault => ({
  name: raw.name,
  meta: <T>(key: string) => raw.get('meta', key) as Promise<T | undefined>,
  async updateMeta(key, fn) {
    const tx = raw.transaction('meta', 'readwrite')
    const cur: unknown = await tx.store.get(key)
    const next = fn(cur)
    if (next !== null) await tx.store.put(next, key)
    await tx.done
    return next ?? cur
  },
})
