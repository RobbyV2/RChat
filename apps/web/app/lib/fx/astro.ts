// Calendar arithmetic for the season table. Pure, no Intl, no clock.
// Civil dates are {y, m, d} with m 1-12. A "day number" is days since 1970-01-01 (proleptic
// Gregorian), so it is the same in every time zone.

export interface Ymd {
  y: number
  m: number
  d: number
}

const DAY_MS = 86_400_000

export const dayNum = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / DAY_MS

export const fromDayNum = (n: number): Ymd => {
  const t = new Date(n * DAY_MS)
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }
}

export const ymdKey = ({ y, m, d }: Ymd) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

// 0 = Sunday.
export const weekday = (n: number) => (((n + 4) % 7) + 7) % 7

// The day number of the civil date an instant falls on at a fixed UTC offset.
export const dayAt = (ms: number, offsetMinutes: number) =>
  Math.floor((ms + offsetMinutes * 60_000) / DAY_MS)

const rad = (deg: number) => (deg * Math.PI) / 180
const sin = (deg: number) => Math.sin(rad(deg))
const cos = (deg: number) => Math.cos(rad(deg))

// Julian Ephemeris Day to Unix ms (UT). Delta T is about 69-80 s over 2024-2100; a fixed 72 s
// moves no instant across a date line by more than a few seconds.
const DELTA_T_S = 72
export const jdeToMs = (jde: number) => (jde - 2440587.5) * DAY_MS - DELTA_T_S * 1000

// Meeus, Astronomical Algorithms, ch. 49: the instant of the new (phase 0) or full (phase 0.5)
// moon of lunation k (k = 0 is the new moon of 2000-01-06).
export function moonPhaseMs(k: number, phase: 0 | 0.5): number {
  const kk = Math.floor(k) + phase
  const T = kk / 1236.85
  const T2 = T * T
  const T3 = T2 * T
  const T4 = T3 * T
  let jde =
    2451550.09766 + 29.530588861 * kk + 0.00015437 * T2 - 0.00000015 * T3 + 0.00000000073 * T4
  const E = 1 - 0.002516 * T - 0.0000074 * T2
  const M = 2.5534 + 29.1053567 * kk - 0.0000014 * T2 - 0.00000011 * T3
  const Mp = 201.5643 + 385.81693528 * kk + 0.0107582 * T2 + 0.00001238 * T3 - 0.000000058 * T4
  const F = 160.7108 + 390.67050284 * kk - 0.0016118 * T2 - 0.00000227 * T3 + 0.000000011 * T4
  const Om = 124.7746 - 1.56375588 * kk + 0.0020672 * T2 + 0.00000215 * T3
  const first =
    phase === 0
      ? [-0.4072, 0.17241, 0.01608, 0.01039, 0.00739, -0.00514, 0.00208]
      : [-0.40614, 0.17302, 0.01614, 0.01043, 0.00734, -0.00515, 0.00209]
  jde +=
    first[0] * sin(Mp) +
    first[1] * E * sin(M) +
    first[2] * sin(2 * Mp) +
    first[3] * sin(2 * F) +
    first[4] * E * sin(Mp - M) +
    first[5] * E * sin(Mp + M) +
    first[6] * E * E * sin(2 * M) -
    0.00111 * sin(Mp - 2 * F) -
    0.00057 * sin(Mp + 2 * F) +
    0.00056 * E * sin(2 * Mp + M) -
    0.00042 * sin(3 * Mp) +
    0.00042 * E * sin(M + 2 * F) +
    0.00038 * E * sin(M - 2 * F) -
    0.00024 * E * sin(2 * Mp - M) -
    0.00017 * sin(Om) -
    0.00007 * sin(Mp + 2 * M) +
    0.00004 * sin(2 * Mp - 2 * F) +
    0.00004 * sin(3 * M) +
    0.00003 * sin(Mp + M - 2 * F) +
    0.00003 * sin(2 * Mp + 2 * F) -
    0.00003 * sin(Mp + M + 2 * F) +
    0.00003 * sin(Mp - M + 2 * F) -
    0.00002 * sin(Mp - M - 2 * F) -
    0.00002 * sin(3 * Mp + M) +
    0.00002 * sin(4 * Mp)
  const A = [
    [299.77 + 0.107408 * kk - 0.009173 * T2, 0.000325],
    [251.88 + 0.016321 * kk, 0.000165],
    [251.83 + 26.651886 * kk, 0.000164],
    [349.42 + 36.412478 * kk, 0.000126],
    [84.66 + 18.206239 * kk, 0.00011],
    [141.74 + 53.303771 * kk, 0.000062],
    [207.14 + 2.453732 * kk, 0.00006],
    [154.84 + 7.30686 * kk, 0.000056],
    [34.52 + 27.261239 * kk, 0.000047],
    [207.19 + 0.121824 * kk, 0.000042],
    [291.34 + 1.844379 * kk, 0.00004],
    [161.72 + 24.198154 * kk, 0.000037],
    [239.56 + 25.513099 * kk, 0.000035],
    [331.55 + 3.592518 * kk, 0.000023],
  ]
  for (const [arg, amp] of A) jde += amp * sin(arg)
  return jdeToMs(jde)
}

