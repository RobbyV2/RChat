import {
  HOSTED,
  channelMask,
  checkBitsEdit,
  checkOverwriteEdit,
  hasBit,
  registry,
  type ChannelRules,
  type Ow,
  type Who,
} from './perms'
import { EVERYONE, RULES_NEXT, maskUnder } from './p2p/acl/rules'

// What the permission editors of hosted servers and P2P rooms offer and how they read it: the
// permissions in groups, labelled from the shared registry in the units of each side (hosted
// masks, P2P wire bits), a search over them, the three states of one permission in a channel or
// category rule, why a change is refused, and what a subject holds under the rules. A
// `RuleSource` is one place's rules as both editors read and write them.

export type PermGroup = 'General' | 'Text' | 'Voice' | 'Moderation' | 'Management'
export const PERM_GROUPS: readonly PermGroup[] = [
  'General',
  'Text',
  'Voice',
  'Moderation',
  'Management',
]

const GROUP_OF: Record<string, PermGroup> = {
  ViewChannels: 'General',
  ReadHistory: 'General',
  ViewMembers: 'General',
  ChangeProfile: 'General',
  CreateInvites: 'General',
  SendMessages: 'Text',
  AddReactions: 'Text',
  AttachFiles: 'Text',
  EmbedLinks: 'Text',
  CreatePolls: 'Text',
  StartThreads: 'Text',
  MentionEveryone: 'Text',
  BypassSlowmode: 'Text',
  Connect: 'Voice',
  Speak: 'Voice',
  Video: 'Voice',
  MoveMembers: 'Voice',
  DeleteMessages: 'Moderation',
  PinMessages: 'Moderation',
  Kick: 'Moderation',
  BanMembers: 'Moderation',
  TimeoutMembers: 'Moderation',
  ManageProfiles: 'Moderation',
  ViewAuditLog: 'Moderation',
  ManageReports: 'Moderation',
}

// Labels and hints where a side words a permission its own way.
const HOSTED_TEXT: Record<string, { label?: string; hint?: string }> = {
  ViewMembers: { hint: 'See who is in the server, who is online, and get member suggestions' },
  DeleteMessages: { hint: "Delete others' messages and close their polls" },
  BypassSlowmode: { hint: 'Send without waiting in slow mode channels' },
  ManageServer: { label: 'Manage server settings' },
  MentionEveryone: {
    label: 'Mention everyone and roles',
    hint: 'Use @everyone, @here and mention any role',
  },
  ViewAuditLog: { hint: 'See who changed what in this server' },
  TimeoutMembers: { hint: 'Stop members from chatting for a while' },
  ManageWebhooks: { hint: 'Create and change webhooks that post into channels' },
  ManageReports: { hint: 'See and act on reports in this server' },
  ManageProfiles: { hint: "Clear and lock other members' server profiles" },
  ChangeProfile: { hint: 'Set their own name, avatar, banner and description for this server' },
}
const P2P_TEXT: Record<string, { label?: string; hint?: string }> = {
  DeleteMessages: { hint: "Delete and pin others' messages" },
  Kick: { label: 'Kick' },
  BanMembers: { label: 'Ban' },
  ManageServer: { hint: 'Rename the server and change its settings' },
  ManageRoles: { hint: 'Make, change and give roles below their own' },
  CreateInvites: { label: 'Invite', hint: 'Invite people and make invite codes' },
  MentionEveryone: { hint: 'Use @everyone' },
}
// From the rules version where pins and giving roles have permissions of their own.
const P2P_NEXT_TEXT: Record<string, { label?: string; hint?: string }> = {
  ...P2P_TEXT,
  DeleteMessages: { hint: "Delete others' messages" },
  ManageRoles: { hint: 'Make and change roles below their own' },
  TimeoutMembers: { hint: 'Stop members from chatting for a while' },
  ManageProfiles: { hint: "Clear and lock other members' server profiles" },
  ChangeProfile: { hint: 'Set their own name, avatar, banner and description for this server' },
}

export interface PermItem {
  name: string
  label: string
  hint?: string
  group: PermGroup
  // The bit in the side's units: a hosted mask bit, or a P2P wire bit.
  bit: bigint
  // Channel and category rules can carry it.
  channel: boolean
  // @everyone holds it by default.
  everyone: boolean
}

// The permissions a side knows: every live hosted permission (`HOSTED`), or those a P2P room's
// rules version (`ruleset`) knows.
export const permItems = (ruleset: number): PermItem[] =>
  registry().flatMap(b => {
    const hosted = ruleset === HOSTED
    const live = hosted
      ? b.hosted === 'live'
      : b.p2p !== null && b.p2p.state === 'live' && b.p2p.since <= ruleset
    if (!live) return []
    const text =
      (hosted ? HOSTED_TEXT : ruleset >= RULES_NEXT ? P2P_NEXT_TEXT : P2P_TEXT)[b.name] ?? {}
    return [
      {
        name: b.name,
        label: text.label ?? b.label,
        ...(text.hint ? { hint: text.hint } : {}),
        group: GROUP_OF[b.name] ?? 'Management',
        bit: hosted ? b.value : BigInt(b.p2p!.value),
        channel: b.scope === 'channel',
        everyone: b.everyone,
      },
    ]
  })

