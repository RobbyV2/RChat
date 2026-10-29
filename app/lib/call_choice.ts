import type { CallLog } from './types'
import { callTone } from './voice_layout'

// How a DM call connects: through the server (WebRTC via the instance) or direct (PeerJS).
export type CallRoute = 'server' | 'p2p'

export const DEFAULT_ROUTE: CallRoute = 'server'

export const callRouteKey = (username: string) => `rchat_call:${username}`

export const isRoute = (x: unknown): x is CallRoute => x === 'server' || x === 'p2p'

export const parseCallRoute = (raw: string | null): CallRoute => {
  try {
    const data = raw ? (JSON.parse(raw) as unknown) : null
    if (typeof data !== 'object' || data === null) return DEFAULT_ROUTE
    const { v, route } = data as { v?: unknown; route?: unknown }
    return v === 1 && isRoute(route) ? route : DEFAULT_ROUTE
  } catch {
    return DEFAULT_ROUTE
  }
}

export const callRouteValue = (route: CallRoute) => JSON.stringify({ v: 1, route })

export interface P2pCallInputs {
  guest: boolean
  signedIn: boolean
  p2pOn: boolean
  selfDm: boolean
  // A P2P call to this DM already failed because the other side can't do it.
  failed: boolean
}

export const p2pCallable = (x: P2pCallInputs) =>
  x.signedIn && !x.guest && x.p2pOn && !x.selfDm && !x.failed

export const routeFor = (chosen: CallRoute, p2pOk: boolean): CallRoute =>
  p2pOk ? chosen : 'server'

export const ROUTE_LABEL: Record<CallRoute, string> = {
  server: 'Through server',
  p2p: 'Direct (P2P)',
}

export const P2P_IP_HINT = 'The other person can see your IP unless you use relay only.'

// `12m 05s`, `1h 02m 05s`, `45s`.
export const shortDuration = (s: number) => {
  const sec = Math.max(0, Math.floor(s))
  const pad = (n: number) => String(n).padStart(2, '0')
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const r = sec % 60
  if (h > 0) return `${h}h ${pad(m)}m ${pad(r)}s`
  if (m > 0) return `${m}m ${pad(r)}s`
  return `${r}s`
}

export interface CallLogInfo {
  label: string
  video: boolean
  direct: boolean
  // Null while the call rings or is still going.
  outcome: string | null
  duration: string | null
  // A call this user missed: shown in red.
  alert: boolean
}

const callKindLabel = (video: boolean | null | undefined) =>
  video === true ? 'Video call' : video === false ? 'Voice call' : 'Call'

export const callLogInfo = (call: CallLog, me: string | null): CallLogInfo => {
  const tone = callTone(call)
  const incoming = me !== null && me !== call.from
  const lasted =
    tone === 'ended' ? Math.max(0, (call.ended_at ?? 0) - (call.answered_at ?? 0)) : null
  const outcome =
    tone === 'missed'
      ? 'Missed call'
      : tone === 'declined'
        ? 'Declined'
        : tone === 'ended'
          ? 'Call ended'
          : null
  return {
    label: callKindLabel(call.video),
    video: call.video === true,
    direct: call.p2p === true,
    outcome,
    duration: lasted === null ? null : shortDuration(lasted),
    alert: tone === 'missed' && incoming,
  }
}

const P2P_FAIL_TTL = 10 * 60 * 1000

export const recentlyFailed = (at: number | undefined, now = Date.now()) =>
  at !== undefined && now - at < P2P_FAIL_TTL
