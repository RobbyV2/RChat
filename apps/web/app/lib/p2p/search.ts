import {
  SEARCH_META,
  SEARCH_STALE,
  SEARCH_V,
  SERVER_TOTAL_BYTES,
  serverWire,
  type EventRecord,
  type P2pDatabase,
  type SearchKey,
  type SearchMeta,
} from './db'
import { isEventId, type EditContent, type MsgContent } from './event'
import { LOCAL } from './limits'

// Local search over P2P server messages (note section 7, store `search`): one row per word and
// message, written with the message in the transaction that stores, purges or drops it, and
// counted in the room's and every server's storage. Words are lowercase NFKD without marks; a
// query word of three characters or more matches any word it starts, a shorter one only itself.
// An edit's words count for its message, and hidden content keeps its rows (visibility changes
// after storage), so hits are checked against what shows before they are listed.

export const SEARCH = { ...LOCAL.search }

export const words = (text: string): string[] => {
  const norm = text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
  const out = new Set<string>()
  for (const w of norm.split(/[^\p{L}\p{N}]+/u)) {
    if (!w) continue
    out.add(Array.from(w).slice(0, SEARCH.word).join(''))
    if (out.size >= SEARCH.words) break
  }
  return [...out]
}

const wordMatches = (w: string, q: string) => (q.length <= SEARCH.exact ? w === q : w.startsWith(q))

// Whether every query word matches a word of `text`.
export const matches = (text: string, query: readonly string[]) => {
  if (!query.length) return true
  const have = words(text)
  return query.every(q => have.some(w => wordMatches(w, q)))
}

// What a row costs in storage, about: its key and value.
export const rowBytes = (k: SearchKey, v: string) =>
  16 + k[0].length + new TextEncoder().encode(k[1]).length + k[2].length + v.length

// The part of a sort key a row keeps: time and depth (the message id ends every sort key).
const skHead = (sk: string, id: string) =>
  sk.endsWith(`.${id}`) ? sk.slice(0, sk.length - id.length - 1) : sk
const skOf = (head: string, id: string) => `${head}.${id}`

// The words a message shows: its body, or a forward's.
const textOf = (rec: EventRecord) => {
  const c = serverWire(rec).c as (Partial<MsgContent> & Partial<EditContent>) | null
  if (!c) return null
  if (rec.type === 'msg') return typeof c.fwd?.body === 'string' ? c.fwd.body : (c.body ?? null)
  if (rec.type === 'edit') return typeof c.body === 'string' ? c.body : null
  return null
}

const indexable = (r: EventRecord | undefined): r is EventRecord =>
  !!r && r.layer === 'c' && !r.redacted && !r.purged && r.wire.c !== null

interface RowCursor {
  primaryKey: IDBValidKey
  value: string
  delete(): Promise<unknown>
  continue(): Promise<RowCursor | null>
}

export interface SearchWrite {
  put(v: string, k: SearchKey): Promise<unknown>
  getKey(k: SearchKey): Promise<IDBValidKey | undefined>
  delete(k: SearchKey): Promise<unknown>
  openCursor(q?: IDBKeyRange): Promise<RowCursor | null>
}

export interface EventRead {
  get(id: string): Promise<EventRecord | undefined>
  index(name: 'room_target'): { getAll(q: [string, string]): Promise<EventRecord[]> }
}

// The words a message's rows hold: its body's, then its author's edits' in order, SEARCH.words at
// most, so edits can't grow a message's rows past that.
const planned = (texts: (string | null)[]) => {
  const out = new Set<string>()
  for (const t of texts)
    for (const w of t ? words(t) : []) {
      if (out.size >= SEARCH.words) return out
      out.add(w)
    }
  return out
}

// Writes rows for words; returns the bytes of the rows that are new.
const putWords = async (
  st: SearchWrite,
  room: string,
  id: string,
  sk: string,
  list: Iterable<string>
) => {
  let bytes = 0
  const head = skHead(sk, id)
  for (const token of list) {
    const k: SearchKey = [room, token, id]
    if ((await st.getKey(k)) !== undefined) continue
    await st.put(head, k)
    bytes += rowBytes(k, head)
  }
  return bytes
}

// The edits a message's author made of it, oldest first.
const editsOf = async (events: EventRead, rec: EventRecord) =>
  (await events.index('room_target').getAll([rec.room, rec.id]))
    .filter(e => e.type === 'edit' && e.sender === rec.sender)
    .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0))

