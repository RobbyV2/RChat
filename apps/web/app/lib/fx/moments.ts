// Fun moments: the sent tally and its milestones, DM streaks, anniversaries, the birthday, and
// what empty states show. Pure; the app passes the clock and keeps the values through
// `writeLocal`, per account on this device. Nothing here is ever sent.
import {
  SEASONS,
  accentGlyph,
  localToday,
  rainPlan,
  type ActiveSeason,
  type SeasonId,
} from './seasons'
import { jsonObject, jsonOr } from '../schema'

export const FX_SENT_KEY = 'fx_sent'
export const FX_STREAKS_KEY = 'fx_streaks'

export const dayOf = (at: Date) => localToday(at).today

const whole = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x)

const json = (raw: string | null): unknown => {
  try {
    return jsonOr(raw, jsonObject, null)
  } catch {
    return null
  }
}

const record = (x: unknown): Record<string, unknown> | null =>
  typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : null

// Messages sent from this device for this account.
export interface SentTally {
  v: 1
  n: number
}

export const MILESTONES = [100, 1_000, 10_000] as const

export const parseSent = (raw: string | null): SentTally => {
  const o = record(json(raw))
  return { v: 1, n: o?.v === 1 && whole(o.n) && o.n >= 0 ? o.n : 0 }
}

export const sentValue = (tally: SentTally) => JSON.stringify(tally)

export function countSent(tally: SentTally): { tally: SentTally; milestone: number | null } {
  const n = tally.n + 1
  return { tally: { v: 1, n }, milestone: MILESTONES.find(m => m === n) ?? null }
}

export const milestoneLine = (n: number) =>
  `${n.toLocaleString('en-US')} messages sent from this device.`

// A DM streak: the days in a row on which both people sent a message. `me` and `them` are the
// last local day each sent, `last` the last day that counted and `run` the days in a row up to
// it.
export interface Streak {
  me: number
  them: number
  last: number
  run: number
}

export interface Streaks {
  v: 1
  dms: Record<string, Streak>
}

export const STREAK_MIN = 3
export const STREAK_DMS_MAX = 500

const lastActive = (s: Streak) => Math.max(s.me, s.them)

// The DMs quiet the longest go first.
const capped = (dms: Record<string, Streak>): Record<string, Streak> => {
  const ids = Object.keys(dms)
  if (ids.length <= STREAK_DMS_MAX) return dms
  const keep = ids
    .map((id, at) => ({ id, at, active: lastActive(dms[id]) }))
    .sort((a, b) => b.active - a.active || b.at - a.at)
    .slice(0, STREAK_DMS_MAX)
    .sort((a, b) => a.at - b.at)
  return Object.fromEntries(keep.map(({ id }) => [id, dms[id]]))
}

export const parseStreaks = (raw: string | null): Streaks => {
  const o = record(json(raw))
  const saved = o?.v === 1 ? record(o.dms) : null
  const dms: Record<string, Streak> = {}
  for (const [id, value] of Object.entries(saved ?? {})) {
    const s = record(value)
    if (!s) continue
    const { me, them, last, run } = s
    if (whole(me) && whole(them) && whole(last) && whole(run) && run >= 0)
      dms[id] = { me, them, last, run }
  }
  return { v: 1, dms: capped(dms) }
}

export const streaksValue = (streaks: Streaks) => JSON.stringify(streaks)

// A live message in a DM, on local day `day`. Returns `streaks` itself when nothing changed.
export function noteDm(streaks: Streaks, dm: string, who: 'me' | 'them', day: number): Streaks {
  const was = streaks.dms[dm] ?? { me: -1, them: -1, last: -1, run: 0 }
  if (day <= was[who]) return streaks
  const now = { ...was, [who]: day }
  if (now.me === day && now.them === day) {
    now.run = now.last === day - 1 ? now.run + 1 : 1
    now.last = day
  }
  return { v: 1, dms: capped({ ...streaks.dms, [dm]: now }) }
}

// The streak to show today: it holds through the day after its last day, and counts from
// three days.
export function streakDays(streaks: Streaks, dm: string, today: number): number {
  const s = streaks.dms[dm]
  return s && today - s.last <= 1 && today >= s.last && s.run >= STREAK_MIN ? s.run : 0
}

export const streakShown = (streaks: Streaks, dm: string, today: number, streamer: boolean) =>
  streamer ? null : streakDays(streaks, dm, today) || null

export const streakLabel = (days: number) => `${days}-day streak`

const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0

// Whether `now` is the yearly day of month `m`, day `d` on the local calendar (29 February
// falls on 28 February in other years).
const yearlyDay = (m: number, d: number, now: Date) =>
  now.getMonth() + 1 === m &&
  now.getDate() === (m === 2 && d === 29 && !leap(now.getFullYear()) ? 28 : d)

// How many years ago today `createdAt` (unix seconds) was, or 0 when today is not its day.
export function yearsToday(createdAt: number, now: Date): number {
  const made = new Date(createdAt * 1000)
  const years = now.getFullYear() - made.getFullYear()
  return years > 0 && yearlyDay(made.getMonth() + 1, made.getDate(), now) ? years : 0
}

