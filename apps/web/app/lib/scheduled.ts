// Scheduled messages, the same for both sides: the instance sends hosted ones (`hosted`), this
// device sends P2P ones while the app runs (`device`). Presets, checks, list state and the words
// the menus, chip and lists show.

import type { ScheduledMessage, WsEvent } from './types'

export const SCHEDULE_MIN_MS = 60_000
// The picker's floor: a minute of clock slack over the instance's.
export const PICK_MIN_MS = 120_000
export const SCHEDULE_MAX_MS = 365 * 86_400_000
// Slow mode may hold a message back this long past its time.
export const DEFER_MAX_MS = 3_600_000
// A device-held message later than this asks before it is sent.
export const MISSED_MS = 120_000
export const RETRY_BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 480_000]

export const WAITING_SLOW = 'Waiting for slow mode'
export const SLOW_FAILED = 'Slow mode kept it from sending'
export const SEND_FAILED = 'Something went wrong. Try again.'

export type PresetKind = 'hour' | 'tomorrow' | 'monday'
export const PRESET_KINDS: readonly PresetKind[] = ['hour', 'tomorrow', 'monday']

const MINUTE = 60_000
const HOUR = 3_600_000

export const presetTime = (kind: PresetKind, now: Date): number => {
  if (kind === 'hour') return Math.ceil((now.getTime() + HOUR) / MINUTE) * MINUTE
  const d = new Date(now.getTime())
  const days = kind === 'tomorrow' ? 1 : (1 - d.getDay() + 7) % 7 || 7
  d.setDate(d.getDate() + days)
  d.setHours(9, 0, 0, 0)
  return d.getTime()
}

const range = (at: number, now: number, floor: number, soon: string): string | null => {
  if (!Number.isFinite(at)) return 'Pick a date and time'
  if (at < now + floor) return soon
  if (at > now + SCHEDULE_MAX_MS) return 'Pick a time within a year'
  return null
}

export const scheduleProblem = (at: number, now: number) =>
  range(at, now, SCHEDULE_MIN_MS, 'Pick a time at least 1 minute ahead')

export const pickProblem = (at: number, now: number) =>
  range(at, now, PICK_MIN_MS, 'Pick a time at least 2 minutes ahead')

// Calendar days from `now` to `at` in the local zone.
const dayDiff = (at: number, now: number) => {
  const day = (ms: number) => {
    const d = new Date(ms)
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000
  }
  return day(at) - day(now)
}

const timeOf = (at: number, locale?: string) =>
  new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(at)

// "Today at 4:42 PM", "Tomorrow at 9:00 AM", "Monday at 9:00 AM" within 6 days, "Mon, Dec 1 at
// 9:00 AM" this year, "Dec 1, 2027 at 9:00 AM" past it. Local zone, the locale's hour cycle.
export const whenText = (at: number, now: number, locale?: string): string => {
  const days = dayDiff(at, now)
  const time = timeOf(at, locale)
  if (days === 0) return `Today at ${time}`
  if (days === 1) return `Tomorrow at ${time}`
  if (days === -1) return `Yesterday at ${time}`
  if (days > 1 && days <= 6)
    return `${new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(at)} at ${time}`
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear()
  const date = new Intl.DateTimeFormat(
    locale,
    sameYear
      ? { weekday: 'short', month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' }
  ).format(at)
  return `${date} at ${time}`
}

// The time a preset row names: "9:00 AM".
export const presetLabel = (kind: PresetKind, now: Date, locale?: string) => {
  if (kind === 'hour') return 'In 1 hour'
  const time = timeOf(presetTime(kind, now), locale)
  return kind === 'tomorrow' ? `Tomorrow at ${time}` : `Next Monday at ${time}`
}

// The full date, time and zone, for a title.
export const whenTitle = (at: number, locale?: string) =>
  new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'long' }).format(at)

const pad = (n: number) => String(n).padStart(2, '0')

// A time as a datetime-local input shows it, in local time.
export const localInput = (ms: number, seconds = false) => {
  const d = new Date(ms)
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  return seconds ? `${base}:${pad(d.getSeconds())}` : base
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/

export const fromLocalInput = (v: string): number | null => {
  const m = LOCAL.exec(v.trim())
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1).map(x => (x === undefined ? 0 : Number(x)))
  const date = new Date(y, mo - 1, d, h, mi, s)
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null
  return date.getTime()
}

