import { isRecord } from '../../bytes'
import { bytesOf, canonical, isInt } from '../canonical'
import { AGREED, LOCAL, type Agreed, type Local } from '../limits'
import type { EvalResult, Facts, FactsQ } from './facts'
import {
  atLeast,
  bit,
  channelMask,
  checkBitsEdit,
  checkOverwriteEdit,
  fromWire,
  hasBit,
  managesRole,
  maskAnd,
  maskNot,
  mayAssign,
  mayModerate,
  mayUnassign,
  outranks as above,
  toWire,
  type Actor,
  type Rank as PermRank,
} from '../../perms'

// The rules of P2P server ACL events: event classes, the Authority column (what
// an event relies on, so what a deny can take away), the guards (admission only) and the
// protection predicates. A port of the reference model's model.ts.

export type Rank = readonly [number, string]
export const TOP: Rank = [Infinity, '']
export const BOT: Rank = [-1, '']
export const NEG: Rank = [-Infinity, '']
export const cmp = (a: Rank, b: Rank) =>
  a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0
export const gt = (a: Rank, b: Rank) => cmp(a, b) > 0
export const minR = (a: Rank, b: Rank) => (cmp(a, b) <= 0 ? a : b)
export const rkey = (r: Rank) => `${r[0]}/${r[1]}`

export const P = {
  ManageChannels: 1,
  ManageMessages: 2,
  Kick: 4,
  ManageServer: 8,
  ManageRoles: 16,
  Ban: 32,
  Invite: 64,
  MentionEveryone: 128,
  ViewChannel: 256,
  SendMessages: 512,
  TimeoutMembers: 16777216,
} as const
export const KICK = P.Kick
export const BAN = P.Ban
export const ROLES = P.ManageRoles
export const INVITE = P.Invite
export const SERVER = P.ManageServer
export const CHANNELS = P.ManageChannels
export const MESSAGES = P.ManageMessages
export const MENTION = P.MentionEveryone
export const SEND = P.SendMessages
export const VIEW = P.ViewChannel
// Reset server profiles: read from rules RULES_NEXT on. Up to rules 4, Kick stands in for it.
export const PROFILES = 8388608
export const TIMEOUT = P.TimeoutMembers
// Change server profile: read from rules RULES_NEXT on. Before, every member may.
export const CHANGE_PROFILE = 4194304
export const ALL = 0x7fffffff
export const MODBITS = KICK | BAN | ROLES | CHANNELS | SERVER | MESSAGES
export const EVERYONE = 'everyone'
export const RULES_VERSION = 4
// The next rules version: channel permissions follow the hosted semantics from it on.
export const RULES_NEXT = 5
// The rules version permissions are decided under: a room's own, or the current one.
export const rulesOf = (rules: unknown): number =>
  rules === 2 || rules === RULES_VERSION || rules === RULES_NEXT ? rules : RULES_VERSION
const atNext = (rules: unknown) => typeof rules === 'number' && rules >= RULES_NEXT
export const knownRules = (rules: unknown) => rules === 2 || rules === RULES_VERSION
// The bit a moderator needs to reset another member's room profile under `rules`.
export const resetBit = (rules: unknown) =>
  typeof rules === 'number' && rules >= RULES_NEXT ? PROFILES : KICK
// Whether `a` may set a room profile of their own under `rules`, holding what `F` says.
export const changesProfile = (
  rules: unknown,
  F: Pick<FactsQ, 'owners' | 'bits' | 'holds'>,
  a: string
) => !atNext(rules) || (permsQ(F, a) & CHANGE_PROFILE) !== 0
export function textOnlyChannel(rules: unknown, channel: AclContent | undefined) {
  return (
    rules === RULES_VERSION && (channel?.kind ?? 'text') === 'text' && channel?.text_only === true
  )
}

export function richMessage(c: Record<string, unknown>) {
  return (
    c.att !== undefined ||
    c.poll !== undefined ||
    (isRecord(c.fwd) && (c.fwd.att !== undefined || c.fwd.poll !== undefined))
  )
}

// Production values (ts in ms).
export const PRODUCTION_LIMITS: Readonly<Agreed> = AGREED

export interface Owner {
  ik: string
  dk?: string
  dcert?: string
  [k: string]: unknown
}

// ACL event content. Each type reads only its own fields; `aclContentOk` checks their
// types, so a field a type reads is either absent or of the type given here.
export interface AclContent {
  [k: string]: unknown
  to: string
  role: string
  pos: number
  bits: number
  bit: number
  on: boolean
  dk: string
  ik: string
  h: string
  code?: string
  seen?: number | Record<string, number>
  keep?: string[]
  pcert?: string
  dcert?: string
  idb?: { ik?: unknown; dcert?: unknown }
  owners?: Owner[]
  everyone_bits?: number
  sigs?: Record<string, string>
  wipe?: boolean
  until?: number
  reason?: string
  purge_h?: number
  rules?: number
  from?: { srv: string }
  id?: string
  ch?: string
  subj?: string
  allow?: number
  deny?: number
}

// `a` is the acting identity. A device_revoke that another member relays acts for the
// record's `ik` in facts, k, self-deny and protection: then `a` is that identity and `relay` the
// member whose device `dev` signed it; everything else counts it as the relayer's (admit.ts). A
// relayed primary_rotate is refused: two members could carry one record concurrently, and two
// concurrent rotations are rotation evidence, which only the recovery key may create.
export interface AclEv {
  id: string
  t: string
  a: string
  relay?: string
  dev: string
  seq: number
  ap: string[]
  aprev?: string
  iprev?: string
  ts: number
  c: AclContent
}

export type Cls = 'G' | 'D' | 'R' | 'A'

// What admission records for an admitted event.
export interface Rec {
  k: Rank
  cls: Cls
  self: boolean
  exempt: boolean
  depth: number
  epoch: string
  local: EvalResult
  // U(e), by poster: a relayed revocation is in its relayer's
  pool?: string[]
}

// What admission and evaluation read of a replica: its events, their admission records, and the
// limits its server agreed on.
export interface Ctx {
  ev(id: string): AclEv
  rec(id: string): Rec
  readonly lim: Agreed
  // The evaluator's device-local limits (the account's); absent, the registry's.
  readonly local?: EvalLimits
}

