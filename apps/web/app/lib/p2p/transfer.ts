import { isRecord } from '../bytes'
import { capabilities } from '../platform'
import { eachPercent, type KdfJob, type KdfReply } from './kdf_job'
import { argon2idAsync } from '@noble/hashes/argon2.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import {
  b64u,
  bytesOf,
  canonical,
  concat,
  equalBytes,
  fromB64u,
  nfc,
  randomBytes,
  utf8,
} from './canonical'
import {
  isKeyId,
  keyId,
  newKeyPair,
  publicOf,
  signCert,
  signRevocation,
  verifyCert,
  verifyProfile,
  type KeyPair,
} from './keys'
import {
  CERTS_KEPT,
  mergeCerts,
  mergeContact,
  mergeRevocations,
  visibleContacts,
  type Contact,
} from './contacts'
import {
  blankRoom,
  insertInto,
  countOf,
  moveCounts,
  SERVER_ACL,
  SERVER_TOTAL,
  SERVER_TOTAL_BYTES,
  storedSize,
  TOTAL,
  TOTAL_BYTES,
  type InsertTx,
} from './dag'
import type {
  BlobRecord,
  EventRecord,
  OutboxRecord,
  P2pDatabase,
  RoomRecord,
  SelfRecord,
  StoreName,
} from './db'
import {
  DB_VERSION,
  hasSecrets,
  SEARCH_META,
  SEARCH_STALE,
  serverWire,
  withFiles,
  withoutSecrets,
} from './db'
import { attsOf, isEventId, LIMITS as EV } from './content'
import { buildEvent, claimedId, type Wire } from './event_v1'
import { claimedId2 } from './event_v2'
import { fingerprint } from './keys'
import { hashPages, partRange, readBlock } from './blobs'
import { BLOCK, blobRootOf, blockCount, digest } from './hashing'
import { LOCAL } from './limits'
import { NEUTRAL_TYPE, safeType, SNIFF_BYTES } from '../sniff'
import { IV_BYTES, SALT_BYTES, type Kdf, type P2pSection } from './section'

// Moving P2P to another device (note section 7): every store except the excluded ones is dumped
// as JSON lines, deflated, and sealed with AES-256-GCM under a key from Argon2id over a
// passphrase. The section goes into the config string and the `.rchat` file only.
//
// Importing writes everything in one IndexedDB transaction (aborted on any error, so nothing
// is half written) and then, on a new device, makes a new device key: the identity signs its
// cert and a revocation of the old one, and a `move` event on top of every room's heads vouches
// for the history the old device signed.

export { type Kdf, type P2pSection } from './section'

// The search index is rebuilt; meta holds counters and flags of this browser only. Files never
// go into the dump: when the user asks for them, they follow it in the `.rchat` file, streamed
// (see `writeFiles`).
export const EXCLUDED: ReadonlySet<string> = new Set([
  'blobs',
  'blob_parts',
  'blob_hashes',
  'search',
  'meta',
])

// Bytes of the complete files stored here (sent and downloaded).
export const filesSize = async (db: P2pDatabase) =>
  (await db.getAll('blobs')).reduce((n, r) => n + (r.done ? r.size : 0), 0)

// Desktop finishes in about a second, a mid-range phone in two to three. Files say which
// parameters they used; unlocking refuses anything below the minimum or above the maximum.
const TR = LOCAL.transfer
export const KDF_DESKTOP: Kdf = {
  alg: 'argon2id',
  m: TR.kdfDesktopM,
  t: TR.kdfDesktopT,
  p: TR.kdfDesktopP,
}
export const KDF_MOBILE: Kdf = {
  alg: 'argon2id',
  m: TR.kdfMobileM,
  t: TR.kdfMobileT,
  p: TR.kdfMobileP,
}
export const KDF_MIN = { m: TR.kdfMinM, t: TR.kdfMinT, p: TR.kdfMinP }
export const KDF_MAX = { m: TR.kdfMaxM, t: TR.kdfMaxT, p: TR.kdfMaxP }

export const PASS_MIN = TR.passMin
// What a dump may inflate to.
export const DUMP_MAX = TR.dumpMax

// Shown while the key is made in JavaScript, once that has run `SLOW_AFTER` ms.
export const SLOW_KDF = 'This can take a minute or two on this device.'
export const SLOW_AFTER = 2000

export const WRONG_PASS = 'Wrong passphrase, or the file was changed'
export const WEAK_KDF = "This file's encryption settings are too weak. Export it again."
export const HEAVY_KDF = 'This file needs more memory to unlock than this device allows.'
export const DAMAGED_DUMP = 'The P2P data in this file is damaged'
export const NEWER_DUMP = 'This P2P data is from a newer version. Update and try again'
export const CHANGED = 'P2P data in this browser changed. Unlock the file again.'
export const MOVED_DUMP =
  'This file is from a browser that already moved. Export from the new device.'
export const MOVED_EXPORT =
  'Your P2P identity moved to another device. Export from that device instead.'
export const IMPORTED_HERE =
  'This file was already imported in this browser. Export again from the device you use now.'

export class TransferError extends Error {}

export const percent = (part: number) => `${Math.floor(part * 100)}%`

// The user stopped the key derivation.
export class Cancelled extends TransferError {
  constructor() {
    super('Cancelled')
  }
}

// `work`, with `late(true)` once it has run `after` ms and `late(false)` when it ends.
export const whileSlow = async <T>(
  work: Promise<T>,
  late: (on: boolean) => void,
  after = SLOW_AFTER
): Promise<T> => {
  const timer = setTimeout(() => late(true), after)
  try {
    return await work
  } finally {
    clearTimeout(timer)
    late(false)
  }
}

// `progress` gets the part done (0 to 1) while the key is made in JavaScript; `signal` stops it.
export interface KdfWatch {
  progress?: (part: number) => void
  signal?: AbortSignal
}

const AAD_TAG = 'rchat-p2p-transfer1\0'

export const defaultKdf = (): Kdf =>
  typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
    ? KDF_MOBILE
    : KDF_DESKTOP

// ----- Passphrase -----

export const passLength = (p: string) => Array.from(nfc(p)).length

export const passProblem = (pass: string, again: string): string | null =>
  passLength(pass) < PASS_MIN
    ? `Use at least ${PASS_MIN} characters`
    : nfc(pass) !== nfc(again)
      ? "The passphrases don't match"
      : null

// A rough hint, not a promise: length counts most, then mixing kinds of characters or words.
export const passStrength = (p: string): { score: 0 | 1 | 2 | 3; label: string } => {
  const n = passLength(p)
  const kinds = [/\p{Ll}/u, /\p{Lu}/u, /\p{N}/u, /[^\p{L}\p{N}\s]/u].filter(r => r.test(p)).length
  const words = p.trim().split(/\s+/).filter(Boolean).length
  const distinct = new Set(Array.from(p.toLowerCase())).size
  let score: 0 | 1 | 2 | 3 =
    n < PASS_MIN
      ? 0
      : n >= 20 || (n >= 14 && (kinds >= 3 || words >= 4))
        ? 3
        : n >= 14 || kinds >= 3 || words >= 3
          ? 2
          : 1
  if (score > 1 && distinct < 6) score = 1
  const label = ['Too short', 'Weak: add more words', 'Fair', 'Strong'][score]
  return { score, label }
}

