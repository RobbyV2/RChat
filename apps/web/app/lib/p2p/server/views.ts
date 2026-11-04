import { gt, restricts, type Rank } from '../acl/rules'
import type { Summary } from '../acl/summary'
import type { Shown } from '../acl_room'
import { DAG, getEvents } from '../dag'
import { serverWire, type EventRecord, type OutboxRecord, type RoomRecord } from '../db'
import { reactionsOf, PINS_MAX, type P2pMessage } from '../dm'
import { around, type PageOpts } from '../jump'
import { LIMITS as EV, type MsgContent } from '../event'
import { LOCAL } from '../limits'
import {
  can,
  chanFactsOf,
  channelPermsOf,
  channelsOf,
  historyOf,
  memberOf,
  membershipOf,
  membersOf,
  nameOf,
  P,
  permsOf,
  roleRank,
  rolesOf,
  systemOf,
  topRoleOf,
  type Membership,
} from '../state'
import type { ServerCtx } from './context'
import {
  SERVER,
  systemRow,
  placeholder,
  roleName,
  sortRoles,
  type MemberView,
  type ChannelView,
  type Rt,
  type ServerView,
} from './types'

// The read-only part of a room's runtime record a view reads.
export type RtView = Pick<
  Rt,
  'mods' | 'reached' | 'reapply' | 'joinWait' | 'conflict' | 'migrateDiff' | 'waits'
>

// What else a server's view reads, from the facade, each when the view first needs it: our
// identity, who is online, members' names and contact state, who is trying to join (linked with
// us or redeeming a code with us), and the room's read-only, voice and sync state.
export interface ViewEnv {
  me: string
  online(): Set<string>
  name(ik: string): string
  contact(ik: string): boolean
  trying(ik: string): boolean
  readOnly(): ServerView['readOnly']
  frozen(): boolean
  voice(): ServerView['voice']
  syncing(): boolean
}

export function view(cx: ServerCtx, room: string): ServerView | null {
  const r = cx.rooms.get(room)
  if (!r) return null
  return serverView(room, r, cx.sumOf(room), cx.rt(room), {
    me: cx.me,
    online: () => cx.gossip.online(room),
    name: ik => cx.nameOf(ik, room),
    contact: ik => cx.deps.node.contact(ik)?.state === 'mutual',
    trying: ik => cx.redeeming(room, ik) || cx.sync.linksOf(room).some(l => l.ik === ik),
    readOnly: () => cx.readOnly(room),
    frozen: () => cx.frozen(room),
    voice: () => cx.voice.channels(room),
    syncing: () => !!cx.sync.pullingState(room),
  })
}

