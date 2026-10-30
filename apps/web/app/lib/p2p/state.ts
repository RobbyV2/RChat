import { isRecord } from '../bytes'
import { bytesOf, hasKeys } from './canonical'
import { isKeyId, verifyCert, verifyProfile, type Cert, type Profile } from './keys'

// P2P server state (note section 6): the current value of every state event, keyed by its type
// and state key. State events carry `skey`; they link to the state heads their sender knew through
// `pstate` and cite the state they rely on through `auth`. This module holds the schemas and the
// permission and rank evaluator; auth.ts applies the rules, resolve.ts orders and replays them.

export const STATE_TYPES = [
  'create',
  'owner',
  'member',
  'role',
  'roles',
  'name',
  'channel',
  'code',
  'history',
  'system',
] as const

export type StateType = (typeof STATE_TYPES)[number]

export const isStateType = (x: unknown): x is StateType => STATE_TYPES.includes(x as StateType)

// Permission bits, a superset of the instance's Perm.
export const P = {
  ManageChannels: 1,
  ManageMessages: 2,
  Kick: 4,
  ManageServer: 8,
  ManageRoles: 16,
  Ban: 32,
  Invite: 64,
  MentionEveryone: 128,
} as const

export const ALL_PERMS = 255
// Permission bits a newer version may add are kept in `perms` (and stay subject to the subset
// rule); this version only reads the bits above.
export const PERMS_MAX = 0x7fffffff

export const EVERYONE = 'everyone'
// What @everyone may do in a new server.
export const EVERYONE_PERMS = P.Invite

export const STATE_LIMITS = {
  name: 100,
  roleName: 32,
  topic: 1024,
  label: 64,
  reason: 200,
  roles: 32,
  // Enum values (membership, channel kind, history visibility) a newer version may add.
  enumLen: 32,
  // Seconds of slow mode a channel may ask for (read by Task 23).
  slow: 21600,
  skey: 128,
  // Citations: the create, owner, both members, both roles lists with every role they name,
  // @everyone, and the event's own key or channel.
  auth: 110,
  pstate: 10,
  // Invite codes a member without ManageServer may have that aren't revoked, and invites they
  // may have pending (deterministic caps of the rules, so state can't be flooded cheaply).
  codesPerMember: 20,
  invitesPerMember: 20,
  // How far past its own time a code may say it expires (the admitting device clamps to this).
  codeTtl: 30 * 24 * 60 * 60_000,
  // Invites signed for people who redeemed a code that may be pending per code (they lapse at
  // their `exp`, at most `codeInviteTtl` after they were made).
  codeInvites: 4,
  codeInviteTtl: 10 * 60_000,
}

// Per-member chains (note section 6): every event of a member in a room names the member's
// previous event there (`dprev`) and its number (`dseq`); state events also name the member's
// previous state event (`sprev`), and power events the member's latest accepted power event at
// their position (`pprev`). The windows below are counted along the chain by the events' own
// times, so every member reaches the same verdict on the same events.
export const CHAIN = {
  // Events per member and UTC day (`dwin` counts the earlier ones in the same day).
  day: 24 * 60 * 60_000,
  perDay: 5000,
  // State events per member and UTC hour (members who can moderate, by the state they cite, have
  // more room).
  hour: 60 * 60_000,
  statePerHour: 60,
  modStatePerHour: 600,
}

export type Membership = 'invite' | 'join' | 'leave' | 'ban'

export const MEMBERSHIPS: readonly Membership[] = ['invite', 'join', 'leave', 'ban']

export const isMembership = (x: unknown): x is Membership => MEMBERSHIPS.includes(x as Membership)

export interface CreateContent {
  kind: 'server'
  v: 1
  creator: string
  // The creator's device certificate, so the first event can be checked on its own.
  cert: Cert
}

export interface OwnerContent {
  ik: string
}

