import type { InstanceAuditEntry } from './types'

export interface AuditPart {
  text: string
  // A username or a server name: blurred in streamer mode.
  name?: boolean
}

// Known actions read as a sentence; `target` says they act on an account.
const ACTIONS: Record<string, { verb: string; target: boolean }> = {
  'user.remove_phrase': { verb: 'removed the backup phrase of', target: true },
  'user.create': { verb: 'created the account of', target: true },
  'user.temp_password': { verb: 'gave a new temporary password to', target: true },
  'user.sign_out': { verb: 'signed out', target: true },
  'report_forms.change': { verb: 'changed the report forms', target: false },
  'encryption.backed_up': { verb: 'saved a copy of the key file', target: false },
  'encryption.rotate': { verb: 'rotated data keys', target: false },
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

// An account added to a server, either of which may have been deleted since.
const addedLine = (e: InstanceAuditEntry): AuditPart[] => {
  const { server } = detailOf(e)
  const who: AuditPart =
    e.target === null ? { text: 'a deleted user' } : { text: e.target, name: true }
  return typeof server === 'string'
    ? [{ text: ' added ' }, who, { text: ' to ' }, { text: server, name: true }]
    : [{ text: ' added ' }, who, { text: ' to a server' }]
}

// An account that replaced its temporary password: the actor is the account itself.
const passwordSetLine = (): AuditPart[] => [{ text: ' chose their own password' }]

// The names of the brand's controls and images.
const BRAND_PARTS: Record<string, string> = {
  instance_name: 'the instance name',
  app_name: 'the app name',
  app_short_name: 'the short name',
  brand_about: 'the about text',
  brand_links: 'the links',
  login_note: 'the sign-in note',
  instance_suggestions: 'the suggested instances',
  logo: 'the logo',
}

// A change to the brand: which part, never its text.
const brandLine = (e: InstanceAuditEntry): AuditPart[] => {
  const { key } = detailOf(e)
  if (key === 'announcements') {
    return [
      {
        text:
          detailOf(e).action === 'remove'
            ? ' removed an announcement'
            : ' scheduled an announcement',
      },
    ]
  }
  const part = typeof key === 'string' ? key : (e.target ?? '')
  const named = Object.hasOwn(BRAND_PARTS, part)
    ? BRAND_PARTS[part]
    : part.startsWith('mark-')
      ? 'the mark'
      : 'the brand'
  return [{ text: ` changed ${named}` }]
}

const countOf = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null

const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

// A server in a staff entry, which may have been deleted since.
const serverPart = (e: InstanceAuditEntry): AuditPart =>
  e.target === null ? { text: 'a deleted server' } : { text: e.target, name: true }

// A server opened with instance powers.
const staffServerLine = (e: InstanceAuditEntry): AuditPart[] => [
  { text: ' opened ' },
  serverPart(e),
  { text: ' as staff' },
]

// A channel opened past its own rules: the entry has its id, never its name.
const staffChannelLine = (e: InstanceAuditEntry): AuditPart[] => {
  const id = countOf(detailOf(e).channel)
  return [
    { text: id === null ? ' opened a private channel of ' : ` opened private channel ${id} of ` },
    serverPart(e),
  ]
}

// A search that found messages in channels opened as staff: counts only.
const staffSearchLine = (e: InstanceAuditEntry): AuditPart[] => {
  const { hits, channels } = detailOf(e)
  const found = countOf(hits)
  const places = Array.isArray(channels) ? channels.length : null
  if (found === null || places === null) return [{ text: ' searched private channels' }]
  return [
    {
      text: ` found ${counted(found, 'message', 'messages')} in ${counted(places, 'private channel', 'private channels')} by search`,
    },
  ]
}

// A file loaded from a channel opened as staff.
const staffMediaLine = (e: InstanceAuditEntry): AuditPart[] => {
  const id = countOf(detailOf(e).channel)
  return [
    {
      text: id === null ? ' opened a file in a channel of ' : ` opened a file in channel ${id} of `,
    },
    serverPart(e),
    { text: ' as staff' },
  ]
}

// The reports to a server's moderators, read with instance powers.
const reportViewLine = (e: InstanceAuditEntry): AuditPart[] => [
  { text: ' read the reports of ' },
  serverPart(e),
  { text: ' as staff' },
]

// P2P backups and synced identities the instance held for an account: counts only.
const p2pDataLine = (e: InstanceAuditEntry): AuditPart[] => {
  const { op, backups, identities } = detailOf(e)
  const who: AuditPart =
    e.target === null ? { text: 'a deleted user' } : { text: e.target, name: true }
  const verb = op === 'purge' ? ' removed' : ' viewed'
  const held = [
    [countOf(backups), 'backup', 'backups'] as const,
    [countOf(identities), 'identity', 'identities'] as const,
  ].flatMap(([n, one, many]) => (n === null ? [] : [counted(n, one, many)]))
  const size = held.length ? ` (${held.join(', ')})` : ''
  return [{ text: `${verb} the P2P data held for ` }, who, ...(size ? [{ text: size }] : [])]
}

const isStaffAction = (action: string) => action.startsWith('staff.') || action === 'report.view'

// The reason a staff entry was given, after its line.
const reasonParts = (e: InstanceAuditEntry): AuditPart[] => {
  const { reason } = detailOf(e)
  return isStaffAction(e.action) && typeof reason === 'string' && reason !== ''
    ? [{ text: `. Reason: ${reason}` }]
    : []
}

// "Require encryption" for the site, or for one server, which may have been deleted since.
const requiredLine = (e: InstanceAuditEntry): AuditPart[] => {
  const verb = detailOf(e).on === false ? ' stopped requiring' : ' required'
  if (e.action === 'encryption.required')
    return [{ text: `${verb} encrypted storage on this site` }]
  return e.target === null
    ? [{ text: `${verb} encrypted storage in a server` }]
    : [{ text: `${verb} encrypted storage in ` }, { text: e.target, name: true }]
}

// Actions with a line of their own: what follows the actor.
const LINES: Record<string, (e: InstanceAuditEntry) => AuditPart[]> = {
  'settings.change': settingLine,
  'settings.config': settingLine,
  'server.create': serverLine,
  'server.add_member': addedLine,
  'user.password_set': passwordSetLine,
  'branding.change': brandLine,
  'staff.view_server': staffServerLine,
  'staff.view_channel': staffChannelLine,
  'staff.search': staffSearchLine,
  'staff.media': staffMediaLine,
  'staff.p2p_data': p2pDataLine,
  'report.view': reportViewLine,
  'encryption.required': requiredLine,
  'encryption.server_required': requiredLine,
}

// One line of the instance audit log: who did what to whom. Unknown actions show their code.
export const instanceAuditLine = (e: InstanceAuditEntry): AuditPart[] => {
  const actor = actorOf(e)
  if (Object.hasOwn(LINES, e.action)) return [actor, ...LINES[e.action](e), ...reasonParts(e)]
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
  { value: 'staff', label: 'Staff access' },
] as const

export type AuditKind = (typeof AUDIT_KINDS)[number]['value']

const KIND_PREFIXES: [string, Exclude<AuditKind, 'all'>][] = [
  ['settings.', 'settings'],
  ['branding.', 'settings'],
  ['report_forms.', 'settings'],
  ['encryption.', 'settings'],
  ['user.', 'accounts'],
  ['server.', 'servers'],
  ['sso.', 'sign_in'],
  ['auth.', 'sign_in'],
  ['staff.', 'staff'],
  ['report.view', 'staff'],
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
