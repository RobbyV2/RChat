// The permission rules shared with the server (`crates/perms`, compiled into `crates/wasm`).
// `ready(load)` loads it (`perms_load.ts` has the loader for pages and workers). Every decision
// below needs it loaded first. Masks are numbers in
// canonical (hosted) values, exact below 2^53; `rules` is 0 for a hosted server and the rules
// version for a P2P room.

import { arr, bool, lit, nullable, num, obj, parseJson, str, union, type Schema } from './schema'

type Tie = string | undefined

export interface PermsModule {
  perms_registry(): string
  perms_known(rules: number): number
  perms_from_wire(wire: number, rules: number): number
  perms_to_wire(mask: number, rules: number, keep: number): number
  perms_server_bits(
    who: number,
    whoMask: number,
    whoRoles: number,
    everyone: number,
    rules: number
  ): number
  perms_channel_mask(
    who: number,
    whoMask: number,
    whoRoles: number,
    everyone: number,
    evAllow: number,
    evDeny: number,
    flags: number,
    roleRows: Float64Array,
    memAllow: number,
    memDeny: number,
    memMode: number,
    rules: number
  ): number
  perms_everyone_stage(
    everyone: number,
    evAllow: number,
    evDeny: number,
    flags: number,
    rules: number
  ): number
  perms_derived_row(allow: number, deny: number, flags: number): Float64Array
  perms_outranks(...ranks: [...RankArgs, ...RankArgs]): boolean
  perms_at_least(...ranks: [...RankArgs, ...RankArgs]): boolean
  perms_may_moderate(...args: [...RankArgs, number, ...RankArgs, number, number, boolean]): boolean
  perms_manages_role(...args: [...RankArgs, number, ...RankArgs, number]): boolean
  perms_may_assign(
    ...args: [
      ...RankArgs,
      number,
      ...RankArgs,
      boolean,
      number,
      boolean,
      boolean,
      ...RankArgs,
      number,
      number,
    ]
  ): boolean
  perms_may_unassign(
    ...args: [...RankArgs, number, ...RankArgs, boolean, boolean, ...RankArgs, number]
  ): boolean
  perms_granted(bAllow: number, bDeny: number, aAllow: number, aDeny: number): number
  perms_denied(bAllow: number, bDeny: number, aAllow: number, aDeny: number): number
  perms_check_overwrite_edit(
    actorMask: number,
    exempt: boolean,
    bAllow: number,
    bDeny: number,
    aAllow: number,
    aDeny: number,
    subjectOk: boolean
  ): number
  perms_check_bits_edit(actorBits: number, exempt: boolean, before: number, after: number): number
  perms_reorder(
    current: Float64Array,
    requested: Float64Array,
    manageable: Float64Array
  ): Float64Array
  perms_moved(before: Float64Array, after: Float64Array): Float64Array
  perms_widens(
    beforeSubjects: string,
    beforeMasks: Float64Array,
    afterSubjects: string,
    afterMasks: Float64Array
  ): string
  perms_widened(
    beforeSubjects: string,
    beforeRows: Float64Array,
    afterSubjects: string,
    afterRows: Float64Array,
    everyoneSubject: string,
    everyone: number,
    roleSubjects: string,
    roleBits: Float64Array,
    memberSubjects: string,
    memberRoles: string,
    flags: number,
    rules: number
  ): string
  perms_display_order(places: Float64Array): Float64Array
  perms_hoist_groups(places: Float64Array, hoist: Uint8Array): Float64Array
}

type RankArgs = [number, number, number, Tie, number]

export const HOSTED = 0

let mod: PermsModule | null = null
let loading: Promise<void> | null = null

// Resolves once the rules are loaded. A failed load rejects, and a later call tries again.
export const ready = (load: () => Promise<PermsModule>): Promise<void> =>
  (loading ??= load().then(
    loadedModule => {
      mod = loadedModule
    },
    (e: unknown) => {
      loading = null
      throw e
    }
  ))

export const loaded = () => mod !== null

export const unload = () => {
  mod = null
  loading = null
}

const rules = (): PermsModule => {
  if (mod === null) throw new Error('permission rules are not loaded')
  return mod
}

