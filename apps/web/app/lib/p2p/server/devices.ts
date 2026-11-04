import type { Disowned } from '../acl_room'
import { getEvents } from '../dag'
import { serverWire, type EventRecord } from '../db'
import { signRevocation2, signRotation2 } from '../event'
import { CANT_TEXT, effectHolds, signedAgain } from '../flows'
import { keyId } from '../keys'
import { memberOf } from '../state'
import type { ServerCtx } from './context'
import { ServerError, RESIGN_CONTENT, RESIGN_ACL, type LostRoom } from './types'

// Re-applies our denies the current state doesn't count, each checked again as it is signed;
// those refused are reported with why.
export async function reapplyAll(cx: ServerCtx, room: string) {
  const rt = cx.ensureRt(room)
  const failed: string[] = []
  for (const r of rt.reapply) {
    const to = typeof r.c.to === 'string' ? r.c.to : undefined
    const seen = r.t === 'kick' || r.t === 'ban' || r.t === 'revoke'
    await cx
      .emit(room, r.t, plan => (seen ? { ...r.c, seen: plan.seen ?? {} } : { ...r.c }), {
        to,
      })
      .catch((e: unknown) => failed.push(e instanceof Error ? e.message : String(e)))
  }
  rt.reapply = await cx.reapplyOf(room)
  cx.changed(room)
  if (failed.length)
    throw new ServerError(
      `${failed.length === 1 ? "One couldn't" : `${failed.length} couldn't`} be applied: ${failed[0]}`
    )
}

// Our denies to apply again (spec 9 rule 18); in a new copy, our kicks and bans in the old one
// that its upgrade didn't have in its past too (spec 3.8 step 7: not carried over).
export async function reapplyOf(cx: ServerCtx, room: string) {
  const prev = cx.rooms.get(room)?.prev
  const rt = cx.ensureRt(room)
  const up = prev && cx.rooms.has(prev) ? (rt.upgrade ?? (await cx.upgradeOf(prev, room))) : null
  if (up) rt.upgrade = up
  return cx.host.reapply(
    room,
    cx.me,
    cx.deps.node.lostDevices(),
    prev && up ? { room: prev, up } : undefined
  )
}

// Our devices in the servers we are in, with what the node knows of them.
export function myDevices(cx: ServerCtx) {
  const known = new Map(cx.deps.node.ownDevices().map(d => [d.dk, d]))
  const out = new Map<string, { dk: string; rooms: string[]; label: string; created: number }>()
  for (const room of cx.joinedRooms()) {
    const m = memberOf(cx.sumOf(room), cx.me)
    if (m?.m !== 'join') continue
    for (const dk of m.devs) {
      const d = out.get(dk) ?? {
        dk,
        rooms: [],
        label: known.get(dk)?.label ?? 'Device',
        created: known.get(dk)?.created ?? 0,
      }
      d.rooms.push(room)
      out.set(dk, d)
    }
  }
  return [...out.values()]
}

// Servers we are in and can still change: not read-only, not transferred to a new copy.
export function joinedRooms(cx: ServerCtx) {
  return [...cx.rooms.keys()].filter(room => cx.myMembership(room) === 'join' && !cx.frozen(room))
}

// The ACL events of `room` this replica held by `t`, other than device `dk`'s: a lost device's
// last trusted event is the newest of its own that one of them has in its past (spec 3.9). A
// thief can backdate an event but can't make us hold it, or others cite it, before it exists.
// Also the highest seq of what this browser itself signed with `dk` by `t` (its own outbox: a
// copy of the key can't put events there), when `dk` is an earlier key of this browser.
export async function witnesses(cx: ServerCtx, room: string, dk: string, t: number) {
  const recs = await cx.db.getAllFromIndex(
    'events',
    'room_aseq',
    IDBKeyRange.bound([room, -Infinity], [room, Infinity])
  )
  const ids = recs.filter(r => r.dev !== dk && r.receivedAt <= t).map(r => r.id)
  const sent = (await cx.db.getAllFromIndex('outbox', 'room', room)).filter(o => o.created <= t)
  let own = -1
  for (const r of await getEvents(
    cx.db,
    room,
    sent.map(o => o.id)
  ))
    if (r.dev === dk && r.sender === cx.me && r.dseq !== undefined) own = Math.max(own, r.dseq)
  return { ids, own }
}

// This browser's own events signed with device key `dev` in `room`, in device order.
export async function ownEvents(cx: ServerCtx, room: string, dev: string) {
  const recs = await cx.db.getAllFromIndex(
    'events',
    'room_dseq',
    IDBKeyRange.bound([room, cx.me, -Infinity], [room, cx.me, Infinity])
  )
  return recs
    .filter(r => r.dev === dev && !r.purged)
    .filter(r => (r.layer === 'c' ? RESIGN_CONTENT : RESIGN_ACL).includes(r.type))
}

