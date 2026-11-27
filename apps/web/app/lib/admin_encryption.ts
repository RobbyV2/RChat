// What the site administration page says about the site's encryption keys.

import { jobOf, type PlacedJob } from './sealing'
import { formatStamp, type FormatOptions } from './timestamps'

export interface AdminDataKey {
  id: number
  purpose: string
  generation: number
  kek: string
  state: string
  held: boolean
  // A key with that id is set here, but it is not the one that encrypted this data key.
  mismatch: boolean
}

// The relay or P2P secrets the server made again because the stored ones could not be opened.
export interface SecretsReset {
  // Unix seconds.
  at: number
  // `relay_secret`, `p2p_secret`.
  secrets: string[]
}

export interface AdminEncryption {
  // Where the root keys come from: `kms`, `operator`, `file` or `none`.
  source: string
  // The key service's address and key, when one is set.
  kms: string | null
  // `id:fingerprint` of every root key, the one in use first.
  fingerprints: string[]
  // `id:fingerprint` of the key file's keys kept to open older data keys while ENCRYPTION_KEYS
  // replaces the file.
  kept: string[]
  key_file: string | null
  // Whether secrets are sealed with a key kept in the database.
  database_key: boolean
  backed_up_at: number | null
  secrets_reset: SecretsReset | null
  data_keys: AdminDataKey[]
  // `ready`, `first_need` (the first switch makes the key), `keys` (no key can be made) or
  // `updating`.
  readiness: string
  needs_backup: boolean
  required: { on: boolean; pinned: boolean }
  // Stored records that did not open since this copy of the site started.
  unreadable: number
  // Whether "Every copy runs this build" is confirmed; null where nobody has to confirm it.
  copies_confirmed: boolean | null
  places: { servers: number; dms: number }
  // The newest jobs over stored messages, newest first.
  jobs: PlacedJob[]
  rotation: RotationView | null
}

// A data key rotation that runs, or that left records under the old keys.
export interface RotationView {
  purposes: string[]
  done: number
  steps: number
  left: number
  ended: boolean
  waiting: boolean
}

export const BACKUP_WARNING =
  "Back up the key file. Without it, encrypted messages can't be opened."

export const SAFER_NOTE =
  'A copy of the whole data folder carries this file. Keeping the key in ENCRYPTION_KEYS, off the server, is safer.'

export function keySourceLine(view: AdminEncryption): string {
  switch (view.source) {
    case 'kms':
      return 'Key service set in the server configuration'
    case 'operator':
      return 'Keys set in the server configuration'
    case 'file':
      return 'Key file made by this site'
    default:
      return view.database_key ? 'Stored with a key in the database' : 'No key yet'
  }
}

export const SET_KEYS = 'Set ENCRYPTION_KEYS or ENCRYPTION_KEYS_FILE to turn on encrypted storage.'

// Whether this site can make its own key when the first server or DM turns encrypted storage on.
const makesKey = (view: AdminEncryption) => view.readiness !== 'keys'

export function keySourceNote(view: AdminEncryption): string | null {
  switch (view.source) {
    case 'kms':
    case 'operator':
      return null
    case 'file':
      return SAFER_NOTE
    default:
      if (view.database_key)
        return makesKey(view)
          ? 'Stored secrets are protected against casual reads only. Encrypted storage for messages starts when a server or DM turns it on, or when ENCRYPTION_KEYS is set.'
          : 'Stored secrets are protected against casual reads only.'
      return makesKey(view)
        ? 'A key is made when a server or DM first turns on encrypted storage. Set ENCRYPTION_KEYS to keep the key off the server.'
        : null
  }
}

export function readinessLine(view: AdminEncryption): string {
  switch (view.readiness) {
    case 'ready':
      return 'Servers and DMs can turn on encrypted storage.'
    case 'first_need':
      return 'Encrypted storage starts with the first server or DM that turns it on.'
    case 'updating':
      return 'Not available while this site updates.'
    default:
      return SET_KEYS
  }
}

export interface Fingerprint {
  id: string
  print: string
  // The key that wraps new data keys.
  current: boolean
}

export const fingerprints = (view: AdminEncryption): Fingerprint[] =>
  view.fingerprints.flatMap((entry, i) => {
    const at = entry.lastIndexOf(':')
    return at <= 0 ? [] : [{ id: entry.slice(0, at), print: entry.slice(at + 1), current: i === 0 }]
  })

