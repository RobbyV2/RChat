import { describe, expect, test } from 'bun:test'
import { findTrigger } from '../autocomplete'
import {
  MENTION_QUERY,
  matchesPerson,
  recentAuthors,
  suggestKey,
  suggestPeople,
} from '../mention_suggest'
import { user } from './fixtures'

const names = (list: { username: string }[]) => list.map(u => u.username)

describe('mention autocomplete query', () => {
  const at = (text: string, caret = text.length) => findTrigger(text, caret, '@', 0, MENTION_QUERY)

  test('opens at a word start, empty query included', () => {
    expect(at('@')).toEqual({ start: 0, end: 1, query: '' })
    expect(at('hi @al')).toEqual({ start: 3, end: 6, query: 'al' })
    expect(at('(@bob.s')).toEqual({ start: 1, end: 7, query: 'bob.s' })
    expect(at('hi @al there', 6)).toEqual({ start: 3, end: 6, query: 'al' })
  })

  test('stays closed in mail addresses, after a space and in code', () => {
    expect(at('mail@bob')).toBeNull()
    expect(at('@bob ')).toBeNull()
    expect(at('`@bob')).toBeNull()
    expect(at('```\n@bob')).toBeNull()
  })
})

describe('suggestPeople', () => {
  const alice = user('alice', { display_name: 'Alice' })
  const bob = user('bob', { display_name: 'Alfie' })
  const carol = user('carol', { display_name: 'Carol' })
  const al = user('al', { display_name: 'Al' })

  test('prefix on username or display name, case-insensitive', () => {
    expect(matchesPerson(bob, 'AL')).toBe(true)
    expect(matchesPerson(bob, 'bo')).toBe(true)
    expect(matchesPerson(bob, 'lfie')).toBe(false)
  })

  test('groups keep their order, duplicates and skipped people drop out', () => {
    const got = suggestPeople('al', [[carol, bob], [alice, bob], [al]], n => n === 'al')
    expect(names(got)).toEqual(['bob', 'alice'])
    expect(names(suggestPeople('', [[carol], [alice]], () => false))).toEqual(['carol', 'alice'])
  })

  test('at most ten', () => {
    const many = Array.from({ length: 30 }, (_, i) => user(`u${i}`))
    expect(suggestPeople('u', [many], () => false)).toHaveLength(10)
    expect(suggestPeople('u', [many], () => false, 3)).toHaveLength(3)
  })

  test('recent authors are newest first and distinct', () => {
    const msgs = ['a', 'b', 'a', 'c', 'b'].map(n => ({ author: user(n) }))
    expect(names(recentAuthors(msgs))).toEqual(['b', 'c', 'a'])
    expect(names(recentAuthors(msgs, 2))).toEqual(['b', 'c'])
  })

  test('cache keys are per server and lowercase query', () => {
    expect(suggestKey('s', 'AL')).toBe(suggestKey('s', 'al'))
    expect(suggestKey('s', 'al') === suggestKey('t', 'al')).toBe(false)
  })
})
