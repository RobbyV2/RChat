// What the store's slices share: the zustand setters, the event handler tables and the router
// that runs one handler per event type.

import type { StoreApi } from 'zustand'
import type { Paged, RChatState } from '../store_types'
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
