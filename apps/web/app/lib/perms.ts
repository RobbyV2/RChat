// The permission rules shared with the server (`crates/perms`, compiled into `crates/wasm`).
// `ready(load)` loads it (`perms_load.ts` has the loader for pages and workers). Every decision
// below needs it loaded first. Masks are `bigint`s in canonical (hosted) values; a P2P wire mask
// is a `number`, and only `fromWire` and `toWire` cross between the two. `rules` is 0 for a hosted
// server and the rules version for a P2P room.

import {
  arr,
  bool,
  int,
  lit,
  nullable,
  num,
  obj,
  parseJson,
  str,
  union,
  type Schema,
} from './schema'

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
  perms_member_list(
    seer: number,
    bits: number,
    here: number,
    inChannel: boolean,
    flags: number
  ): number
  reports_default_forms(): string
  reports_validate(forms: string, form: string, answers: string, nameMax: number): string
  reports_allowed(
    sent: string,
    target: string | undefined,
    sameTargetSecs: number,
    targetsPerDay: number,
    perWeek: number,
    feedbackPerWeek: number,
    t: number
  ): boolean
  reports_context(held: Float64Array, reported: number, count: number): Float64Array
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

// The loaded module, for the other rule sets it carries (`report_rules.ts`).
export const sharedRules = rules

// The shared rules take and give masks as floats, exact below 2^53.
const n = (mask: bigint) => Number(mask)
const big = (mask: number) => BigInt(mask)
const floats = (masks: bigint[]) => Float64Array.from(masks, Number)

export const hasBit = (mask: bigint, bit: bigint) => (mask & bit) !== 0n

