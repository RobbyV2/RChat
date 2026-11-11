// The season calendar: which celebrations are on for a local civil date. Pure; the caller passes
// the device's local date (and time zone for the hemisphere guess).
import {
  dayNum,
  diwaliNewMoon,
  easter,
  hanukkah,
  holiFullMoon,
  islamicStartsIn,
  nthWeekday,
  orthodoxEaster,
  solarTermMs,
  dayAt,
  weekday,
} from './astro'
import { HKO_FIRST, HKO_LAST, LUNAR_NEW_YEAR, MID_AUTUMN } from './hko_table'

export type Hemisphere = 'north' | 'south'

// How particles move: fall from the top, rise from the bottom, drift sideways while falling,
// burst from points (fireworks), or one sprite walking along the bottom edge.
export type Motion = 'fall' | 'rise' | 'drift' | 'burst' | 'walk'

export const SEASON_IDS = [
  'new_year',
  'lunar_new_year',
  'valentines',
  'leap_day',
  'pi_day',
  'st_patricks',
  'holi',
  'march_equinox',
  'easter',
  'april_fools',
  'earth_day',
  'eid_al_fitr',
  'june_solstice',
  'eid_al_adha',
  'mid_autumn',
  'september_equinox',
  'halloween',
  'diwali',
  'day_of_the_dead',
  'thanksgiving',
  'hanukkah',
  'december_solstice',
  'christmas',
  'friday_13',
] as const
export type SeasonId = (typeof SEASON_IDS)[number]

export interface Season {
  id: SeasonId
  // The settings row.
  label: string
  // Inclusive [first, last] day numbers of each occurrence that starts in Gregorian year y.
  windows(y: number): [number, number][]
  glyphs(h: Hemisphere, y: number): string[]
  // Plain colored dots mixed into the particles (Holi's powder).
  dots?: string[]
  motion: Motion
  // false: no rain; the day only changes empty-state glyphs and copy (and April Fools' style).
  rain: boolean
  // The owner's named seasons: while on, they always hold one of the two rain slots.
  anchor?: true
  // The days a season ranks first, whatever else is on (inclusive day numbers, by year).
  peak?(y: number): [number, number][]
  // Equinoxes and solstices: they mix into a rain but never give the empty-state glyph while a
  // celebration is on.
  minor?: true
}

const day = (y: number, m: number, d: number): [number, number] => [
  dayNum(y, m, d),
  dayNum(y, m, d),
]
const span = (a: number, b: number): [number, number] => [a, b]
const iso = (s: string) => dayNum(+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10))
const ZODIAC = ['🐀', '🐂', '🐅', '🐇', '🐉', '🐍', '🐎', '🐐', '🐒', '🐓', '🐕', '🐖']
// The local date of a solar term, from its UTC instant and the device's offset that day.
let termOffset: (ms: number) => number = () => 0
export const setTermOffset = (f: (ms: number) => number) => {
  termOffset = f
}
const term = (y: number, w: 0 | 1 | 2 | 3) => {
  const ms = solarTermMs(y, w)
  return dayAt(ms, termOffset(ms))
}
const around = (n: number, before: number, after: number) => span(n - before, n + after)
const north = (h: Hemisphere, n: string[], s: string[]) => (h === 'north' ? n : s)

const SPRING = ['🌸', '🌷', '🌱', '🐝']
const AUTUMN = ['🍂', '🍁', '🍄', '🌰']
const SUMMER = ['🌞', '🌻', '🍉']
const WINTER = ['❄️', '🌙', '⭐']

