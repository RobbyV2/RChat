'use client'

import { createContext, useContext, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { useStore } from 'zustand'
import { legacyP2pApp, type P2pApp } from '../p2p/app/runtime'
import type { P2pState } from '../p2p/app/store'
import { AccountContext, useAccount } from './react'

const PeerContext = createContext<P2pApp | null | undefined>(undefined)
const empty = createStore<P2pState>(() => ({ ...legacyP2pApp.useP2p.getInitialState() }))

export function P2pProvider({
  identity,
  children,
}: {
  identity: P2pApp | null
  children: ReactNode
}) {
  return <PeerContext.Provider value={identity}>{children}</PeerContext.Provider>
}

export function useP2pApp() {
  const provider = useContext(AccountContext)
  const selected = useContext(PeerContext)
  const account = useAccount()
  const guest = useStore(account.store, s => s.guest)
  const name = useStore(account.store, s => (!s.guest && s.settings.p2p ? s.me?.username : null))
  const snapshot = () => {
    if (guest) return null
    if (!provider && (selected === undefined || selected === legacyP2pApp)) return legacyP2pApp
    if (!name || selected === null) return null
    const app = selected ? account.identities.get(selected.localId) : account.identities.viewed()
    return !selected || selected === app ? (app ?? null) : null
  }
  return useSyncExternalStore(account.identities.subscribe, snapshot, snapshot)
}

function usePeerState(): P2pState
function usePeerState<T>(selector: (state: P2pState) => T): T
function usePeerState<T>(selector?: (state: P2pState) => T) {
  const store = useP2pApp()?.useP2p ?? empty
  return useStore<StoreApi<P2pState>, T | P2pState>(store, selector ?? (state => state))
}
export const useP2p = Object.assign(usePeerState, {
  getState: () => legacyP2pApp.useP2p.getState(),
  getInitialState: () => legacyP2pApp.useP2p.getInitialState(),
  setState: legacyP2pApp.useP2p.setState,
  subscribe: (listener: Parameters<P2pApp['useP2p']['subscribe']>[0]) =>
    legacyP2pApp.useP2p.subscribe(listener),
})

export function withP2pIdentity<Props extends object>(View: React.ComponentType<Props>) {
  return function IdentityView(props: Props) {
    const app = useP2pApp()
    const last = useRef({ app, key: 0 })
    if (last.current.app !== app) last.current = { app, key: last.current.key + 1 }
    if (!app) return null
    const key = last.current.key
    return (
      <P2pProvider identity={app}>
        <View key={key} {...props} />
      </P2pProvider>
    )
  }
}