// Data keys whose root key this site no longer holds.
export const lostKeys = (view: AdminEncryption) =>
  view.data_keys.filter(k => !k.held && k.state !== 'destroyed')

export const LOST_WARNING =
  "A key is missing. What it encrypted can't be opened until it is restored."

export const MISMATCH_WARNING =
  "A key set here is not the one that encrypted some data. That data can't be opened until the right key is restored."

// How long the page shows that tokens were reset, in seconds.
export const RESET_SHOWN_FOR = 30 * 86400

const TOKENS: Record<string, string> = { relay_secret: 'Relay', p2p_secret: 'P2P' }

// What the page says in the month after relay or P2P tokens were reset, else null.
export function resetWarning(
  view: AdminEncryption,
  now: number,
  o: FormatOptions = {}
): string | null {
  const reset = view.secrets_reset
  if (reset === null || now / 1000 - reset.at > RESET_SHOWN_FOR) return null
  const names = reset.secrets.flatMap(s => (Object.hasOwn(TOKENS, s) ? [TOKENS[s]] : []))
  const what = names.length === 0 ? 'Tokens' : `${names.join(' and ')} tokens`
  const stored = names.length > 1 ? 'The stored secrets' : 'The stored secret'
  return `${what} were reset on ${formatStamp(reset.at * 1000, 'f', now, o)}. ${stored} couldn't be opened.`
}

const parseReset = (value: unknown): SecretsReset | null => {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.at !== 'number') return null
  const secrets = Array.isArray(v.secrets)
    ? v.secrets.filter((s): s is string => typeof s === 'string')
    : []
  return { at: v.at, secrets }
}

export const lostWarning = (lost: AdminDataKey[]) =>
  lost.some(k => k.mismatch) ? MISMATCH_WARNING : LOST_WARNING

const text = (v: unknown) => (typeof v === 'string' ? v : '')

const count = (v: unknown) => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : 0)

const record = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}

// The answer of `GET /admin/encryption`, read defensively.
export function parseAdminEncryption(value: unknown): AdminEncryption | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.source !== 'string') return null
  const keys = Array.isArray(v.data_keys) ? v.data_keys : []
  return {
    source: v.source,
    kms: typeof v.kms === 'string' ? v.kms : null,
    fingerprints: Array.isArray(v.fingerprints)
      ? v.fingerprints.filter((f): f is string => typeof f === 'string')
      : [],
    kept: Array.isArray(v.kept) ? v.kept.filter((f): f is string => typeof f === 'string') : [],
    key_file: typeof v.key_file === 'string' ? v.key_file : null,
    database_key: v.database_key === true,
    backed_up_at: typeof v.backed_up_at === 'number' ? v.backed_up_at : null,
    secrets_reset: parseReset(v.secrets_reset),
    data_keys: keys.flatMap(k => {
      if (typeof k !== 'object' || k === null) return []
      const row = k as Record<string, unknown>
      if (typeof row.id !== 'number') return []
      return [
        {
          id: row.id,
          purpose: text(row.purpose),
          generation: typeof row.generation === 'number' ? row.generation : 0,
          kek: text(row.kek),
          state: text(row.state),
          held: row.held === true,
          mismatch: row.mismatch === true,
        },
      ]
    }),
    readiness: text(v.readiness) || 'keys',
    needs_backup: v.needs_backup === true,
    required: { on: record(v.required).on === true, pinned: record(v.required).pinned === true },
    unreadable: count(v.unreadable),
    copies_confirmed: typeof v.copies_confirmed === 'boolean' ? v.copies_confirmed : null,
    places: { servers: count(record(v.places).servers), dms: count(record(v.places).dms) },
    jobs: Array.isArray(v.jobs) ? v.jobs.flatMap(j => jobOf(j) ?? []) : [],
    rotation: rotationOf(v.rotation),
  }
}

const rotationOf = (value: unknown): RotationView | null => {
  if (typeof value !== 'object' || value === null) return null
  const r = value as Record<string, unknown>
  const steps = count(r.steps)
  return {
    purposes: Array.isArray(r.purposes)
      ? r.purposes.filter((p): p is string => typeof p === 'string')
      : [],
    done: Math.min(count(r.done), steps),
    steps,
    left: count(r.left),
    ended: r.ended === true,
    waiting: r.waiting === true,
  }
}