// ----- Encryption -----

const aad = (kdf: Kdf, salt: string) => utf8(`${AAD_TAG}${canonical({ v: 1, kdf, salt })}`)

type Argon = (password: Uint8Array, salt: Uint8Array, kdf: Kdf) => Promise<Uint8Array>

// The passphrase key is argon2id. It is made in WebAssembly, and where the page can't run that
// or the module doesn't load, in JavaScript: the same parameters and the same key, only slower.
// Null: this page makes it in JavaScript.
export const fastKdf = (
  wasm = capabilities().wasm,
  load = () => import('hash-wasm')
): Promise<Argon | null> =>
  wasm
    ? load().then(
        ({ argon2id }) =>
          (password, salt, kdf) =>
            argon2id({
              password,
              salt,
              parallelism: kdf.p,
              iterations: kdf.t,
              memorySize: kdf.m,
              hashLength: 32,
              outputType: 'binary',
            }),
        () => null
      )
    : Promise.resolve(null)

// The worker could not be started; the page does the work itself.
class NoWorker extends Error {}

export type KdfSpawn = () => Worker

const kdfWorker: KdfSpawn = () =>
  new Worker(new URL('./p2p.worker.ts', import.meta.url), { type: 'module' })

const inWorker = (
  spawn: KdfSpawn,
  password: Uint8Array,
  salt: Uint8Array,
  kdf: Kdf,
  { progress, signal }: KdfWatch
) =>
  new Promise<Uint8Array>((done, fail) => {
    if (signal?.aborted) return fail(new Cancelled())
    let w: Worker
    try {
      w = spawn()
    } catch {
      return fail(new NoWorker())
    }
    const end = () => {
      w.terminate()
      signal?.removeEventListener('abort', stop)
    }
    const stop = () => {
      end()
      fail(new Cancelled())
    }
    signal?.addEventListener('abort', stop)
    w.onmessage = (e: MessageEvent<KdfReply>) => {
      const m = e.data
      if ('part' in m) return progress?.(m.part)
      end()
      if ('key' in m) done(m.key)
      else fail(new Error(m.err))
    }
    w.onerror = () => {
      end()
      fail(new NoWorker())
    }
    const job: KdfJob = {
      id: 1,
      kdf: { password, salt, m: kdf.m, t: kdf.t, p: kdf.p, maxmem: KDF_MAX.m * 1024 },
    }
    w.postMessage(job)
  })

// Gives the page a turn every few milliseconds.
const onPage = (
  password: Uint8Array,
  salt: Uint8Array,
  kdf: Kdf,
  { progress, signal }: KdfWatch
) => {
  const report = eachPercent(part => progress?.(part))
  return argon2idAsync(password, salt, {
    m: kdf.m,
    t: kdf.t,
    p: kdf.p,
    dkLen: 32,
    maxmem: KDF_MAX.m * 1024,
    asyncTick: 8,
    onProgress: part => {
      if (signal?.aborted) throw new Cancelled()
      report(part)
    },
  })
}

// The key in JavaScript: in a worker, so the page stays usable and the work can be stopped at
// once; on the page itself where there is no worker.
export const slowKdf = (
  password: Uint8Array,
  salt: Uint8Array,
  kdf: Kdf,
  watch: KdfWatch = {},
  spawn: KdfSpawn | null = typeof window === 'undefined' || typeof Worker === 'undefined'
    ? null
    : kdfWorker
) =>
  spawn
    ? inWorker(spawn, password, salt, kdf, watch).catch((e: unknown) => {
        if (e instanceof NoWorker) return onPage(password, salt, kdf, watch)
        throw e
      })
    : onPage(password, salt, kdf, watch)

const deriveRaw = async (pass: string, salt: Uint8Array, kdf: Kdf, watch?: KdfWatch) => {
  const password = utf8(nfc(pass))
  const fast = await fastKdf()
  if (watch?.signal?.aborted) throw new Cancelled()
  return fast ? fast(password, salt, kdf) : slowKdf(password, salt, kdf, watch)
}

const aesKey = (raw: Uint8Array) =>
  crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt'])

// The key for the files that follow a dump: from the same passphrase key, with its own salt.
const filesKeyOf = (raw: Uint8Array, salt: Uint8Array) => {
  const k = hkdf(sha256, raw, salt, utf8(FILES_INFO), 32)
  const key = aesKey(k)
  k.fill(0)
  return key
}

// Seals the dump; with `filesSalt`, also gives the key for the files that follow it.
const sealWith = async (
  plain: Uint8Array,
  pass: string,
  kdf: Kdf,
  filesSalt?: Uint8Array,
  watch?: KdfWatch
) => {
  const salt = b64u(randomBytes(SALT_BYTES))
  const iv = randomBytes(IV_BYTES)
  const raw = await deriveRaw(pass, fromB64u(salt), kdf, watch)
  const key = await aesKey(raw)
  const files = filesSalt ? await filesKeyOf(raw, filesSalt) : null
  raw.fill(0)
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad(kdf, salt) as BufferSource },
    key,
    plain as BufferSource
  )
  const section: P2pSection = {
    v: 1,
    kdf: { ...kdf },
    salt,
    iv: b64u(iv),
    ct: b64u(new Uint8Array(ct)),
  }
  return { section, files }
}

export const seal = async (
  plain: Uint8Array,
  pass: string,
  kdf: Kdf,
  watch?: KdfWatch
): Promise<P2pSection> => (await sealWith(plain, pass, kdf, undefined, watch)).section

export interface KdfBounds {
  min: { m: number; t: number; p: number }
  max: { m: number; t: number; p: number }
}

export const checkKdf = (kdf: Kdf, bounds: KdfBounds = { min: KDF_MIN, max: KDF_MAX }) => {
  const { min, max } = bounds
  if (kdf.m < min.m || kdf.t < min.t || kdf.p < min.p) throw new TransferError(WEAK_KDF)
  if (kdf.m > max.m || kdf.t > max.t || kdf.p > max.p) throw new TransferError(HEAVY_KDF)
}

export const open = async (sec: P2pSection, pass: string, bounds?: KdfBounds, watch?: KdfWatch) =>
  (await openWith(sec, pass, bounds, undefined, watch)).plain

const openWith = async (
  sec: P2pSection,
  pass: string,
  bounds?: KdfBounds,
  filesSalt?: Uint8Array,
  watch?: KdfWatch
) => {
  checkKdf(sec.kdf, bounds)
  let iv: Uint8Array
  let ct: Uint8Array
  try {
    iv = fromB64u(sec.iv)
    ct = fromB64u(sec.ct)
  } catch {
    throw new TransferError(DAMAGED_DUMP)
  }
  let key: CryptoKey
  let files: CryptoKey | null = null
  try {
    const raw = await deriveRaw(pass, fromB64u(sec.salt), sec.kdf, watch)
    key = await aesKey(raw)
    if (filesSalt) files = await filesKeyOf(raw, filesSalt)
    raw.fill(0)
  } catch (e) {
    // Mostly Argon2 failing to get its memory on a small device.
    throw e instanceof TransferError ? e : new TransferError(HEAVY_KDF)
  }
  try {
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: iv as BufferSource,
          additionalData: aad(sec.kdf, sec.salt) as BufferSource,
        },
        key,
        ct as BufferSource
      )
    )
    return { plain, files }
  } catch {
    throw new TransferError(WRONG_PASS)
  }
}

