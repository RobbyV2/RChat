// Calendar-day lines in message lists: which rows start a new local day, and the date they show.
// Row times are Unix seconds; `localDayKey` and `formatDateBanner` take milliseconds. Pure.

const pad = (n: number) => String(n).padStart(2, '0')

// `YYYY-MM-DD` of the local day `ms` falls on.
export const localDayKey = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export const sameDay = (a: number, b: number) => localDayKey(a * 1000) === localDayKey(b * 1000)

// Where day lines go: above each shown row on another local day than the last line, starting
// from `above` (the time of what shows above the list, like a thread's root). `shown[i]` is
// false for rows folded out of sight; a folded run's header counts as its first row.
export const dayLines = (
  times: readonly number[],
  shown: readonly boolean[],
  above: number | null = null
): Set<number> => {
  const lines = new Set<number>()
  let last = above === null ? null : localDayKey(above * 1000)
  times.forEach((t, i) => {
    if (!shown[i]) return
    const day = localDayKey(t * 1000)
    if (day === last) return
    lines.add(i)
    last = day
  })
  return lines
}

// The rows that start a local day when every row shows.
export const dayStarts = (times: readonly number[], above: number | null = null): Set<number> =>
  dayLines(
    times,
    times.map(() => true),
    above
  )

// "Tuesday, November 24, 2026".
export const formatDateBanner = (ms: number, locale?: string) =>
  new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(ms)