const SYNODIC_MS = 29.530588861 * DAY_MS
const K0_MS = jdeToMs(2451550.09766)

// The lunations whose phase instant falls in [fromMs, toMs).
export function phasesBetween(fromMs: number, toMs: number, phase: 0 | 0.5): number[] {
  const out: number[] = []
  let k = Math.floor((fromMs - K0_MS) / SYNODIC_MS) - 1
  for (;;) {
    const t = moonPhaseMs(k, phase)
    if (t >= toMs) return out
    if (t >= fromMs) out.push(t)
    k += 1
  }
}

// The last phase instant strictly before `ms`.
export function phaseBefore(ms: number, phase: 0 | 0.5): number {
  let k = Math.floor((ms - K0_MS) / SYNODIC_MS) + 1
  while (moonPhaseMs(k, phase) >= ms) k -= 1
  return moonPhaseMs(k, phase)
}

// Meeus ch. 27: March equinox (0), June solstice (1), September equinox (2), December solstice (3).
const SEASON_MEAN = [
  [2451623.80984, 365242.37404, 0.05169, -0.00411, -0.00057],
  [2451716.56767, 365241.62603, 0.00325, 0.00888, -0.0003],
  [2451810.21715, 365242.01767, -0.11575, 0.00337, 0.00078],
  [2451900.05952, 365242.74049, -0.06223, -0.00823, 0.00032],
]
const SEASON_TERMS = [
  [485, 324.96, 1934.136],
  [203, 337.23, 32964.467],
  [199, 342.08, 20.186],
  [182, 27.85, 445267.112],
  [156, 73.14, 45036.886],
  [136, 171.52, 22518.443],
  [77, 222.54, 65928.934],
  [74, 296.72, 3034.906],
  [70, 243.58, 9037.513],
  [58, 119.81, 33718.147],
  [52, 297.17, 150.678],
  [50, 21.02, 2281.226],
  [45, 247.54, 29929.562],
  [44, 325.15, 31555.956],
  [29, 60.93, 4443.417],
  [18, 155.12, 67555.328],
  [17, 288.79, 4562.452],
  [16, 198.04, 62894.029],
  [14, 199.76, 31436.921],
  [12, 95.39, 14577.848],
  [12, 287.11, 31931.756],
  [12, 320.81, 34777.259],
  [9, 227.73, 1222.114],
  [8, 15.45, 16859.074],
]

export function solarTermMs(year: number, which: 0 | 1 | 2 | 3): number {
  const Y = (year - 2000) / 1000
  const [a, b, c, d, e] = SEASON_MEAN[which]
  const jde0 = a + b * Y + c * Y * Y + d * Y ** 3 + e * Y ** 4
  const T = (jde0 - 2451545.0) / 36525
  const W = 35999.373 * T - 2.47
  const dl = 1 + 0.0334 * cos(W) + 0.0007 * cos(2 * W)
  let S = 0
  for (const [A, B, C] of SEASON_TERMS) S += A * cos(B + C * T)
  return jdeToMs(jde0 + (0.00001 * S) / dl)
}

// Western Easter Sunday (anonymous Gregorian algorithm).
export function easter(y: number): number {
  const a = y % 19
  const b = Math.floor(y / 100)
  const c = y % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return dayNum(y, month, day)
}

// Orthodox Easter Sunday (Meeus' Julian algorithm, shifted to Gregorian; valid 1900-2099).
export function orthodoxEaster(y: number): number {
  const a = y % 4
  const b = y % 7
  const c = y % 19
  const d = (19 * c + 15) % 30
  const e = (2 * a + 4 * b - d + 34) % 7
  const month = Math.floor((d + e + 114) / 31)
  const day = ((d + e + 114) % 31) + 1
  return dayNum(y, month, day) + 13
}

// The n-th (1-based) given weekday of a month; n = -1 is the last.
export function nthWeekday(y: number, m: number, dow: number, n: number): number {
  if (n > 0) {
    const first = dayNum(y, m, 1)
    return first + ((dow - weekday(first) + 7) % 7) + 7 * (n - 1)
  }
  const last = dayNum(y, m + 1, 1) - 1
  return last - ((weekday(last) - dow + 7) % 7)
}

// Dershowitz and Reingold, Calendrical Calculations: the Hebrew calendar. Day numbers here are
// fixed dates (RD); RD 719163 is 1970-01-01.
const RD_UNIX = 719163
const HEBREW_EPOCH_RD = -1373427

const hebrewElapsed = (y: number) => {
  const months = Math.floor((235 * y - 234) / 19)
  const parts = 12084 + 13753 * months
  const days = 29 * months + Math.floor(parts / 25920)
  return (3 * (days + 1)) % 7 < 3 ? days + 1 : days
}