// ----- Dump -----

export interface Row {
  value: unknown
  // Only for stores without a key path.
  key?: IDBValidKey
}

export interface Dump {
  // Random per export: an import records it, so the same file never makes a second device.
  id: string
  schema: number
  at: number
  self: SelfRecord
  stores: Map<string, Row[]>
  // Records dropped because they were malformed.
  skipped: number
}

// Bytes and blobs become tagged objects (keys `$b`, `$blob`). Any other key that starts with `$`
// gets one more, so stored data can never pass for a tag.
const tags = new WeakSet<object>()

const escaped = (v: Record<string, unknown>) => {
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) out[k.startsWith('$') ? `$${k}` : k] = x
  return out
}

const pack = (_k: string, v: unknown) =>
  v instanceof Uint8Array
    ? { $b: b64u(v) }
    : v instanceof ArrayBuffer
      ? { $b: b64u(new Uint8Array(v)) }
      : isRecord(v) && !tags.has(v) && Object.keys(v).some(k => k.startsWith('$'))
        ? escaped(v)
        : v

const hasBlob = (v: unknown): boolean =>
  typeof Blob !== 'undefined' &&
  (v instanceof Blob ||
    (Array.isArray(v)
      ? v.some(hasBlob)
      : isRecord(v) && !(v instanceof Uint8Array) && Object.values(v).some(hasBlob)))

const unblob = async (v: unknown): Promise<unknown> => {
  if (!hasBlob(v)) return v
  if (v instanceof Blob) {
    const tag = { $blob: b64u(new Uint8Array(await v.arrayBuffer())), type: v.type }
    tags.add(tag)
    return tag
  }
  if (Array.isArray(v)) return Promise.all(v.map(unblob))
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = await unblob(x)
  return out
}

const revive = (_k: string, v: unknown) => {
  if (!isRecord(v)) return v
  const keys = Object.keys(v)
  if (keys.length === 1 && typeof v.$b === 'string') return fromB64u(v.$b)
  if (keys.length === 2 && typeof v.$blob === 'string' && typeof v.type === 'string')
    return new Blob([fromB64u(v.$blob) as BlobPart], { type: v.type })
  if (!keys.some(k => k.startsWith('$'))) return v
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) out[k.startsWith('$$') ? k.slice(1) : k] = x
  return out
}

interface LooseStore {
  keyPath: string | string[] | null
  getAll: () => Promise<unknown[]>
  getAllKeys: () => Promise<IDBValidKey[]>
  get: (key: IDBValidKey) => Promise<unknown>
  put: (value: unknown, key?: IDBValidKey) => Promise<IDBValidKey>
  clear: () => Promise<void>
}

interface LooseTx {
  objectStore: (name: string) => LooseStore
  done: Promise<void>
  abort: () => void
}

const storeNames = (db: P2pDatabase) => Array.from(db.objectStoreNames) as string[]

// Every store except the excluded ones, read in one transaction (a consistent snapshot).
export const readStores = async (db: P2pDatabase, skip: ReadonlySet<string> = new Set()) => {
  const names = storeNames(db).filter(n => !EXCLUDED.has(n) && !skip.has(n))
  const tx = db.transaction(names as StoreName[], 'readonly') as unknown as LooseTx
  const out = new Map<string, Row[]>()
  for (const n of names) {
    const st = tx.objectStore(n)
    const values = await st.getAll()
    const keys = st.keyPath === null ? await st.getAllKeys() : null
    out.set(
      n,
      values.map((value, i) => (keys ? { value, key: keys[i] } : { value }))
    )
  }
  await tx.done
  return out
}

const HEADER = 'p2p-dump'

export const dumpBytes = async (
  db: P2pDatabase,
  now = Date.now(),
  opts: { id?: string } = {}
): Promise<Uint8Array> => {
  const stores = await readStores(db)
  const self = stores.get('self')?.[0]?.value as SelfRecord | undefined
  if (!self) throw new TransferError('No P2P identity here')
  if (self.moved || !hasSecrets(self)) throw new TransferError(MOVED_EXPORT)
  const id = opts.id ?? b64u(randomBytes(16))
  const cs = new CompressionStream('deflate-raw')
  const result = new Response(cs.readable).arrayBuffer()
  const w = cs.writable.getWriter()
  const enc = new TextEncoder()
  let buf = `${JSON.stringify({ rchat: HEADER, v: 1, id, schema: DB_VERSION, at: now })}\n`
  for (const [name, rows] of stores)
    for (const r of rows) {
      const value = await unblob(r.value)
      const line = r.key === undefined ? [name, value] : [name, value, r.key]
      buf += `${JSON.stringify(line, pack)}\n`
      if (buf.length >= 1 << 16) {
        await w.write(enc.encode(buf))
        buf = ''
      }
    }
  if (buf) await w.write(enc.encode(buf))
  await w.close()
  return new Uint8Array(await result)
}

const isKeyPair = (x: unknown): x is KeyPair =>
  isRecord(x) &&
  x.pk instanceof Uint8Array &&
  x.sk instanceof Uint8Array &&
  x.pk.length === 32 &&
  x.sk.length === 32 &&
  equalBytes(publicOf(x.sk), x.pk)

export const isSelf = (x: unknown): x is SelfRecord => {
  if (!isRecord(x) || x.id !== 'me' || !isKeyPair(x.ik) || !isKeyPair(x.dk)) return false
  const ik = keyId(x.ik.pk)
  return (
    verifyCert(x.cert, ik) &&
    x.cert.dk === keyId(x.dk.pk) &&
    Array.isArray(x.certs) &&
    Array.isArray(x.revocations) &&
    verifyProfile(x.profile, ik) &&
    Number.isSafeInteger(x.created)
  )
}

// A DM row holds a v1 event of its room; a server row a v2 event of its server (its genesis is
// the server).
const isEventRow = (x: unknown): x is EventRecord => {
  if (
    !isRecord(x) ||
    typeof x.id !== 'string' ||
    typeof x.room !== 'string' ||
    !Number.isSafeInteger(x.receivedAt) ||
    !Number.isSafeInteger(x.depth) ||
    !isRecord(x.wire) ||
    !isRecord(x.wire.ev)
  )
    return false
  const ev = x.wire.ev
  if (ev.v === 2)
    return (
      (ev.srv === x.room || (ev.t === 'genesis' && x.id === x.room)) && claimedId2(x.wire) === x.id
    )
  return ev.room === x.room && ev.depth === x.depth && claimedId(x.wire) === x.id
}

const HEADS_MAX = TR.headsMax

const isHead = (h: unknown) =>
  isRecord(h) && isEventId(h.id) && Number.isSafeInteger(h.depth) && (h.depth as number) >= 0

