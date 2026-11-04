import type { PackedRec } from '../acl_room'
import { UNKNOWN } from '../dag'
import type { EventRecord } from '../db'
import { LOCAL } from '../limits'
import { channelOf, isShortId } from '../state'
import { candidates, matches, SEARCH, words } from '../search'
import type { P2pMessage } from '../dm'
import type { ServerCtx } from './context'
import type { SearchQuery, SearchHit } from './types'

// Messages stored here (thread replies too) that show and match, newest first: one page of at
// most SEARCH.page below `cursor` (a sort key). `next` when more may follow.
// A query without letters or digits ("!!!") looks for that text in what shows.
export async function search(
  cx: ServerCtx,
  q: SearchQuery,
  cursor: string | null = null,
  page: number = SEARCH.page
) {
  const query = words(q.q)
  const literal = !query.length && q.q.trim() ? q.q.trim().toLowerCase() : null
  const rooms = [...cx.rooms.values()]
    .filter(r => !r.invite && !cx.readOnly(r.id) && (q.room === null || r.id === q.room))
    .map(r => r.id)
  const from = q.from ? new Set(q.from) : null
  // A transferred copy: its archive only (spec 3.8 step 6).
  const keeps = new Map<string, (r: EventRecord) => boolean>()
  for (const room of rooms)
    if (cx.sumOf(room).upgraded) {
      const keep = await cx.archiveKeep(room, cx.rooms.get(room)?.next)
      if (keep) keeps.set(room, keep)
    }
  const { pool, capped: more0 } = await cx.searchPool(q, query, rooms, cursor)
  const scan = pool.slice(0, SEARCH.scan)
  let capped = more0 || pool.length > scan.length
  const hits: SearchHit[] = []
  let last: string | null = null
  let i = 0
  while (i < scan.length && hits.length < page) {
    const chunk = scan.slice(i, i + LOCAL.server.searchChunk)
    i += chunk.length
    const recs = new Map<string, EventRecord>()
    for (const x of chunk) {
      const r = await cx.db.get('events', x.id)
      if (!r || r.room !== x.room || r.type !== 'msg' || !r.chan || r.purged || r.redacted) continue
      if (q.ch !== null && r.chan !== q.ch) continue
      if (from && !from.has(r.sender)) continue
      if (q.hasFile && !r.atts?.length) continue
      if (q.beforeTs !== null && r.effTs >= q.beforeTs * 1000) continue
      if (q.afterTs !== null && r.effTs <= q.afterTs * 1000) continue
      // A channel we may no longer view (spec 1.4) isn't searched either.
      if (!cx.isChannel(r.room, r.chan) || !cx.canViewCh(r.room, r.chan)) continue
      const keep = keeps.get(r.room)
      if (keep && !keep(r)) continue
      recs.set(r.id, r)
    }
    const shown = new Map<string, P2pMessage>()
    for (const room of new Set([...recs.values()].map(r => r.room)))
      for (const m of await cx.rows(
        room,
        [...recs.values()].filter(r => r.room === room)
      ))
        shown.set(m.id, m)
    for (const x of chunk) {
      last = x.sk
      const m = shown.get(x.id)
      const r = recs.get(x.id)
      const text = m ? (m.fwd ? m.fwd.body : m.body) : ''
      if (!m || !r || m.unavailable) continue
      if (literal ? !text.toLowerCase().includes(literal) : !matches(text, query)) continue
      hits.push({ room: r.room, ch: r.chan as string, thread: m.thread ?? null, m })
      if (hits.length >= page) break
    }
  }
  capped ||= i < scan.length || hits.length >= page
  return { hits, next: capped ? last : null }
}

export async function searchPool(
  cx: ServerCtx,
  q: SearchQuery,
  query: readonly string[],
  rooms: readonly string[],
  cursor: string | null
) {
  const now = cx.clock.now()
  const key = JSON.stringify([query, q.from, rooms])
  const c = cx.searchCache
  if (query.length && cursor !== null && c?.key === key && now - c.at < SEARCH.poolMs) {
    const pool = c.pool.filter(x => x.sk < cursor)
    if (pool.length || !c.capped) return { pool, capped: c.capped }
  }
  const pool: { room: string; id: string; sk: string }[] = []
  let capped = false
  const max = query.length ? SEARCH.pool : SEARCH.scan
  for (const room of rooms) {
    const got = query.length
      ? await candidates(cx.db, room, query, cursor, max)
      : await cx.recent(room, q, cursor, max)
    pool.push(...got.list)
    capped ||= got.more
  }
  pool.sort((a, b) => (a.sk < b.sk ? 1 : a.sk > b.sk ? -1 : 0))
  const kept = pool.slice(0, max)
  capped ||= pool.length > kept.length
  if (query.length) cx.searchCache = { key, at: now, pool: kept, capped }
  return { pool: kept, capped }
}