// Bit arithmetic that stays exact up to 2^53: the bitwise operators cut numbers to 32 bits.
const HALF = 2 ** 26
const LOW = HALF - 1
const HIGH = 2 ** 27 - 1
const high = (x: number) => Math.floor(x / HALF)
const low = (x: number) => x % HALF
export const maskAnd = (a: number, b: number) => (high(a) & high(b)) * HALF + (low(a) & low(b))
export const maskOr = (a: number, b: number) => (high(a) | high(b)) * HALF + (low(a) | low(b))
export const maskNot = (a: number) => (~high(a) & HIGH) * HALF + (~low(a) & LOW)
export const maskXor = (a: number, b: number) => (high(a) ^ high(b)) * HALF + (low(a) ^ low(b))
export const hasBit = (mask: number, bit: number) => maskAnd(mask, bit) !== 0

export interface Bit {
  name: string
  label: string
  value: number
  scope: 'server' | 'channel'
  everyone: boolean
  hosted: 'live' | 'reserved'
  p2p: { value: number; state: 'live' | 'reserved'; since: number } | null
}

let bits: Bit[] | null = null
const STATE = union(lit('live'), lit('reserved'))
const BITS: Schema<Bit[]> = arr(
  obj({
    name: str(),
    label: str(),
    value: num(),
    scope: union(lit('server'), lit('channel')),
    everyone: bool,
    hosted: STATE,
    p2p: nullable(obj({ value: num(), state: STATE, since: num() })),
  })
)
export const registry = (): Bit[] => {
  if (bits) return bits
  const parsed = parseJson(rules().perms_registry(), BITS)
  if (!parsed.ok) throw new Error('The permission rules could not be read')
  return (bits = parsed.value)
}
export const bit = (name: string): number => {
  const found = registry().find(b => b.name === name)
  if (found === undefined) throw new Error(`unknown permission ${name}`)
  return found.value
}

// What everyone holds on a hosted server that stores no mask of its own.
export const baseBits = (): number =>
  registry()
    .filter(b => b.everyone && b.hosted === 'live')
    .reduce((m, b) => maskOr(m, b.value), 0)

export const known = (ruleset: number) => rules().perms_known(ruleset)
export const fromWire = (wire: number, ruleset: number) =>
  rules().perms_from_wire(wire >>> 0, ruleset)
export const toWire = (mask: number, ruleset: number, keep = 0) =>
  rules().perms_to_wire(mask, ruleset, keep >>> 0)

export type Who =
  | { kind: 'staff' }
  | { kind: 'owner' }
  | { kind: 'admin'; mask: number; roles?: number }
  | { kind: 'member'; roles: number }
  | { kind: 'visitor'; signedIn: boolean; caps: number }

// An admin's `roles` is the union of its role masks: only their base bits count.
const whoArgs = (who: Who): [number, number, number] => {
  switch (who.kind) {
    case 'staff':
      return [0, 0, 0]
    case 'owner':
      return [1, 0, 0]
    case 'admin':
      return [2, who.mask, who.roles ?? 0]
    case 'member':
      return [3, who.roles, 0]
    case 'visitor':
      return [who.signedIn ? 5 : 4, who.caps, 0]
  }
}

export interface Ow {
  allow: number
  deny: number
}

export interface ChannelRules {
  everyone?: Ow
  restrictView?: boolean
  restrictSend?: boolean
  voice?: boolean
  roles: Ow[]
  member?: Ow & { merge?: boolean }
}

export const serverBits = (who: Who, everyone: number, ruleset: number) =>
  rules().perms_server_bits(...whoArgs(who), everyone, ruleset)

export const channelMask = (
  who: Who,
  everyone: number,
  ch: ChannelRules,
  ruleset: number,
  timedOut = false,
  acting = true
) =>
  rules().perms_channel_mask(
    ...whoArgs(who),
    everyone,
    ch.everyone?.allow ?? 0,
    ch.everyone?.deny ?? 0,
    (ch.restrictView === true ? 1 : 0) |
      (ch.restrictSend === true ? 2 : 0) |
      (ch.voice === true ? 4 : 0) |
      (ch.everyone ? 8 : 0) |
      (ch.member ? 16 : 0) |
      (timedOut ? 32 : 0) |
      (acting ? 64 : 0),
    Float64Array.from(ch.roles.flatMap(o => [o.allow, o.deny])),
    ch.member?.allow ?? 0,
    ch.member?.deny ?? 0,
    ch.member?.merge === true ? 1 : 0,
    ruleset
  )