const isRoomRow = (x: unknown): x is RoomRecord =>
  isRecord(x) &&
  typeof x.id === 'string' &&
  ((x.kind === 'dm' && isKeyId(x.peer)) || (x.kind === 'server' && x.peer === '')) &&
  Array.isArray(x.heads) &&
  x.heads.length <= HEADS_MAX &&
  x.heads.every(isHead) &&
  Array.isArray(x.missing)

const isContactRow = (x: unknown): x is Contact =>
  isRecord(x) &&
  isKeyId(x.ik) &&
  typeof x.name === 'string' &&
  Array.isArray(x.certs) &&
  Array.isArray(x.revocations) &&
  Array.isArray(x.intros) &&
  ['outgoing', 'incoming', 'mutual', 'blocked'].includes(x.state as string)

// A contact keeps only the devices and profile its identity signed.
const cleanContact = (c: Contact): Contact => {
  const revocations = mergeRevocations([], c.revocations.slice(0, CERTS_KEPT * 2), c.ik)
  return {
    ...c,
    revocations,
    certs: mergeCerts([], c.certs.slice(0, CERTS_KEPT), c.ik, revocations),
    profile: c.profile && verifyProfile(c.profile, c.ik) ? c.profile : null,
  }
}

const isHash = (x: unknown) => typeof x === 'string' && isEventId(x)

const isOutboxRow = (x: unknown): x is OutboxRecord =>
  isRecord(x) && typeof x.id === 'string' && Array.isArray(x.deliveredTo)

const ROW_CHECKS: Record<string, (x: unknown) => boolean> = {
  events: isEventRow,
  rooms: isRoomRow,
  contacts: isContactRow,
  outbox: isOutboxRow,
}

// What a stored event says about its files is derived from its content, never taken from a file.
const cleanEvent = (e: EventRecord): EventRecord => {
  const v2 = (e.wire.ev as { v?: unknown }).v === 2
  const atts = e.redacted || e.type !== 'msg' ? [] : attsOf(e.wire.c)
  const out = withFiles(e, atts)
  const marks = serverMarks(e)
  for (const k of ['chan', 'layer', 'dev', 'dseq', 'aseq', 'acl', 'imp'] as const) delete out[k]
  if (v2) Object.assign(out, marks)
  return out
}

type Marks = Pick<EventRecord, 'chan' | 'layer' | 'dev' | 'dseq' | 'aseq' | 'acl'>

// What a server event is indexed by (its layer, channel, device and seq), from the event itself,
// and the admission record the exporting device stored (the importing evaluator reads it if its
// version and shape check out and a sample of them matches their evaluation, acl_room.ts).
const serverMarks = (e: EventRecord): Marks => {
  const w = serverWire(e)
  const out: Marks = {}
  if ((w.ev as { v?: unknown }).v !== 2) return out
  out.layer = w.ev.L === 'c' ? 'c' : 'a'
  out.dev = w.ev.dev
  out.dseq = w.ev.seq
  const ch = (w.c as { ch?: unknown } | null)?.ch
  if (out.layer === 'c' && typeof ch === 'string') out.chan = ch
  if (out.layer === 'a' && Number.isSafeInteger(e.aseq) && isRecord(e.acl)) {
    out.aseq = e.aseq
    out.acl = e.acl
  }
  return out
}

// A server event merged into this device's copy of the server: stored as it came, without the
// other device's admission order and record; on start it is checked and decided like one from a
// peer (server.ts load).
const putServerRow = async (tx: LooseTx, e: EventRecord) => {
  const { aseq: _a, acl: _r, ...row } = { ...e, imp: true as const }
  const rooms = tx.objectStore('rooms')
  const r = (await rooms.get(e.room)) as RoomRecord | undefined
  if (!r) return
  const size = storedSize(e.wire)
  const seq = r.lastSeq + 1
  await tx.objectStore('events').put({ ...row, seq })
  const meta = tx.objectStore('meta') as unknown as Parameters<typeof moveCounts>[0]
  await rooms.put(await moveCounts(meta, { ...r, lastSeq: seq }, { ...countOf(e), bytes: size }))
}

// Reads the inflated lines one at a time, so memory goes to the records, never to one huge
// string.
export const parseDump = async (bytes: Uint8Array, max = DUMP_MAX): Promise<Dump> => {
  const damaged = () => new TransferError(DAMAGED_DUMP)
  const reader = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))
    .getReader()
  const dec = new TextDecoder('utf-8', { fatal: true })
  const stores = new Map<string, Row[]>()
  let header: { id: string; schema: number; at: number } | null = null
  let size = 0
  // Text of the line so far, in pieces: each new piece is searched once, so a long line costs
  // what it weighs, not its length times the number of pieces.
  let parts: string[] = []
  const line = (text: string) => {
    const x = JSON.parse(text, revive) as unknown
    if (!header) {
      if (!isRecord(x) || x.rchat !== HEADER) throw damaged()
      if (typeof x.v === 'number' && x.v > 1) throw new TransferError(NEWER_DUMP)
      if (Number.isSafeInteger(x.schema) && (x.schema as number) > DB_VERSION)
        throw new TransferError(NEWER_DUMP)
      if (
        x.v !== 1 ||
        typeof x.id !== 'string' ||
        x.id.length < 16 ||
        x.id.length > 64 ||
        !Number.isSafeInteger(x.schema) ||
        !Number.isSafeInteger(x.at)
      )
        throw damaged()
      header = { id: x.id, schema: x.schema as number, at: x.at as number }
      return
    }
    if (!Array.isArray(x) || (x.length !== 2 && x.length !== 3) || typeof x[0] !== 'string')
      throw damaged()
    const rows = stores.get(x[0]) ?? []
    rows.push(x.length === 3 ? { value: x[1], key: x[2] as IDBValidKey } : { value: x[1] })
    stores.set(x[0], rows)
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > max) {
        void reader.cancel().catch(() => {})
        throw damaged()
      }
      const text = dec.decode(value, { stream: true })
      let at = 0
      for (let nl = text.indexOf('\n'); nl >= 0; nl = text.indexOf('\n', at)) {
        parts.push(text.slice(at, nl))
        line(parts.join(''))
        parts = []
        at = nl + 1
      }
      if (at < text.length) parts.push(text.slice(at))
    }
    const tail = dec.decode()
    if (tail) parts.push(tail)
  } catch (e) {
    throw e instanceof TransferError ? e : damaged()
  }
  if (parts.join('') !== '' || !header) throw damaged()
  const selfRows = stores.get('self') ?? []
  const self = selfRows[0]?.value
  if (selfRows.length === 1 && isRecord(self) && self.moved) throw new TransferError(MOVED_DUMP)
  if (selfRows.length !== 1 || !isSelf(self)) throw damaged()
  let skipped = 0
  for (const [name, rows] of stores) {
    const ok = ROW_CHECKS[name]
    if (!ok) continue
    const kept = rows.filter(r => ok(r.value))
    skipped += rows.length - kept.length
    stores.set(
      name,
      name === 'contacts'
        ? kept.map(r => ({ ...r, value: cleanContact(r.value as Contact) }))
        : name === 'events'
          ? kept.map(r => ({ ...r, value: cleanEvent(r.value as EventRecord) }))
          : kept
    )
  }
  const { id, schema, at } = header as { id: string; schema: number; at: number }
  return { id, schema, at, self, stores, skipped }
}

