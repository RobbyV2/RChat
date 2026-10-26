import { describe, expect, test } from 'bun:test'
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
