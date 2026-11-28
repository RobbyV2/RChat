import { HOSTED, baseBits, derivedRow, everyoneStage, hasBit, type Rank } from './perms'
import { outranks, roleRank } from './hierarchy'
import {
  ALL_PERMS,
  ChannelPermBit,
  Perm,
  type Channel,
  type ChannelPerm,
  type ConfirmChoice,
  type Member,
  type PasswordMembers,
  type ProfanityTarget,
  type Role,
  type RoleLimits,
  type SiteSettings,
} from './types'
import { plural } from './bytes'
import { cleanBio } from './profile_fields'

export const PERM_ITEMS: { label: string; bit: bigint; hint?: string }[] = [
  { label: 'Manage channels', bit: Perm.ManageChannels },
  {
    label: 'Manage messages',
    bit: Perm.DeleteMessages,
    hint: "Delete others' messages and close their polls",
  },
  { label: 'Pin messages', bit: Perm.PinMessages },
  {
    label: 'Bypass slow mode',
    bit: Perm.BypassSlowmode,
    hint: 'Send without waiting in slow mode channels',
  },
  { label: 'Kick', bit: Perm.Kick },
  { label: 'Delete server', bit: Perm.DeleteServer },
  { label: 'Manage server settings', bit: Perm.ManageServer },
  { label: 'Manage invites', bit: Perm.ManageInvites },
  { label: 'Manage roles', bit: Perm.ManageRoles },
  { label: 'Assign roles', bit: Perm.AssignRoles },
  { label: 'Manage admins', bit: Perm.ManageAdmins },
  {
    label: 'Mention everyone and roles',
    bit: Perm.MentionEveryone,
    hint: 'Use @everyone, @here and mention any role',
  },
  {
    label: 'View audit log',
    bit: Perm.ViewAuditLog,
    hint: 'See who changed what in this server',
  },
  {
    label: 'Timeout members',
    bit: Perm.TimeoutMembers,
    hint: 'Stop members from chatting for a while',
  },
  {
    label: 'Manage webhooks',
    bit: Perm.ManageWebhooks,
    hint: 'Create and change webhooks that post into channels',
  },
  {
    label: 'Manage reports',
    bit: Perm.ManageReports,
    hint: 'See and act on reports in this server',
  },
  {
    label: 'Reset server profiles',
    bit: Perm.ManageProfiles,
    hint: "Clear and lock other members' server profiles",
  },
]

export const PROFANITY_TARGETS: { key: ProfanityTarget; label: string }[] = [
  { key: 'messages', label: 'Messages' },
  { key: 'links', label: 'Links in messages' },
  { key: 'usernames', label: 'Usernames' },
  { key: 'server_names', label: 'Server names' },
  { key: 'channel_names', label: 'Channel names' },
  { key: 'role_names', label: 'Role names' },
  { key: 'file_names', label: 'File names' },
  { key: 'bios', label: 'Profile descriptions' },
  { key: 'channel_topics', label: 'Channel topics' },
  { key: 'category_names', label: 'Category names' },
]

type ProfanitySettings = Pick<SiteSettings, 'profanity_filter'> & {
  profanity_targets?: Partial<SiteSettings['profanity_targets']>
}

export const profanityTargetOn = (settings: ProfanitySettings, key: ProfanityTarget) =>
  settings.profanity_targets?.[key] ?? true

export const profanityTargetLocked = (settings: ProfanitySettings, key: ProfanityTarget) =>
  !settings.profanity_filter || (key === 'links' && !profanityTargetOn(settings, 'messages'))

// Strict file names only matter while the filter checks file names.
export const strictFileNamesLocked = (settings: ProfanitySettings) =>
  profanityTargetLocked(settings, 'file_names') || !profanityTargetOn(settings, 'file_names')

// The site filter blocks server content before it is posted; it never applies to P2P content.
export const siteFilterOn = (settings: ProfanitySettings) =>
  PROFANITY_TARGETS.some(
    t => profanityTargetOn(settings, t.key) && !profanityTargetLocked(settings, t.key)
  )

// Whether the site filter checks server messages, so the composer says so.
export const messageFilterOn = (settings: ProfanitySettings) =>
  profanityTargetOn(settings, 'messages') && !profanityTargetLocked(settings, 'messages')

export const NAME_MAX = 100
export const SLOWMODE_MAX = 21600

