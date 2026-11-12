import { durationText } from './timeouts'
import type { InstanceInfo } from './types'

// How long a server keeps uploaded files: the instance default, a custom time, or until removed.
export type ExpiryMode = 'default' | 'custom' | 'never'

export interface UploadExpiry {
  mode: ExpiryMode
  // Seconds after upload for `custom`, else null.
  seconds: number | null
}

// The files a server keeps longer than the instance default, against the instance's limit for
// one server (0: no limit). `full`: a file of the largest upload size (or of the whole limit, if
// smaller) no longer fits.
export interface KeptSpace {
  bytes: number
  limit: number
  full: boolean
}

// What a change did to the files already posted: how many now stay longer, and how many were
// left at the instance default because the kept space is full.
export interface Extended {
  files: number
  bytes: number
  left_files: number
  left_bytes: number
}

// The same across all servers whose longer choice one account set, which a file must fit too.
// `bytes` is null unless you are that account.
export interface OwnerKept {
  bytes: number | null
  limit: number
  full: boolean
}

export interface UploadExpiryState {
  upload_expiry: UploadExpiry
  upload_ttl: number | null
  // Absent on servers before the kept space.
  kept?: KeptSpace
  // Null when no account is charged for the choice: the server has only its own kept space.
  owner_kept?: OwnerKept | null
  extended?: Extended
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

const longer = (lifetime: number | null, base: number) => lifetime === null || lifetime > base

// Whether the instance limits how much a server, or the account that set its file expiry, keeps
// longer than the default. Older servers have no such limit and send nothing.
export const keptLimited = (info: InstanceInfo | null | undefined) =>
  info?.limits?.upload_kept_limited === true

// What happens to a file uploaded now. Where kept files are `limited`, a longer time holds only
// for a file that still fits, so the hint is one sentence that is true either way.
export const uploadHint = (
  lifetime: number | null,
  base: number,
  limited: boolean,
  them = false
) =>
  limited && longer(lifetime, base)
    ? `${lifetimeText(base)} unless there is room to keep ${them ? 'them' : 'it'} ${
        lifetime === null ? 'longer' : `for ${durationText(lifetime)}`
      }`
    : lifetimeText(lifetime)

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

// "3.1 GB", "8 GB", "700 KB": one decimal at most.
export const sizeText = (bytes: number) => {
  const round = (v: number) => (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10)
  let value = Math.max(0, bytes)
  let unit = 0
  while (unit < SIZE_UNITS.length - 1 && round(value) >= 1024) {
    value /= 1024
    unit += 1
  }
  return `${round(value)} ${SIZE_UNITS[unit]}`
}

const amount = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)

// The kept space a server sent, or null when it sent none (older servers) or nonsense.
export const keptSpace = (v: unknown): KeptSpace | null => {
  if (typeof v !== 'object' || v === null) return null
  const { bytes, limit, full } = v as Record<string, unknown>
  const [b, l] = [amount(bytes), amount(limit)]
  return b === null || l === null ? null : { bytes: b, limit: l, full: full === true }
}

// The charged account's kept space a server sent, or null when it sent none or nonsense.
export const ownerKept = (v: unknown): OwnerKept | null => {
  if (typeof v !== 'object' || v === null) return null
  const { bytes, limit, full } = v as Record<string, unknown>
  const l = amount(limit)
  return l === null ? null : { bytes: amount(bytes), limit: l, full: full === true }
}

const used = (bytes: number, limit: number) =>
  `${sizeText(bytes)}${limit > 0 ? ` of ${sizeText(limit)}` : ''}`

const MINE = 'across the servers whose file expiry you set'

// "3.1 GB of 8 GB kept in this server; 9.4 GB of 16 GB across the servers whose file expiry you
// set". The second part is for the charged account only.
export const keptText = (kept: KeptSpace, owner: OwnerKept | null) =>
  `${used(kept.bytes, kept.limit)} kept in this server${
    owner && owner.bytes !== null ? `; ${used(owner.bytes, owner.limit)} ${MINE}` : ''
  }`

// The usage line shows while the server keeps new files longer, or still holds some.
export const keptShown = (kept: KeptSpace | null, lifetime: number | null, base: number) =>
  kept !== null && (kept.bytes > 0 || longer(lifetime, base))

// The line for a full space, while new files would stay longer: which space is full, what
// happens to new files, and who sets the limit. Null when neither is full.
export const keptFullText = (
  kept: KeptSpace | null,
  owner: OwnerKept | null,
  lifetime: number | null,
  base: number
): string | null => {
  if (!longer(lifetime, base)) return null
  const spaces = [
    kept?.full ? "this server's space" : null,
    owner?.full
      ? owner.bytes !== null
        ? `your space ${MINE}`
        : 'the space of the account that set this file expiry'
      : null,
  ].filter(space => space !== null)
  if (spaces.length === 0) return null
  const which = spaces.join(' and ')
  return `${which[0].toUpperCase()}${which.slice(1)} ${spaces.length > 1 ? 'are' : 'is'} full. New files that don't fit are removed after ${durationText(base)} until space frees up. The site admin sets the limit.`
}

// What the settings say new files get. While a space is full, a longer time holds only for a
// file that still fits.
export const newFilesText = (
  kept: KeptSpace | null,
  owner: OwnerKept | null,
  lifetime: number | null,
  base: number
) =>
  keptFullText(kept, owner, lifetime, base) === null
    ? lifetimeText(lifetime)
    : uploadHint(lifetime, base, true, true)

const files = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

// After a save: how many files already posted now stay longer, and how many did not fit.
export const savedText = (extended: Extended | undefined, base: number) =>
  [
    'Saved.',
    extended && extended.files > 0
      ? `${files(extended.files, 'file')} now ${extended.files === 1 ? 'stays' : 'stay'} longer.`
      : null,
    extended && extended.left_files > 0
      ? `${files(extended.left_files, 'older file')} ${extended.left_files === 1 ? 'is' : 'are'} still removed after ${durationText(base)}: no room left.`
      : null,
  ]
    .filter(part => part !== null)
    .join(' ')

// What a saved setting changes in the loaded server detail.
export const serverPatch = (state: UploadExpiryState) => ({
  upload_expiry: state.upload_expiry,
  upload_ttl: state.upload_ttl,
})

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
