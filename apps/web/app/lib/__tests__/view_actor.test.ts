import { expect, test } from 'bun:test'
import { parseBook } from '../client/book'
import { resolveNoticeActor, resolveViewActor } from '../client/view_actor'

import { testAccount } from './test_account'

const alpha = 'https://alpha.test'
const beta = 'https://beta.test'
const saved = (
  origin: string,
  name = 'Chat',
  accounts = [{ username: 'alice', identities: [] as object[] }]
) => ({ origin, id: origin, name, accounts })
const book = (...instances: ReturnType<typeof saved>[]) =>
  parseBook(JSON.stringify({ v: 1, instances }))

test('one account with a second discovered instance retains its original UI', () => {
  expect(
    resolveViewActor(book(saved(alpha), saved(beta, 'Beta', [])), alpha, 'alice', null)
  ).toBeNull()
})

test('duplicate account and instance names are qualified by the view owner', () => {
  const both = book(saved(alpha), saved(beta))
  expect(resolveViewActor(both, beta, 'alice', null)).toMatchObject({
    name: 'beta.test',
    row: { origin: beta, display: 'alice', local: null },
  })
  expect(resolveViewActor(both, beta, 'other', null)).toBeNull()
})

test('a saved identity counts as another actor and only peer views use its key and name', () => {
  const savedBook = book(
    saved(alpha, 'Alpha', [
      { username: 'alice', identities: [{ local: 'work', name: 'Work', ik: 'saved-key' }] },
    ])
  )
  expect(resolveViewActor(savedBook, alpha, 'alice', null)?.row.display).toBe('alice')
  expect(
    resolveViewActor(savedBook, alpha, 'alice', { local: 'work', name: null, ik: null })?.row
  ).toMatchObject({ username: 'alice', local: 'work', ik: 'saved-key', display: 'Work' })
  expect(
    resolveViewActor(savedBook, alpha, 'alice', { local: 'work', name: 'Updated', ik: 'new-key' })
      ?.row
  ).toMatchObject({ ik: 'new-key', display: 'Updated' })
})

test('a background notice uses the recipient account and identity despite a different viewed identity', () => {
  const receiver = testAccount('alice', beta)
  try {
    receiver.identities.setAccount('alice')
    const main = receiver.identities.get()!
    const work = receiver.identities.add('work')
    main.useP2p.setState({ name: 'Main' })
    work.useP2p.setState({ name: 'Office' })
    expect(receiver.identities.viewed()).toBe(main)
    const both = book(saved(alpha), saved(beta))
    const recipient = (key: string) => resolveNoticeActor(both, receiver, key)?.row
    expect(recipient('identity/work/p2p-call:42')).toMatchObject({
      origin: beta,
      username: 'alice',
      local: 'work',
      display: 'Office',
    })
    expect(recipient('p2p:room')).toMatchObject({ local: 'main', display: 'Main' })
    expect(recipient('dm:5')).toMatchObject({ local: null, display: 'alice' })
  } finally {
    receiver.store.dispose()
  }
})

test('a status toast retains its emitting identity even when another identity is viewed', () => {
  const account = testAccount('alice', beta)
  try {
    account.identities.setAccount('alice')
    const main = account.identities.get()!
    const work = account.identities.add('work')
    main.useP2p.setState({ name: 'Personal' })
    work.useP2p.setState({ name: 'Office' })
    expect(account.identities.viewed()).toBe(main)
    work.p2pHost.toast('Saved')
    work.useP2p.setState({ name: 'Renamed' })
    expect(account.store.getState().toast?.peer).toMatchObject({ local: 'work', name: 'Office' })
    main.p2pHost.toast('Saved')
    expect(account.store.getState().toast?.peer).toMatchObject({ local: 'main', name: 'Personal' })
    account.store.getState().showToast('Saved')
    expect(account.store.getState().toast?.peer).toBeUndefined()
  } finally {
    account.store.dispose()
  }
})
