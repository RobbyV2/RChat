import { ICON_KINDS } from './server_about'
import { guestLabel } from './guest_voice'
import { MODE_LABELS, isProfilesMode } from './profile_fields'
import { FOREVER, RESET_FIELDS, RESET_LABELS, isResetField } from './profile_reset'
import { diffFacts, permsDiffOf } from './audit_format'
import { HOSTED, hasBit, loaded } from './perms'
import { permItems } from './perm_source'
import { PERM_ITEMS } from './rules'
import { slowLabel } from './slowmode'
import { durationText } from './timeouts'
import type { AuditEntry } from './types'

export type AuditGroup = 'member' | 'role' | 'channel' | 'server' | 'access' | 'message' | 'webhook'

export const AUDIT_GROUPS: { key: AuditGroup; label: string }[] = [
  { key: 'member', label: 'Members' },
  { key: 'role', label: 'Roles' },
  { key: 'channel', label: 'Channels' },
  { key: 'server', label: 'Server' },
  { key: 'access', label: 'Access' },
  { key: 'message', label: 'Messages' },
  { key: 'webhook', label: 'Webhooks' },
]

export const groupOf = (action: string): AuditGroup | null => {
  const head = action.split('.')[0]
  return AUDIT_GROUPS.some(g => g.key === head) ? (head as AuditGroup) : null
}

// A sentence as text runs; `name` runs are usernames or server names (streamer blur), `by` the
// account a person's name belongs to (your own is never masked). A `person` run names `by` as
// they are now: drawn under the server's name for them, with the username after it.
export type Part = { text: string; name?: boolean; by?: string; person?: boolean }

export interface AuditChange {
  field: string
  before: unknown
  after: unknown
}

export const changesOf = (entry: AuditEntry): AuditChange[] => {
  const raw = entry.details.changes
  if (!Array.isArray(raw)) return []
  return raw.flatMap(c =>
    c && typeof c === 'object' && typeof (c as { field?: unknown }).field === 'string'
      ? [c as AuditChange]
      : []
  )
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  allow: 'Allowed',
  deny: 'Denied',
  everyone_perms: 'Everyone',
  topic: 'Topic',
  slowmode_seconds: 'Slow mode',
  text_only: 'Text only',
  restrict_view: 'Require roles to view',
  restrict_send: 'Require roles to send',
  color: 'Color',
  perms: 'Permissions',
  mentionable: 'Anyone can mention',
  icon: 'Icon',
  hoist: 'Show members separately',
  color_names: 'Color member names',
  banner_color: 'Banner color',
  description: 'Description',
  icon_kind: 'Icon',
  name_color: 'Name color',
  join_messages: 'Join messages',
  leave_messages: 'Leave messages',
  system_channel: 'Channel',
  can_view: 'View',
  can_send: 'Send',
  can_read_history: 'Read history',
  protected: 'Password protected',
  kind: 'Type',
  was_member: 'Was a member',
  guest_voice: 'Guests can use voice',
  members_visible: 'Members can be seen by people outside this server',
  members_removed: 'Members removed',
  guests_revoked: 'Guest access ended',
  passwords_revoked: 'Extra passwords revoked',
  permanent_password: 'Permanent password',
  expires_at: 'Expires',
  max_uses: 'Uses',
  channels: 'Channels moved out',
  until: 'Ends',
  duration: 'Duration',
  remaining: 'Time left',
  reason: 'Reason',
  total: 'Messages deleted',
  count: "Other people's messages",
  authors: 'Authors',
  more_authors: 'More authors',
  thread: 'Thread replies',
  owner: 'Owner',
  upload_expiry: 'File expiry',
  profiles_mode: 'Server profiles',
  lock_until: 'Locked until',
  roles: 'Roles moved',
  more_roles: 'More roles moved',
  ranked: 'Roles ranked',
}

export const fieldLabel = (field: string) => FIELD_LABELS[field] ?? field.replaceAll('_', ' ')

export const permNames = (bits: number) => {
  const names = PERM_ITEMS.filter(p => hasBit(bits, p.bit)).map(p => p.label)
  return names.length ? names.join(', ') : 'None'
}

const RULE_FIELDS = new Set(['can_view', 'can_send', 'can_read_history'])