// What @everyone may hold: on hosted servers the permissions every member starts with; in P2P
// rooms any permission.
export const everyoneItems = (ruleset: number) =>
  permItems(ruleset).filter(i => ruleset !== HOSTED || i.everyone)

export type RulePlace = 'text' | 'voice' | 'category'

// The permissions a rule of a text or voice channel, or of a category, carries. Before P2P rules
// 5 only View channels and Send messages count per channel.
export const ruleItems = (ruleset: number, place: RulePlace) => {
  const early = ruleset !== HOSTED && ruleset < RULES_NEXT
  return permItems(ruleset).filter(i => {
    if (!i.channel) return false
    if (early && i.name !== 'ViewChannels' && i.name !== 'SendMessages') return false
    if (place === 'text') return i.group !== 'Voice'
    if (place === 'voice') return i.name === 'ViewChannels' || i.group === 'Voice'
    return true
  })
}

// The items whose label or hint has every word of `q`.
export const matchItems = (items: readonly PermItem[], q: string) => {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  return items.filter(i => {
    const text = `${i.label} ${i.hint ?? ''}`.toLowerCase()
    return words.every(w => text.includes(w))
  })
}

// The items by group, in the groups' order, without empty groups.
export const groupItems = (items: readonly PermItem[]) =>
  PERM_GROUPS.map(group => ({ group, items: items.filter(i => i.group === group) })).filter(
    g => g.items.length > 0
  )

// One permission of a rule: allowed, denied, or left to what the rule's subject holds anyway.
export type Tri = 'allow' | 'inherit' | 'deny'
export const TRIS: readonly Tri[] = ['allow', 'inherit', 'deny']
export const TRI_TEXT: Record<Tri, string> = { allow: 'Allow', inherit: 'Inherit', deny: 'Deny' }

export const triOf = (rule: Ow | undefined, bit: bigint): Tri =>
  rule && hasBit(rule.allow, bit) ? 'allow' : rule && hasBit(rule.deny, bit) ? 'deny' : 'inherit'

export const withTri = (rule: Ow | undefined, bit: bigint, tri: Tri): Ow => {
  const r = rule ?? { allow: 0n, deny: 0n }
  const off = (mask: bigint) => mask & ~bit
  return {
    allow: tri === 'allow' ? r.allow | bit : off(r.allow),
    deny: tri === 'deny' ? r.deny | bit : off(r.deny),
  }
}

export const NO_GRANT = "You don't have this permission"
export const NO_DENY = "You can't deny a permission you don't have"
export const NOT_BELOW = 'This role or member is not below you'

// Why a change of a channel or category rule from `before` to `after` (canonical masks) is
// refused for someone who holds `mine` there, through the shared rules; null when it is not.
// `exempt`: no check applies to them. `subjectOk`: the subject ranks below them.
export const ruleBlock = (
  mine: bigint,
  exempt: boolean,
  before: Ow | undefined,
  after: Ow | undefined,
  subjectOk: boolean
): string | null => {
  switch (checkOverwriteEdit(mine, exempt, before, after, subjectOk)) {
    case null:
      return null
    case 'grants':
      return NO_GRANT
    case 'denies_moderation':
      return NO_DENY
    case 'outranked':
      return NOT_BELOW
  }
}

// Why a role's or @everyone's permissions may not go from `before` to `after` (canonical) for
// someone holding `mine`; null when they may.
export const bitsBlock = (
  mine: bigint,
  exempt: boolean,
  before: bigint,
  after: bigint
): string | null => (checkBitsEdit(mine, exempt, before, after) === null ? null : NO_GRANT)

// A channel or category rule in the side's units.
export interface RuleRow extends Ow {
  subject: string
  // A member's rule that combines with their roles instead of overriding them.
  merge: boolean
}

export type SubjectKind = 'everyone' | 'role' | 'member'

export const subjectKind = (subject: string, everyone: string): SubjectKind =>
  subject === everyone ? 'everyone' : subject.startsWith('r:') ? 'role' : 'member'

// One place's rules as the editors read and write them: a hosted channel or category through
// its REST routes, a P2P channel or category through signed overwrites.
export interface RuleSource {
  ruleset: number
  place: RulePlace
  // The subject of @everyone's rule (`everyone` on hosted servers, `r:everyone` in P2P rooms).
  everyone: string
  rows: RuleRow[]
  // Side units to canonical masks (P2P wire bits through the room's rules).
  canonical: (bits: bigint) => bigint
  // What we hold where the rules apply (canonical), what we hold in each channel a category's
  // rule is copied to (each change is checked there too), and whether no check applies to us.
  mine: bigint
  also: bigint[]
  exempt: boolean
  // The subject ranks below us; `lock`: why nothing of its rule may change, or null.
  subjectOk: (subject: string) => boolean
  lock: (subject: string) => string | null
  // Member rules may combine with the member's roles (hosted servers).
  merges: boolean
  write: (subject: string, rule: Ow, merge: boolean) => Promise<unknown>
  clear: (subject: string) => Promise<unknown>
  // For View as: @everyone's server permissions, each role's (by subject, side units), the
  // roles a member subject holds and who they are (an admin or owner), and the place's private
  // and read-only switches.
  everyoneBits: bigint
  roleBits: Record<string, bigint>
  memberRoles: (subject: string) => string[]
  memberWho?: (subject: string) => Who | undefined
  restrictView: boolean
  restrictSend: boolean
}