export const rowsOf = (dump: Dump, store: string) => dump.stores.get(store) ?? []

export interface Summary {
  ik: string
  fingerprint: string
  name: string
  contacts: number
  rooms: number
  messages: number
}

export const summarize = (dump: Dump): Summary => {
  const ik = keyId(dump.self.ik.pk)
  const contacts = rowsOf(dump, 'contacts').map(r => r.value as Contact)
  return {
    ik,
    fingerprint: fingerprint(ik),
    name: dump.self.profile.name,
    contacts: visibleContacts(contacts).length,
    rooms: rowsOf(dump, 'rooms').length,
    messages: rowsOf(dump, 'events').filter(r => {
      const e = r.value as EventRecord
      return e.type === 'msg' && !e.redacted
    }).length,
  }
}

export const summaryText = (s: Summary) => {
  const n = (x: number, one: string, many = `${one}s`) =>
    `${x.toLocaleString('en-US')} ${x === 1 ? one : many}`
  return `Identity ${s.fingerprint}, ${n(s.contacts, 'contact')}, ${n(s.rooms, 'room')}, ${n(
    s.messages,
    'message'
  )}`
}

// ----- Export -----

export const exportP2p = async (
  db: P2pDatabase,
  pass: string,
  kdf: Kdf = defaultKdf(),
  now = Date.now(),
  watch?: KdfWatch
) => seal(await dumpBytes(db, now), pass, kdf, watch)

// The same, plus the key for writing the files after it into the `.rchat` file.
export const exportP2pWithFiles = async (
  db: P2pDatabase,
  pass: string,
  kdf: Kdf = defaultKdf(),
  now = Date.now(),
  watch?: KdfWatch
): Promise<{ section: P2pSection; files: FilesKey }> => {
  const id = b64u(randomBytes(16))
  const salt = randomBytes(SALT_BYTES)
  const { section, files } = await sealWith(
    await dumpBytes(db, now, { id }),
    pass,
    kdf,
    salt,
    watch
  )
  return { section, files: { id, salt: b64u(salt), key: files as CryptoKey } }
}

export const unlockP2p = async (
  sec: P2pSection,
  pass: string,
  bounds?: KdfBounds,
  watch?: KdfWatch
) => parseDump(await open(sec, pass, bounds, watch))

// The same, with the key for the files that follow it (from their header's salt).
export const unlockP2pWithFiles = async (
  sec: P2pSection,
  pass: string,
  head: FilesHead,
  bounds?: KdfBounds,
  watch?: KdfWatch
): Promise<{ dump: Dump; files: FilesKey }> => {
  const salt = bytesOf(head.salt, SALT_BYTES)
  if (!salt) throw new TransferError(DAMAGED_DUMP)
  const { plain, files } = await openWith(sec, pass, bounds, salt, watch)
  const dump = await parseDump(plain)
  if (dump.id !== head.id) throw new TransferError(DAMAGED_DUMP)
  return { dump, files: { id: head.id, salt: head.salt, key: files as CryptoKey } }
}

// ----- Import -----

// No identity here yet; this identity (merge); or another one (replace, after a warning).
export type ImportKind = 'new' | 'merge' | 'replace'

export const importKind = (local: SelfRecord | undefined, dump: Dump): ImportKind =>
  !local ? 'new' : equalBytes(local.ik.pk, dump.self.ik.pk) ? 'merge' : 'replace'

// This identity already took this file in: importing it again changes nothing.
export const alreadyImported = (local: SelfRecord | undefined, dump: Dump) =>
  !!local && importKind(local, dump) === 'merge' && (local.imports ?? []).includes(dump.id)

const IMPORTS_KEPT = TR.importsKept

const withImport = (list: string[] | undefined, id: string) =>
  [...new Set([...(list ?? []).filter(x => x !== id), id])].slice(-IMPORTS_KEPT)

export interface Imported {
  kind: ImportKind
  contacts: number
  rooms: number
  events: number
  skipped: number
  // Files read from the `.rchat` file after the data.
  files?: FilesResult
}

// A new device key for the identity: the identity signs its cert and the revocation of the
// device the dump came from. The revocation time is now, or a little later if the old device
// signed events with a clock ahead of ours, so none of them falls after it.
export const moveSelf = (
  old: SelfRecord,
  at: number,
  label = 'Browser',
  importId?: string
): SelfRecord => {
  const ik = keyId(old.ik.pk)
  const dk = newKeyPair()
  const cert = signCert(old.ik, dk.pk, at, label)
  const rev = signRevocation(old.ik, keyId(old.dk.pk), at, keyId(dk.pk))
  const revocations = mergeRevocations(old.revocations, [rev], ik)
  const certs = mergeCerts([cert], old.certs, ik, revocations)
  return {
    ...old,
    dk,
    cert,
    certs,
    revocations,
    suffix: 0,
    moved: null,
    moving: null,
    exported: null,
    alert: null,
    imports: importId ? withImport(old.imports, importId) : (old.imports ?? []),
  }
}

// A failed request aborts the transaction, and the import fails as a whole when it ends.
const fire = (p: Promise<unknown>) => void p.catch(() => {})

const asTx = (tx: LooseTx) => tx as unknown as InsertTx

// One `move` event per ten heads (events reference at most ten), signed by the new device.
const vouch = async (tx: LooseTx, self: SelfRecord, room: RoomRecord, now: number) => {
  const author = { ik: self.ik, dk: self.dk }
  const me = keyId(self.ik.pk)
  const heads = room.heads
  let n = 0
  for (let i = 0; i < heads.length; i += EV.prev) {
    const part = heads.slice(i, i + EV.prev)
    const depth = Math.max(...part.map(h => h.depth)) + 1
    const { id, wire } = buildEvent(
      author,
      room.id,
      'move',
      {},
      part.map(h => h.id),
      depth,
      now
    )
    const res = await insertInto(asTx(tx), id, wire, now, { me, peer: room.peer, own: true })
    if (res.status !== 'new') continue
    await tx.objectStore('outbox').put({ id, room: room.id, created: now, deliveredTo: [] })
    n += 1
  }
  return n
}

