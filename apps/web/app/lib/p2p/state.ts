import { bytesOf } from './canonical'
import {
  channelPerms,
  cmp,
  EVERYONE,
  P as ACL_P,
  type AclContent,
  type ChanFacts,
  type Rank,
} from './acl/rules'
import type { Membership, MemberSum, RoleSum, Summary } from './acl_room'
import { AGREED, LOCAL } from './limits'

// The current state of a P2P server as the page reads it: the mirror of the evaluator's facts
// (acl_room.ts Summary), with the readers the views, gates and gossip use. Values members write
// (names, channels, settings) are read defensively: a malformed or unknown value is ignored.

export const P = ACL_P

export { EVERYONE } from './acl/rules'
export type { Membership }

export type HistoryVis = 'shared' | 'joined'

export const LIMITS = {
  ...LOCAL.display,
  // Live codes of a member without Manage server (the rules cap them per device, spec 4.1).
  codesPerMember: AGREED.codesPerDev,
}

export const CHANNEL_KINDS: readonly string[] = ['text', 'voice']

export interface ChannelContent {
  name: string
  kind: string
  pos: number
  topic?: string
  gone?: true
  restrict_view?: true
  restrict_send?: true
  // Slow mode, in seconds (spec 3.5).
  slow?: number
}

export interface SystemContent {
  ch: string | null
  join: boolean
  leave: boolean
}

export const isShortId = (x: unknown): x is string => bytesOf(x, 8) !== null

const pick = (x: Record<string, unknown>, keys: readonly string[]) => {
  const out: Record<string, unknown> = {}
  for (const k of keys) if (Object.hasOwn(x, k) && x[k] !== undefined) out[k] = x[k]
  return out
}

// The fields of a channel and of the settings this version reads; what we write again keeps
// only these.
const CHANNEL_FIELDS = [
  'name',
  'kind',
  'pos',
  'topic',
  'gone',
  'restrict_view',
  'restrict_send',
  'slow',
]
export const knownChannel = (c: object) => pick(c as Record<string, unknown>, CHANNEL_FIELDS)

export const knownSettings = (x: object) => {
  const out = pick(x as Record<string, unknown>, ['name', 'color', 'history', 'system'])
  if (out.system !== null && typeof out.system === 'object')
    out.system = pick(out.system as Record<string, unknown>, ['ch', 'join', 'leave'])
  else delete out.system
  return out
}

const text = (x: unknown, max: number) =>
  typeof x === 'string' && x.trim() !== '' ? Array.from(x).slice(0, max).join('') : null
const int = (x: unknown) => (Number.isSafeInteger(x) ? (x as number) : null)

export const memberOf = (s: Summary, ik: string): MemberSum | undefined => s.members[ik]

export const membershipOf = (s: Summary, ik: string): Membership | null => s.members[ik]?.m ?? null

export const isOwner = (s: Summary, ik: string) => s.owners.includes(ik)

export const permsOf = (s: Summary, ik: string) =>
  s.members[ik]?.m === 'join' ? s.members[ik].perms : 0

export const can = (s: Summary, ik: string, bits: number) => (permsOf(s, ik) & bits) !== 0

export const rankOf = (s: Summary, ik: string): Rank => s.members[ik]?.rank ?? [-Infinity, '']

// Whether `ik` outranks `other` (acting on a member needs it, spec 1.6).
export const outranks = (s: Summary, ik: string, other: string) =>
  cmp(rankOf(s, ik), rankOf(s, other)) > 0

export const membersOf = (s: Summary) => Object.entries(s.members).map(([ik, m]) => ({ ik, ...m }))

export const nameOf = (s: Summary): { name: string; color: number | null } | null => {
  const n = text(s.settings?.name, LIMITS.name)
  if (!n) return null
  const c = int(s.settings?.color)
  return { name: n, color: c !== null && c >= 0 && c <= 0xffffff ? c : null }
}