// limits.ts `acl` and `cache`: what one device's evaluator keeps and walks.
export type EvalLimits = Pick<Local, 'acl' | 'cache'>

export const evalLimits = (cx: Ctx): EvalLimits => cx.local ?? LOCAL

export const ownersOf = (c: AclContent): string[] => (c.owners ?? []).map(o => o.ik)

export const isFixedT = (t: string) =>
  t === 'genesis' || t === 'device_revoke' || t === 'primary_rotate'
export const isRevocationT = (t: string) => t === 'device_revoke' || t === 'primary_rotate'
export const isWithdrawalT = (t: string) => t === 'uninvite' || t === 'code_revoke'

// Identity ops sit on the identity chain (`iprev`): genesis, device_add, primary_rotate, and a
// join that introduces its device.
export const idOp = (e: AclEv, F: FactsQ | undefined) =>
  e.t === 'genesis' ||
  e.t === 'device_add' ||
  e.t === 'primary_rotate' ||
  (e.t === 'join' && !(F?.devs.get(e.a)?.has(e.dev) ?? false))

export const relayed = (e: AclEv) => e.relay !== undefined && e.relay !== e.a
// The identity whose device signed e: its relayer, or its author.
export const poster = (e: AclEv) => (relayed(e) ? e.relay! : e.a)

// Devices an event introduces: its own device, and a rotation's keep list.
export function introduces(e: AclEv): string[] {
  if (e.t === 'genesis' || e.t === 'join' || e.t === 'device_add') return [e.dev]
  if (e.t === 'primary_rotate') return [e.dev, ...(e.c.keep ?? [])]
  return []
}

export function rankOf(F: FactsQ, R: string): Rank {
  if (R === EVERYONE) return BOT
  return [F.pos.get(R) ?? -1, R]
}
export function rank(F: FactsQ, P: string): Rank {
  if (F.owners.has(P)) return TOP
  if (!F.mem.has(P)) return NEG
  let r: Rank = BOT
  for (const R of F.holds.get(P) ?? []) if (gt(rankOf(F, R), r)) r = rankOf(F, R)
  return r
}
export function permsQ(F: Pick<FactsQ, 'owners' | 'bits' | 'holds'>, P: string): number {
  if (F.owners.has(P)) return ALL
  let m = F.bits.get(EVERYONE) ?? 0
  for (const R of F.holds.get(P) ?? []) m |= F.bits.get(R) ?? 0
  return m
}
export const perms = permsQ

// Monotone authority: resources (what the author holds) are read in Fr,
// obstacles (what it acts against) in Fo. In the admission state both are St(e).
export interface AuthCtx {
  Fr: FactsQ
  Fo: FactsQ
  readonly me: Rank
  rankOf: (R: string) => Rank
  rankT: (T: string) => Rank
  // The room's rules version, and the channels and overwrites of the state the author's
  // resources are read in.
  rules?: number
  chan?: ChanReader
}
// The channels and overwrites of one state.
export interface ChanReader {
  channel: (ch: string) => AclContent | undefined
  overwrite: (ch: string, subj: string) => AclContent | undefined
  // The overwrites of `subj`, each with its channel.
  rows: (subj: string) => [string, AclContent][]
}
const readerOf = (F: Partial<Pick<Facts, 'overwrites' | 'channels'>>): ChanReader => ({
  channel: ch => F.channels?.get(ch),
  overwrite: (ch, subj) => F.overwrites?.get(ch)?.get(subj),
  rows: subj =>
    [...(F.overwrites ?? [])].flatMap(([ch, rows]): [string, AclContent][] => {
      const o = rows.get(subj)
      return o ? [[ch, o]] : []
    }),
})
export const simpleCtx = (F: FactsQ, a: string): AuthCtx => ({
  Fr: F,
  Fo: F,
  rules: (F as Partial<Facts>).rules,
  chan: readerOf(F as Partial<Facts>),
  me: rank(F, a),
  rankOf: R => rankOf(F, R),
  rankT: T => rank(F, T),
})

// The authority of content events through authCore: a redaction of another member's
// message needs Manage messages and a rank above its author, a pin needs Manage messages; any
// other content needs Mem (and Dev). These type names can't be ACL types.
export const CONTENT_REDACT = 'c:redact'
export const CONTENT_PIN = 'c:pin'

// A rank as the shared permission rules read it.
export const tiered = (r: Rank): PermRank =>
  r[0] === Infinity
    ? { tier: 'owner' }
    : r[0] === -Infinity
      ? { tier: 'outside' }
      : r[0] === -1 && r[1] === ''
        ? { tier: 'plain' }
        : { tier: 'role', pos: r[0], tie: r[1] }

// Wire bits as the shared rules read them: the mask of the bits these rules know, and the rest.
const split = (wire: number, rules: number) => {
  const mask = fromWire(wire, rules)
  return { mask, rest: wire & ~toWire(mask, rules) }
}
const splits = new Map<number, Map<number, { mask: number; rest: number }>>()
const splitOf = (wire: number, rules: number) => {
  let byWire = splits.get(rules)
  if (!byWire) splits.set(rules, (byWire = new Map()))
  let s = byWire.get(wire)
  if (!s) {
    if (byWire.size >= 4096) byWire.clear()
    byWire.set(wire, (s = split(wire, rules)))
  }
  return s
}