const load = async (
  tx: LooseTx,
  names: string[],
  dump: Dump,
  now: number,
  label: string
): Promise<Imported> => {
  for (const n of names) fire(tx.objectStore(n).clear())
  const meta = tx.objectStore('meta')
  fire(meta.put(DB_VERSION, 'schema'))
  const ik = keyId(dump.self.ik.pk)
  const oldDk = keyId(dump.self.dk.pk)
  // Events and bytes per room: DMs and servers are counted apart (purged server events count no
  // event; a server's ACL events are counted apart too).
  const perRoom = new Map<string, { n: number; acl: number; bytes: number }>()
  const count = (k: string, e: EventRecord) => {
    const u = perRoom.get(k) ?? { n: 0, acl: 0, bytes: 0 }
    const c = e.layer ? countOf(e) : { n: e.purged ? 0 : 1, acl: 0 }
    perRoom.set(k, { n: u.n + c.n, acl: u.acl + c.acl, bytes: u.bytes + storedSize(e.wire) })
  }
  let skipped = dump.skipped
  let latest = now
  const rooms: RoomRecord[] = []
  const oldTs = new Map<string, number>()
  let contacts = 0
  for (const [name, rows] of dump.stores) {
    if (!names.includes(name) || EXCLUDED.has(name) || name === 'self' || name === 'outbox')
      continue
    const st = tx.objectStore(name)
    const inline = st.keyPath !== null
    for (const r of rows) {
      let v = r.value
      if (!inline && r.key === undefined) {
        skipped += 1
        continue
      }
      if (name === 'events') {
        const e = v as EventRecord
        // A server event is checked and decided on the next start (server.ts load).
        if (e.layer) v = { ...e, imp: true }
        count(e.room, e)
        const ev = (e.wire as Wire).ev
        if (ev.sender === ik && ev.dev === oldDk) {
          latest = Math.max(latest, ev.ts)
          oldTs.set(e.id, ev.ts)
        }
      }
      // Dropped events' headers are checked on the next start too (server.ts load).
      if (name === 'dropped') v = { ...(v as object), imp: true }
      if (name === 'rooms') rooms.push(v as RoomRecord)
      if (name === 'contacts') contacts += 1
      fire(inline ? st.put(v) : st.put(v, r.key))
    }
  }
  const servers = new Set(rooms.filter(r => r.kind === 'server').map(r => r.id))
  // A server room's bytes counted the exporter's search rows: here they are the events', and the
  // index is built again on start (and counted then).
  for (const r of rooms)
    if (r.kind === 'server') {
      const u = perRoom.get(r.id) ?? { n: 0, acl: 0, bytes: 0 }
      fire(tx.objectStore('rooms').put({ ...r, count: u.n, acount: u.acl, bytes: u.bytes }))
    }
  const dms = { n: 0, acl: 0, bytes: 0 }
  const srv = { n: 0, acl: 0, bytes: 0 }
  for (const [room, u] of perRoom) {
    const t = servers.has(room) ? srv : dms
    t.n += u.n
    t.acl += u.acl
    t.bytes += u.bytes
  }
  fire(meta.put(dms.n, TOTAL))
  fire(meta.put(dms.bytes, TOTAL_BYTES))
  fire(meta.put(srv.n, SERVER_TOTAL))
  fire(meta.put(srv.acl, SERVER_ACL))
  fire(meta.put(srv.bytes, SERVER_TOTAL_BYTES))
  const revokedAt = Math.min(latest, now + EV.futureMs)
  // Events the old device dated after the revocation would be refused: they stay unsent.
  if (names.includes('outbox'))
    for (const r of rowsOf(dump, 'outbox')) {
      const o = r.value as OutboxRecord
      const late = (oldTs.get(o.id) ?? 0) > revokedAt
      fire(tx.objectStore('outbox').put(late ? { ...o, failed: true } : o))
    }
  const self = moveSelf(dump.self, revokedAt, label, dump.id)
  await tx.objectStore('self').put(self)
  // Servers vouch differently: the new device posts its member event again on start.
  for (const room of rooms) if (room.kind !== 'server') await vouch(tx, self, room, now)
  return { kind: 'new', contacts, rooms: rooms.length, events: dms.n + srv.n, skipped }
}

const merge = async (
  tx: LooseTx,
  names: string[],
  dump: Dump,
  local: SelfRecord,
  now: number
): Promise<Imported> => {
  const ik = keyId(local.ik.pk)
  const d = dump.self
  const revocations = mergeRevocations(local.revocations, d.revocations, ik)
  const certs = mergeCerts(local.certs, [local.cert, ...d.certs], ik, revocations)
  // The file may come from the device this one moved to: then this one is the old device.
  const gone = revocations.find(r => r.dk === keyId(local.dk.pk) && r.successor)
  const moved =
    local.moved ?? (gone ? { at: gone.revoked_at, successor: gone.successor as string } : null)
  const next: SelfRecord = {
    ...local,
    certs,
    revocations,
    profile: d.profile.updated > local.profile.updated ? d.profile : local.profile,
    moved,
    imports: withImport([...(local.imports ?? []), ...(d.imports ?? [])], dump.id),
  }
  await tx.objectStore('self').put(moved ? withoutSecrets({ ...next, moving: null }) : next)

  let skipped = dump.skipped
  let contacts = 0
  const cs = tx.objectStore('contacts')
  for (const r of rowsOf(dump, 'contacts')) {
    const c = r.value as Contact
    const cur = (await cs.get(c.ik)) as Contact | undefined
    await cs.put(cur ? mergeContact(cur, c, now) : c)
    contacts += 1
  }

  const roomStore = tx.objectStore('rooms')
  const before = new Map<string, RoomRecord | undefined>()
  const theirs = new Map<string, RoomRecord>()
  for (const r of rowsOf(dump, 'rooms')) {
    const room = r.value as RoomRecord
    const cur = (await roomStore.get(room.id)) as RoomRecord | undefined
    if (cur && cur.peer !== room.peer) {
      skipped += 1
      continue
    }
    before.set(room.id, cur)
    theirs.set(room.id, room)
    // A server room comes as it is: its events are admitted again when P2P starts.
    if (!cur)
      await roomStore.put(
        room.kind === 'server'
          ? {
              ...blankRoom(room.id, '', room.created),
              kind: 'server',
              name: room.name,
              server: null,
            }
          : blankRoom(room.id, room.peer, room.created)
      )
  }

  const evStore = tx.objectStore('events')
  const list = rowsOf(dump, 'events')
    .map(r => r.value)
    .filter((v): v is EventRecord => {
      const ok = theirs.has((v as EventRecord).room)
      if (!ok) skipped += 1
      return ok
    })
    .sort((a, b) => a.depth - b.depth)
  let events = 0
  for (const e of list) {
    if (await evStore.get(e.id)) continue
    const room = theirs.get(e.room) as RoomRecord
    if (room.kind === 'server') {
      await putServerRow(tx, e)
      events += 1
      continue
    }
    const res = await insertInto(asTx(tx), e.id, e.wire, e.receivedAt, {
      me: ik,
      peer: room.peer,
    })
    if (res.status === 'new') events += 1
    else if (res.status !== 'dup') skipped += 1
  }

  const box = tx.objectStore('outbox')
  for (const r of rowsOf(dump, 'outbox')) {
    const o = r.value as OutboxRecord
    if (!(await evStore.get(o.id))) continue
    const cur = (await box.get(o.id)) as OutboxRecord | undefined
    await box.put(
      cur
        ? {
            ...cur,
            deliveredTo: [...new Set([...cur.deliveredTo, ...o.deliveredTo])],
            failed: !!cur.failed && !!o.failed,
          }
        : o
    )
  }

  // Imported events count as read where either copy had read them.
  for (const [id, prev] of before) {
    const cur = (await roomStore.get(id)) as RoomRecord
    const other = theirs.get(id) as RoomRecord
    const unread = Math.min(cur.unread, (prev?.unread ?? 0) + other.unread)
    const pings = Math.min(cur.pings, (prev?.pings ?? 0) + other.pings)
    await roomStore.put({
      ...cur,
      unread,
      pings,
      readSeq: Math.max(cur.readSeq, cur.lastSeq - unread),
    })
  }

  const handled = new Set(['self', 'contacts', 'rooms', 'events', 'children', 'outbox'])
  for (const [name, rows] of dump.stores) {
    if (!names.includes(name) || EXCLUDED.has(name) || handled.has(name)) continue
    const st = tx.objectStore(name)
    const inline = st.keyPath !== null
    for (const r of rows) {
      if (!inline && r.key === undefined) continue
      const key = inline ? keyOf(r.value, st.keyPath as string | string[]) : r.key
      if (key === undefined) continue
      const v = name === 'dropped' ? { ...(r.value as object), imp: true } : r.value
      if ((await st.get(key)) === undefined) await (inline ? st.put(v) : st.put(v, r.key))
    }
  }
  return { kind: 'merge', contacts, rooms: theirs.size, events, skipped }
}

