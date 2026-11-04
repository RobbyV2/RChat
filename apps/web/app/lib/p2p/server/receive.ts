import { isRecord } from '../../bytes'
import { RULES_VERSION } from '../acl/rules'
import { applySummary, type SumDelta } from '../acl/summary'
import type { Received } from '../acl_room'
import {
  chainKey,
  contentCounts,
  DAG,
  getEvents,
  insertServer,
  SERVER_TOTAL_BYTES,
  withinShareNow,
  type DevChain,
  type Inserted,
} from '../dag'
import { serverWire, type ChanCounts, type EventRecord } from '../db'
import { claimedId2, validate2, type WireV2 } from '../event_v2'
import { shownReaction, type MsgContent } from '../content'
import { type Wire } from '../event_v1'
import { reachedBy } from '../flows'
import type { Message } from '../frames'
import { isKeyId, verifyCert, verifyProfile, type Cert, type Profile } from '../keys'
import { LOCAL } from '../limits'
import type { Session } from '../session'
import { chanFactsOf, channelPermsOf, isOwner, memberOf, membershipOf, P } from '../state'
import type { Check } from '../sync'
import type { ServerCtx } from './context'
import { storeDue } from './storage'
import { SERVER, VOUCH, SAVE_MS, sizeOfWire, type ServerArrival } from './types'
import { type Rt } from './rt'

// The wire checks: schema, sizes, id, `ch` and the device's signature. Everything else is
// admission's (insert). Malformed: a strike.
export async function check(cx: ServerCtx, room: string, raw: unknown): Promise<Check> {
  const id = claimedId2(raw)
  const r = cx.rooms.get(room)
  if (!r || r.legacy) return { ok: false, later: true, id }
  const genesis = isRecord(raw) && isRecord(raw.ev) && raw.ev.t === 'genesis'
  // Before the genesis its rules version is unknown: nothing else is judged yet (no strike).
  if (!genesis && cx.sumOf(room).rules === null) return { ok: false, later: true, id }
  const rules = cx.sumOf(room).rules ?? RULES_VERSION
  const v = genesis ? validate2(raw, null) : validate2(raw, room, rules)
  if (!v.ok) return { ok: false, later: false, id }
  if (genesis && v.id !== room) return { ok: false, later: false, id }
  return { ok: true, id: v.id, wire: v.wire as unknown as Wire, revoked: false }
}

export function insert(
  cx: ServerCtx,
  room: string,
  id: string,
  wire: Wire,
  receivedAt: number
): Promise<Inserted> {
  return cx.locked(room, () => cx.take(room, id, wire as unknown as WireV2, receivedAt, true))
}

// A peer's event (now, or released once its parents are here). Spec 3.9: one signed with this
// device's key (checked by `check`), admitted and stored here, past this device's own chain:
// another copy of this device (a profile restored from a backup) signs too.
export async function decidePeer(cx: ServerCtx, room: string, id: string, w: WireV2, now: number) {
  const mine = w.ev.a === cx.me && w.ev.dev === cx.myDev()
  const chain = mine
    ? ((await cx.db.get('meta', chainKey(room, w.ev.dev))) as DevChain | undefined)
    : undefined
  const out = await cx.decide(room, id, w, now)
  if (mine && out.status === 'new' && w.ev.seq > (chain?.seq ?? -1)) cx.conflicted(room)
  return out
}

// ACL ids the room waits for: missing parents of pending events.
export function wanted(cx: ServerCtx, room: string) {
  const rt = cx.rt(room)
  if (!rt) return []
  return [...rt.need, ...rt.waits.keys()].slice(0, DAG.missing)
}

export async function admittedHere(cx: ServerCtx, room: string, id: string) {
  const r = await cx.db.get('events', id)
  return !!r && r.room === room && (r.aseq !== undefined || r.layer === 'a')
}