// Masks of a channel rule or of what everyone holds, named (like role and admin permissions) by
// the shared rules once they are loaded.
const MASK_FIELDS = new Set(['allow', 'deny', 'everyone_perms'])

const PASSWORD_MODES: Record<string, string> = {
  set: 'Set',
  changed: 'Changed',
  removed: 'Removed',
  none: 'None',
}

// A stored value as shown in the details table.
export function valueText(field: string, v: unknown): string {
  if (v === null || v === undefined) {
    if (field === 'topic') return 'No topic'
    if (field === 'description') return 'No description'
    if (field === 'system_channel') return 'Default channel'
    if (field === 'expires_at') return 'Never'
    if (field === 'max_uses') return 'Unlimited'
    if (field === 'until') return 'Not timed out'
    if (field === 'lock_until') return 'Not locked'
    return 'None'
  }
  if (field === 'icon_kind' && typeof v === 'string')
    return ICON_KINDS.find(k => k.kind === v)?.label ?? v
  if (field === 'authors' && Array.isArray(v))
    return v
      .map(a => {
        const o = obj(a)
        const n = typeof o?.count === 'number' ? ` (${o.count})` : ''
        return `${str(o?.name) ?? 'Deleted user'}${n}`
      })
      .join(', ')
  if (field === 'roles' && Array.isArray(v))
    return v.map(r => str(obj(r)?.name) ?? 'Deleted role').join(', ')
  if (typeof v === 'boolean') {
    if (RULE_FIELDS.has(field)) return v ? 'Allowed' : 'Denied'
    return v ? 'On' : 'Off'
  }
  if (typeof v === 'number') {
    if (field === 'slowmode_seconds') return slowLabel(v)
    if (field === 'upload_expiry') return durationText(v)
    if ((field === 'perms' || MASK_FIELDS.has(field)) && loaded()) {
      const named = permItems(HOSTED).filter(i => hasBit(v, i.bit))
      return named.length ? named.map(i => i.label).join(', ') : 'None'
    }
    if (field === 'perms') return permNames(v)
    if (field === 'lock_until' && v >= FOREVER) return 'Until unlocked'
    if (field === 'expires_at' || field === 'until' || field === 'lock_until')
      return new Date(v * 1000).toLocaleString()
    if (field === 'duration' || field === 'remaining') return durationText(v)
    return String(v)
  }
  if (typeof v === 'string') {
    if (field === 'upload_expiry') return v === 'never' ? 'Never' : 'Default'
    if (field === 'kind') return v === 'voice' ? 'Voice' : 'Text'
    if (field === 'permanent_password') return PASSWORD_MODES[v] ?? v
    if (field === 'profiles_mode' && isProfilesMode(v)) return MODE_LABELS[v]
    return v
  }
  const o = obj(v)
  if (o && typeof o.name === 'string') return field.includes('channel') ? `#${o.name}` : o.name
  return JSON.stringify(v)
}

const FACTS = [
  'kind',
  'was_member',
  'members_removed',
  'guests_revoked',
  'passwords_revoked',
  'permanent_password',
  'expires_at',
  'max_uses',
  'channels',
  'duration',
  'remaining',
  'lock_until',
  'reason',
  'total',
  'count',
  'authors',
  'more_authors',
  'roles',
  'more_roles',
  'ranked',
]

// Extra facts of an entry next to its changes, as label and value.
export const factsOf = (entry: AuditEntry): [string, string][] => {
  const diff = permsDiffOf(entry.details.perms_diff, loaded() ? permItems(HOSTED) : [])
  return [
    ...FACTS.filter(
      k =>
        k in entry.details && !((k === 'more_authors' || k === 'more_roles') && !entry.details[k])
    ).map((k): [string, string] => [fieldLabel(k), valueText(k, entry.details[k])]),
    ...(diff ? diffFacts(diff) : []),
  ]
}

// Facts whose value names people (streamer blur).
export const isNameFact = (label: string) => label === FIELD_LABELS.authors

const actorParts = (entry: AuditEntry): Part[] => {
  if (entry.staff) return [{ text: 'Instance staff' }]
  if (entry.actor)
    return [{ text: entry.actor.display_name, name: true, by: entry.actor.username, person: true }]
  return [{ text: 'Deleted user' }]
}

