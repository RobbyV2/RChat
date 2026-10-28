import type { Channel, Message } from './types'

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

type SystemRow = Pick<Message, 'id' | 'kind'>

export const isSystem = (m: Pick<Message, 'kind'>) => m.kind === 'join' || m.kind === 'leave'

// The same message always gets the same line, on every client.
const template = (m: SystemRow) =>
  m.kind === 'join'
    ? JOIN_LINES[((m.id % JOIN_LINES.length) + JOIN_LINES.length) % JOIN_LINES.length]
    : LEAVE_LINE

// The text around the name, so the name itself can open the profile card.
export const systemParts = (m: SystemRow): [string, string] => {
  const [before = '', after = ''] = template(m).split('{name}')
  return [before, after]
}

export const systemText = (m: SystemRow & Pick<Message, 'author'>) =>
  template(m).replace('{name}', () => m.author.display_name)

export interface SystemChoice {
  value: string
  label: string
}

// Text channels the server has, after "Default channel". A saved channel the viewer can't
// see stays selectable so saving other fields doesn't move it.
export const systemChoices = (channels: Channel[], saved: number | null): SystemChoice[] => {
  const text = channels.filter(c => c.kind === 'text')
  const list: SystemChoice[] = [{ value: '', label: DEFAULT_CHANNEL }]
  for (const c of text) list.push({ value: String(c.id), label: `#${c.name}` })
  if (saved !== null && !text.some(c => c.id === saved))
    list.push({ value: String(saved), label: 'Hidden channel' })
  return list
}

export const choiceId = (value: string): number | null => (value === '' ? null : Number(value))
