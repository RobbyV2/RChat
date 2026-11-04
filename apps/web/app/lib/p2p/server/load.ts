import { RULES_VERSION } from '../acl/rules'
import type { ContentEv } from '../acl/visibility'
import {
  applySummary,
  emptySummary,
  fromStored,
  sameSummary,
  SUM_SHAPE,
  toStored,
  type Summary,
} from '../acl/summary'
import { IMPL, trimContent, type AclItem } from '../acl_room'
import { cacheKey, countOf, moveCounts, unindexAll, resetHeld, storedSize } from '../dag'
import { serverWire, type RoomRecord, type ServerCache } from '../db'
import { contentEvOf, headerOk, validate2, type WireV2 } from '../event_v2'
import { cutOut } from '../flows'
import {
  chanFactsOf,
  channelPermsOf,
  channelsOf,
  memberOf,
  membershipOf,
  nameOf,
  P,
} from '../state'
import { indexEstimate } from '../search'
import type { ServerCtx } from './context'
import { heldBare, storeDue } from './storage'
import { JOIN_WAIT, SETTLE_RESAMPLE } from './types'

// A room on start: what the cache says at once (when it is current), while the evaluator
// rebuilds from the stored events and their admission records (no event is decided again
// unless its record is missing).
export async function load(cx: ServerCtx, r: RoomRecord, records = true): Promise<void> {
  const rt = cx.ensureRt(r.id)
  const legacy = async () => {
    if (!r.legacy) await cx.updateRoom(r.id, cur => ({ ...cur, legacy: true }))
    rt.sum = emptySummary()
    cx.changed(r.id)
  }
  if (r.legacy) return legacy()
  // Older builds kept the cache in the room record.
  const kept = ((await cx.db.get('meta', cacheKey(r.id))) as ServerCache | undefined) ?? r.server
  const cached = kept?.impl === IMPL && kept.shape === SUM_SHAPE ? fromStored(kept.sum) : null
  if (cached && records) rt.sum = cached
  // Imported rows: the wire checks first (an import is trusted no more than a peer).
  const g = await cx.db.get('events', r.id)
  const gr = g?.room === r.id ? serverWire(g).c?.rules : undefined
  const rules = typeof gr === 'number' ? gr : RULES_VERSION
  const bad: string[] = []
  const acl: (AclItem & { order: number })[] = []
  const contents: ContentEv[] = []
  const check: { id: string; w: WireV2 }[] = []
  const bodiless: string[] = []
  // Bodies evicted for space: wanted back only when viewed, after a start too.
  const evicted: string[] = []
  const held = new Set<string>()
  const imported: string[] = []
  const bodies = new Map<string, number>()
  let old = false
  // One record at a time: content goes to the evaluator trimmed to what it reads.
  rt.evictFrom.clear()
  rt.migrated = undefined
  const tx = cx.db.transaction('events')
  const range = IDBKeyRange.bound([r.id, -Infinity], [r.id, Infinity])
  for (
    let cur = await tx.store.index('room_seq').openCursor(range);
    cur;
    cur = await cur.continue()
  ) {
    const x = cur.value
    if (x.wire.ev.v === 1) {
      old = true
      break
    }
    held.add(x.id)
    if (x.layer === 'c' && !x.purged && !x.redacted)
      bodies.set(x.sender, (bodies.get(x.sender) ?? 0) + storedSize(x.wire) + indexEstimate(x))
    const w = serverWire(x)
    if (x.imp) {
      imported.push(x.id)
      const v = x.id === r.id ? validate2(w, null) : validate2(w, r.id, rules)
      if (!v.ok || v.id !== x.id) {
        bad.push(x.id)
        continue
      }
    }
    if (x.layer === 'c' || w.ev.L === 'c') {
      if (x.imp) check.push({ id: x.id, w })
      else {
        // Without its body, it keeps its channel and target (the record's).
        const m = contentEvOf(x.id, w)
        if (m.c === null) {
          bodiless.push(x.id)
          if (x.evicted) evicted.push(x.id)
          if (x.chan !== undefined || x.target !== undefined)
            m.c = {
              ...(x.chan !== undefined ? { ch: x.chan } : {}),
              ...(x.target !== undefined ? { target: x.target } : {}),
            }
        }
        contents.push(trimContent(m))
      }
    } else
      acl.push({
        id: x.id,
        w,
        ...(records && x.acl ? { rec: x.acl } : {}),
        order: x.aseq ?? 1e15 + x.seq,
      })
  }
  await tx.done.catch(() => {})
  if (old) return legacy()
  // Dropped events whose header stays (spec 2.3): evidence, restored from their records. A
  // record of an event stored whole (a merged import) goes; an imported header must check out.
  const stale: string[] = []
  const checked: string[] = []
  for (const d of await cx.db.getAllFromIndex('dropped', 'room', r.id)) {
    if (held.has(d.id) || (d.imp && d.hdr && !headerOk(d.id, d.hdr, r.id))) {
      stale.push(d.id)
      continue
    }
    if (d.imp) checked.push(d.id)
    if (d.layer === 'a' && d.hdr)
      acl.push({ id: d.id, w: d.hdr, rec: d.acl, hdr: true, order: d.aseq ?? 1e15 })
  }
  if (stale.length || checked.length) {
    const tx = cx.db.transaction('dropped', 'readwrite')
    for (const id of stale) await tx.store.delete(id)
    for (const id of checked) {
      const d = await tx.store.get(id)
      if (d) {
        const { imp: _i, ...rest } = d
        await tx.store.put(rest)
      }
    }
    await tx.done
  }
  await resetHeld(cx.db, r.id, bodies)
  acl.sort((a, b) => a.order - b.order)
  const run = (async () => {
    const out = await cx.host.load(
      r.id,
      acl.map(({ order: _o, ...it }) => it),
      contents,
      check,
      bodiless,
      evicted
    )
    heldBare(rt, bodiless)
    rt.want.clear()
    rt.views.clear()
    storeDue(rt)
    const before = rt.sum
    rt.sum = applySummary(emptySummary(), out.delta)
    // A wrong restore shows in the state: the cache was written with these same events.
    if (
      records &&
      !out.mismatch &&
      cached &&
      kept?.count === rt.sum.count &&
      !sameSummary(cached, rt.sum)
    ) {
      rt.sum = before
      return cx.load(r, false)
    }
    if (out.fresh.length) {
      const tx = cx.db.transaction('events', 'readwrite')
      for (const f of out.fresh) {
        const e = await tx.store.get(f.id)
        if (e) await tx.store.put({ ...e, aseq: f.aseq, acl: f.rec })
      }
      await tx.done
    }
    await cx.dropRows(r.id, [...bad, ...out.refused])
    // Headers that can't be read any more: only their ids stay.
    if (out.lost.length) {
      const tx = cx.db.transaction('dropped', 'readwrite')
      for (const id of out.lost) {
        const d = await tx.store.get(id)
        if (d) await tx.store.put({ id: d.id, room: d.room, layer: d.layer })
      }
      await tx.done
    }
    if (imported.length) {
      const tx = cx.db.transaction('events', 'readwrite')
      for (const id of imported) {
        const e = await tx.store.get(id)
        if (e?.imp) {
          const { imp: _i, ...rest } = e
          await tx.store.put(rest)
        }
      }
      await tx.done
    }
    await cx.saveCache(r.id)
    await cx.afterState(r.id, before)
  })()
  rt.loading = run.catch(() => {})
  await run
}

