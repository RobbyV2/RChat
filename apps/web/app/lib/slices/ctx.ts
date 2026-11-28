// What the store's slices share: the zustand setters, the event handler tables and the router
// that runs one handler per event type.

import type { StoreApi } from 'zustand'
import { client } from '../client/client'
import type { Key, Page } from '../lists'
import type { Paged, RChatState, SearchState } from '../store_types'
import type { ServerSummary, WsEvent } from '../types'
import { viewKey, type View } from '../view'
import type { AccountSession } from '../client/session'

export type SetState = StoreApi<RChatState>['setState']
export type GetState = StoreApi<RChatState>['getState']

export type Handler<T extends WsEvent['type']> = (ev: Extract<WsEvent, { type: T }>) => void
export type Handlers = { [T in WsEvent['type']]?: Handler<T> }

// Runs the one handler for `ev.type`; false when no table has one (unknown or ignored types).
export const routeEvent = (ev: WsEvent, tables: readonly Handlers[]): boolean => {
  for (const table of tables) {
    if (!Object.hasOwn(table, ev.type)) continue
    const run = table[ev.type] as ((ev: WsEvent) => void) | undefined
    if (!run) continue
    run(ev)
    return true
  }
  return false
}

// What a late answer throws: it stops what waited for it, and nothing shows it.
export class Ended extends Error {}

// Each session (an account or a guest) has its own mark, and ending it starts a new one. An
// answer that comes back after its session ended sees another mark and is dropped.
export function sessionLifetime() {
  let session = {}
  const sessionMark = () => session
  const endSession = () => {
    session = {}
  }

  // Waits for `p`, but throws `Ended` instead when the session ended meanwhile.
  const live = async <T>(p: Promise<T>): Promise<T> => {
    const at = session
    let out: T
    try {
      out = await p
    } catch (e) {
      if (at === session) throw e
      throw new Ended('The session ended')
    }
    if (at !== session) throw new Ended('The session ended')
    return out
  }

  // `fn`, which does nothing once the session it was made in ended: for what runs after a request.
  const inSession = <A extends unknown[], R>(fn: (...a: A) => R) => {
    const at = session
    return (...a: A): R | undefined => (at === session ? fn(...a) : undefined)
  }

  return { sessionMark, endSession, live, inSession }
}
export const sessionMark = () => client.shown().lifetime.sessionMark()
export const live = <T>(p: Promise<T>) => client.shown().lifetime.live(p)
export const inSession = <A extends unknown[], R>(fn: (...args: A) => R) =>
  client.shown().lifetime.inSession(fn)

export const pageVisible = () =>
  typeof document === 'undefined' || document.visibilityState === 'visible'

// The instance view on screen: none while P2P shows in its place.
export const shownView = (acct: AccountSession, view: View | null) =>
  view && acct.mode === 'shown' && !acct.identities.coversView() ? view : null

export const shownKey = (acct: AccountSession, view: View | null) => {
  const v = shownView(acct, view)
  return v ? viewKey(v) : null
}

// Runs `fetch` until no newer generation started while it ran.
export const settled = async <T>(gen: () => number, fetch: () => Promise<T>): Promise<T> => {
  for (;;) {
    const at = gen()
    const out = await fetch()
    if (gen() === at) return out
  }
}

export const PAGE = 50

export const LIST_MAX = 100

export const BANNED = 'You are banned from this server'

export class Banned extends Error {}

export const emptyPage = <T>(): Paged<T> => ({ list: [], hasMore: true, loading: false, q: '' })

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export const serverKey = (x: ServerSummary) => x.name

export const emptySearch = (): SearchState => ({ results: [], hasMore: false, loading: false })

// Loads a paged list; a page that arrives after the list was reset or searched again, or after
// its session ended, is dropped. A page joins the list as it is when the page arrives, so rows
// changed or removed meanwhile stay that way.
export const pageLoader = (epochs: Record<string, number>, sessionMark: () => object) => {
  const pageKeys = new WeakMap<unknown[], Set<Key>>()

  const loadPage = async <T>(
    id: string,
    read: () => Paged<T>,
    write: (page: Paged<T>) => void,
    fetchPage: (cursor: string | null) => Promise<Page<T>>,
    keyOf: (item: T) => string,
    q: string,
    reset: boolean
  ) => {
    const cur = read()
    const fresh = reset || q !== cur.q
    if (!fresh && (cur.loading || !cur.hasMore)) return
    if (fresh) epochs[id] = (epochs[id] ?? 0) + 1
    const epoch = epochs[id] ?? 0
    const at = sessionMark()
    const current = () => (epochs[id] ?? 0) === epoch && at === sessionMark()
    const base: Paged<T> = fresh
      ? { list: [], hasMore: true, loading: true, q, cursor: null }
      : { ...cur, loading: true }
    write(base)
    let page: Page<T>
    try {
      page = await fetchPage(base.cursor ?? null)
    } catch (e) {
      if (current()) write({ ...base, loading: false })
      throw e
    }
    if (!current()) return
    const now = read().list
    const seen = pageKeys.get(now) ?? new Set<Key>(now.map(keyOf))
    const added = page.items.filter(item => {
      const key = keyOf(item)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    const list = added.length ? [...now, ...added] : now
    pageKeys.set(list, seen)
    write({ ...base, list, hasMore: page.next !== null, cursor: page.next, loading: false })
  }
  return loadPage
}
