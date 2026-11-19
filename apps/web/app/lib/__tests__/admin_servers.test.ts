import { expect, test } from 'bun:test'
import {
  CREATORS_MAX,
  DEFAULT_SERVERS_MAX,
  addCreator,
  addDefaultServer,
  addTypedServer,
  createServerError,
  isBuiltin,
  listOf,
  moveEntry,
  p2pAll,
  removeEntry,
} from '../admin_servers'

test('a stored list reads as its entries', () => {
  expect(listOf('')).toEqual([])
  expect(listOf('none')).toEqual([])
  expect(listOf('rchat')).toEqual(['rchat'])
  expect(listOf('rchat, lobby,,')).toEqual(['rchat', 'lobby'])
  expect(listOf(undefined)).toEqual([])
})

test('a default server is added at the end, once, by its key', () => {
  expect(addDefaultServer(['rchat'], 'Lobby')).toEqual({ list: ['rchat', 'lobby'], error: null })
  expect(addDefaultServer(['rchat'], ' RCHAT ')).toEqual({
    list: ['rchat'],
    error: 'That server is already on the list.',
  })
  expect(addDefaultServer([], '  ').error).toBe('Choose a server.')
  expect(addDefaultServer([], 'a,b').error).toBe("A server name can't have a comma.")
})

test('a typed server is added only when a server has that name', async () => {
  const asked: string[] = []
  const exists = async (key: string) => {
    asked.push(key)
    return key === 'lounge'
  }
  const list = () => ['rchat']
  expect(await addTypedServer(list, ' Lounge ', exists)).toEqual({
    list: ['rchat', 'lounge'],
    error: null,
  })
  expect(await addTypedServer(list, 'nope-server', exists)).toEqual({
    list: ['rchat'],
    error: 'No server with that name.',
  })
  expect(await addTypedServer(list, 'rchat', exists)).toEqual({
    list: ['rchat'],
    error: 'That server is already on the list.',
  })
  expect(asked).toEqual(['lounge', 'nope-server'])
  let now = ['rchat']
  const late = addTypedServer(() => now, 'lounge', exists)
  now = ['rchat', 'lobby']
  expect((await late).list).toEqual(['rchat', 'lobby', 'lounge'])
})

test('the default list holds ten servers', () => {
  const ten = Array.from({ length: DEFAULT_SERVERS_MAX }, (_, i) => `s${i}`)
  expect(DEFAULT_SERVERS_MAX).toBe(10)
  expect(addDefaultServer(ten.slice(1), 'last').list).toHaveLength(10)
  expect(addDefaultServer(ten, 'more')).toEqual({
    list: ten,
    error: 'The list holds up to 10 servers.',
  })
})

test('entries move up and down and stop at the ends', () => {
  const list = ['a', 'b', 'c']
  expect(moveEntry(list, 0, 1)).toEqual(['b', 'a', 'c'])
  expect(moveEntry(list, 2, -1)).toEqual(['a', 'c', 'b'])
  expect(moveEntry(list, 0, -1)).toEqual(list)
  expect(moveEntry(list, 2, 1)).toEqual(list)
  expect(moveEntry(list, 5, 1)).toEqual(list)
  expect(list).toEqual(['a', 'b', 'c'])
  expect(removeEntry(list, 1)).toEqual(['a', 'c'])
  expect(removeEntry(list, 9)).toEqual(list)
})

test('a creator is a username or a server and one of its roles', () => {
  expect(addCreator([], ' alice ')).toEqual({ list: ['alice'], error: null })
  expect(addCreator(['alice'], '@bob').list).toEqual(['alice', 'bob'])
  expect(addCreator(['alice'], 'lobby:Staff').list).toEqual(['alice', 'lobby:Staff'])
  expect(addCreator(['alice'], 'alice').error).toBe('That entry is already on the list.')
  expect(addCreator([], '').error).toBe('Type a username or server:role.')
  expect(addCreator([], 'a,b').error).toBe("An entry can't have a comma.")
  expect(addCreator([], 'lobby:').error).toBe('Write a role as server:role.')
  expect(addCreator([], ':Staff').error).toBe('Write a role as server:role.')
  const full = Array.from({ length: CREATORS_MAX }, (_, i) => `u${i}`)
  expect(CREATORS_MAX).toBe(500)
  expect(addCreator(full, 'more').error).toBe('The list holds up to 500 entries.')
})

test('a server made for someone needs a name, an owner and a long enough password', () => {
  const form = { name: 'Pixel Club', owner: 'dana', password: '' }
  expect(createServerError(form)).toBeNull()
  expect(createServerError({ ...form, name: '  ' })).toBe('Type a server name.')
  expect(createServerError({ ...form, name: 'x'.repeat(101) })).toBe(
    'A server name has up to 100 characters.'
  )
  expect(createServerError({ ...form, owner: ' ' })).toBe("Type the owner's username.")
  expect(createServerError({ ...form, password: 'short' })).toBe(
    'A password has 8 characters or more.'
  )
  expect(createServerError({ ...form, password: 'long enough' })).toBeNull()
})

test('the built-in server is the one named rchat until it is removed', () => {
  expect(isBuiltin('rchat', {})).toBe(true)
  expect(isBuiltin('rchat', { builtin_server: 'kept' })).toBe(true)
  expect(isBuiltin('rchat', { builtin_server: 'removed' })).toBe(false)
  expect(isBuiltin('lobby', {})).toBe(false)
})

test('all of P2P turns off while any of it is on, and on once all of it is off', () => {
  const s = { p2p: true, p2p_attachments: true, p2p_backup: true }
  expect(p2pAll(s)).toEqual({
    label: 'Turn off all P2P',
    patch: { p2p: false, p2p_attachments: false, p2p_backup: false },
  })
  expect(p2pAll({ ...s, p2p: false }).label).toBe('Turn off all P2P')
  expect(p2pAll({ p2p: false, p2p_attachments: false, p2p_backup: false })).toEqual({
    label: 'Turn on all P2P',
    patch: { p2p: true, p2p_attachments: true, p2p_backup: true },
  })
})
