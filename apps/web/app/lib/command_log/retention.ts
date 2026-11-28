import type { RecordStore, RecordTable } from '../platform/records'
import type { LogEntry, LogPrefs } from './types'
import { jsonObject, jsonOr } from '../schema'

export const TABLE = 'rchat_cmdlog'
export const PREFS = 'rchat_cmdlog_prefs'
export const DAY_CHOICES: readonly number[] = [7, 30, 90, 365]
export const MAX_MIN = 100
export const MAX_MAX = 5000
export const PRUNE_EVERY = 50

const DAY_MS = 86_400_000
const MOVE_PAGE = 200

export const DEFAULT_PREFS: LogPrefs = {
  v: 1,
  on: true,
  days: 30,
  max: 1000,
  keep_after_sign_out: false,
}

export const tableName = (account: string) => `${TABLE}:${account}`
export const prefsKey = (account: string) => `${PREFS}:${account}`

const flag = (v: unknown, or: boolean) => (typeof v === 'boolean' ? v : or)

export const parsePrefs = (raw: string | null): LogPrefs => {
  try {
    const p: unknown = jsonOr(raw, jsonObject, null)
    if (typeof p !== 'object' || p === null || Array.isArray(p)) return DEFAULT_PREFS
    const { v, on, days, max, keep_after_sign_out } = p as Record<string, unknown>
    if (v !== 1) return DEFAULT_PREFS
    return {
      v: 1,
      on: flag(on, DEFAULT_PREFS.on),
      days: typeof days === 'number' && DAY_CHOICES.includes(days) ? days : DEFAULT_PREFS.days,
      max:
        typeof max === 'number' && Number.isFinite(max)
          ? Math.min(MAX_MAX, Math.max(MAX_MIN, Math.floor(max)))
          : DEFAULT_PREFS.max,
      keep_after_sign_out: flag(keep_after_sign_out, DEFAULT_PREFS.keep_after_sign_out),
    }
  } catch {
    return DEFAULT_PREFS
  }
}

export const pruneOpts = (prefs: LogPrefs, now: number) => ({
  olderThan: now - prefs.days * DAY_MS,
  keep: prefs.max,
})

export const prune = (table: RecordTable<LogEntry>, prefs: LogPrefs, now: number) =>
  table.prune(pruneOpts(prefs, now))

export const forget = (store: RecordStore, account: string) => store.remove(tableName(account))

export const signedOut = async (store: RecordStore, account: string, prefs: LogPrefs) => {
  if (!prefs.keep_after_sign_out) await forget(store, account)
}

// Moves the entries of a P2P identity to the table of the account it moved to; resolves to how
// many moved.
export const moveIdentity = async (
  from: RecordTable<LogEntry>,
  to: RecordTable<LogEntry>,
  identity: string,
  account: string
) => {
  let moved = 0
  let before: LogEntry | undefined
  for (;;) {
    const page = await from.list({ before, limit: MOVE_PAGE })
    if (!page.length) return moved
    before = page[page.length - 1]
    const mine = page.filter(e => e.actor.identity === identity)
    if (!mine.length) continue
    await to.put(mine.map(e => ({ ...e, actor: { ...e.actor, account } })))
    await from.delete(mine.map(e => e.id))
    moved += mine.length
  }
}
