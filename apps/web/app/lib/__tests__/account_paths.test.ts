import { expect, test } from 'bun:test'
import {
  accountPath,
  adminPath,
  messagePath,
  parseAccountPath,
  parsePath,
  serverPath,
  viewPath,
  type PathTarget,
  type RouteOwner,
} from '../view'

const account = { username: 'alice.2-work', host: 'alpha.test:3653' }
const guest = { username: null, host: '[::1]:3000' }
const channel = { kind: 'channel', server: 'café & co', channelId: 3 } as const
const dm = { kind: 'dm', dmId: 5 } as const

test('every local target round-trips for a primary account, a named account and a guest', () => {
  const paths: ReadonlyArray<readonly [PathTarget | null, (owner: RouteOwner | null) => string]> = [
    [null, owner => viewPath(null, owner)],
    [{ kind: 'server', server: channel.server }, owner => serverPath(channel.server, owner)],
    [channel, owner => viewPath(channel, owner)],
    [dm, owner => viewPath(dm, owner)],
    ...(
      [
        [channel, null],
        [channel, 7],
        [dm, null],
      ] as const
    ).map(([place, thread]) => {
      const target = { kind: 'message', place, thread, id: 9 } as const
      return [target, (owner: RouteOwner | null) => messagePath(target, owner)] as const
    }),
    [{ kind: 'admin', section: null, item: null }, owner => adminPath(null, null, owner)],
    [
      { kind: 'admin', section: 'features', item: null },
      owner => adminPath('features', null, owner),
    ],
    [
      { kind: 'admin', section: 'users', item: 'café/a' },
      owner => adminPath('users', 'café/a', owner),
    ],
    [
      { kind: 'admin', section: 'servers', item: 'club' },
      owner => adminPath('servers', 'club', owner),
    ],
  ]
  for (const [owner, prefix] of [
    [null, ''],
    [account, '/@alice.2-work@alpha.test:3653'],
    [guest, '/@[::1]:3000'],
  ] as const) {
    for (const [target, make] of paths) {
      const plain = make(null)
      const path = make(owner)
      expect(path).toBe(prefix + plain)
      expect(parseAccountPath(path)).toEqual({ owner, path: plain })
      expect(parsePath(path)).toEqual(target)
    }
  }
})

test('account paths round-trip names containing Unicode, spaces and URL delimiters', () => {
  for (const username of ['a.b-c', 'étoile', 'a b', 'a/b?c#d', 'a%2Fb', 'a\\b', '100%']) {
    const owner = { username: username.toLowerCase(), host: '[::1]:3000' }
    const path = viewPath(dm, owner)
    expect(new URL(path, 'https://host.test').pathname).toBe(path)
    expect(parseAccountPath(path)).toEqual({ owner, path: '/dm/5/' })
  }
  expect(parseAccountPath('/@ALICE.2-WORK@ALPHA.TEST:3653')).toEqual({ owner: account, path: '/' })
})

test('queries and fragments survive qualifying, stripping and changing the local account', () => {
  for (const path of [
    '/i/join/?from=%2Fdm%2F1#@old',
    '/config/share/#key',
    '/dm/5/?q=@work#t',
    '/?x#y',
  ]) {
    const named = accountPath(path, account)
    expect(parseAccountPath(named)).toEqual({ owner: account, path })
    expect(accountPath(named, guest)).toBe('/@[::1]:3000' + path)
    expect(accountPath(named, null)).toBe(path)
  }
  expect(parseAccountPath('/@alpha.test?x#y')).toEqual({
    owner: { username: null, host: 'alpha.test' },
    path: '/?x#y',
  })
  expect(parsePath('/@a@alpha.test/dm/5?q=1#foo')).toEqual(dm)
  expect(messagePath({ place: dm, thread: null, id: 9 })).toBe('/dm/5/9/')
})

test('malformed prefixes and nonlocal URLs cannot become primary-account routes', () => {
  for (const href of [
    '',
    'dm/5/',
    '//other.test/s/club/',
    'https://other.test/dm/5/',
    '/@/',
    '/@@host/',
    '/@user@/',
    '/@user@host@other/',
    '/@%40user@host/',
    '/@%00@host/',
    '/@%FE@host/',
    '/@host:123456/',
    '/@host:/',
    '/@[::1/',
    '/@foo\\bar/',
    '/@foo%2fbar/',
    '/@alpha.test//evil.test/',
    '/@a@alpha.test/@b@beta.test/dm/5/',
  ]) {
    expect(parseAccountPath(href)).toBeNull()
    expect(parsePath(href)).toBeNull()
    expect(() => accountPath(href, account)).toThrow()
  }
  for (const owner of [
    { username: '', host: 'host' },
    { username: 'x@y', host: 'host' },
    { username: null, host: 'https://host' },
  ])
    expect(() => viewPath(null, owner)).toThrow()
})