const userParts = (entry: AuditEntry): Part[] => {
  const t = entry.target
  if (!t || entry.hidden) return [{ text: 'someone' }]
  if (t.kind === 'guest') return [{ text: t.name ? guestLabel(t.name) : 'a guest' }]
  if (t.staff) return [{ text: 'Instance staff' }]
  if (t.deleted) return [{ text: 'Deleted user' }]
  if (t.user) return [{ text: t.user.display_name, name: true, by: t.user.username, person: true }]
  return t.name ? [{ text: t.name, name: true }] : [{ text: 'someone' }]
}

const channelText = (entry: AuditEntry): string => {
  if (entry.hidden) return 'a private channel'
  const ch = obj(entry.details.channel)
  const name =
    (entry.target?.kind === 'channel' ? entry.target.name : null) ?? str(ch?.name) ?? null
  return name ? `#${name}` : 'a channel'
}

const quoted = (v: string | null, fallback: string) => (v ? `"${v}"` : fallback)

const subjectParts = (entry: AuditEntry): Part[] => {
  const s = obj(entry.details.subject)
  if (!s) return [{ text: 'someone' }]
  if (s.kind === 'role') return [{ text: `the role ${quoted(str(s.name), 'a deleted role')}` }]
  if (s.staff === true) return [{ text: 'Instance staff' }]
  if (s.deleted === true) return [{ text: 'Deleted user' }]
  const name = str(s.name)
  return name ? [{ text: name, name: true, by: name, person: true }] : [{ text: 'someone' }]
}

const roleText = (entry: AuditEntry) => {
  const r = obj(entry.details.role)
  return `the role ${quoted(str(r?.name) ?? entry.target?.name ?? null, 'a deleted role')}`
}

const t = (text: string): Part => ({ text })

function channelUpdate(entry: AuditEntry, actor: Part[]): Part[] {
  const ch = channelText(entry)
  const list = changesOf(entry)
  if (list.length !== 1 || entry.hidden) return [...actor, t(` updated ${ch}`)]
  const [c] = list
  if (c.field === 'name')
    return [...actor, t(` renamed #${String(c.before)} to #${String(c.after)}`)]
  if (c.field === 'topic')
    return [
      ...actor,
      t(c.after === null ? ` cleared the topic of ${ch}` : ` changed the topic of ${ch}`),
    ]
  return [
    ...actor,
    t(
      ` changed ${fieldLabel(c.field).toLowerCase()} in ${ch} from ${valueText(c.field, c.before)} to ${valueText(c.field, c.after)}`
    ),
  ]
}

const JOIN_WORDS: Record<string, string> = {
  name: ' let anyone join with the server name',
  invite: ' made the server invite only',
  password: ' made the server need a password to join',
  closed: ' closed the server to new members',
}

function accessMode(entry: AuditEntry, actor: Part[]): Part[] {
  const j = changesOf(entry).find(c => c.field === 'join_mode')
  const words = j ? JOIN_WORDS[str(j.after) ?? ''] : undefined
  if (words) return [...actor, t(words)]
  const p = changesOf(entry).find(c => c.field === 'protected')
  if (p)
    return [
      ...actor,
      t(p.after ? ' made the server password protected' : ' made the server public'),
    ]
  const mode = str(entry.details.permanent_password)
  if (mode === 'set') return [...actor, t(' set the server password')]
  if (mode === 'changed') return [...actor, t(' changed the server password')]
  if (mode === 'removed') return [...actor, t(' removed the server password')]
  return [...actor, t(' changed who can join')]
}

// How someone joined: the server's invite link, a link or an extra password, by its label and
// number.
function joinedWith(kind: string | null, label: string, id: number | null): string {
  const n = id === null ? '' : ` (#${id})`
  if (kind === 'standing') return ` joined with the invite link${n}`
  if (kind === 'link')
    return label ? ` joined with the link ${label}${n}` : ` joined with a link${n}`
  return label
    ? ` joined with the extra password ${label}${n}`
    : ` joined with an extra password${n}`
}

