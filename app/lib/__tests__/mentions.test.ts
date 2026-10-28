import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  maskCode,
  mentionCandidates,
  mentionLookups,
  mentionsUser,
  splitKnownMentions,
  splitMentions,
} from '../mentions'

describe('mentionsUser', () => {
  test('matches on token boundaries only', () => {
    expect(mentionsUser('hey @bob', 'bob')).toBe(true)
    expect(mentionsUser('@bob, look', 'bob')).toBe(true)
    expect(mentionsUser('(@bob)', 'bob')).toBe(true)
    expect(mentionsUser("@bob's turn", 'bob')).toBe(true)
    expect(mentionsUser('hey @bobby', 'bob')).toBe(false)
    expect(mentionsUser('mail@bob', 'bob')).toBe(false)
    expect(mentionsUser('@bob_x', 'bob')).toBe(false)
    expect(mentionsUser('bob', 'bob')).toBe(false)
  })

  test('is case-insensitive and handles unicode and regex characters', () => {
    expect(mentionsUser('hi @BOB', 'bob')).toBe(true)
    expect(mentionsUser('hi @zoë!', 'zoë')).toBe(true)
    expect(mentionsUser('hi @zoëe', 'zoë')).toBe(false)
    expect(mentionsUser('ping @a.b', 'a.b')).toBe(true)
    expect(mentionsUser('ping @axb', 'a.b')).toBe(false)
    expect(mentionsUser('ping @john smith now', 'john smith')).toBe(true)
    expect(mentionsUser('anything', '')).toBe(false)
  })
})

describe('splitMentions', () => {
  test('splits text around each mention', () => {
    expect(splitMentions('@bob hi @bobby and @Bob.', 'bob')).toEqual([
      { text: '@bob', mention: true },
      { text: ' hi @bobby and ', mention: false },
      { text: '@Bob', mention: true },
      { text: '.', mention: false },
    ])
  })

  test('no mention keeps the text whole', () => {
    expect(splitMentions('plain', 'bob')).toEqual([{ text: 'plain', mention: false }])
    expect(splitMentions('', 'bob')).toEqual([{ text: '', mention: false }])
  })
})

describe('mention edges', () => {
  test('adjacent, repeated and line-start mentions', () => {
    expect(mentionsUser('@@bob', 'bob')).toBe(true)
    expect(mentionsUser('x@bob@bob', 'bob')).toBe(false)
    expect(mentionsUser('hi\n@bob', 'bob')).toBe(true)
    expect(mentionsUser('😀@bob', 'bob')).toBe(true)
    expect(splitMentions('@bob @bob', 'bob')).toEqual([
      { text: '@bob', mention: true },
      { text: ' ', mention: false },
      { text: '@bob', mention: true },
    ])
    expect(splitMentions('a@bob @bob', 'bob')).toEqual([
      { text: 'a@bob ', mention: false },
      { text: '@bob', mention: true },
    ])
  })
})