const hebrewCorrection = (y: number) => {
  const ny0 = hebrewElapsed(y - 1)
  const ny1 = hebrewElapsed(y)
  const ny2 = hebrewElapsed(y + 1)
  if (ny2 - ny1 === 356) return 2
  if (ny1 - ny0 === 382) return 1
  return 0
}

const hebrewNewYearRd = (y: number) => HEBREW_EPOCH_RD + hebrewElapsed(y) + hebrewCorrection(y)

// 25 Kislev of the Hebrew year that starts in the autumn of Gregorian year `g`: the first day of
// Hanukkah (its first candle is lit the evening before).
export function hanukkah(g: number): number {
  const h = g + 3761
  const ny = hebrewNewYearRd(h)
  const len = hebrewNewYearRd(h + 1) - ny
  const longHeshvan = len === 355 || len === 385
  return ny + 30 + (longHeshvan ? 30 : 29) + 24 - RD_UNIX
}

// The arithmetic (civil) Islamic calendar, epoch 16 July 622 Julian = RD 227015.
const ISLAMIC_EPOCH_RD = 227015
export const islamicTabular = (y: number, m: number, d: number) =>
  ISLAMIC_EPOCH_RD -
  1 +
  (y - 1) * 354 +
  Math.floor((3 + 11 * y) / 30) +
  29 * (m - 1) +
  Math.floor(m / 2) +
  d -
  RD_UNIX

// Islamic months begin when the new crescent is seen, a day or two after the new moon. The
// tabular date picks the lunation; the new moon gives the start of the window, so a window of
// [new moon + 1, new moon + 1 + len] holds the observed first day wherever it is seen.
// Returns the day number of (new moon date at Mecca + 1).
export function islamicMonthStart(ah: number, month: number): number {
  const tab = islamicTabular(ah, month, 1)
  const nm = phaseBefore((tab + 1) * DAY_MS, 0)
  return dayAt(nm, 180) + 1
}

// Every AH year whose given month starts in Gregorian year g (zero, one or two).
export function islamicStartsIn(g: number, month: number): number[] {
  const out: number[] = []
  const base = Math.floor(((g - 622) * 33) / 32)
  for (let ah = base - 2; ah <= base + 3; ah++) {
    const n = islamicMonthStart(ah, month)
    if (fromDayNum(n).y === g) out.push(n)
  }
  return out
}

// The Hindu lunisolar festivals, from amanta months (new moon to new moon) named by the
// sidereal solar ingress (sankranti) they contain, Lahiri ayanamsa.
const IST = 330

const jdOf = (ms: number) => ms / DAY_MS + 2440587.5

// Meeus ch. 25 (low precision, about 0.01 degrees): the sun's apparent tropical longitude.
export function sunLongitude(ms: number): number {
  const T = (jdOf(ms) - 2451545.0) / 36525
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T
  const M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T
  const C =
    (1.914602 - 0.004817 * T - 0.000014 * T * T) * sin(M) +
    (0.019993 - 0.000101 * T) * sin(2 * M) +
    0.000289 * sin(3 * M)
  const om = 125.04 - 1934.136 * T
  const l = L0 + C - 0.00569 - 0.00478 * sin(om)
  return ((l % 360) + 360) % 360
}

// Lahiri: 23.853 degrees at J2000, precessing 50.29 arcseconds a year.
const ayanamsa = (ms: number) => 23.853 + ((jdOf(ms) - 2451545.0) / 365.25) * (50.29 / 3600)

// The instant the sun enters sidereal longitude `deg` near `guessMs` (Newton steps on the
// sun's mean motion; converges to seconds in 3-4 steps).
export function sankrantiMs(deg: number, guessMs: number): number {
  let t = guessMs
  for (let i = 0; i < 8; i++) {
    const sid = ((((sunLongitude(t) - ayanamsa(t) - deg) % 360) + 540) % 360) - 180
    t -= (sid / 0.98565) * DAY_MS
    if (Math.abs(sid) < 1e-6) break
  }
  return t
}

// The amanta month containing the ingress: [new moon before it, new moon after it).
const monthHolding = (ingress: number) => phaseBefore(ingress, 0)

// Diwali (Lakshmi Puja) is the new moon that ends amanta Ashvin: the last new moon before the
// sun enters sidereal Scorpio (210 degrees, about 16 November) starts Kartika. Returns that new
// moon's date in India; the festival is that date or the day before.
export function diwaliNewMoon(y: number): number {
  const ingress = sankrantiMs(210, Date.UTC(y, 10, 16))
  return dayAt(monthHolding(ingress), IST)
}

// Holi follows Phalguna Purnima: the full moon of the amanta month that contains the sun's
// entry into sidereal Pisces (330 degrees, about 14 March). Returns that full moon's date in
// India; Rangwali Holi is that date or the day after.
export function holiFullMoon(y: number): number {
  const ingress = sankrantiMs(330, Date.UTC(y, 2, 14))
  const start = monthHolding(ingress)
  const [full] = phasesBetween(start, start + 31 * DAY_MS, 0.5)
  return dayAt(full, IST)
}
