import { expect, test } from 'bun:test'
import { selectLinkOwner } from '../client/link_selection'
import { client } from '../client/client'
import { messageInstanceTarget, routeInstanceLink } from '../client/instance_links'
import { testAccount } from './test_account'

test('zero, one and multiple candidates, remembered owner, actor, and recency ties', () => {
  const choose = (users: string[], preference?: string, actor?: string) =>
    selectLinkOwner(users, preference, actor, name => (name === 'carol' ? 2 : 0))
  expect(choose([], 'missing')).toEqual({ kind: 'add' })
  expect(choose(['alice'], 'missing')).toEqual({ kind: 'open', owner: 'alice' })
  expect(choose(['alice', 'carol'], 'alice', 'carol')).toEqual({ kind: 'open', owner: 'alice' })
  expect(choose(['alice', 'carol'], 'gone', 'carol')).toEqual({ kind: 'open', owner: 'carol' })
  expect(choose(['alice', 'carol'], undefined, 'other')).toEqual({ kind: 'choose', owner: 'carol' })
  expect(choose(['bob', 'alice'])).toEqual({ kind: 'choose', owner: 'bob' })
})

test('ordinary links require an exact recognized origin and an app route', () => {
  const owner = testAccount('alice', 'https://beta.test:8443')
  try {
    for (const href of [
      'http://beta.test:8443/dm/1/5/',
      'https://beta.test/dm/1/5/',
      'https://beta.test:8443/blog',
      'https://a@beta.test:8443/invite/main/',
    ])
      expect(messageInstanceTarget(owner, href)).toBeNull()
    expect(messageInstanceTarget(owner, 'https://beta.test:8443/i/abc234/')).toEqual({
      origin: owner.conn.origin,
      path: '/i/abc234/',
    })
    expect(messageInstanceTarget(owner, 'rchat://other.test/i/abc234/')).toEqual({
      origin: 'https://other.test',
      path: '/i/abc234/',
    })
  } finally {
    owner.store.dispose()
  }
})

test('superseding navigation retires a chooser and prevents accepting the stale link', async () => {
  const source = testAccount('alice', 'https://alpha.choice.test')
  const a = testAccount('alice', 'https://beta.choice.test')
  const b = testAccount('bob', a.conn.origin)
  const previous = client.shown
  client.shown = () => source
  try {
    const pending = routeInstanceLink(source, {
      origin: a.conn.origin,
      path: '/invite/club/#password=Mixed',
    })
    const dialog = source.store.getState().activeDialog
    expect(dialog?.kind).toBe('instance_link')
    source.store.cancelNavigation()
    source.store.setState({ home: true })
    if (dialog?.kind === 'instance_link') dialog.accept('bob')
    await pending
    expect(source.store.getState().activeDialog).toBeNull()
    expect(b.store.getState().invite).toBeNull()
    expect(client.shown()).toBe(source)
  } finally {
    client.shown = previous
    for (const owner of [source, a, b]) owner.store.dispose()
  }
})

test('an account that reauthenticates while a chooser is open needs a new click', async () => {
  const source = testAccount('actor', 'https://alpha.reauth.test')
  const target = testAccount('bob', 'https://beta.reauth.test')
  const other = testAccount('carol', target.conn.origin)
  const previous = client.shown
  client.shown = () => source
  try {
    const pending = routeInstanceLink(source, { origin: target.conn.origin, path: '/invite/main/' })
    const dialog = source.store.getState().activeDialog
    expect(dialog?.kind).toBe('instance_link')
    target.lifetime.endSession()
    if (dialog?.kind === 'instance_link') dialog.accept('bob')
    await pending
    expect(target.store.getState().invite).toBeNull()
    expect(source.store.getState().error).toBe('Sign in again to open this link.')
  } finally {
    client.shown = previous
    for (const owner of [source, target, other]) owner.store.dispose()
  }
})
