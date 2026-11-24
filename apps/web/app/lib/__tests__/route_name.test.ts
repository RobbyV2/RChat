import { expect, test } from 'bun:test'
import { dmBlocks } from '../client/dm_blocks'
import { routeName } from '../client/route_name'
import { switcherRows } from '../client/switcher_rows'
import type { BookAccount } from '../client/book'

test('route names by actor then host recency, including ports and Unicode', () => {
  const a = { account: 'a', host: 'Alpha.Test', lastShown: 1 }
  const b = { account: 'b', host: 'beta.test:3653', lastShown: 2 }
  const c = { ...b, account: 'c', lastShown: 4 }
  const candidates = [a, b, c]
  expect(routeName('Éloïse', 'a', candidates)).toEqual({ account: 'a', name: 'éloïse' })
  for (const name of ['李 明', 'é'.repeat(100), '𠀀'.repeat(100)])
    expect(routeName(name + '@alpha.test', 'b', candidates)).toEqual({ account: 'a', name })
  for (const name of ['é'.repeat(101), '李\n明'])
    expect(routeName(name, 'a', candidates).error).toBe('Enter a username or username@host')
  expect(routeName('bob@BETA.test:3653', 'b', candidates)).toEqual({ account: 'b', name: 'bob' })
  expect(routeName('carol@beta.test:3653', 'a', candidates)).toEqual({
    account: 'c',
    name: 'carol',
  })
  expect(routeName('bob@beta.test', 'a', candidates)).toEqual({
    error: "You're not signed in on beta.test.",
    host: 'beta.test',
  })
  expect(routeName('bob@wrong/host', 'a', candidates).error).toBe(
    'Enter a username or username@host'
  )
  expect(routeName('x@y@alpha.test', 'a', candidates).error).toBe(
    'Enter a username or username@host'
  )
})

test('DM blocks retain both accounts and their peer identities, omitting guests and signed-out accounts', () => {
  const origin = 'https://a.test'
  const make = (username: string): BookAccount => ({
    username,
    display: null,
    avatar: null,
    added: 1,
    connect: true,
    identities: [{ local: 'main', name: 'Main', ik: null, background: true, added: 1 }],
  })
  const groups = switcherRows(
    {
      v: 1,
      instances: [
        { origin, id: 'a', name: 'A', guest: true, accounts: ['sam', 'work', 'old'].map(make) },
      ],
    },
    ['sam', 'work'].map(username => ({
      origin,
      username,
      local: null,
      status: 'Online' as const,
      badge: 0,
      unread: false,
      ik: null,
    })),
    null
  ).groups
  const blocks = dmBlocks(groups, undefined, r => r.username ?? undefined)
  expect(blocks[0].owners.map(r => r.owner)).toEqual(['sam', 'work'])
  expect(blocks[0].peers.map(r => [r.username, r.local])).toEqual([
    ['sam', 'main'],
    ['work', 'main'],
  ])
  expect(dmBlocks(groups, 'https://b.test', r => r.username ?? undefined)).toEqual([])
})