function systemMessages(entry: AuditEntry, actor: Part[]): Part[] {
  const list = changesOf(entry)
  const only = list.length === 1 ? list[0] : null
  if (only?.field === 'system_channel' && !entry.hidden) {
    const to = obj(only.after)
    const name = str(to?.name)
    return [
      ...actor,
      t(
        name
          ? ` moved system messages to #${name}`
          : ' moved system messages to the default channel'
      ),
    ]
  }
  return [...actor, t(' changed the join and leave messages')]
}

// What a member did to their own name in a server: the names are theirs (streamer blur).
function serverName(entry: AuditEntry): Part[] {
  const by = entry.target?.user?.username ?? entry.actor?.username
  const name = (v: unknown): Part => ({ text: str(v) ?? '', name: true, by })
  const old = entry.hidden ? null : str(entry.details.old)
  const next = entry.hidden ? null : str(entry.details.new)
  if (old && next) return [t(' changed their server name from '), name(old), t(' to '), name(next)]
  if (next) return [t(' set their server name to '), name(next)]
  if (old) return [t(' removed their server name '), name(old)]
  return [t(' changed their server name')]
}

// What a moderator cleared of a member's server profile: the parts, the member, and the name
// that went (theirs: streamer blur).
function profileReset(entry: AuditEntry, actor: Part[], user: Part[]): Part[] {
  const raw = entry.hidden ? [] : entry.details.fields
  const fields = RESET_FIELDS.filter(
    f => Array.isArray(raw) && raw.filter(isResetField).includes(f)
  )
  if (!fields.length)
    return [
      ...actor,
      t(entry.hidden ? ' reset the server profile of ' : ' locked the server profile of '),
      ...user,
    ]
  const labels = fields.map(f => RESET_LABELS[f].toLowerCase())
  const what =
    fields.length === RESET_FIELDS.length
      ? 'server profile'
      : labels.length === 1
        ? labels[0]
        : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
  const old = str(entry.details.old_name)
  const by = entry.target?.user?.username
  return [
    ...actor,
    t(` reset the ${what} of `),
    ...user,
    ...(old ? [t(', who was named '), { text: old, name: true, by }] : []),
  ]
}

// Whether a details value is a server name (streamer blur).
export const isNameValue = (entry: AuditEntry, field: string) =>
  (entry.action === 'server.update' && field === 'name') || field === 'owner'

// " and became its owner" when a webhook change moved its ownership to the actor.
const tookOver = (entry: AuditEntry): Part[] =>
  changesOf(entry).some(c => c.field === 'owner') ? [{ text: ' and became its owner' }] : []

