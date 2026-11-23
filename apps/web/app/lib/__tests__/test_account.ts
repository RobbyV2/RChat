import { AccountSession } from '../client/session'
import { endpointsFrom, InstanceConnection } from '../instances'
import { me } from './fixtures'

export function testAccount(username: string, origin = 'https://instance.test') {
  const account = new AccountSession(new InstanceConnection(endpointsFrom(origin, null)))
  Object.assign(account.store.getInitialState(), { me: me(username) })
  account.store.setState({ me: me(username) })
  return account
}