// One received event, within the room's lock: pending while an ACL parent isn't held, refused
// after a rejected parent, otherwise decided and (admitted) stored, then whatever waited on it.
export async function take(
  cx: ServerCtx,
  room: string,
  id: string,
  w: WireV2,
  now: number,
  peer = false
): Promise<Inserted> {
  const rt = cx.ensureRt(room)
  await rt.loading
  const have = await cx.db.get('events', id)
  if (have) {
    // A purged body that shows again, fetched back (spec 4.3).
    if (
      have.purged &&
      (rt.want.has(id) || rt.viewed.has(id)) &&
      w.c !== null &&
      have.room === room
    ) {
      // Only while it still shows: what was hidden again stays purged.
      const [ok] = await cx.host.restorable(room, [id], rt.viewed.has(id))
      if (ok) return cx.restoreBody(room, id, w)
      rt.want.delete(id)
      rt.viewed.delete(id)
    }
    return { status: 'dup', rec: have }
  }
  // Dropped here (spec 2.3, 4.2): an ACL event is taken again only when something cites it.
  const gone = await cx.db.get('dropped', id)
  if (gone?.room === room && !(gone.layer === 'a' && (rt.waits.has(id) || rt.need.has(id)))) {
    if ((await cx.deps.store.room(room))?.missing.includes(id))
      await cx.updateRoom(room, cur => ({ ...cur, missing: cur.missing.filter(m => m !== id) }))
    return { status: 'dropped' }
  }
  if (rt.rejected.has(id)) return { status: 'rejected', why: 'known' }
  const ap = w.ev.ap ?? []
  if (ap.some(p => rt.rejected.has(p))) return cx.reject(room, id, 'parent')
  const missing: string[] = []
  for (const p of ap) if (!(await cx.admittedHere(room, p))) missing.push(p)
  if (missing.length) {
    cx.park(room, id, w, missing)
    return { status: 'quota' }
  }
  const res = peer ? await cx.decidePeer(room, id, w, now) : await cx.decide(room, id, w, now)
  if (res.status === 'new') {
    rt.need.delete(id)
    await cx.release(room, id, now)
  }
  return res
}

export function reject(cx: ServerCtx, room: string, id: string, why: string): Inserted {
  const rt = cx.ensureRt(room)
  rt.rejected.add(id)
  if (rt.rejected.size > SERVER.rejectedKept)
    rt.rejected.delete(rt.rejected.values().next().value as string)
  // What waited on it is refused with it.
  const q = [id]
  while (q.length) {
    const p = q.pop() as string
    for (const c of rt.waits.get(p) ?? []) {
      cx.unpark(rt, c)
      rt.rejected.add(c)
      q.push(c)
    }
    rt.waits.delete(p)
  }
  return { status: 'rejected', why }
}

// The pending store (spec 4.2): bounded per room; the oldest goes first.
export function park(cx: ServerCtx, room: string, id: string, w: WireV2, missing: string[]) {
  const rt = cx.ensureRt(room)
  if (rt.pending.has(id)) return
  const size = sizeOfWire(w)
  rt.pending.set(id, { wire: w, missing: new Set(missing), size })
  rt.pendingBytes += size
  for (const p of missing) {
    const s = rt.waits.get(p) ?? new Set<string>()
    s.add(id)
    rt.waits.set(p, s)
  }
  while (
    rt.pending.size > SERVER.pendingEvents ||
    (rt.pendingBytes > SERVER.pendingBytes && rt.pending.size > 1)
  )
    cx.unpark(rt, rt.pending.keys().next().value as string)
}

export function unpark(cx: ServerCtx, rt: Rt, id: string) {
  const p = rt.pending.get(id)
  if (!p) return
  rt.pending.delete(id)
  rt.pendingBytes -= p.size
  for (const m of p.missing) {
    const s = rt.waits.get(m)
    s?.delete(id)
    if (s && !s.size) rt.waits.delete(m)
  }
}

// Events that waited on `id` and now have every ACL parent: decided in turn.
export async function release(cx: ServerCtx, room: string, id: string, now: number) {
  const rt = cx.ensureRt(room)
  const queue = [id]
  const added: Inserted[] = []
  while (queue.length) {
    const p = queue.shift() as string
    const ws = [...(rt.waits.get(p) ?? [])]
    rt.waits.delete(p)
    for (const c of ws) {
      const x = rt.pending.get(c)
      if (!x) continue
      x.missing.delete(p)
      if (x.missing.size) continue
      cx.unpark(rt, c)
      const res = await cx.decidePeer(room, c, x.wire, now)
      if (res.status === 'new') {
        added.push(res)
        queue.push(c)
      }
    }
  }
  if (added.length) {
    void cx.stored(room, added).catch(() => {})
    cx.sync.announce(room)
  }
}

