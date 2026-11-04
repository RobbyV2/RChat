import { isRecord } from '../../bytes'
import { genesisBundle } from '../acl/binding'
import { RULES_VERSION } from '../acl/rules'
import { emptySummary } from '../acl/summary'
import type { Carried } from '../acl_room'
import { b64u, canonical, randomBytes } from '../canonical'
import { blankRoom } from '../dag'
import { serverWire, type Carry } from '../db'
import { buildEvent2, signUpgrade, upgradeSigOk, validate2, type WireV2 } from '../event_v2'
import {
  CANT_TEXT,
  LONE_TEXT,
  QUICK_TEXT,
  CO_OWNER_DECLINED_TEXT,
  CO_OWNER_OFFLINE_TEXT,
  TOO_OFTEN_TEXT,
} from '../flows'
import type { Message } from '../frames'
import { keyId } from '../keys'
import { LOCAL } from '../limits'
import type { Session } from '../session'
import { channelsOf, knownChannel, knownSettings, membershipOf, EVERYONE, nameOf } from '../state'
import type { ServerCtx } from './context'
import {
  SERVER,
  SYNC_TEXT,
  OLD_GONE_TEXT,
  ServerError,
  MIGRATE_PER,
  CARRY_ACK,
  CARRY_ACKS_MAX,
  type Migrated,
} from './types'
import { type Rt } from './rt'

export function transferAsks(cx: ServerCtx) {
  return [...cx.xferAsks].map(([key, a]) => ({
    key,
    kind: a.kind,
    from: a.from,
    room: a.room,
    to: a.to,
    name: nameOf(cx.sumOf(a.room))?.name ?? cx.rooms.get(a.room)?.name ?? a.name,
  }))
}

// An owner transfers the server to member `to` (spec 3.8): `to` builds the new copy's genesis
// and signs it, every other genesis owner countersigns it (also ones who left), and the upgrade
// goes out. This copy becomes read-only; everyone follows to the new one.
export async function transfer(cx: ServerCtx, room: string, to: string) {
  const s = cx.sumOf(room)
  if (!s.owners.includes(cx.me) || to === cx.me || membershipOf(s, to) !== 'join')
    throw new ServerError(CANT_TEXT)
  const ses = await cx.sessionTo(room, to)
  if (!ses) throw new ServerError('They must be online to take it')
  const reply = await cx.request(ses, { t: 'gxfer', room }, SERVER.coOwnerMs)
  const g = cx.successorOk(room, reply?.g, to)
  if (!g) throw new ServerError("They didn't take the transfer")
  const sigs: Record<string, string> = {}
  // Co-owners who never joined or have left may not hold the server: its genesis goes along.
  const genesis = (await cx.db.get('events', room))?.wire
  for (const o of s.owners) {
    if (o === cx.me) continue
    // A co-owner who is a member is dialed for the room; one who left only as a contact.
    const os =
      membershipOf(s, o) === 'join' ? await cx.sessionTo(room, o) : cx.deps.node.readySessions(o)[0]
    const r = os ? await cx.request(os, { t: 'gcosign', room, g, genesis }, SERVER.coOwnerMs) : null
    if (typeof r?.sig !== 'string' || !upgradeSigOk(o, room, g, r.sig))
      throw new ServerError(os ? CO_OWNER_DECLINED_TEXT : CO_OWNER_OFFLINE_TEXT, cx.nameOf(o, room))
    sigs[o] = r.sig
  }
  await cx.emit(room, 'upgrade', () => ({ g, sigs }))
}

// A ready session to `ik`: one we have, else one dialed for `room` (a member we never linked
// with), waiting at most 15 s.
export async function sessionTo(cx: ServerCtx, room: string, ik: string) {
  let s = cx.deps.node.readySessions(ik)[0]
  if (s) return s
  cx.prefer(room, ik)
  cx.deps.node.schedule(true)
  for (let i = 0; i < LOCAL.server.sessionTries && !s; i++) {
    await new Promise<void>(done => cx.clock.set(done, LOCAL.server.sessionWaitMs))
    s = cx.deps.node.readySessions(ik)[0]
  }
  return s
}