// A server's view: a pure function of its room record, summary and runtime record.
export function serverView(
  room: string,
  r: RoomRecord,
  s: Summary,
  rt: RtView | null,
  env: ViewEnv
): ServerView {
  const online = env.online()
  const owners = s.owners
  const meRank = memberOf(s, env.me)?.rank
  const banner = membershipOf(s, env.me) === 'join' && can(s, env.me, P.Ban)
  const order = rolesOf(s)
  const at = new Map(order.map((r, i) => [r.id, i]))
  const members: MemberView[] = membersOf(s)
    .filter(m => m.m === 'join' || m.m === 'invite' || m.m === 'ban')
    .map(m => ({
      ik: m.ik,
      m: m.m,
      name: env.name(m.ik),
      owner: owners.includes(m.ik),
      online: m.m === 'join' && online.has(m.ik),
      contact: env.contact(m.ik),
      below: !!meRank && gt(meRank, m.rank as Rank),
      // Waiting for a third member only while they are trying to join: linked with us, or
      // redeeming a code with us.
      waits: m.m === 'invite' && m.waits === true && env.trying(m.ik),
      myInvite: m.m === 'invite' && !!m.inviters?.length && m.inviters.every(x => x === env.me),
      unban: m.m === 'ban' && banner && !!meRank && (!m.banRank || !gt(m.banRank, meRank)),
      roles: m.m === 'join' ? sortRoles(m.roles, at) : [],
      top: m.m === 'join' ? topRoleOf(s, m.ik) : null,
    }))
  const joined = members.filter(m => m.m === 'join')
  const n = nameOf(s)
  const readOnly = env.readOnly()
  const me = readOnly ? null : membershipOf(s, env.me)
  return {
    id: room,
    name: n?.name ?? r.name ?? 'P2P server',
    color: n?.color ?? null,
    me,
    joining: !!r.joining,
    owner: s.creator,
    owners,
    perms: me === 'join' ? permsOf(s, env.me) : 0,
    rank: meRank ?? [-Infinity, ''],
    history: historyOf(s),
    system: systemOf(s),
    channels: readOnly ? [] : channelViews(s, env.me, me),
    roles: readOnly
      ? []
      : order.map(r => ({
          id: r.id,
          name: roleName(r.name),
          color:
            Number.isSafeInteger(r.color) && r.color! >= 0 && r.color! <= 0xffffff
              ? r.color!
              : null,
          pos: r.pos,
          bits: r.bits,
          holders: joined.filter(m => m.roles.includes(r.id)).length,
          below: me === 'join' && !!meRank && gt(meRank, roleRank(s, r.id)),
          held: restricts(chanFactsOf(s), r.id),
        })),
    everyone: s.everyone,
    members: readOnly ? [] : members,
    online: joined.filter(m => m.online).length,
    joined: joined.length,
    chans: r.chans ?? {},
    seq: r.lastSeq,
    gap: r.missing.length > 0 || (rt?.waits.size ?? 0) > 0,
    full: r.full,
    readOnly,
    voice: env.frozen() || me !== 'join' ? {} : env.voice(),
    mods: (rt?.mods ?? []).map(x => ({ id: x.id, act: x.act, who: x.who })),
    reached: (rt?.reached ?? []).map(x => ({ by: x.by, lost: [...x.lost] })),
    reapply: readOnly ? [] : (rt?.reapply ?? []),
    joinWait: rt?.joinWait ?? null,
    conflict: rt?.conflict ?? false,
    syncing: env.syncing() ? s.count : null,
    upgraded: s.upgraded,
    disputed: (s.upgrades?.length ?? 0) > 1,
    next: r.next ?? null,
    prev: r.prev ?? null,
    carry:
      r.carry && r.carry.state !== 'done'
        ? { state: r.carry.state, why: r.carry.why ?? null }
        : null,
    migrateDiff: rt?.migrateDiff ?? null,
  }
}

// The channels we may view, with what we may do there.
export function channelViews(s: Summary, myIk: string, me: Membership | null): ChannelView[] {
  const F = chanFactsOf(s)
  const out: ChannelView[] = []
  for (const c of channelsOf(s)) {
    const p = channelPermsOf(s, myIk, c.id, F)
    if (!(p & P.ViewChannel)) continue
    out.push({
      ...c,
      send: me === 'join' && (p & P.SendMessages) !== 0,
      exempt: (p & (P.ManageChannels | P.ManageMessages)) !== 0,
      over: s.overwrites?.[c.id] ?? {},
    })
  }
  return out
}

// Whether we may view `ch` (spec 1.4).
export function canViewCh(cx: ServerCtx, room: string, ch: string) {
  const s = cx.sumOf(room)
  return (channelPermsOf(s, cx.me, ch) & P.ViewChannel) !== 0
}

export function online(cx: ServerCtx, room: string) {
  return cx.sync.online(room)
}

export function pulling(cx: ServerCtx, room: string) {
  return cx.sync.pulling(room)
}