export interface MemberContent {
  m: Membership
  cert?: Cert
  profile?: Profile
  reason?: string
  // An invite signed for someone who redeemed a code: the code, and when the invite lapses.
  code?: string
  exp?: number
}

export interface RoleContent {
  name: string
  color: number | null
  perms: number
  pos: number
  gone?: true
}

export interface RolesContent {
  ids: string[]
}

export interface NameContent {
  name: string
  color?: number
}

export type ChannelKind = 'text' | 'voice'

export const CHANNEL_KINDS: readonly ChannelKind[] = ['text', 'voice']

export interface ChannelContent {
  name: string
  kind: ChannelKind
  pos: number
  topic?: string
  gone?: true
}

export interface CodeContent {
  // Expiry (ms since the epoch), checked by the admitting device's clock.
  exp: number
  revoked?: true
  label?: string
}

export type HistoryVis = 'shared' | 'joined'

export interface HistoryContent {
  vis: HistoryVis
}

export interface SystemContent {
  ch: string | null
  join: boolean
  leave: boolean
}

// Channel and role ids: 8 random bytes (b64u).
export const isShortId = (x: unknown): x is string => bytesOf(x, 8) !== null
export const isRoleId = (x: unknown): x is string => x === EVERYONE || isShortId(x)
export const isCodeHash = (x: unknown): x is string => bytesOf(x, 32) !== null

const chars = (s: string) => Array.from(s).length
const isInt = (x: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): x is number =>
  Number.isSafeInteger(x) && (x as number) >= min && (x as number) <= max
const isText = (x: unknown, max: number, empty = false): x is string =>
  typeof x === 'string' && chars(x) <= max && (empty || x.trim() !== '')
const isColor = (x: unknown) => isInt(x, 0, 0xffffff)
// A value of an enum: the known ones and any a newer version adds (stored, never acted on here).
const isEnum = (x: unknown) => isText(x, STATE_LIMITS.enumLen)

// Content of a known state type, with the state key it needs. Fields a newer version adds are
// kept (signed) and never read; so are enum values and permission bits it adds (forward
// compatibility: refusing them would strike newer peers and split the event set).
export const checkState = (type: string, skey: string, c: unknown): boolean => {
  if (!isRecord(c)) return false
  switch (type) {
    case 'create':
      return (
        skey === '' &&
        hasKeys(c, ['kind', 'v', 'creator', 'cert']) &&
        c.kind === 'server' &&
        c.v === 1 &&
        isKeyId(c.creator) &&
        verifyCert(c.cert, c.creator)
      )
    case 'owner':
      return skey === '' && isKeyId(c.ik)
    case 'member':
      return (
        isKeyId(skey) &&
        isEnum(c.m) &&
        (c.cert === undefined || verifyCert(c.cert, skey)) &&
        (c.profile === undefined || verifyProfile(c.profile, skey)) &&
        (c.reason === undefined || isText(c.reason, STATE_LIMITS.reason, true)) &&
        (c.code === undefined || isCodeHash(c.code)) &&
        (c.exp === undefined || isInt(c.exp))
      )
    case 'role':
      return (
        isRoleId(skey) &&
        isText(c.name, STATE_LIMITS.roleName) &&
        (c.color === null || isColor(c.color)) &&
        isInt(c.perms, 0, PERMS_MAX) &&
        isInt(c.pos, 0, 1_000_000) &&
        (c.gone === undefined || c.gone === true) &&
        (skey !== EVERYONE || (c.pos === 0 && c.gone === undefined))
      )
    case 'roles':
      return (
        isKeyId(skey) &&
        Array.isArray(c.ids) &&
        c.ids.length <= STATE_LIMITS.roles &&
        c.ids.every(isShortId) &&
        new Set(c.ids).size === c.ids.length
      )
    case 'name':
      return (
        skey === '' &&
        isText(c.name, STATE_LIMITS.name) &&
        (c.color === undefined || isColor(c.color))
      )
    case 'channel':
      return (
        isShortId(skey) &&
        isText(c.name, STATE_LIMITS.name) &&
        isEnum(c.kind) &&
        isInt(c.pos, 0, 1_000_000) &&
        (c.topic === undefined || isText(c.topic, STATE_LIMITS.topic, true)) &&
        (c.gone === undefined || c.gone === true)
      )
    case 'code':
      return (
        isCodeHash(skey) &&
        isInt(c.exp) &&
        (c.revoked === undefined || c.revoked === true) &&
        (c.label === undefined || isText(c.label, STATE_LIMITS.label, true))
      )
    case 'history':
      return skey === '' && isEnum(c.vis)
    case 'system':
      return (
        skey === '' &&
        (c.ch === null || isShortId(c.ch)) &&
        typeof c.join === 'boolean' &&
        typeof c.leave === 'boolean'
      )
    default:
      // A state type from a newer version: any object.
      return true
  }
}