// The new copies the upgrades of `room` name (more than one: the user picks, spec 3.8).
// With who transferred it (`by`), so two copies with the same owner can be told apart.
export async function successors(cx: ServerCtx, room: string) {
  const out: { id: string; owner: string; by: string; g: WireV2 }[] = []
  for (const id of cx.sumOf(room).upgrades ?? []) {
    const up = await cx.db.get('events', id)
    const g = up ? cx.successorOk(room, (serverWire(up).c as { g?: unknown } | null)?.g) : null
    const v = g ? validate2(g, null) : null
    if (up && g && v?.ok) out.push({ id: v.id, owner: g.ev.a, by: up.sender, g })
  }
  return out
}

// A new copy's genesis for `room`, signed by its owner `to`, of rules we know and naming the
// room it follows; null otherwise.
export function successorOk(cx: ServerCtx, room: string, g: unknown, to?: string): WireV2 | null {
  const v = validate2(g, null)
  if (!v.ok || v.wire.ev.t !== 'genesis') return null
  const c = v.wire.c as { rules?: unknown; from?: { srv?: unknown } } | null
  if (c?.rules !== RULES_VERSION || c.from?.srv !== room) return null
  if (to !== undefined && v.wire.ev.a !== to) return null
  return v.wire
}

export function onTransfer(cx: ServerCtx, m: Message, s: Session, kind: 'take' | 'cosign') {
  const from = s.remote?.ik
  const room = m.room
  if (!from || typeof room !== 'string') return s.strike()
  const answer = (ok: boolean, extra: Record<string, unknown> = {}) =>
    void s
      .send({ t: kind === 'take' ? 'gxfered' : 'gcosigned', room, ok, ...extra })
      .catch(() => {})
  // The server's owners: from its genesis (sent along to a co-owner, who may not hold it).
  const gen = validate2(kind === 'cosign' ? m.genesis : null, null)
  const owners =
    kind === 'take'
      ? cx.sumOf(room).owners
      : gen.ok && gen.id === room
        ? (((gen.wire.c?.owners as { ik?: unknown }[] | undefined) ?? []).map(
            o => o.ik
          ) as string[])
        : []
  if (!owners.includes(from) || from === cx.me) return answer(false)
  const g = kind === 'cosign' ? cx.successorOk(room, m.g) : null
  if (kind === 'take' && cx.myMembership(room) !== 'join') return answer(false)
  if (kind === 'cosign' && (!g || !owners.includes(cx.me))) return answer(false)
  const key = `${kind}\n${from}\n${room}`
  if (cx.xferAsks.size >= SERVER.coOwnerAsks && !cx.xferAsks.has(key)) return answer(false)
  const gname = (gen.ok ? gen.wire.c?.name : undefined) ?? g?.c?.name
  cx.xferAsks.set(key, {
    kind,
    from,
    room,
    name:
      typeof gname === 'string'
        ? Array.from(gname).slice(0, LOCAL.server.nameMax).join('')
        : 'P2P server',
    to: kind === 'take' ? cx.me : (g?.ev.a ?? ''),
    ...(g ? { g } : {}),
    s,
  })
  const drop = () => {
    if (cx.xferAsks.delete(key)) cx.changed('')
  }
  s.onClose(drop)
  cx.clock.set(drop, SERVER.coOwnerMs)
  cx.changed('')
}

export async function answerTransfer(cx: ServerCtx, key: string, yes: boolean) {
  const a = cx.xferAsks.get(key)
  if (!a) return
  cx.xferAsks.delete(key)
  cx.changed('')
  const t = a.kind === 'take' ? 'gxfered' : 'gcosigned'
  const send = (ok: boolean, extra: Record<string, unknown> = {}) =>
    void a.s.send({ t, room: a.room, ok, ...extra }).catch(() => {})
  const author = cx.deps.node.author()
  if (!yes || !author) return send(false)
  if (a.kind === 'cosign' && a.g) return send(true, { sig: signUpgrade(author.ik, a.room, a.g) })
  send(true, { g: await cx.successorOf(a.room) })
}

