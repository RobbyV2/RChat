import { peerStorage } from '../client/keys'
import { fmtSize, plural } from '../bytes'
import { readLocal, writeLocal, type InstanceConnection } from '../instances'
import { fit, localDefaults, RANGES, type Local } from './limits'
import { jsonObject, jsonOr } from '../schema'

// What one account runs P2P with: the instance's P2P_LIMITS (its `local.` names), then the
// user's own overrides from Settings > Peer-to-peer > Advanced, each clamped to its range. Read
// once per P2P start. The overrides are stored per account: { v: 1, roomBytes?, serverBytes?,
// totalBytes?, hiddenPauseMs? }, only where they differ from the instance's value.

export const USER_LIMITS = {
  roomBytes: 'dag.roomBytes',
  serverBytes: 'dag.serverBytes',
  totalBytes: 'dag.totalBytes',
  hiddenPauseMs: 'node.hiddenPauseMs',
} as const

export type UserField = keyof typeof USER_LIMITS

export interface UserLimits {
  v: 1
  roomBytes?: number
  serverBytes?: number
  totalBytes?: number
  hiddenPauseMs?: number
}

const FIELDS = Object.keys(USER_LIMITS) as UserField[]

const MIN = 60_000
const HOUR = 60 * MIN
const MIB = 1024 * 1024

const CHOICES: Record<UserField, readonly number[]> = {
  roomBytes: [64, 128, 200, 512, 1024, 2048, 4096, 16_384].map(n => n * MIB),
  serverBytes: [256, 512, 768, 1024, 2048, 4096, 16_384, 65_536].map(n => n * MIB),
  totalBytes: [256, 512, 1024, 2048, 4096, 16_384, 65_536].map(n => n * MIB),
  hiddenPauseMs: [1, 5, 15, 60, 4 * 60, 24 * 60].map(n => n * MIN),
}

const clamp = (name: string, v: number) => {
  const [lo, hi] = RANGES[name]
  return Math.min(hi, Math.max(lo, v))
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

export const LIMITS_LATER = 'Changes take effect the next time P2P starts.'

export const userLimitsKey = (username: string) => `rchat_p2p_limits:${username}`

export const parseUserLimits = (raw: string | null): UserLimits => {
  const out: UserLimits = { v: 1 }
  try {
    const v = jsonOr(raw, jsonObject, null)
    if (typeof v !== 'object' || v === null || (v as { v?: unknown }).v !== 1) return out
    for (const f of FIELDS) {
      const x = (v as Record<string, unknown>)[f]
      if (finite(x)) out[f] = x
    }
  } catch {
    // Unreadable: the defaults.
  }
  return out
}

export const applyUser = (l: Readonly<Local>, u: UserLimits): Local => {
  const out = structuredClone(l) as Local
  const tree = out as unknown as Record<string, Record<string, number>>
  for (const f of FIELDS) {
    const x = fit(USER_LIMITS[f], u[f])
    if (x === null) continue
    const [s, k] = USER_LIMITS[f].split('.')
    tree[s][k] = x
  }
  return out
}

// The `local.<section>.<key>` entries of the instance's `limits.p2p`, by registry name.
export const instanceLimits = (p2p: unknown): Record<string, number> =>
  typeof p2p === 'object' && p2p !== null && !Array.isArray(p2p)
    ? Object.fromEntries(
        Object.entries(p2p)
          .filter((e): e is [string, number] => e[0].startsWith('local.') && finite(e[1]))
          .map(([k, v]) => [k.slice('local.'.length), v])
      )
    : {}

type HasLimits = { limits?: { p2p?: unknown } } | null | undefined

export const instanceLocal = (info: HasLimits): Local =>
  localDefaults(instanceLimits(info?.limits?.p2p))

export const accountLimits = (info: HasLimits, raw: string | null): Local =>
  applyUser(instanceLocal(info), parseUserLimits(raw))

type LimitConnection = InstanceConnection

const storageKey = (username: string, conn: LimitConnection, local: string) =>
  peerStorage(conn, username, local).scoped(userLimitsKey(username))

export const readUserLimits = (username: string, conn: LimitConnection, local = 'main') =>
  parseUserLimits(readLocal(storageKey(username, conn, local)))

export const limitsFor = (username: string, conn: LimitConnection, local = 'main') =>
  applyUser(instanceLocal(conn.info), readUserLimits(username, conn, local))

// Keeps only the values that differ from the instance's (clamped); none left clears the key.
export const writeUserLimits = (
  username: string,
  u: UserLimits,
  conn: LimitConnection,
  local = 'main'
) => {
  const base = instanceLocal(conn.info)
  const out: UserLimits = { v: 1 }
  for (const f of FIELDS) {
    const v = fit(USER_LIMITS[f], u[f])
    if (v !== null && v !== valueOf(base, f)) out[f] = v
  }
  return writeLocal(
    storageKey(username, conn, local),
    Object.keys(out).length > 1 ? JSON.stringify(out) : null
  )
}

export const valueOf = (l: Readonly<Local>, f: UserField) => {
  const [s, k] = USER_LIMITS[f].split('.')
  return (l as unknown as Record<string, Record<string, number>>)[s][k]
}

// The choices offered for a field: a fixed list plus the default and the current value, inside
// the range, smallest first.
export const limitChoices = (f: UserField, def: number, cur = def) =>
  [...new Set([...CHOICES[f], def, cur].map(v => clamp(USER_LIMITS[f], v)))].sort((a, b) => a - b)

export const limitText = (f: UserField, v: number) =>
  f !== 'hiddenPauseMs'
    ? fmtSize(v)
    : v % HOUR === 0
      ? plural(v / HOUR, 'hour')
      : v % MIN === 0
        ? plural(v / MIN, 'minute')
        : plural(Math.round(v / 1000), 'second')

export const withChoice = (list: readonly number[], v: number) =>
  [...new Set([...list, v])].sort((a, b) => a - b)

// What each part of the P2P runtime takes from the account's limits: the node its sections, the
// DMs and the servers all of them.
export const runtimeLimits = (l: Readonly<Local>) => ({
  node: { limits: l.node, session: l.session, contacts: l.contacts },
  transport: l.transport,
  calls: l.calls,
  badge: l.badge,
  inbox: l.inbox,
  leader: l.misc,
  dms: { local: l },
  servers: { local: l },
})
