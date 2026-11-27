import { isRecord } from '../../bytes'
import { bytesOf, canonical, isInt } from '../canonical'
import { AGREED, LOCAL, type Agreed, type Local } from '../limits'
import type { EvalResult, Facts, FactsQ } from './facts'

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
export const SEND = P.SendMessages
export const VIEW = P.ViewChannel
// Reset server profiles: read from rules RULES_NEXT on. Up to rules 4, Kick stands in for it.
export const PROFILES = 8388608
export const TIMEOUT = P.TimeoutMembers
export const ALL = 0x7fffffff
export const MODBITS = KICK | BAN | ROLES | CHANNELS | SERVER | MESSAGES
export const EVERYONE = 'everyone'
export const RULES_VERSION = 4
export const RULES_NEXT = 5
const atNext = (rules: unknown) => typeof rules === 'number' && rules >= RULES_NEXT
export const knownRules = (rules: unknown) => rules === 2 || rules === RULES_VERSION
// The bit a moderator needs to reset another member's room profile under `rules`.
export const resetBit = (rules: unknown) =>
  typeof rules === 'number' && rules >= RULES_NEXT ? PROFILES : KICK
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
}
export const simpleCtx = (F: FactsQ, a: string): AuthCtx => ({
  Fr: F,
  Fo: F,
  me: rank(F, a),
  rankOf: R => rankOf(F, R),
  rankT: T => rank(F, T),
})

// The authority of content events through authCore: a redaction of another member's
// message needs Manage messages and a rank above its author, a pin needs Manage messages; any
// other content needs Mem (and Dev). These type names can't be ACL types.
export const CONTENT_REDACT = 'c:redact'
export const CONTENT_PIN = 'c:pin'

export function authCore(e: AclEv, x: AuthCtx): boolean {
  const a = e.a
  const c = e.c
  const Fr = x.Fr
  const Fo = x.Fo
  const isMem = Fr.mem.has(a)
  const has = (b: number) => (permsQ(Fr, a) & b) !== 0
  const outranks = (r: Rank) => gt(x.me, r)
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
      return isMem && has(KICK) && !Fr.owners.has(c.to) && outranks(x.rankT(c.to))
    case 'ban':
      return (
        isMem &&
        has(BAN) &&
        !Fr.owners.has(c.to) &&
        outranks(x.rankT(c.to)) &&
        (c.wipe !== true || has(MESSAGES))
      )
    case 'unban':
      return isMem && has(BAN) && (Fr.effBanK.get(c.to) ?? []).every(kb => cmp(x.me, kb) >= 0)
    case 'timeout':
      if (!atNext(Fr.rules)) return isMem
      return isMem && has(TIMEOUT) && !Fr.owners.has(c.to) && outranks(x.rankT(c.to))
    case 'role_create':
      return isMem && has(ROLES) && outranks([c.pos, e.id]) && (c.bits & ~permsQ(Fr, a)) === 0
    case 'role_move':
      return (
        isMem &&
        has(ROLES) &&
        Fr.roles.has(c.role) &&
        outranks(x.rankOf(c.role)) &&
        outranks([c.pos, c.role])
      )
    case 'role_bits':
      return (
        isMem &&
        has(ROLES) &&
        (c.role === EVERYONE || Fr.roles.has(c.role)) &&
        outranks(x.rankOf(c.role)) &&
        (!c.on || has(c.bit))
      )
    case 'role_del':
      return isMem && has(ROLES) && Fr.roles.has(c.role) && outranks(x.rankOf(c.role))
    case 'assign':
      return (
        isMem &&
        has(ROLES) &&
        Fr.roles.has(c.role) &&
        outranks(x.rankOf(c.role)) &&
        !Fr.owners.has(c.to) &&
        outranks(x.rankT(c.to))
      )
    case 'revoke':
      return (
        isMem &&
        (c.to === a || (has(ROLES) && outranks(x.rankOf(c.role)) && outranks(x.rankT(c.to))))
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
      if (subj.startsWith('r:')) return outranks(x.rankOf(subj.slice(2)))
      if (subj.startsWith('u:')) return outranks(x.rankT(subj.slice(2)))
      return false
    }
    case 'device_add':
      return isMem && !Fr.revoked.has(e.dev)
    case 'upgrade':
    case 'migrate':
      return isMem && Fr.owners.has(a)
    case CONTENT_REDACT:
      return isMem && (c.to === a || Fr.owners.has(a) || (has(MESSAGES) && outranks(x.rankT(c.to))))
    case CONTENT_PIN:
      return isMem && has(MESSAGES)
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
  Pick<Facts, 'overwrites' | 'channels'>

// P's permissions in channel `ch`, in Discord order: owners and holders of Manage channels have
// every bit; else P's permissions, the @everyone overwrite, the channel's restrictions
// (restrict_view and restrict_send clear ViewChannel and SendMessages from that baseline), the
// denies then the allows of P's roles' overwrites, and P's own overwrite.
export function channelPerms(F: ChanFacts, P: string, ch: string): number {
  if (F.owners.has(P)) return ALL
  let m = permsQ(F, P)
  if (m & CHANNELS) return ALL
  const ov = F.overwrites.get(ch)
  const c = F.channels.get(ch)
  const apply = (o: AclContent | undefined) => {
    if (o) m = (m & ~(o.deny ?? 0)) | (o.allow ?? 0)
  }
  apply(ov?.get(`r:${EVERYONE}`))
  if (c?.restrict_view === true) m &= ~VIEW
  if (c?.restrict_send === true) m &= ~SEND
  let deny = 0
  let allow = 0
  for (const R of F.holds.get(P) ?? []) {
    const o = ov?.get(`r:${R}`)
    deny |= o?.deny ?? 0
    allow |= o?.allow ?? 0
  }
  m = (m & ~deny) | allow
  apply(ov?.get(`u:${P}`))
  return m
}
export const canView = (F: ChanFacts, P: string, ch: string) =>
  (channelPerms(F, P, ch) & VIEW) !== 0
// Whether everyone in the server sees channel `ch`: a member without roles may view it (no key
// is the empty string), and no overwrite denies ViewChannel to anyone.
export const everyoneSees = (F: ChanFacts, ch: string) =>
  canView(F, '', ch) &&
  ![...(F.overwrites.get(ch)?.values() ?? [])].some(o => ((o.deny ?? 0) & VIEW) !== 0)
// Sending needs ViewChannel and SendMessages.
export const canSend = (F: ChanFacts, P: string, ch: string) =>
  (channelPerms(F, P, ch) & (VIEW | SEND)) === (VIEW | SEND)

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
    (St.mem.has(e.a) && (permsQ(St, e.a) & ROLES) !== 0 && gt(rank(St, e.a), rankOf(St, e.c.role))))

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
    (St.mem.has(e.a) && (permsQ(St, e.a) & bit) !== 0 && gt(rank(St, e.a), rank(St, e.c.to))))

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
