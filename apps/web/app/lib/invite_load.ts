import { background, missing, refusalOf, statusOf, type Refusal } from './api_errors'
import type { AccountSession } from './client/session'
import { InstanceError, type InstanceConnection } from './instances'
import { keepsPreview, pinnedPreview } from './invite'
import { deniedAccess, needsPassword } from './join_flow'
import { time } from './platform/time'
import type { InviteAccess } from './remote_invite'
import type { Invite, Message } from './types'

// What asking for an invite answered: the invite, a server that wants its password first (with
// the line for a password it turned down), an invite that is gone, or one only a signed-in
// account may see.
export type InviteView =
  | { kind: 'here'; invite: Invite }
  | { kind: 'hidden'; denied: string | null }
  | { kind: 'gone' }
  | { kind: 'locked'; refusal: Refusal }

// The answer a refused invite request stands for. Any other failure is thrown again.
export const refusedInvite = (error: unknown, byCode: boolean): InviteView => {
  if (!byCode && needsPassword(error)) return { kind: 'hidden', denied: null }
  if (!byCode && deniedAccess(error))
    return { kind: 'hidden', denied: error instanceof Error ? error.message : null }
  if (missing(error)) return { kind: 'gone' }
  if (statusOf(error) === 401) return { kind: 'locked', refusal: refusalOf(error) }
  throw error
}

// What a card shows after asking again failed: the invite it already shows when the failure
// passes on its own (no answer, a rate limit, a server error), else what the failure stands for.
export const afterRefusal = (
  shown: InviteView | null,
  error: unknown,
  byCode: boolean
): InviteView => {
  if (shown?.kind === 'here' && keepsPreview(statusOf(error))) {
    background('invite refresh')(error)
    return shown
  }
  return refusedInvite(error, byCode)
}

export const INVITE_TTL = 30_000
export const INVITE_FRESH = 1_000
const CACHE_MAX = 100
type InviteResults = Map<string, { at: number; promise: Promise<Invite> }>
const results = new WeakMap<object, InviteResults>()

export interface InviteAsk {
  // What tells this ask from every other: who asks, what for, and which change it follows.
  key: string
  server: string
  password: string | null
  code: string | null
}

// The invite, from the account's instance. Cards that ask for the same one within `maxAge`
// share one request.
export const fetchInvite = (
  owner: AccountSession,
  { key, server, password, code }: InviteAsk,
  maxAge: number
): Promise<Invite> => {
  const mark = owner.lifetime.sessionMark()
  const cache = results.get(mark) ?? new Map<string, { at: number; promise: Promise<Invite> }>()
  results.set(mark, cache)
  const hit = cache.get(key)
  if (hit && time().now() - hit.at < maxAge) return hit.promise
  const promise = code
    ? owner.api.inviteByCode(code)
    : owner.api.getInvite(server, password, 'metadata')
  cache.delete(key)
  cache.set(key, { at: time().now(), promise })
  const oldest = cache.keys().next().value
  if (cache.size > CACHE_MAX && oldest !== undefined) cache.delete(oldest)
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key)
  })
  return promise
}

// Whether `password` opens the invite of `server`: null when it does, else the line to show.
export const tryInvitePassword = (
  owner: AccountSession,
  server: string,
  password: string
): Promise<string | null> =>
  owner.api.getInvite(server, password, 'metadata').then(
    () => null,
    (error: unknown) =>
      needsPassword(error)
        ? 'Enter the server password'
        : error instanceof Error
          ? error.message
          : String(error)
  )

const never = new Promise<never>(() => {})

export interface PreviewAsk {
  conn: InstanceConnection
  server: string
  password: string | null
  id: number | null
  label: boolean
  access?: InviteAccess
}

export interface PreviewChange {
  id: number | null
  label: boolean
  name: string | null
}

// The messages of an invite's preview channel. When the server answers for another channel or
// another label than the one asked for, `changed` hears it and nothing is shown for this ask.
export const fetchPreview = (
  { conn, server, password, id, label, access }: PreviewAsk,
  changed: (to: PreviewChange) => void
): Promise<Message[]> => {
  const revision = { revision: `${id}.${label ? 1 : 0}` }
  const asked = access
    ? access.read(conn, server, password, revision)
    : conn.api.getInvite(server, password, revision)
  return asked.then(data => {
    if (access && !access.current()) return never
    const answer = pinnedPreview({ id, label }, data)
    if (!answer.changed) return answer.messages
    changed(answer.changed)
    return never
  })
}

// An invite on another site: the site and the invite, a site that wants a password, an invite
// that is gone, or an address that did not answer as one of these sites (`line` says how, when
// it said).
export type RemoteView =
  | { kind: 'here'; invite: Invite; conn: InstanceConnection; info: InstanceConnection['info'] }
  | { kind: 'hidden'; info: InstanceConnection['info'] }
  | { kind: 'gone'; info: InstanceConnection['info'] }
  | { kind: 'foreign'; line: string | null }

export interface RemoteAsk {
  origin: string
  server: string
  password: string | null
  access: InviteAccess
}

// Asks the other site for the invite. `resolved` hears whether the address is one of these
// sites, as soon as that is known. A site that answers but refuses for a passing reason is a
// failure to ask again.
export const fetchRemoteInvite = (
  owner: AccountSession,
  { origin, server, password, access }: RemoteAsk,
  fresh: boolean,
  resolved: (site: boolean) => void
): Promise<RemoteView> =>
  owner.invites.remoteConnection(origin).then(
    conn => {
      if (!access.current()) return never
      resolved(true)
      return access.read(conn, server, password, 'metadata', fresh).then(
        (invite): RemoteView | Promise<never> =>
          access.current() ? { kind: 'here', invite, conn, info: conn.info } : never,
        (error: unknown): RemoteView | Promise<never> => {
          if (!access.current()) return never
          if (needsPassword(error) || deniedAccess(error))
            return { kind: 'hidden', info: conn.info }
          if (missing(error)) return { kind: 'gone', info: conn.info }
          throw error
        }
      )
    },
    (error: unknown): RemoteView | Promise<never> => {
      if (!access.current()) return never
      resolved(false)
      return { kind: 'foreign', line: error instanceof InstanceError ? error.message : null }
    }
  )
