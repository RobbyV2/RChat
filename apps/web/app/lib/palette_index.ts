// The palette's local search index: messages the client has seen and members of servers, built
// in the browser with MiniSearch. "Loaded only" keeps it in memory for the session; "Full" also
// keeps it on this device through the platform BlobStore (one record per conversation plus a
// manifest), so it survives a reload. It never holds more than `maxBytes` (the oldest messages go
// first). What may be shown is decided again at query time by the caller (`visible`).

import MiniSearch from 'minisearch'
import type { BlobStore } from './platform/blobs'

export type DocKind = 'message' | 'member'

export interface IndexDoc {
  // `m<message id>` or `u<server>\n<username>`.
  id: string
  kind: DocKind
  // Where it lives: `c<channel>`, `t<thread root>`, `d<dm>` for messages, `m:<server>` for
  // members. Access is dropped by bucket.
  bucket: string
  // The source adapter that produced it: `instance` for this server's channels and DMs.
  source: string
  server: string | null
  channel: number | null
  dm: number | null
  thread: number | null
  msg: number | null
  author: string
  name: string
  text: string
  at: number
}

export const FULL_MAX_BYTES = 50 * 1024 * 1024
export const LOADED_MAX_BYTES = 20 * 1024 * 1024
export const TEXT_MAX = 4000

export const messageDocId = (id: number) => `m${id}`
export const memberDocId = (server: string, username: string) => `u${server}\n${username}`
export const memberBucket = (server: string) => `m:${server}`

// Rough stored size of a document (UTF-16 code units of its JSON, as kept in IndexedDB).
export const docBytes = (d: IndexDoc) => JSON.stringify(d).length * 2

const str = (x: unknown, max = 200) => (typeof x === 'string' ? x.slice(0, max) : null)
const int = (x: unknown) => (Number.isSafeInteger(x) ? (x as number) : null)

// A stored document as written by `save`, or null when it is not one.
export const parseDoc = (x: unknown): IndexDoc | null => {
  if (typeof x !== 'object' || x === null) return null
  const o = x as Record<string, unknown>
  const id = str(o.id, 400)
  const bucket = str(o.bucket)
  const source = str(o.source) ?? 'instance'
  if (!id || !bucket || (o.kind !== 'message' && o.kind !== 'member')) return null
  const author = str(o.author)
  const name = str(o.name)
  const text = str(o.text, TEXT_MAX) ?? ''
  const at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0
  if (author === null || name === null) return null
  return {
    id,
    kind: o.kind,
    bucket,
    source,
    server: str(o.server),
    channel: int(o.channel),
    dm: int(o.dm),
    thread: int(o.thread),
    msg: int(o.msg),
    author,
    name,
    text,
    at,
  }
}

export interface Manifest {
  v: 1
  buckets: string[]
  // When each conversation was last backfilled (ms).
  filled: Record<string, number>
}

export const EMPTY_MANIFEST: Manifest = { v: 1, buckets: [], filled: {} }

export const parseManifest = (raw: string | null): Manifest => {
  try {
    const data = raw ? (JSON.parse(raw) as unknown) : null
    if (typeof data !== 'object' || data === null) return EMPTY_MANIFEST
    const { v, buckets, filled } = data as Record<string, unknown>
    if (v !== 1 || !Array.isArray(buckets)) return EMPTY_MANIFEST
    const out: Record<string, number> = {}
    if (typeof filled === 'object' && filled !== null)
      for (const [k, at] of Object.entries(filled))
        if (typeof at === 'number' && Number.isFinite(at)) out[k] = at
    return {
      v: 1,
      buckets: [...new Set(buckets.filter((b): b is string => typeof b === 'string' && !!b))],
      filled: out,
    }
  } catch {
    return EMPTY_MANIFEST
  }
}

export interface IndexHit {
  doc: IndexDoc
  score: number
}

// Words are runs of letters and digits, so `||spoiler||`, `@name` and `#channel` find the word.
export const tokenize = (text: string) => text.split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean)