// Stored events that turned out not to be admitted (an import): deleted, their space back.
export async function dropRows(cx: ServerCtx, room: string, ids: string[]) {
  if (!ids.length) return
  const tx = cx.db.transaction(['events', 'rooms', 'meta', 'search'], 'readwrite')
  const events = tx.objectStore('events')
  let n = 0
  let acl = 0
  let bytes = 0
  // Out of the index first, while everything is still stored.
  bytes += await unindexAll(tx.objectStore('search'), events, null, room, ids)
  for (const id of ids) {
    const e = await events.get(id)
    if (!e || e.room !== room) continue
    await events.delete(id)
    const k = countOf(e)
    n += k.n
    acl += k.acl
    bytes += storedSize(e.wire)
  }
  const rec = await tx.objectStore('rooms').get(room)
  if (rec)
    await tx
      .objectStore('rooms')
      .put(await moveCounts(tx.objectStore('meta'), rec, { n: -n, acl: -acl, bytes: -bytes }))
  await tx.done
}

export async function saveCache(cx: ServerCtx, room: string) {
  const sum = cx.sumOf(room)
  const cache: ServerCache = {
    impl: IMPL,
    shape: SUM_SHAPE,
    rules: sum.rules,
    count: sum.count,
    sum: toStored(sum),
  }
  await cx.db.put('meta', cache, cacheKey(room))
  const n = nameOf(sum)?.name
  const r = cx.rooms.get(room)
  if (r && (r.server || (n && n !== r.name)))
    await cx.updateRoom(room, cur => ({ ...cur, server: null, ...(n ? { name: n } : {}) }))
}

