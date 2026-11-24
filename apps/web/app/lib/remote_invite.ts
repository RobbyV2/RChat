import { allowsAccountOrigin } from './client/hosted_policy'
import { client } from './client/client'
import type { AccountSession } from './client/session'
import { Ended } from './slices/ctx'
import {
  InstanceError,
  compatible,
  fetchInstance,
  endpointsFrom,
  remoteAllowed,
  InstanceConnection,
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

export interface InviteAccess {
  current(): boolean
  read(
    conn: InstanceConnection,
    server: string,
    password: string | null,
    part: 'metadata' | { revision: string },
    fresh?: boolean
  ): Promise<Invite>
}

export function createInviteCache(account: AccountSession) {
  const connections = new Map<string, Entry<InstanceConnection>>()
  const invites = new Map<string, Entry<Invite>>()
  const requested = new Set<string>()
  const anonymous = new WeakSet<InstanceConnection>()

  const knownAccount = (origin: string) => {
    if (!allowsAccountOrigin(origin)) return undefined
    return account.conn.origin === origin
      ? account
      : client.live().find(other => other.conn.origin === origin)
  }

  function remoteConnection(origin: string) {
    const known = knownAccount(origin)
    if (known) return Promise.resolve(known.conn)
    return bounded(connections, origin, INFO_TTL, async () => {
      if (!remoteAllowed(origin, account.conn.origin))
        throw new InstanceError(`${hostOf(origin) ?? origin} is not a public https site`)
      const info = await fetchInstance(origin)
      if (!compatible(info))
        throw new InstanceError(
          `${hostOf(origin) ?? origin} runs an RChat API this client can't use`
        )
      const connection = new InstanceConnection(endpointsFrom(origin, info), info)
      anonymous.add(connection)
      return connection
    })
  }

  function forCredentials(session: AccountSession) {
    const mark = session.lifetime.sessionMark()
    const { token, guestGrants } = session.store.getState()
    return () => {
      const state = session.store.getState()
      return (
        mark === session.lifetime.sessionMark() &&
        token === state.token &&
        guestGrants === state.guestGrants
      )
    }
  }

  function access(origin: string): InviteAccess {
    const target = knownAccount(origin)
    const sourceValid = forCredentials(account)
    const targetValid = target ? forCredentials(target) : () => true
    const current = () => sourceValid() && target === knownAccount(origin) && targetValid()
    const read = async (
      conn: InstanceConnection,
      server: string,
      password: string | null,
      part: 'metadata' | { revision: string },
      fresh = false
    ) => {
      if (
        !current() ||
        (target ? target.conn !== conn : !anonymous.has(conn)) ||
        conn.origin !== origin
      )
        throw new Ended()
      const load = () => conn.api.getInvite(server, password, part)
      const result =
        !target && part === 'metadata'
          ? await bounded(
              invites,
              JSON.stringify([origin, server, password]),
              fresh ? 0 : INVITE_TTL,
              load
            )
          : await load()
      if (!current()) throw new Ended()
      return result
    }
    return { current, read }
  }

  // The mounted card loses its previous data as soon as either account or its grants change.
  function watch(origin: string) {
    let audience = access(origin)
    const snapshot = () => {
      if (!audience.current()) audience = access(origin)
      return audience
    }
    const subscribe = (notify: () => void) => {
      let target: AccountSession | undefined
      let stopTarget: (() => void) | undefined
      const changed = () => {
        followTarget()
        notify()
      }
      const followTarget = () => {
        const next = knownAccount(origin)
        if (next === target) return
        stopTarget?.()
        target = next
        stopTarget = target !== account ? target?.store.subscribe(changed) : undefined
      }
      followTarget()
      const stopBook = client.subscribe(changed)
      const stopSource = account.store.subscribe(changed)
      return () => {
        stopSource()
        stopBook()
        stopTarget?.()
      }
    }
    return { subscribe, snapshot }
  }

  async function remoteInvite(
    origin: string,
    server: string,
    password: string | null,
    fresh = false
  ) {
    const audience = access(origin)
    const conn = await remoteConnection(origin)
    return audience.read(conn, server, password, 'metadata', fresh)
  }

  const requestPreview = (key: string) => {
    requested.add(key)
    if (requested.size > CACHE_MAX) requested.delete(requested.values().next().value as string)
  }

  return {
    remoteConnection,
    remoteInvite,
    watch,
    requestPreview,
    previewRequested: (key: string) => requested.has(key),
    clear() {
      connections.clear()
      invites.clear()
      requested.clear()
    },
  }
}

export const previewRequested = (key: string) => client.shown().invites.previewRequested(key)
export const requestPreview = (key: string) => client.shown().invites.requestPreview(key)