const newMini = () =>
  new MiniSearch<IndexDoc>({
    fields: ['text', 'name', 'author'],
    storeFields: [],
    tokenize,
    autoVacuum: { minDirtCount: 200, minDirtFactor: 0.2, batchSize: 1000, batchWait: 20 },
  })

export class PaletteIndex {
  private mini = newMini()
  private docs = new Map<string, IndexDoc>()
  private sizes = new Map<string, number>()
  private buckets = new Map<string, Set<string>>()
  private dirty = new Set<string>()
  private total = 0
  filled: Record<string, number> = {}

  constructor(public maxBytes: number) {}

  get bytes() {
    return this.total
  }

  get count() {
    return this.docs.size
  }

  get messageCount() {
    let n = 0
    for (const d of this.docs.values()) if (d.kind === 'message') n += 1
    return n
  }

  get dirtyBuckets() {
    return [...this.dirty]
  }

  has(id: string) {
    return this.docs.has(id)
  }

  get(id: string) {
    return this.docs.get(id)
  }

  bucketNames() {
    return [...this.buckets.keys()]
  }

  docsIn(bucket: string): IndexDoc[] {
    return [...(this.buckets.get(bucket) ?? [])].flatMap(id => this.docs.get(id) ?? [])
  }

  private unlink(id: string) {
    const doc = this.docs.get(id)
    if (!doc) return
    this.mini.discard(id)
    this.docs.delete(id)
    this.total -= this.sizes.get(id) ?? 0
    this.sizes.delete(id)
    const set = this.buckets.get(doc.bucket)
    set?.delete(id)
    if (set && !set.size) this.buckets.delete(doc.bucket)
    this.dirty.add(doc.bucket)
  }

  // Adds or replaces documents. Returns how many changed.
  add(list: readonly IndexDoc[]) {
    let changed = 0
    for (const doc of list) {
      const before = this.docs.get(doc.id)
      if (
        before &&
        before.text === doc.text &&
        before.name === doc.name &&
        before.bucket === doc.bucket &&
        before.server === doc.server
      )
        continue
      if (before) this.unlink(doc.id)
      const clean = { ...doc, text: doc.text.slice(0, TEXT_MAX) }
      const size = docBytes(clean)
      this.docs.set(doc.id, clean)
      this.sizes.set(doc.id, size)
      this.total += size
      let set = this.buckets.get(doc.bucket)
      if (!set) this.buckets.set(doc.bucket, (set = new Set()))
      set.add(doc.id)
      this.mini.add(clean)
      this.dirty.add(doc.bucket)
      changed += 1
    }
    if (this.total > this.maxBytes) this.trim()
    return changed
  }

  // Drops the oldest messages until the index is under 90% of its cap.
  trim(target = this.maxBytes * 0.9) {
    if (this.total <= target) return
    const old = [...this.docs.values()]
      .filter(d => d.kind === 'message')
      .sort((a, b) => a.at - b.at)
    for (const d of old) {
      if (this.total <= target) break
      this.unlink(d.id)
    }
  }

  // Brings a conversation in line with a run of its messages (`ids`, as fetched or loaded):
  // documents of messages within the run's id range that are not in `docs` are dropped (deleted,
  // no longer visible, edited to nothing), and with `older` those before the range too. Changed
  // text is replaced. Returns how many documents changed.
  reconcile(bucket: string, docs: readonly IndexDoc[], ids: readonly number[], older = false) {
    let lo = Infinity
    let hi = -Infinity
    for (const id of ids) {
      if (id < lo) lo = id
      if (id > hi) hi = id
    }
    const keep = new Set(docs.map(d => d.id))
    let n = 0
    for (const d of this.docsIn(bucket)) {
      if (d.kind !== 'message' || d.msg === null || keep.has(d.id)) continue
      if ((d.msg >= lo && d.msg <= hi) || (older && (d.msg < lo || !ids.length))) {
        this.unlink(d.id)
        n += 1
      }
    }
    return n + this.add(docs)
  }

  remove(ids: readonly string[]) {
    for (const id of ids) this.unlink(id)
  }