export const charCount = (text: string) => Array.from(text).length

// The length from which a message box shows how many characters are left.
export const counterFrom = (max: number) => max - Math.min(500, Math.floor(max / 4))

export const BIO_MAX = 190

const BIO_WARN = 20

export { cleanBio }

export const bioError = (text: string) =>
  charCount(cleanBio(text)) > BIO_MAX ? `Description must be at most ${BIO_MAX} characters` : null

// A character counter's announcement: nothing until at most `warn` characters are left.
export const charsLeft = (left: number, warn: number) => {
  if (left < 0) return `${plural(-left, 'character')} over the limit`
  if (left <= warn) return `${plural(left, 'character')} left`
  return ''
}

export const bioAnnouncement = (count: number, saved: boolean) =>
  saved ? 'Description saved' : charsLeft(BIO_MAX - count, BIO_WARN)

export const canDeleteChannel = (channels: Channel[], channel: Channel) =>
  channels.length > 1 &&
  (channel.kind !== 'text' || channels.filter(c => c.kind === 'text').length > 1)

export const memberPerms = (
  member: Pick<Member, 'is_admin' | 'perms' | 'role_ids'> | null | undefined,
  roles: Pick<Role, 'id' | 'perms'>[]
) => {
  if (!member) return 0n
  if (member.is_admin) return member.perms === 0n ? ALL_PERMS : member.perms & ALL_PERMS
  return (
    roles.filter(r => member.role_ids.includes(r.id)).reduce((acc, r) => acc | r.perms, 0n) &
    ALL_PERMS
  )
}

const without = (bits: bigint, held: bigint) => bits & ~held

// Your rank and theirs on a server whose role order decides who may moderate whom.
export interface Order {
  mine: Rank
  theirs: Rank
}

// Whether you may act on a member: you rank above them (`order`), or on a server whose role
// order is unconfirmed their permissions are a strict subset of yours.
export const canModerate = (perms: bigint, siteAdmin: boolean, target: bigint, order?: Order) =>
  siteAdmin ||
  (order ? outranks(order.mine, order.theirs) : without(target, perms) === 0n && target !== perms)

export const canGrant = (perms: bigint, siteAdmin: boolean, granted: bigint) =>
  siteAdmin || without(granted & ALL_PERMS, perms) === 0n

// Whether you may set a role's permissions from `current` to `next`: once the role order is
// confirmed only the permissions it gains must be yours, before that all of them.
export const canSetRoleBits = (perms: bigint, current: bigint, next: bigint, confirmed: boolean) =>
  canGrant(perms, false, confirmed ? without(next, current) : next)

export const adminMask = (stored: bigint) => (stored === 0n ? ALL_PERMS : stored & ALL_PERMS)

export const canPromote = (perms: bigint, siteAdmin: boolean) =>
  canGrant(perms, siteAdmin, ALL_PERMS)

export const rolePerms = (
  member: Pick<Member, 'role_ids'> | null | undefined,
  roles: Pick<Role, 'id' | 'perms'>[]
) => memberPerms(member && { is_admin: false, perms: 0n, role_ids: member.role_ids }, roles)

export const REVOKE_RAISES =
  "They have roles with permissions you don't have, so removing their admin would give them those."

export const canRevoke = (perms: bigint, siteAdmin: boolean, stored: bigint, roles: bigint) =>
  without(roles & ALL_PERMS, adminMask(stored)) === 0n || canGrant(perms, siteAdmin, roles)

export const canTransferTo = (
  perms: bigint,
  siteAdmin: boolean,
  storedPerms: bigint,
  myRoles = 0n
) => canGrant(perms, siteAdmin, adminMask(storedPerms)) && canGrant(perms, siteAdmin, myRoles)

export const canSetAdminPerms = (perms: bigint, siteAdmin: boolean, stored: bigint, next: bigint) =>
  (adminMask(next) & ~adminMask(stored)) === 0n || canGrant(perms, siteAdmin, adminMask(next))

// How you and a role's holder rank: `below` says the role ranks below you, `order` is as for
// `canModerate`.
export interface RoleStanding {
  below: boolean
  order?: Order
}

const NO_STANDING: RoleStanding = { below: true }

const canAssignRole = (
  perms: bigint,
  siteAdmin: boolean,
  rolePerms: bigint,
  channelLocked: boolean,
  standing: RoleStanding
) => siteAdmin || (canGrant(perms, false, rolePerms) && standing.below && !channelLocked)