// The message an indexable message or edit is about.
const messageOf = async (events: EventRead, rec: EventRecord) => {
  const m =
    rec.type === 'msg'
      ? rec
      : rec.type === 'edit' && rec.target
        ? await events.get(rec.target)
        : undefined
  return indexable(m) && m.type === 'msg' && m.room === rec.room && m.sender === rec.sender
    ? m
    : null
}

const wordsOf = async (events: EventRead, msg: EventRecord, without?: string) =>
  planned([
    textOf(msg),
    ...(await editsOf(events, msg)).filter(e => e.id !== without && indexable(e)).map(textOf),
  ])

// Indexes a stored content event: a message (with the edits its author made of it that came
// first), or an edit of a message held here. A message holds SEARCH.words rows at most, whatever
// order its edits arrive in: rows already there count first. Returns the bytes added.
export const indexEvent = async (st: SearchWrite, events: EventRead, rec: EventRecord) => {
  if (!indexable(rec) || (rec.type !== 'msg' && rec.type !== 'edit')) return 0
  const msg = await messageOf(events, rec)
  if (!msg) return 0
  // Every word any text of the message ever had (edits superseded or not): its possible rows.
  const every = new Set<string>()
  for (const r of [msg, ...(await editsOf(events, msg))]) {
    const t = textOf(r)
    for (const w of t ? words(t) : []) every.add(w)
  }
  const present = new Set<string>()
  for (const w of every) if ((await st.getKey([msg.room, w, msg.id])) !== undefined) present.add(w)
  let left = SEARCH.words - present.size
  const fresh: string[] = []
  for (const w of await wordsOf(events, msg)) {
    if (left <= 0) break
    if (present.has(w)) continue
    fresh.push(w)
    left -= 1
  }
  return putWords(st, msg.room, msg.id, msg.sortKey, fresh)
}

// About what a message's or edit's rows take (a cold start counts it for its author).
export const indexEstimate = (rec: EventRecord) => {
  if (!indexable(rec) || (rec.type !== 'msg' && rec.type !== 'edit')) return 0
  const id = rec.type === 'edit' ? (rec.target ?? rec.id) : rec.id
  const text = textOf(rec)
  return (text ? words(text) : []).reduce(
    (n, w) => n + rowBytes([rec.room, w, id], '0'.repeat(30)),
    0
  )
}

// Takes an edit's words off its message (the edit is dropped or purged; call it while the edit
// is stored whole): those no other text of the message holds. Returns the bytes freed.
export const unindexEdit = async (st: SearchWrite, events: EventRead, edit: EventRecord) => {
  const text = edit.type === 'edit' && edit.target ? textOf(edit) : null
  const msg = edit.target ? await events.get(edit.target) : undefined
  if (!text || !msg || msg.type !== 'msg' || msg.room !== edit.room) return 0
  const keep = indexable(msg) ? await wordsOf(events, msg, edit.id) : new Set<string>()
  const head = skHead(msg.sortKey, msg.id)
  let bytes = 0
  for (const token of words(text)) {
    const k: SearchKey = [edit.room, token, msg.id]
    if (keep.has(token) || (await st.getKey(k)) === undefined) continue
    await st.delete(k)
    bytes += rowBytes(k, head)
  }
  return bytes
}

// Takes a message out of the index (purged, dropped or deleted here), by its words and its
// edits' (call it while they are still stored whole); returns the bytes freed.
export const unindex = async (st: SearchWrite, events: EventRead, rec: EventRecord) => {
  if (rec.type !== 'msg') return 0
  const texts = [textOf(rec), ...(await editsOf(events, rec)).map(textOf)]
  const head = skHead(rec.sortKey, rec.id)
  let bytes = 0
  for (const token of new Set(texts.flatMap(t => (t ? words(t) : [])))) {
    const k: SearchKey = [rec.room, token, rec.id]
    if ((await st.getKey(k)) === undefined) continue
    await st.delete(k)
    bytes += rowBytes(k, head)
  }
  return bytes
}

// Deletes rows (`room`'s, or all) and returns the bytes freed per room.
const deleteRows = async (st: SearchWrite, range?: IDBKeyRange) => {
  const freed = new Map<string, number>()
  let c = await st.openCursor(range)
  while (c) {
    const k = c.primaryKey as SearchKey
    freed.set(k[0], (freed.get(k[0]) ?? 0) + rowBytes(k, c.value))
    await c.delete()
    c = await c.continue()
  }
  return freed
}

export const unindexRoom = async (st: SearchWrite, room: string) =>
  (await deleteRows(st, IDBKeyRange.bound([room], [room, []]))).get(room) ?? 0