// Messages of a channel, oldest first, with join and leave lines in the system channel (the
// page bounds as in dm.ts loadMessages).
export async function loadChannel(
  cx: ServerCtx,
  room: string,
  ch: string,
  opts: PageOpts & { keep?: (r: EventRecord) => boolean } = {}
): Promise<{ messages: P2pMessage[]; more: boolean }> {
  const limit = opts.limit ?? 100
  if (cx.readOnly(room)) return { messages: [], more: false }
  if (!opts.keep && !cx.canViewCh(room, ch)) return { messages: [], more: false }
  // A transferred copy shows only its archive (spec 3.8 step 6), opened by itself too.
  if (!opts.keep && cx.sumOf(room).upgraded) {
    const keep = await cx.archiveKeep(room, cx.rooms.get(room)?.next)
    if (keep) opts = { ...opts, keep }
  }
  const up = opts.newer === true
  const range = IDBKeyRange.bound(
    [room, ch, opts.after ?? opts.from ?? ''],
    [room, ch, opts.before ?? '￿'],
    !!opts.after,
    !!opts.before
  )
  const recs: EventRecord[] = []
  const pins: EventRecord[] = []
  const store = cx.db.transaction('events').store
  const roots = new Map<string, Promise<EventRecord | undefined>>()
  const get = (id: string) => {
    let r = roots.get(id)
    if (!r) roots.set(id, (r = store.get(id)))
    return r
  }
  let cursor = await store.index('room_chan_sort').openCursor(range, up ? 'next' : 'prev')
  while (cursor && recs.length < limit + 1) {
    const r = cursor.value
    // Thread replies show in their thread only; an archive (spec 3.8) only what `keep` keeps,
    // without its pin lines.
    if (r.type === 'msg' && !(await cx.rootOf(r, get)) && (!opts.keep || opts.keep(r))) recs.push(r)
    else if (r.type === 'pin' && !opts.keep) pins.push(r)
    cursor = await cursor.continue()
  }
  const more = recs.length > limit
  const page = up ? recs.slice(0, limit) : recs.slice(0, limit).reverse()
  const rows = await cx.withReplies(room, ch, await cx.rows(room, page))
  const lo = more && !up ? page[0]?.sortKey : (opts.after ?? opts.from)
  const hi = more && up ? recs[limit].sortKey : opts.before
  const pinRows = await cx.pinRows(
    room,
    pins.filter(p => (lo === undefined || p.sortKey > lo) && (hi === undefined || p.sortKey < hi))
  )
  rows.push(...pinRows)
  const sys = systemOf(cx.sumOf(room))
  // An archive (spec 3.8) brings no join and leave lines of the old copy.
  if (sys.ch === ch && (sys.join || sys.leave) && !opts.keep)
    rows.push(...(await cx.systemRows(room, lo, hi, sys)))
  rows.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0))
  // Spec 3.8: a new copy shows the old copy's messages of the same channel above its own, as
  // they are there (read-only).
  const prev = cx.rooms.get(room)?.prev
  const keep = prev && cx.rooms.has(prev) ? await cx.archiveKeep(prev, room) : null
  if (prev && keep && !up && !more && !opts.after && page.length < limit) {
    const before = page[0]?.sortKey ?? opts.before
    const old = await cx.loadChannel(prev, ch, { before, limit: limit - page.length, keep })
    return {
      messages: [...old.messages.map(m => ({ ...m, archived: true })), ...rows],
      more: old.more,
    }
  }
  return { messages: rows, more }
}

// What an old copy shows after its transfer (spec 3.8 step 6): each device's messages up to
// its last one at the transfer, by what the new owner carried over or, at the latest, what we
// held when we heard of the upgrade (the new owner's holdings are partial: history, backfill
// horizon, channels it can't view), and nothing by someone banned in the new copy. Null before
// either is known.
export async function archiveKeep(cx: ServerCtx, old: string, next?: string) {
  const local = cx.rooms.get(old)?.archive
  const migrated = next ? await cx.migratedOf(next) : null
  if (!local && !migrated) return null
  const s = next ? cx.sumOf(next) : null
  const mark = (m: Record<string, number> | undefined, dev: string) =>
    m && Object.hasOwn(m, dev) ? m[dev] : -1
  return (r: EventRecord) =>
    r.dev !== undefined &&
    r.dseq !== undefined &&
    r.dseq <= Math.max(mark(migrated?.marks, r.dev), mark(local, r.dev)) &&
    (!s || membershipOf(s, r.sender) !== 'ban')
}

// Each device's last message we hold in a copy, when we first hear it was transferred: what
// comes later at positions from before the upgrade never shows (spec 3.8 step 6).
export async function markArchive(cx: ServerCtx, room: string) {
  const archive = Object.create(null) as Record<string, number>
  const range = IDBKeyRange.bound([room, -Infinity], [room, Infinity])
  const tx = cx.db.transaction('events')
  for (
    let cur = await tx.store.index('room_seq').openCursor(range);
    cur;
    cur = await cur.continue()
  ) {
    const r = cur.value
    if (r.layer === 'c' && r.dev && r.dseq !== undefined)
      archive[r.dev] = Math.max(Object.hasOwn(archive, r.dev) ? archive[r.dev] : -1, r.dseq)
  }
  await tx.done.catch(() => {})
  await cx.updateRoom(room, cur => (cur.archive ? cur : { ...cur, archive }))
}

