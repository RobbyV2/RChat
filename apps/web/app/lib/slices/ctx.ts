// What the store's slices share: the zustand setters, the event handler tables and the router
// that runs one handler per event type.

import type { StoreApi } from 'zustand'
import type { RChatState } from '../store_types'
import type { WsEvent } from '../types'

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
