// Per-sender content shares of P2P servers (spec 4.2): what one sender's content may take of a
// room's and of every server's content budget, counted over a rolling day of local receipt in
// hourly buckets.

export const SHARE = {
  // Of a room's content budget, and of the budget of every server together.
  room: 1 / 4,
  server: 1 / 8,
  hourMs: 60 * 60_000,
  hours: 24,
}

// [hour, events, bytes] per hour with receipts, oldest first.
export type Share = [number, number, number][]

export const shareKey = (room: string | null, ik: string) => `share\n${room ?? ''}\n${ik}`

const hourOf = (now: number) => Math.floor(now / SHARE.hourMs)

// The buckets still inside the day, defensively (a stored value of another shape counts nothing).
export const shareLive = (s: unknown, now: number): Share => {
  if (!Array.isArray(s)) return []
  const from = hourOf(now) - SHARE.hours + 1
  return s.filter(
    (b): b is [number, number, number] =>
      Array.isArray(b) &&
      b.length === 3 &&
      b.every(x => Number.isSafeInteger(x) && x >= 0) &&
      b[0] >= from
  )
}

export const shareTotal = (s: Share) =>
  s.reduce((t, [, n, b]) => ({ n: t.n + n, b: t.b + b }), { n: 0, b: 0 })

export const shareAdd = (s: Share, now: number, bytes: number): Share => {
  const h = hourOf(now)
  const last = s[s.length - 1]
  if (last && last[0] === h) return [...s.slice(0, -1), [h, last[1] + 1, last[2] + bytes]]
  return [...s, [h, 1, bytes]]
}

// Whether one more event of `bytes` keeps the sender within `frac` of a budget of `cap` events
// and `capBytes` bytes.
export const withinShare = (
  s: Share,
  bytes: number,
  frac: number,
  cap: number,
  capBytes: number
) => {
  const t = shareTotal(s)
  return t.n + 1 <= Math.floor(cap * frac) && t.b + bytes <= Math.floor(capBytes * frac)
}