// The genesis of a new copy of `room` that we own, with the room's name and what @everyone may
// do (spec 3.8: `from` names the room it follows).
export async function successorOf(cx: ServerCtx, room: string): Promise<WireV2> {
  const author = await cx.author()
  const dk = keyId(author.dk.pk)
  const s = cx.sumOf(room)
  const bare: Record<string, unknown> = {
    rules: RULES_VERSION,
    nonce: b64u(randomBytes(16)),
    owners: [{ ik: cx.me, dk }],
    everyone_bits: s.everyone,
    name: nameOf(s)?.name ?? 'P2P server',
    cert: cx.deps.node.cert,
    profile: cx.deps.node.profile,
    from: { srv: room },
  }
  const binding = cx.deps.node.binding
  if (binding) bare.binding = binding
  const content = {
    ...bare,
    owners: [{ ik: cx.me, dk, dcert: genesisBundle(author.ik, dk, bare).dcert }],
  }
  return buildEvent2(author, null, 'genesis', 'a', content, { seq: 0 }, cx.clock.now())
    .wire as WireV2
}

// The follow rule (spec 3.8): with exactly one upgrade, the new copy is followed: its owner
// creates it and carries members, roles, channels and bans over; everyone else joins it when
// invited. With more than one, the user chooses (disputed). One at a time per room.
export async function follow(cx: ServerCtx, room: string) {
  const rt = cx.ensureRt(room)
  if (rt.following) return
  rt.following = true
  try {
    const s = cx.sumOf(room)
    const r = cx.rooms.get(room)
    if (s.upgrades.length !== 1 || !r || r.next || cx.myMembership(room) !== 'join') return
    const up = await cx.db.get('events', s.upgrades[0])
    if (!up) return
    const g = cx.successorOk(room, (serverWire(up).c as { g?: unknown } | null)?.g)
    if (g) await cx.followTo(room, g)
  } finally {
    rt.following = false
  }
}

// Follows `room` to the new copy whose genesis is `g` (also the user's choice when disputed).
export async function followTo(cx: ServerCtx, room: string, g: WireV2) {
  const v = validate2(g, null)
  if (!v.ok || !cx.successorOk(room, g)) return
  const next = v.id
  await cx.updateRoom(room, cur => ({ ...cur, next }))
  const now = cx.clock.now()
  const owner = g.ev.a === cx.me
  if (!cx.rooms.has(next))
    await cx.putRoom({
      ...blankRoom(next, '', now),
      kind: 'server',
      name: cx.rooms.get(room)?.name ?? 'P2P server',
      chans: {},
      server: null,
      since: now,
      prev: room,
      ...(owner
        ? { carry: { from: room, roles: {}, state: 'running' as const } }
        : { joining: { at: now, via: 'invite' as const } }),
    })
  if (owner) {
    await cx.locked(next, async () => {
      if (await cx.db.get('events', next)) return
      await cx.withDevice(keyId((await cx.author()).dk.pk), () => cx.take(next, next, g, now))
    })
    void cx.carryOver(next).catch(() => {})
  } else {
    cx.ensureRt(next).joinPosted = false
    cx.prefer(next, g.ev.a)
    cx.deps.node.schedule(true)
  }
  cx.changed(room)
  cx.changed(next)
}