// Decides an event whose ACL parents are all held, and stores it if admitted.
export async function decide(
  cx: ServerCtx,
  room: string,
  id: string,
  w: WireV2,
  now: number,
  retried = false
): Promise<Inserted> {
  const rt = cx.ensureRt(room)
  // Someone else's content past its share of the budgets (spec 4.2): not now, no strike.
  if (
    w.ev.L === 'c' &&
    w.ev.a !== cx.me &&
    !(await withinShareNow(cx.db, room, w.ev.a, sizeOfWire(w), now, cx.caps()))
  )
    return { status: 'quota' }
  if (w.ev.L === 'c') {
    const full = await cx.contentFull(room, w)
    if (full) {
      const why = (await cx.deps.store.room(room))?.fullWhy ?? 'events'
      if ((await cx.evictForSpace(room, sizeOfWire(w), full === 'total')) > 0)
        return cx.decide(room, id, w, now)
      return { status: 'full', why }
    }
  }
  let out: Received
  let delta = null
  if (w.ev.L === 'a') ({ out, delta } = await cx.host.acl(room, id, w, now))
  else out = await cx.host.content(room, id, w, now)
  switch (out.s) {
    case 'M':
      return { status: 'invalid', why: 'auth' }
    case 'R':
      return cx.reject(room, id, out.why)
    case 'P': {
      // Parents stored here that the evaluator doesn't hold (it lost the room): load it again.
      const stored = await getEvents(cx.db, room, out.missing)
      if (!retried && stored.length === out.missing.length) {
        await cx.reload(room)
        return cx.decide(room, id, w, now, true)
      }
      cx.park(room, id, w, out.missing)
      return { status: 'quota' }
    }
    case 'H':
      return cx.hold(room, id, w)
  }
  let res
  // The evaluator took it but storage didn't: an ACL event (its state and the page's copy moved)
  // makes both start again from what is stored; content is let go of. An unknown-rules event
  // only counted.
  const undo = async () => {
    if (out.s === 'A') await cx.reload(room)
    else if (out.s === 'C') await cx.host.unhold(room, [id])
  }
  try {
    res = await insertServer(cx.db, room, id, w, now, {
      me: cx.me,
      ...(out.s === 'A' ? { aseq: out.aseq, acl: out.rec } : {}),
      unknown: out.s === 'U',
      roomCap: cx.deps.roomCap,
      roomBytes: cx.deps.roomBytes,
      serverCap: cx.deps.serverCap,
      serverBytes: cx.deps.serverBytes,
    })
  } catch (e) {
    await undo()
    throw e
  }
  if (res.status !== 'new' && res.status !== 'dup') await undo()
  if (res.status === 'stale') return { status: 'quota' }
  if (res.status === 'rejected') return cx.reject(room, id, res.why)
  if (res.status !== 'new') return res
  const cached = cx.rooms.get(room)
  if (cached && cached.lastSeq < res.rec.seq)
    cx.rooms.set(room, { ...cached, lastSeq: res.rec.seq })
  storeDue(rt)
  // Stored without its body (an edit of a message purged here).
  if (res.rec.purged) {
    rt.bodiless.add(id)
    await cx.host.bodies(room, [id], false, !!res.rec.evicted)
  }
  if (w.ev.L === 'a') {
    if (w.ev.t === 'migrate') cx.migrateArrived(rt)
    await cx.db.delete('dropped', id)
    await cx.learnFrom(res.rec)
    const to = w.c?.to
    if (w.ev.t === 'add' && w.ev.a !== cx.me && to !== cx.me && !isOwner(rt.sum, w.ev.a))
      rt.vouch.set(id, w.ev.a)
    if (delta) await cx.applyDelta(room, delta)
  } else {
    cx.evictBelow(room, res.rec)
    await cx.purgeRedacted(room, res.rec)
  }
  return res
}

// A body stored below where its sender's eviction walk starts moves the start back.
export function evictBelow(cx: ServerCtx, room: string, rec: EventRecord) {
  const starts = cx.ensureRt(room).evictFrom
  const at = starts.get(rec.sender)
  if (at !== undefined && rec.sortKey < at) starts.delete(rec.sender)
}