// The shared permission rules decide whether a mask holds a bit, whether a rank is above
// another, who moderates whom, who manages a role and who may give or take one. Wire bits they
// do not know are compared bit for bit.
export function authCore(e: AclEv, x: AuthCtx, rules = rulesOf(x.rules)): boolean {
  const a = e.a
  const c = e.c
  const Fr = x.Fr
  const Fo = x.Fo
  const isMem = Fr.mem.has(a)
  const held = () => splitOf(permsQ(Fr, a), rules)
  const has = (b: number) => {
    const mine = held()
    const asked = splitOf(b, rules)
    return hasBit(mine.mask, asked.mask) || (mine.rest & asked.rest) !== 0
  }
  const within = (bits: number) => {
    const mine = held()
    const asked = splitOf(bits, rules)
    return (
      checkBitsEdit(mine.mask, false, 0, asked.mask) === null && (asked.rest & ~mine.rest) === 0
    )
  }
  const outranks = (r: Rank) => above(tiered(x.me), tiered(r))
  const actor = (): Actor => ({ rank: tiered(x.me), bits: held().mask })
  const at = (r: Rank): Actor => ({ rank: tiered(r), bits: 0 })
  const moderates = (need: number, to: string) =>
    mayModerate(actor(), at(x.rankT(to)), fromWire(need, rules), false)
  const manages = (r: Rank) => managesRole(actor(), tiered(r))
  // Whether every overwrite of a live channel that allows something to `role` allows only what
  // the author holds in that channel.
  const allowsWithin = (role: string) => {
    const chan = x.chan ?? readerOf({})
    const live = (ch: string) => {
      const c = chan.channel(ch)
      return c !== undefined && c.gone !== true
    }
    return chan
      .rows(`r:${role}`)
      .every(
        ([ch, o]) =>
          !live(ch) ||
          maskAnd(fromWire(o.allow ?? 0, rules), maskNot(maskIn(Fr, chan, a, ch, rules))) === 0
      )
  }
  const codeLive = (cid: string) => Fr.codeOk.has(cid) && !Fo.codeDead.has(cid)
  switch (e.t) {
    case 'genesis':
      return false
    case 'add':
      return isMem && has(INVITE) && !Fr.ban.has(c.to) && (c.code === undefined || codeLive(c.code))
    case 'uninvite': {
      const ps = Fo.invited.get(c.to) ?? []
      return isMem && ps.every(p => p.a === a || (has(KICK) && outranks(p.k)))
    }
    case 'join':
      return (
        !Fr.ban.has(a) &&
        (Fr.owners.has(a) ||
          (Fr.addsTo.get(a) ?? []).some(
            g => !Fo.consumed.has(g.id) && (g.code === undefined || codeLive(g.code))
          ))
      )
    case 'kick':
      return isMem && !Fr.owners.has(c.to) && moderates(KICK, c.to)
    case 'ban':
      return (
        isMem && !Fr.owners.has(c.to) && moderates(BAN, c.to) && (c.wipe !== true || has(MESSAGES))
      )
    case 'unban':
      return (
        isMem &&
        has(BAN) &&
        (Fr.effBanK.get(c.to) ?? []).every(kb => atLeast(tiered(x.me), tiered(kb)))
      )
    case 'timeout':
      if (!atNext(Fr.rules)) return isMem
      return isMem && has(TIMEOUT) && !Fr.owners.has(c.to) && outranks(x.rankT(c.to))
    case 'role_create':
      return isMem && manages([c.pos, e.id]) && within(c.bits)
    case 'role_move':
      return isMem && Fr.roles.has(c.role) && manages(x.rankOf(c.role)) && manages([c.pos, c.role])
    case 'role_bits':
      return (
        isMem &&
        (c.role === EVERYONE || Fr.roles.has(c.role)) &&
        manages(x.rankOf(c.role)) &&
        (!c.on || has(c.bit))
      )
    case 'role_del':
      return isMem && Fr.roles.has(c.role) && manages(x.rankOf(c.role))
    case 'assign': {
      if (!isMem || !Fr.roles.has(c.role) || Fr.owners.has(c.to)) return false
      const role = tiered(x.rankOf(c.role))
      const target = at(x.rankT(c.to))
      if (rules < RULES_NEXT) return mayAssign(actor(), role, 0, true, target, rules)
      // The role's permissions and what its overwrites allow must be within the author's.
      return mayAssign(
        actor(),
        role,
        fromWire(Fr.bits.get(c.role) ?? 0, rules),
        allowsWithin(c.role),
        c.to === a ? undefined : target,
        rules
      )
    }
    case 'revoke':
      return (
        isMem &&
        mayUnassign(actor(), tiered(x.rankOf(c.role)), c.to === a ? undefined : at(x.rankT(c.to)))
      )
    case 'code':
      return isMem && has(INVITE)
    case 'code_revoke': {
      const iss = c.code === undefined ? undefined : Fr.codeIssuer.get(c.code)
      return isMem && iss !== undefined && (iss === a || (has(SERVER) && outranks(x.rankT(iss))))
    }
    case 'settings':
      return isMem && has(SERVER)
    case 'channel':
      return isMem && has(CHANNELS)
    case 'chperm': {
      if (!isMem || !has(CHANNELS)) return false
      const subj = typeof c.subj === 'string' ? c.subj : ''
      const ranked = subj.startsWith('r:')
        ? outranks(x.rankOf(subj.slice(2)))
        : subj.startsWith('u:') && outranks(x.rankT(subj.slice(2)))
      if (!ranked || rules < RULES_NEXT || Fr.owners.has(a)) return ranked
      // The edit may allow, or stop denying, only what its author holds in the channel, and
      // deny a moderation bit only when the author holds it.
      const ch = typeof c.ch === 'string' ? c.ch : ''
      const chan = x.chan ?? readerOf({})
      const row = (o: AclContent | undefined) => {
        const allow = fromWire(o?.allow ?? 0, rules)
        const deny = fromWire(o?.deny ?? 0, rules)
        return allow === 0 && deny === 0 ? undefined : { allow, deny }
      }
      const mine = maskIn(Fr, chan, a, ch, rules)
      return checkOverwriteEdit(mine, false, row(chan.overwrite(ch, subj)), row(c), true) === null
    }
    case 'device_add':
      return isMem && !Fr.revoked.has(e.dev)
    case 'upgrade':
    case 'migrate':
      return isMem && Fr.owners.has(a)
    case CONTENT_REDACT: {
      if (!isMem) return false
      if (c.to === a || Fr.owners.has(a)) return true
      const holds =
        rules < RULES_NEXT ? has(MESSAGES) : heldBy(Fr, x.chan, a, c.ch, 'DeleteMessages', rules)
      return holds && outranks(x.rankT(c.to))
    }
    case CONTENT_PIN:
      return (
        isMem &&
        (rules < RULES_NEXT ? has(MESSAGES) : heldBy(Fr, x.chan, a, c.ch, 'PinMessages', rules))
      )
    default:
      return isMem
  }
}

// The Authority column in one state (admission: St(e)).
export const authority = (e: AclEv, F: FactsQ): boolean => authCore(e, simpleCtx(F, e.a))