export type ScheduledSide = 'hosted' | 'device'
// `paused`: held back when the account's sessions were ended, until its owner resumes it.
export type ScheduledState = 'waiting' | 'sending' | 'failed' | 'missed' | 'paused'

// Where a scheduled message goes, as far as its owner can name it now; null when they can't
// open it.
export interface ScheduledLabel {
  server: string | null
  channel: string | null
  // The other person of a DM: their name and whose it is (for masking).
  person: string | null
  by: string | null
  thread: boolean
}

export interface ScheduledItem {
  // `h:<id>` for hosted rows, `d:<id>` for device rows: never one id space.
  key: string
  side: ScheduledSide
  // The composer draft key: hosted `c<id>`, `d<id>`, `t<root>`; P2P room keys.
  place: string
  body: string
  // The names of the files it carries, and the question of its poll.
  files: string[]
  poll: string | null
  // A hosted message id as text, or a P2P event id.
  reply: string | null
  at: number
  next: number
  state: ScheduledState
  error: string | null
  // Waiting again after slow mode held it.
  deferred: boolean
  label: ScheduledLabel | null
}

const UNSENT: readonly ScheduledState[] = ['failed', 'missed', 'paused']

export const isUnsent = (i: Pick<ScheduledItem, 'state'>) => UNSENT.includes(i.state)

// Failed, missed and paused ones first, then by time.
export const sortItems = (items: ScheduledItem[]): ScheduledItem[] =>
  [...items].sort(
    (a, b) => Number(isUnsent(b)) - Number(isUnsent(a)) || a.at - b.at || a.key.localeCompare(b.key)
  )

export const countsFor = (items: ScheduledItem[], place: string) => {
  let waiting = 0
  let unsent = 0
  for (const i of items) {
    if (i.place !== place) continue
    if (isUnsent(i)) unsent += 1
    else waiting += 1
  }
  return { waiting, unsent }
}

export const chipText = (c: { waiting: number; unsent: number }): string | null => {
  const parts = [
    c.waiting ? `${c.waiting} scheduled` : '',
    c.unsent ? `${c.unsent} not sent` : '',
  ].filter(Boolean)
  return parts.length ? parts.join(', ') : null
}

export const chipTitle = (c: { waiting: number; unsent: number }) => {
  const n = c.waiting + c.unsent
  return n === 1 ? '1 scheduled message here' : `${n} scheduled messages here`
}

export const PAUSED_TEXT = 'Paused when you were signed out everywhere'

// What a row shows of its message: the text, else its poll or its files.
export const summaryOf = (i: Pick<ScheduledItem, 'body' | 'files' | 'poll'>): string => {
  if (i.body.trim()) return i.body
  if (i.poll !== null) return `Poll: ${i.poll}`
  return i.files.join(', ')
}

export const stateText = (i: ScheduledItem): string | null => {
  if (i.state === 'failed') return `Not sent: ${i.error ?? SEND_FAILED}`
  if (i.state === 'missed') return 'Not sent while the app was closed'
  if (i.state === 'paused') return PAUSED_TEXT
  if (i.state === 'sending') return 'Sending'
  return i.deferred ? WAITING_SLOW : null
}

// "#general · Pixel Club", "Thread in #general", the person; for a place one can't open now,
// "Somewhere you can't open now".
export const NOWHERE = "Somewhere you can't open now"

export type Settle =
  | { kind: 'sent' }
  | { kind: 'defer'; next: number; note: string }
  | { kind: 'retry'; next: number }
  | { kind: 'fail'; error: string }

// Slow mode asks to wait `waitMs`: wait while that keeps it within `DEFER_MAX_MS` of its time.
export const settleWait = (at: number, now: number, waitMs: number): Settle =>
  now + waitMs <= at + DEFER_MAX_MS
    ? { kind: 'defer', next: now + waitMs, note: WAITING_SLOW }
    : { kind: 'fail', error: SLOW_FAILED }

export const isLate = (next: number, now: number) => next < now - MISSED_MS