// Purges at arrival (spec 4.3): a counted redaction by its target's author strips the target at
// once, asked when the redaction or the target arrives, whichever comes last (any such
// redaction, whatever else came first); content of someone out of the server whose cause is
// already due goes at once too. A moderator's redaction we applied gets acknowledged.
export async function purgeRedacted(cx: ServerCtx, room: string, rec: EventRecord) {
  const ids =
    rec.type === 'redact'
      ? rec.target
        ? [rec.target]
        : []
      : (await cx.db.getAllFromIndex('events', 'room_target', [room, rec.id])).some(
            x => x.type === 'redact'
          )
        ? [rec.id]
        : []
  if (membershipOf(cx.sumOf(room), rec.sender) !== 'join') ids.push(rec.id)
  if (ids.length) await cx.purgePass(room, false, ids)
  if (rec.type === 'redact' && rec.target && rec.sender !== cx.me) {
    const t = await cx.db.get('events', rec.target)
    const [sh] = await cx.host.display(room, [rec.target])
    if (t && t.sender !== rec.sender && sh?.hidden?.why === 'redacted' && sh.hidden.by === rec.id)
      cx.noteRedaction(room)
  }
}

export function caps(cx: ServerCtx) {
  return {
    roomCap: cx.deps.roomCap,
    roomBytes: cx.deps.roomBytes,
    serverCap: cx.deps.serverCap,
    serverBytes: cx.deps.serverBytes,
  }
}

// The page's copy takes a delta from the evaluator; what follows from it runs for the members
// it changed, and the cache is written soon after.
export async function applyDelta(cx: ServerCtx, room: string, delta: SumDelta) {
  const rt = cx.ensureRt(room)
  const before = rt.sum
  rt.sum = applySummary(rt.sum, delta)
  // Only removals of the last day, and not from an empty copy (a start without a cache).
  const reached = before.count ? reachedBy(before, rt.sum, cx.me, cx.clock.now()) : []
  if (reached.length) cx.noteReached(rt, reached)
  cx.saveSoon(room)
  await cx.afterState(room, before, [
    ...Object.keys(delta.put?.members ?? {}),
    ...(delta.del?.members ?? []),
  ])
}

export function saveSoon(cx: ServerCtx, room: string) {
  if (cx.saving.has(room)) return
  cx.saving.add(room)
  cx.clock.set(() => {
    cx.saving.delete(room)
    if (cx.rooms.has(room)) void cx.saveCache(room).catch(() => {})
  }, SAVE_MS)
}

// Whether content of `w`'s size fits: no ('room' or 'total', the budget it doesn't fit) or yes.
export async function contentFull(
  cx: ServerCtx,
  room: string,
  w: WireV2
): Promise<'room' | 'total' | null> {
  const r = await cx.deps.store.room(room)
  if (!r) return 'room'
  const size = sizeOfWire(w)
  const bytes = ((await cx.db.get('meta', SERVER_TOTAL_BYTES)) as number | undefined) ?? 0
  const cc = await contentCounts({ get: k => cx.db.get('meta', k) }, r)
  if (
    cc.room >= (cx.deps.roomCap ?? DAG.roomCap) ||
    (r.bytes ?? 0) + size > (cx.deps.roomBytes ?? DAG.roomBytes)
  )
    return 'room'
  if (
    cc.total >= (cx.deps.serverCap ?? DAG.serverCap) ||
    bytes + size > (cx.deps.serverBytes ?? DAG.serverBytes)
  )
    return 'total'
  return null
}

// The hold store (spec 2.1): admitted, dated more than 5 minutes ahead of our clock; kept
// until our clock reaches it, at most SERVER.heldPerDevice per device.
export function hold(cx: ServerCtx, room: string, id: string, w: WireV2): Inserted {
  const rt = cx.ensureRt(room)
  const n = [...rt.held.values()].filter(h => h.wire.ev.dev === w.ev.dev).length
  if (n < SERVER.heldPerDevice)
    rt.held.set(id, { wire: w, due: w.ev.ts - LOCAL.server.heldEarlyMs })
  return { status: 'quota' }
}

// The vouching mark (see Rt.vouch).
export function vouch(cx: ServerCtx, room: string, rt: Rt, now: number) {
  if (cx.myMembership(room) !== 'join' || cx.frozen(room)) return
  if (now - rt.vouchedAt < VOUCH.roomMs) return
  const s = rt.sum
  const live = [...rt.vouch].filter(([add, by]) => {
    const to = Object.entries(s.members).find(([, m]) => m.adds?.includes(add))
    return !!to && membershipOf(s, by) === 'join'
  })
  rt.vouch = new Map(live)
  const due = live.filter(([, by]) => now - (cx.vouchedBy.get(by) ?? -Infinity) >= VOUCH.inviterMs)
  if (!due.length) return
  rt.vouchedAt = now
  for (const [add, by] of due) {
    cx.vouchedBy.set(by, now)
    rt.vouch.delete(add)
  }
  void cx.emit(room, 'mark', () => ({})).catch(() => {})
}

