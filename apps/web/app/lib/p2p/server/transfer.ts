import { isRecord } from '../../bytes'
import { parseP2pMemberList } from '../../member_list'
import { genesisBundle } from '../acl/binding'
import { lockState, RESET_FIELDS } from '../../profile_reset'
import {
  carriedBits,
  carriedRule,
  knownRules,
  RULES_VERSION,
  timedBans,
  timeouts,
  type AclContent,
} from '../acl/rules'
import { emptySummary, type MemberSum, type RoleSum, type Summary } from '../acl/summary'
import type { Carried } from '../acl_room'
import { b64u, canonical, randomBytes } from '../canonical'
import { blankRoom } from '../dag'
import { serverWire, type Carry } from '../db'
import {
  buildEvent2,
  signUpgrade,
  upgradeSigOk,
  validate2,
  type CheckedWire2,
  type WireV2,
} from '../event_v2'
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
import type { Session } from '../session'
import { channelsOf, knownChannel, knownSettings, membershipOf, EVERYONE, nameOf } from '../state'
import { separatorContent } from './categories'
import type { ServerCtx } from './context'
import { SYNC_TEXT, OLD_GONE_TEXT, ServerError, type Migrated } from './types'
import { type Rt } from './rt'
import { clip } from '../rate'
import { malformed } from '../strike'

// The `role_create` a new copy makes from a role of the old one: its position, bits, name, color
// and looks (the fields of its last change this version doesn't know stay behind).
const carriedRole = (role: RoleSum, from: number | null) => {
  const out: Record<string, unknown> = { ...role, bits: carriedBits(role.bits, false, from) }
  delete out.extra
  return out
}

// A register of the old copy that the new one keeps. Its owner signs the content of each key the
// upgrade carries again (a register a room has once has the one key ''), unless the new copy has
// that key already. Deleted entries are not among the keys. `roles` names each role of the old
// copy as the new one has it; a register that reads it comes after the roles.
export interface CarryRegister {
  type: string
  step: (k: string) => string
  keys: (s: Carried) => string[]
  content: (s: Carried, k: string, roles: Record<string, string>) => Record<string, unknown>
  has: (cur: Summary, k: string) => boolean
  afterRoles?: true
}

const once = (
  type: string,
  step: string,
  at: (s: Carried) => AclContent | null | undefined,
  has: (cur: Summary) => boolean,
  content: (c: AclContent, roles: Record<string, string>) => Record<string, unknown> = c => ({
    ...c,
  })
): CarryRegister => ({
  type,
  step: () => step,
  keys: s => (at(s) ? [''] : []),
  content: (s, _k, roles) => content(at(s) as AclContent, roles),
  has,
})

// Every register a room upgrade carries. A commit that adds a register adds its entry here.
export const CARRY_REGISTERS: readonly CarryRegister[] = [
  // Stored sealed from the start: what the new copy stored before this write is sealed too.
  once(
    'store',
    'store',
    s => (s.store?.on === true ? s.store : null),
    cur => cur.store !== null,
    c => ({ ...c, on: true, earlier: true })
  ),
  {
    type: 'category',
    step: id => `k:${id}`,
    keys: s => Object.keys(s.categories ?? {}),
    content: (s, id) => {
      const cat = s.categories![id]
      return {
        ...cat.extra,
        id,
        name: cat.name,
        pos: cat.pos,
        ...(cat.style ? { style: cat.style } : {}),
      }
    },
    has: (cur, id) => !!cur.categories?.[id],
  },
  {
    type: 'chcat',
    step: ch => `h:${ch}`,
    keys: s => Object.keys(s.chcats ?? {}),
    content: (s, ch) => {
      const cc = s.chcats![ch]
      return { ...cc.extra, ch, cat: cc.cat, sync: cc.sync }
    },
    has: (cur, ch) => !!cur.chcats?.[ch],
  },
  {
    type: 'chsep',
    step: id => `p:${id}`,
    keys: s => Object.keys(s.separators ?? {}),
    content: (s, id) => separatorContent(id, s.separators![id]),
    has: (cur, id) => !!cur.separators?.[id],
  },
  once(
    'profile_mode',
    'profile_mode',
    s => s.profileMode,
    cur => cur.profiles !== null
  ),
  once(
    'about',
    'about',
    s => s.about,
    cur => cur.about !== null
  ),
  {
    // Its roles are named as the new copy has them.
    ...once(
      'member_list',
      'l',
      s => s.memberList,
      cur => cur.memberList !== null,
      (c, made) => {
        const roles = parseP2pMemberList(c).roles
        return roles === null ? { ...c } : { ...c, allow_roles: roles.flatMap(r => made[r] ?? []) }
      }
    ),
    afterRoles: true,
  },
]

