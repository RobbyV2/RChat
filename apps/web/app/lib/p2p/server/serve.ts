import { DAG, getEvents } from '../dag'
import { serverWire, type EventRecord } from '../db'
import type { Wire } from '../event_v1'
import type { WireV2 } from '../event_v2'
import { cutOut } from '../flows'
import { historyOf, membershipOf } from '../state'
import type { Link, Walked } from '../sync'
import type { ServerCtx } from './context'

// What we serve a member: everything, only what belongs to their history (history `joined`),
// only the ACL DAG (invited, or redeeming a code with us), or nothing.
export function gate(cx: ServerCtx, room: string, ik: string): 'all' | 'joined' | 'acl' | 'none' {
  const s = cx.sumOf(room)
  const m = membershipOf(s, ik)
  if (m === 'invite') return 'acl'
  if (m !== 'join')
    return cx.myMembership(room) === 'join' &&
      (cx.redeeming(room, ik) || cutOut(s, ik, cx.clock.now()))
      ? 'acl'
      : 'none'
  return historyOf(s) === 'joined' ? 'joined' : 'all'
}

export async function walk(
  cx: ServerCtx,
  link: Link,
  from: string[],
  have: string[],
  limit: number,
  bytes: number,
  state: boolean
): Promise<Walked> {
  const room = link.room
  const g = cx.gate(room, link.ik)
  if (g === 'none') return { events: [], more: false, denied: true }
  if (state) {
    const ids = await cx.host.diff(room, from, have, limit)
    const recs = await getEvents(cx.db, room, ids)
    const out: EventRecord[] = []
    let size = 0
    for (const r of recs) {
      const n = JSON.stringify(r.wire).length
      if (out.length > 0 && size + n > bytes) return { events: out, more: true }
      size += n
      out.push(r)
    }
    return { events: out, more: ids.length >= limit }
  }
  if (g === 'acl') return { events: [], more: false, denied: true }
  return cx.walkContent(link, from, have, limit, bytes, g === 'joined')
}

// Content back over `prev` from `from`, stopping at what the peer has; under history `joined`
// only what belongs to its history (the walk goes on past the rest).
export async function walkContent(
  cx: ServerCtx,
  link: Link,
  from: string[],
  have: string[],
  limit: number,
  bytes: number,
  joined: boolean
): Promise<Walked> {
  const room = link.room
  const stop = new Set(have)
  const seen = new Set<string>()
  const queue = from.filter(id => !stop.has(id))
  const picked: EventRecord[] = []
  let steps = 0
  let more = false
  while (queue.length) {
    if (picked.length >= limit || steps >= DAG.walk) {
      more = true
      break
    }
    const id = queue.shift() as string
    if (seen.has(id)) continue
    seen.add(id)
    steps += 1
    const r = await cx.db.get('events', id)
    if (!r || r.room !== room || r.layer !== 'c') continue
    for (const p of serverWire(r).ev.prev ?? []) if (!stop.has(p) && !seen.has(p)) queue.push(p)
    if (r.purged) continue
    picked.push(r)
  }
  const ok = joined
    ? await cx.host.history(
        room,
        link.ik,
        picked.map(r => r.id)
      )
    : picked.map(() => true)
  const see = await cx.viewable(room, link.ik, picked)
  const out: EventRecord[] = []
  let size = 0
  for (let i = 0; i < picked.length; i++) {
    if (!ok[i] || !see[i]) continue
    const n = JSON.stringify(picked[i].wire).length
    if (out.length > 0 && size + n > bytes) {
      more = true
      break
    }
    size += n
    out.push(picked[i])
  }
  out.sort((a, b) => a.seq - b.seq)
  return { events: out, more }
}

export async function getFor(cx: ServerCtx, link: Link, ids: string[]) {
  const g = cx.gate(link.room, link.ik)
  if (g === 'none') return []
  const found = (await getEvents(cx.db, link.room, ids)).filter(r => !r.purged)
  const acl = found.filter(r => r.layer !== 'c')
  let content = g === 'all' || g === 'joined' ? found.filter(r => r.layer === 'c') : []
  const see = await cx.viewable(link.room, link.ik, content)
  content = content.filter((_r, i) => see[i])
  if (g !== 'joined') return [...acl, ...content]
  const ok = await cx.host.history(
    link.room,
    link.ik,
    content.map(r => r.id)
  )
  return [...acl, ...content.filter((_r, i) => ok[i])]
}

// Whether `ik` may be sent these content events: each one's channel must be one they may view
// (spec 3.7, Discord order); a copy without its body only to who may view every channel.
export function viewable(cx: ServerCtx, room: string, ik: string, recs: EventRecord[]) {
  if (!recs.length) return Promise.resolve([])
  return cx.host.viewable(
    room,
    ik,
    recs.map(r => (serverWire(r).c === null ? null : (r.chan ?? '')))
  )
}

// Our new events go out live to members who may have everything (content only of channels they
// may view: `views`, filled before the push); members under history `joined` pull content (the
// gate checks each one); invitees get the ACL.
export function pushable(cx: ServerCtx, link: Link, wire: Wire) {
  const g = cx.gate(link.room, link.ik)
  if (g === 'none') return false
  const w = wire as unknown as WireV2
  if (w.ev.L === 'a') return true
  if (g !== 'all') return false
  const ch = typeof w.c?.ch === 'string' ? w.c.ch : w.c === null ? null : ''
  return cx.rt(link.room)?.views.get(`${link.ik}\n${ch}`) === true
}

// Who of the room's links may be sent our content of `ch` (null: without its body).
export async function fillViews(cx: ServerCtx, room: string, ch: string | null) {
  const rt = cx.ensureRt(room)
  const iks = [...new Set(cx.sync.linksOf(room).map(l => l.ik))].filter(
    ik => !rt.views.has(`${ik}\n${ch}`)
  )
  if (!iks.length) return
  for (const ik of iks) {
    const sum = rt.sum
    const [ok] = await cx.host.viewable(room, ik, [ch])
    // An answer for a state that changed meanwhile is stale (voice reads these): not kept.
    if (rt.sum !== sum) return
    rt.views.set(`${ik}\n${ch}`, ok)
  }
}

// The file gate for server rooms: a joined member, a message they didn't write that carries
// the file and shows in a channel they may view, and (history `joined`) belongs to their
// history.
export async function entitled(cx: ServerCtx, ik: string, h: string) {
  for (const r of await cx.db.getAllFromIndex('events', 'att', h)) {
    if (r.redacted || r.sender === ik || !cx.rooms.has(r.room)) continue
    const g = cx.gate(r.room, ik)
    if (g !== 'all' && g !== 'joined') continue
    const [sh] = await cx.host.display(r.room, [r.id])
    if (!sh || sh.hidden) continue
    const [see] = await cx.viewable(r.room, ik, [r])
    if (!see) continue
    if (g === 'all') return true
    const [ok] = await cx.host.history(r.room, ik, [r.id])
    if (ok) return true
  }
  return false
}

// Who may have a file: joined members of the rooms where someone else's message carries it.
export async function holdersOf(cx: ServerCtx, h: string) {
  const out = new Set<string>()
  for (const r of await cx.db.getAllFromIndex('events', 'att', h)) {
    if (r.redacted || r.sender === cx.me || !cx.rooms.has(r.room)) continue
    for (const ik of cx.joinedOthers(r.room)) out.add(ik)
  }
  return [...out]
}