// The readable sentence of an entry, e.g. "alice banned bob".
export function sentence(entry: AuditEntry): Part[] {
  const actor = actorParts(entry)
  const user = userParts(entry)
  const ch = () => channelText(entry)
  const label = quoted(entry.target?.name ?? null, '')
  switch (entry.action) {
    case 'member.kick':
      return [...actor, t(' kicked '), ...user]
    case 'member.ban':
      return [...actor, t(' banned '), ...user]
    case 'member.unban':
      return entry.details.expired === true
        ? [t('The ban of '), ...user, t(' ended')]
        : [...actor, t(' unbanned '), ...user]
    case 'member.timeout': {
      const d = entry.details.duration
      const changed = changesOf(entry).some(c => c.field === 'until' && c.before !== null)
      return [
        ...actor,
        t(changed ? ' changed the timeout of ' : ' timed out '),
        ...user,
        ...(typeof d === 'number' ? [t(`${changed ? ' to' : ' for'} ${durationText(d)}`)] : []),
      ]
    }
    case 'member.untimeout':
      return [...actor, t(' removed the timeout of '), ...user]
    case 'member.join':
      return [...actor, t(joinedWith(str(entry.details.kind), label, entry.target?.id ?? null))]
    case 'member.voice_disconnect':
      return [...actor, t(' disconnected '), ...user, t(` from voice in ${ch()}`)]
    case 'member.voice_mute':
      return [...actor, t(' muted '), ...user, t(` for everyone in ${ch()}`)]
    case 'member.voice_unmute':
      return [...actor, t(' unmuted '), ...user, t(` in ${ch()}`)]
    case 'member.admin_grant':
      return [...actor, t(' made '), ...user, t(' an admin')]
    case 'member.admin_revoke':
      return [...actor, t(' removed '), ...user, t(' as admin')]
    case 'member.admin_transfer':
      return [...actor, t(' handed admin to '), ...user]
    case 'member.admin_perms':
      return [...actor, t(' changed the admin permissions of '), ...user]
    case 'member.profile_name':
      return [...actor, ...serverName(entry)]
    case 'member.profile_reset':
      return profileReset(entry, actor, user)
    case 'member.profile_unlock':
      return [...actor, t(' unlocked the server profile of '), ...user]
    case 'role.create':
      return [...actor, t(` created ${roleText(entry)}`)]
    case 'role.update': {
      const list = changesOf(entry)
      const rename = list.length === 1 && list[0].field === 'name' ? list[0] : null
      return rename
        ? [...actor, t(` renamed the role "${String(rename.before)}" to "${String(rename.after)}"`)]
        : [...actor, t(` updated ${roleText(entry)}`)]
    }
    case 'role.delete':
      return [...actor, t(` deleted ${roleText(entry)}`)]
    case 'role.assign':
      return [...actor, t(' gave '), ...user, t(` ${roleText(entry)}`)]
    case 'role.unassign':
      return [...actor, t(` removed ${roleText(entry)} from `), ...user]
    case 'role.reorder':
      return [...actor, t(' changed the role order')]
    case 'role.order_confirm':
      return [...actor, t(' confirmed the role order')]
    case 'role.display_order':
      return [
        ...actor,
        t(
          entry.details.follow === true
            ? ' showed the roles in role order'
            : ' changed the order roles show in'
        ),
      ]
    case 'role.order_init':
      return [t('Roles were put in order by their permissions')]
    case 'channel.create':
      return [...actor, t(` created ${ch()}`)]
    case 'channel.update':
      return channelUpdate(entry, actor)
    case 'channel.delete':
      return [...actor, t(` deleted ${ch()}`)]
    case 'channel.perm_set':
      return [...actor, t(' set permissions for '), ...subjectParts(entry), t(` in ${ch()}`)]
    case 'channel.perm_clear':
      return [...actor, t(' removed the permissions of '), ...subjectParts(entry), t(` in ${ch()}`)]
    case 'channel.perm_sync':
      return [...actor, t(` synced the permissions of ${ch()} with its category`)]
    case 'channel.category_perms':
      return [
        ...actor,
        t(
          entry.details.removed === true ? ' removed the permissions of ' : ' set permissions for '
        ),
        ...subjectParts(entry),
        t(` in the category ${label}`),
      ]
    case 'channel.reorder':
      return [...actor, t(' reordered the channels')]
    case 'channel.category_create':
      return [...actor, t(` created the category ${label}`)]
    case 'channel.category_update': {
      const c = changesOf(entry).find(c => c.field === 'name')
      return c
        ? [...actor, t(` renamed the category "${String(c.before)}" to "${String(c.after)}"`)]
        : [...actor, t(` updated the category ${label}`)]
    }
    case 'channel.category_delete':
      return [...actor, t(` deleted the category ${label}`)]
    case 'channel.separator_create':
      return [...actor, t(label ? ` added the separator ${label}` : ' added a separator')]
    case 'channel.separator_update':
      return [...actor, t(label ? ` changed the separator ${label}` : ' changed a separator')]
    case 'channel.separator_delete':
      return [...actor, t(label ? ` deleted the separator ${label}` : ' deleted a separator')]
    case 'server.update': {
      const list = changesOf(entry)
      const only = list.length === 1 ? list[0] : null
      if (only?.field === 'name')
        return [...actor, t(' renamed the server to '), { text: String(only.after), name: true }]
      if (only?.field === 'guest_voice')
        return [...actor, t(` turned voice ${only.after === 'off' ? 'off' : 'on'} for guests`)]
      if (only?.field === 'profiles_mode')
        return [
          ...actor,
          t(` set server profiles to ${valueText(only.field, only.after).toLowerCase()}`),
        ]
      if (only?.field === 'members_visible')
        return [
          ...actor,
          t(
            only.after === false
              ? ' hid the members from people outside the server'
              : ' showed the members to people outside the server'
          ),
        ]
      if (only) return [...actor, t(` changed the server ${fieldLabel(only.field).toLowerCase()}`)]
      return [...actor, t(' updated the server settings')]
    }
    case 'server.system_messages':
      return systemMessages(entry, actor)
    case 'access.mode':
      return accessMode(entry, actor)
    case 'access.password_create':
      return [
        ...actor,
        t(
          entry.target?.name ? ` created the extra password ${label}` : ' created an extra password'
        ),
      ]
    case 'access.password_revoke':
      return [
        ...actor,
        t(
          entry.target?.name ? ` revoked the extra password ${label}` : ' revoked an extra password'
        ),
      ]
    case 'message.delete':
      return [...actor, t(' deleted a message by '), ...user, t(` in ${ch()}`)]
    case 'message.bulk_delete': {
      const n = typeof entry.details.total === 'number' ? entry.details.total : 0
      const what = `${n.toLocaleString('en-US')} ${n === 1 ? 'message' : 'messages'}`
      const where = entry.details.thread ? ` from a thread in ${ch()}` : ` in ${ch()}`
      return [...actor, t(` deleted ${what}${where}`)]
    }
    case 'message.attachment_remove':
      return [...actor, t(' removed an attachment from a message by '), ...user, t(` in ${ch()}`)]
    case 'message.pin':
      return [...actor, t(' pinned a message by '), ...user, t(` in ${ch()}`)]
    case 'message.unpin':
      return [...actor, t(' unpinned a message by '), ...user, t(` in ${ch()}`)]
    case 'message.poll_close':
      return [...actor, t(' closed a poll by '), ...user, t(` in ${ch()}`)]
    case 'message.poll_reopen':
      return [...actor, t(' reopened a poll by '), ...user, t(` in ${ch()}`)]
    case 'webhook.create':
      return [...actor, t(` created the webhook ${label} in ${ch()}`)]
    case 'webhook.update': {
      const c = changesOf(entry).find(c => c.field === 'name')
      const what = c
        ? t(` renamed the webhook "${String(c.before)}" to "${String(c.after)}"`)
        : t(` updated the webhook ${label}`)
      return [...actor, what, ...tookOver(entry)]
    }
    case 'webhook.delete':
      return [...actor, t(` deleted the webhook ${label}`)]
    case 'webhook.token_reset':
      return [...actor, t(` reset the URL of the webhook ${label}`), ...tookOver(entry)]
    case 'webhook.outgoing_create':
      return [...actor, t(` created the outgoing webhook ${label}`)]
    case 'webhook.outgoing_update':
      return [...actor, t(` updated the outgoing webhook ${label}`), ...tookOver(entry)]
    case 'webhook.outgoing_delete':
      return [...actor, t(` deleted the outgoing webhook ${label}`)]
    case 'webhook.outgoing_secret_reset':
      return [...actor, t(` reset the secret of the outgoing webhook ${label}`), ...tookOver(entry)]
    default:
      return [...actor, t(` did ${entry.action}`)]
  }
}