const sameValue = (x: unknown, y: unknown) => {
  if (x === undefined || y === undefined) return x === y
  try {
    return canonical(x) === canonical(y)
  } catch {
    return false
  }
}

// Guards: target-state, cap and no-op checks, enforced at admission only, never a reason to cut.
export function guards(e: AclEv, F: Facts, L: Agreed): boolean {
  if (F.upgraded.length && e.t !== 'leave') return false
  const a = e.a
  const c = e.c
  const holds = (T: string, R: string) => F.holds.get(T)?.has(R) ?? false
  switch (e.t) {
    case 'add':
      return c.to !== a && !F.mem.has(c.to) && !F.pending.has(c.to)
    case 'uninvite':
      return F.pending.has(c.to)
    case 'join':
      return !F.mem.has(a)
    case 'kick':
      return c.to !== a && F.mem.has(c.to)
    case 'ban':
      return c.to !== a && !F.ban.has(c.to)
    case 'unban':
      return F.ban.has(c.to)
    case 'timeout':
      return !atNext(F.rules) || (c.to !== a && F.mem.has(c.to))
    case 'role_create':
      return c.pos >= 0
    case 'role_move':
      return c.pos >= 0 && c.pos !== F.pos.get(c.role)
    case 'role_bits': {
      const cur = ((F.bits.get(c.role) ?? 0) & c.bit) !== 0
      return c.on ? !cur : cur
    }
    case 'role_del':
      return c.role !== EVERYONE && mayLift(F, a, c.role)
    case 'assign':
      return c.to !== a && F.mem.has(c.to) && !holds(c.to, c.role)
    case 'revoke':
      // Taking away a role that a live channel's overwrites restrict widens access there:
      // owners and ManageChannels only, oneself included (the model has no chperm).
      // Deleting it takes it from everyone, so the same holds there.
      return holds(c.to, c.role) && mayLift(F, a, c.role)
    case 'code':
      return typeof c.h === 'string'
    case 'code_revoke':
      return c.code !== undefined && F.codes.has(c.code)
    case 'profile':
      return !sameValue(F.profile.get(a), c)
    case 'settings':
      return !sameValue(F.setting, c)
    case 'channel': {
      if (typeof c.id !== 'string') return false
      const cur = F.channels.get(c.id)
      if (c.gone === true || (cur !== undefined && cur.gone !== true)) return true
      let live = 0
      for (const x of F.channels.values()) if (x.gone !== true) live++
      return live < L.channels
    }
    case 'chperm': {
      if (typeof c.ch !== 'string' || typeof c.subj !== 'string') return false
      const ov = F.overwrites.get(c.ch)
      return ov === undefined || ov.has(c.subj) || ov.size < L.overwrites
    }
    case 'device_add': {
      const d = F.devs.get(a)
      return !(d?.has(e.dev) ?? false) && (d?.size ?? 0) < L.devCap
    }
    case 'device_revoke':
      return (
        c.ik === a &&
        (!relayed(e) || F.mem.has(e.relay!)) &&
        (F.devs.get(a)?.has(c.dk) ?? false) &&
        c.dk !== e.dev
      )
    case 'primary_rotate': {
      const d = F.devs.get(a)
      const keep: unknown = c.keep ?? []
      return (
        c.ik === a &&
        !relayed(e) &&
        Array.isArray(keep) &&
        keep.every(v => typeof v === 'string' && (d?.has(v) ?? false) && v !== e.dev) &&
        new Set([...keep, e.dev]).size <= L.devCap
      )
    }
    case 'upgrade': {
      const sigs = c.sigs ?? {}
      return [...F.owners].filter(o => o !== a).every(o => typeof sigs[o] === 'string')
    }
    case 'migrate':
      return F.from !== undefined
    default:
      return true
  }
}

// Whether role `R` has an overwrite in a live channel with a deny, or an allow short of
// ViewChannel and SendMessages: the rows that hold its holders back there.
export const restricts = (F: Pick<Facts, 'overwrites' | 'channels'>, R: string) => {
  for (const [ch, ov] of F.overwrites) {
    const o = ov.get(`r:${R}`)
    const c = F.channels.get(ch)
    if (!o || !c || c.gone === true) continue
    const allow = o.allow ?? 0
    if ((o.deny ?? 0) !== 0 || (allow !== 0 && (allow & (VIEW | SEND)) !== (VIEW | SEND)))
      return true
  }
  return false
}

const mayLift = (F: Facts, a: string, R: string) =>
  !restricts(F, R) || F.owners.has(a) || (permsQ(F, a) & CHANNELS) !== 0

// What channel permissions read (the page reads them from its summary too).
export type ChanFacts = Pick<FactsQ, 'owners' | 'bits' | 'holds'> &
  Pick<Facts, 'overwrites' | 'channels' | 'rules'>

// P's canonical mask in channel `ch` under `rules`.
function maskIn(
  F: Pick<FactsQ, 'owners' | 'bits' | 'holds'>,
  chan: ChanReader,
  P: string,
  ch: string,
  rules: number
): number {
  const c = chan.channel(ch)
  return maskUnder(
    permsQ(F, P),
    F.owners.has(P),
    {
      everyone: chan.overwrite(ch, `r:${EVERYONE}`),
      roles: [...(F.holds.get(P) ?? [])].flatMap(R => chan.overwrite(ch, `r:${R}`) ?? []),
      member: chan.overwrite(ch, `u:${P}`),
    },
    { restrictView: c?.restrict_view === true, restrictSend: c?.restrict_send === true },
    rules
  )
}

type WireRow = { allow?: number; deny?: number } | undefined

// What a member holding `bits` (wire; an owner holds every bit) has in a channel or category
// under its rules for @everyone, the member's roles and the member (wire rows), as admission
// reads it and as the editors check a rule change before it is made.
export const maskUnder = (
  bits: number,
  owner: boolean,
  rows: { everyone: WireRow; roles: WireRow[]; member: WireRow },
  place: { restrictView: boolean; restrictSend: boolean },
  rules: number
): number => {
  const row = (o: WireRow) =>
    o && { allow: fromWire(o.allow ?? 0, rules), deny: fromWire(o.deny ?? 0, rules) }
  return channelMask(
    owner ? { kind: 'owner' } : { kind: 'member', roles: fromWire(bits, rules) },
    0,
    {
      everyone: row(rows.everyone),
      restrictView: place.restrictView,
      restrictSend: place.restrictSend,
      roles: rows.roles.flatMap(o => row(o) ?? []),
      member: row(rows.member),
    },
    rules
  )
}