// This browser's own work with key `dev` that a rotation dropping `dev` would undo, so the new
// key signs it again (spec 3.9): messages that show, and ACL changes whose effect holds (never
// what a moderator redacted, removed or cut, or a change cut or superseded since).
export async function resignable(cx: ServerCtx, room: string, dev: string) {
  const own = await cx.ownEvents(room, dev)
  const counts = await cx.host.counted(
    room,
    own.map(r => r.id)
  )
  const s = cx.sumOf(room)
  return own.filter((r, i) => {
    if (!counts[i]) return false
    if (r.layer === 'c') return true
    const c = (serverWire(r).c ?? {}) as Record<string, unknown>
    return effectHolds(r.type, c, r.id, cx.me, s)
  })
}

// What a lost or stolen device `dk` did after it stopped being ours at `t`, per server (spec
// 8.2): its ACL events after its last trusted one (with when we received each), how many
// messages, who joined through its invites from then on, and what of this browser's own work
// the new key may sign again (when this browser's key came after the trusted point).
export async function lostPreview(cx: ServerCtx, dk: string, t: number): Promise<LostRoom[]> {
  const mine = cx.myDev() ?? ''
  const out: LostRoom[] = []
  for (const room of cx.joinedRooms()) {
    const w = await cx.witnesses(room, dk, t)
    const d = await cx.host.disown(room, cx.me, dk, w.ids, w.own)
    if (!d.live) continue
    const at: Record<string, number> = {}
    for (const r of await getEvents(
      cx.db,
      room,
      d.acts.map(x => x.id)
    ))
      at[r.id] = r.receivedAt
    const own = d.ap && !d.devs.includes(mine) ? await cx.resignable(room, mine) : []
    const resign = own
      .filter(r => r.layer !== 'c')
      .map(r => {
        const to = (serverWire(r).c as { to?: unknown } | null)?.to
        return { id: r.id, t: r.type, ...(typeof to === 'string' ? { to } : {}) }
      })
    const live = memberOf(cx.sumOf(room), cx.me)?.devs ?? []
    const others = d.ap ? live.filter(v => v !== dk && v !== mine && !d.devs.includes(v)) : []
    out.push({ room, ...d, at, resign, others })
  }
  return out
}

// Removes device `dk` from every server and undoes what it signed after its last trusted event
// (spec 3.9). This browser moves to a new device key, which posts a rotation (signed with the
// recovery key) positioned at the last point it trusts. The rotation drops `dk` at that point
// and keeps this browser's old key, which is then revoked on the heads, so this browser's own
// work stands. Where the old key came after that point the rotation can't keep it: what it
// signed is signed again from the new key. Where nothing before the device's changes can be
// trusted (it made the server), it is revoked on the heads: what it did stays, nothing it signs
// later counts. Returns those servers and the ones where it failed, with why.
export async function disownDevice(cx: ServerCtx, dk: string, t: number) {
  const author = await cx.author()
  // A retry after an attempt that changed the key already: that key stays (contacts heard of
  // it; a new one each time is another move for them and another device here), and this
  // browser's key from before that attempt is the one whose work is signed again.
  const again = cx.deps.node.lostDevices().includes(dk)
  const cur = keyId(author.dk.pk)
  const old = again ? (cx.deps.node.movedTo(cur) ?? cur) : cur
  if (dk === old || dk === cur) throw new ServerError(CANT_TEXT)
  const plans = new Map<string, Disowned>()
  const carry = new Map<string, EventRecord[]>()
  for (const room of cx.joinedRooms()) {
    const w = await cx.witnesses(room, dk, t)
    const d = await cx.host.disown(room, cx.me, dk, w.ids, w.own)
    if (!d.live) continue
    plans.set(room, d)
    if (d.ap && !d.devs.includes(old)) carry.set(room, await cx.resignable(room, old))
  }
  // In no server any more: revoked for contacts only, this key stays.
  if (!again && !plans.size) {
    await cx.deps.node.disowned([dk])
    return { late: [], failed: [], unsent: 0 }
  }
  if (!again) {
    await cx.deps.node.rekey({ moved: true, lost: [dk] })
    for (const rt of cx.rts.values()) rt.conflict = false
  }
  const fresh = await cx.author()
  const dev = keyId(fresh.dk.pk)
  const late: string[] = []
  const failed: { room: string; why: string }[] = []
  let unsent = 0
  for (const room of cx.joinedRooms()) {
    const d = plans.get(room)
    try {
      if (d?.ap) {
        const keep = d.devs.filter(v => v !== dk && v !== dev)
        const seen: Record<string, number> = {}
        for (const [v, n] of Object.entries(d.seen)) if (!keep.includes(v) && v !== dev) seen[v] = n
        const c = { pcert: cx.me, keep, seen }
        await cx.emit(
          room,
          'primary_rotate',
          plan => ({
            ik: cx.me,
            ...c,
            rsig: signRotation2(fresh.ik, room, dev, plan.iprev, c),
          }),
          { ap: d.ap }
        )
        // The old key (a move): revoked on the heads, so all it signed stands.
        await cx.refreshMe(room)
        const own = carry.get(room)
        if (own?.length) unsent += await cx.resign(room, own)
        continue
      }
      // The new key introduces itself (and the old one is revoked); `dk` is revoked on the heads.
      await cx.refreshMe(room)
      if (!d) continue
      late.push(room)
      await cx.emit(
        room,
        'device_revoke',
        plan => {
          const seen = plan.seen?.[dk] ?? d.seq
          return { ik: cx.me, dk, seen, rec: signRevocation2(fresh.ik, room, dk, seen) }
        },
        { to: dk }
      )
    } catch (e) {
      failed.push({ room, why: e instanceof Error ? e.message : String(e) })
    }
  }
  return { late, failed, unsent }
}