// The new owner carries the old copy over (spec 3.8 steps 4 and 6, as owner events), as it
// was at the upgrade (project(Eval_S(B(u))), not as it is now): first the `migrate` content
// (who was a member, who banned, and each device's last message at the transfer: the old copy
// shows here only up to there, without the new copy's banned members), then an invite for each
// member, so they join and acknowledge the rest; then the channels with their ids, the
// settings, the roles and the bans, and a last `migrate` chunk that says it is done. Finished
// steps are recorded, so a start resumes after them and never redoes one that was changed
// since; limits that clear by themselves (spec 4.1 W3) are waited out, and anything else stops
// it with the reason shown.
export async function carryOver(cx: ServerCtx, to: string) {
  const rt = cx.ensureRt(to)
  const rec = cx.rooms.get(to)
  if (rt.carrying || !rec?.carry || rec.carry.state === 'done') return
  if (cx.sumOf(to).owners[0] !== cx.me) return
  rt.carrying = true
  let carry = rec.carry
  const save = async (patch: Partial<Carry>) => {
    carry = { ...carry, ...patch }
    if (!patch.why) delete carry.why
    await cx.updateRoom(to, cur => ({ ...cur, carry }))
    cx.changed(to)
  }
  try {
    const from = carry.from
    await cx.ensureRt(from).loading
    const up = carry.up ?? (await cx.upgradeOf(from, to))
    const s = up ? await cx.carriedOf(from, up) : null
    if (up && s) rt.carryTries = 0
    if (!up || !s) {
      if (cx.started && !cx.rooms.has(from))
        return await save({ state: 'failed', why: OLD_GONE_TEXT })
      // The old copy isn't loaded here yet: again in a moment (for an hour; then on a change).
      if ((rt.carryTries = (rt.carryTries ?? 0) + 1) <= LOCAL.server.carryTries)
        cx.clock.set(() => void cx.carryOver(to).catch(() => {}), LOCAL.server.carryRetryMs)
      return carry.state === 'waiting' && carry.why === SYNC_TEXT
        ? undefined
        : await save({ state: 'waiting', why: SYNC_TEXT })
    }
    await save({ state: 'running', up })
    if (!carry.chunks) await save({ chunks: await cx.migrateChunks(from, s) })
    const cur = () => cx.sumOf(to)
    const steps: [string, () => Promise<unknown>][] = []
    for (const [n, chunk] of (carry.chunks ?? []).entries())
      steps.push([`m${n}`, () => cx.emit(to, 'migrate', () => ({ chunk }))])
    for (const ik of s.members)
      if (ik !== cx.me)
        steps.push([
          `a:${ik}`,
          async () => {
            const now = membershipOf(cur(), ik)
            if (now !== 'join' && now !== 'invite' && now !== 'ban')
              await cx.emit(to, 'add', () => ({ to: ik }))
            // They may have asked for the new copy before they were invited (and been told no).
            if (now !== 'join' && now !== 'ban') cx.prefer(to, ik)
          },
        ])
    for (const c of channelsOf({ ...emptySummary(), channels: s.channels }))
      steps.push([
        `c:${c.id}`,
        async () => {
          if (!cur().channels[c.id])
            await cx.emit(to, 'channel', () => ({ ...knownChannel(c), id: c.id }))
        },
      ])
    if (s.settings)
      steps.push([
        'settings',
        async () => {
          if (
            canonical(knownSettings(cur().settings ?? {})) !==
            canonical(knownSettings(s.settings ?? {}))
          )
            await cx.emit(to, 'settings', () => knownSettings(s.settings ?? {}))
        },
      ])
    for (const [id, role] of Object.entries(s.roles).sort(([, a], [, b]) => a.pos - b.pos))
      steps.push([
        `r:${id}`,
        async () => {
          if (carry.roles[id] && cur().roles[carry.roles[id]]) return
          const made = await cx.emit(to, 'role_create', () => ({ ...role }))
          await save({ roles: { ...carry.roles, [id]: made } })
        },
      ])
    // Overwrites, their role subjects mapped to the new roles.
    for (const [ch, ov] of Object.entries(s.overwrites ?? {}))
      for (const [subj, o] of Object.entries(ov))
        steps.push([
          `o:${ch}|${subj}`,
          async () => {
            const old = subj.startsWith('r:') && subj !== `r:${EVERYONE}` ? subj.slice(2) : null
            if (old !== null && !carry.roles[old]) return
            const target = old !== null ? `r:${carry.roles[old]}` : subj
            const now = cur().overwrites?.[ch]?.[target]
            if (now?.allow === o.allow && now?.deny === o.deny) return
            await cx.emit(to, 'chperm', () => ({
              ch,
              subj: target,
              allow: o.allow,
              deny: o.deny,
            }))
          },
        ])
    for (const ik of s.bans)
      steps.push([
        `b:${ik}`,
        async () => {
          if (membershipOf(cur(), ik) !== 'ban')
            await cx.emit(to, 'ban', () => ({ to: ik, seen: {} }))
        },
      ])
    steps.push([
      'done',
      () => cx.emit(to, 'migrate', () => ({ chunk: { kind: 'done', n: 0, of: 1, list: [] } })),
    ])
    for (const [key, step] of steps) {
      if (carry.done?.includes(key)) continue
      const why = await cx.untilAllowed(to, step, w => save({ state: 'waiting', why: w }))
      if (why !== null) return await save({ state: 'failed', why })
      await save({ state: 'running', done: [...(carry.done ?? []), key] })
    }
    await save({ state: 'done' })
    await cx.carryRoles(to)
  } finally {
    rt.carrying = false
  }
}

// Tries the carry-over again (after it stopped on an error).
export function retryCarry(cx: ServerCtx, room: string) {
  const r = cx.rooms.get(room)
  if (r?.carry && r.carry.state === 'failed') void cx.carryOver(room).catch(() => {})
}