const keyOf = (v: unknown, path: string | string[]): IDBValidKey | undefined => {
  if (!isRecord(v)) return undefined
  if (Array.isArray(path)) {
    const parts = path.map(p => v[p])
    return parts.every(p => p !== undefined) ? (parts as IDBValidKey[]) : undefined
  }
  return v[path] as IDBValidKey | undefined
}

// Writes the dump in one transaction; any error aborts it, so the database is as before.
export const applyImport = async (
  db: P2pDatabase,
  dump: Dump,
  kind: ImportKind,
  opts: { now?: number; label?: string } = {}
): Promise<Imported> => {
  const now = opts.now ?? Date.now()
  const names = storeNames(db)
  const tx = db.transaction(names as StoreName[], 'readwrite') as unknown as LooseTx
  tx.done.catch(() => {})
  try {
    const local = (await tx.objectStore('self').get('me')) as SelfRecord | undefined
    if (importKind(local, dump) !== kind) throw new TransferError(CHANGED)
    if (alreadyImported(local, dump)) {
      await tx.done
      return { kind: 'merge', contacts: 0, rooms: 0, events: 0, skipped: 0 }
    }
    const res =
      kind === 'merge'
        ? await merge(tx, names, dump, local as SelfRecord, now)
        : {
            ...(await load(tx, names, dump, now, opts.label ?? 'Browser')),
            kind,
          }
    // The search index is built again from the events now stored (server.ts start).
    await tx.objectStore('meta').put(SEARCH_STALE, SEARCH_META)
    await tx.done
    return res
  } catch (e) {
    try {
      tx.abort()
    } catch {
      // Already finished.
    }
    throw e
  }
}

// ----- Files in the `.rchat` file -----
//
// With "Include downloaded attachments", the `.rchat` file is the config text line, then
// FILES_MAGIC, a header line `{v, id, salt}` (`id` is the dump's, so files can't be moved to
// another export), then frames: u32 (big endian; top bit set on the last frame) length, then
// AES-256-GCM ciphertext under a key from the passphrase key (HKDF, the header's salt), with the
// frame counter as nonce and `FILES_AAD || id || u64 counter || last` as associated data, so
// frames can't be reordered, dropped or spliced, and a cut is noticed. Plaintext: one kind byte,
// then a file's header (JSON), one 1 MiB block of it, a drop of the current file, or the end.
// Both sides go one block at a time, so a file of any size fits; the string and QR forms never
// carry files.

export const FILES_MAGIC = 'RCHATFILES1\n'
const FILES_INFO = 'rchat-p2p files1'
const FILES_AAD = 'rchat-p2p-files1\0'
const FRAME_LAST = 0x8000_0000
// One block, its kind byte and the tag.
export const FILES_FRAME_MAX = BLOCK + 1 + 16
const HEAD_MAX = TR.headMax

export const F_FILE = 1
export const F_BLOCK = 2
export const F_END = 3
const F_DROP = 4

export interface FilesKey {
  id: string
  salt: string
  key: CryptoKey
}

export interface FilesHead {
  id: string
  salt: string
}

export interface FilesResult {
  files: number
  skipped: number
  // The end frame arrived: nothing was cut off.
  complete: boolean
}

const u64 = (n: number) => {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(n))
  return out
}

const frameIv = (n: number) => {
  const iv = new Uint8Array(12)
  iv.set(u64(n), 4)
  return iv
}

const frameAad = (id: string, n: number, last: boolean) =>
  concat(utf8(`${FILES_AAD}${id}\0`), u64(n), new Uint8Array([last ? 1 : 0]))

// One frame of the files part: its length word (with the last flag), then the sealed kind byte
// and body.
export const sealFilesFrame = async (
  fk: FilesKey,
  n: number,
  kind: number,
  body: Uint8Array,
  last = false
) => {
  const pt = new Uint8Array(1 + body.length)
  pt[0] = kind
  pt.set(body, 1)
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: frameIv(n) as BufferSource,
        additionalData: frameAad(fk.id, n, last) as BufferSource,
      },
      fk.key,
      pt as BufferSource
    )
  )
  const head = new Uint8Array(4)
  new DataView(head.buffer).setUint32(0, (ct.length | (last ? FRAME_LAST : 0)) >>> 0)
  return concat(head, ct)
}

// Writes every complete file after the config text, one block in memory at a time. `write`
// gets the pieces in order (the caller streams them to disk or into a Blob).
export const writeFiles = async (
  db: P2pDatabase,
  fk: FilesKey,
  write: (part: Uint8Array) => Promise<void>,
  progress?: (done: number, total: number) => void
) => {
  const total = await filesSize(db)
  let done = 0
  let n = 0
  const frame = async (kind: number, body: Uint8Array, last = false) =>
    write(await sealFilesFrame(fk, n++, kind, body, last))
  await write(utf8(`${FILES_MAGIC}${JSON.stringify({ v: 1, id: fk.id, salt: fk.salt })}\n`))
  const keys = await db.getAllKeys('blobs')
  for (const h of keys) {
    const rec = await db.get('blobs', h)
    if (!rec?.done) continue
    const meta = {
      h: rec.h,
      size: rec.size,
      own: rec.own,
      created: rec.created,
      lastUsed: rec.lastUsed,
    }
    await frame(F_FILE, utf8(JSON.stringify(meta)))
    const count = blockCount(rec.size)
    let ok = true
    for (let i = 0; i < count; i += 1) {
      const data = await readBlock(db, rec, i).catch(() => null)
      if (!data || data.length !== Math.min(BLOCK, rec.size - i * BLOCK)) {
        ok = false
        break
      }
      await frame(F_BLOCK, data)
      done += data.length
      progress?.(done, total)
    }
    if (!ok) await frame(F_DROP, new Uint8Array(0))
  }
  await frame(F_END, new Uint8Array(0), true)
}