// ----- State -----

// One state event as resolution and the rules see it.
export interface StateEvent {
  id: string
  type: string
  skey: string
  sender: string
  ts: number
  depth: number
  content: Record<string, unknown>
  pstate: string[]
  auth: string[]
  // The sender's chain (CHAIN above).
  dseq: number
  sprev?: string
  pprev?: string
}

// Keys are interned: the same key is the same string, whose hash the engine keeps (state maps
// look keys up a great deal).
const interned = new Map<string, Map<string, string>>()

export const stateKey = (type: string, skey: string) => {
  let byKey = interned.get(type)
  if (!byKey) {
    byKey = new Map()
    interned.set(type, byKey)
  }
  let k = byKey.get(skey)
  if (k === undefined) {
    k = `${type}\n${skey}`
    if (byKey.size >= 100_000) byKey.clear()
    byKey.set(skey, k)
  }
  return k
}

// The current value per (type, state key).
export type StateMap = ReadonlyMap<string, StateEvent>

export const stateOf = (events: Iterable<StateEvent>): Map<string, StateEvent> => {
  const out = new Map<string, StateEvent>()
  for (const e of events) out.set(stateKey(e.type, e.skey), e)
  return out
}

const get = (s: StateMap, type: string, skey: string) => s.get(stateKey(type, skey))

export const createOf = (s: StateMap) => get(s, 'create', '')?.content as CreateContent | undefined

export const ownerOf = (s: StateMap): string | null =>
  (get(s, 'owner', '')?.content as OwnerContent | undefined)?.ik ?? createOf(s)?.creator ?? null

export const memberOf = (s: StateMap, ik: string) => {
  const e = get(s, 'member', ik)
  return e ? { ...(e.content as unknown as MemberContent), id: e.id, sender: e.sender } : null
}

// An unknown membership (from a newer version) counts as none here.
export const membershipOf = (s: StateMap, ik: string): Membership | null => {
  const m = memberOf(s, ik)?.m
  return isMembership(m) ? m : null
}

export const roleOf = (s: StateMap, id: string) =>
  get(s, 'role', id)?.content as RoleContent | undefined

export const roleIdsOf = (s: StateMap, ik: string): string[] =>
  (get(s, 'roles', ik)?.content as RolesContent | undefined)?.ids ?? []

// Live roles of a member (not gone, still defined), @everyone not included.
export const rolesOf = (s: StateMap, ik: string) =>
  roleIdsOf(s, ik)
    .map(id => ({ id, role: roleOf(s, id) }))
    .filter((x): x is { id: string; role: RoleContent } => !!x.role && !x.role.gone)

export const isOwner = (s: StateMap, ik: string) => ownerOf(s) === ik

// Rank: the owner is above everyone; anyone else stands at their highest role (@everyone 0).
export const rankOf = (s: StateMap, ik: string) =>
  isOwner(s, ik) ? Infinity : Math.max(0, ...rolesOf(s, ik).map(r => r.role.pos))