export const SEASONS: readonly Season[] = [
  {
    id: 'new_year',
    label: 'New Year',
    windows: y => [span(dayNum(y, 12, 31), dayNum(y + 1, 1, 1))],
    glyphs: () => ['🎆', '🎇', '🥂', '🎉', '✨'],
    motion: 'burst',
    rain: true,
  },
  {
    id: 'lunar_new_year',
    label: 'Lunar New Year',
    windows: y => (y >= HKO_FIRST && y <= HKO_LAST ? [around(iso(LUNAR_NEW_YEAR[y]), 1, 14)] : []),
    glyphs: (_h, y) => ['🧧', '🏮', '🎆', ZODIAC[(((y - 2020) % 12) + 12) % 12]],
    motion: 'rise',
    rain: true,
  },
  {
    id: 'valentines',
    label: "Valentine's Day",
    windows: y => [day(y, 2, 14)],
    glyphs: () => ['💘', '💖', '💝', '🌹', '💌'],
    motion: 'rise',
    rain: true,
  },
  {
    id: 'leap_day',
    label: 'Leap day',
    windows: y => (dayNum(y, 3, 1) - dayNum(y, 2, 28) === 2 ? [day(y, 2, 29)] : []),
    glyphs: () => ['🐸'],
    motion: 'fall',
    rain: true,
  },
  {
    id: 'pi_day',
    label: 'Pi Day',
    windows: y => [day(y, 3, 14)],
    glyphs: () => ['π', '🥧'],
    motion: 'fall',
    rain: true,
  },
  {
    id: 'st_patricks',
    label: "St Patrick's Day",
    windows: y => [day(y, 3, 17)],
    glyphs: () => ['☘️', '🍀', '🌈'],
    motion: 'drift',
    rain: true,
  },
  {
    id: 'holi',
    label: 'Holi',
    windows: y => [around(holiFullMoon(y), 0, 1)],
    glyphs: () => ['🎨', '🌈'],
    dots: ['#e91e63', '#ffeb3b', '#4caf50', '#2196f3', '#9c27b0', '#ff9800'],
    motion: 'burst',
    rain: true,
  },
  {
    id: 'march_equinox',
    minor: true,
    label: 'March equinox',
    windows: y => [around(term(y, 0), 2, 2)],
    glyphs: h => north(h, SPRING, AUTUMN),
    motion: 'drift',
    rain: true,
  },
  {
    id: 'easter',
    label: 'Easter',
    windows: y => {
      const w = easter(y)
      const o = orthodoxEaster(y)
      return o === w ? [around(w, 2, 1)] : [around(w, 2, 1), around(o, 2, 1)]
    },
    glyphs: () => ['🥚', '🐣', '🐰', '🌷'],
    motion: 'fall',
    rain: true,
  },
  {
    id: 'april_fools',
    label: "April Fools' Day",
    windows: y => [day(y, 4, 1)],
    glyphs: () => ['🃏'],
    motion: 'fall',
    rain: false,
  },
  {
    id: 'earth_day',
    label: 'Earth Day',
    windows: y => [day(y, 4, 22)],
    glyphs: () => ['🌍', '🌱', '🌳'],
    motion: 'drift',
    rain: true,
  },
  {
    id: 'eid_al_fitr',
    label: 'Eid al-Fitr',
    windows: y => islamicStartsIn(y, 10).map(s => span(s, s + 3)),
    glyphs: () => ['🌙', '⭐', '🕌', '✨'],
    motion: 'fall',
    rain: true,
  },
  {
    id: 'june_solstice',
    minor: true,
    label: 'June solstice',
    windows: y => [around(term(y, 1), 2, 2)],
    glyphs: h => north(h, SUMMER, WINTER),
    motion: 'fall',
    rain: true,
  },
  {
    id: 'eid_al_adha',
    label: 'Eid al-Adha',
    windows: y => islamicStartsIn(y, 12).map(s => span(s + 9, s + 13)),
    glyphs: () => ['🌙', '🐑', '🕌', '✨'],
    motion: 'fall',
    rain: true,
  },
  {
    id: 'mid_autumn',
    label: 'Mid-Autumn Festival',
    windows: y => (y >= HKO_FIRST && y <= HKO_LAST ? [around(iso(MID_AUTUMN[y]), 1, 1)] : []),
    glyphs: () => ['🥮', '🏮', '🌕', '🐇'],
    motion: 'rise',
    rain: true,
  },
  {
    id: 'september_equinox',
    minor: true,
    label: 'September equinox',
    windows: y => [around(term(y, 2), 2, 2)],
    glyphs: h => north(h, AUTUMN, SPRING),
    motion: 'drift',
    rain: true,
  },
  {
    id: 'halloween',
    anchor: true,
    peak: y => [day(y, 10, 31)],
    label: 'Halloween',
    windows: y => [span(dayNum(y, 10, 1), dayNum(y, 10, 31))],
    glyphs: () => ['🎃', '👻', '🦇', '🕷️', '🍬', '🕸️'],
    motion: 'fall',
    rain: true,
  },
  {
    id: 'diwali',
    label: 'Diwali',
    windows: y => [around(diwaliNewMoon(y), 2, 2)],
    glyphs: () => ['🪔', '✨', '🎆', '🌼'],
    motion: 'rise',
    rain: true,
  },
  {
    id: 'day_of_the_dead',
    label: 'Day of the Dead',
    windows: y => [span(dayNum(y, 11, 1), dayNum(y, 11, 2))],
    glyphs: () => ['🌼', '💀', '🕯️'],
    motion: 'drift',
    rain: true,
  },
  {
    // The two weeks, Monday to Sunday, that end the Sunday after US Thanksgiving.
    id: 'thanksgiving',
    label: 'Thanksgiving',
    windows: y => [around(nthWeekday(y, 11, 4, 4), 10, 3)],
    glyphs: () => ['🦃', '🍂', '🥧', '🌽'],
    motion: 'drift',
    rain: true,
  },
  {
    // The first candle is lit the evening before 25 Kislev; eight nights.
    id: 'hanukkah',
    label: 'Hanukkah',
    windows: y => [around(hanukkah(y), 1, 7)],
    glyphs: () => ['🕎', '✨', '🍩', '🕯️'],
    motion: 'fall',
    rain: true,
  },
  {
    id: 'december_solstice',
    minor: true,
    label: 'December solstice',
    windows: y => [around(term(y, 3), 2, 2)],
    glyphs: h => north(h, WINTER, SUMMER),
    motion: 'fall',
    rain: true,
  },
  {
    id: 'christmas',
    anchor: true,
    peak: y => [span(dayNum(y, 12, 24), dayNum(y, 12, 25))],
    label: 'Christmas and winter holidays',
    windows: y => [span(dayNum(y, 12, 1), dayNum(y, 12, 31))],
    glyphs: h => north(h, ['🎄', '❄️', '🎁', '⭐', '☃️'], ['🎄', '🎁', '⭐', '☀️', '🍓']),
    motion: 'fall',
    rain: true,
  },
  {
    id: 'friday_13',
    label: 'Friday the 13th',
    windows: y => {
      const out: [number, number][] = []
      for (let m = 1; m <= 12; m++) if (weekday(dayNum(y, m, 13)) === 5) out.push(day(y, m, 13))
      return out
    },
    glyphs: () => ['🐈‍⬛'],
    motion: 'walk',
    rain: true,
  },
]