// Whether P holds the permission `name` of the shared rules in channel `ch`.
const heldBy = (
  F: Pick<FactsQ, 'owners' | 'bits' | 'holds'>,
  chan: ChanReader | undefined,
  P: string,
  ch: unknown,
  name: string,
  rules: number
) => hasBit(maskIn(F, chan ?? readerOf({}), P, typeof ch === 'string' ? ch : '', rules), bit(name))
export const holdsIn = (
  F: ChanFacts,
  P: string,
  ch: string,
  name: string,
  rules = rulesOf(F.rules)
) => heldBy(F, readerOf(F), P, ch, name, rules)

// What content of P in channel `ch` relies on besides sending. Up to rules 4, Manage messages
// pins and deletes, and with Manage channels it leaves slow mode out; from rules 5 each has its
// own permission in the channel.
export const mayPin = (F: ChanFacts, P: string, ch: string, rules = rulesOf(F.rules)) =>
  rules < RULES_NEXT ? (permsQ(F, P) & MESSAGES) !== 0 : holdsIn(F, P, ch, 'PinMessages', rules)
export const mayDelete = (F: ChanFacts, P: string, ch: string, rules = rulesOf(F.rules)) =>
  rules < RULES_NEXT ? (permsQ(F, P) & MESSAGES) !== 0 : holdsIn(F, P, ch, 'DeleteMessages', rules)
export const mayMentionEveryone = (
  F: ChanFacts,
  P: string,
  ch: string,
  rules = rulesOf(F.rules)
) =>
  rules < RULES_NEXT ? (permsQ(F, P) & MENTION) !== 0 : holdsIn(F, P, ch, 'MentionEveryone', rules)
export const skipsSlowMode = (F: ChanFacts, P: string, ch: string, rules = rulesOf(F.rules)) =>
  rules < RULES_NEXT
    ? (channelPerms(F, P, ch, rules) & (CHANNELS | MESSAGES)) !== 0
    : holdsIn(F, P, ch, 'BypassSlowmode', rules)

// What a content event of kind `t` with content `c` (null: held without it) needs its author
// to hold in its channel from rules 5 on: a reaction Add reactions (taking one back only View),
// a deletion View (whose message it may take is authCore's), a pin Pin messages and Send
// messages, a message with files Attach files with Send messages, anything else Send messages.
// The answer names the first one missing, or null.
export function contentLack(
  F: ChanFacts,
  P: string,
  ch: string,
  t: string,
  c: Record<string, unknown> | null,
  rules = rulesOf(F.rules)
): 'send' | 'react' | 'pin' | 'attach' | null {
  const holds = (name: string) => holdsIn(F, P, ch, name, rules)
  if (t === 'react') {
    if (c !== null && c.on === true) return holds('AddReactions') ? null : 'react'
    return holds('ViewChannels') ? null : 'react'
  }
  if (t === 'redact') return holds('ViewChannels') ? null : 'send'
  if (!holds('SendMessages')) return 'send'
  if (t === 'pin') return holds('PinMessages') ? null : 'pin'
  const files = c !== null && (c.att !== undefined || (isRecord(c.fwd) && c.fwd.att !== undefined))
  return t === 'msg' && files && !holds('AttachFiles') ? 'attach' : null
}

// P's permissions in channel `ch`, in Discord order: P's permissions, the @everyone overwrite,
// the channel's restrictions (restrict_view and restrict_send clear ViewChannel and SendMessages
// from that baseline), the denies then the allows of P's roles' overwrites, and P's own
// overwrite. Below rules 5, owners and holders of Manage channels have every bit. From rules 5,
// Manage channels passes the base bits, owners keep their moderation bits, and nobody holds
// anything without ViewChannel.
export function channelPerms(
  F: ChanFacts,
  P: string,
  ch: string,
  rules = rulesOf(F.rules)
): number {
  const mask = maskIn(F, readerOf(F), P, ch, rules)
  const every = rules < RULES_NEXT && (F.owners.has(P) || (permsQ(F, P) & CHANNELS) !== 0)
  return every ? ALL : toWire(mask, rules)
}
export const canView = (F: ChanFacts, P: string, ch: string, rules = rulesOf(F.rules)) =>
  (channelPerms(F, P, ch, rules) & VIEW) !== 0
// Whether everyone in the server sees channel `ch`: a member without roles may view it (no key
// is the empty string), and no overwrite denies ViewChannel to anyone.
export const everyoneSees = (F: ChanFacts, ch: string) =>
  canView(F, '', ch) &&
  ![...(F.overwrites.get(ch)?.values() ?? [])].some(o => ((o.deny ?? 0) & VIEW) !== 0)
// Sending needs ViewChannel and SendMessages.
export const canSend = (F: ChanFacts, P: string, ch: string, rules = rulesOf(F.rules)) =>
  (channelPerms(F, P, ch, rules) & (VIEW | SEND)) === (VIEW | SEND)

// The signing device is live for its identity (a relayer's, for a relayed record); join,
// device_add and primary_rotate establish their own device.
export function deviceOk(e: AclEv, F: FactsQ): boolean {
  if (relayed(e)) return F.devs.get(e.relay!)?.has(e.dev) ?? false
  if (e.t === 'join' || e.t === 'device_add' || e.t === 'primary_rotate')
    return !F.revoked.has(e.dev)
  return F.devs.get(e.a)?.has(e.dev) ?? false
}
export const authorizeFull = (e: AclEv, F: FactsQ) => deviceOk(e, F) && authority(e, F)

export const admissible = (e: AclEv, F: Facts, L: Agreed) => authorizeFull(e, F) && guards(e, F, L)

// Whether a holder of the wire permissions `wire` at rank `me` manages a role at rank `role`.
export const managesAt = (wire: number, me: Rank, role: Rank, rules: number) =>
  managesRole({ rank: tiered(me), bits: fromWire(wire, rules) }, tiered(role))

// Whether `a` outranks `b` in state F.
export const outranksIn = (F: FactsQ, a: string, b: string) =>
  above(tiered(rank(F, a)), tiered(rank(F, b)))

