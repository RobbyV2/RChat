import { inCode } from './autocomplete'

// Discord-style timestamp tokens: `<t:SECONDS>` or `<t:SECONDS:STYLE>`, shown in the reader's
// locale and time zone.

export const STYLES = ['t', 'T', 'd', 'D', 'f', 'F', 'R'] as const
export type StampStyle = (typeof STYLES)[number]
export const DEFAULT_STYLE: StampStyle = 'f'

export const STYLE_LABELS: Record<StampStyle, string> = {
  t: 'Short time',
  T: 'Long time',
  d: 'Short date',
  D: 'Long date',
  f: 'Short date and time',
  F: 'Long date and time',
  R: 'Relative',
}

// The range a JS Date can hold, in seconds.
export const STAMP_MAX = 8.64e12

const TOKEN = /<t:(-?\d{1,13})(?::([tTdDfFR]))?>/g

export interface StampPart {
  text: string
  stamp: { ms: number; style: StampStyle } | null
}

const toMs = (digits: string): number | null => {
  const seconds = Number(digits)
  return Number.isSafeInteger(seconds) && Math.abs(seconds) <= STAMP_MAX ? seconds * 1000 : null
}

export const messageStampToken = (createdAt: number) => `<t:${createdAt}:F>`

// Splits text into plain runs and timestamps. Invalid tokens stay plain text.
export function splitStamps(text: string): StampPart[] {
  const out: StampPart[] = []
  let last = 0
  for (const m of text.matchAll(TOKEN)) {
    const ms = toMs(m[1])
    if (ms === null) continue
    const at = m.index
    if (at > last) out.push({ text: text.slice(last, at), stamp: null })
    out.push({
      text: m[0],
      stamp: { ms, style: (m[2] as StampStyle | undefined) ?? DEFAULT_STYLE },
    })
    last = at + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), stamp: null })
  return out
}

export interface FormatOptions {
  locale?: string
  timeZone?: string
}

const STYLE_OPTIONS: Record<Exclude<StampStyle, 'R'> | 'full', Intl.DateTimeFormatOptions> = {
  t: { timeStyle: 'short' },
  T: { timeStyle: 'medium' },
  d: { year: 'numeric', month: '2-digit', day: '2-digit' },
  D: { dateStyle: 'long' },
  f: { dateStyle: 'long', timeStyle: 'short' },
  F: { dateStyle: 'full', timeStyle: 'short' },
  full: { dateStyle: 'full', timeStyle: 'short' },
}

const dateFormats = new Map<string, Intl.DateTimeFormat>()
const dateFormat = (key: keyof typeof STYLE_OPTIONS, o: FormatOptions) => {
  const id = `${key}|${o.locale ?? ''}|${o.timeZone ?? ''}`
  let f = dateFormats.get(id)
  if (!f) {
    f = new Intl.DateTimeFormat(o.locale, { ...STYLE_OPTIONS[key], timeZone: o.timeZone })
    dateFormats.set(id, f)
  }
  return f
}

const relFormats = new Map<string, Intl.RelativeTimeFormat>()
const relFormat = (o: FormatOptions) => {
  const id = o.locale ?? ''
  let f = relFormats.get(id)
  if (!f) {
    f = new Intl.RelativeTimeFormat(o.locale, { numeric: 'auto' })
    relFormats.set(id, f)
  }
  return f
}

const UNITS: [Intl.RelativeTimeFormatUnit, number, number][] = [
  ['second', 1, 60],
  ['minute', 60, 60],
  ['hour', 3600, 24],
  ['day', 86400, 30],
  ['month', 2629800, 12],
  ['year', 31557600, Infinity],
]

export function relativeTime(ms: number, now: number, o: FormatOptions = {}) {
  const seconds = (ms - now) / 1000
  for (const [unit, size, limit] of UNITS) {
    const n = unit === 'second' ? Math.trunc(seconds) : Math.round(seconds / size)
    if (Math.abs(n) < limit) return relFormat(o).format(n, unit)
  }
  return ''
}