// Effective permissions: the owner has all of them; anyone else the OR of @everyone and their
// roles.
export const permsOf = (s: StateMap, ik: string) => {
  if (isOwner(s, ik)) return PERMS_MAX
  let bits = roleOf(s, EVERYONE)?.perms ?? 0
  for (const r of rolesOf(s, ik)) bits |= r.role.perms
  return bits
}

export const can = (s: StateMap, ik: string, bit: number) => (permsOf(s, ik) & bit) !== 0

export const channelOf = (s: StateMap, id: string) =>
  get(s, 'channel', id)?.content as ChannelContent | undefined

export const codeOf = (s: StateMap, hash: string) => {
  const e = get(s, 'code', hash)
  return e ? { ...(e.content as unknown as CodeContent), sender: e.sender, id: e.id } : null
}

// An unknown visibility (from a newer version) is treated as the stricter `joined`.
export const historyOf = (s: StateMap): HistoryVis => {
  const vis = (get(s, 'history', '')?.content as HistoryContent | undefined)?.vis
  return vis === undefined || vis === 'shared' ? 'shared' : 'joined'
}

export const nameOf = (s: StateMap) => get(s, 'name', '')?.content as NameContent | undefined

// Live channels of a kind this version knows, in display order.
export const channelsOf = (s: StateMap) => {
  const out: ({ id: string } & ChannelContent)[] = []
  for (const e of s.values()) {
    if (e.type !== 'channel') continue
    const c = e.content as unknown as ChannelContent
    if (!c.gone && CHANNEL_KINDS.includes(c.kind)) out.push({ id: e.skey, ...c })
  }
  return out.sort((a, b) => a.pos - b.pos || (a.id < b.id ? -1 : 1))
}

// Where join and leave lines go: the system channel when it is a live text channel, otherwise
// the first text channel. Null when lines are off or there is no text channel.
export const systemOf = (s: StateMap) => {
  const sys = get(s, 'system', '')?.content as SystemContent | undefined
  const texts = channelsOf(s).filter(c => c.kind === 'text')
  const pick = sys?.ch ? texts.find(c => c.id === sys.ch) : undefined
  return {
    ch: (pick ?? texts[0])?.id ?? null,
    join: sys?.join ?? true,
    leave: sys?.leave ?? true,
  }
}

// Events that change who may do what: ownership, roles, and removals of someone else.
export const isPower = (e: { type: string; sender: string; skey: string; content: unknown }) => {
  if (e.type === 'create' || e.type === 'owner' || e.type === 'role' || e.type === 'roles')
    return true
  if (e.type !== 'member' || e.skey === e.sender) return false
  const m = (e.content as { m?: unknown } | null)?.m
  return m === 'leave' || m === 'ban'
}

// Giving up power or membership yourself: handing ownership over, leaving, or changing your own
// roles (only the owner may).
export const isSelfRevoking = (e: {
  type: string
  sender: string
  skey: string
  content: unknown
}) => {
  if (e.type === 'owner') return true
  if (e.type === 'roles') return e.skey === e.sender
  return (
    e.type === 'member' &&
    e.skey === e.sender &&
    (e.content as { m?: unknown } | null)?.m === 'leave'
  )
}

// Events on a member's power chain (`pprev`): power events and leaving.
export const isPowerChain = (e: { type: string; sender: string; skey: string; content: unknown }) =>
  isPower(e) || isSelfRevoking(e)

export const membersOf = (s: StateMap) => {
  const out: { ik: string; m: Membership; id: string; sender: string }[] = []
  for (const e of s.values()) {
    const m = (e.content as { m?: unknown }).m
    if (e.type === 'member' && isMembership(m))
      out.push({ ik: e.skey, m, id: e.id, sender: e.sender })
  }
  return out
}

export const joinedOf = (s: StateMap) =>
  membersOf(s)
    .filter(m => m.m === 'join')
    .map(m => m.ik)
