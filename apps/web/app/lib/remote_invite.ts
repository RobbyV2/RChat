import {
  InstanceError,
  compatible,
  fetchInstance,
  home,
  registry,
  remoteAllowed,
  type InstanceConnection,
} from './instances'
import { hostOf } from './qualified'
import type { Invite } from './types'

const INFO_TTL = 5 * 60 * 1000
const INVITE_TTL = 30 * 1000
export const FAIL_TTL = 60 * 1000
const CACHE_MAX = 100

type Entry<T> = { at: number; ttl: number; promise: Promise<T> }

export const bounded = <T>(
  cache: Map<string, Entry<T>>,
  key: string,
  ttl: number,
  load: () => Promise<T>,
  now: () => number = Date.now
) => {
  const hit = cache.get(key)
  if (hit && now() - hit.at < Math.min(ttl, hit.ttl)) return hit.promise
  const promise = load()
  const entry: Entry<T> = { at: now(), ttl, promise }
  cache.delete(key)
  cache.set(key, entry)
  const oldest = cache.keys().next().value
  if (cache.size > CACHE_MAX && oldest !== undefined) cache.delete(oldest)
  promise.catch(() => {
    entry.at = now()
    entry.ttl = FAIL_TTL
  })
  return promise
}

const connections = new Map<string, Entry<InstanceConnection>>()
const invites = new Map<string, Entry<Invite>>()

export const remoteConnection = (origin: string) =>
  bounded(connections, origin, INFO_TTL, async () => {
    if (!remoteAllowed(origin, home.origin))
      throw new InstanceError(`${hostOf(origin) ?? origin} is not a public https site`)
    const info = await fetchInstance(origin)
    if (!compatible(info))
      throw new InstanceError(`${hostOf(origin) ?? origin} runs an RChat API this client can't use`)
    return registry.add(origin, info)
  })

export const remoteInvite = (
  origin: string,
  server: string,
  password: string | null,
  fresh = false
) =>
  bounded(invites, `${origin}\n${server}\n${password ?? ''}`, fresh ? 0 : INVITE_TTL, async () => {
    const conn = await remoteConnection(origin)
    return conn.api.getInvite(server, password)
  })

const requested = new Set<string>()

export const previewRequested = (key: string) => requested.has(key)

export const requestPreview = (key: string) => {
  requested.add(key)
  if (requested.size > CACHE_MAX) requested.delete(requested.values().next().value as string)
}
