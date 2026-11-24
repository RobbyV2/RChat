import { signDeviceCert2 } from '../acl/binding'
import { knownRules } from '../acl/rules'
import {
  memberExtras,
  recentWrites,
  roomExtras,
  sameExtras,
  writeFits,
  type RoomExtras,
} from '../../profile_fields'
import type { ProfilesMode } from '../../types'
import type { Plan } from '../acl_room'
import {
  dropServer,
  evictionOrder,
  oldestBodies,
  purgeServer,
  restoreBody as restoreIn,
  type Inserted,
} from '../dag'
import { serverWire, type RoomRecord } from '../db'
import { signRevocation2, headerOk, type WireV2 } from '../event_v2'
import { CANT_TEXT, VOUCH_WAIT_TEXT } from '../flows'
import { memberBindingDue } from '../badge'
import { cleanName, keyId } from '../keys'
import { can, memberOf, P } from '../state'
import { MOVED_TEXT } from '../dm'
import type { ServerCtx } from './context'
import { ServerError, sizeOfWire } from './types'
import { type Rt } from './rt'

// Storage work is due: the state or the held content changed.
export const storeDue = (rt: Rt) => {
  rt.storeDirty = true
}

// The content a cold start found held without its body.
export const heldBare = (rt: Rt, ids: Iterable<string>) => {
  rt.bodiless = new Set(ids)
}

// A tick's storage work in room `r`: a storage pass when due, bodies still
// wanted asked for again while some are, proofs, and the mark acknowledging a redaction.
export function tick(cx: ServerCtx, r: RoomRecord, rt: Rt, now: number) {
  const lim = cx.local.server
  const every = Object.keys(r.causes ?? {}).length ? lim.causesMs : Infinity
  if ((rt.storeDirty && now - rt.storeAt >= lim.storeMs) || now - rt.storeAt >= every) {
    rt.storeDirty = false
    rt.storeAt = now
    void cx.locked(r.id, () => cx.storePass(r.id)).catch(() => {})
  }
  if ((rt.want.size || rt.viewed.size) && now - rt.wantAt >= lim.causesMs) {
    rt.wantAt = now
    void cx.locked(r.id, () => cx.wantPass(r.id)).catch(() => {})
  }
  if (rt.proofs.size) cx.postProofs(r.id, rt, now)
  if (rt.ackDue !== null && rt.ackDue <= now) cx.ackRedactions(r.id, rt, now)
}

// What the state and the held content let storage do now: drop what the ACL core names, purge
// bodies whose cause is stable, ask for bodies that show again, and look for proofs to post.
export async function storePass(cx: ServerCtx, room: string) {
  if (!cx.rooms.has(room) || !knownRules(cx.sumOf(room).rules)) return
  await cx.dropPass(room)
  await cx.purgePass(room, false)
  await cx.wantPass(room)
  await cx.proofPass(room)
}

export function myDev(cx: ServerCtx) {
  const author = cx.deps.node.author()
  return author ? keyId(author.dk.pk) : undefined
}

export async function dropPass(cx: ServerCtx, room: string) {
  const d = await cx.host.drops(room, cx.myDev())
  if (!d.acl.length && !d.content.length) return
  let freed: string[]
  try {
    freed = await dropServer(cx.db, room, d, cx.local.search)
  } catch (e) {
    // The evaluator let go of what is still stored: it starts again from storage.
    await cx.reload(room)
    throw e
  }
  const rt = cx.ensureRt(room)
  for (const id of d.content) {
    rt.bodiless.delete(id)
    rt.want.delete(id)
  }
  await cx.refreshRoom(room)
  if (d.delta) await cx.applyDelta(room, d.delta)
  if (freed.length) void cx.deps.dms.blobs.release([...new Set(freed)]).catch(() => {})
  cx.changed(room)
}

export async function refreshRoom(cx: ServerCtx, room: string) {
  const after = await cx.deps.store.room(room)
  if (after) cx.rooms.set(room, after)
}

