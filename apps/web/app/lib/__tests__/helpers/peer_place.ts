import type { P2pApp } from '../../p2p/app/runtime'
import { P2pDm } from '../../place/place'

type PeerState = ReturnType<P2pApp['useP2p']['getState']>

// Puts `state` in the identity's store, for client reads and for server renders.
export const seedPeer = (app: P2pApp, state: Partial<PeerState>) => {
  Object.assign(app.useP2p.getInitialState(), state)
  app.useP2p.setState(state)
}

// A P2P conversation of `app`, whose store holds `state` in place of what a test is about.
export const peerPlace = (app: P2pApp, state: Partial<PeerState> = {}) => {
  seedPeer(app, { me: 'me', ...state })
  return P2pDm.open(app, 'dm')
}
