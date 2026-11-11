// How long a solve takes on this device, in words. Nothing here shows a number of tries.

// Tries per second of one thread, until a device has measured its own.
export const RATES = { laptop: 5_000_000, phone: 1_500_000, slowPhone: 500_000 }

// Shorter solves show nothing.
export const QUIET_MS = 1500
// Past this the client asks before it starts.
export const SLOW_CONFIRM_MS = 30_000
// The most work a client does for one challenge, whatever an instance asks.
export const MAX_WORK = 2 ** 32

export const estimateMs = (work: number, rate: number, threads: number): number =>
  work <= 0 ? 0 : Math.round((work / (rate * Math.max(1, threads))) * 1000)

export const rateFrom = (tries: number, ms: number): number =>
  ms > 0 ? Math.round((tries / ms) * 1000) : 0

const about = (n: number, unit: string) => `about ${n} ${unit}${n === 1 ? '' : 's'}`

export const words = (ms: number): string => {
  if (!Number.isFinite(ms)) return 'a long time'
  if (ms < 1000) return 'under a second'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return about(seconds, 'second')
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return about(minutes, 'minute')
  return about(Math.round(ms / 3_600_000), 'hour')
}

export const showsProgress = (ms: number): boolean => ms >= QUIET_MS

export const needsConfirm = (ms: number): boolean => ms > SLOW_CONFIRM_MS

export const tooMuchWork = (work: number): boolean => !(work <= MAX_WORK)