const hostedPlace = (row: ScheduledMessage) => {
  if (row.thread_root_id !== null) return `t${row.thread_root_id}`
  if (row.channel_id !== null) return `c${row.channel_id}`
  return `d${row.dm_id}`
}

const hostedLabel = (row: ScheduledMessage): ScheduledLabel | null => {
  const p = row.place
  if (!p) return null
  return {
    server: p.server_name ?? p.server,
    channel: p.channel_name,
    person: p.dm_user?.display_name ?? null,
    by: p.dm_user?.username ?? null,
    thread: row.thread_root_id !== null,
  }
}

export const hostedKey = (id: number) => `h:${id}`

export const fromHosted = (row: ScheduledMessage): ScheduledItem => ({
  key: hostedKey(row.id),
  side: 'hosted',
  place: hostedPlace(row),
  body: row.content,
  files: row.media ? [row.media.filename] : [],
  poll: row.poll?.question ?? null,
  reply: row.reply_to === null ? null : String(row.reply_to),
  at: row.at * 1000,
  next: row.next_at * 1000,
  state: row.status,
  error: row.status === 'failed' ? row.error : null,
  deferred: row.status === 'waiting' && row.error !== null,
  label: hostedLabel(row),
})

// The hosted rows after a `scheduled_updated` or `scheduled_removed` event. Events carry no
// place names; a row keeps the label it had.
export const applyHosted = (
  items: Record<string, ScheduledItem>,
  ev: WsEvent
): Record<string, ScheduledItem> => {
  if (ev.type === 'scheduled_updated') {
    const key = hostedKey(ev.scheduled.id)
    const item = fromHosted(ev.scheduled)
    return { ...items, [key]: { ...item, label: item.label ?? items[key]?.label ?? null } }
  }
  if (ev.type === 'scheduled_removed') {
    const key = hostedKey(ev.id)
    if (!(key in items)) return items
    const { [key]: _gone, ...rest } = items
    return rest
  }
  return items
}

// A composer's draft as Send later reads it when a menu row runs. `blocked`: why Send later can't
// take it now. `pick` opens the composer's date and time picker.
export interface ComposerDraft {
  side: ScheduledSide
  place: string
  text: string
  reply: { id: string; mention: boolean } | null
  blocked: string | null
  schedule(at: number): Promise<void>
  pick(): void
}

// A row of a scheduled list as its menu reads it.
export interface ScheduledRow {
  item: ScheduledItem
  edit(): void
  sendNow(): Promise<void>
  resume(): Promise<void>
  reschedule(at: number): Promise<void>
  pick(): void
  remove(): Promise<void>
}

// What a list does with its rows, the same for hosted and device ones. Each answers null, or
// why it was refused. `max`: the longest text an edit may have.
export interface ScheduledOps {
  side: ScheduledSide
  max: number
  edit(key: string, body: string): Promise<string | null>
  removeReply(key: string): Promise<string | null>
  reschedule(key: string, at: number): Promise<string | null>
  sendNow(key: string): Promise<string | null>
  // A paused one waits for its time again.
  resume(key: string): Promise<string | null>
  remove(key: string): Promise<string | null>
}

// What Send later says it can't take from a draft right now.
export const BLOCKED = {
  text: "Send later can't take a forward or a file shared from this device",
  empty: 'Type a message first',
  long: 'Message is too long',
  off: 'Turned off on this site',
  full: (n: number) => `You have ${n} waiting`,
} as const

// Why Send later can't take a draft now, or null: `rich` (a forward, or a file this device
// would have to serve); neither text nor `files`; too long; the instance's switch off; `cap` (0
// for none) waiting already.
export const laterBlocked = (d: {
  text: string
  rich: boolean
  files?: boolean
  tooLong: boolean
  on: boolean
  cap: number
  waiting: number
}): string | null => {
  if (d.rich) return BLOCKED.text
  if (!d.text.trim() && !d.files) return BLOCKED.empty
  if (d.tooLong) return BLOCKED.long
  if (!d.on) return BLOCKED.off
  if (d.cap > 0 && d.waiting >= d.cap) return BLOCKED.full(d.cap)
  return null
}
