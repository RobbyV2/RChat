// What the store's slices share: the zustand setters, the event handler tables and the router
// that runs one handler per event type.

import type { StoreApi } from 'zustand'
import { home } from '../instances'
import type { Key, Page } from '../lists'
import type { Paged, RChatState, SearchState } from '../store_types'
import type { ServerSummary, WsEvent } from '../types'

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

export const pageVisible = () =>
  typeof document === 'undefined' || document.visibilityState === 'visible'

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

// Reads a per-account value; storage that throws (no window, privacy mode) gives the fallback.
export const readScoped = <T>(key: string, parse: (raw: string | null) => T, fallback: T): T => {
  try {
    return parse(localStorage.getItem(home.scoped(key)))
  } catch {
    return fallback
  }
}

// Loads a paged list; a page that arrives after the list was reset or searched again is dropped.
export const pageLoader = (epochs: Record<string, number>) => {
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
    const base: Paged<T> = fresh
      ? { list: [], hasMore: true, loading: true, q, cursor: null }
      : { ...cur, loading: true }
    write(base)
    let page: Page<T>
    try {
      page = await fetchPage(base.cursor ?? null)
    } catch (e) {
      if ((epochs[id] ?? 0) === epoch) write({ ...base, loading: false })
      throw e
    }
    if ((epochs[id] ?? 0) !== epoch) return
    const seen = pageKeys.get(base.list) ?? new Set<Key>(base.list.map(keyOf))
    const added = page.items.filter(item => {
      const key = keyOf(item)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    const list = added.length ? [...base.list, ...added] : base.list
    pageKeys.set(list, seen)
    write({ ...base, list, hasMore: page.next !== null, cursor: page.next, loading: false })
  }
  return loadPage
}