export const historyOf = (s: Summary): HistoryVis => {
  const h = s.settings?.history
  return h === undefined || h === 'shared' ? 'shared' : 'joined'
}

// Live channels of a kind this version knows, in display order.
export const channelsOf = (s: Summary) => {
  const out: ({ id: string } & ChannelContent)[] = []
  for (const [id, c] of Object.entries(s.channels)) {
    const name = text(c.name, LIMITS.name)
    const kind = typeof c.kind === 'string' ? c.kind : 'text'
    if (!isShortId(id) || !name || c.gone === true || !CHANNEL_KINDS.includes(kind)) continue
    const ch: { id: string } & ChannelContent = { id, name, kind, pos: int(c.pos) ?? 0 }
    const topic = text(c.topic, LIMITS.topic)
    if (topic) ch.topic = topic
    if (c.restrict_view === true) ch.restrict_view = true
    if (c.restrict_send === true) ch.restrict_send = true
    const slow = int(c.slow)
    if (slow !== null && slow > 0) ch.slow = slow
    out.push(ch)
  }
  return out.sort((a, b) => a.pos - b.pos || (a.id < b.id ? -1 : 1))
}

export const channelOf = (s: Summary, id: string) => {
  const c = s.channels[id]
  return c && c.gone !== true ? c : undefined
}

export const systemOf = (s: Summary): SystemContent => {
  const sys = s.settings?.system as Partial<SystemContent> | undefined
  const texts = channelsOf(s).filter(c => c.kind === 'text')
  const pick = typeof sys?.ch === 'string' ? texts.find(c => c.id === sys.ch) : undefined
  return {
    ch: (pick ?? texts[0])?.id ?? null,
    join: typeof sys?.join === 'boolean' ? sys.join : true,
    leave: typeof sys?.leave === 'boolean' ? sys.leave : true,
  }
}

// Members who can moderate (gossip weighs them up).
export const MOD_BITS = P.Kick | P.Ban | P.ManageMessages

// The summary as channel permissions read it (acl/rules.ts channelPerms, spec 1.4).
// Built once per summary (summaries are replaced, never changed): search and every page load ask.
const facts = new WeakMap<Summary, ChanFacts>()
export const chanFactsOf = (s: Summary): ChanFacts => {
  let F = facts.get(s)
  if (!F) facts.set(s, (F = buildChanFacts(s)))
  return F
}

const buildChanFacts = (s: Summary): ChanFacts => ({
  owners: new Set(s.owners),
  bits: { get: (R: string) => (R === EVERYONE ? s.everyone : s.roles[R]?.bits) },
  holds: { get: (ik: string) => (s.members[ik]?.m === 'join' ? s.members[ik].roles : undefined) },
  overwrites: new Map(
    Object.entries(s.overwrites ?? {}).map(([ch, o]) => [
      ch,
      new Map(Object.entries(o).map(([subj, x]) => [subj, x as unknown as AclContent])),
    ])
  ),
  channels: new Map(Object.entries(s.channels)),
})

// `ik`'s permissions in channel `ch` (owners and Manage channels have every bit).
export const channelPermsOf = (s: Summary, ik: string, ch: string, F = chanFactsOf(s)) =>
  channelPerms(F, ik, ch)

// Roles, the highest first (rank order, spec 1.6: position, then id).
export const rolesOf = (s: Summary): ({ id: string } & RoleSum)[] =>
  Object.entries(s.roles)
    .map(([id, r]) => ({ id, ...r }))
    .sort((a, b) => b.pos - a.pos || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))

// A role's rank (spec 1.6).
export const roleRank = (s: Summary, id: string): Rank => [s.roles[id]?.pos ?? -1, id]

// The highest of `ik`'s roles, or null.
export const topRoleOf = (s: Summary, ik: string): string | null => {
  let best: string | null = null
  for (const R of s.members[ik]?.roles ?? [])
    if (s.roles[R] && (best === null || cmp(roleRank(s, R), roleRank(s, best)) > 0)) best = R
  return best
}