// A hidden body goes when its cause is stable (S1 to S4; S4 is the time it has stood
// here, kept per cause), or under `pressure` when S1 to S3 hold; a counted redaction by the
// content's own author at once. Under pressure with nothing stable, every hidden body goes
// (they can be fetched again), keeping its files as an eviction does. `only`: just these
// content events. Returns how many went.
export async function purgePass(cx: ServerCtx, room: string, pressure: boolean, only?: string[]) {
  const p = await cx.host.purgeable(room, only)
  const now = cx.clock.now()
  const old = cx.rooms.get(room)?.causes ?? {}
  const causes: Record<string, number> = only ? { ...old } : {}
  for (const id of [...p.live, ...p.causes.filter(c => c.kind !== 'self').map(c => c.id)])
    causes[id] = old[id] ?? now
  const keys = (x: Record<string, number>) => Object.keys(x).sort().join()
  if (keys(causes) !== keys(old)) await cx.updateRoom(room, cur => ({ ...cur, causes }))
  const due = (c: (typeof p.causes)[number]) =>
    c.kind === 'self' ||
    (c.stable && (pressure || now - causes[c.id] >= cx.local.server.purgeAfter))
  const ids = p.causes.filter(due).flatMap(c => c.ids)
  const n = await cx.purge(room, ids)
  if (!pressure || p.causes.some(c => c.kind !== 'self' && due(c))) return n
  const rest = [...p.causes.filter(c => !due(c)).flatMap(c => c.ids), ...p.other]
  return n + (await cx.purge(room, rest, false, true))
}

// Purges the bodies of `ids` and their authors' edits of them: each keeps only its header
// (never served), its files go, and the room's space comes back. `evict`: bodies that show,
// evicted for space, fetched again only when viewed. `keepFiles`: bodies that can be fetched
// again free no file space the budget counts, so files of our own messages stay, and so does
// every file we sent (our uploads), until we delete them.
export async function purge(
  cx: ServerCtx,
  room: string,
  ids: string[],
  evict = false,
  keepFiles = evict
) {
  if (!ids.length) return 0
  const { done, freed, mine } = await purgeServer(cx.db, room, ids, cx.me, evict, cx.local.search)
  if (!done.length) return 0
  const rt = cx.ensureRt(room)
  for (const id of done) rt.bodiless.add(id)
  await cx.host.bodies(room, done, false, evict)
  await cx.refreshRoom(room)
  const blobs = cx.deps.dms.blobs
  if (freed.length) void blobs.release([...new Set(freed)], undefined, keepFiles).catch(() => {})
  if (mine.length && !keepFiles)
    void blobs
      .release([...new Set(mine)], x => x.room !== room || x.sender === cx.me)
      .catch(() => {})
  cx.changed(room)
  return done.length
}

// Bodies that show again after a purge (a later event overturned their cause), and evicted ones
// someone viewed: fetched by id from a peer that still holds them.
export async function wantPass(cx: ServerCtx, room: string) {
  const rt = cx.ensureRt(room)
  rt.wantAt = cx.clock.now()
  if (!rt.bodiless.size) return
  // Viewed bodies that no longer show aren't asked for any more.
  const viewed = [...rt.viewed]
  const still = await cx.host.restorable(room, viewed, true)
  rt.viewed = new Set(viewed.filter((_id, i) => still[i]))
  const w = [...new Set([...(await cx.host.wanted(room)), ...rt.viewed])]
  rt.want = new Set(w)
  if (w.length) {
    cx.sync.fetch(room, w)
    cx.changed(room)
  }
}