const canUnassignRole = (
  perms: bigint,
  siteAdmin: boolean,
  self: boolean,
  targetPerms: bigint,
  channelLocked: boolean,
  standing: RoleStanding
) =>
  siteAdmin ||
  ((self || (standing.below && canModerate(perms, false, targetPerms, standing.order))) &&
    !channelLocked)

export const canChangeRole = (
  perms: bigint,
  siteAdmin: boolean,
  rolePerms: bigint,
  held: boolean,
  self: boolean,
  targetPerms: bigint,
  channelLocked = false,
  standing: RoleStanding = NO_STANDING
) =>
  held
    ? canUnassignRole(perms, siteAdmin, self, targetPerms, channelLocked, standing)
    : canAssignRole(perms, siteAdmin, rolePerms, channelLocked, standing)

const NO_ROLE_LIMITS: RoleLimits = {
  held_above: [],
  channel_grants: [],
  channel_denies: [],
}

export const ROLE_NOT_BELOW = 'Only someone with a higher role can change this role.'

// Why you can't change a role, or null. `rank` is yours when the server orders its roles;
// `confirmed` says that order alone decides who manages a role.
export const roleEditBlock = (
  perms: bigint,
  siteAdmin: boolean,
  role: Pick<Role, 'id' | 'perms' | 'position'>,
  limits: RoleLimits = NO_ROLE_LIMITS,
  rank?: Rank,
  confirmed = false
) => {
  if (siteAdmin) return null
  if (rank && !outranks(rank, roleRank(role))) return ROLE_NOT_BELOW
  if (!confirmed && !canGrant(perms, false, role.perms))
    return "This role has permissions you don't have, so you can't change it."
  if (limits.held_above.includes(role.id))
    return confirmed
      ? ROLE_NOT_BELOW
      : "Someone you can't moderate has this role, so you can't change it."
  return null
}

// The ids of the roles you may move: with Manage roles, those you may change. No `perms`: site
// staff, who move every role.
export const movableRoles = (
  roles: Pick<Role, 'id' | 'perms' | 'position'>[],
  perms: bigint | undefined,
  limits?: RoleLimits,
  rank?: Rank,
  confirmed = false
) =>
  roles
    .filter(
      r =>
        perms === undefined ||
        (hasBit(perms, Perm.ManageRoles) &&
          roleEditBlock(perms, false, r, limits, rank, confirmed) === null)
    )
    .map(r => r.id)

export const roleDeleteBlock = (
  perms: bigint,
  siteAdmin: boolean,
  role: Pick<Role, 'id' | 'perms' | 'position'>,
  limits: RoleLimits = NO_ROLE_LIMITS,
  rank?: Rank,
  confirmed = false
) =>
  roleEditBlock(perms, siteAdmin, role, limits, rank, confirmed) ??
  (!siteAdmin && limits.channel_denies.includes(role.id)
    ? 'This role limits access to a channel. Deleting it would widen that access, so it needs Manage channels.'
    : null)

export const ROLE_DENY_HINT =
  'Members can lose a role by leaving and rejoining. Use Require roles for strict control.'

// The row a channel rule stands for.
export const ruleRow = (r: ChannelPerm) =>
  r.allow !== undefined && r.deny !== undefined
    ? { allow: r.allow, deny: r.deny, merge: r.mode === 'merge' }
    : derivedRow(
        {
          allow: 0n,
          deny: 0n,
          canView: r.can_view,
          canSend: r.can_send,
          canReadHistory: r.can_read_history,
        },
        r.subject.startsWith('u:')
      )

export const EVERYONE_SUBJECT = 'everyone'

// Whether a role rule denies something the channel gives everyone who views it: a member loses
// that deny with the role. `everyone` is what everyone holds in the server (the default when
// the server does not say). Needs the permission rules loaded.
export const roleDenyEscapes = (
  channel: Pick<Channel, 'kind' | 'restrict_view' | 'restrict_send'>,
  rules: ChannelPerm[],
  everyone?: bigint
) => {
  const all = rules.find(r => r.subject === EVERYONE_SUBJECT)
  const stage = everyoneStage(
    everyone ?? baseBits(),
    {
      everyone: all && ruleRow(all),
      restrictView: channel.restrict_view === true,
      restrictSend: channel.restrict_send === true,
    },
    HOSTED
  )
  const used =
    channel.kind === 'text'
      ? stage
      : stage &
        (ChannelPermBit.ViewChannels |
          ChannelPermBit.Connect |
          ChannelPermBit.Speak |
          ChannelPermBit.Video)
  return (
    hasBit(stage, ChannelPermBit.ViewChannels) &&
    rules.some(r => r.subject.startsWith('r:') && (ruleRow(r).deny & used) !== 0n)
  )
}