// The upgrade of `from` that names the new copy `to` (spec 3.8).
export async function upgradeOf(cx: ServerCtx, from: string, to: string) {
  for (const id of cx.sumOf(from).upgrades ?? []) {
    const up = await cx.db.get('events', id)
    const g = up ? cx.successorOk(from, (serverWire(up).c as { g?: unknown } | null)?.g) : null
    const v = g ? validate2(g, null) : null
    if (v?.ok && v.id === to) return id
  }
  return null
}

// The old copy as the upgrade `up` carries it (spec 3.8 step 4), kept while it is in use.
export async function carriedOf(cx: ServerCtx, from: string, up: string) {
  const rt = cx.ensureRt(from)
  if (rt.carried?.up !== up) {
    const s = await cx.host.carried(from, up)
    if (!s) return null
    rt.carried = { up, s }
  }
  return rt.carried.s
}

// `migrate` content (spec 3.8): the members and bans the upgrade carries, and the last message
// seq of each device we hold in the old copy, in chunks within the size of an ACL event.
export async function migrateChunks(cx: ServerCtx, from: string, s: Carried) {
  const marks: Record<string, number> = {}
  const recs = await cx.db.getAllFromIndex(
    'events',
    'room_seq',
    IDBKeyRange.bound([from, -Infinity], [from, Infinity])
  )
  for (const r of recs)
    if (r.layer === 'c' && r.dev && r.dseq !== undefined)
      marks[r.dev] = Math.max(marks[r.dev] ?? -1, r.dseq)
  const out: Record<string, unknown>[] = []
  const split = <T>(kind: string, list: T[], each: number) => {
    const of = Math.max(1, Math.ceil(list.length / each))
    for (let n = 0; n < of; n++)
      out.push({ kind, n, of, list: list.slice(n * each, (n + 1) * each) })
  }
  split('members', [...s.members].sort(), MIGRATE_PER)
  split('bans', [...s.bans].sort(), MIGRATE_PER)
  split('marks', Object.entries(marks), MIGRATE_PER)
  return out
}

// The `migrate` content an owner of this copy posted (spec 3.8), once every chunk is here, and
// whether the carry-over said it is done.
export async function migratedOf(cx: ServerCtx, room: string): Promise<Migrated | null> {
  const rt = cx.ensureRt(room)
  if (rt.migrated !== undefined) return rt.migrated
  const out = await cx.readMigrated(room)
  rt.migrated = out
  return out
}

// A new `migrate` chunk: read and compared again.
export function migrateArrived(cx: ServerCtx, rt: Rt) {
  rt.migrated = undefined
  rt.migrateChecked = false
}

export async function readMigrated(cx: ServerCtx, room: string): Promise<Migrated | null> {
  const s = cx.sumOf(room)
  const recs = await cx.db.getAllFromIndex(
    'events',
    'room_type_sort',
    IDBKeyRange.bound([room, 'migrate', ''], [room, 'migrate', '\uffff'])
  )
  const parts = new Map<string, { of: number; got: Map<number, unknown[]> }>()
  for (const r of recs) {
    if (!s.owners.includes(r.sender)) continue
    const c = (serverWire(r).c as { chunk?: unknown } | null)?.chunk
    if (!isRecord(c) || typeof c.kind !== 'string' || !Array.isArray(c.list)) continue
    const n = c.n
    const of = c.of
    if (!Number.isSafeInteger(n) || !Number.isSafeInteger(of)) continue
    const p = parts.get(c.kind) ?? { of: of as number, got: new Map() }
    p.got.set(n as number, c.list)
    parts.set(c.kind, p)
  }
  const all = (kind: string) => {
    const p = parts.get(kind)
    if (!p || p.got.size < p.of) return null
    return [...p.got.keys()].sort((a, b) => a - b).flatMap(n => p.got.get(n) ?? [])
  }
  const members = all('members')
  const bans = all('bans')
  const marks = all('marks')
  if (!members || !bans || !marks) return null
  const strs = (l: unknown[]) => l.filter((x): x is string => typeof x === 'string')
  const map: Record<string, number> = {}
  for (const e of marks)
    if (Array.isArray(e) && typeof e[0] === 'string' && Number.isSafeInteger(e[1]))
      map[e[0]] = e[1] as number
  return { members: strs(members), bans: strs(bans), marks: map, done: parts.has('done') }
}

