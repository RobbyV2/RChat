import type { InstanceInfo } from './types'

const MIB = 1024 * 1024

// The limits the client follows. Servers send them in `GET /api/instance`; older servers send
// fewer, and the missing ones keep the values from before servers sent them.
export interface ClientLimits {
  message_chars: number
  upload_bytes: number
  reconnect_base_ms: number
  reconnect_cap_ms: number
  reconnect_floor_ms: number
  resync_jitter_ms: number
  catch_up_delay_ms: number
  // 0 means none for the last three.
  servers_per_account: number
  session_max_age_secs: number
  session_idle_secs: number
  // Seconds an uploaded file stays by default (servers may choose otherwise).
  media_retention_secs: number
}

export const DEFAULT_LIMITS: Readonly<ClientLimits> = Object.freeze({
  message_chars: 4000,
  upload_bytes: 25 * MIB,
  reconnect_base_ms: 1000,
  reconnect_cap_ms: 30000,
  reconnect_floor_ms: 250,
  resync_jitter_ms: 10000,
  catch_up_delay_ms: 5000,
  servers_per_account: 0,
  session_max_age_secs: 0,
  session_idle_secs: 0,
  media_retention_secs: 86400,
})

const KEYS = Object.keys(DEFAULT_LIMITS) as (keyof ClientLimits)[]

const usable = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

let last: { info: InstanceInfo | null; limits: ClientLimits } | null = null

// The same info gives the same object, so selectors can return it.
export const limitsOf = (info: InstanceInfo | null): ClientLimits => {
  if (last?.info === info) return last.limits
  const sent: unknown = info?.limits
  const from = typeof sent === 'object' && sent !== null ? (sent as Record<string, unknown>) : {}
  const limits = { ...DEFAULT_LIMITS }
  for (const key of KEYS) {
    const v = from[key]
    if (usable(v)) limits[key] = v
  }
  last = { info, limits }
  return limits
}

export const tooLargeText = (bytes: number) =>
  `File exceeds ${Math.max(1, Math.round(bytes / MIB))}MB limit`
