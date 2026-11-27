import { expect, test } from 'bun:test'
import { addAccount, addIdentity, parseBook, addInstance } from '../client/book'
import { client } from '../client/client'
import { accountStorage } from '../client/keys'
import { testAccount } from './test_account'
import { me, memoryStorage } from './fixtures'
import { plain } from './helpers/secret'

test('the last slot is checked at commit and signed-out rows retain their identities', async () => {
  const conn = testAccount('new-user', 'https://account-limit.example')
  const origin = conn.conn.origin
  const savedBook = client.book.getState()
  const oldRaw = memoryStorage.getItem('rchat_book')
  const keys = accountStorage(conn.conn)
  const input = { display: null, avatar: null, added: 0, identities: [], connect: true }
  let book = addInstance(parseBook(null), { origin, id: origin, name: 'Fixture' })
  for (let index = 0; index < 49; index++)
    book = addAccount(book, origin, { ...input, username: 'a' + index }, origin)
  const identity = { local: 'work', name: 'Work', ik: null, background: false, added: 15 }
  book = addIdentity(book, origin, 'a0', identity)
  const install = () => {
    memoryStorage.setItem('rchat_book', JSON.stringify(book))
    client.book.setState(book, true)
  }
  let starts = 0
  conn.conn.ws.start = () => {
    starts++
  }
  const sent = Promise.withResolvers<void>()
  const reply = Promise.withResolvers<Response>()
  conn.api.send = () => {
    sent.resolve()
    return reply.promise
  }
  conn.api.logout = async () => ({ ok: true })
  try {
    install()
    conn.store.setState({ me: null })
    const pending = conn.store.getState().login({ username: 'new-user', password: 'fixture' })
    await sent.promise
    book = addAccount(book, origin, { ...input, username: 'last' }, origin)
    install()
    reply.resolve(Response.json({ token: 'overflow-test', user: me('new-user') }))
    await pending
    expect(conn.store.getState().error).toContain('50')
    expect(conn.store.getState().token).toBeNull()
    expect(memoryStorage.getItem(keys.token('new-user'))).toBeNull()
    expect(starts).toBe(0)
    conn.api.send = async () => Response.json({ token: 'existing-test', user: me('a0') })
    await conn.store.getState().login({ username: 'a0', password: 'fixture' })
    expect(plain(conn.store.getState().token)).toBe('existing-test')
    conn.store.getState().logout()
    const retained = parseBook(memoryStorage.getItem('rchat_book')).instances[0].accounts[0]
    expect(retained.primary).toBe(true)
    expect(retained.identities).toEqual([identity])
    expect(memoryStorage.getItem(keys.token('a0'))).toBeNull()
  } finally {
    client.book.setState(savedBook, true)
    if (oldRaw === null) memoryStorage.removeItem('rchat_book')
    else memoryStorage.setItem('rchat_book', oldRaw)
  }
})