export const ROTATE = 'Rotate data keys'
export const ROTATE_CONFIRM =
  'New data keys encrypt everything stored encrypted again. The old ones are destroyed a day after.'

// How a rotation goes, or what it left behind.
export function rotationLine(r: RotationView): string {
  if (r.ended && r.left > 0)
    return `${counted(r.left, 'record', 'records')} couldn't be encrypted again. The old data keys stay.`
  if (r.waiting) return 'Rotating data keys: a last pass follows in a few minutes.'
  return `Rotating data keys: ${r.done} of ${r.steps} steps.`
}

// The key file's keys kept beside ENCRYPTION_KEYS, and whether a data key still needs them.
export function keptLines(view: AdminEncryption): string[] {
  const used = new Set(view.data_keys.filter(k => k.state !== 'destroyed').map(k => k.kek))
  const service = view.source === 'kms'
  return view.kept.flatMap(entry => {
    const id = entry.slice(0, Math.max(0, entry.lastIndexOf(':')))
    if (!id) return []
    if (service)
      return [
        used.has(id)
          ? `The key ${id} still opens data keys until they move under the key service.`
          : `The key ${id} is no longer needed. No data key uses it.`,
      ]
    return [
      used.has(id)
        ? `The key file's key ${id} still opens data keys until they move under the key in use.`
        : `The key file's key ${id} is no longer needed. The key file can be deleted.`,
    ]
  })
}

export const rotating = (view: AdminEncryption) => view.rotation !== null && !view.rotation.ended

export const REQUIRE_SITE = 'Require encryption on this site'
export const REQUIRE_SITE_HINT = "Servers and DMs can't turn encrypted storage off."
export const REQUIRE_SERVER = 'Require encryption'
export const REQUIRE_SERVER_HINT = "This server's managers can't turn encrypted storage off."
export const PINNED_NOTE = 'Set by the server configuration'
export const COPIES_LABEL = 'Every copy runs this build'
export const COPIES_HINT =
  'Copies of this site on Postgres without Redis cannot say which build they run.'
export const KEY_SAVED = 'Key copy saved'
export const KEY_SAVED_CONFIRM =
  'Confirm that a copy of the key file is kept somewhere safe, off this server.'
export const EVERYWHERE = 'Encrypt earlier messages everywhere'
export const EVERYWHERE_CONFIRM =
  'Every server and DM that stores new messages encrypted will store its earlier messages only encrypted.'
export const UNSEAL = 'Decrypt stored messages'
export const UNSEAL_CONFIRM =
  'Everything stored encrypted is stored plain again. New messages still follow each server and DM.'
export const UNSEAL_SERVER_CONFIRM =
  'Everything this server stored encrypted is stored plain again. New messages still follow its switch.'

const counted = (n: number, one: string, many: string) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

// Where new messages are stored encrypted.
export function placesLine(view: AdminEncryption): string {
  if (view.required.on) return 'Every server and DM stores new messages encrypted.'
  const { servers, dms } = view.places
  if (servers === 0 && dms === 0) return 'No server or DM stores new messages encrypted.'
  const parts = [
    ...(servers > 0 ? [counted(servers, 'server', 'servers')] : []),
    ...(dms > 0 ? [counted(dms, 'DM', 'DMs')] : []),
  ]
  return `New messages are stored encrypted in ${parts.join(' and ')}.`
}

export const unreadableLine = (view: AdminEncryption): string | null =>
  view.unreadable === 0
    ? null
    : `${counted(view.unreadable, 'stored record', 'stored records')} couldn't be opened since this copy started.`

export const keySavedLine = (at: number, now: number, o: FormatOptions = {}) =>
  `Key copy saved on ${formatStamp(at * 1000, 'f', now, o)}.`

// The place of a job as the admin page names it; `name` marks a server name.
export const jobPlace = (place: string): { text: string; name: boolean } =>
  place === '*'
    ? { text: 'Every place', name: false }
    : place.startsWith('s:')
      ? { text: place.slice(2), name: true }
      : { text: 'A DM', name: false }

export const runningJob = (view: AdminEncryption) => view.jobs.some(j => j.state === 'running')
