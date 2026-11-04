import { signDeviceCert2 } from '../acl/binding'
import { RULES_VERSION } from '../acl/rules'
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
import { signRevocation2, headerOk, type WireV2 } from '../event'
import { VOUCH_WAIT_TEXT } from '../flows'
import { memberBindingDue } from '../badge'
import { keyId } from '../keys'
import { memberOf } from '../state'
import { MOVED_TEXT } from '../dm'
import type { ServerCtx } from './context'
import { SERVER, ServerError, sizeOfWire } from './types'
import { type Rt } from './rt'

// Storage work is due: the state or the held content changed.
export const storeDue = (rt: Rt) => {
  rt.storeDirty = true
}

// The content a cold start found held without its body.
export const heldBare = (rt: Rt, ids: Iterable<string>) => {
  rt.bodiless = new Set(ids)
}

// A tick's storage work in room `r`: a storage pass when due (spec 2.3, 4.2, 4.3), bodies still
// wanted asked for again while some are, proofs, and the mark acknowledging a redaction.
export function tick(cx: ServerCtx, r: RoomRecord, rt: Rt, now: number) {
  const every = Object.keys(r.causes ?? {}).length ? SERVER.causesMs : Infinity
  if ((rt.storeDirty && now - rt.storeAt >= SERVER.storeMs) || now - rt.storeAt >= every) {
    rt.storeDirty = false
    rt.storeAt = now
    void cx.locked(r.id, () => cx.storePass(r.id)).catch(() => {})
  }
  if ((rt.want.size || rt.viewed.size) && now - rt.wantAt >= SERVER.causesMs) {
    rt.wantAt = now
    void cx.locked(r.id, () => cx.wantPass(r.id)).catch(() => {})
  }
  if (rt.proofs.size) cx.postProofs(r.id, rt, now)
  if (rt.ackDue !== null && rt.ackDue <= now) cx.ackRedactions(r.id, rt, now)
}

// What the state and the held content let storage do now: drop what the ACL core names, purge
// bodies whose cause is stable, ask for bodies that show again, and look for proofs to post.
export async function storePass(cx: ServerCtx, room: string) {
  if (!cx.rooms.has(room) || cx.sumOf(room).rules !== RULES_VERSION) return
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
    freed = await dropServer(cx.db, room, d)
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

// Spec 4.3: a hidden body goes when its cause is stable (S1 to S4; S4 is the time it has stood
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
    c.kind === 'self' || (c.stable && (pressure || now - causes[c.id] >= SERVER.purgeAfter))
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
  const { done, freed, mine } = await purgeServer(cx.db, room, ids, cx.me, evict)
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
  const rec = await restoreIn(cx.db, room, id, w, cx.clock.now())
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

// Proofs (spec 2.3, 4.1): evidence that lowers a device's fork point below an ACL event of it
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
    rt.proofs.set(c.dev, { f: c.f, due: now + Math.floor(rand() * SERVER.proofDelayMs) })
  }
}

export function postProofs(cx: ServerCtx, room: string, rt: Rt, now: number) {
  rt.proofTimes = rt.proofTimes.filter(t => now - t < 60 * 60_000)
  for (const [dev, q] of rt.proofs) {
    if (q.due > now) continue
    if (rt.proofTimes.length >= SERVER.proofsPerHour) return
    rt.proofs.delete(dev)
    rt.proofTimes.push(now)
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
// acknowledged (spec 4.3 S2), at most one per room per SERVER.ackMs, and only while some
// redaction still needs it (ackRedactions).
export function noteRedaction(cx: ServerCtx, room: string) {
  const rt = cx.ensureRt(room)
  if (rt.ackDue !== null) return
  const rand = cx.deps.random ?? Math.random
  const at = cx.clock.now() + Math.floor(rand() * SERVER.ackDelayMs)
  rt.ackDue = Math.max(at, rt.ackAt + SERVER.ackMs)
}

// Controller ruling: a mark only names redactions not yet acknowledged that can still be
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

// Out of space (spec 4.2): purgeable bodies go first, then hidden ones that can be fetched
// again, then the oldest bodies of the sender whose bodies take the most here (`total`: in
// every server), until `size` more bytes fit, at least SERVER.evictBytes. Bodies fetched back
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
  const need = restore ? size : Math.max(size, SERVER.evictBytes)
  let late: { room: string; ids: string[] } | null = null
  for (const c of await evictionOrder(cx.db, total ? null : room, cx.me)) {
    const starts = cx.ensureRt(c.room).evictFrom
    const walk = (from?: string) =>
      oldestBodies(cx.db, c.room, c.ik, need, now, 500, {
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
    // Spec 9 rule 14: the join waits for a third member's acknowledgement (shown, retried).
    const wait = e instanceof ServerError && e.message === VOUCH_WAIT_TEXT ? e.message : null
    if (wait !== rt.joinWait) {
      rt.joinWait = wait
      cx.changed(room)
    }
    throw e
  }
}

// A join that introduces this device carries its certificate (spec 1.1), signed by the
// identity key (it plays primary until Task 17), and the v1 certificate and profile peers use
// to reach and name us.
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
  // Spec 3.9: a move or import makes a new device; the one it moved from is revoked with the
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
  const name = cx.deps.node.name
  if (m.profile && m.profile.name !== name)
    await cx.emit(room, 'profile', () => cx.profileContent())
}

export function profileContent(cx: ServerCtx) {
  const c: Record<string, unknown> = { name: cx.deps.node.name }
  const binding = cx.deps.node.binding
  if (binding) c.binding = binding
  return c
}

// Our account badge was turned on or renewed: once it is due (badge.ts) every server where it
// is gets a profile write with it.
export async function refreshBadge(cx: ServerCtx) {
  const binding = cx.deps.node.binding
  const now = cx.clock.now()
  const due = [...cx.rooms.keys()].filter(id => {
    const m = memberOf(cx.sumOf(id), cx.me)
    return m?.m === 'join' && memberBindingDue(m.binding, binding, now)
  })
  if (!due.length || !cx.deps.node.author()) return
  await cx.deps.node.touchProfile()
  for (const id of due) await cx.emit(id, 'profile', () => cx.profileContent()).catch(() => {})
}