// role_meta has no case in authCore, guards or
// classify: it is admitted, cut and live by the generic rule, as a client that doesn't know the
// type reads it, so every version holds the same events and agrees on their liveness. Its
// Authority is read only inside RoleMeta(R): a write counts when it is well formed and its
// author, in St(w), has Manage roles, Role(R) holds and the author outranks R.
export const roleMetaOk = (e: AclEv, St: FactsQ) =>
  typeof e.c.role === 'string' &&
  (e.c.name === undefined || typeof e.c.name === 'string') &&
  (e.c.color === undefined ||
    (isInt(e.c.color, -Infinity) &&
      (e.c.color as number) >= 0 &&
      (e.c.color as number) <= 0xffffff)) &&
  St.roles.has(e.c.role) &&
  (St.owners.has(e.a) ||
    (St.mem.has(e.a) &&
      managesAt(
        permsQ(St, e.a),
        rank(St, e.a),
        rankOf(St, e.c.role),
        rulesOf((St as Partial<Facts>).rules)
      )))

// profile_mode is a register on the role_meta pattern: admitted, cut and live by the generic
// rule, with its Authority read only at display. A write counts when its mode is one of the
// three and its author, in St(w), is an owner or holds Manage server. A malformed one is not
// read.
export const profileModeOk = (e: AclEv, St: FactsQ) =>
  (e.c.mode === 'all' || e.c.mode === 'no_names' || e.c.mode === 'off') &&
  (St.owners.has(e.a) || (St.mem.has(e.a) && (permsQ(St, e.a) & SERVER) !== 0))

// profile_reset is a register on the role_meta pattern, keyed by the member it names (`to`):
// admitted, cut and live by the generic rule, with its Authority read only at display. A write
// counts when it names a member other than its author who is not an owner, and its author, in
// St(w), is an owner or holds `bit` (resetBit) and outranks that member. Its parts and lock end
// are read where it is shown; a malformed one is not read.
export const profileResetOk = (e: AclEv, St: FactsQ, bit: number) =>
  typeof e.c.to === 'string' &&
  e.c.to !== e.a &&
  St.mem.has(e.c.to) &&
  !St.owners.has(e.c.to) &&
  (St.owners.has(e.a) ||
    (St.mem.has(e.a) && (permsQ(St, e.a) & bit) !== 0 && outranksIn(St, e.a, e.c.to)))

// about (the server's description and icon) is a register on the role_meta pattern: admitted,
// cut and live by the generic rule, with its Authority read only at display. A write counts when
// its author, in St(w), is an owner or holds Manage server. Its fields are read one by one at
// display, a malformed one as unset.
export const aboutOk = (e: AclEv, St: FactsQ) =>
  St.owners.has(e.a) || (St.mem.has(e.a) && (permsQ(St, e.a) & SERVER) !== 0)

// member_list (who sees the member list) is a register on the role_meta pattern: admitted, cut
// and live by the generic rule, with its Authority read only at display. A write counts when its
// author, in St(w), is an owner or holds Manage server. Its fields are read one by one at
// display, a malformed one as unset.
export const memberListOk = aboutOk

const SHORT_ID_MAX = 64
const shortId = (x: unknown): x is string =>
  typeof x === 'string' && x !== '' && x.length <= SHORT_ID_MAX

// category ({id, name, pos, style?, gone?}, one register per id), chcat ({ch, cat, sync}, one
// per channel) and chsep ({id, label, pos, style?, cat?, gone?}, a separator of the channel
// list, one register per id) are registers like role_meta: no case in authCore, guards or
// classify. A write counts when it is well formed and its author, in St(w), is an owner or a
// member who holds Manage channels. A separator's place may be any finite number (between two
// others); its style and category are read where it is shown, a malformed one as unset.
export const channelMetaOk = (e: AclEv, St: FactsQ) => {
  const c = e.c
  const shaped =
    e.t === 'category'
      ? shortId(c.id) &&
        (c.gone === true || (typeof c.name === 'string' && isInt(c.pos, -Infinity)))
      : e.t === 'chsep'
        ? shortId(c.id) &&
          (c.gone === true ||
            (typeof c.label === 'string' && typeof c.pos === 'number' && Number.isFinite(c.pos)))
        : e.t === 'chcat' &&
          shortId(c.ch) &&
          (c.cat === null || shortId(c.cat)) &&
          typeof c.sync === 'boolean'
  return shaped && (St.owners.has(e.a) || (St.mem.has(e.a) && (permsQ(St, e.a) & CHANNELS) !== 0))
}

// store is admitted, cut and live by the generic rule, like role_meta. Its Authority is read only
// inside Store: a write counts when `on` is a boolean, `earlier` is absent or a boolean, and its
// author, in St(w), is an owner or a member with Manage server.
export const storeOk = (e: AclEv, St: FactsQ) =>
  typeof e.c.on === 'boolean' &&
  (e.c.earlier === undefined || typeof e.c.earlier === 'boolean') &&
  (St.owners.has(e.a) || (St.mem.has(e.a) && (permsQ(St, e.a) & SERVER) !== 0))

export function classify(e: AclEv, F: FactsQ): { cls: Cls; self: boolean } {
  switch (e.t) {
    case 'kick':
    case 'ban':
    case 'role_del':
    case 'uninvite':
    case 'code_revoke':
      return { cls: 'D', self: false }
    case 'leave':
    case 'device_revoke':
    case 'primary_rotate':
      return { cls: 'D', self: true }
    case 'revoke':
      return { cls: 'D', self: e.c.to === e.a }
    case 'role_move':
      return { cls: e.c.pos < (F.pos.get(e.c.role) ?? -1) ? 'D' : 'G', self: false }
    case 'role_bits':
      return { cls: e.c.on ? 'G' : 'D', self: false }
    case 'timeout':
      return { cls: !atNext(F.rules) ? 'A' : timeoutEnds(e) ? 'G' : 'D', self: false }
    case 'profile':
    case 'settings':
    case 'channel':
    case 'chperm':
      return { cls: 'R', self: false }
    case 'genesis':
    case 'add':
    case 'join':
    case 'unban':
    case 'role_create':
    case 'assign':
    case 'code':
    case 'device_add':
    case 'migrate':
      return { cls: 'G', self: false }
    default:
      return { cls: 'A', self: false }
  }
}