// "{name} pinned a message to this channel.": a pin that shows, by someone with Manage messages
// where it was posted, of a top-level message (a link to it while it shows).
export async function pinRows(cx: ServerCtx, room: string, pins: EventRecord[]) {
  const on = pins.filter(p => (serverWire(p).c as { on?: unknown } | null)?.on === true)
  if (!on.length) return []
  const shown = await cx.host.display(
    room,
    on.map(p => p.id)
  )
  const ok = on.filter((_p, i) => shown[i] && !shown[i]?.hidden && shown[i]?.pins === true)
  const targets = await getEvents(
    cx.db,
    room,
    ok.flatMap(p => (p.target ? [p.target] : []))
  )
  const byId = new Map(targets.map(t => [t.id, t]))
  const top = new Set<string>()
  for (const t of targets) if (!(await cx.rootOf(t))) top.add(t.id)
  const live = targets.filter(t => t.type === 'msg' && top.has(t.id) && !t.redacted)
  const vis = await cx.host.display(
    room,
    live.map(t => t.id)
  )
  const showing = new Set(live.filter((_t, i) => vis[i] && !vis[i]?.hidden).map(t => t.id))
  const out: P2pMessage[] = []
  for (const p of ok) {
    const t = p.target ? byId.get(p.target) : undefined
    if (t && (!top.has(t.id) || t.chan !== p.chan)) continue
    out.push({
      ...systemRow(p, p.sender),
      system: {
        kind: 'pin',
        ik: p.sender,
        target: t && showing.has(t.id) ? t.id : null,
      },
    })
  }
  return out
}

// Top-level rows of channel `ch` with their thread's reply count and last reply time (replies
// in the same channel that show).
export async function withReplies(cx: ServerCtx, room: string, ch: string, rows: P2pMessage[]) {
  const roots = rows.filter(m => !m.thread && !m.noThread && !m.system)
  if (!roots.length) return rows
  const ix = cx.db.transaction('events').store.index('room_thread_sort')
  const lists = await Promise.all(
    roots.map(m => ix.getAll(IDBKeyRange.bound([room, m.id, ''], [room, m.id, '￿'])))
  )
  const replies = new Map<string, EventRecord[]>()
  roots.forEach((m, i) => {
    if (lists[i].length) replies.set(m.id, lists[i])
  })
  if (!replies.size) return rows
  const all = [...replies.values()].flat().filter(r => r.type === 'msg' && r.chan === ch)
  const shown = await cx.host.display(
    room,
    all.map(r => r.id)
  )
  const vis = new Set(all.filter((_r, i) => shown[i] && !shown[i]?.hidden).map(r => r.id))
  return rows.map(m => {
    const list = replies.get(m.id)?.filter(r => vis.has(r.id) && !r.redacted)
    if (!list?.length) return m
    return { ...m, replies: list.length, lastReply: list[list.length - 1].effTs }
  })
}

// A thread: its root and replies, oldest first, `limit` at most before `before`.
export async function loadThread(
  cx: ServerCtx,
  room: string,
  root: string,
  opts: { before?: string; after?: string; limit?: number } = {}
) {
  const limit = opts.limit ?? 100
  const r = await cx.db.get('events', root)
  if (cx.readOnly(room) || !r || r.room !== room || r.type !== 'msg' || !r.chan) return null
  if (!cx.canViewCh(room, r.chan) || (await cx.rootOf(r))) return null
  const range = IDBKeyRange.bound(
    [room, root, opts.after ?? ''],
    [room, root, opts.before ?? '￿'],
    !!opts.after,
    !!opts.before
  )
  // A transferred copy: its archive only (spec 3.8 step 6).
  const keep = cx.sumOf(room).upgraded ? await cx.archiveKeep(room, cx.rooms.get(room)?.next) : null
  if (keep && !keep(r)) return null
  const recs: EventRecord[] = []
  let cursor = await cx.db
    .transaction('events')
    .store.index('room_thread_sort')
    .openCursor(range, 'prev')
  while (cursor && recs.length < limit + 1) {
    const x = cursor.value
    if (x.type === 'msg' && x.chan === r.chan && (!keep || keep(x))) recs.push(x)
    cursor = await cursor.continue()
  }
  const more = recs.length > limit
  const page = recs.slice(0, limit).reverse()
  const [head] = await cx.withReplies(room, r.chan, await cx.rows(room, [r]))
  return { root: head ?? null, ch: r.chan, messages: await cx.rows(room, page), more }
}

// A thread around one of its replies, for jumping to it.
export async function loadThreadAround(cx: ServerCtx, room: string, root: string, id: string) {
  const r = await cx.db.get('events', id)
  if (!r || r.room !== room || (await cx.rootOf(r)) !== root) return null
  const older = await cx.loadThread(room, root, {
    before: r.sortKey,
    limit: LOCAL.server.threadBefore,
  })
  const newer = await cx.loadThread(room, root, {
    after: r.sortKey,
    limit: LOCAL.server.threadAfter,
  })
  if (!older || !newer) return null
  const self = await cx.rows(room, [r])
  return { ...older, messages: [...older.messages, ...self, ...newer.messages] }
}