export async function restoreBody(
  cx: ServerCtx,
  room: string,
  id: string,
  w: WireV2
): Promise<Inserted> {
  // Room for it first: just its size, from bodies not fetched back lately.
  const full = await cx.contentFull(room, w)
  if (full) await cx.evictForSpace(room, sizeOfWire(w), full === 'total', true)
  const rec = await restoreIn(cx.db, room, id, w, cx.clock.now(), cx.local.search)
  const rt = cx.ensureRt(room)
  if (!rec) return { status: 'dropped' }
  rt.evictFrom.delete(rec.sender)
  rt.bodiless.delete(id)
  rt.want.delete(id)
  rt.viewed.delete(id)
  // What waited on it (its author's edits) may be wanted now.
  rt.storeDirty = true
  await cx.host.bodies(room, [id], true)
  await cx.refreshRoom(room)
  cx.changed(room)
  return { status: 'dup', rec }
}

// Proofs: evidence that lowers a device's fork point below an ACL event of it
// is posted after a random delay, unless what arrived meanwhile already lowered it as far.
export async function proofPass(cx: ServerCtx, room: string) {
  const author = cx.deps.node.author()
  if (!author || cx.myMembership(room) !== 'join' || cx.frozen(room)) return
  const rt = cx.ensureRt(room)
  const now = cx.clock.now()
  for (const c of await cx.host.proofs(room, cx.me, keyId(author.dk.pk))) {
    if ((rt.proofed.get(c.dev) ?? Infinity) <= c.f) continue
    const q = rt.proofs.get(c.dev)
    if (q && q.f <= c.f) continue
    const rand = cx.deps.random ?? Math.random
    const due = now + Math.floor(rand() * cx.local.server.proofDelayMs)
    rt.proofs.set(c.dev, { f: c.f, due })
  }
}

export function postProofs(cx: ServerCtx, room: string, rt: Rt, now: number) {
  for (const [dev, q] of rt.proofs) {
    if (q.due > now) continue
    if (rt.proofTimes.count(now) >= rt.proofTimes.limit) return
    rt.proofs.delete(dev)
    rt.proofTimes.note(now)
    void cx.postProof(room, dev).catch(() => {})
  }
}

export async function postProof(cx: ServerCtx, room: string, dev: string) {
  const author = cx.deps.node.author()
  if (!author || cx.myMembership(room) !== 'join' || cx.frozen(room)) return
  const [c] = await cx.host.proofs(room, cx.me, keyId(author.dk.pk), [dev])
  if (!c) return
  // A side is a stored event's core, or a dropped event's header; either must check out.
  const side = async (id: string) => {
    const e = await cx.db.get('events', id)
    const w = e?.room === room ? serverWire(e) : (await cx.db.get('dropped', id))?.hdr
    const x = w ? { ev: w.ev, sig: w.sig } : null
    return x && headerOk(id, x, room) ? x : null
  }
  const x = await side(c.x)
  const y = await side(c.y)
  if (!x || !y) return
  await cx.emit(room, 'proof', () => ({ x, y }))
  const rt = cx.ensureRt(room)
  rt.proofed.set(dev, Math.min(rt.proofed.get(dev) ?? Infinity, c.f))
}

// A moderator's redaction we applied: a mark naming it within a minute, so it can be
// acknowledged, at most one per room per `server.ackMs`, and only while some redaction still
// needs it (ackRedactions).
export function noteRedaction(cx: ServerCtx, room: string) {
  const rt = cx.ensureRt(room)
  if (rt.ackDue !== null) return
  const rand = cx.deps.random ?? Math.random
  const lim = cx.local.server
  const at = cx.clock.now() + Math.floor(rand() * lim.ackDelayMs)
  rt.ackDue = Math.max(at, rt.ackAt + lim.ackMs)
}

// A mark only names redactions not yet acknowledged that can still be
// (at least 2 identities other than their authors, us among them); with none, no mark.
export function ackRedactions(cx: ServerCtx, room: string, rt: Rt, now: number) {
  rt.ackDue = null
  if (cx.myMembership(room) !== 'join' || cx.frozen(room)) return
  void cx
    .locked(room, async () => {
      const ack = await cx.host.acks(room, cx.me)
      if (!ack.length) return
      rt.ackAt = now
      await cx.emitNow(room, 'mark', () => ({ ack }))
    })
    .catch(() => {})
}