// A member of a new copy acknowledges the owner's carry-over (spec 4.1 W3(b): an owner alone
// waits after 24 changes nobody else acknowledged): a mark once 20 more ACL events of an owner
// arrived (other members' marks never count), at most one a minute, until the carry-over says
// it is done. An owner who stops (gone, stalled, failed) gets no more, nor one who goes on past
// what the carry-over holds (the old copy at the upgrade, which we hold too) or whose carry-over
// made no progress here for a day while we ran. The baseline and count are in the room record.
export function ackCarry(cx: ServerCtx, room: string, rt: Rt) {
  const r = cx.rooms.get(room)
  const s = cx.sumOf(room)
  const now = cx.clock.now()
  if (cx.stopped || !r?.prev || r.carry || cx.myMembership(room) !== 'join') return
  if (s.owners.includes(cx.me)) return
  // The day counts from the last owner event that arrived, or our start: the owner may be
  // waiting for a mark we never got to post while closed.
  if (rt.carrySeen === null || s.ownerCount > rt.carrySeen) {
    rt.carrySeen = s.ownerCount
    rt.carryAt = now
  }
  if (rt.carryAckCount === null) {
    const a = r.acks
    const kept = !!a && Number.isSafeInteger(a.base) && Number.isSafeInteger(a.n) && a.n >= 0
    // Never acknowledged before (just joined): a mark at once, as what we hold unacknowledged
    // may be all the owner can still post.
    rt.carryAckCount = kept ? a.base : s.ownerCount - CARRY_ACK
    rt.carryAcks = kept ? a.n : 0
  }
  if (rt.carryDone || rt.carryAcks >= (rt.carryMax ?? r.carryMax ?? CARRY_ACKS_MAX)) return
  if (now - rt.carryAt > LOCAL.server.carryWindowMs) return
  if (s.ownerCount - rt.carryAckCount < CARRY_ACK) return
  const later = (ms: number) =>
    (rt.carryAckLater ??= cx.clock.set(() => {
      rt.carryAckLater = undefined
      cx.ackCarry(room, rt)
    }, ms))
  // Too soon after the last one: later, as the owner may be waiting for it (nothing new comes).
  const gap = LOCAL.server.carryAckGapMs
  if (now - rt.carryAckAt < gap) return void later(gap - (now - rt.carryAckAt))
  const base = rt.carryAckCount
  const acks = { base: s.ownerCount, n: rt.carryAcks + 1 }
  rt.carryAckAt = now
  rt.carryAckCount = acks.base
  rt.carryAcks = acks.n
  void cx
    .emit(room, 'mark', () => ({}))
    .then(
      () => cx.updateRoom(room, cur => ({ ...cur, acks })),
      () => {
        // Not posted: still owed, again in a minute.
        if (rt.carryAckCount !== acks.base) return
        rt.carryAckCount = base
        rt.carryAcks = acks.n - 1
        later(60_000)
      }
    )
    .catch(() => {})
}

