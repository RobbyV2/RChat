import type { TrustKind } from './policy'
import { fromHeaders, usable, type Trust } from './token'

// Trust around a request: the token and the client id go on, what the answer says about the
// token is kept, and a refusal (429 with `X-Trust-Required`) is answered by solving again.

export interface Outgoing {
  url: string
  headers?: Record<string, string>
  // The token the route takes; sign-in class routes say 'signin'.
  kind?: TrustKind
  // A file or preview download: free for accounts, paid by guests.
  media?: boolean
}

export interface Incoming {
  status: number
  headers: { get(name: string): string | null }
}

export interface TrustDeps {
  // The origin of the instance these requests are for.
  origin: string
  // Whether the instance advertises trust tokens at all (`parseTrustInfo`).
  advertised(): boolean
  // Whether it wants a token of this kind from this caller (`wants`).
  wants(kind: TrustKind, signedIn: boolean): boolean
  clientId(): string
  token(kind: TrustKind): Trust | null
  setToken(kind: TrustKind, trust: Trust | null): void
  // A new token through the solve queue; null when there will be none (cancelled, declined).
  solve(kind: TrustKind, ask: { priority: 'foreground'; minWork?: number }): Promise<Trust | null>
  serverNow(): number
  sleep(ms: number): Promise<void>
  // Every answer's `Date` header, for the clock offset.
  date?(header: string | null): void
}

// The waits before the second, third and fourth new token for one request.
export const RESOLVE_BACKOFF_MS: readonly number[] = [2000, 4000, 8000]

// `general`, `signin`, optionally `; level=<n>`.
export const parseRequired = (
  header: string | null
): { kind: TrustKind; level: number | null } | null => {
  const [kind, ...params] = (header ?? '').split(';').map(part => part.trim().toLowerCase())
  if (kind !== 'general' && kind !== 'signin') return null
  const level = params.map(p => /^level=(\d{1,15})$/.exec(p)?.[1]).find(l => l !== undefined)
  return { kind, level: level === undefined ? null : Number(level) }
}

const sameOrigin = (url: string, origin: string): boolean => {
  try {
    return new URL(url, origin).origin === new URL(origin).origin
  } catch {
    return false
  }
}

export const withTrust = <Req extends Outgoing, Res extends Incoming>(
  send: (req: Req) => Promise<Res>,
  deps: TrustDeps
): ((req: Req) => Promise<Res>) => {
  const solving = new Map<TrustKind, Promise<Trust | null>>()
  // Requests refused together wait for one solve.
  const solve = (kind: TrustKind, minWork: number | undefined): Promise<Trust | null> => {
    if (minWork !== undefined) return deps.solve(kind, { priority: 'foreground', minWork })
    const running = solving.get(kind)
    if (running) return running
    const started = deps.solve(kind, { priority: 'foreground' }).finally(() => solving.delete(kind))
    solving.set(kind, started)
    return started
  }
  const held = (kind: TrustKind): Trust | null => {
    const t = deps.token(kind)
    return t && usable(t, deps.serverNow()) ? t : null
  }

  return async req => {
    if (!deps.advertised() || !sameOrigin(req.url, deps.origin)) return send(req)
    const signedIn = Object.keys(req.headers ?? {}).some(h => h.toLowerCase() === 'authorization')
    if (req.media && signedIn) return send(req)
    let kind = req.kind ?? 'general'
    let needed = deps.wants(kind, signedIn)
    let minWork: number | undefined
    // New tokens made for this request after a refusal of one it carried.
    let renewed = 0
    let bare = false
    let declined = false
    let switched = false
    for (;;) {
      let trust = needed ? held(kind) : null
      if (needed && !trust && !declined) {
        trust = await solve(kind, minWork)
        declined = trust === null
      }
      const headers = { ...req.headers }
      if (!signedIn || kind === 'signin') headers['X-Trust-Client'] = deps.clientId()
      if (trust) headers['X-Trust-Token'] = trust.token
      const res = await send({ ...req, headers })
      deps.date?.(res.headers.get('date'))
      const refused = res.status === 429 ? parseRequired(res.headers.get('x-trust-required')) : null
      if (!refused) {
        const seen = trust ? fromHeaders(trust, res.headers) : null
        if (trust && seen !== trust && deps.token(kind)?.token === trust.token)
          deps.setToken(kind, seen)
        return res
      }
      if (declined) return res
      if (refused.level !== null) minWork = refused.level
      needed = true
      if (refused.kind !== kind) {
        if (switched) return res
        switched = true
        kind = refused.kind
        continue
      }
      if (!trust) {
        bare = true
        continue
      }
      if (deps.token(kind)?.token === trust.token) deps.setToken(kind, null)
      if (bare || renewed > RESOLVE_BACKOFF_MS.length) return res
      if (renewed > 0) await deps.sleep(RESOLVE_BACKOFF_MS[renewed - 1])
      renewed += 1
    }
  }
}