export type PasswordVerb = 'Set' | 'Change' | 'Clear'

export const passwordPrompt = (
  had: boolean,
  next: string,
  canRemove: boolean,
  siteAdmin: boolean,
  staysProtected = false,
  goingPublic = 'Anyone will be able to join with the server name.'
) => {
  const verb: PasswordVerb = next ? (had ? 'Change' : 'Set') : 'Clear'
  const changed = had && next !== ''
  const choices: ConfirmChoice[] = [
    {
      value: 'keep',
      label: 'Keep everyone',
      detail: changed
        ? 'Current members stay. Guests who entered the old password lose access unless you also keep guest access.'
        : 'Current members stay.',
      danger: false,
    },
  ]
  if (canRemove)
    choices.push({
      value: 'remove',
      label: 'Remove everyone except me',
      detail: [
        `Other members are removed, not banned, and can rejoin${next ? ' with the new password' : ''}.`,
        changed ? 'Guests who entered the old password lose access.' : '',
        siteAdmin ? '' : 'Members with equal or higher permissions stay.',
      ]
        .filter(Boolean)
        .join(' '),
      danger: true,
    })
  return {
    title: `${verb} Password`,
    body: next
      ? 'Joining will require the new password.'
      : staysProtected
        ? 'The server stays password protected. New people need one of the other passwords.'
        : `${goingPublic} All other passwords are revoked.`,
    confirm: verb,
    choices,
  }
}

const members = (n: number) => `${n} member${n === 1 ? '' : 's'}`

export const passwordDone = (
  verb: PasswordVerb,
  choice: PasswordMembers,
  removed: number,
  kept: number
) => {
  const head = `Password ${verb === 'Change' ? 'changed' : verb === 'Set' ? 'set' : 'cleared'}.`
  if (choice === 'keep') return `${head} Everyone stayed.`
  const gone = removed ? `Removed ${members(removed)}.` : 'No one was removed.'
  const stayed = kept ? ` ${members(kept)} with equal or higher permissions stayed.` : ''
  return `${head} ${gone}${stayed}`
}

export const serverInitial = (name: string) => {
  const trimmed = name.trim()
  const first =
    typeof Intl !== 'undefined' && 'Segmenter' in Intl
      ? new Intl.Segmenter().segment(trimmed)[Symbol.iterator]().next().value?.segment
      : Array.from(trimmed)[0]
  return first ? first.toUpperCase() : '?'
}

export const sameOriginImage = (src: string | undefined, base: string, origins: string[]) => {
  if (!src) return false
  try {
    const url = new URL(src, base)
    return (url.protocol === 'http:' || url.protocol === 'https:') && origins.includes(url.origin)
  } catch {
    return false
  }
}

const UNITS: [number, string][] = [
  [1, 'second'],
  [60, 'minute'],
  [3600, 'hour'],
  [86400, 'day'],
]

export const expiryText = (seconds: number) => {
  if (seconds <= 0) return 'Expired'
  let unit = 0
  while (
    unit < UNITS.length - 1 &&
    Math.round(seconds / UNITS[unit][0]) >= UNITS[unit + 1][0] / UNITS[unit][0]
  )
    unit += 1
  const [mult, label] = UNITS[unit]
  const n = Math.max(1, Math.round(seconds / mult))
  return `Expires in ${n} ${label}${n === 1 ? '' : 's'}`
}

export const mediaError = (e: unknown, device: 'microphone' | 'camera', purpose: string) => {
  const name = typeof e === 'object' && e !== null && 'name' in e ? String(e.name) : ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new Error(`Allow ${device} access to ${purpose}`)
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new Error(`No ${device} found`)
    case 'NotReadableError':
      return new Error(`Your ${device} is busy in another app`)
    default:
      return e instanceof Error ? e : new Error(String(e))
  }
}