// Reads exactly `n` bytes at a time from a stream, copying each byte once.
class ByteReader {
  private chunks: Uint8Array[] = []
  private have = 0
  private ended = false

  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async read(n: number): Promise<Uint8Array | null> {
    while (this.have < n && !this.ended) {
      const { done, value } = await this.reader.read()
      if (done) this.ended = true
      else if (value.length) {
        this.chunks.push(value)
        this.have += value.length
      }
    }
    if (this.have < n) return null
    const out = new Uint8Array(n)
    let at = 0
    while (at < n) {
      const c = this.chunks[0]
      const take = Math.min(c.length, n - at)
      out.set(c.subarray(0, take), at)
      at += take
      if (take === c.length) this.chunks.shift()
      else this.chunks[0] = c.subarray(take)
    }
    this.have -= n
    return out
  }

  cancel() {
    void this.reader.cancel().catch(() => {})
  }
}

// The header of the files part of a `.rchat` file, or null when there is none.
export const filesHead = async (trailer: Blob): Promise<FilesHead | null> => {
  if (trailer.size < FILES_MAGIC.length) return null
  const head = new Uint8Array(await trailer.slice(0, FILES_MAGIC.length + HEAD_MAX).arrayBuffer())
  const text = new TextDecoder().decode(head)
  if (!text.startsWith(FILES_MAGIC)) return null
  const nl = text.indexOf('\n', FILES_MAGIC.length)
  if (nl < 0) return null
  try {
    const x = JSON.parse(text.slice(FILES_MAGIC.length, nl)) as unknown
    if (
      isRecord(x) &&
      x.v === 1 &&
      typeof x.id === 'string' &&
      x.id.length >= 16 &&
      x.id.length <= 64 &&
      bytesOf(x.salt, SALT_BYTES)
    )
      return { id: x.id, salt: x.salt as string }
  } catch {
    // Not a header.
  }
  return null
}

interface Incoming {
  h: string
  size: number
  own: boolean
  created: number
  lastUsed: number
  count: number
  next: number
  hashes: Uint8Array
  type: string
  // Already complete here: the bytes are read and checked, not stored again.
  had: boolean
}

// Largest file an import takes (its hash list is held while it streams in).
const FILE_SIZE_MAX = TR.fileSizeMax

const isFileMeta = (x: unknown) =>
  isRecord(x) &&
  isHash(x.h) &&
  Number.isSafeInteger(x.size) &&
  (x.size as number) >= 0 &&
  (x.size as number) <= FILE_SIZE_MAX &&
  typeof x.own === 'boolean' &&
  Number.isSafeInteger(x.created) &&
  Number.isSafeInteger(x.lastUsed)

// Reads the files part of a `.rchat` file into the database, one block at a time. Every block is
// checked against the hashes it adds up to and the file's root, and its type is sniffed here; a
// file that doesn't check out, or is cut off, is dropped (blocks and all). What came before a
// damaged or missing part stays.
export const importFiles = async (
  db: P2pDatabase,
  trailer: Blob,
  fk: FilesKey,
  progress?: (done: number) => void
): Promise<FilesResult> => {
  const r = new ByteReader(trailer.stream().getReader())
  const out: FilesResult = { files: 0, skipped: 0, complete: false }
  let cur: Incoming | null = null
  let n = 0
  let done = 0
  const drop = async (x: Incoming) => {
    if (!x.had) await db.delete('blob_parts', partRange(x.h)).catch(() => {})
    out.skipped += 1
  }
  const finish = async (x: Incoming) => {
    if (x.had) return
    if (blobRootOf(x.size, x.hashes) !== x.h) return drop(x)
    const tx = db.transaction(['blobs', 'blob_hashes'], 'readwrite')
    const now = await tx.objectStore('blobs').get(x.h)
    if (!now?.done) {
      await tx.objectStore('blob_hashes').delete(partRange(x.h))
      for (const p of hashPages(x.h, x.hashes)) await tx.objectStore('blob_hashes').put(p)
      const rec: BlobRecord = {
        h: x.h,
        size: x.size,
        hashed: true,
        have: x.count,
        done: true,
        type: x.type,
        own: x.own,
        wanted: false,
        created: x.created,
        lastUsed: x.lastUsed,
      }
      await tx.objectStore('blobs').put(rec)
    }
    await tx.done
    out.files += 1
  }
  try {
    const magic = await r.read(FILES_MAGIC.length)
    if (!magic || new TextDecoder().decode(magic) !== FILES_MAGIC) return out
    // The header line, byte by byte (it is short).
    for (let i = 0; ; i += 1) {
      const b = await r.read(1)
      if (!b || i > HEAD_MAX) return out
      if (b[0] === 0x0a) break
    }
    for (;;) {
      const head = await r.read(4)
      if (!head) break
      const word = new DataView(head.buffer).getUint32(0)
      const last = (word & FRAME_LAST) !== 0
      const len = word & ~FRAME_LAST
      if (len < 17 || len > FILES_FRAME_MAX) break
      const ct = await r.read(len)
      if (!ct) break
      let pt: Uint8Array
      try {
        pt = new Uint8Array(
          await crypto.subtle.decrypt(
            {
              name: 'AES-GCM',
              iv: frameIv(n) as BufferSource,
              additionalData: frameAad(fk.id, n, last) as BufferSource,
            },
            fk.key,
            ct as BufferSource
          )
        )
      } catch {
        break
      }
      n += 1
      const kind = pt[0]
      const body = pt.subarray(1)
      if (kind === F_END) {
        out.complete = last && body.length === 0
        break
      }
      if (last) break
      if (kind === F_FILE) {
        if (cur) await drop(cur)
        cur = null
        let meta: unknown
        try {
          meta = JSON.parse(new TextDecoder().decode(body))
        } catch {
          meta = null
        }
        if (!isFileMeta(meta)) {
          out.skipped += 1
          continue
        }
        const m = meta as {
          h: string
          size: number
          own: boolean
          created: number
          lastUsed: number
        }
        const count = blockCount(m.size)
        // Already here, or being downloaded (that download keeps its own blocks): left alone.
        const had = !!(await db.get('blobs', m.h))
        cur = {
          ...m,
          count,
          next: 0,
          hashes: new Uint8Array(count * 32),
          type: NEUTRAL_TYPE,
          had,
        }
        if (count === 0) {
          await finish(cur)
          cur = null
        }
        continue
      }
      if (kind === F_DROP) {
        if (cur) await drop(cur)
        cur = null
        continue
      }
      // A frame kind from a newer version, or a block of a file that was skipped: passed over.
      // Frames are authenticated and in order, so nothing after it is lost.
      if (kind !== F_BLOCK || !cur) continue
      const x: Incoming = cur
      if (body.length !== Math.min(BLOCK, x.size - x.next * BLOCK)) {
        await drop(x)
        cur = null
        continue
      }
      x.hashes.set(await digest(body), x.next * 32)
      if (x.next === 0) x.type = safeType(body.subarray(0, SNIFF_BYTES))
      if (!x.had)
        await db.put('blob_parts', { h: x.h, block: x.next, data: new Blob([body as BlobPart]) })
      x.next += 1
      done += body.length
      progress?.(done)
      if (x.next === x.count) {
        await finish(x)
        cur = null
      }
    }
  } finally {
    r.cancel()
  }
  if (cur) await drop(cur)
  return out
}