// Newest messages of a room below `before` without words to look for: by author when the query
// names authors, else every message.
export async function recent(
  cx: ServerCtx,
  room: string,
  q: SearchQuery,
  before: string | null,
  max: number
) {
  const out: { room: string; id: string; sk: string }[] = []
  const scan = async (index: 'room_type_sort' | 'room_sender_sort', key: string) => {
    let cursor = await cx.db
      .transaction('events')
      .store.index(index)
      .openCursor(
        IDBKeyRange.bound([room, key, ''], [room, key, before ?? '￿'], false, !!before),
        'prev'
      )
    let n = 0
    while (cursor && n < max + 1) {
      const r = cursor.value
      if (r.type === 'msg') {
        out.push({ room, id: r.id, sk: r.sortKey })
        n += 1
      }
      cursor = await cursor.continue()
    }
  }
  if (q.from) for (const ik of q.from) await scan('room_sender_sort', ik)
  else await scan('room_type_sort', 'msg')
  out.sort((a, b) => (a.sk < b.sk ? 1 : -1))
  return { list: out.slice(0, max), more: out.length > max }
}

// Whether a channel id is one of the room's live text channels.
export function isChannel(cx: ServerCtx, room: string, ch: string) {
  if (!isShortId(ch)) return false
  const c = channelOf(cx.sumOf(room), ch)
  return !!c && (c.kind === undefined || c.kind === 'text')
}

export function isVoiceChannel(cx: ServerCtx, room: string, ch: string) {
  if (!isShortId(ch) || cx.frozen(room)) return false
  return channelOf(cx.sumOf(room), ch)?.kind === 'voice'
}

// A joined member of a room we are joined in (voice frames come and go only between them).
export function voiceMember(cx: ServerCtx, room: string, ik: string | undefined) {
  return !!ik && cx.myMembership(room) === 'join' && cx.may(room, ik) === 'full'
}

// Who may be in a voice channel, and hear who is: a joined member who may view it.
// At once when the answer is cached.
export function voiceAllowed(
  cx: ServerCtx,
  room: string,
  ch: string,
  ik: string
): boolean | Promise<boolean> {
  if (!cx.isVoiceChannel(room, ch) || cx.myMembership(room) !== 'join') return false
  if (ik !== cx.me && cx.may(room, ik) !== 'full') return false
  const rt = cx.ensureRt(room)
  const key = `${ik}\n${ch}`
  const hit = rt.views.get(key)
  if (hit !== undefined) return hit
  // An answer for a state that changed meanwhile is stale: asked again.
  const sum = rt.sum
  return cx.host.viewable(room, ik, [ch]).then(([ok]) => {
    if (rt.sum !== sum) return cx.voiceAllowed(room, ch, ik)
    rt.views.set(key, ok === true)
    return ok === true
  })
}

// The voice channel we are in went away, or we may no longer view it; others who may not are
// gone from the lists.
export function checkVoice(cx: ServerCtx, room: string) {
  void cx.voice.recheck(room).catch(() => {})
  const cur = cx.voice.current()
  if (cur?.room !== room) return
  void Promise.resolve(cx.voiceAllowed(room, cur.ch, cx.me)).then(ok => {
    const now = cx.voice.current()
    if (!ok && now?.room === room && now.ch === cur.ch) cx.voice.leave()
  })
}

// The admission record of a stored ACL event (tests).
export async function recordOf(cx: ServerCtx, id: string): Promise<PackedRec | null> {
  return (await cx.db.get('events', id))?.acl ?? null
}

// Server events held for later (tests): pending (waiting for ACL parents) and held (dated ahead).
export function waiting(cx: ServerCtx, room: string) {
  const rt = cx.rt(room)
  return { pending: rt?.pending.size ?? 0, held: rt?.held.size ?? 0, unknown: UNKNOWN }
}
