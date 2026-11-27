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
import { PLAIN_FORM, sealingOf, searchForm, storedSealed, type SearchForm } from './sealed_db'
import type { Keyed } from './search_keys'
import { isEventId, type EditContent, type MsgContent } from './content'
import { LOCAL, type Local } from './limits'

// Local search over P2P server messages (store `search`): one row per word and
// message, written with the message in the transaction that stores, purges or drops it, and
// counted in the room's and every server's storage. Words are lowercase NFKD without marks; a
// query word of three characters or more matches any word it starts, a shorter one only itself.
// An edit's words count for its message, and hidden content keeps its rows (visibility changes
// after storage), so hits are checked against what shows before they are listed. A message any
// text of which is stored sealed has keyed rows (search_keys.ts), which hold no words; a room that
// switched holds both kinds.

// limits.ts `search`. `word` and `words` cut what the index holds, and `exact` how keyed rows are
// made: an index made with another cut is built again (rebuildStep).
export type SearchLimits = Local['search']
export type Cut = Pick<SearchLimits, 'word' | 'words'>
type Query = Pick<SearchLimits, 'word' | 'words' | 'exact'>
export type IndexCut = Pick<SearchLimits, 'word' | 'words' | 'exact'>

export const words = (text: string, cut: Cut = LOCAL.search): string[] => {
  const norm = text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
  const out = new Set<string>()
  for (const w of norm.split(/[^\p{L}\p{N}]+/u)) {
    if (!w) continue
    out.add(Array.from(w).slice(0, cut.word).join(''))
    if (out.size >= cut.words) break
  }
  return [...out]
}

const wordMatches = (w: string, q: string, exact: number) =>
  q.length <= exact ? w === q : w.startsWith(q)

