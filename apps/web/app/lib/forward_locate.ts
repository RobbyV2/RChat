import { ApiError, type Api } from './api'
import type { AccountSession } from './client/session'
import type { RChatState } from './store_types'
import type { WsEvent } from './types'
import { time } from './platform/time'

// What a forward of a message names when its sender shows where it's from, as the server
// decides it: the server, and the channel when everyone there may see it.
export interface ShownSource {
  server: string
  channel?: string
}

// Where a message is, as the viewer's own access answers: a channel (with what a forward that
// shows its source would name), a direct message they are in, or nowhere they can read.
export type Located =
  | { kind: 'channel'; server: string; id: number; shown: ShownSource | null }
  | { kind: 'dm' }
  | { kind: 'none' }

// Undefined after any other error.
export const locateSource = async (
  id: number,
  accountApi: Pick<Api, 'messagePlace'>
): Promise<Located | undefined> => {
  try {
    const place = await accountApi.messagePlace(id)
    if (place.server && place.channel_id != null)
      return {
        kind: 'channel',
        server: place.server,
        id: place.channel_id,
        shown: place.shown ?? null,
      }
    if (place.dm_id != null) return { kind: 'dm' }
  } catch (e) {
    if (e instanceof ApiError && (e.status === 403 || e.status === 404)) return { kind: 'none' }
  }
}

// One answer per message and account session, shared by every view of its copies (card, pill,
// menu, the forward bar). An answer holds while the account's servers keep their names; a channel
// answer while its server keeps the name and channel list it had (a reload of the server
// replaces the list); "nowhere you can read" for a minute, so access gained shows.
interface Lookup {
  id: number
  members: string
  at: number
  channels?: object
  display?: string
  value?: Located
  failed?: true
  pending?: Promise<void>
}

type State = Pick<RChatState, 'me' | 'servers'>

export const LOOKUPS_MAX = 500
export const NONE_TTL_MS = 60_000

const lookups = new WeakMap<object, Map<string, Lookup>>()

// The account's servers by name: answers hold for one such list.
export const membersOf = (s: State) =>
  (s.me?.servers ?? [])
    .map(x => x.name)
    .sort()
    .join('\n')

const holds = (entry: Lookup, s: State) => {
  if (entry.members !== membersOf(s)) return false
  const value = entry.value
  if (value?.kind === 'none') return time().now() - entry.at <= NONE_TTL_MS
  if (value?.kind !== 'channel') return true
  const detail = s.servers[value.server]
  if (!entry.channels) {
    entry.channels = detail?.channels
    entry.display = detail?.display_name
    return true
  }
  return entry.channels === detail?.channels && entry.display === detail?.display_name
}

const tableOf = (owner: AccountSession, create: boolean) => {
  const mark = owner.lifetime.sessionMark()
  const found = lookups.get(mark)
  if (found || !create) return found
  const fresh = new Map<string, Lookup>()
  lookups.set(mark, fresh)
  return fresh
}

const keyOf = (s: State, id: number) => `${s.me?.username ?? ''}:${id}`

// The answer so far, without asking: undefined before it, and once it may be stale.
export const locatedNow = (owner: AccountSession, id: number) => {
  const s = owner.store.getState()
  const entry = tableOf(owner, false)?.get(keyOf(s, id))
  return entry && holds(entry, s) ? entry.value : undefined
}

// The last ask ended in another error (it is asked again next time).
export const locateFailed = (owner: AccountSession, id: number) => {
  const s = owner.store.getState()
  const entry = tableOf(owner, false)?.get(keyOf(s, id))
  return !!entry?.failed && !entry.pending && entry.members === membersOf(s)
}

// Asks once; a pending ask is shared while the account's servers are the same.
export const locateOnce = (owner: AccountSession, id: number): Promise<void> => {
  const s = owner.store.getState()
  const all = tableOf(owner, true)!
  const key = keyOf(s, id)
  const members = membersOf(s)
  const entry = all.get(key)
  if (entry?.pending && entry.members === members) return entry.pending
  if (entry?.value && holds(entry, s)) return Promise.resolve()
  const fresh: Lookup = { id, members, at: time().now() }
  all.delete(key)
  if (all.size >= LOOKUPS_MAX) all.delete(all.keys().next().value!)
  all.set(key, fresh)
  const session = owner.lifetime.sessionMark()
  fresh.pending = locateSource(id, owner.api).then(found => {
    fresh.pending = undefined
    if (session !== owner.lifetime.sessionMark()) return
    if (!found) {
      fresh.failed = true
      return
    }
    fresh.value = found
    fresh.at = time().now()
    if (found.kind !== 'channel') return
    const detail = owner.store.getState().servers[found.server]
    fresh.channels = detail?.channels
    fresh.display = detail?.display_name
  })
  return fresh.pending
}

// A deleted original or channel takes its answers along.
export const forgetLocated = (owner: AccountSession, ev: WsEvent) => {
  const all = tableOf(owner, false)
  if (!all) return
  const gone =
    ev.type === 'message_deleted'
      ? (e: Lookup) => e.id === ev.id
      : ev.type === 'messages_deleted'
        ? (e: Lookup) => ev.ids.includes(e.id)
        : ev.type === 'channel_deleted'
          ? (e: Lookup) => e.value?.kind === 'channel' && e.value.id === ev.channel_id
          : null
  if (!gone) return
  for (const [key, entry] of all) if (gone(entry)) all.delete(key)
}