// Join and leave lines from ACL events in a sort key range: the genesis (its creator) and a live
// join, an effective leave, kick or ban.
export async function systemRows(
  cx: ServerCtx,
  room: string,
  lo: string | undefined,
  hi: string | undefined,
  sys: { join: boolean; leave: boolean }
) {
  const kinds = [
    ...(sys.join ? ['genesis', 'join'] : []),
    ...(sys.leave ? ['leave', 'kick', 'ban'] : []),
  ]
  const recs: EventRecord[] = []
  for (const t of kinds)
    recs.push(
      ...(await cx.db.getAllFromIndex(
        'events',
        'room_type_sort',
        IDBKeyRange.bound([room, t, lo ?? ''], [room, t, hi ?? '￿'], !!lo, !!hi)
      ))
    )
  if (!recs.length) return []
  const ids = recs.map(r => r.id)
  const shown = await cx.host.display(room, ids)
  // A server that shows joiners only what came after them shows no lines from before either.
  const mine =
    historyOf(cx.sumOf(room)) === 'joined'
      ? await cx.host.history(room, cx.me, ids)
      : ids.map(() => true)
  const out: P2pMessage[] = []
  recs.forEach((rec, i) => {
    if (!shown[i] || shown[i]?.hidden || !mine[i]) return
    const c = serverWire(rec).c
    const ik = rec.type === 'kick' || rec.type === 'ban' ? (c?.to as string) : rec.sender
    if (typeof ik !== 'string') return
    out.push({
      ...systemRow(rec, ik),
      system: { kind: rec.type === 'join' || rec.type === 'genesis' ? 'join' : 'leave', ik },
    })
  })
  return out
}

// Message rows: what shows, with its last edit, its reactions and its pin (spec 3.5).
export async function rows(cx: ServerCtx, room: string, recs: EventRecord[]) {
  if (!recs.length) return []
  const box = new Map<string, OutboxRecord>(
    (await cx.db.getAllFromIndex('outbox', 'room', room)).map(o => [o.id, o])
  )
  const shown = await cx.host.display(
    room,
    recs.map(r => r.id)
  )
  const out: P2pMessage[] = []
  const viewed: string[] = []
  const replies = new Map<string, Shown | null>()
  const roots = new Map<string, Promise<EventRecord | undefined>>()
  const getRoot = (id: string) => {
    let x = roots.get(id)
    if (!x) roots.set(id, (x = cx.db.get('events', id)))
    return x
  }
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i]
    const sh = shown[i]
    const thread = await cx.rootOf(r, getRoot)
    const c = serverWire(r).c as MsgContent | null
    // Shows, but its body was purged or evicted here: until a peer sends it back (spec 4.3);
    // an evicted one is asked for now that it is viewed (spec 4.2).
    if (sh && !sh.hidden && r.purged) {
      if (r.evicted) viewed.push(r.id)
      out.push({
        ...placeholder(r),
        unavailable: true,
        thread,
        ...(r.thread && !thread ? { noThread: true as const } : {}),
      })
      continue
    }
    // Sent by a member around the time they were removed, and after it (spec 3.5, 8.2): a line
    // in its place says so.
    if (sh?.hidden?.why === 'removed' && r.type === 'msg') {
      // One line for a run of them by the same member.
      const last = out[out.length - 1]
      if (!(last?.removed && last.sender === r.sender))
        out.push({ ...placeholder(r), removed: true, thread })
      continue
    }
    // Ours, sent too soon after our last one (two devices, one offline): we see why it's gone.
    if (sh?.hidden?.why === 'slow' && r.type === 'msg' && r.sender === cx.me) {
      out.push({ ...placeholder(r), slowHidden: true, thread })
      continue
    }
    // Not decided here yet (our own message on its way in), or hidden.
    if (!sh || sh.hidden || !c || r.redacted) continue
    const edit = sh.edit && !c.fwd ? await cx.db.get('events', sh.edit) : undefined
    const reacts = (await getEvents(
      cx.db,
      room,
      sh.reactions.map(x => x.id)
    )) as EventRecord[]
    const pin = sh.pin ? await cx.db.get('events', sh.pin.id) : undefined
    let reply: P2pMessage['reply'] = null
    if (c.reply) {
      const t = await cx.db.get('events', c.reply)
      let ts = replies.get(c.reply)
      if (ts === undefined && t && t.room === room) {
        ts = (await cx.host.display(room, [t.id]))[0]
        replies.set(c.reply, ts)
      }
      const tc = t && t.room === room ? (serverWire(t).c as MsgContent | null) : null
      const gone = !t || !tc || t.redacted || !ts || !!ts.hidden
      const tedit = !gone && ts?.edit ? await cx.db.get('events', ts.edit) : undefined
      reply = {
        id: c.reply,
        sender: t?.room === room ? t.sender : null,
        body: gone
          ? null
          : tedit
            ? String((serverWire(tedit).c as { body?: unknown } | null)?.body ?? '')
            : (tc as MsgContent).body,
      }
    }
    const o = box.get(r.id)
    const pending = r.sender === cx.me && !!o && o.deliveredTo.length === 0
    out.push({
      id: r.id,
      sender: r.sender,
      ts: r.effTs,
      sentTs: serverWire(r).ev.ts,
      sortKey: r.sortKey,
      seq: r.seq,
      body: edit ? String((serverWire(edit).c as { body?: unknown } | null)?.body ?? '') : c.body,
      reply,
      mentions: c.fwd ? [] : (c.mentions ?? []),
      fwd: c.fwd ?? null,
      att: c.att ?? [],
      edited: edit ? edit.effTs : null,
      reactions: reactionsOf(reacts, cx.me),
      pinned: sh.pin?.on && pin && !thread ? pin.effTs : null,
      late: r.sender !== cx.me && r.receivedAt - r.effTs > EV.lateMs,
      pending,
      failed: pending && !!o?.failed,
      call: null,
      everyone: c.everyone === true && sh.everyone,
      thread,
      ...(r.thread && !thread ? { noThread: true as const } : {}),
    })
  }
  if (viewed.length) {
    const rt = cx.ensureRt(room)
    const fresh = viewed.filter(id => !rt.viewed.has(id))
    for (const id of fresh) rt.viewed.add(id)
    while (rt.viewed.size > SERVER.viewedMax)
      rt.viewed.delete(rt.viewed.values().next().value as string)
    if (fresh.length) cx.sync.fetch(room, fresh)
  }
  return out
}

