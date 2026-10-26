import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mentionsUser, splitMentions } from '../mentions'

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
