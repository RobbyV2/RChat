import { expect, test } from 'bun:test'
import {
  addAccount,
  addIdentity,
  addInstance,
  migrateBook,
  moveAccount,
  moveInstance,
  parseBook,
  removeAccount,
  removeIdentity,
  removeInstance,
} from '../client/book'

const alpha = 'https://alpha.example'
const beta = 'https://beta.example'
const alice = {
  username: 'alice',
  display: null,
  avatar: null,
  connect: true,
  added: 1,
  identities: [],
}
test('book operations preserve order, boundaries and their inputs', () => {
  const empty = parseBook(null)
  const a = addInstance(empty, { origin: alpha, id: 'a', name: 'Alpha' })
  expect(addInstance(a, { origin: beta, id: 'a', name: 'Other' })).toEqual(a)
  const b = addInstance(a, { origin: beta, id: 'b', name: 'Beta' })
  const users = addAccount(
    addAccount(b, alpha, alice, alpha),
    alpha,
    { ...alice, username: 'bob' },
    alpha
  )
  expect(users.instances[0].accounts.map(x => x.primary)).toEqual([true, undefined])
  const moved = moveAccount(users, alpha, 'bob', 0)
  expect(moved.instances[0].accounts[0].username).toBe('bob')
  const withPeer = addIdentity(moved, alpha, 'bob', {
    local: 'main',
    name: 'Main',
    ik: null,
    added: 1,
    background: true,
  })
  expect(removeIdentity(withPeer, alpha, 'bob', 'main')).toEqual(moved)
  expect(removeAccount(moved, alpha, 'bob').instances[0].accounts).toHaveLength(1)
  expect(moveInstance(b, beta, 0).instances[0].origin).toBe(beta)
  expect(removeInstance(b, beta)).toEqual(a)
  expect(empty.instances).toEqual([])
})
test('invalid persisted data and unverified legacy tokens cannot introduce accounts', () => {
  for (const raw of ['[', '{"v":2}', '{"v":1,"instances":[null,{}]}'])
    expect(parseBook(raw).instances).toEqual([])
  const data: Record<string, string> = {
    rchat_instances: JSON.stringify({
      [alpha]: { id: 'a', name: 'Alpha' },
      [beta]: { id: 'b', name: 'Beta' },
    }),
    rchat_token: 'private',
    'rchat_p2p:alice': '{"v":1,"on":true}',
    'rchat_guest@beta.example': '1',
  }
  const migrated = migrateBook(Object.keys(data), k => data[k] ?? null, alpha)
  expect(migrated.instances.flatMap(i => i.accounts)).toEqual([])
  expect(migrated.instances.find(i => i.origin === beta)?.guest).toBe(true)
  expect(JSON.stringify(migrated)).not.toContain('private')
})

test('limits are global for accounts and per-account for identities', () => {
  let book = addInstance(addInstance(parseBook(null), { origin: alpha, id: 'a', name: 'A' }), {
    origin: beta,
    id: 'b',
    name: 'B',
  })
  for (let j = 0; j < 52; j++)
    book = addAccount(book, j % 2 ? alpha : beta, { ...alice, username: 'a' + j }, alpha)
  for (let j = 0; j < 10; j++)
    book = addIdentity(book, beta, 'a0', {
      local: 'p' + j,
      ik: null,
      name: 'Peer',
      background: true,
      added: j,
    })
  expect(book.instances.flatMap(i => i.accounts)).toHaveLength(50)
  expect(book.instances[1].accounts[0].identities).toHaveLength(8)
  expect(parseBook(JSON.stringify(book))).toEqual(book)
})

test('guest flags survive even when discovery history has been evicted', () => {
  const data: Record<string, string> = {
    rchat_home: beta,
    rchat_guest: '1',
    'rchat_guest@beta.example': '1',
  }
  const book = migrateBook(Object.keys(data), k => data[k] ?? null, alpha)
  expect(book.instances.map(i => [i.origin, i.guest])).toEqual([
    [alpha, true],
    [beta, true],
  ])
})