// Signs our own events again from this device (spec 3.9: `recs`, what `resignable` found before
// a rotation dropped this browser's old key), in their order, where the rotation stopped them
// counting: content hidden by it, ACL changes no longer in force whose effect is gone; ids they
// name that were signed again are mapped. What still counts is left alone.
// Returns how many messages slow mode kept from being sent again.
export async function resign(cx: ServerCtx, room: string, recs: EventRecord[]) {
  let unsent = 0
  const ids = new Map<string, string>()
  const sorted = [...recs].sort((a, b) => (a.dseq ?? 0) - (b.dseq ?? 0))
  const stopped = await cx.host.stopped(
    room,
    sorted.map(r => r.id)
  )
  for (const [i, r] of sorted.entries()) {
    if (!stopped[i]) continue
    const w = serverWire(r)
    if (!w.c) continue
    if (w.ev.L !== 'c' && effectHolds(w.ev.t, w.c, r.id, cx.me, cx.sumOf(room))) continue
    const c = signedAgain(w.c, ids)
    const content = w.ev.L === 'c'
    const to = !content && typeof c.to === 'string' ? c.to : undefined
    const seen = ['kick', 'ban', 'revoke'].includes(w.ev.t)
    // A message goes through the slow-mode check (spec 3.5): one it would hide isn't sent.
    const id = await (
      content
        ? cx.content(room, w.ev.t, c)
        : cx.emit(room, w.ev.t, plan => (seen ? { ...c, seen: plan.seen ?? {} } : c), { to })
    ).catch((e: unknown) => {
      if (content && e instanceof Error && e.message.startsWith('Slow mode')) unsent += 1
      return null
    })
    if (id) ids.set(r.id, id)
  }
  return unsent
}

// Recovery (spec 3.9, 8.2): a rotation signed with the recovery key (the identity key until Task
// 17 splits them) in every server, keeping `keep` and this device; every other device of ours
// is signed out. Copies transferred to a new one are left alone. Returns the servers where it
// failed, with why.
export async function recover(cx: ServerCtx, keep: string[]) {
  const author = await cx.author()
  const dev = keyId(author.dk.pk)
  const failed: { room: string; why: string }[] = []
  // Signed out: not ours any more, so what they did is never offered to re-apply (I2).
  const out = new Set<string>()
  for (const room of cx.joinedRooms()) {
    const live = memberOf(cx.sumOf(room), cx.me)?.devs ?? []
    const kept = keep.filter(v => v !== dev && live.includes(v))
    if (live.every(v => v === dev || kept.includes(v))) continue
    await cx
      .emit(room, 'primary_rotate', plan => {
        const seen: Record<string, number> = {}
        for (const [v, n] of Object.entries(plan.seen ?? {})) if (!kept.includes(v)) seen[v] = n
        const c = { pcert: cx.me, keep: kept, seen }
        return { ik: cx.me, ...c, rsig: signRotation2(author.ik, room, dev, plan.iprev, c) }
      })
      .then(() => {
        for (const v of live) if (v !== dev && !kept.includes(v)) out.add(v)
      })
      .catch((e: unknown) => failed.push({ room, why: e instanceof Error ? e.message : String(e) }))
  }
  if (out.size) await cx.deps.node.disowned([...out])
  return failed
}

// Spec 3.9: this device's history conflicts with another copy of it. It stops signing in the
// server where that shows; set up as a new device (a new key, introduced in every server), the
// copy's voided moderation can be applied again.
export function conflicted(cx: ServerCtx, room: string) {
  const rt = cx.ensureRt(room)
  const dev = cx.myDev()
  if (!dev || rt.conflict) return
  rt.conflict = true
  void cx.updateRoom(room, cur => ({ ...cur, conflict: dev })).catch(() => {})
  cx.changed(room)
}

export async function newDevice(cx: ServerCtx) {
  await cx.deps.node.rekey()
  for (const room of cx.rooms.keys()) {
    const rt = cx.rt(room)
    if (rt) rt.conflict = false
    await cx.refreshMe(room).catch(() => {})
    cx.changed(room)
  }
}
