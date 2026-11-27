// Timeouts: a moderator stops a member from chatting in a server for a while.

import { TIMEOUT_PRESETS } from './durations'

export {
  TIMEOUT_MAX,
  TIMEOUT_PRESETS,
  TIMEOUT_REASON_MAX as REASON_MAX,
  TIMEOUT_UNITS,
  customSeconds,
} from './durations'

// A running timeout as the app keeps it: when it ends on this device's clock (ms).
export interface Timeout {
  ends: number
  reason: string | null
}

export interface TimeoutWire {
  until: number
  remaining: number
  reason: string | null
}

// The device time a timeout ends at, from the seconds left the server sent (clock skew safe).
export const fromWire = (t: TimeoutWire, now = Date.now()): Timeout => ({
  ends: now + Math.max(0, t.remaining) * 1000,
  reason: t.reason,
})

// Your own timeout's end in unix seconds on this device's clock, from the seconds left.
export const localUntil = (remaining: number, now = Date.now()) =>
  now / 1000 + Math.max(0, remaining)

export const TIMED_OUT_MIC = 'Muted while you are timed out'
export const TIMED_OUT_CAMERA = 'Camera is off while you are timed out'
export const TIMED_OUT_SHARE = 'Screen share is off while you are timed out'
export const NO_SPEAK = "You can't speak in this voice channel"
export const NO_VIDEO = "You can't share video in this voice channel"
export const NO_CONNECT = "You can't join this voice channel"

// What a listener shows of someone's camera and screen share: nothing while a timeout mutes
// them, whatever their app announces.
export const shownMedia = (
  media: { camOn: boolean; screenOn: boolean } | undefined,
  silenced: boolean
) => ({
  cam: !silenced && (media?.camOn ?? false),
  screen: !silenced && (media?.screenOn ?? false),
})

export const running = (t: Timeout | undefined, now = Date.now()): t is Timeout =>
  t !== undefined && t.ends > now

// The members of a P2P room whose timeout runs at `now`.
export const timedOutIn = (
  members: readonly { ik: string; timeoutUntil?: number }[] | undefined,
  now = Date.now()
): string[] =>
  (members ?? []).filter(m => m.timeoutUntil !== undefined && m.timeoutUntil > now).map(m => m.ik)

// A P2P member's running timeout as the badge and the dialog read it.
export const peerTimeout = (
  m: { timeoutUntil?: number; timeoutReason?: string } | undefined,
  now = Date.now()
): Timeout | null =>
  m?.timeoutUntil !== undefined && m.timeoutUntil > now
    ? { ends: m.timeoutUntil, reason: m.timeoutReason ?? null }
    : null

// The longest wait a timer takes: a longer one fires at once.
const TIMER_MAX = 2 ** 31 - 1

// Watches an end time (ms, null while none runs) that `read` gives: `changed` runs when it
// changes on `sync`, and when it passes by the clock.
export function endWatch(read: () => number | null, changed: () => void) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let ends: number | null = null
  const stop = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  const sync = () => {
    const next = read()
    if (next === ends && (next === null || timer !== null)) return
    const moved = next !== ends
    ends = next
    stop()
    if (next !== null)
      timer = setTimeout(
        () => {
          timer = null
          sync()
        },
        Math.min(Math.max(0, next - Date.now()) + 50, TIMER_MAX)
      )
    if (moved) changed()
  }
  return { sync, stop }
}

const pad = (n: number) => String(n).padStart(2, '0')

// Time left as a short countdown: "45s", "4:05", "1:02:03", "3d 4h".
export function remainingText(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`
  if (m > 0) return `${m}:${pad(s)}`
  return `${s}s`
}

// Time left in words for tooltips: "4 minutes left".
export function remainingWords(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'} left`
  if (total >= 86400) return unit(Math.floor(total / 86400), 'day')
  if (total >= 3600) return unit(Math.floor(total / 3600), 'hour')
  if (total >= 60) return unit(Math.floor(total / 60), 'minute')
  return unit(total, 'second')
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate()

// When a timeout ends in the reader's locale: the time today, otherwise date and time.
export function untilText(ends: number, now = Date.now(), locale?: string): string {
  const at = new Date(ends)
  const opts: Intl.DateTimeFormatOptions = sameDay(at, new Date(now))
    ? { timeStyle: 'short' }
    : { dateStyle: 'medium', timeStyle: 'short' }
  return new Intl.DateTimeFormat(locale, opts).format(at)
}

export const timedOutLine = (ends: number, now = Date.now(), locale?: string) =>
  `You are timed out until ${untilText(ends, now, locale)}.`

// A duration in seconds in words, for the audit log: "10 minutes", "1 day 2 hours" (its two
// largest units, rounded down).
export function durationText(seconds: number): string {
  const preset = TIMEOUT_PRESETS.find(p => p.seconds === seconds)
  if (preset) return preset.label
  const units: [number, string][] = [
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
    [1, 'second'],
  ]
  const total = Math.max(0, Math.floor(seconds))
  const at = units.findIndex(([size]) => total >= size)
  if (at < 0) return '0 seconds'
  const words = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  const [size, word] = units[at]
  const head = words(Math.floor(total / size), word)
  const next = units[at + 1]
  const rest = next ? Math.floor((total % size) / next[0]) : 0
  return next && rest > 0 ? `${head} ${words(rest, next[1])}` : head
}
