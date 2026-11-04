import { gt } from '../acl/rules'
import { cacheKey, countOf, moveCounts, storedSize } from '../dag'
import { CANT_TEXT } from '../flows'
import {
  can,
  channelPermsOf,
  channelsOf,
  LIMITS as STATE_LIMITS,
  membershipOf,
  P,
  rankOf,
  roleRank,
} from '../state'
import { unindexRoom } from '../search'
import type { ServerCtx } from './context'
import { ServerError, ROLE_NAME_MAX, NO_ROOM_TEXT, newRolePos } from './types'
import { clip } from '../rate'

// A new role goes to the bottom of the list.
export async function createRole(
  cx: ServerCtx,
  room: string,
  role: { name: string; color: number | null; bits: number }
) {
  const s = cx.sumOf(room)
  const me = rankOf(s, cx.me)
  const pos = newRolePos(
    Object.values(s.roles).map(r => r.pos),
    me[0] === Infinity ? Infinity : me[0]
  )
  if (pos === null) throw new ServerError(NO_ROOM_TEXT)
  const name = clip(role.name.trim(), ROLE_NAME_MAX)
  return cx.emit(room, 'role_create', () => ({
    pos,
    bits: role.bits,
    ...(name ? { name } : {}),
    ...(role.color !== null ? { color: role.color } : {}),
  }))
}

// A role's name and color (spec 1.4 `role_meta`).
export async function editRole(
  cx: ServerCtx,
  room: string,
  role: string,
  meta: { name: string; color: number | null }
) {
  // Admitted by the generic rule (spec 1.4): one we may not make would show nothing.
  const s = cx.sumOf(room)
  if (!can(s, cx.me, P.ManageRoles) || !s.roles[role] || !gt(rankOf(s, cx.me), roleRank(s, role)))
    throw new ServerError(CANT_TEXT)
  const name = clip(meta.name.trim(), ROLE_NAME_MAX)
  return cx.emit(room, 'role_meta', () => ({
    role,
    ...(name ? { name } : {}),
    ...(meta.color !== null ? { color: meta.color } : {}),
  }))
}

export function moveRole(cx: ServerCtx, room: string, role: string, pos: number) {
  return cx.emit(room, 'role_move', () => ({ role, pos }))
}

// `role` may be `everyone`.
export function setRoleBit(cx: ServerCtx, room: string, role: string, bit: number, on: boolean) {
  return cx.emit(room, 'role_bits', () => ({ role, bit, on }))
}

export function deleteRole(cx: ServerCtx, room: string, role: string) {
  return cx.emit(room, 'role_del', () => ({ role }))
}

export function assignRole(cx: ServerCtx, room: string, ik: string, role: string) {
  return cx.emit(room, 'assign', () => ({ to: ik, role }))
}

// Taking a role from someone else carries the watermark of a removal (spec 3.5).
export function revokeRole(cx: ServerCtx, room: string, ik: string, role: string) {
  if (ik === cx.me) return cx.emit(room, 'revoke', () => ({ to: ik, role }))
  return cx.emit(room, 'revoke', plan => ({ to: ik, role, seen: plan.seen ?? {} }), { to: ik })
}

// How long until we may post in `ch` again (slow mode, spec 3.5): 0 when it's off or leaves us
// out.
export async function slowLeft(cx: ServerCtx, room: string, ch: string) {
  const s = cx.sumOf(room)
  const c = channelsOf(s).find(x => x.id === ch)
  if (!c?.slow || channelPermsOf(s, cx.me, ch) & (P.ManageChannels | P.ManageMessages)) return 0
  const last = await cx.host.lastSent(room, cx.me, ch)
  return last === null ? 0 : Math.max(0, last + c.slow * 1000 - cx.clock.now())
}

// Kicking someone invited withdraws the invite.
export function kick(cx: ServerCtx, room: string, ik: string) {
  if (membershipOf(cx.sumOf(room), ik) === 'invite')
    return cx.emit(room, 'uninvite', () => ({ to: ik }))
  return cx.emit(room, 'kick', plan => ({ to: ik, seen: plan.seen ?? {} }), { to: ik })
}

// `wipe`: "Also hide all their messages" (spec 3.5, needs Manage messages).
export function ban(cx: ServerCtx, room: string, ik: string, reason?: string, wipe = false) {
  return cx.emit(
    room,
    'ban',
    plan => ({
      to: ik,
      seen: plan.seen ?? {},
      ...(reason ? { reason: reason.slice(0, STATE_LIMITS.reason) } : {}),
      ...(wipe ? { wipe: true } : {}),
    }),
    { to: ik }
  )
}

export function unban(cx: ServerCtx, room: string, ik: string) {
  return cx.emit(room, 'unban', () => ({ to: ik }))
}

export async function leave(cx: ServerCtx, room: string) {
  const m = cx.myMembership(room)
  if (m === 'join') await cx.emit(room, 'leave', plan => ({ seen: plan.seen ?? {} }))
  else cx.gossip.leave(room)
  await cx.updateRoom(room, cur => ({ ...cur, joining: null }))
  cx.changed(room)
}

// Removes a server we are not in any more from this device. Our device's chain there is kept,
// so if we join again we go on from it (starting over would fork it).
export async function forget(cx: ServerCtx, room: string) {
  const m = cx.myMembership(room)
  if ((m === 'join' || m === 'invite') && !cx.readOnly(room))
    throw new ServerError('Leave the server first')
  cx.gossip.leave(room)
  for (const l of cx.sync.linksOf(room)) cx.sync.unlink(l.session, room)
  const tx = cx.db.transaction(
    ['rooms', 'events', 'children', 'outbox', 'codes', 'meta', 'search', 'dropped'],
    'readwrite'
  )
  const events = tx.objectStore('events')
  let n = 0
  let acl = 0
  let bytes = await unindexRoom(tx.objectStore('search'), room)
  const files = new Set<string>()
  let cursor = await events
    .index('room_seq')
    .openCursor(IDBKeyRange.bound([room, -Infinity], [room, Infinity]))
  while (cursor) {
    const r = cursor.value
    for (const p of (r.wire.ev as { prev?: string[] }).prev ?? [])
      await tx.objectStore('children').delete([p, r.id])
    const k = countOf(r)
    n += k.n
    acl += k.acl
    bytes += storedSize(r.wire)
    for (const h of r.atts ?? []) files.add(h)
    await cursor.delete()
    cursor = await cursor.continue()
  }
  for (const o of await tx.objectStore('outbox').index('room').getAll(room))
    await tx.objectStore('outbox').delete(o.id)
  for (const k of await tx.objectStore('codes').index('room').getAllKeys(room))
    await tx.objectStore('codes').delete(k)
  for (const k of await tx.objectStore('dropped').index('room').getAllKeys(room))
    await tx.objectStore('dropped').delete(k)
  const meta = tx.objectStore('meta')
  // Its per-sender counters and cache; this device's chains stay (spec 3.9).
  for (const lo of [`held\n${room}\n`, `share\n${room}\n`])
    await meta.delete(IDBKeyRange.bound(lo, `${lo}\uffff`))
  await meta.delete(cacheKey(room))
  const rec = await tx.objectStore('rooms').get(room)
  if (rec) await moveCounts(meta, rec, { n: -n, acl: -acl, bytes: -bytes })
  await tx.objectStore('rooms').delete(room)
  await tx.done
  cx.rooms.delete(room)
  cx.rts.delete(room)
  cx.host.drop(room)
  // Downloaded files no other message here carries go too; files we sent stay.
  if (files.size) await cx.deps.dms.blobs.release([...files], undefined, true).catch(() => {})
  cx.changed(room)
}
