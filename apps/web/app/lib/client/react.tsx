'use client'

import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'
import { useStore as useZustand, type UseBoundStore } from 'zustand'
import type { StoreApi } from 'zustand/vanilla'
import type { RChatState } from '../store_types'
import { client } from './client'
import type { AccountSession } from './session'

export const AccountContext = createContext<AccountSession | null>(null)

export function AccountProvider({
  session,
  children,
}: {
  session: AccountSession
  children: ReactNode
}) {
  return <AccountContext.Provider value={session}>{children}</AccountContext.Provider>
}

export function useAccount() {
  const account = useContext(AccountContext)
  return account ?? client.shown()
}

export function useLiveSessions() {
  // Materialize the lazy home session before taking the first snapshot.
  client.shown()
  return useSyncExternalStore(client.subscribe, client.live, client.live)
}

export const useStoreApi = () => useAccount().store
export const useConn = () => useAccount().conn
export const useApi = () => useAccount().api
export const useClock = () => useAccount().time

export function accountBoundStore<S>(
  select: (account: AccountSession) => StoreApi<S>
): UseBoundStore<StoreApi<S>> {
  const identity = (state: S) => state
  function useAccountStore(): S
  function useAccountStore<T>(selector: (state: S) => T): T
  function useAccountStore<T>(selector?: (state: S) => T) {
    return useZustand<StoreApi<S>, T | S>(select(useAccount()), selector ?? identity)
  }

  const shown = () => select(client.shown())
  type Update =
    | [patch: S | Partial<S> | ((state: S) => S | Partial<S>), replace?: false]
    | [state: S | ((state: S) => S), replace: true]
  return Object.assign(useAccountStore, {
    getState: () => shown().getState(),
    getInitialState: () => shown().getInitialState(),
    setState: (...args: Update) => {
      if (args[1]) shown().setState(args[0], true)
      else shown().setState(args[0], false)
    },
    subscribe: (listener: Parameters<StoreApi<S>['subscribe']>[0]) => shown().subscribe(listener),
  })
}

export const useStore = accountBoundStore<RChatState>(account => account.store)