const readMeta = (x: unknown): SearchMeta | null => {
  if (typeof x !== 'object' || x === null) return null
  const m = x as Record<string, unknown>
  return m.v === SEARCH_V && typeof m.done === 'boolean' && typeof m.at === 'string'
    ? { v: SEARCH_V, done: m.done, at: m.at }
    : null
}

export const searchReady = async (db: P2pDatabase) =>
  readMeta(await db.get('meta', SEARCH_META))?.done === true

// Bytes of the index rows a step wrote or freed, per room (the rooms and the servers' total
// count them).
const account = async (
  rooms: {
    get(id: string): Promise<{ bytes?: number } | undefined>
    put(v: never): Promise<unknown>
  },
  meta: { get(k: string): Promise<unknown>; put(v: unknown, k: string): Promise<unknown> },
  delta: Map<string, number>
) => {
  let sum = 0
  for (const [room, n] of delta) {
    if (!n) continue
    const r = await rooms.get(room)
    if (!r) continue
    await rooms.put({ ...r, bytes: Math.max(0, (r.bytes ?? 0) + n) } as never)
    sum += n
  }
  if (!sum) return
  const cur = await meta.get(SERVER_TOTAL_BYTES)
  await meta.put(Math.max(0, (typeof cur === 'number' ? cur : 0) + sum), SERVER_TOTAL_BYTES)
}

// One step of building the index again from the stored events, in key order from where the last
// step stopped (an import, or the first start on this schema). Rooms `skip` names (servers this
// build can't read) are left out, as storing their events leaves them out. Thread roots stored
// before threads existed are filled in on the way. Returns whether the index is complete.
export const rebuildStep = async (
  db: P2pDatabase,
  limit = SEARCH.step,
  skip: (room: string) => boolean = () => false
) => {
  const tx = db.transaction(['events', 'search', 'meta', 'rooms'], 'readwrite')
  const meta = tx.objectStore('meta')
  let m = readMeta(await meta.get(SEARCH_META))
  if (m?.done) {
    await tx.done
    return true
  }
  const st = tx.objectStore('search')
  const delta = new Map<string, number>()
  if (!m) {
    for (const [room, n] of await deleteRows(st)) delta.set(room, -n)
    m = SEARCH_STALE
  }
  const events = tx.objectStore('events')
  let cursor = await events.openCursor(m.at ? IDBKeyRange.lowerBound(m.at, true) : undefined)
  let at = m.at
  let n = 0
  while (cursor && n < limit) {
    let rec = cursor.value
    if (rec.layer === 'c' && rec.type === 'msg' && rec.thread === undefined) {
      const t = (serverWire(rec).c as MsgContent | null)?.thread
      if (isEventId(t)) {
        rec = { ...rec, thread: t }
        await cursor.update(rec)
      }
    }
    if (rec.layer === 'c' && !skip(rec.room))
      delta.set(rec.room, (delta.get(rec.room) ?? 0) + (await indexEvent(st, events, rec)))
    at = rec.id
    n += 1
    cursor = await cursor.continue()
  }
  await account(tx.objectStore('rooms'), meta, delta)
  const done = cursor === null
  await meta.put({ v: SEARCH_V, done, at }, SEARCH_META)
  await tx.done
  return done
}

// The rows that can match a query word: its own word when it is short, else every word it starts.
const wordRange = (room: string, q: string) =>
  q.length <= SEARCH.exact
    ? IDBKeyRange.bound([room, q], [room, q, []])
    : IDBKeyRange.bound([room, q], [room, `${q}￿`])

// Messages of `room` with a word matching every query word, newest first, below `before` (a sort
// key), at most `max`; `more` when there were more.
export const candidates = async (
  db: P2pDatabase,
  room: string,
  query: readonly string[],
  before: string | null,
  max: number
) => {
  const order = [...query].sort((a, b) => b.length - a.length)
  const range = wordRange(room, order[0])
  const tx = db.transaction('search')
  const [keys, heads] = await Promise.all([tx.store.getAllKeys(range), tx.store.getAll(range)])
  const sk = new Map<string, string>()
  keys.forEach((k, i) => {
    const s = skOf(heads[i], k[2])
    if (before === null || s < before) sk.set(k[2], s)
  })
  for (const q of order.slice(1)) {
    if (!sk.size) break
    const ids = new Set((await db.getAllKeys('search', wordRange(room, q))).map(k => k[2]))
    for (const id of [...sk.keys()]) if (!ids.has(id)) sk.delete(id)
  }
  const list = [...sk]
    .map(([id, s]) => ({ room, id, sk: s }))
    .sort((a, b) => (a.sk < b.sk ? 1 : -1))
  return { list: list.slice(0, max), more: list.length > max }
}