export async function loadAround(cx: ServerCtx, room: string, ch: string, id: string) {
  const r = await cx.db.get('events', id)
  if (!r || r.room !== room || r.chan !== ch || (await cx.rootOf(r))) return null
  if (!cx.canViewCh(room, ch)) return null
  // A transferred copy shows only its archive (spec 3.8 step 6), at a jump too.
  if (cx.sumOf(room).upgraded) {
    const keep = await cx.archiveKeep(room, cx.rooms.get(room)?.next)
    if (keep && !keep(r)) return null
  }
  return around(
    r.sortKey,
    async () => cx.withReplies(room, ch, await cx.rows(room, [r])),
    o => cx.loadChannel(room, ch, o)
  )
}

// Pinned messages of a channel, newest pin first (spec 3.5: the latest visible pin by someone
// with Manage messages in its admission state decides).
export async function loadPins(cx: ServerCtx, room: string, ch: string) {
  if (!cx.canViewCh(room, ch)) return []
  const seen = new Set<string>()
  const targets: string[] = []
  let steps = 0
  let cursor = await cx.db
    .transaction('events')
    .store.index('room_type_sort')
    .openCursor(IDBKeyRange.bound([room, 'pin', ''], [room, 'pin', '￿']), 'prev')
  while (cursor && steps < DAG.walk) {
    const p = cursor.value
    steps += 1
    if (p.target && p.chan === ch && !seen.has(p.target)) {
      seen.add(p.target)
      targets.push(p.target)
    }
    cursor = await cursor.continue()
  }
  if (!targets.length) return []
  const shown = await cx.host.display(room, targets)
  const on = targets.filter((_t, i) => shown[i]?.pin?.on && !shown[i]?.hidden)
  // A transferred copy pins only what its archive shows (spec 3.8 step 6).
  const keep = cx.sumOf(room).upgraded ? await cx.archiveKeep(room, cx.rooms.get(room)?.next) : null
  const recs: EventRecord[] = []
  for (const r of await getEvents(cx.db, room, on))
    if (r.type === 'msg' && r.chan === ch && !(await cx.rootOf(r)) && (!keep || keep(r)))
      recs.push(r)
  return cx.rows(room, recs.slice(0, PINS_MAX))
}
