import { PERM_ITEMS } from './rules'
import { slowLabel } from './slowmode'
import { durationText } from './timeouts'
import type { AuditEntry } from './types'

export type AuditGroup = 'member' | 'role' | 'channel' | 'server' | 'access' | 'message'

export const AUDIT_GROUPS: { key: AuditGroup; label: string }[] = [
  { key: 'member', label: 'Members' },
  { key: 'role', label: 'Roles' },
  { key: 'channel', label: 'Channels' },
  { key: 'server', label: 'Server' },
  { key: 'access', label: 'Access' },
  { key: 'message', label: 'Messages' },
]

export const groupOf = (action: string): AuditGroup | null => {
  const head = action.split('.')[0]
  return AUDIT_GROUPS.some(g => g.key === head) ? (head as AuditGroup) : null
}

// A sentence as text runs; `name` runs are usernames or server names (streamer blur).
export type Part = { text: string; name?: boolean }

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
  topic: 'Topic',
  slowmode_seconds: 'Slow mode',
  restrict_view: 'Require roles to view',
  restrict_send: 'Require roles to send',
  color: 'Color',
  perms: 'Permissions',
  mentionable: 'Anyone can mention',
  banner_color: 'Banner color',
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
}

export const fieldLabel = (field: string) => FIELD_LABELS[field] ?? field.replaceAll('_', ' ')

export const permNames = (bits: number) => {
  const names = PERM_ITEMS.filter(p => (bits & p.bit) !== 0).map(p => p.label)
  return names.length ? names.join(', ') : 'None'
}

const RULE_FIELDS = new Set(['can_view', 'can_send', 'can_read_history'])

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
    if (field === 'system_channel') return 'Default channel'
    if (field === 'expires_at') return 'Never'
    if (field === 'max_uses') return 'Unlimited'
    if (field === 'until') return 'Not timed out'
    return 'None'
  }
  if (typeof v === 'boolean') {
    if (RULE_FIELDS.has(field)) return v ? 'Allowed' : 'Denied'
    return v ? 'On' : 'Off'
  }
  if (typeof v === 'number') {
    if (field === 'slowmode_seconds') return slowLabel(v)
    if (field === 'perms') return permNames(v)
    if (field === 'expires_at' || field === 'until') return new Date(v * 1000).toLocaleString()
    if (field === 'duration' || field === 'remaining') return durationText(v)
    return String(v)
  }
  if (typeof v === 'string') {
    if (field === 'kind') return v === 'voice' ? 'Voice' : 'Text'
    if (field === 'permanent_password') return PASSWORD_MODES[v] ?? v
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
  'reason',
]

// Extra facts of an entry next to its changes, as label and value.
export const factsOf = (entry: AuditEntry): [string, string][] =>
  FACTS.filter(k => k in entry.details).map(k => [fieldLabel(k), valueText(k, entry.details[k])])

const actorParts = (entry: AuditEntry): Part[] => {
  if (entry.staff) return [{ text: 'Instance staff' }]
  if (entry.actor) return [{ text: entry.actor.display_name, name: true }]
  return [{ text: 'Deleted user' }]
}

const userParts = (entry: AuditEntry): Part[] => {
  const t = entry.target
  if (!t || entry.hidden) return [{ text: 'someone' }]
  if (t.staff) return [{ text: 'Instance staff' }]
  if (t.deleted) return [{ text: 'Deleted user' }]
  const name = t.user?.display_name ?? t.name
  return name ? [{ text: name, name: true }] : [{ text: 'someone' }]
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
  return name ? [{ text: name, name: true }] : [{ text: 'someone' }]
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

function accessMode(entry: AuditEntry, actor: Part[]): Part[] {
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

// Whether a details value is a server name (streamer blur).
export const isNameValue = (entry: AuditEntry, field: string) =>
  entry.action === 'server.update' && field === 'name'

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
      return [...actor, t(' unbanned '), ...user]
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
    case 'member.admin_grant':
      return [...actor, t(' made '), ...user, t(' an admin')]
    case 'member.admin_revoke':
      return [...actor, t(' removed '), ...user, t(' as admin')]
    case 'member.admin_transfer':
      return [...actor, t(' handed admin to '), ...user]
    case 'member.admin_perms':
      return [...actor, t(' changed the admin permissions of '), ...user]
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
    case 'server.update': {
      const list = changesOf(entry)
      const only = list.length === 1 ? list[0] : null
      if (only?.field === 'name')
        return [...actor, t(' renamed the server to '), { text: String(only.after), name: true }]
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
    case 'message.attachment_remove':
      return [...actor, t(' removed an attachment from a message by '), ...user, t(` in ${ch()}`)]
    case 'message.pin':
      return [...actor, t(' pinned a message by '), ...user, t(` in ${ch()}`)]
    case 'message.unpin':
      return [...actor, t(' unpinned a message by '), ...user, t(` in ${ch()}`)]
    default:
      return [...actor, t(` did ${entry.action}`)]
  }
}

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
