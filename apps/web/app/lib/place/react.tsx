'use client'

import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { useAccount, useStore } from '../client/react'
import { featureAt, type Feature, type Unsupported } from './feature'
import type { Live } from './live'
import { useP2pApp } from '../client/p2p_react'
import { HostedDm, HostedServer, P2pRoom, type Place } from './place'

const PlaceContext = createContext<Place | null>(null)

// The place whose features the components inside use.
export function PlaceProvider({ place, children }: { place: Place; children: ReactNode }) {
  return <PlaceContext.Provider value={place}>{children}</PlaceContext.Provider>
}

// The place around a component: the one a provider gives, else the hosted channel's server or
// the hosted DM the account has open. Null when neither is there.
export function usePlace(): Place | null {
  const given = useContext(PlaceContext)
  const account = useAccount()
  const server = useStore(s => (s.view?.kind === 'channel' ? s.view.server : null))
  const dmId = useStore(s => (s.view?.kind === 'dm' ? s.view.dmId : null))
  if (given) return given
  if (server !== null) return HostedServer.open(account, server)
  return dmId === null ? null : HostedDm.open(account, dmId)
}

// The hosted server `server` of the account around the component.
export function useHostedServer(server: string | null): HostedServer | null {
  const account = useAccount()
  return server === null ? null : HostedServer.open(account, server)
}

// The P2P room `room` of the identity around the component.
export function useP2pRoom(room: string | null): P2pRoom | null {
  const app = useP2pApp()
  return app && room !== null ? P2pRoom.open(app, room) : null
}

// `feature` as the place around the component has it.
export function useFeature<F>(feature: Feature<F>): F | Unsupported {
  return featureAt(feature, usePlace())
}

export function useLive<T>(live: Live<T>): T {
  return useSyncExternalStore(live.subscribe, live.get, live.initial ?? live.get)
}

// A live value picked with `pick`, which runs again when `deps` change.
export function useWatch<T>(pick: () => Live<T>, deps: readonly unknown[]): T {
  return useLive(useMemo(pick, deps))
}
