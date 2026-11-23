import { client } from '../client/client'
import { me } from './fixtures'

// Older UI fixtures seed the live store and the server-render snapshot independently.
export function shownPeer() {
  const owner = client.shown()
  const state = owner.store.getState()
  const snapshot = owner.store.getInitialState()
  const user = state.me ?? snapshot.me ?? me('alice')
  if (!state.settings.p2p || !state.me || state.guest) {
    owner.store.setState({
      me: user,
      guest: false,
      settings: state.settings.p2p ? state.settings : { ...state.settings, p2p: true },
    })
  }
  Object.assign(snapshot, {
    me: snapshot.me ?? user,
    guest: false,
    settings: snapshot.settings.p2p ? snapshot.settings : { ...snapshot.settings, p2p: true },
  })
  owner.identities.setAccount(user.username)
  return owner.identities.get()!
}
