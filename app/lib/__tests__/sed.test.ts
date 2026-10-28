import { describe, expect, test } from 'bun:test'
import { applySed, lastEditable, parseSed } from '../sed'
import { msg, user } from './fixtures'

describe('parseSed', () => {
  test('the three Discord forms', () => {
    expect(parseSed('s/teh/the')).toEqual({ find: 'teh', replace: 'the', global: false })
    expect(parseSed('s/teh/the/')).toEqual({ find: 'teh', replace: 'the', global: false })
    expect(parseSed('s/teh/the/g')).toEqual({ find: 'teh', replace: 'the', global: true })
  })

  test('surrounding whitespace is ignored, inner spaces are kept', () => {
    expect(parseSed('  s/a b/c d \n')).toEqual({ find: 'a b', replace: 'c d', global: false })
  })

  test('an empty replacement deletes', () => {
    expect(parseSed('s/very //')).toEqual({ find: 'very ', replace: '', global: false })
    expect(parseSed('s/x/')).toEqual({ find: 'x', replace: '', global: false })
  })

  test('escaped slashes are literal', () => {
    expect(parseSed('s/a\\/b/c\\/d/g')).toEqual({ find: 'a/b', replace: 'c/d', global: true })
    expect(parseSed('s/http:\\/\\/x/https:\\/\\/x')).toEqual({
      find: 'http://x',
      replace: 'https://x',
      global: false,
    })
    expect(parseSed('s/\\d/digit')).toEqual({ find: '\\d', replace: 'digit', global: false })
  })

  test('anything else is a normal message', () => {
    for (const text of [
      '',
      's/',
      's/old',
      's//new',
      's/a/b/x',
      's/a/b/gg',
      's/a/b/g/',
      's/a/b/c/d',
      'S/a/b',
      'xs/a/b',
      's /a/b',
      's/a/b\nmore',
      'see s/a/b',
    ])
      expect(parseSed(text)).toBeNull()
  })
})

describe('applySed', () => {
  const sed = (text: string) => parseSed(text)!

  test('replaces the first literal occurrence', () => {
    expect(applySed('teh cat and teh dog', sed('s/teh/the'))).toBe('the cat and teh dog')
  })

  test('g replaces every occurrence', () => {
    expect(applySed('teh cat and teh dog', sed('s/teh/the/g'))).toBe('the cat and the dog')
  })

  test('patterns are not regular expressions', () => {
    expect(applySed('a.c abc', sed('s/a.c/x/g'))).toBe('x abc')
    expect(applySed('cost $5', sed('s/$5/$6'))).toBe('cost $6')
    expect(applySed('(x)', sed('s/(x)/[$&]'))).toBe('[$&]')
  })

  test('matching is case sensitive and null without a match', () => {
    expect(applySed('Hello', sed('s/hello/bye'))).toBeNull()
    expect(applySed('', sed('s/a/b'))).toBeNull()
  })

  test('works across lines and with emoji', () => {
    expect(applySed('one\ntwo 👍', sed('s/👍/🎉'))).toBe('one\ntwo 🎉')
  })
})

describe('lastEditable', () => {
  const mine = user('bob')
  test('the newest own user message, skipping others and call logs', () => {
    const list = [
      msg(1, { author: mine }),
      msg(2, { author: mine }),
      msg(3),
      msg(4, { author: mine, kind: 'call' }),
    ]
    expect(lastEditable(list, 'bob')?.id).toBe(2)
    expect(lastEditable(list, 'carol')).toBeNull()
    expect(lastEditable(list, undefined)).toBeNull()
  })

  test('falls back to the thread root', () => {
    expect(lastEditable([msg(5)], 'bob', msg(1, { author: mine }))?.id).toBe(1)
    expect(lastEditable([], 'bob', msg(1))).toBeNull()
  })
})