// The accounts entries name as people, for the lookup of how the server shows them.
export const peopleIn = (entries: readonly AuditEntry[]): string[] => [
  ...new Set(entries.flatMap(e => sentence(e).flatMap(p => (p.person && p.by ? [p.by] : [])))),
]

export const sentenceText = (entry: AuditEntry) =>
  sentence(entry)
    .map(p => p.text)
    .join('')

// Unix seconds of the start or end of a `YYYY-MM-DD` day in local time.
export const dayBound = (day: string, end: boolean): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (end) d.setDate(d.getDate() + 1)
  return Math.floor(d.getTime() / 1000) - (end ? 1 : 0)
}

export interface AuditFilters {
  group: AuditGroup | ''
  actor: string
  target: string
  from: string
  to: string
}

export const NO_FILTERS: AuditFilters = { group: '', actor: '', target: '', from: '', to: '' }

export function auditQuery(f: AuditFilters): Record<string, string> {
  const q: Record<string, string> = {}
  if (f.group) q.action = f.group
  if (f.actor.trim()) q.actor = f.actor.trim().toLowerCase()
  if (f.target.trim()) q.target = f.target.trim()
  const from = dayBound(f.from, false)
  const to = dayBound(f.to, true)
  if (from !== null) q.from = String(from)
  if (to !== null) q.to = String(to)
  return q
}