// A register about one member that the new copy keeps once that member has joined it: the
// content its owner signs then, or null when nothing of it is left. `was` is the old copy as the
// upgrade carries it, `old` as it is now (what ended there since is not brought back), `at` the
// time in ms.
export interface CarryMemberRegister {
  type: string
  content: (
    was: Carried,
    ik: string,
    old: Summary,
    cur: Summary,
    at: number
  ) => Record<string, unknown> | null
  has: (cur: Summary, ik: string) => boolean
}

export const CARRY_MEMBER_REGISTERS: readonly CarryMemberRegister[] = [
  {
    // The parts a moderator cleared, with the lock while it runs.
    type: 'profile_reset',
    content: (was, ik, old, _cur, at) => {
      const reset = was.resets?.[ik]
      if (!reset || !old.members[ik]?.reset) return null
      const locked = lockState(reset.lock?.until, Math.floor(at / 1000)).locked
      const held = locked ? (reset.lock?.fields ?? []) : []
      const fields = RESET_FIELDS.filter(f => reset.hide.includes(f) || held.includes(f))
      if (!fields.length) return null
      return { to: ik, fields, ...(locked ? { until: reset.lock?.until } : {}) }
    },
    has: (cur, ik) => !!cur.members[ik]?.reset,
  },
  {
    // A timeout still running, in a copy whose rules read timeouts.
    type: 'timeout',
    content: (was, ik, old, cur, at) => {
      const until = was.timeouts?.[ik]
      const now = old.members[ik]
      if (!timeouts(cur.rules) || until === undefined || until <= at) return null
      if (now?.timeoutUntil !== until) return null
      return { to: ik, until, ...(now.timeoutReason ? { reason: now.timeoutReason } : {}) }
    },
    has: (cur, ik) => cur.members[ik]?.timeoutUntil !== undefined,
  },
]

// What a carried ban keeps of the old one: its reason, and its end in a copy whose rules read it.
const carriedBan = (old: MemberSum | undefined, rules: number | null) => ({
  ...(old?.banReason ? { reason: old.banReason } : {}),
  ...(timedBans(rules) && old?.banUntil !== undefined ? { until: old.banUntil } : {}),
})

export function transferAsks(cx: ServerCtx) {
  return [...cx.xferAsks].map(([key, a]) => ({
    key,
    kind: a.kind,
    from: a.from,
    room: a.room,
    to: a.to,
    name: nameOf(cx.sumOf(a.room), cx.local.display)?.name ?? cx.rooms.get(a.room)?.name ?? a.name,
  }))
}