// What a deny acts on, for protection. `who` is the principal whose rank protects it.
export function target(
  e: AclEv,
  F: FactsQ
): { kind: 'member' | 'role' | 'self' | 'none'; who: string } {
  switch (e.t) {
    case 'kick':
    case 'ban':
    case 'uninvite':
      return { kind: 'member', who: e.c.to }
    case 'timeout':
      return atNext(F.rules) && typeof e.c.to === 'string'
        ? { kind: 'member', who: e.c.to }
        : { kind: 'self', who: e.a }
    case 'revoke':
      return e.c.to === e.a ? { kind: 'self', who: e.a } : { kind: 'member', who: e.c.to }
    case 'role_move':
    case 'role_bits':
    case 'role_del':
      return { kind: 'role', who: e.c.role }
    case 'code_revoke': {
      const iss = e.c.code === undefined ? undefined : F.codeIssuer.get(e.c.code)
      return !iss || iss === e.a ? { kind: 'none', who: '' } : { kind: 'member', who: iss }
    }
    default:
      return { kind: 'self', who: e.a }
  }
}

export function protectedP(F: FactsQ, P: string, k: Rank) {
  return F.owners.has(P) || gt(rank(F, P), k)
}

// Whether a deny's target is protected at stratum kk in V_d. A target that was not
// a member in St(d) and joined concurrently is protected already at equal rank.
export function protectedTarget(e: AclEv, St: FactsQ, V: FactsQ, kk: Rank) {
  const tg = target(e, St)
  if (tg.kind === 'member') {
    if (V.owners.has(tg.who)) return true
    if (!St.mem.has(tg.who)) return cmp(rank(V, tg.who), kk) >= 0
    return gt(rank(V, tg.who), kk)
  }
  if (tg.kind === 'role') return gt(rankOf(V, tg.who), kk)
  return false
}

// exposed(p, γ): p's author is not protected against cause γ at stratum kk, read in V_γ.
export function exposedTo(p: AclEv, g: AclEv, gRec: Rec, V: FactsQ, kk: Rank): boolean {
  const P = p.a
  if (V.owners.has(P)) return false
  const r = rank(V, P)
  if (isRevocationT(g.t)) return !gt(r, kk)
  if (p.t === 'join') {
    if (isWithdrawalT(g.t) && !(permsQ(gRec.local.facts, g.a) & KICK)) return false
    return cmp(r, kk) < 0
  }
  return !gt(r, kk)
}

// ----- content schemas of the ACL types (malformed known fields are refused with a strike) -----

const isStr = (x: unknown) => typeof x === 'string'
const isBit = (x: unknown) =>
  isInt(x, -Infinity) &&
  (x as number) > 0 &&
  (x as number) <= 2 ** 30 &&
  ((x as number) & ((x as number) - 1)) === 0
const isMask = (x: unknown) => isInt(x, -Infinity) && (x as number) >= 0 && (x as number) <= ALL
const isSeenMap = (x: unknown) =>
  isRecord(x) && Object.values(x).every(v => isInt(v, -Infinity) && (v as number) >= -1)
const isStrList = (x: unknown) => Array.isArray(x) && x.every(isStr)

type Kind = 'str' | 'int' | 'bool' | 'bit' | 'mask' | 'seen' | 'strs' | 'rec'
const KINDS: Record<Kind, (x: unknown) => boolean> = {
  str: isStr,
  int: (x: unknown) => isInt(x, -Infinity),
  bool: x => typeof x === 'boolean',
  bit: isBit,
  mask: isMask,
  seen: isSeenMap,
  strs: isStrList,
  rec: isRecord,
}

const SCHEMA: Record<string, Record<string, Kind>> = {
  add: { to: 'str', code: 'str' },
  uninvite: { to: 'str' },
  kick: { to: 'str', seen: 'seen' },
  ban: { to: 'str', seen: 'seen', wipe: 'bool' },
  unban: { to: 'str' },
  join: { idb: 'rec' },
  leave: { seen: 'seen' },
  role_create: { pos: 'int', bits: 'mask' },
  role_move: { role: 'str', pos: 'int' },
  role_bits: { role: 'str', bit: 'bit', on: 'bool' },
  role_del: { role: 'str' },
  assign: { to: 'str', role: 'str' },
  revoke: { to: 'str', role: 'str', seen: 'seen' },
  code_revoke: { code: 'str' },
  device_add: { dcert: 'str' },
  device_revoke: { ik: 'str', dk: 'str' },
  primary_rotate: { ik: 'str', seen: 'seen', pcert: 'str' },
  upgrade: { sigs: 'rec' },
  channel: { id: 'str' },
  chperm: { ch: 'str', subj: 'str', allow: 'mask', deny: 'mask' },
  proof: { x: 'rec', y: 'rec' },
}
// Read from RULES_NEXT on; rooms on earlier rules keep the type unread.
const NEXT_SCHEMA: Record<string, Record<string, Kind>> = {
  timeout: { to: 'str', until: 'int', reason: 'str' },
}
const NEXT_REQUIRED: Record<string, string[]> = {
  timeout: ['to', 'until'],
}
const REQUIRED: Record<string, string[]> = {
  add: ['to'],
  uninvite: ['to'],
  kick: ['to'],
  ban: ['to'],
  unban: ['to'],
  role_create: ['pos', 'bits'],
  role_move: ['role', 'pos'],
  role_bits: ['role', 'bit', 'on'],
  role_del: ['role'],
  assign: ['to', 'role'],
  revoke: ['to', 'role'],
  code_revoke: ['code'],
  device_revoke: ['ik', 'dk'],
  primary_rotate: ['ik'],
  channel: ['id'],
  chperm: ['ch', 'subj'],
  proof: ['x', 'y'],
}

export const BAN_REASON_MAX = 300
export const BAN_PURGE_H_MAX = 168
// Whether a room of these rules reads the end, reason and wipe window of a ban.
export const timedBans = atNext

const reasonFits = (x: unknown) =>
  x === undefined || (isStr(x) && [...(x as string)].length <= BAN_REASON_MAX)