// Out of space: purgeable bodies go first, then hidden ones that can be fetched
// again, then the oldest bodies of the sender whose bodies take the most here (`total`: in
// every server), until `size` more bytes fit, at least `server.evictBytes`. Bodies fetched back
// lately go only when nothing else can. `restore`: making room for a body fetched back, which
// takes just its size and never one fetched back lately.
export async function evictForSpace(
  cx: ServerCtx,
  room: string,
  size: number,
  total: boolean,
  restore = false
) {
  const n = await cx.purgePass(room, true)
  if (n) return n
  const now = cx.clock.now()
  const need = restore ? size : Math.max(size, cx.local.server.evictBytes)
  let late: { room: string; ids: string[] } | null = null
  for (const c of await evictionOrder(cx.db, total ? null : room, cx.me)) {
    const starts = cx.ensureRt(c.room).evictFrom
    const walk = (from?: string) =>
      oldestBodies(cx.db, c.room, c.ik, need, now, cx.local.dag, {
        from,
        undelivered: c.ik === cx.me,
      })
    const at = starts.get(c.ik)
    let got = await walk(at)
    // Nothing past where the last walk stopped: from the start once (a body stored since below
    // it).
    if (at !== undefined && !got.ids.length && !got.late.length) got = await walk()
    if (got.from !== undefined) starts.set(c.ik, got.from)
    if (got.ids.length) return cx.purge(c.room, got.ids, true)
    if (!late && got.late.length) late = { room: c.room, ids: got.late }
  }
  return late && !restore ? cx.purge(late.room, late.ids, true) : 0
}

export async function postJoin(cx: ServerCtx, room: string) {
  const rt = cx.ensureRt(room)
  if (rt.joinPosted) return
  rt.joinPosted = true
  try {
    await cx.emit(room, 'join', plan => cx.joinContent(room, plan))
    rt.joinWait = null
    await cx.updateRoom(room, cur => ({
      ...cur,
      joining: null,
      since: cur.since ?? cx.clock.now(),
    }))
    cx.changed(room)
    cx.deps.node.schedule()
  } catch (e) {
    rt.joinPosted = false
    // The join waits for a third member's acknowledgement (shown, retried).
    const wait = e instanceof ServerError && e.message === VOUCH_WAIT_TEXT ? e.message : null
    if (wait !== rt.joinWait) {
      rt.joinWait = wait
      cx.changed(room)
    }
    throw e
  }
}

// A join that introduces this device carries its certificate, signed by the identity key,
// and the v1 certificate and profile peers use to reach and name us.
export function joinContent(cx: ServerCtx, room: string, plan: Plan): Record<string, unknown> {
  const author = cx.deps.node.author()
  if (!author) throw new ServerError(MOVED_TEXT)
  const dk = keyId(author.dk.pk)
  const c: Record<string, unknown> = {
    idb: { ik: cx.me, dcert: signDeviceCert2(author.ik, room, cx.me, dk, plan.iprev) },
    profile: cx.deps.node.profile,
    cert: cx.deps.node.cert,
  }
  const binding = cx.deps.node.binding
  if (binding) c.binding = binding
  return c
}

// After a device move this device isn't one of ours in the server yet: it introduces itself
// (device_add). A changed name goes out as a profile write.
export async function refreshMe(cx: ServerCtx, room: string) {
  const m = memberOf(cx.sumOf(room), cx.me)
  const author = cx.deps.node.author()
  if (m?.m !== 'join' || !author) return
  const dk = keyId(author.dk.pk)
  if (!m.devs.includes(dk))
    await cx.emit(room, 'device_add', plan => ({
      dcert: signDeviceCert2(author.ik, room, cx.me, dk, plan.iprev),
      cert: cx.deps.node.cert,
      profile: cx.deps.node.profile,
    }))
  // A move or import makes a new device; the one it moved from is revoked with the
  // watermark of what we hold of it, so whatever it signs later doesn't count.
  const live = memberOf(cx.sumOf(room), cx.me)?.devs ?? []
  for (const old of cx.deps.node.movedFrom())
    if (old !== dk && live.includes(old))
      await cx.emit(
        room,
        'device_revoke',
        plan => {
          const seen = plan.seen?.[old] ?? -1
          return { ik: cx.me, dk: old, seen, rec: signRevocation2(author.ik, room, old, seen) }
        },
        { to: old }
      )
  // The whole content counts, not the name alone: a device that doesn't know the extras
  // writes them away, and this one puts them back. So does a new membership (a new copy, a
  // join again), where what we wrote before shows nothing.
  const want = cx.profileContent(room)
  if (
    (m.profile && m.profile.name !== want.name) ||
    !sameExtras(memberExtras(m, cleanName), roomExtras(want, cleanName))
  )
    await writeProfile(cx, room).catch(() => {})
}