// An owner transfers the server to member `to`: `to` builds the new copy's genesis
// and signs it, every other genesis owner countersigns it (also ones who left), and the upgrade
// goes out. This copy becomes read-only; everyone follows to the new one.
export async function transfer(cx: ServerCtx, room: string, to: string) {
  const s = cx.sumOf(room)
  const upgrade = to === cx.me
  if (
    !s.owners.includes(cx.me) ||
    membershipOf(s, to) !== 'join' ||
    (upgrade && (!knownRules(s.rules) || (s.rules as number) >= RULES_VERSION)) ||
    (upgrade && s.owners.length !== 1)
  )
    throw new ServerError(CANT_TEXT)
  if (upgrade) {
    const g = await cx.successorOf(room)
    await cx.emit(room, 'upgrade', () => ({ g, sigs: {} }))
    return
  }
  const ses = await cx.sessionTo(room, to)
  if (!ses) throw new ServerError('They must be online to take it')
  const reply = await cx.request(ses, { t: 'gxfer', room }, cx.local.server.coOwnerMs)
  const g = cx.successorOk(room, reply?.g, to)
  if (!g) throw new ServerError("They didn't take the transfer")
  const sigs: Record<string, string> = {}
  // Co-owners who never joined or have left may not hold the server: its genesis goes along.
  const held = await cx.db.get('events', room)
  const genesis = held?.unreadable ? undefined : held?.wire
  for (const o of s.owners) {
    if (o === cx.me) continue
    // A co-owner who is a member is dialed for the room; one who left only as a contact.
    const os =
      membershipOf(s, o) === 'join' ? await cx.sessionTo(room, o) : cx.deps.node.readySessions(o)[0]
    const r = os
      ? await cx.request(os, { t: 'gcosign', room, g, genesis }, cx.local.server.coOwnerMs)
      : null
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
  const lim = cx.local.server
  for (let i = 0; i < lim.sessionTries && !s; i++) {
    await new Promise<void>(done => cx.clock.set(done, lim.sessionWaitMs))
    s = cx.deps.node.readySessions(ik)[0]
  }
  return s
}

// The new copies the upgrades of `room` name (more than one: the user picks).
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
export function successorOk(
  cx: ServerCtx,
  room: string,
  g: unknown,
  to?: string
): CheckedWire2 | null {
  const v = validate2(g, null)
  if (!v.ok || v.wire.ev.t !== 'genesis') return null
  const c = v.wire.c as { rules?: unknown; from?: { srv?: unknown } } | null
  if (!knownRules(c?.rules) || c?.from?.srv !== room) return null
  if ((c.rules as number) < (cx.sumOf(room).rules ?? 0)) return null
  if (to !== undefined && v.wire.ev.a !== to) return null
  return v.wire
}

export function onTransfer(cx: ServerCtx, m: Message, s: Session, kind: 'take' | 'cosign') {
  const from = s.remote?.ik
  const room = m.room
  if (!from || typeof room !== 'string') return s.strike(malformed('room'))
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
  if (cx.xferAsks.size >= cx.local.server.coOwnerAsks && !cx.xferAsks.has(key)) return answer(false)
  const gname = (gen.ok ? gen.wire.c?.name : undefined) ?? g?.c?.name
  cx.xferAsks.set(key, {
    kind,
    from,
    room,
    name: typeof gname === 'string' ? clip(gname, cx.local.server.nameMax) : 'P2P server',
    to: kind === 'take' ? cx.me : (g?.ev.a ?? ''),
    ...(g ? { g } : {}),
    s,
  })
  const drop = () => {
    if (cx.xferAsks.delete(key)) cx.changed('')
  }
  s.onClose(drop)
  cx.clock.set(drop, cx.local.server.coOwnerMs)
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
// do (`from` names the room it follows).
export async function successorOf(cx: ServerCtx, room: string): Promise<WireV2> {
  const author = await cx.author()
  const dk = keyId(author.dk.pk)
  const s = cx.sumOf(room)
  const bare: Record<string, unknown> = {
    rules: RULES_VERSION,
    nonce: b64u(randomBytes(16)),
    owners: [{ ik: cx.me, dk }],
    everyone_bits: carriedBits(s.everyone, true, s.rules),
    name: nameOf(s, cx.local.display)?.name ?? 'P2P server',
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

// The follow rule: with exactly one upgrade, the new copy is followed: its owner
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
  const old = cx.rooms.get(room)
  // What we set for ourselves in the old copy is written into the new one once we are in.
  if (!cx.rooms.has(next))
    await cx.putRoom({
      ...blankRoom(next, '', now),
      kind: 'server',
      name: old?.name ?? 'P2P server',
      chans: {},
      server: null,
      since: now,
      prev: room,
      ...(old?.profile ? { profile: old.profile } : {}),
      ...(owner
        ? { carry: { from: room, roles: {}, state: 'running' as const } }
        : { joining: { at: now, via: 'invite' as const } }),
    })
  if (owner) {
    await cx.locked(next, async () => {
      if (await cx.db.get('events', next)) return
      await cx.withDevice(keyId((await cx.author()).dk.pk), () => cx.take(next, next, v.wire, now))
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

// The new owner carries the old copy over (as owner events), as it
// was at the upgrade (project(Eval_S(B(u))), not as it is now): first the `migrate` content
// (who was a member, who banned, and each device's last message at the transfer: the old copy
// shows here only up to there, without the new copy's banned members), then an invite for each
// member, so they join and acknowledge the rest; then the channels with their ids, the
// settings, the roles and the bans, and a last `migrate` chunk that says it is done. Finished
// steps are recorded, so a start resumes after them and never redoes one that was changed
// since; limits that clear by themselves (W3) are waited out, and anything else stops
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
      if ((rt.carryTries = (rt.carryTries ?? 0) + 1) <= cx.local.server.carryTries)
        cx.clock.set(() => void cx.carryOver(to).catch(() => {}), cx.local.server.carryRetryMs)
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
    for (const c of channelsOf(
      { ...emptySummary(), rules: cx.sumOf(from).rules, channels: s.channels },
      cx.local.display
    ))
      steps.push([
        `c:${c.id}`,
        async () => {
          if (!cur().channels[c.id])
            await cx.emit(to, 'channel', () => ({ ...knownChannel(c), id: c.id }))
        },
      ])
    const register = (reg: CarryRegister) => {
      for (const k of reg.keys(s))
        steps.push([
          reg.step(k),
          async () => {
            if (!reg.has(cur(), k))
              await cx.emit(to, reg.type, () => reg.content(s, k, carry.roles))
          },
        ])
    }
    for (const reg of CARRY_REGISTERS) if (!reg.afterRoles) register(reg)
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
          const made = await cx.emit(to, 'role_create', () =>
            carriedRole(role, cx.sumOf(from).rules)
          )
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
            const rule = carriedRule(o, cx.sumOf(from).rules)
            if (now?.allow === rule.allow && now?.deny === rule.deny) return
            await cx.emit(to, 'chperm', () => ({ ch, subj: target, ...rule }))
          },
        ])
    for (const reg of CARRY_REGISTERS) if (reg.afterRoles) register(reg)
    for (const ik of s.bans)
      steps.push([
        `b:${ik}`,
        async () => {
          if (membershipOf(cur(), ik) !== 'ban')
            await cx.emit(to, 'ban', () => ({
              to: ik,
              seen: {},
              ...carriedBan(cx.sumOf(from).members[ik], cur().rules),
            }))
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

// The upgrade of `from` that names the new copy `to`.
export async function upgradeOf(cx: ServerCtx, from: string, to: string) {
  for (const id of cx.sumOf(from).upgrades ?? []) {
    const up = await cx.db.get('events', id)
    const g = up ? cx.successorOk(from, (serverWire(up).c as { g?: unknown } | null)?.g) : null
    const v = g ? validate2(g, null) : null
    if (v?.ok && v.id === to) return id
  }
  return null
}

// The old copy as the upgrade `up` carries it, kept while it is in use.
export async function carriedOf(cx: ServerCtx, from: string, up: string) {
  const rt = cx.ensureRt(from)
  if (rt.carried?.up !== up) {
    const s = await cx.host.carried(from, up)
    if (!s) return null
    rt.carried = { up, s }
  }
  return rt.carried.s
}

// `migrate` content: the members and bans the upgrade carries, and the last message
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
  const per = cx.local.server.migratePer
  split('members', [...s.members].sort(), per)
  split('bans', [...s.bans].sort(), per)
  split('marks', Object.entries(marks), per)
  return out
}

// The `migrate` content an owner of this copy posted, once every chunk is here, and
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

// A member of a new copy acknowledges the owner's carry-over (W3(b): an owner alone
// waits after 24 changes nobody else acknowledged): a mark once 20 more ACL events of an owner
// arrived (other members' marks never count), at most one a minute, until the carry-over says
// it is done. An owner who stops (gone, stalled, failed) gets no more, nor one who goes on past
// what the carry-over holds (the old copy at the upgrade, which we hold too) or whose carry-over
// made no progress here for a day while we ran. The baseline and count are in the room record.
export function ackCarry(cx: ServerCtx, room: string, rt: Rt) {
  const r = cx.rooms.get(room)
  const s = cx.sumOf(room)
  const now = cx.clock.now()
  const lim = cx.local.server
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
    rt.carryAckCount = kept ? a.base : s.ownerCount - lim.carryAck
    rt.carryAcks = kept ? a.n : 0
  }
  if (rt.carryDone || rt.carryAcks >= (rt.carryMax ?? r.carryMax ?? lim.carryAcksMax)) return
  if (now - rt.carryAt > lim.carryWindowMs) return
  if (s.ownerCount - rt.carryAckCount < lim.carryAck) return
  const later = (ms: number) =>
    (rt.carryAckLater ??= cx.clock.set(() => {
      rt.carryAckLater = undefined
      cx.ackCarry(room, rt)
    }, ms))
  // Too soon after the last one: later, as the owner may be waiting for it (nothing new comes).
  const gap = lim.carryAckGapMs
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

// The member list the new owner carried over, against the old copy's at the
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
    if (!rt.checkLater && tries < cx.local.server.checkTries)
      rt.checkLater = cx.clock.set(() => {
        rt.checkLater = undefined
        void cx.checkMigrated(room, prev, tries + 1).catch(() => {})
      }, cx.local.server.checkRetryMs)
    return
  }
  // What the carry-over posts, at most, from what the upgrade carries (known before any of it
  // is here): what bounds our acknowledgements of it, with room for about 100 changes of the
  // owner's own meanwhile. Every carried event counts: overwrites and `migrate` chunks too.
  const old = cx.sumOf(prev)
  const devices = at.members.reduce((n, ik) => n + (old.members[ik]?.devs.length || 1), 0)
  const chunks = [at.members.length, at.bans.length, devices].reduce(
    (n, k) => n + Math.max(1, Math.ceil(k / cx.local.server.migratePer)),
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
  rt.carryMax = Math.ceil(size / cx.local.server.carryAck) + 5
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
  const lim = cx.local.server
  for (let i = 0; i < lim.stepTries && cx.rooms.has(room); i++) {
    try {
      await step()
      return null
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      if (why !== LONE_TEXT && why !== QUICK_TEXT && why !== SYNC_TEXT) return why
      last = why
      await waiting(why)
      await new Promise<void>(done => cx.clock.set(done, lim.stepRetryMs))
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
  // What the old copy says now: a role taken away concurrently with the transfer isn't given
  // back.
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
  for (const reg of CARRY_MEMBER_REGISTERS)
    for (const ik of old.members) {
      const key = `\n${reg.type}\n${ik}`
      const cur = cx.sumOf(room)
      if (given.has(key) || ik === cx.me || cur.members[ik]?.m !== 'join') continue
      if (cx.rooms.get(room)?.carry?.given?.includes(key)) continue
      given.add(key)
      const content = reg.has(cur, ik) ? null : reg.content(old, ik, now, cur, cx.clock.now())
      if (content) await cx.emit(room, reg.type, () => content)
      await cx.updateRoom(room, x =>
        x.carry ? { ...x, carry: { ...x.carry, given: [...(x.carry.given ?? []), key] } } : x
      )
    }
}
