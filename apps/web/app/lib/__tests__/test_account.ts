import { AccountSession } from '../client/session'
import { endpointsFrom, InstanceConnection } from '../instances'
import { me } from './fixtures'
import { own } from './helpers/fixture'

// An account session of its own, disposed after the test (or after the file, made outside a test).
export function testSession(...args: ConstructorParameters<typeof AccountSession>) {
  return own(new AccountSession(...args), account => account.store.dispose())
}

export function testAccount(username: string, origin = 'https://instance.test') {
  const account = testSession(new InstanceConnection(endpointsFrom(origin, null)))
  Object.assign(account.store.getInitialState(), { me: me(username) })
  account.store.setState({ me: me(username) })
  return account
}
