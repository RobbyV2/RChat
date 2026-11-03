import { describe, expect, test } from 'bun:test'
import { andMore, fewOf, matching, nextPage, page, pageGroups, PAGE } from '../paging'
import { allowListTitle, emptyAllowText, restrictionItems } from '../channel_access'

const range = (n: number, p = 'm') => Array.from({ length: n }, (_, i) => `${p}${i}`)

describe('paging long lists', () => {
  test('50 at a time', () => {
    expect(PAGE).toBe(50)
    const l = range(120)
    expect(page(l, PAGE)).toEqual({ items: l.slice(0, 50), more: true })
    expect(page(l, nextPage(100, l.length)).more).toBe(false)
    expect(nextPage(50, 120)).toBe(100)
    expect(nextPage(100, 120)).toBe(120)
    expect(page([], PAGE)).toEqual({ items: [], more: false })
  })

  test('groups share one page; each keeps its full count', () => {
    const g = [
      { key: 'mod', list: range(3, 'a') },
      { key: 'online', list: range(40, 'b') },
      { key: 'offline', list: range(30, 'c') },
    ]
    const one = pageGroups(g, PAGE)
    expect(one.groups.map(x => [x.key, x.list.length, x.total])).toEqual([
      ['mod', 3, 3],
      ['online', 40, 40],
      ['offline', 7, 30],
    ])
    expect(one.more).toBe(true)
    const two = pageGroups(g, 100)
    expect(two.groups.map(x => x.list.length)).toEqual([3, 40, 30])
    expect(two.more).toBe(false)
    // A group nothing of which is shown yet is left out.
    expect(pageGroups(g, 2).groups.map(x => x.key)).toEqual(['mod'])
  })

  test('a few names inline, and how many more', () => {
    expect(fewOf(['a', 'b'])).toEqual({ first: ['a', 'b'], more: 0 })
    expect(fewOf(range(57))).toEqual({ first: ['m0', 'm1', 'm2'], more: 54 })
    expect(andMore(54)).toBe('and 54 more')
  })

  test('a search over names', () => {
    const l = [{ n: 'Alice' }, { n: 'bob' }, { n: 'Carol' }]
    expect(matching(l, ' AL ', x => x.n).map(x => x.n)).toEqual(['Alice'])
    expect(matching(l, 'o', x => x.n).map(x => x.n)).toEqual(['bob', 'Carol'])
    expect(matching(l, '', x => x.n)).toEqual(l)
  })
})

describe('channel restrictions, as the instance and P2P settings say them', () => {
  test('the instance texts', () => {
    expect(restrictionItems('admins').map(r => [r.key, r.label, r.detail])).toEqual([
      [
        'restrict_view',
        'Require roles to view',
        'Only the roles and members below can see this channel. Leave empty for admins only.',
      ],
      [
        'restrict_send',
        'Require roles to send',
        'Only the roles and members below can send. Leave empty for admins only.',
      ],
    ])
    expect(emptyAllowText(true, true, 'admins')).toBe(
      'Nobody added. Only admins can see this channel.'
    )
    expect(emptyAllowText(false, true, 'admins')).toBe('Nobody added. Only admins can send.')
    expect(emptyAllowText(false, false, 'admins')).toBe(
      'No overrides. The channel is open to everyone.'
    )
    expect([allowListTitle(true), allowListTitle(false)]).toEqual([
      'Allowed roles and members',
      'Role and member overrides',
    ])
  })
})