// `src` with `rows` in place of its own: the editor's view while its writes are on their way.
export const withRows = (src: RuleSource, rows: RuleRow[]): RuleSource => ({ ...src, rows })

const rowOf = (src: Pick<RuleSource, 'rows'>, subject: string) =>
  src.rows.find(r => r.subject === subject)

const canon = (src: Pick<RuleSource, 'canonical'>, o: Ow | undefined): Ow | undefined =>
  o && { allow: src.canonical(o.allow), deny: src.canonical(o.deny) }

// Why `subject`'s rule may not go from `before` to `after` (side units), or null: checked
// against what we hold where it applies and in every channel it is copied to.
const changeBlock = (
  src: RuleSource,
  subject: string,
  before: Ow | undefined,
  after: Ow | undefined
) => {
  const lock = src.lock(subject)
  if (lock) return lock
  if (src.exempt) return null
  const ok = src.subjectOk(subject)
  for (const mine of [src.mine, ...src.also]) {
    const block = ruleBlock(mine, false, canon(src, before), canon(src, after), ok)
    if (block) return block
  }
  return null
}

// Why setting `bit` of `subject`'s rule to `tri` is refused, or null.
export const triBlock = (src: RuleSource, subject: string, bit: bigint, tri: Tri) => {
  const before = rowOf(src, subject)
  return changeBlock(src, subject, before, withTri(before, bit, tri))
}

// Why taking `subject`'s rule away is refused, or null.
export const clearBlock = (src: RuleSource, subject: string) =>
  changeBlock(src, subject, rowOf(src, subject), undefined)

// Why a member rule may not switch between overriding and combining with their roles, or null:
// the switch takes the rule away and sets it again.
export const modeBlock = (src: RuleSource, subject: string) => {
  const row = rowOf(src, subject)
  return changeBlock(src, subject, row, undefined) ?? changeBlock(src, subject, undefined, row)
}

// What `subject` holds where the rules apply (canonical): @everyone as a member without roles,
// a role as a member holding only it, a member as who they are, with the roles they hold and
// their own rule.
export const viewAs = (src: RuleSource, subject: string): bigint => {
  const kind = subjectKind(subject, src.everyone)
  const held =
    kind === 'role' ? [subject] : kind === 'member' ? src.memberRoles(subject) : ([] as string[])
  const roles = held.reduce((m, r) => m | src.canonical(src.roleBits[r] ?? 0n), 0n)
  const ev = canon(src, rowOf(src, src.everyone))
  const own = kind === 'member' ? rowOf(src, subject) : undefined
  const ch: ChannelRules = {
    ...(ev ? { everyone: ev } : {}),
    restrictView: src.restrictView,
    restrictSend: src.restrictSend,
    voice: src.place === 'voice',
    roles: held.flatMap(r => {
      const o = canon(src, rowOf(src, r))
      return o ? [o] : []
    }),
    ...(own ? { member: { ...canon(src, own)!, merge: own.merge } } : {}),
  }
  const who = (kind === 'member' && src.memberWho?.(subject)) || { kind: 'member' as const, roles }
  return channelMask(who, src.canonical(src.everyoneBits), ch, src.ruleset, false, false)
}

// What a P2P member holds where a rule applies, as the room's rules count it when they admit a
// rule change: their room-wide bits (`bits`, wire) under the place's own rules (`over`, by
// subject) for @everyone, the roles they hold (`held`, role ids) and themselves (`ik`).
export const p2pMaskIn = (
  bits: number,
  owner: boolean,
  held: readonly string[],
  ik: string,
  over: Record<string, { allow: number; deny: number }>,
  place: { restrictView: boolean; restrictSend: boolean },
  rules: number
) =>
  maskUnder(
    bits,
    owner,
    {
      everyone: over[`r:${EVERYONE}`],
      roles: held.flatMap(r => over[`r:${r}`] ?? []),
      member: over[`u:${ik}`],
    },
    place,
    rules
  )

// Subjects in the order the editors list them: @everyone, then roles in `roleOrder` (highest
// first), then members by name.
export const orderSubjects = (
  subjects: readonly string[],
  everyone: string,
  roleOrder: readonly string[],
  nameOf: (subject: string) => string
) => {
  const rank = (s: string) => {
    if (s === everyone) return -1
    const i = roleOrder.indexOf(s)
    return i >= 0 ? i : s.startsWith('r:') ? roleOrder.length : roleOrder.length + 1
  }
  return [...subjects].sort(
    (a, b) => rank(a) - rank(b) || nameOf(a).localeCompare(nameOf(b)) || a.localeCompare(b)
  )
}
