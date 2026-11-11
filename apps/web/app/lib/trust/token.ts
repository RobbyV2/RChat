import type { TrustKind } from './policy'

// A trust token as a session keeps it. Times are Unix seconds, as the API gives them; every
// comparison takes the server's clock in milliseconds (`Date.now()` plus the offset learned from
// response `Date` headers), so a wrong device clock can't make a dead token look fresh.

export interface Trust {
  token: string
  kind: TrustKind
  expiresAt: number
  budget: number
  remaining: number
  renewAt: number
}

interface Headers {
  get(name: string): string | null
}

const OFFSETS = 5

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const trustOf = (
  token: unknown,
  kind: unknown,
  expiresAt: unknown,
  budget: unknown,
  remaining: unknown,
  renewAt: unknown
): Trust | null =>
  typeof token === 'string' &&
  token.startsWith('t1.') &&
  (kind === 'general' || kind === 'signin') &&
  count(expiresAt) &&
  count(budget) &&
  count(remaining) &&
  count(renewAt)
    ? { token, kind, expiresAt, budget, remaining, renewAt }
    : null

export const serialize = (t: Trust): string =>
  JSON.stringify({
    v: 1,
    token: t.token,
    kind: t.kind,
    expiresAt: t.expiresAt,
    budget: t.budget,
    remaining: t.remaining,
    renewAt: t.renewAt,
  })

export const parseStored = (raw: string | null): Trust | null => {
  if (!raw) return null
  try {
    const s = record(JSON.parse(raw))
    if (!s || s.v !== 1) return null
    return trustOf(s.token, s.kind, s.expiresAt, s.budget, s.remaining, s.renewAt)
  } catch {
    return null
  }
}

// The answer of `POST /pow/token`.
export const fromTokenAnswer = (answer: unknown): Trust | null => {
  const a = record(answer)
  return a ? trustOf(a.token, a.kind, a.expires_at, a.budget, a.budget, a.renew_at) : null
}

// The `trust` field of a sign-in answer: a general token for the new session.
export const fromSignIn = (answer: unknown): Trust | null => {
  const t = record(record(answer)?.trust)
  return t ? trustOf(t.token, 'general', t.expires_at, t.budget, t.budget, t.renew_at) : null
}

// What a paid response says: `X-Trust-Remaining`, and `X-Trust-Renew: 1` makes the renewal due.
export const fromHeaders = (t: Trust, headers: Headers): Trust => {
  const left = headers.get('x-trust-remaining')
  const remaining = left !== null && /^\d+$/.test(left) ? Math.min(Number(left), t.budget) : null
  const renew = headers.get('x-trust-renew') === '1'
  if (remaining === null && !renew) return t
  return { ...t, remaining: remaining ?? t.remaining, renewAt: renew ? 0 : t.renewAt }
}

export const expired = (t: Trust, serverNow: number): boolean => serverNow >= t.expiresAt * 1000

export const usable = (t: Trust, serverNow: number): boolean =>
  !expired(t, serverNow) && t.remaining > 0

// At 80% of the life (the server's `renew_at`), with 20% of the budget or less left, or once the
// server said so.
export const renewDue = (t: Trust, serverNow: number): boolean =>
  serverNow >= t.renewAt * 1000 || t.remaining * 5 <= t.budget

// How far the server's clock is ahead of this device, from a response's `Date` header.
export const clockOffset = (dateHeader: string | null, now: number): number | null => {
  const at = dateHeader ? Date.parse(dateHeader) : NaN
  return Number.isNaN(at) ? null : at - now
}

export const pushOffset = (samples: readonly number[], sample: number): number[] =>
  [...samples, sample].slice(-OFFSETS)

// The median of the samples kept; 0 before the first.
export const offsetOf = (samples: readonly number[]): number => {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