// Whether someone else put `ik` out of a room we are in (a kick or a ban).
export function removed(cx: ServerCtx, room: string, ik: string) {
  if (cx.myMembership(room) !== 'join') return false
  const m = memberOf(cx.sumOf(room), ik)
  return !!m && m.by !== undefined && m.by !== ik && (m.m === 'leave' || m.m === 'ban')
}

// A session that is only up so a removed member hears it: told, then closed.
export function farewell(cx: ServerCtx, s: Session) {
  const ik = s.remote?.ik
  if (!ik || cx.deps.node.contact(ik)?.state === 'mutual') return
  const rooms = [...cx.rooms.keys()]
  if (rooms.some(room => cx.may(room, ik))) return
  const gone = rooms.filter(room => cx.removed(room, ik))
  if (!gone.length) return
  for (const room of gone) cx.tellRemoved(s, room)
  cx.clock.set(() => {
    if (![...cx.rooms.keys()].some(room => cx.may(room, ik))) s.close('refused')
  }, 5_000)
}

// Someone we no longer serve hears why: the removal someone else made. Nothing else of the
// room goes to them.
export function tellRemoved(cx: ServerCtx, s: Session, room: string) {
  const ik = s.remote?.ik
  if (!ik) return
  const m = memberOf(cx.sumOf(room), ik)
  if (!m?.rem || m.by === ik || (m.m !== 'leave' && m.m !== 'ban')) return
  void cx.db.get('events', m.rem).then(rec => {
    if (rec) void s.send({ t: 'gmember', room, ev: rec.wire }).catch(() => {})
  })
}

export async function onMember(cx: ServerCtx, m: Message, s: Session) {
  const room = m.room
  if (typeof room !== 'string' || !cx.rooms.has(room)) return
  const ev = (m.ev as { ev?: { t?: unknown } } | null)?.ev
  const c = (m.ev as { c?: { to?: unknown } } | null)?.c
  if ((ev?.t !== 'kick' && ev?.t !== 'ban') || c?.to !== cx.me) return s.strike()
  const seen = cx.memberFrames.get(s) ?? new Set<string>()
  cx.memberFrames.set(s, seen)
  const mine = cx.myMembership(room)
  if (seen.has(room) || (mine !== 'join' && mine !== 'invite')) return
  seen.add(room)
  const v = await cx.check(room, m.ev)
  if (!v.ok) {
    if (!v.later) s.strike()
    return
  }
  await cx.insert(room, v.id, v.wire, cx.clock.now()).catch(() => {})
}

// Devices and profiles from introductions (genesis, join, device_add).
export async function learnFrom(cx: ServerCtx, rec: EventRecord) {
  const w = serverWire(rec)
  const c = w.c
  if (!c || !['genesis', 'join', 'device_add'].includes(w.ev.t)) return
  const ik = w.ev.a
  if (!isKeyId(ik) || ik === cx.me) return
  const certs = verifyCert(c.cert, ik) ? [c.cert as Cert] : []
  const profile = verifyProfile(c.profile, ik) ? (c.profile as Profile) : null
  if (certs.length || profile) await cx.learn(ik, certs, [], profile)
  if (c.binding !== undefined) cx.deps.node.heardBinding(ik, c.binding)
}

