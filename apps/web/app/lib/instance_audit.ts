import type { InstanceAuditEntry } from './types'

export interface AuditPart {
  text: string
  // A username: blurred in streamer mode.
  name?: boolean
}

// Known actions read as a sentence; `target` says they act on an account.
const ACTIONS: Record<string, { verb: string; target: boolean }> = {
  'user.remove_phrase': { verb: 'removed the backup phrase of', target: true },
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

// A setting's value in a line: an empty one reads "nothing", a long list is cut.
const shown = (value: string): string => {
  if (value === '') return 'nothing'
  return value.length > VALUE_MAX ? `${value.slice(0, VALUE_MAX)}...` : value
}

// A changed setting: its key and, when the entry has them, the old and the new value.
const settingLine = (e: InstanceAuditEntry): AuditPart[] => {
  const { key, from, to } = detailOf(e)
  const name = typeof key === 'string' && key !== '' ? key : (e.target ?? 'a setting')
  const values =
    typeof from === 'string' && typeof to === 'string'
      ? [{ text: ` from ${shown(from)} to ${shown(to)}` }]
      : []
  return [{ text: ` changed ${name}` }, ...values]
}

// Actions with a line of their own: what follows the actor.
const LINES: Record<string, (e: InstanceAuditEntry) => AuditPart[]> = {
  'settings.change': settingLine,
  'settings.config': settingLine,
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