// Whether every query word matches a word of `text`.
export const matches = (text: string, query: readonly string[], lim: Query = LOCAL.search) => {
  if (!query.length) return true
  const have = words(text, lim)
  return query.every(q => have.some(w => wordMatches(w, q, lim.exact)))
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

// The words a message's rows hold: its body's, then its author's edits' in order, `words` at
// most, so edits can't grow a message's rows past that.
const planned = (texts: (string | null)[], cut: Cut) => {
  const out = new Set<string>()
  for (const t of texts)
    for (const w of t ? words(t, cut) : []) {
      if (out.size >= cut.words) return out
      out.add(w)
    }
  return out
}

// The rows `words` are held as in one kind: words themselves, or keyed rows.
const rowsFor = (keyed: Keyed | null, room: string, words: Iterable<string>) => {
  const out = new Set<string>()
  for (const w of words) for (const row of keyed ? keyed.rows(room, w) : [w]) out.add(row)
  return out
}

// The kinds of rows the index may hold, for taking rows out.
const kinds = (form: SearchForm) => [null, ...form.every]

// Writes rows for words, keyed or plain; returns the bytes of the rows that are new.
const putWords = async (
  st: SearchWrite,
  room: string,
  id: string,
  sk: string,
  list: Iterable<string>,
  keyed: Keyed | null
) => {
  let bytes = 0
  const head = skHead(sk, id)
  for (const token of rowsFor(keyed, room, list)) {
    const k: SearchKey = [room, token, id]
    if ((await st.getKey(k)) !== undefined) continue
    await st.put(head, k)
    bytes += rowBytes(k, head)
  }
  return bytes
}

// Whether a word of a message has its rows, in any kind. A keyed word's own row is there only
// when every start it is held as is.
const held = async (st: SearchWrite, form: SearchForm, room: string, id: string, w: string) => {
  for (const keyed of kinds(form))
    if ((await st.getKey([room, keyed ? keyed.row(room, w) : w, id])) !== undefined) return true
  return false
}

// Takes out the rows `words` are held as in every kind, but those `keep` is held as.
const dropRows = async (
  st: SearchWrite,
  form: SearchForm,
  room: string,
  id: string,
  head: string,
  words: Iterable<string>,
  keep: Iterable<string> = []
) => {
  let bytes = 0
  const list = [...words]
  const kept = [...keep]
  for (const keyed of kinds(form)) {
    const keepRows = rowsFor(keyed, room, kept)
    for (const token of rowsFor(keyed, room, list)) {
      const k: SearchKey = [room, token, id]
      if (keepRows.has(token) || (await st.getKey(k)) === undefined) continue
      await st.delete(k)
      bytes += rowBytes(k, head)
    }
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

const wordsOf = async (events: EventRead, msg: EventRecord, cut: Cut, without?: string) =>
  planned(
    [
      textOf(msg),
      ...(await editsOf(events, msg)).filter(e => e.id !== without && indexable(e)).map(textOf),
    ],
    cut
  )

// Indexes a stored content event: a message (with the edits its author made of it that came
// first), or an edit of a message held here. A message any text of which is stored sealed gets
// keyed rows (`form.keyed`), or none when there is no device key; any other gets words. A
// message holds `words` words at most, whatever order its edits arrive in: words already there
// count first. Returns the bytes added.
export const indexEvent = async (
  st: SearchWrite,
  events: EventRead,
  rec: EventRecord,
  cut: Cut,
  form: SearchForm = PLAIN_FORM
) => {
  if (!indexable(rec) || (rec.type !== 'msg' && rec.type !== 'edit')) return 0
  const msg = await messageOf(events, rec)
  if (!msg) return 0
  const edits = await editsOf(events, msg)
  const sealed = [rec, msg, ...edits].some(storedSealed)
  if (sealed && !form.keyed) return 0
  // Every word any text of the message ever had (edits superseded or not): its possible rows.
  const every = new Set<string>()
  for (const r of [msg, ...edits]) {
    const t = textOf(r)
    for (const w of t ? words(t, cut) : []) every.add(w)
  }
  const present = new Set<string>()
  for (const w of every) if (await held(st, form, msg.room, msg.id, w)) present.add(w)
  let left = cut.words - present.size
  const fresh: string[] = []
  for (const w of planned([textOf(msg), ...edits.filter(indexable).map(textOf)], cut)) {
    if (left <= 0) break
    if (present.has(w)) continue
    fresh.push(w)
    left -= 1
  }
  return putWords(st, msg.room, msg.id, msg.sortKey, fresh, sealed ? form.keyed : null)
}

// About what a message's or edit's rows take (a cold start counts it for its author).
export const indexEstimate = (rec: EventRecord, cut: Cut) => {
  if (!indexable(rec) || (rec.type !== 'msg' && rec.type !== 'edit')) return 0
  const id = rec.type === 'edit' ? (rec.target ?? rec.id) : rec.id
  const text = textOf(rec)
  return (text ? words(text, cut) : []).reduce(
    (n, w) => n + rowBytes([rec.room, w, id], '0'.repeat(30)),
    0
  )
}

// Takes an edit's words off its message (the edit is dropped or purged; call it while the edit
// is stored whole): those no other text of the message holds. Returns the bytes freed.
export const unindexEdit = async (
  st: SearchWrite,
  events: EventRead,
  edit: EventRecord,
  cut: Cut,
  form: SearchForm = PLAIN_FORM
) => {
  const text = edit.type === 'edit' && edit.target ? textOf(edit) : null
  const msg = edit.target ? await events.get(edit.target) : undefined
  if (!text || !msg || msg.type !== 'msg' || msg.room !== edit.room) return 0
  const keep = indexable(msg) ? await wordsOf(events, msg, cut, edit.id) : new Set<string>()
  const head = skHead(msg.sortKey, msg.id)
  return dropRows(st, form, edit.room, msg.id, head, words(text, cut), keep)
}

// Takes a message out of the index (purged, dropped or deleted here), by its words and its
// edits' (call it while they are still stored whole); returns the bytes freed.
export const unindex = async (
  st: SearchWrite,
  events: EventRead,
  rec: EventRecord,
  cut: Cut,
  form: SearchForm = PLAIN_FORM
) => {
  if (rec.type !== 'msg') return 0
  const texts = [textOf(rec), ...(await editsOf(events, rec)).map(textOf)]
  const head = skHead(rec.sortKey, rec.id)
  const all = new Set(texts.flatMap(t => (t ? words(t, cut) : [])))
  return dropRows(st, form, rec.room, rec.id, head, all)
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

// The cut of an index whose meta states none: 32 characters of a word, 256 words of a message,
// and keyed rows made for whole words up to 2 characters.
const UNSTATED_CUT: IndexCut = { word: 32, words: 256, exact: 2 }

// The index's progress, or null when it is of another version or cut (it is built again), or,
// on a device that sealed something, does not say it holds keyed rows (`keyed`).
const readMeta = (x: unknown, cut: IndexCut, keyed: boolean): SearchMeta | null => {
  if (typeof x !== 'object' || x === null) return null
  const m = x as Record<string, unknown>
  const word = m.word ?? UNSTATED_CUT.word
  const max = m.words ?? UNSTATED_CUT.words
  const exact = m.exact ?? UNSTATED_CUT.exact
  return m.v === SEARCH_V &&
    typeof m.done === 'boolean' &&
    typeof m.at === 'string' &&
    word === cut.word &&
    max === cut.words &&
    exact === cut.exact &&
    (!keyed || m.keyed === true)
    ? { v: SEARCH_V, done: m.done, at: m.at }
    : null
}

// Whether the database's device sealed any room: its index must have been built with keyed rows.
const sealedHere = (db: P2pDatabase) => sealingOf(db)?.sealedAny === true

export const searchReady = async (db: P2pDatabase, cut: IndexCut = LOCAL.search) =>
  readMeta(await db.get('meta', SEARCH_META), cut, sealedHere(db))?.done === true

// Bytes of the index rows a step wrote or freed, per room (the rooms and the servers' total
// count them).
export const accountRows = async (
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
  lim: Pick<SearchLimits, 'word' | 'words' | 'step' | 'exact'> = LOCAL.search,
  skip: (room: string) => boolean = () => false
) => {
  const exact = lim.exact
  const tx = db.transaction(['events', 'search', 'meta', 'rooms'], 'readwrite')
  const meta = tx.objectStore('meta')
  const stored = await meta.get(SEARCH_META)
  let m = readMeta(stored, lim, sealedHere(db))
  if (m?.done) {
    // Built where nothing was sealed: complete for keyed rows too.
    if ((stored as { keyed?: unknown }).keyed !== true)
      await meta.put({ ...(stored as object), exact, keyed: true }, SEARCH_META)
    await tx.done
    return true
  }
  const st = tx.objectStore('search')
  const form = searchForm(db, exact)
  const delta = new Map<string, number>()
  if (!m) {
    for (const [room, n] of await deleteRows(st)) delta.set(room, -n)
    m = SEARCH_STALE
  }
  const events = tx.objectStore('events')
  let cursor = await events.openCursor(m.at ? IDBKeyRange.lowerBound(m.at, true) : undefined)
  let at = m.at
  let n = 0
  while (cursor && n < lim.step) {
    let rec = cursor.value
    if (rec.layer === 'c' && rec.type === 'msg' && rec.thread === undefined) {
      const t = (serverWire(rec).c as MsgContent | null)?.thread
      if (isEventId(t)) {
        rec = { ...rec, thread: t }
        await cursor.update(rec)
      }
    }
    if (rec.layer === 'c' && !skip(rec.room)) {
      delta.set(
        rec.room,
        (delta.get(rec.room) ?? 0) + (await indexEvent(st, events, rec, lim, form))
      )
    }
    at = rec.id
    n += 1
    cursor = await cursor.continue()
  }
  await accountRows(tx.objectStore('rooms'), meta, delta)
  const done = cursor === null
  await meta.put(
    { v: SEARCH_V, done, at, word: lim.word, words: lim.words, exact, keyed: true },
    SEARCH_META
  )
  await tx.done
  return done
}

// The rows that can match a query word: its own word when it is short, else every word it starts.
const wordRange = (room: string, q: string, exact: number) =>
  q.length <= exact
    ? IDBKeyRange.bound([room, q], [room, q, []])
    : IDBKeyRange.bound([room, q], [room, `${q}￿`])

// The keyed row a query word looks for.
const keyedRange = (room: string, keyed: Keyed, q: string) => {
  const row = keyed.row(room, q)
  return IDBKeyRange.bound([room, row], [room, row, []])
}

// Messages of `room` with a word matching every query word, newest first, below `before` (a sort
// key), at most `max`; `more` when there were more. Words and keyed rows both count.
export const candidates = async (
  db: P2pDatabase,
  room: string,
  query: readonly string[],
  before: string | null,
  max: number,
  exact: number
) => {
  const { every } = searchForm(db, exact)
  const order = [...query].sort((a, b) => b.length - a.length)
  const ranges = (q: string) => [
    wordRange(room, q, exact),
    ...every.map(keyed => keyedRange(room, keyed, q)),
  ]
  const tx = db.transaction('search')
  const sk = new Map<string, string>()
  for (const range of ranges(order[0])) {
    const [keys, heads] = await Promise.all([tx.store.getAllKeys(range), tx.store.getAll(range)])
    keys.forEach((k, i) => {
      const s = skOf(heads[i], k[2])
      if (before === null || s < before) sk.set(k[2], s)
    })
  }
  for (const q of order.slice(1)) {
    if (!sk.size) break
    const ids = new Set<string>()
    for (const range of ranges(q))
      for (const k of await db.getAllKeys('search', range)) ids.add(k[2])
    for (const id of [...sk.keys()]) if (!ids.has(id)) sk.delete(id)
  }
  const list = [...sk]
    .map(([id, s]) => ({ room, id, sk: s }))
    .sort((a, b) => (a.sk < b.sk ? 1 : -1))
  return { list: list.slice(0, max), more: list.length > max }
}
