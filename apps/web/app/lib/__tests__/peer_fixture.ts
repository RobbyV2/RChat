import type { AccountSession } from '../client/session'
import { me } from './fixtures'

export function createPeerFixture(account: AccountSession, username: string) {
  account.store.setState(s => ({
    me: me(username),
    guest: false,
    settings: { ...s.settings, p2p: true },
  }))
  Object.assign(account.store.getInitialState(), account.store.getState())
  account.identities.setAccount(username)
  return account.identities.get()!
}
