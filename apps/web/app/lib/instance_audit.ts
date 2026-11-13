import type { InstanceAuditEntry } from './types'

export interface AuditPart {
  text: string
  // A username or a server name: blurred in streamer mode.
  name?: boolean
}

// Known actions read as a sentence; `target` says they act on an account.
const ACTIONS: Record<string, { verb: string; target: boolean }> = {
  'user.remove_phrase': { verb: 'removed the backup phrase of', target: true },
  'report_forms.change': { verb: 'changed the report forms', target: false },
}

// The longest value of a setting a line shows in full.
const VALUE_MAX = 120

const detailOf = (e: InstanceAuditEntry): Record<string, unknown> =>
  typeof e.detail === 'object' && e.detail !== null ? (e.detail as Record<string, unknown>) : {}

// Who made an entry. No actor means the account was deleted since, except on the entries the
// server marks as made by its config at a start.
const actorOf = (e: InstanceAuditEntry): AuditPart => {
  if (e.actor !== null) return { text: e.actor, name: true }
  return detailOf(e).by === 'config' ? { text: 'Server config' } : { text: 'Deleted user' }
}

// A setting's value in a line: an empty one reads "nothing", a long list is cut. `names` marks
// the values of a list of usernames.
const valuePart = (value: string, names: boolean): AuditPart => {
  if (value === '') return { text: 'nothing' }
  const text = value.length > VALUE_MAX ? `${value.slice(0, VALUE_MAX)}...` : value
  return names ? { text, name: true } : { text }
}

// Settings whose values are usernames.
const NAME_LISTS = new Set(['server_creators'])

// A changed setting: its key and, when the entry has them, the old and the new value.
const settingLine = (e: InstanceAuditEntry): AuditPart[] => {
  const { key, from, to } = detailOf(e)
  const name = typeof key === 'string' && key !== '' ? key : (e.target ?? 'a setting')
  if (typeof from !== 'string' || typeof to !== 'string') return [{ text: ` changed ${name}` }]
  const names = NAME_LISTS.has(name)
  return [
    { text: ` changed ${name} from ` },
    valuePart(from, names),
    { text: ' to ' },
    valuePart(to, names),
  ]
}

// A server the admin made for an account, which may have been deleted since.
const serverLine = (e: InstanceAuditEntry): AuditPart[] => {
  if (e.target === null) return [{ text: ' created a server' }]
  const { owner } = detailOf(e)
  const made: AuditPart[] = [{ text: ' created the server ' }, { text: e.target, name: true }]
  if (typeof owner === 'string') return [...made, { text: ' for ' }, { text: owner, name: true }]
  return owner === null ? [...made, { text: ' for a deleted user' }] : made
}

// Actions with a line of their own: what follows the actor.
const LINES: Record<string, (e: InstanceAuditEntry) => AuditPart[]> = {
  'settings.change': settingLine,
  'settings.config': settingLine,
  'server.create': serverLine,
}

// One line of the instance audit log: who did what to whom. Unknown actions show their code.
export const instanceAuditLine = (e: InstanceAuditEntry): AuditPart[] => {
  const actor = actorOf(e)
  if (Object.hasOwn(LINES, e.action)) return [actor, ...LINES[e.action](e)]
  const known = Object.hasOwn(ACTIONS, e.action) ? ACTIONS[e.action] : undefined
  const target: AuditPart[] =
    e.target !== null
      ? [{ text: ' ' }, { text: e.target, name: true }]
      : known?.target
        ? [{ text: ' a deleted user' }]
        : []
  return [actor, { text: ` ${known?.verb ?? e.action}` }, ...target]
}