  dropBucket(bucket: string) {
    for (const id of [...(this.buckets.get(bucket) ?? [])]) this.unlink(id)
    this.dirty.add(bucket)
    delete this.filled[bucket]
  }

  // Documents of one bucket matching `pred`.
  dropIn(bucket: string, pred: (d: IndexDoc) => boolean) {
    const gone = this.docsIn(bucket).filter(pred)
    for (const d of gone) this.unlink(d.id)
    return gone.length
  }

  // Every document matching `pred` (access lost to a server, a channel, a person).
  dropWhere(pred: (d: IndexDoc) => boolean) {
    const gone = [...this.docs.values()].filter(pred)
    for (const d of gone) this.unlink(d.id)
    for (const b of new Set(gone.map(d => d.bucket))) delete this.filled[b]
    return gone.length
  }

  // Everything is written again on the next save (after switching to "Full").
  touchAll() {
    for (const b of this.buckets.keys()) this.dirty.add(b)
  }

  servers() {
    return new Set([...this.docs.values()].flatMap(d => (d.server ? [d.server] : [])))
  }

  clear() {
    for (const b of this.buckets.keys()) this.dirty.add(b)
    this.mini = newMini()
    this.docs.clear()
    this.sizes.clear()
    this.buckets.clear()
    this.total = 0
    this.filled = {}
  }

  search(
    q: string,
    opts: { kind?: DocKind; limit?: number; visible?: (d: IndexDoc) => boolean } = {}
  ): IndexHit[] {
    const text = q.trim()
    if (!text) return []
    const { kind, limit = 20, visible = () => true } = opts
    const out: IndexHit[] = []
    const found = this.mini.search(text, {
      prefix: true,
      fuzzy: t => (t.length > 4 ? 0.2 : false),
      combineWith: 'AND',
      boost: { name: 1.5, author: 1.5 },
    })
    for (const r of found) {
      const doc = this.docs.get(r.id as string)
      if (!doc || (kind && doc.kind !== kind) || !visible(doc)) continue
      out.push({ doc, score: r.score })
      if (out.length >= limit * 3) break
    }
    out.sort((a, b) => b.score - a.score || b.doc.at - a.doc.at)
    return out.slice(0, limit)
  }

  // Writes the changed conversations and the manifest. Errors are left to the caller. It stops
  // (and each write is skipped) once `live` turns false: the device copy was removed meanwhile.
  async save(store: BlobStore, prefix: string, live: () => boolean = () => true) {
    const dirty = [...this.dirty]
    this.dirty.clear()
    try {
      for (const b of dirty) {
        if (!live()) return
        const list = this.docsIn(b)
        const key = `${prefix}${encodeURIComponent(b)}`
        if (list.length)
          await store.put(key, new Blob([JSON.stringify(list)], { type: 'application/json' }), live)
        else await store.remove(key)
      }
      if (!live()) return
      const manifest: Manifest = { v: 1, buckets: this.bucketNames(), filled: this.filled }
      await store.put(
        `${prefix}manifest`,
        new Blob([JSON.stringify(manifest)], { type: 'application/json' }),
        live
      )
    } catch (e) {
      for (const b of dirty) this.dirty.add(b)
      throw e
    }
  }

  // Reads what `save` wrote. Unreadable records are skipped.
  async load(store: BlobStore, prefix: string) {
    const blob = await store.get(`${prefix}manifest`)
    const manifest = parseManifest(blob ? await blob.text() : null)
    const docs: IndexDoc[] = []
    for (const b of manifest.buckets) {
      const part = await store.get(`${prefix}${encodeURIComponent(b)}`)
      if (!part) continue
      try {
        const list = JSON.parse(await part.text()) as unknown
        if (!Array.isArray(list)) continue
        for (const x of list) {
          const d = parseDoc(x)
          if (d && d.bucket === b) docs.push(d)
        }
      } catch {
        continue
      }
    }
    this.add(docs)
    this.filled = { ...manifest.filled, ...this.filled }
    this.dirty.clear()
    for (const b of manifest.buckets) if (!this.buckets.has(b)) this.dirty.add(b)
    return docs.length
  }
}