// What a channel gives everyone before any role or member row.
export const everyoneStage = (
  everyone: number,
  ch: Pick<ChannelRules, 'everyone' | 'restrictView' | 'restrictSend'>,
  ruleset: number
) =>
  rules().perms_everyone_stage(
    everyone,
    ch.everyone?.allow ?? 0,
    ch.everyone?.deny ?? 0,
    (ch.restrictView === true ? 1 : 0) | (ch.restrictSend === true ? 2 : 0) | (ch.everyone ? 8 : 0),
    ruleset
  )

// A hosted rule as stored: its masks and the three flags a rule with both masks 0 is read from.
export interface StoredRule {
  allow: number
  deny: number
  merge?: boolean
  canView: boolean
  canSend: boolean
  canReadHistory: boolean
}

// The row a hosted rule stands for. `member` says it is a member's rule.
export const derivedRow = (rule: StoredRule, member: boolean): Ow & { merge: boolean } => {
  const [allow, deny, merge] = rules().perms_derived_row(
    rule.allow,
    rule.deny,
    (rule.canView ? 1 : 0) |
      (rule.canSend ? 2 : 0) |
      (rule.canReadHistory ? 4 : 0) |
      (member ? 8 : 0) |
      (rule.merge === true ? 16 : 0)
  )
  return { allow, deny, merge: merge === 1 }
}

export type Tier = 'outside' | 'plain' | 'role' | 'admin' | 'owner' | 'staff'
const TIERS: Tier[] = ['outside', 'plain', 'role', 'admin', 'owner', 'staff']

// A rank: its tier, and for a role its position and tie (a role id: a number on hosted servers,
// a string in P2P rooms), and for an admin the admin mask.
export interface Rank {
  tier: Tier
  pos?: number
  tie?: number | string
  adminMask?: number
}

export interface Actor {
  rank: Rank
  bits: number
}

const rankArgs = (r: Rank): RankArgs => [
  TIERS.indexOf(r.tier),
  r.pos ?? -1,
  typeof r.tie === 'number' ? r.tie : 0,
  typeof r.tie === 'number' ? undefined : (r.tie ?? ''),
  r.adminMask ?? 0,
]

export const outranks = (a: Rank, b: Rank) => rules().perms_outranks(...rankArgs(a), ...rankArgs(b))
export const atLeast = (a: Rank, b: Rank) => rules().perms_at_least(...rankArgs(a), ...rankArgs(b))

export const mayModerate = (a: Actor, t: Actor, need: number, guard: boolean) =>
  rules().perms_may_moderate(...rankArgs(a.rank), a.bits, ...rankArgs(t.rank), t.bits, need, guard)

const held = (heldAbove: boolean | undefined) => (heldAbove === undefined ? 0 : heldAbove ? 2 : 1)

// `heldAbove` is the extra test of the order guard: leave it out when the guard is off.
export const managesRole = (a: Actor, role: Rank, heldAbove?: boolean) =>
  rules().perms_manages_role(...rankArgs(a.rank), a.bits, ...rankArgs(role), held(heldAbove))

const NOBODY: Actor = { rank: { tier: 'outside' }, bits: 0 }

// `target` is left out when the actor gives the role to itself; `guard` is the order guard.
export const mayAssign = (
  a: Actor,
  role: Rank,
  roleBits: number,
  allowsOk: boolean,
  target: Actor | undefined,
  ruleset: number,
  guard = false
) =>
  rules().perms_may_assign(
    ...rankArgs(a.rank),
    a.bits,
    ...rankArgs(role),
    guard,
    roleBits,
    allowsOk,
    target !== undefined,
    ...rankArgs((target ?? NOBODY).rank),
    (target ?? NOBODY).bits,
    ruleset
  )

// `target` is left out when the actor drops its own role.
export const mayUnassign = (a: Actor, role: Rank, target: Actor | undefined, guard = false) =>
  rules().perms_may_unassign(
    ...rankArgs(a.rank),
    a.bits,
    ...rankArgs(role),
    guard,
    target !== undefined,
    ...rankArgs((target ?? NOBODY).rank),
    (target ?? NOBODY).bits
  )