// Counts, pings and alerts for stored messages that show, and files.
export async function stored(cx: ServerCtx, room: string, added: Inserted[]) {
  if (cx.rt(room)?.mods.length) void cx.runMods(room)
  const r = cx.rooms.get(room)
  const s = cx.sumOf(room)
  const since = r?.since ?? Infinity
  if (r?.joining) {
    if (r.joining.ev) void cx.locked(room, () => cx.takeInvite(room)).catch(() => {})
    cx.maybeJoin(room)
  }
  const news = added.flatMap(a =>
    a.status === 'new' && a.rec.layer === 'c' && a.rec.sender !== cx.me ? [a.rec] : []
  )
  for (const a of added)
    if (a.status === 'new' && a.rec.type === 'redact' && a.freed.length) {
      const mine = a.rec.sender === cx.me
      void cx.deps.dms.blobs
        .release(a.freed, x => !mine || x.room !== room || x.sender === cx.me)
        .catch(() => {})
    }
  if (!news.length) return cx.changed(room)
  // Spec 3.8: an old copy counts and announces nothing new (what shows of it is its archive).
  if (s.upgraded) return cx.changed(room)
  const shown = await cx.host.display(
    room,
    news.map(x => x.id)
  )
  const counts = new Map<string, ChanCounts>()
  const from = r?.viewFrom ?? {}
  const arrivals: ServerArrival[] = []
  let F: ReturnType<typeof chanFactsOf> | undefined
  for (let i = 0; i < news.length; i++) {
    const rec = news[i]
    const sh = shown[i]
    if (!sh || sh.hidden) continue
    const c = serverWire(rec).c
    let ch: string | null = null
    let ping: ServerArrival['ping'] = null
    let unread = false
    let thread: string | null = null
    if (rec.type === 'msg' && c && rec.chan) {
      ch = rec.chan
      // Thread replies aren't unread in the channel; their pings count, per thread too.
      thread = await cx.rootOf(rec)
      unread = thread === null
      const m = c as unknown as MsgContent
      cx.gossip.stopTyping(room, ch, rec.sender, thread)
      if (!m.fwd && m.mentions?.includes(cx.me)) ping = 'mention'
      else if (m.everyone && sh.everyone) ping = 'everyone'
      else if (m.reply) {
        const t = await cx.db.get('events', m.reply)
        if (t && t.room === room && t.type === 'msg' && t.sender === cx.me) ping = 'reply'
      }
    } else if (rec.type === 'react' && c?.on === true && rec.target && shownReaction(c)) {
      const t = await cx.db.get('events', rec.target)
      if (t && t.room === room && t.sender === cx.me && t.chan) {
        ch = t.chan
        ping = 'reaction'
        thread = await cx.rootOf(t)
      }
    }
    if (!ch || !(channelPermsOf(s, cx.me, ch, (F ??= chanFactsOf(s))) & P.ViewChannel)) continue
    if (rec.type === 'msg' && c) cx.autoFetch(rec, c as unknown as MsgContent)
    if (rec.effTs < since || membershipOf(s, cx.me) !== 'join') continue
    // A channel we may view lately: what was held back from us before isn't new (no unread,
    // pings or alerts for it).
    if (Object.hasOwn(from, ch) && rec.effTs < from[ch]) continue
    const cur = counts.get(ch) ?? { unread: 0, pings: 0, readSeq: 0 }
    const next: ChanCounts = {
      ...cur,
      unread: cur.unread + (unread ? 1 : 0),
      pings: cur.pings + (ping ? 1 : 0),
    }
    if (ping && thread)
      next.threads = Object.assign(Object.create(null) as Record<string, number>, cur.threads, {
        [thread]: (cur.threads?.[thread] ?? 0) + 1,
      })
    counts.set(ch, next)
    arrivals.push({ room, ch, rec, ping, unread, thread })
  }
  if (counts.size)
    await cx.updateRoom(room, cur => {
      const chans = Object.assign(Object.create(null) as Record<string, ChanCounts>, cur.chans)
      for (const [ch, n] of counts) {
        const old = Object.hasOwn(chans, ch) ? chans[ch] : { unread: 0, pings: 0, readSeq: 0 }
        const next: ChanCounts = {
          ...old,
          unread: old.unread + n.unread,
          pings: old.pings + n.pings,
        }
        if (n.threads) {
          const threads = Object.assign(Object.create(null) as Record<string, number>, old.threads)
          for (const [t, k] of Object.entries(n.threads))
            threads[t] = (Object.hasOwn(threads, t) ? threads[t] : 0) + k
          next.threads = threads
        }
        chans[ch] = next
      }
      return { ...cur, chans }
    })
  for (const a of arrivals) for (const fn of cx.arriveFns) fn(a)
  cx.changed(room)
}

// Images up to the server limit are fetched by themselves.
export function autoFetch(cx: ServerCtx, rec: EventRecord, m: MsgContent) {
  const max = cx.deps.autoMax?.() ?? 0
  if (max <= 0 || cx.deps.attachments?.() === false) return
  const seen = new Set<string>()
  for (const f of [...(m.att ?? []), ...(m.fwd?.att ?? [])]) {
    if (f.size > max || !f.mime.startsWith('image/') || seen.has(f.h)) continue
    seen.add(f.h)
    cx.deps.dms.autoFetch(rec.sender, f)
  }
}