export interface ActiveSeason {
  season: Season
  first: number
  last: number
  glyphs: string[]
  // Today is one of the season's peak days.
  peak: boolean
}

// Every season on for day number `today`: seasons on a peak day first, then the shortest window,
// ties in table order. Windows from the year before and after count, so New Year (31 Dec to
// 1 Jan) is on both days.
export function activeSeasons(
  today: number,
  hemisphere: Hemisphere,
  off: ReadonlySet<SeasonId> = new Set()
): ActiveSeason[] {
  const y = new Date(today * 86_400_000).getUTCFullYear()
  const out: (ActiveSeason & { order: number })[] = []
  SEASONS.forEach((season, order) => {
    if (off.has(season.id)) return
    for (const yy of [y - 1, y, y + 1])
      for (const [first, last] of season.windows(yy))
        if (today >= first && today <= last) {
          const peak = (season.peak?.(yy) ?? []).some(([a, b]) => today >= a && today <= b)
          out.push({ season, first, last, glyphs: season.glyphs(hemisphere, yy), peak, order })
        }
  })
  const seen = new Set<SeasonId>()
  return out
    .sort(
      (a, b) =>
        Number(b.peak) - Number(a.peak) ||
        a.last - a.first - (b.last - b.first) ||
        a.order - b.order
    )
    .filter(a => (seen.has(a.season.id) ? false : (seen.add(a.season.id), true)))
    .map(({ order: _, ...a }) => a)
}

// What a rain shows: two seasons' glyphs interleaved. The first raining season leads; an
// anchor season (Halloween, Christmas) that is on always takes one of the two slots.
export interface RainPlan {
  ids: SeasonId[]
  glyphs: string[]
  dots: string[]
  motion: Motion
}

export function rainPlan(active: ActiveSeason[]): RainPlan | null {
  const raining = active.filter(a => a.season.rain)
  if (!raining.length) return null
  const top = raining.slice(0, 2)
  const anchor = raining.find(a => a.season.anchor)
  if (anchor && !top.includes(anchor)) top[1] = anchor
  const glyphs: string[] = []
  const max = Math.max(...top.map(t => t.glyphs.length))
  for (let i = 0; i < max; i++) for (const t of top) if (t.glyphs[i]) glyphs.push(t.glyphs[i])
  return {
    ids: top.map(t => t.season.id),
    glyphs,
    dots: top.flatMap(t => t.season.dots ?? []),
    motion: top[0].season.motion,
  }
}

// The glyph an empty state shows: a peak season's, else the most specific celebration's (an
// equinox or solstice only when nothing else is on).
export const accentGlyph = (active: ActiveSeason[]) =>
  (active.find(a => !a.season.minor) ?? active[0])?.glyphs[0] ?? null