// Spec 3.8 step 5: the member list the new owner carried over, against the old copy's at the
// upgrade (not its members now: leaving the archive changes nothing here).
export async function checkMigrated(cx: ServerCtx, room: string, prev: string, tries = 0) {
  const rt = cx.ensureRt(room)
  // Done and compared: nothing here changes any more.
  if (rt.migrateChecked) return
  const m = await cx.migratedOf(room)
  rt.carryDone = m?.done ?? false
  if (!cx.rooms.has(prev)) return
  await cx.ensureRt(prev).loading
  const up = rt.upgrade ?? (await cx.upgradeOf(prev, room))
  if (up) rt.upgrade = up
  const at = up ? await cx.carriedOf(prev, up) : null
  if (!at) {
    // The old copy isn't loaded here yet: again in a moment (for a minute).
    if (!rt.checkLater && tries < LOCAL.server.checkTries)
      rt.checkLater = cx.clock.set(() => {
        rt.checkLater = undefined
        void cx.checkMigrated(room, prev, tries + 1).catch(() => {})
      }, LOCAL.server.checkRetryMs)
    return
  }
  // What the carry-over posts, at most, from what the upgrade carries (known before any of it
  // is here): what bounds our acknowledgements of it, with room for about 100 changes of the
  // owner's own meanwhile. Every carried event counts: overwrites and `migrate` chunks too.
  const old = cx.sumOf(prev)
  const devices = at.members.reduce((n, ik) => n + (old.members[ik]?.devs.length || 1), 0)
  const chunks = [at.members.length, at.bans.length, devices].reduce(
    (n, k) => n + Math.max(1, Math.ceil(k / MIGRATE_PER)),
    1
  )
  const size =
    at.members.length +
    at.bans.length +
    Object.keys(at.channels).length +
    Object.keys(at.roles).length +
    Object.values(at.holds).reduce((n, l) => n + l.length, 0) +
    Object.values(at.overwrites ?? {}).reduce((n, o) => n + Object.keys(o).length, 0) +
    chunks +
    8
  rt.carryMax = Math.ceil(size / CARRY_ACK) + 5
  // Known from now on, also at a start that loads this copy before the old one.
  if (cx.rooms.get(room)?.carryMax !== rt.carryMax) {
    const carryMax = rt.carryMax
    await cx.updateRoom(room, cur => ({ ...cur, carryMax }))
  }
  if (!m) return
  rt.carriedMembers = new Set(m.members)
  const was = new Set(at.members)
  const added = m.members.filter(ik => !was.has(ik)).sort()
  const removed = at.members.filter(ik => !rt.carriedMembers?.has(ik)).sort()
  const diff = added.length || removed.length ? { added, removed } : null
  if (JSON.stringify(diff) !== JSON.stringify(rt.migrateDiff)) {
    rt.migrateDiff = diff
    cx.changed(room)
  }
  if (m.done) rt.migrateChecked = true
}

// Runs `step`, waiting out the limits that clear by themselves (another member's ACL event, or
// the hourly window), a minute at a time for at most a day. Null when it went through, else why
// it didn't (after a day, the limit it still waits for).
export async function untilAllowed(
  cx: ServerCtx,
  room: string,
  step: () => Promise<unknown>,
  waiting: (why: string) => Promise<void>
): Promise<string | null> {
  let last = TOO_OFTEN_TEXT
  for (let i = 0; i < LOCAL.server.stepTries && cx.rooms.has(room); i++) {
    try {
      await step()
      return null
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      if (why !== LONE_TEXT && why !== QUICK_TEXT && why !== SYNC_TEXT) return why
      last = why
      await waiting(why)
      await new Promise<void>(done => cx.clock.set(done, LOCAL.server.stepRetryMs))
    }
  }
  return last
}

// Members of the old copy who joined the new one get the roles they held at the upgrade back,
// once each (a role taken from them since stays taken). One run at a time per room, reading
// what was given and what they hold again for each role.
export async function carryRoles(cx: ServerCtx, room: string) {
  const rt = cx.ensureRt(room)
  if (rt.givingRoles) {
    rt.giveAgain = true
    return
  }
  rt.givingRoles = true
  try {
    do {
      rt.giveAgain = false
      await cx.giveRoles(room)
    } while (rt.giveAgain)
  } finally {
    rt.givingRoles = false
  }
}

export async function giveRoles(cx: ServerCtx, room: string) {
  const c = cx.rooms.get(room)?.carry
  if (!c?.up || cx.sumOf(room).owners[0] !== cx.me) return
  const old = await cx.carriedOf(c.from, c.up)
  if (!old) return
  const given = new Set(c.given ?? [])
  // What the old copy says now: a role taken away concurrently with the transfer (spec 3.8
  // step 7) isn't given back.
  const now = cx.sumOf(c.from)
  for (const [ik, held] of Object.entries(old.holds))
    for (const r of held) {
      const key = `${ik}\n${r}`
      if (given.has(key)) continue
      if (!now.members[ik]?.roles.includes(r)) continue
      const cur = cx.sumOf(room)
      const carry = cx.rooms.get(room)?.carry
      const role = carry?.roles[r]
      if (cur.members[ik]?.m !== 'join') break
      if (!carry || !role || !cur.roles[role] || carry.given?.includes(key)) continue
      given.add(key)
      if (!cur.members[ik]?.roles.includes(role))
        await cx.emit(room, 'assign', () => ({ to: ik, role }))
      await cx.updateRoom(room, x =>
        x.carry ? { ...x, carry: { ...x.carry, given: [...(x.carry.given ?? []), key] } } : x
      )
    }
}
