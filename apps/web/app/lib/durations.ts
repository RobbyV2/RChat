// Lengths and message windows of moderation actions, shared by hosted servers and P2P rooms.

export const BAN_MIN = 60
export const BAN_MAX = 63_072_000
export const BAN_REASON_MAX = 300
export const PURGE_HOURS_MAX = 168

export interface Choice<T> {
  label: string
  value: T
}

// How long a ban lasts, in seconds; `null` is until someone lifts it.
export const BAN_DURATIONS: Choice<number | null>[] = [
  { label: '1 hour', value: 3600 },
  { label: '1 day', value: 86400 },
  { label: '7 days', value: 604800 },
  { label: '30 days', value: 2_592_000 },
  { label: 'Permanent', value: null },
]

// How far back a ban deletes the member's messages, in hours; 0 is none.
export const PURGE_WINDOWS: Choice<number>[] = [
  { label: 'None', value: 0 },
  { label: '1 hour', value: 1 },
  { label: '24 hours', value: 24 },
  { label: '7 days', value: 168 },
]

const whole = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x)

export const banSeconds = (x: unknown): number | null =>
  whole(x) && x >= BAN_MIN && x <= BAN_MAX ? x : null

export const purgeHours = (x: unknown): number | null =>
  whole(x) && x >= 0 && x <= PURGE_HOURS_MAX ? x : null

export const cleanReason = (text: string): string | null => {
  const reason = [...text.trim()].slice(0, BAN_REASON_MAX).join('')
  return reason === '' ? null : reason
}

// What a ban dialog hands to its adapter.
export interface BanChoice {
  seconds: number | null
  reason: string | null
  purgeHours: number
}

// What one side can do with a ban: P2P rooms on older rules ban without an end and hide either
// nothing or everything.
export interface BanSupport {
  timed: boolean
  purge: 'none' | 'all' | 'window'
}

export const PURGE_ALL = -1

// The heading of the message choice: a wipe window deletes, a wipe of everything only hides
// until the ban is lifted.
export const purgeLabel = (purge: BanSupport['purge']) =>
  purge === 'all' ? 'Hide their messages' : 'Delete their messages from'
export const PURGE_ALL_NOTE = 'They show again if the ban is lifted.'

export const purgeChoices = (purge: BanSupport['purge']): Choice<number>[] =>
  purge === 'window'
    ? PURGE_WINDOWS
    : purge === 'all'
      ? [PURGE_WINDOWS[0], { label: 'All', value: PURGE_ALL }]
      : []

// The choice as `support` allows it: no end where bans can't be timed, no window where there is
// none.
export const fitBan = (choice: BanChoice, support: BanSupport): BanChoice => ({
  seconds: support.timed ? choice.seconds : null,
  reason: choice.reason,
  purgeHours:
    support.purge === 'window'
      ? (purgeHours(choice.purgeHours) ?? 0)
      : support.purge === 'all' && choice.purgeHours === PURGE_ALL
        ? PURGE_ALL
        : 0,
})

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate()

// When something ends in the reader's locale: the time today, otherwise date and time.
export function endsText(ends: number, now = Date.now(), locale?: string): string {
  const at = new Date(ends)
  const time = at.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
  if (sameDay(at, new Date(now))) return time
  return `${at.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' })}, ${time}`
}

export const HOSTED_BAN: BanSupport = { timed: true, purge: 'window' }
export const HOSTED_BAN_NOTE =
  "They are removed from the server and can't join again until the ban ends or is lifted."
export const P2P_BAN_NOTE = "They can't come back until the ban ends or is lifted."

// The body of the hosted ban request for a choice.
export const hostedBan = (
  choice?: BanChoice
): { duration_secs?: number; reason?: string; purge_hours?: number } => {
  if (!choice) return {}
  const fit = fitBan(choice, HOSTED_BAN)
  return {
    ...(fit.seconds !== null ? { duration_secs: fit.seconds } : {}),
    ...(fit.reason !== null ? { reason: fit.reason } : {}),
    ...(fit.purgeHours > 0 ? { purge_hours: fit.purgeHours } : {}),
  }
}

const places = (n: number) => `${n} ${n === 1 ? 'place' : 'places'}`

// What to tell the moderator when a ban could not delete messages everywhere.
export const purgeNote = (done: { purge_skipped: number; purge_busy: number }): string | null => {
  const notes = [
    ...(done.purge_skipped > 0
      ? [`Messages in ${places(done.purge_skipped)} were kept. You can't delete there.`]
      : []),
    ...(done.purge_busy > 0
      ? [
          `Messages in ${places(done.purge_busy)} were kept. A deletion of yours is already running there.`,
        ]
      : []),
  ]
  return notes.length ? notes.join(' ') : null
}

// What a P2P ban carries for a choice. Its length counts from the time the ban is signed.
export const p2pBan = (
  choice: BanChoice,
  support: BanSupport
): { wipe: boolean; reason?: string; seconds?: number; purgeH?: number } => {
  const fit = fitBan(choice, support)
  return {
    wipe: fit.purgeHours !== 0,
    ...(fit.reason !== null ? { reason: fit.reason } : {}),
    ...(fit.seconds !== null ? { seconds: fit.seconds } : {}),
    ...(fit.purgeHours > 0 ? { purgeH: fit.purgeHours } : {}),
  }
}

// What a P2P room supports: timed bans and wipe windows from the rules that read them, and any
// wipe only for a member who may manage messages.
export const p2pBanSupport = (timed: boolean, manageMessages: boolean): BanSupport => ({
  timed,
  purge: !manageMessages ? 'none' : timed ? 'window' : 'all',
})
