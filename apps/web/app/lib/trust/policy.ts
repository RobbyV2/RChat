// What an instance says about proof of work (`GET /instance` and `GET /settings`), and whether
// it wants a trust token from a caller.

export type TrustKind = 'general' | 'signin'
export type PowWho = 'both' | 'guests' | 'accounts' | 'none'

export interface TrustInfo {
  version: 1
  algs: string[]
  header: string
  wasm: string
  pageGate: boolean
  forwardAuth: boolean
}

export interface TrustSettings {
  pow: boolean
  who: PowWho
  signin: boolean
  pages: boolean
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

// Null unless the instance advertises `trust` version 1 with the `s256` puzzle.
export const parseTrustInfo = (instance: unknown): TrustInfo | null => {
  const trust = record(record(instance)?.trust)
  if (!trust || trust.version !== 1 || !Array.isArray(trust.algs)) return null
  const algs = trust.algs.filter((a): a is string => typeof a === 'string')
  if (!algs.includes('s256')) return null
  return {
    version: 1,
    algs,
    header: typeof trust.header === 'string' ? trust.header : 'X-Trust-Token',
    wasm: typeof trust.wasm === 'string' ? trust.wasm : '/pow/rchat_pow.wasm',
    pageGate: trust.page_gate === true,
    forwardAuth: trust.forward_auth === true,
  }
}

const WHO: readonly PowWho[] = ['both', 'guests', 'accounts', 'none']

// Settings from before proof of work have it off. With it on, anything missing or unknown reads
// as the instance's defaults: everyone solves, sign-in included.
export const parseTrustSettings = (settings: unknown): TrustSettings => {
  const s = record(settings) ?? {}
  return {
    pow: s.pow === true,
    who: WHO.find(w => w === s.pow_who) ?? 'both',
    signin: s.pow_signin !== false,
    pages: s.pow_pages === true,
  }
}

export const wants = (
  info: TrustInfo | null,
  settings: TrustSettings,
  kind: TrustKind,
  signedIn: boolean
): boolean => {
  if (!info || !settings.pow) return false
  if (kind === 'signin') return settings.signin
  return settings.who === 'both' || settings.who === (signedIn ? 'accounts' : 'guests')
}