const NONE: Ow = { allow: 0, deny: 0 }
export const granted = (before: Ow = NONE, after: Ow = NONE) =>
  rules().perms_granted(before.allow, before.deny, after.allow, after.deny)
export const denied = (before: Ow = NONE, after: Ow = NONE) =>
  rules().perms_denied(before.allow, before.deny, after.allow, after.deny)

export type Refusal = 'grants' | 'denies_moderation' | 'outranked'
const REFUSALS: (Refusal | null)[] = [null, 'grants', 'denies_moderation', 'outranked']

export const checkOverwriteEdit = (
  actorMask: number,
  exempt: boolean,
  before: Ow | undefined,
  after: Ow | undefined,
  subjectOk: boolean
): Refusal | null => {
  const b = before ?? NONE
  const a = after ?? NONE
  return REFUSALS[
    rules().perms_check_overwrite_edit(
      actorMask,
      exempt,
      b.allow,
      b.deny,
      a.allow,
      a.deny,
      subjectOk
    )
  ]
}

export const checkBitsEdit = (
  actorBits: number,
  exempt: boolean,
  before: number,
  after: number
): Refusal | null => REFUSALS[rules().perms_check_bits_edit(actorBits, exempt, before, after)]

export const reorder = (current: number[], requested: number[], manageable: number[]) =>
  Array.from(
    rules().perms_reorder(
      Float64Array.from(current),
      Float64Array.from(requested),
      Float64Array.from(manageable)
    )
  )

export const moved = (before: number[], after: number[]) =>
  Array.from(rules().perms_moved(Float64Array.from(before), Float64Array.from(after)))

// The subjects (without newlines) whose mask gains View or Send.
export const widens = (before: [string, number][], after: [string, number][]) => {
  const out = rules().perms_widens(
    before.map(([s]) => s).join('\n'),
    Float64Array.from(before.map(([, m]) => m)),
    after.map(([s]) => s).join('\n'),
    Float64Array.from(after.map(([, m]) => m))
  )
  return out === '' ? [] : out.split('\n')
}

// A channel rule as the sync check reads it: subject, allow, deny and whether it merges.
export interface SyncRule {
  subject: string
  allow: number
  deny: number
  merge: boolean
}

// The subjects that gain View or Send (Connect in a voice channel) in a channel whose rules
// `before` become `after`: @everyone (its rule's subject and its bits), each role as a member
// holding only it (`roleBits` by subject), each pair of roles as `a+b`, and each member subject
// with the roles it holds (`memberRoles`, by subject).
export const widened = (
  before: SyncRule[],
  after: SyncRule[],
  everyone: { subject: string; bits: number },
  roleBits: Record<string, number>,
  memberRoles: Record<string, string[]>,
  place: { restrictView: boolean; restrictSend: boolean; voice: boolean },
  ruleset: number
) => {
  const members = Object.entries(memberRoles)
  const rows = (list: SyncRule[]) =>
    Float64Array.from(list.flatMap(r => [r.allow, r.deny, r.merge ? 1 : 0]))
  const roles = Object.entries(roleBits)
  const out = rules().perms_widened(
    before.map(r => r.subject).join('\n'),
    rows(before),
    after.map(r => r.subject).join('\n'),
    rows(after),
    everyone.subject,
    everyone.bits,
    roles.map(([s]) => s).join('\n'),
    Float64Array.from(roles.map(([, b]) => b)),
    members.map(([s]) => s).join('\n'),
    members.map(([, held]) => held.join(',')).join('\n'),
    (place.restrictView ? 1 : 0) | (place.restrictSend ? 2 : 0) | (place.voice ? 4 : 0),
    ruleset
  )
  return out === '' ? [] : out.split('\n')
}

// Roles listed highest rank first, by their display place: the display order and the roles
// shown as groups, as indexes into the list.
export const displayOrderOf = (places: number[]) =>
  Array.from(rules().perms_display_order(Float64Array.from(places)))

export const hoistGroupsOf = (places: number[], hoist: boolean[]) =>
  Array.from(
    rules().perms_hoist_groups(Float64Array.from(places), Uint8Array.from(hoist.map(Number)))
  )