export const formatStamp = (ms: number, style: StampStyle, now: number, o: FormatOptions = {}) =>
  style === 'R' ? relativeTime(ms, now, o) : dateFormat(style, o).format(ms)

// The full date and time, for hover titles.
export const fullTime = (ms: number, o: FormatOptions = {}) => dateFormat('full', o).format(ms)

export const fullTimeOf = (seconds: number) => fullTime(seconds * 1000)

const dayKey = (ms: number, o: FormatOptions) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: o.timeZone }).format(ms)

// The calendar day before a `YYYY-MM-DD` key, independent of daylight saving.
const dayBefore = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
}

// The time next to a message: the time today, "Yesterday at …", or the short date and time.
export function messageTime(ms: number, now: number, o: FormatOptions = {}) {
  const time = dateFormat('t', o).format(ms)
  const day = dayKey(ms, o)
  if (day === dayKey(now, o)) return time
  if (day === dayBefore(dayKey(now, o)) && ms < now) return `Yesterday at ${time}`
  return `${dateFormat('d', o).format(ms)} ${time}`
}

// Message text with each timestamp outside code replaced by its formatted text, for snippets,
// search results and notifications.
export const plainStamps = (text: string, now: number = Date.now(), o: FormatOptions = {}) => {
  if (!text.includes('<t:')) return text
  let at = 0
  return splitStamps(text)
    .map(p => {
      const start = at
      at += p.text.length
      return p.stamp && !inCode(text, start)
        ? formatStamp(p.stamp.ms, p.stamp.style, now, o)
        : p.text
    })
    .join('')
}

// When the shared clock next has to tick: every second while any relative time is under a
// minute away (or will be before the next minute), otherwise at the next minute.
export function tickDelay(targets: readonly number[], now: number): number | null {
  if (!targets.length) return null
  let next: number | null = null
  for (const t of targets) {
    const gap = Math.abs(t - now)
    const wait = gap < 61000 ? 1000 - (now % 1000) : t > now ? t - now - 60000 : null
    if (wait !== null && (next === null || wait < next)) next = wait
  }
  const minute = 60000 - (now % 60000)
  return Math.max(1, next === null ? minute : Math.min(next, minute))
}

export interface StampTrigger {
  start: number
  end: number
  seconds: number | null
}

const TRIGGER = /<t:(-?\d{0,13})(?::[tTdDfFR]?)?$/

// `<t:` (optionally with the seconds and a style) just before the caret, outside code.
export function findStampTrigger(text: string, caret: number): StampTrigger | null {
  const m = TRIGGER.exec(text.slice(Math.max(0, caret - 20), caret))
  if (!m) return null
  const start = caret - m[0].length
  if (inCode(text, start)) return null
  const ms = m[1] && m[1] !== '-' ? toMs(m[1]) : null
  return { start, end: caret, seconds: ms === null ? null : ms / 1000 }
}

// The text after accepting a timestamp choice: replaces the trigger (and a `>` already after
// the caret), padding a space unless whitespace follows.
export function acceptStamp(text: string, trigger: StampTrigger, token: string) {
  const end = text[trigger.end] === '>' ? trigger.end + 1 : trigger.end
  const pad = /\s/.test(text[end] ?? '') ? '' : ' '
  return {
    text: text.slice(0, trigger.start) + token + pad + text.slice(end),
    caret: trigger.start + token.length + pad.length,
  }
}

export interface StampChoice {
  style: StampStyle
  token: string
  preview: string
}

export const stampChoices = (seconds: number, now: number, o: FormatOptions = {}): StampChoice[] =>
  STYLES.map(style => ({
    style,
    token: `<t:${seconds}:${style}>`,
    preview: formatStamp(seconds * 1000, style, now, o),
  }))