// The fields a ban carries from RULES_NEXT on, each with its type and range.
const banFieldsOk = (c: Record<string, unknown>) =>
  (c.until === undefined || (isInt(c.until, -Infinity) && (c.until as number) > 0)) &&
  reasonFits(c.reason) &&
  (c.purge_h === undefined ||
    (isInt(c.purge_h, -Infinity) &&
      (c.purge_h as number) >= 0 &&
      (c.purge_h as number) <= BAN_PURGE_H_MAX))

export interface BanTerms {
  // When the ban ends (ms), null for a ban without an end.
  until: number | null
  reason: string | null
  // The hours before the ban its `wipe` reaches back, null for everything.
  purgeH: number | null
}

// The reason a ban gives, read at display in rooms of every rules.
const reasonOf = (c: Record<string, unknown>) =>
  isStr(c.reason) && c.reason !== ''
    ? [...(c.reason as string)].slice(0, BAN_REASON_MAX).join('')
    : null

// What a ban says about its end, reason and wipe window, read at display. Rooms on earlier rules
// keep the end and the window unread: a ban there has no end and its wipe hides everything. An
// end at or before the ban's own time is a ban that is already over and waits for its unban.
export function banTerms(rules: unknown, e: { ts: number; c: Record<string, unknown> }): BanTerms {
  const reason = reasonOf(e.c)
  if (!atNext(rules) || !banFieldsOk(e.c)) return { until: null, reason, purgeH: null }
  return {
    until: (e.c.until as number | undefined) ?? null,
    reason,
    purgeH: (e.c.purge_h as number | undefined) ?? null,
  }
}

// Whether a timed ban's end has passed at `now`, in a room that reads it.
export const banOver = (rules: unknown, c: Record<string, unknown>, now: number) =>
  atNext(rules) && isInt(c.until, -Infinity) && (c.until as number) <= now

// When the standing bans of one member end: the latest end, with who made that ban and its
// reason. Null when there is none or any of them has no end.
export function banEnd(
  bans: (BanTerms & { by: string })[]
): { until: number; by: string; reason: string | null } | null {
  let last: { until: number; by: string; reason: string | null } | null = null
  for (const b of bans) {
    if (b.until === null) return null
    if (!last || b.until > last.until) last = { until: b.until, by: b.by, reason: b.reason }
  }
  return last
}

// The reason shown with the standing bans of one member: that of the ban that ends last, or,
// while one of them has no end, that of the newest.
export function banReason(bans: (BanTerms & { by: string; ts: number })[]): string | null {
  const end = banEnd(bans)
  if (end) return end.reason
  let last: (BanTerms & { ts: number }) | null = null
  for (const b of bans) if (!last || b.ts > last.ts) last = b
  return last?.reason ?? null
}

// Whether a wiping ban hides a message its target sent at `ts` (with no `ts`: any message).
// Once an unban lifted it, only a wipe window of the rules that read it keeps hiding the messages
// it reached up to the ban; any other wipe shows them again.
export function banWipes(
  rules: unknown,
  ban: { ts: number; c: Record<string, unknown> },
  ts: number | undefined,
  lifted = false
) {
  const { purgeH } = banTerms(rules, ban)
  const from = purgeH === null ? -Infinity : ban.ts - purgeH * 3_600_000
  if (lifted) return purgeH !== null && (ts === undefined || (ts >= from && ts <= ban.ts))
  return ts === undefined || ts >= from
}

// The longest a timeout lasts from its own time: 28 days, as on hosted servers.
export const TIMEOUT_MAX_MS = 28 * 86_400_000
// When a timeout ends: its `until`, at most 28 days after its own time.
export const timeoutEnd = (e: { ts: number; c: Record<string, unknown> }) =>
  Math.min(e.c.until as number, e.ts + TIMEOUT_MAX_MS)
// Whether a room of these rules reads timeouts.
export const timeouts = atNext
// A timeout whose end is at or before its own time ends the member's timeout.
export const timeoutEnds = (e: { ts: number; c: Record<string, unknown> }) =>
  !isInt(e.c.until, -Infinity) || (e.c.until as number) <= e.ts
// An event of type `t` that ends a member's timeout.
export const endsTimeout = (t: string, e: { ts: number; c: Record<string, unknown> }) =>
  t === 'timeout' && timeoutEnds(e)
// The reason a timeout gives, read at display.
export const timeoutReason = (c: Record<string, unknown>) => reasonOf(c)

// A genesis nonce: 16 random bytes, b64u.
export const NONCE_LEN = 16

// The fields an ACL type reads have their types; fields a newer version adds are kept, unread. A
// genesis of another rules version needs only an integer `rules` (shown read-only).
export function aclContentOk(t: string, c: unknown, rules?: number | null): c is AclContent {
  if (!isRecord(c)) return false
  if (
    t === 'channel' &&
    rules === RULES_VERSION &&
    c.text_only !== undefined &&
    typeof c.text_only !== 'boolean'
  )
    return false
  if (t === 'ban' && atNext(rules) && !banFieldsOk(c)) return false
  if (atNext(rules)) {
    for (const f of NEXT_REQUIRED[t] ?? []) if (c[f] === undefined) return false
    for (const [f, k] of Object.entries(NEXT_SCHEMA[t] ?? {}))
      if (c[f] !== undefined && !KINDS[k](c[f])) return false
    if (t === 'timeout' && !reasonFits(c.reason)) return false
  }
  if (t === 'genesis')
    return (
      isInt(c.rules, -Infinity) &&
      (!knownRules(c.rules) ||
        (bytesOf(c.nonce, NONCE_LEN) !== null &&
          Array.isArray(c.owners) &&
          c.owners.length > 0 &&
          c.owners.every(o => isRecord(o) && isStr(o.ik)) &&
          isMask(c.everyone_bits) &&
          (c.from === undefined || (isRecord(c.from) && isStr(c.from.srv)))))
    )
  for (const f of REQUIRED[t] ?? []) if (c[f] === undefined) return false
  for (const [f, k] of Object.entries(SCHEMA[t] ?? {}))
    if (c[f] !== undefined && !KINDS[k](c[f])) return false
  if (t === 'device_revoke' && c.seen !== undefined && !isInt(c.seen, -Infinity)) return false
  if (t === 'primary_rotate' && c.keep !== undefined && !isStrList(c.keep)) return false
  return true
}