describe('regex support', () => {
  test('no source uses lookbehind, which Safari before 16.4 cannot parse', () => {
    const root = fileURLToPath(new URL('../..', import.meta.url))
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(path)
        } else if (/\.(ts|tsx)$/.test(entry.name)) files.push(path)
      }
    }
    walk(root)
    expect(files.length > 20).toBe(true)
    const offenders = files.filter(f => /\(\?<[=!]/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})

describe('server-side mention rules', () => {
  test('code never mentions', () => {
    expect(mentionsUser('see `@bob`', 'bob')).toBe(false)
    expect(mentionsUser('```\n@bob\n```', 'bob')).toBe(false)
    expect(mentionsUser('`@bob` and @bob', 'bob')).toBe(true)
    expect(mentionsUser('`open @bob', 'bob')).toBe(true)
  })

  test('maskCode keeps positions', () => {
    expect(maskCode('a `b` c')).toBe('a     c')
    expect(maskCode('a ``b`` `c')).toBe('a       `c')
    expect(maskCode('x\n```\n@y\n```\nz')).toBe('x\n   \n  \n   \nz')
    expect(maskCode('~~~\n@y')).toBe('   \n  ')
  })

  test('candidates match src/api/pings.rs', () => {
    expect(mentionCandidates('hey @bob')).toEqual(['bob'])
    expect(mentionCandidates('@BOB, look')).toEqual(['bob', 'bob,', 'bob, look'])
    expect(mentionCandidates('(@bob)')).toEqual(['bob', 'bob)'])
    expect(mentionCandidates('mail@bob')).toEqual([])
    expect(mentionCandidates('@bob_x')).toEqual(['bob_x'])
    expect(mentionCandidates('@zoë!')).toEqual(['zoë', 'zoë!'])
    expect(mentionCandidates('@@bob')).toEqual(['bob'])
    expect(mentionCandidates('x@bob @bob')).toEqual(['bob'])
    expect(mentionCandidates('@a.b c')).toEqual(['a', 'a.b', 'a.b c'])
    expect(mentionCandidates('hi\n@bob\nnext')).toEqual(['bob'])
    expect(mentionCandidates('`@bob` and\n```\n@carol\n```')).toEqual([])
    expect(mentionCandidates('`@bob` and ```\n@carol')).toEqual(['carol'])
    expect(mentionCandidates(`@${'a'.repeat(150)}`)).toEqual([])
    const many = Array.from({ length: 1000 }, (_, i) => `@u${i} `).join('')
    expect(mentionCandidates(many)).toHaveLength(400)
    expect(mentionCandidates(many, 20)).toHaveLength(20)
  })

  test('splitKnownMentions picks the longest known name at each @', () => {
    const known = new Set(['bob', 'bob.smith', 'john smith'])
    const look = (n: string) => (known.has(n) ? n : undefined)
    expect(splitKnownMentions('hi @Bob.Smith, @bob and @john smith!', look)).toEqual([
      { text: 'hi ', user: null },
      { text: '@Bob.Smith', user: 'bob.smith' },
      { text: ', ', user: null },
      { text: '@bob', user: 'bob' },
      { text: ' and ', user: null },
      { text: '@john smith', user: 'john smith' },
      { text: '!', user: null },
    ])
    expect(splitKnownMentions('@nobody', look)).toEqual([{ text: '@nobody', user: null }])
    expect(splitKnownMentions('', look)).toEqual([{ text: '', user: null }])
    expect(splitKnownMentions('mail@bob', look)).toEqual([{ text: 'mail@bob', user: null }])
  })

  test('every @ in ordinary prose can render a pill', () => {
    const text =
      '@bob, @dave, can you and the team look at it? I think it is related to the thing @carol did'
    const all = mentionCandidates(text)
    expect(all.length > 20).toBe(true)
    expect(all).toContain('carol')
    const known = new Set(['bob', 'dave', 'carol'])
    const pills = splitKnownMentions(text, n => (known.has(n) ? n : undefined))
      .filter(p => p.user !== null)
      .map(p => p.text)
    expect(pills).toEqual(['@bob', '@dave', '@carol'])
    const lookups = mentionLookups(text)
    expect(lookups).toEqual(['bob', 'bob,', 'dave', 'dave,', 'dave, can', 'carol', 'carol did'])
  })

  test('mentionLookups caps names per @ and the number of @s', () => {
    const many = Array.from({ length: 30 }, (_, i) => `@u${i} x y z`).join(' ')
    const names = mentionLookups(many)
    expect(names.filter(n => n.startsWith('u0'))).toEqual(['u0', 'u0 x', 'u0 x y'])
    expect(new Set(names.map(n => n.split(' ')[0])).size).toBe(20)
    expect(names).toHaveLength(60)
    expect(mentionLookups('`@code` @bob')).toEqual(['bob'])
  })
})
