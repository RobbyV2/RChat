import { nameWithUsername } from './display_name'
import type { Message } from './types'

export const JOIN_LINES = [
  '{name} joined the party.',
  '{name} is here.',
  'Welcome, {name}. Say hi!',
  '{name} just showed up.',
  'Everyone welcome {name}!',
  '{name} hopped into the server.',
] as const

export const LEAVE_LINE = '{name} left the server.'

export const DEFAULT_CHANNEL = 'Default channel'

// What a `storage` line says, by its content: the switch a member changed, or the site's
// requirement.
export const STORAGE_LINES: Record<string, string> = {
  on: '{name} turned on encrypted storage for new messages.',
  off: '{name} turned off encrypted storage for new messages. Messages stored encrypted stay encrypted.',
  forced: '{name} now requires encrypted storage.',
  unforced: '{name} no longer requires encrypted storage.',
}

export const STORAGE_LINE = '{name} changed how messages are stored.'

// Who a storage line names when no member is behind it.
export const SITE_NAME = 'This site'

type SystemRow = Pick<Message, 'id' | 'kind'> & Partial<Pick<Message, 'content'>>

export const isStorage = (m: Pick<Message, 'kind'>) => m.kind === 'storage'

// A storage line that turns encrypted storage on, shown with a closed lock.
export const sealsFromHere = (m: Pick<Message, 'kind'> & Partial<Pick<Message, 'content'>>) =>
  isStorage(m) && (m.content === 'on' || m.content === 'forced')

export const isSystem = (m: Pick<Message, 'kind'>) =>
  m.kind === 'join' || m.kind === 'leave' || isStorage(m)

// A storage line the site wrote: it has no author.
export const bySite = (m: Pick<Message, 'kind' | 'author'>) =>
  isStorage(m) && m.author.username === ''

// A pin, join/leave or storage line: its menu offers delete, select and its id only.
export const isNotice = (m: Pick<Message, 'kind'>) => m.kind === 'pin' || isSystem(m)

// The same message always gets the same line, on every client.
const template = (m: SystemRow) =>
  isStorage(m)
    ? (STORAGE_LINES[m.content ?? ''] ?? STORAGE_LINE)
    : m.kind === 'join'
      ? JOIN_LINES[((m.id % JOIN_LINES.length) + JOIN_LINES.length) % JOIN_LINES.length]
      : LEAVE_LINE

// The text around the name, so the name itself can open the profile card.
export const systemParts = (m: SystemRow): [string, string] => {
  const [before = '', after = ''] = template(m).split('{name}')
  return [before, after]
}

export const systemText = (m: SystemRow & Pick<Message, 'author'>) =>
  template(m).replace('{name}', () => (bySite(m) ? SITE_NAME : nameWithUsername(m.author)))

export const SYSTEM_CHANNEL_LABEL = 'Channel for join and leave messages'
export const SYSTEM_DEFAULT_NOTE = 'The default channel is the first text channel.'
export const SYSTEM_JOIN_LABEL = 'Show a message when someone joins'
export const SYSTEM_LEAVE_LABEL = 'Show a message when someone leaves'
export const SYSTEM_HERE_TITLE = 'Send join and leave messages here'
export const SYSTEM_HERE_DONE = 'Join and leave messages go here now'

export interface SystemChoice {
  value: string
  label: string
  // The channel's name, where the choice is one: shown after a "#".
  channel?: string
}

// Text channels the server has, after "Default channel". A saved channel the viewer can't
// see stays selectable so saving other fields doesn't move it.
export const systemChoices = (
  channels: readonly { id: number | string; name: string; kind?: string }[],
  saved: number | string | null
): SystemChoice[] => {
  const text = channels.filter(c => c.kind === 'text')
  const list: SystemChoice[] = [{ value: '', label: DEFAULT_CHANNEL }]
  for (const c of text) list.push({ value: String(c.id), label: `#${c.name}`, channel: c.name })
  if (saved !== null && !text.some(c => String(c.id) === String(saved)))
    list.push({ value: String(saved), label: 'Hidden channel' })
  return list
}

export const choiceId = (value: string): number | null => (value === '' ? null : Number(value))
