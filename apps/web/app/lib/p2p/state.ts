import { bytesOf } from './canonical'
import { cmp, P as ACL_P, type Rank } from './acl/rules'
import type { Membership, MemberSum, Summary } from './acl_room'

// The current state of a P2P server as the page reads it: the mirror of the evaluator's facts
// (acl_room.ts Summary), with the readers the views, gates and gossip use. Values members write
// (names, channels, settings) are read defensively: a malformed or unknown value is ignored.

export const P = ACL_P

export { EVERYONE } from './acl/rules'
export type { Membership }

export type HistoryVis = 'shared' | 'joined'

export const LIMITS = {
  name: 100,
  topic: 1024,
  label: 64,
  reason: 200,
  // How far past its own time a code may say it expires (the admitting device clamps to this).
  codeTtl: 30 * 24 * 60 * 60_000,
  // Live codes of a member without Manage server (the rules cap them per device, spec 4.1).
  codesPerMember: 20,
}

export const CHANNEL_KINDS: readonly string[] = ['text', 'voice']

export interface ChannelContent {
  name: string
  kind: string
  pos: number
  topic?: string
  gone?: true
}

export interface SystemContent {
  ch: string | null
  join: boolean
  leave: boolean
}

export const isShortId = (x: unknown): x is string => bytesOf(x, 8) !== null

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
