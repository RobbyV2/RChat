'use client'

import { createContext, useContext, type ReactNode } from 'react'
import { useStore as useZustand, type UseBoundStore } from 'zustand'
import type { StoreApi } from 'zustand/vanilla'
import type { RChatState } from '../store_types'
import { client } from './client'
import type { AccountSession } from './session'

const AccountContext = createContext<AccountSession | null>(null)

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
  const shown = client.shown()
  return account ?? shown
}

export const useStoreApi = () => useAccount().store
export const useConn = () => useAccount().conn
export const useApi = () => useAccount().api

const identity = (state: RChatState) => state
function useAccountStore(): RChatState
function useAccountStore<T>(selector: (s: RChatState) => T): T
function useAccountStore<T = RChatState>(selector?: (s: RChatState) => T) {
  return useZustand<StoreApi<RChatState>, T | RChatState>(useStoreApi(), selector ?? identity)
}

const shownStore = () => client.shown().store

type Patch =
  RChatState | Partial<RChatState> | ((state: RChatState) => RChatState | Partial<RChatState>)
type Update =
  | [patch: Patch, replace?: false]
  | [state: RChatState | ((state: RChatState) => RChatState), replace: true]

export const useStore: UseBoundStore<StoreApi<RChatState>> = Object.assign(useAccountStore, {
  getState: () => shownStore().getState(),
  getInitialState: () => shownStore().getInitialState(),
  setState: (...args: Update) => {
    if (args[1]) shownStore().setState(args[0], true)
    else shownStore().setState(args[0], false)
  },
  subscribe: (listener: Parameters<StoreApi<RChatState>['subscribe']>[0]) =>
    shownStore().subscribe(listener),
})
