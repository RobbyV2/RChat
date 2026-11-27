// What the site administration page says about the site's encryption keys.

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

export interface AdminEncryption {
  // Where the root keys come from: `operator`, `file` or `none`.
  source: string
  // `id:fingerprint` of every root key, the one in use first.
  fingerprints: string[]
  key_file: string | null
  // Whether secrets are sealed with a key kept in the database.
  database_key: boolean
  backed_up_at: number | null
  data_keys: AdminDataKey[]
  // `ready`, `first_need` (the first switch makes the key), `keys` (no key can be made) or
  // `updating`.
  readiness: string
  needs_backup: boolean
}

export const BACKUP_WARNING =
  "Back up the key file. Without it, encrypted messages can't be opened."

export const SAFER_NOTE =
  'A copy of the whole data folder carries this file. Keeping the key in ENCRYPTION_KEYS, off the server, is safer.'

export function keySourceLine(view: AdminEncryption): string {
  switch (view.source) {
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
    case 'operator':
      return null
    case 'file':
      return SAFER_NOTE
    default:
      if (view.database_key)
        return makesKey(view)
          ? 'Sign-in secrets are protected against casual reads only. Encrypted storage for messages starts when a server or DM turns it on, or when ENCRYPTION_KEYS is set.'
          : 'Sign-in secrets are protected against casual reads only.'
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

export const lostWarning = (lost: AdminDataKey[]) =>
  lost.some(k => k.mismatch) ? MISMATCH_WARNING : LOST_WARNING

const text = (v: unknown) => (typeof v === 'string' ? v : '')

// The answer of `GET /admin/encryption`, read defensively.
export function parseAdminEncryption(value: unknown): AdminEncryption | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.source !== 'string') return null
  const keys = Array.isArray(v.data_keys) ? v.data_keys : []
  return {
    source: v.source,
    fingerprints: Array.isArray(v.fingerprints)
      ? v.fingerprints.filter((f): f is string => typeof f === 'string')
      : [],
    key_file: typeof v.key_file === 'string' ? v.key_file : null,
    database_key: v.database_key === true,
    backed_up_at: typeof v.backed_up_at === 'number' ? v.backed_up_at : null,
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
  }
}