// What a state change means here: we were let in, or put out.
export async function afterState(cx: ServerCtx, room: string, before: Summary, changed?: string[]) {
  const was = membershipOf(before, cx.me)
  const now = cx.myMembership(room)
  const r = cx.rooms.get(room)
  cx.maybeJoin(room)
  const rt = cx.ensureRt(room)
  storeDue(rt)
  rt.views.clear()
  // A channel we may view now that we couldn't (spec 3.7): what peers held back can come.
  const seen = (s: Summary) => {
    const F = chanFactsOf(s)
    return channelsOf(s).filter(c => channelPermsOf(s, cx.me, c.id, F) & P.ViewChannel)
  }
  const had = new Set(seen(before).map(c => c.id))
  const opened = seen(cx.sumOf(room)).filter(c => !had.has(c.id))
  if (now === 'join' && opened.length) cx.sync.retryGaps(room)
  // Its history that comes now isn't new to us: counted from here (stored).
  if (now === 'join' && was === 'join' && opened.length) {
    const at = cx.clock.now()
    await cx.updateRoom(room, cur => {
      const viewFrom = Object.assign(Object.create(null) as Record<string, number>, cur.viewFrom)
      for (const c of opened) viewFrom[c.id] = at
      return { ...cur, viewFrom }
    })
  }
  // In once a join of ours from after we set out is (not an old one the backfill brings
  // first); our own join clears it in postJoin.
  const mine = memberOf(cx.sumOf(room), cx.me)
  if (now === 'join' && r?.joining && (mine?.joinTs ?? 0) > r.joining.at)
    await cx.updateRoom(room, cur => ({
      ...cur,
      joining: null,
      since: cur.since ?? cx.clock.now(),
    }))
  // We are in now: everything the gates held back may come.
  if (now === 'join' && was !== 'join') cx.sync.loadOlder(room)
  // A new copy (spec 3.8): links are drawn again soon, once we know more of who is in.
  if (now === 'join' && was !== 'join' && r?.prev)
    for (const ms of SETTLE_RESAMPLE) cx.clock.set(() => cx.gossip.resample(), ms)
  // Out without a removal of our own (a cascade took our join, spec 3.1): we keep syncing the
  // ACL with members, and join again by ourselves if someone invites us again (spec 8.2).
  if (
    was === 'join' &&
    now === 'leave' &&
    !mine?.rem &&
    r &&
    !r.cascade &&
    cutOut(cx.sumOf(room), cx.me, cx.clock.now())
  )
    await cx.updateRoom(room, cur => ({ ...cur, cascade: cx.clock.now() }))
  // Only after a cascade this device saw and recently: any other invite waits for the user.
  const lost = cx.rooms.get(room)
  if (
    now === 'invite' &&
    was !== 'invite' &&
    lost &&
    !lost.joining &&
    !lost.invite &&
    cx.lostByCascade(lost)
  ) {
    await cx.updateRoom(room, cur => ({
      ...cur,
      cascade: null,
      joining: { at: cx.clock.now(), via: 'invite' },
    }))
    cx.ensureRt(room).joinPosted = false
    cx.maybeJoin(room)
  }
  if (now === 'join' && r?.cascade) await cx.updateRoom(room, cur => ({ ...cur, cascade: null }))
  // Spec 3.8: an upgrade is followed; roles go to members who joined the new copy. What we
  // hold of the old copy then is its archive.
  if (cx.sumOf(room).upgraded && !cx.rooms.get(room)?.archive) await cx.markArchive(room)
  if (cx.sumOf(room).upgrades?.length) void cx.follow(room).catch(() => {})
  if (r?.carry) void cx.carryRoles(room).catch(() => {})
  if (r?.carry && r.carry.state !== 'done' && r.carry.state !== 'failed')
    void cx.carryOver(room).catch(() => {})
  if (r?.prev) {
    await cx.checkMigrated(room, r.prev)
    cx.ackCarry(room, rt)
  }
  // Spec 3.9: evidence against this device stops it signing here.
  const dev = cx.myDev()
  if (dev && cx.sumOf(room).forks?.includes(dev)) cx.conflicted(room)
  // Spec 9 rule 18 (I2): our denies the state doesn't count that we may still make.
  rt.reapply = now === 'join' && !cx.frozen(room) ? await cx.reapplyOf(room) : []
  // A change in an old copy can be one of ours the new copy didn't get (spec 3.8 step 7).
  const nx = cx.rooms.get(room)?.next
  if (nx && cx.rooms.has(nx) && cx.myMembership(nx) === 'join' && !cx.frozen(nx)) {
    cx.ensureRt(nx).reapply = await cx.reapplyOf(nx)
    cx.changed(nx)
  }
  cx.sync.announce(room)
  if (was === 'join' && now !== 'join') {
    cx.gossip.leave(room)
    cx.voice.forget(room)
    cx.ensureRt(room).joinPosted = false
  }
  cx.checkVoice(room)
  // Those someone else removed hear it from us.
  const s = cx.sumOf(room)
  for (const ik of changed ?? Object.keys(s.members)) {
    const m = s.members[ik]
    if (
      m &&
      (m.m === 'leave' || m.m === 'ban') &&
      m.by !== ik &&
      before.members[ik]?.m !== m.m &&
      ik !== cx.me
    )
      for (const sess of cx.deps.node.readySessions(ik)) cx.tellRemoved(sess, room)
  }
  cx.gossip.tick()
  cx.changed(room)
}

// Invited while on our way in: we join once the invite is in the state we hold.
export function maybeJoin(cx: ServerCtx, room: string) {
  const r = cx.rooms.get(room)
  if (cx.myMembership(room) !== 'invite' || !r?.joining) return
  // Not while ACL events we know of are still missing, for at most JOIN_WAIT.
  if (cx.rt(room)?.waits.size && cx.clock.now() - r.joining.at < JOIN_WAIT) return
  void cx.postJoin(room).catch(() => {})
}