export interface Bit {
  name: string
  label: string
  value: bigint
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
    value: int().map(big),
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
export const bit = (name: string): bigint => {
  const found = registry().find(b => b.name === name)
  if (found === undefined) throw new Error(`unknown permission ${name}`)
  return found.value
}

// What everyone holds on a hosted server that stores no mask of its own.
export const baseBits = (): bigint =>
  registry()
    .filter(b => b.everyone && b.hosted === 'live')
    .reduce((m, b) => m | b.value, 0n)

export const known = (ruleset: number) => big(rules().perms_known(ruleset))
export const fromWire = (wire: number, ruleset: number) =>
  big(rules().perms_from_wire(wire >>> 0, ruleset))
export const toWire = (mask: bigint, ruleset: number, keep = 0) =>
  rules().perms_to_wire(n(mask), ruleset, keep >>> 0)

export type Who =
  | { kind: 'staff' }
  | { kind: 'owner' }
  | { kind: 'admin'; mask: bigint; roles?: bigint }
  | { kind: 'member'; roles: bigint }
  | { kind: 'visitor'; signedIn: boolean; caps: bigint }

// An admin's `roles` is the union of its role masks: only their base bits count.
const whoArgs = (who: Who): [number, number, number] => {
  switch (who.kind) {
    case 'staff':
      return [0, 0, 0]
    case 'owner':
      return [1, 0, 0]
    case 'admin':
      return [2, n(who.mask), n(who.roles ?? 0n)]
    case 'member':
      return [3, n(who.roles), 0]
    case 'visitor':
      return [who.signedIn ? 5 : 4, n(who.caps), 0]
  }
}

export interface Ow {
  allow: bigint
  deny: bigint
}

export interface ChannelRules {
  everyone?: Ow
  restrictView?: boolean
  restrictSend?: boolean
  voice?: boolean
  roles: Ow[]
  member?: Ow & { merge?: boolean }
}

export const serverBits = (who: Who, everyone: bigint, ruleset: number) =>
  big(rules().perms_server_bits(...whoArgs(who), n(everyone), ruleset))

export const channelMask = (
  who: Who,
  everyone: bigint,
  ch: ChannelRules,
  ruleset: number,
  timedOut = false,
  acting = true
) =>
  big(
    rules().perms_channel_mask(
      ...whoArgs(who),
      n(everyone),
      n(ch.everyone?.allow ?? 0n),
      n(ch.everyone?.deny ?? 0n),
      (ch.restrictView === true ? 1 : 0) |
        (ch.restrictSend === true ? 2 : 0) |
        (ch.voice === true ? 4 : 0) |
        (ch.everyone ? 8 : 0) |
        (ch.member ? 16 : 0) |
        (timedOut ? 32 : 0) |
        (acting ? 64 : 0),
      floats(ch.roles.flatMap(o => [o.allow, o.deny])),
      n(ch.member?.allow ?? 0n),
      n(ch.member?.deny ?? 0n),
      ch.member?.merge === true ? 1 : 0,
      ruleset
    )
  )

// What a channel gives everyone before any role or member row.
export const everyoneStage = (
  everyone: bigint,
  ch: Pick<ChannelRules, 'everyone' | 'restrictView' | 'restrictSend'>,
  ruleset: number
) =>
  big(
    rules().perms_everyone_stage(
      n(everyone),
      n(ch.everyone?.allow ?? 0n),
      n(ch.everyone?.deny ?? 0n),
      (ch.restrictView === true ? 1 : 0) |
        (ch.restrictSend === true ? 2 : 0) |
        (ch.everyone ? 8 : 0),
      ruleset
    )
  )

// A hosted rule as stored: its masks and the three flags a rule with both masks 0 is read from.
export interface StoredRule {
  allow: bigint
  deny: bigint
  merge?: boolean
  canView: boolean
  canSend: boolean
  canReadHistory: boolean
}

// The row a hosted rule stands for. `member` says it is a member's rule.
export const derivedRow = (rule: StoredRule, member: boolean): Ow & { merge: boolean } => {
  const [allow, deny, merge] = rules().perms_derived_row(
    n(rule.allow),
    n(rule.deny),
    (rule.canView ? 1 : 0) |
      (rule.canSend ? 2 : 0) |
      (rule.canReadHistory ? 4 : 0) |
      (member ? 8 : 0) |
      (rule.merge === true ? 16 : 0)
  )
  return { allow: big(allow), deny: big(deny), merge: merge === 1 }
}

export type Tier = 'outside' | 'plain' | 'role' | 'admin' | 'owner' | 'staff'
const TIERS: Tier[] = ['outside', 'plain', 'role', 'admin', 'owner', 'staff']

// A rank: its tier, and for a role its position and tie (a role id: a number on hosted servers,
// a string in P2P rooms), and for an admin the admin mask.
export interface Rank {
  tier: Tier
  pos?: number
  tie?: number | string
  adminMask?: bigint
}

export interface Actor {
  rank: Rank
  bits: bigint
}

const rankArgs = (r: Rank): RankArgs => [
  TIERS.indexOf(r.tier),
  r.pos ?? -1,
  typeof r.tie === 'number' ? r.tie : 0,
  typeof r.tie === 'number' ? undefined : (r.tie ?? ''),
  n(r.adminMask ?? 0n),
]

export const outranks = (a: Rank, b: Rank) => rules().perms_outranks(...rankArgs(a), ...rankArgs(b))
export const atLeast = (a: Rank, b: Rank) => rules().perms_at_least(...rankArgs(a), ...rankArgs(b))

export const mayModerate = (a: Actor, t: Actor, need: bigint, guard: boolean) =>
  rules().perms_may_moderate(
    ...rankArgs(a.rank),
    n(a.bits),
    ...rankArgs(t.rank),
    n(t.bits),
    n(need),
    guard
  )

const held = (heldAbove: boolean | undefined) => (heldAbove === undefined ? 0 : heldAbove ? 2 : 1)

// `heldAbove` is the extra test of the order guard: leave it out when the guard is off.
export const managesRole = (a: Actor, role: Rank, heldAbove?: boolean) =>
  rules().perms_manages_role(...rankArgs(a.rank), n(a.bits), ...rankArgs(role), held(heldAbove))

const NOBODY: Actor = { rank: { tier: 'outside' }, bits: 0n }

// `target` is left out when the actor gives the role to itself; `guard` is the order guard.
export const mayAssign = (
  a: Actor,
  role: Rank,
  roleBits: bigint,
  allowsOk: boolean,
  target: Actor | undefined,
  ruleset: number,
  guard = false
) =>
  rules().perms_may_assign(
    ...rankArgs(a.rank),
    n(a.bits),
    ...rankArgs(role),
    guard,
    n(roleBits),
    allowsOk,
    target !== undefined,
    ...rankArgs((target ?? NOBODY).rank),
    n((target ?? NOBODY).bits),
    ruleset
  )

// `target` is left out when the actor drops its own role.
export const mayUnassign = (a: Actor, role: Rank, target: Actor | undefined, guard = false) =>
  rules().perms_may_unassign(
    ...rankArgs(a.rank),
    n(a.bits),
    ...rankArgs(role),
    guard,
    target !== undefined,
    ...rankArgs((target ?? NOBODY).rank),
    n((target ?? NOBODY).bits)
  )

const NONE: Ow = { allow: 0n, deny: 0n }
export const granted = (before: Ow = NONE, after: Ow = NONE) =>
  big(rules().perms_granted(n(before.allow), n(before.deny), n(after.allow), n(after.deny)))
export const denied = (before: Ow = NONE, after: Ow = NONE) =>
  big(rules().perms_denied(n(before.allow), n(before.deny), n(after.allow), n(after.deny)))

export type Refusal = 'grants' | 'denies_moderation' | 'outranked'
const REFUSALS: (Refusal | null)[] = [null, 'grants', 'denies_moderation', 'outranked']

export const checkOverwriteEdit = (
  actorMask: bigint,
  exempt: boolean,
  before: Ow | undefined,
  after: Ow | undefined,
  subjectOk: boolean
): Refusal | null => {
  const b = before ?? NONE
  const a = after ?? NONE
  return REFUSALS[
    rules().perms_check_overwrite_edit(
      n(actorMask),
      exempt,
      n(b.allow),
      n(b.deny),
      n(a.allow),
      n(a.deny),
      subjectOk
    )
  ]
}

export const checkBitsEdit = (
  actorBits: bigint,
  exempt: boolean,
  before: bigint,
  after: bigint
): Refusal | null =>
  REFUSALS[rules().perms_check_bits_edit(n(actorBits), exempt, n(before), n(after))]

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
export const widens = (before: [string, bigint][], after: [string, bigint][]) => {
  const out = rules().perms_widens(
    before.map(([s]) => s).join('\n'),
    floats(before.map(([, m]) => m)),
    after.map(([s]) => s).join('\n'),
    floats(after.map(([, m]) => m))
  )
  return out === '' ? [] : out.split('\n')
}

// A channel rule as the sync check reads it: subject, allow, deny and whether it merges.
export interface SyncRule {
  subject: string
  allow: bigint
  deny: bigint
  merge: boolean
}

// The subjects that gain View or Send (Connect in a voice channel) in a channel whose rules
// `before` become `after`: @everyone (its rule's subject and its bits), each role as a member
// holding only it (`roleBits` by subject), each pair of roles as `a+b`, and each member subject
// with the roles it holds (`memberRoles`, by subject).
export const widened = (
  before: SyncRule[],
  after: SyncRule[],
  everyone: { subject: string; bits: bigint },
  roleBits: Record<string, bigint>,
  memberRoles: Record<string, string[]>,
  place: { restrictView: boolean; restrictSend: boolean; voice: boolean },
  ruleset: number
) => {
  const members = Object.entries(memberRoles)
  const rows = (list: SyncRule[]) =>
    Float64Array.from(list.flatMap(r => [n(r.allow), n(r.deny), r.merge ? 1 : 0]))
  const roles = Object.entries(roleBits)
  const out = rules().perms_widened(
    before.map(r => r.subject).join('\n'),
    rows(before),
    after.map(r => r.subject).join('\n'),
    rows(after),
    everyone.subject,
    n(everyone.bits),
    roles.map(([s]) => s).join('\n'),
    floats(roles.map(([, b]) => b)),
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

// Why a server's member list is hidden: the site turned member lists off, the server or the
// viewer's roles keep it from them, the channel does, or the server shows its members only to
// members.
export type MembersHidden = 'site' | 'server' | 'channel' | 'outside'
const HIDDEN: (MembersHidden | null)[] = [null, 'site', 'server', 'channel', 'outside']

// Who asks for a member list: a site admin, a member with their server bits (and in a channel
// what they hold there), or someone outside with @everyone's bits.
export type Seer =
  | { kind: 'staff' }
  | { kind: 'member'; server: bigint; here?: bigint }
  | { kind: 'visitor'; everyone: bigint; here?: bigint }

export interface ListPlace {
  site: boolean
  hide: boolean
  outside: boolean
}

// Whether `seer` sees a server's member list: null when it does.
export const memberListHidden = (seer: Seer, place: ListPlace): MembersHidden | null => {
  const flags = (place.site ? 1 : 0) | (place.hide ? 2 : 0) | (place.outside ? 4 : 0)
  const answer =
    seer.kind === 'staff'
      ? rules().perms_member_list(0, 0, 0, false, flags)
      : seer.kind === 'member'
        ? rules().perms_member_list(
            1,
            n(seer.server),
            n(seer.here ?? 0n),
            seer.here !== undefined,
            flags
          )
        : rules().perms_member_list(
            2,
            n(seer.everyone),
            n(seer.here ?? 0n),
            seer.here !== undefined,
            flags
          )
  return answer < HIDDEN.length ? HIDDEN[answer] : 'server'
}
