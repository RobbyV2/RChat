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
// server marks as made by its config at a start or at its command line.
const actorOf = (e: InstanceAuditEntry): AuditPart => {
  if (e.actor !== null) return { text: e.actor, name: true }
  const by = detailOf(e).by
  if (by === 'config') return { text: 'Server config' }
  return by === 'cli' ? { text: 'Command line' } : { text: 'Deleted user' }
}

// A setting's value in a line: an empty one reads "nothing", a long list is cut. `names` marks
// the values of a list of usernames.
const valuePart = (value: string, names: boolean): AuditPart => {
  if (value === '') return { text: 'nothing' }
  const text = value.length > VALUE_MAX ? `${value.slice(0, VALUE_MAX)}...` : value
  return names ? { text, name: true } : { text }
}

// Settings whose values are usernames or server names.
const NAME_LISTS = new Set(['server_creators', 'default_servers'])

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

// The kinds the audit list filters by.
export const AUDIT_KINDS = [
  { value: 'all', label: 'All' },
  { value: 'settings', label: 'Settings' },
  { value: 'accounts', label: 'Accounts' },
  { value: 'servers', label: 'Servers' },
  { value: 'sign_in', label: 'Sign-in' },
] as const

export type AuditKind = (typeof AUDIT_KINDS)[number]['value']

const KIND_PREFIXES: [string, Exclude<AuditKind, 'all'>][] = [
  ['settings.', 'settings'],
  ['report_forms.', 'settings'],
  ['user.', 'accounts'],
  ['server.', 'servers'],
  ['sso.', 'sign_in'],
  ['auth.', 'sign_in'],
]

// The kind of an entry, from its action; null for an action of no listed kind.
export const auditKind = (action: string): Exclude<AuditKind, 'all'> | null =>
  KIND_PREFIXES.find(([prefix]) => action.startsWith(prefix))?.[1] ?? null

const personOf = (person: string) => person.trim().replace(/^@+/, '').toLowerCase()

// Whether an entry is of `kind` and its line names `person`: who did it, whom it was done to,
// or a name in what changed.
export const auditMatches = (e: InstanceAuditEntry, kind: AuditKind, person: string) => {
  if (kind !== 'all' && auditKind(e.action) !== kind) return false
  const name = personOf(person)
  if (name === '') return true
  return instanceAuditLine(e).some(p => p.name === true && p.text.toLowerCase().includes(name))
}

// Whether the filters leave out any entry.
export const auditFiltered = (kind: AuditKind, person: string) =>
  kind !== 'all' || personOf(person) !== ''

// How many pages in a row without a match a filtered list loads before it waits to be asked.
export const QUIET_PAGES = 3

// Whether the list loads its next page by itself, after `quiet` pages in a row without a match.
export const autoLoads = (filtered: boolean, quiet: number) => !filtered || quiet < QUIET_PAGES

// How many of the last loaded pages, in a row, have no entry the filters keep.
export const quietPages = (pages: InstanceAuditEntry[][], kind: AuditKind, person: string) => {
  let quiet = 0
  for (let i = pages.length - 1; i >= 0; i--) {
    if (pages[i].some(e => auditMatches(e, kind, person))) break
    quiet++
  }
  return quiet
}
