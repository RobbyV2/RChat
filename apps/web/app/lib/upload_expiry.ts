import { durationText } from './timeouts'

// How long a server keeps uploaded files: the instance default, a custom time, or until removed.
export type ExpiryMode = 'default' | 'custom' | 'never'

export interface UploadExpiry {
  mode: ExpiryMode
  // Seconds after upload for `custom`, else null.
  seconds: number | null
}

export interface UploadExpiryState {
  upload_expiry: UploadExpiry
  upload_ttl: number | null
}

const DAY = 86400
const HOUR = 3600
export const CUSTOM_MIN = HOUR
export const CUSTOM_MAX = 365 * DAY
export const CAP_DAYS_MAX = 365

// Seconds a new file posted under `choice` stays, after the instance cap (`capDays`, 0 for none);
// null when it is kept until removed. `base` is the instance default.
export const uploadLifetime = (
  choice: UploadExpiry | undefined,
  capDays: number,
  base: number
): number | null => {
  const cap = Math.max(0, capDays) * DAY
  if (!choice || choice.mode === 'default') return base
  if (choice.mode === 'never') return cap > 0 ? cap : null
  const s = choice.seconds ?? base
  return cap > 0 && s > cap ? cap : s
}

// A server's lifetime for new files: its choice under the current cap, else what it sent (older
// servers send neither, so the default).
export const serverLifetime = (
  detail: { upload_expiry?: UploadExpiry; upload_ttl?: number | null } | undefined,
  capDays: number,
  base: number
): number | null =>
  detail?.upload_expiry
    ? uploadLifetime(detail.upload_expiry, capDays, base)
    : detail?.upload_ttl !== undefined
      ? detail.upload_ttl
      : base

// How long a removed file stayed after its message was posted, from the message's own expiry
// time (server lifetimes are whole hours, so it is rounded to the hour, or the minute below half
// an hour); `fallback` when the message has none (or one not after posting).
export const removedLifetime = (
  expiresAt: number | null,
  postedAt: number,
  fallback: number | null
): number | null => {
  if (expiresAt === null || expiresAt <= postedAt) return fallback
  const d = Math.max(0, expiresAt - postedAt)
  const unit = d >= HOUR / 2 ? HOUR : 60
  return Math.max(unit, Math.round(d / unit) * unit)
}

export const lifetimeText = (seconds: number | null) =>
  seconds === null ? 'kept until removed' : `removed after ${durationText(seconds)}`

// After the file name: "was removed after 1 day of posting".
export const removedTail = (seconds: number | null) =>
  seconds === null ? 'was removed' : `was removed after ${durationText(seconds)} of posting`

export const removedText = (filename: string, seconds: number | null) =>
  `File ${filename} ${removedTail(seconds)}`

export type ExpiryUnit = 'hours' | 'days'

// The settings form: a mode, and an amount in hours or days for a custom time.
export interface ExpiryForm {
  mode: ExpiryMode
  amount: number
  unit: ExpiryUnit
}

export const expiryChoice = (choice: UploadExpiry | undefined): ExpiryForm => {
  if (!choice || choice.mode !== 'custom' || choice.seconds === null)
    return { mode: choice?.mode ?? 'default', amount: 1, unit: 'days' }
  return choice.seconds % DAY === 0
    ? { mode: 'custom', amount: choice.seconds / DAY, unit: 'days' }
    : { mode: 'custom', amount: Math.round(choice.seconds / HOUR), unit: 'hours' }
}

// The choice to send, or null when a custom time is not a whole number from 1 hour to 365 days.
export const expiryFromChoice = (form: ExpiryForm): UploadExpiry | null => {
  if (form.mode !== 'custom') return { mode: form.mode, seconds: null }
  const seconds = form.amount * (form.unit === 'days' ? DAY : HOUR)
  return Number.isInteger(form.amount) && seconds >= CUSTOM_MIN && seconds <= CUSTOM_MAX
    ? { mode: 'custom', seconds }
    : null
}
