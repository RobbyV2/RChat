import { localKeys, readLocal, writeLocal } from '../instances'
import { Sha256 } from '../sha256'
import { viewingKey } from '../viewing'
import { VIEW_LIMITS } from './ui/catalog'

// An alias a remembered app answers, so its invocation stays local before the app loads.
export type SavedAlias = { slash: string; argument: boolean }
export type SavedPreview = { name: string; revision: string; size: number; aliases?: SavedAlias[] }
const prefix = (account: string, server: string) => viewingKey(account, ['app-files', server]) + ':'
const keyFor = (account: string, server: string, revision: string) =>
  prefix(account, server) + revision
const maxFiles = 16
export const fileDigest = (bytes: Uint8Array) => new Sha256().update(bytes).hex()

const aliasList = (value: unknown): SavedAlias[] =>
  Array.isArray(value)
    ? value
        .flatMap(a =>
          a &&
          typeof a.slash === 'string' &&
          /^[a-z][a-z0-9_-]*$/.test(a.slash) &&
          typeof a.argument === 'boolean'
            ? [{ slash: a.slash, argument: a.argument }]
            : []
        )
        .slice(0, 64)
    : []

const storedFile = (
  key: string
): { name: string; raw: string; size: number; aliases?: unknown } | null => {
  try {
    const entry = JSON.parse(readLocal(key) ?? 'null')
    if (
      entry &&
      typeof entry.name === 'string' &&
      typeof entry.raw === 'string' &&
      entry.raw.length <= VIEW_LIMITS.chars &&
      Number.isSafeInteger(entry.size) &&
      entry.size >= 0 &&
      entry.size <= VIEW_LIMITS.chars
    )
      return entry
  } catch {
    /* Discard unreadable local definitions. */
  }
  return null
}

export const savedPreviews = (account: string, server: string): SavedPreview[] => {
  const group = prefix(account, server)
  return localKeys(group).flatMap(key => {
    const revision = key.slice(group.length)
    if (!/^[0-9a-f]{64}$/.test(revision)) return []
    const entry = storedFile(key)
    return entry
      ? [{ name: entry.name, revision, size: entry.size, aliases: aliasList(entry.aliases) }]
      : []
  })
}

export const readSavedPreview = (account: string, server: string, revision: string) => {
  const entry = storedFile(keyFor(account, server, revision))
  if (!entry || fileDigest(new TextEncoder().encode(entry.raw)) !== revision)
    throw new Error('Choose this app definition again.')
  return entry.raw
}

export const storePreview = (
  account: string,
  server: string,
  file: SavedPreview,
  raw: string,
  aliases: SavedAlias[]
) => {
  const key = keyFor(account, server, file.revision)
  if (!readLocal(key) && localKeys(prefix(account, server)).length >= maxFiles) return false
  return (
    writeLocal(key, JSON.stringify({ name: file.name, size: file.size, raw, aliases })) &&
    readLocal(key) !== null
  )
}

export const removePreviewFile = (account: string, server: string, revision: string) =>
  writeLocal(keyFor(account, server, revision), null)
