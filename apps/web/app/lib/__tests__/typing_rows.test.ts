import { describe, expect, test } from 'bun:test'
import { p2pRowTypers, rowTypers, type RowTypingSource } from '../typing_rows'

const source = (over: Partial<RowTypingSource> = {}): RowTypingSource => ({
  typingOn: true,
  typing: {
    c1: { bob: { name: 'Bob', until: 9 }, eve: { name: 'Eve', until: 9 } },
    c2: { bob: { name: 'Bob', until: 9 }, carol: { name: 'Carol', until: 9 } },
    d7: { dave: { name: 'Dave', until: 9 } },
  },
  blocked: { eve: true },
  ...over,
})

describe('who a row shows as typing', () => {
  test('everyone in the scopes once, but blocked people', () => {
    expect(rowTypers(source(), ['c1'], null).names).toEqual(['Bob'])
    expect(rowTypers(source(), ['c1', 'c2'], null).names).toEqual(['Bob', 'Carol'])
    expect(rowTypers(source(), ['d7'], null).names).toEqual(['Dave'])
    expect(rowTypers(source(), ['c9'], null)).toEqual({ names: [], ask: [] })
  })

  test('nobody while typing indicators are off', () => {
    expect(rowTypers(source({ typingOn: false }), ['c1', 'c2'], null).names).toEqual([])
  })

  test('in a server, members whose look is not loaded are asked for', () => {
    const got = rowTypers(source({ members: {}, memberInfo: {} }), ['c2'], 'club')
    expect(got.ask).toEqual(['bob', 'carol'])
  })

  test('a P2P channel leaves out blocked contacts and names the rest', () => {
    const names: Record<string, string> = { a: 'Ann', b: 'Ben' }
    expect(p2pRowTypers(['a', 'b'], new Set(['b']), ik => names[ik])).toEqual(['Ann'])
    expect(p2pRowTypers(['b'], new Set(['b']), ik => names[ik])).toEqual([])
  })
})
