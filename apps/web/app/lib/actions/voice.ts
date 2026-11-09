// How a DM call connects: the menu of the call buttons' chevrons.

import {
  P2P_IP_HINT,
  ROUTE_LABEL,
  p2pCallable,
  recentlyFailed,
  routeFor,
  type CallRoute,
} from '../call_choice'
import { relayOnly } from '../ice'
import { displayHost, hostOf, manualRelays, ownTurn } from '../relays'
import { useStore } from '../store'
import type { RChatState } from '../store_types'
import type { DmSummary } from '../types'
import type { Action, ActionCtx } from './types'

const get = () => useStore.getState()

// Whether a call with the DM's other person can go direct (P2P) now.
export const p2pCallOk = (s: RChatState, dm: DmSummary) =>
  p2pCallable({
    guest: s.guest,
    signedIn: s.me !== null,
    p2pOn: s.settings.p2p_attachments,
    selfDm: dm.is_self,
    failed: recentlyFailed(s.p2pCallFailed[dm.id]),
  })

// A direct call shows your IP to the other person unless every path goes through a relay.
export const hidesIp = (s: RChatState) =>
  relayOnly(s.instance?.ice, s.iceHelpers, s.iceRelay, ownTurn(s.relayPrefs))

const callOf = ({ s, target }: ActionCtx) =>
  target.kind === 'call' && s.call === null ? target : null

const routeOf = (ctx: ActionCtx): CallRoute | null => {
  const at = callOf(ctx)
  return at && routeFor(ctx.s.callRoute, p2pCallOk(ctx.s, at.dm))
}

const direct = (ctx: ActionCtx) => {
  const at = callOf(ctx)
  return !!at && p2pCallOk(ctx.s, at.dm)
}

const onCall = { scope: 'voice', targets: ['call'] } as const

export const voiceActions: Action[] = [
  {
    id: 'call_route_server',
    title: 'Call through the server',
    label: () => ROUTE_LABEL.server,
    ...onCall,
    order: 100,
    radio: true,
    checked: ctx => routeOf(ctx) === 'server',
    available: ctx => callOf(ctx) !== null,
    run: ctx => {
      const at = callOf(ctx)
      if (!at) return
      get().setCallRoute('server')
      void get().startCall(at.dm.id, at.video)
    },
  },
  {
    id: 'call_route_p2p',
    title: 'Call direct (P2P)',
    label: () => ROUTE_LABEL.p2p,
    ...onCall,
    order: 110,
    radio: true,
    wrap: true,
    subtitle: ({ s }) => (hidesIp(s) ? undefined : P2P_IP_HINT),
    checked: ctx => routeOf(ctx) === 'p2p',
    available: direct,
    run: ctx => {
      const at = callOf(ctx)
      if (!at) return
      get().setCallRoute('p2p')
      void get().startP2pCall(at.dm.id, at.video)
    },
  },
  {
    // A P2P call through one of your relays, for this call only: the default for files and calls
    // stays the one in Settings.
    id: 'call_route_relay',
    title: 'Call direct through a relay',
    ...onCall,
    order: 120,
    available: direct,
    expand: ({ s }) =>
      manualRelays(s.relayPrefs).map(r => ({
        key: r.url,
        label: `Direct through ${displayHost(hostOf(r.url) ?? r.url)}`,
        wrap: true,
        args: { relay: r.url },
      })),
    run: (ctx, { relay }) => {
      const at = callOf(ctx)
      if (!at || !relay) return
      get().setCallRoute('p2p')
      void get().startP2pCall(at.dm.id, at.video, relay)
    },
  },
]
