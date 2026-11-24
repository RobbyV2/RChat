import { expect, test } from 'bun:test'
import { ctxFor } from '../actions/ctx'
import { registerAppActions } from '../actions'
import { openActionMenu } from '../actions/menu'
import { runAction } from '../actions/registry'
import { client } from '../client/client'
import { testAccount } from './test_account'
import { user } from './fixtures'

registerAppActions()

test('a saved action acts on its account and expires with its session', async () => {
  const a = testAccount('sam', 'https://one.test')
  const b = testAccount('sam', 'https://two.test')
  try {
    a.store.setState({ typingOn: true })
    b.store.setState({ typingOn: true })
    const ctx = ctxFor(b.store.getState(), { kind: 'none' }, 'palette', b)
    expect(await runAction('typing', ctx)).toBe(true)
    expect(b.store.getState().typingOn).toBe(false)
    expect(a.store.getState().typingOn).toBe(true)
    b.lifetime.endSession()
    expect(await runAction('typing', ctx)).toBe(false)
    expect(b.store.getState().typingOn).toBe(false)
  } finally {
    a.store.dispose()
    b.store.dispose()
  }
})

test('a DM menu opens the selected account’s conversation when IDs overlap', () => {
  const a = testAccount('sam', 'https://one.test')
  const b = testAccount('sam', 'https://two.test')
  const dm = { id: 7, other: user('alice'), is_self: false }
  const visits: string[] = []
  try {
    for (const account of [a, b]) {
      account.store.setState({
        dms: [dm],
        openDm: async id => {
          visits.push(account.conn.host + '/' + id)
        },
      })
    }
    client.show(a, 'none')
    openActionMenu(5, 5, { kind: 'dm', dm, where: 'home' }, {}, b)
    expect(client.overlayOwner()).toBe(b)
    expect(client.shown()).toBe(a)
    const row = b.store.getState().contextMenu?.items.find(item => item.label === 'Open')
    expect(row?.action).not.toBeUndefined()
    row?.action?.()
    expect(client.shown()).toBe(b)
    expect(visits).toEqual(['two.test/7'])
    client.show(a, 'none')
    b.lifetime.endSession()
    row?.action?.()
    expect(client.shown()).toBe(a)
    expect(visits).toEqual(['two.test/7'])
    expect(a.store.getState().contextMenu).toBeNull()
  } finally {
    a.store.dispose()
    b.store.dispose()
  }
})