// The next season to start after `today` (for the settings line "Next: Halloween, 1 October").
export function nextSeason(today: number, hemisphere: Hemisphere, off = new Set<SeasonId>()) {
  const y = new Date(today * 86_400_000).getUTCFullYear()
  let best: { season: Season; first: number } | null = null
  for (const season of SEASONS) {
    if (off.has(season.id)) continue
    for (const yy of [y, y + 1])
      for (const [first] of season.windows(yy))
        if (first > today && (!best || first < best.first)) best = { season, first }
  }
  return best
}

// Southern-hemisphere IANA zones (by the latitude of their reference city). Everything else,
// including UTC and Etc/*, reads as northern.
// Chromium-based clients (V8) report CLDR's legacy names, such as America/Buenos_Aires for
// America/Argentina/Buenos_Aires and Pacific/Enderbury for Pacific/Kanton; both forms are here.
const SOUTH_PREFIX = ['Australia/', 'Antarctica/', 'America/Argentina/', 'Brazil/', 'Chile/']
const SOUTH = new Set([
  'America/Buenos_Aires',
  'America/Catamarca',
  'America/Cordoba',
  'America/Jujuy',
  'America/Mendoza',
  'America/Rosario',
  'Africa/Brazzaville',
  'Indian/Christmas',
  'Indian/Cocos',
  'Indian/Mahe',
  'NZ',
  'NZ-CHAT',
  'Pacific/Bougainville',
  'Pacific/Enderbury',
  'Pacific/Kanton',
  'Pacific/Nauru',
  'Pacific/Samoa',
  'America/Asuncion',
  'America/Araguaina',
  'America/Bahia',
  'America/Belem',
  'America/Campo_Grande',
  'America/Cuiaba',
  'America/Eirunepe',
  'America/Fortaleza',
  'America/Guayaquil',
  'America/La_Paz',
  'America/Lima',
  'America/Maceio',
  'America/Manaus',
  'America/Montevideo',
  'America/Noronha',
  'America/Porto_Velho',
  'America/Punta_Arenas',
  'America/Recife',
  'America/Rio_Branco',
  'America/Santarem',
  'America/Santiago',
  'America/Sao_Paulo',
  'Africa/Blantyre',
  'Africa/Bujumbura',
  'Africa/Dar_es_Salaam',
  'Africa/Gaborone',
  'Africa/Harare',
  'Africa/Johannesburg',
  'Africa/Kigali',
  'Africa/Kinshasa',
  'Africa/Luanda',
  'Africa/Lubumbashi',
  'Africa/Lusaka',
  'Africa/Maputo',
  'Africa/Maseru',
  'Africa/Mbabane',
  'Africa/Nairobi',
  'Africa/Windhoek',
  'Asia/Dili',
  'Asia/Jakarta',
  'Asia/Jayapura',
  'Asia/Makassar',
  'Atlantic/South_Georgia',
  'Atlantic/St_Helena',
  'Atlantic/Stanley',
  'Indian/Antananarivo',
  'Indian/Chagos',
  'Indian/Comoro',
  'Indian/Kerguelen',
  'Indian/Mauritius',
  'Indian/Mayotte',
  'Indian/Reunion',
  'Pacific/Apia',
  'Pacific/Auckland',
  'Pacific/Chatham',
  'Pacific/Easter',
  'Pacific/Efate',
  'Pacific/Fakaofo',
  'Pacific/Fiji',
  'Pacific/Funafuti',
  'Pacific/Galapagos',
  'Pacific/Gambier',
  'Pacific/Guadalcanal',
  'Pacific/Marquesas',
  'Pacific/Niue',
  'Pacific/Norfolk',
  'Pacific/Noumea',
  'Pacific/Pago_Pago',
  'Pacific/Pitcairn',
  'Pacific/Port_Moresby',
  'Pacific/Rarotonga',
  'Pacific/Tahiti',
  'Pacific/Tongatapu',
  'Pacific/Wallis',
])

export const hemisphereOf = (timeZone: string | undefined): Hemisphere =>
  timeZone && (SOUTH.has(timeZone) || SOUTH_PREFIX.some(p => timeZone.startsWith(p)))
    ? 'south'
    : 'north'

// The device's local civil date and the delay to its next local midnight (plus a second, so the
// timer fires on the new day). Clocks sleep in the background: callers also re-check on
// `visibilitychange`.
export function localToday(now: Date): { today: number; msToNext: number } {
  const today = dayNum(now.getFullYear(), now.getMonth() + 1, now.getDate())
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1)
  return { today, msToNext: next.getTime() - now.getTime() }
}