// `birthday` is the saved 'MM-DD'.
export const isBirthday = (birthday: string | null, now: Date) =>
  birthday !== null && yearlyDay(Number(birthday.slice(0, 2)), Number(birthday.slice(3, 5)), now)

export interface Greeting {
  kind: 'birthday' | 'anniversary'
  line: string | null
  effect: 'balloons'
}

// The Home greeting of the day. Streamer mode hides the birthday altogether and the
// anniversary's line.
export function greeting(i: {
  now: Date
  createdAt: number | null
  birthday: string | null
  streamer: boolean
  momentsOn: boolean
}): Greeting | null {
  if (!i.momentsOn) return null
  if (!i.streamer && isBirthday(i.birthday, i.now))
    return { kind: 'birthday', line: 'Happy birthday 🎈', effect: 'balloons' }
  const years = i.createdAt === null ? 0 : yearsToday(i.createdAt, i.now)
  if (years === 0) return null
  return {
    kind: 'anniversary',
    line: i.streamer ? null : `Happy ${years}-year anniversary here 🎂`,
    effect: 'balloons',
  }
}

// Things that happen once a local day (the birthday rise, a server's birthday burst). Only
// today's keys are kept.
export function createOnce(saved?: unknown) {
  const o = record(saved)
  const held = whole(o?.day) && Array.isArray(o.keys) ? { day: o.day, keys: o.keys } : null
  let day = held?.day ?? -1
  let keys = new Set<string>(held?.keys.filter((k): k is string => typeof k === 'string'))
  return {
    first(key: string, today: number): boolean {
      if (today !== day) {
        day = today
        keys = new Set()
      }
      if (keys.has(key)) return false
      keys.add(key)
      return true
    },
    toJSON: () => ({ day, keys: [...keys] }),
  }
}

// The line an empty state shows under its usual text while a season is on.
export const SEASON_LINES: Record<SeasonId, string> = {
  new_year: 'A fresh year, a fresh page.',
  lunar_new_year: 'Wishing you a lucky new year.',
  valentines: 'Someone might like a hello.',
  leap_day: 'An extra day. Use it well.',
  pi_day: '3.14159 reasons to say hi.',
  st_patricks: 'Feeling lucky today?',
  holi: 'Add a little color.',
  march_equinox: 'Day and night are about even.',
  easter: 'Found any eggs yet?',
  april_fools: 'Trust nothing today.',
  earth_day: 'Quiet as a forest in here.',
  eid_al_fitr: 'Eid Mubarak.',
  june_solstice: 'The sun turns around this week.',
  eid_al_adha: 'Eid Mubarak.',
  mid_autumn: 'The moon is bright tonight.',
  september_equinox: 'Day and night are about even.',
  halloween: 'Spooky quiet in here.',
  diwali: 'Happy Diwali.',
  day_of_the_dead: 'Remember someone today.',
  thanksgiving: 'Thankful for a little quiet.',
  hanukkah: 'Happy Hanukkah.',
  december_solstice: 'The sun turns around this week.',
  christmas: 'All is calm in here.',
  friday_13: 'Nothing unlucky here. Probably.',
}

const RAIN_NAMES: Partial<Record<SeasonId, string>> = { christmas: 'Christmas' }

// The season glyph button's label.
export const rainTitle = (id: SeasonId) =>
  `Play the ${RAIN_NAMES[id] ?? SEASONS.find(s => s.id === id)?.label ?? ''} rain`

export const isNightOwl = (now: Date) => now.getHours() >= 2 && now.getHours() < 5

export interface Accent {
  glyph: string
  line: string | null
  // The label of the button that replays the day's rain, or null when the day has none.
  replay: string | null
}

// What an empty state adds: the season's glyph and line, or an owl in the small hours.
export function emptyAccent(i: {
  active: ActiveSeason[]
  now: Date
  seasonsOn: boolean
  momentsOn: boolean
}): Accent | null {
  const glyph = i.seasonsOn ? accentGlyph(i.active) : null
  if (glyph !== null) {
    const season = (i.active.find(a => !a.season.minor) ?? i.active[0]).season
    const plan = rainPlan(i.active)
    return { glyph, line: SEASON_LINES[season.id], replay: plan ? rainTitle(plan.ids[0]) : null }
  }
  return i.momentsOn && isNightOwl(i.now) ? { glyph: '🦉', line: null, replay: null } : null
}

export const CAUGHT_UP_GLYPHS = ['✨', '☕', '🌈', '🌻'] as const

// "You're all caught up.": the season's glyph, else one of four in turn.
export const caughtUpGlyph = (active: ActiveSeason[], seasonsOn: boolean, turn: number) =>
  (seasonsOn ? accentGlyph(active) : null) ??
  CAUGHT_UP_GLYPHS[((turn % 4) + 4) % CAUGHT_UP_GLYPHS.length]

// The seconds left in the last ten of 31 December, local time, else null.
export function newYearCountdown(now: Date): number | null {
  if (now.getMonth() !== 11 || now.getDate() !== 31) return null
  if (now.getHours() !== 23 || now.getMinutes() !== 59 || now.getSeconds() < 50) return null
  return 60 - now.getSeconds()
}