// Our `profile` content in a server: the global name and badge, and what we set for ourselves
// there with the join it counts for.
export function profileContent(cx: ServerCtx, room?: string) {
  const c: Record<string, unknown> = { name: cx.deps.node.name }
  const binding = cx.deps.node.binding
  if (binding) c.binding = binding
  if (!room) return c
  const extras = roomExtras(cx.rooms.get(room)?.profile, cleanName)
  const join = memberOf(cx.sumOf(room), cx.me)?.joinId
  return join && Object.keys(extras).length ? { ...c, ...extras, in: join } : c
}

export const PROFILE_OFTEN_TEXT = 'You changed your server profile too often. Try again later.'

// Our `profile` write in a server, at most `writes_per_hour` an hour from this device.
export async function writeProfile(cx: ServerCtx, room: string) {
  const now = cx.clock.now()
  if (!writeFits(cx.rooms.get(room)?.profileAt, now)) throw new ServerError(PROFILE_OFTEN_TEXT)
  await cx.updateRoom(room, cur => ({
    ...cur,
    profileAt: [...recentWrites(cur.profileAt, now), now],
  }))
  return cx.emit(room, 'profile', () => cx.profileContent(room))
}

// What we show in one server: a nickname, a description, an avatar and a banner color. An
// empty intent goes back to the global profile.
export async function setRoomProfile(cx: ServerCtx, room: string, intent: RoomExtras) {
  const m = memberOf(cx.sumOf(room), cx.me)
  if (m?.m !== 'join') throw new ServerError(CANT_TEXT)
  const next = roomExtras(intent, cleanName)
  if (!writeFits(cx.rooms.get(room)?.profileAt, cx.clock.now()))
    throw new ServerError(PROFILE_OFTEN_TEXT)
  await cx.updateRoom(room, cur => {
    const { profile: _, ...rest } = cur
    return Object.keys(next).length ? { ...rest, profile: next } : rest
  })
  await writeProfile(cx, room)
  cx.changed(room)
}

// What members may set in their profile here (`profile_mode`).
export async function setProfileMode(cx: ServerCtx, room: string, mode: ProfilesMode) {
  // Admitted by the generic rule: one we may not make would show nothing.
  const s = cx.sumOf(room)
  if (!can(s, cx.me, P.ManageServer)) throw new ServerError(CANT_TEXT)
  return cx.emit(room, 'profile_mode', () => ({ mode }))
}

// Our account badge was turned on or renewed: once it is due (badge.ts) every server where it
// is gets a profile write with it. These writes are not ours to space out: they don't count
// against the profile writes of an hour.
export async function refreshBadge(cx: ServerCtx) {
  const binding = cx.deps.node.binding
  const now = cx.clock.now()
  const due = [...cx.rooms.keys()].filter(id => {
    const m = memberOf(cx.sumOf(id), cx.me)
    return m?.m === 'join' && memberBindingDue(m.binding, binding, now, cx.local.badge)
  })
  if (!due.length || !cx.deps.node.author()) return
  await cx.deps.node.touchProfile()
  for (const id of due) await cx.emit(id, 'profile', () => cx.profileContent(id)).catch(() => {})
}
