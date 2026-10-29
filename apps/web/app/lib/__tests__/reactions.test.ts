import { describe, expect, test } from 'bun:test'
import {
  applyReaction,
  canAddEmoji,
  reacted,
  reactionsFull,
  reactorKey,
  readOnly,
  sameEmoji,
  emojiBase,
  emojiCode,
  reactionLabel,
  reactorsText,
  withReaction,
} from '../reactions'
import { EMPTY_PREFS, noteUse, type Emoji } from '../emoji'
import type { Reaction } from '../types'
import { msg, serverDetail } from './fixtures'

const r = (emoji: string, count: number, me = false, first_at = 1): Reaction => ({
  emoji,
  count,
  me,
  first_at,
})
const shape = (list: Reaction[]) => list.map(x => `${x.emoji}${x.count}${x.me ? '*' : ''}`)

describe('reaction reducer', () => {
  test('adds new emojis at the end and counts others', () => {
    let list = applyReaction(undefined, '😭', true, false, 5)
    list = applyReaction(list, '✅', true, true, 6)
    list = applyReaction(list, '😭', true, true, 7)
    list = applyReaction(list, '💀', true, false, 8)
    expect(shape(list)).toEqual(['😭2*', '✅1*', '💀1'])
    expect(list[0].first_at).toBe(5)
  })

  test('removes and drops an emoji at zero, keeping the order', () => {
    const list = [r('😭', 2, true), r('✅', 1), r('💀', 1)]
    expect(shape(applyReaction(list, '😭', false, true, 9))).toEqual(['😭1', '✅1', '💀1'])
    expect(shape(applyReaction(list, '✅', false, false, 9))).toEqual(['😭2*', '💀1'])
    expect(shape(applyReaction(list, '😭', false, false, 9))).toEqual(['😭1*', '✅1', '💀1'])
    expect(applyReaction(list, '🙃', false, false, 9)).toBe(list)
  })

  test('own changes already shown are ignored (optimistic echo)', () => {
    const list = [r('😭', 2, true), r('✅', 1)]
    expect(applyReaction(list, '😭', true, true, 9)).toBe(list)
    expect(applyReaction(list, '✅', false, true, 9)).toBe(list)
    const m = msg(1, { reactions: list })
    expect(withReaction(m, '😭', true, true, 9)).toBe(m)
    const bare = msg(2)
    expect(withReaction(bare, '😭', false, false, 9)).toBe(bare)
    expect(withReaction(bare, '😭', true, false, 9).reactions).toEqual([r('😭', 1, false, 9)])
  })

  test('caps distinct emojis at 20', () => {
    const full = msg(1, {
      reactions: Array.from({ length: 20 }, (_, i) => r(String.fromCodePoint(0x1f600 + i), 1)),
    })
    expect(canAddEmoji(full, '🦀')).toBe(false)
    expect(canAddEmoji(full, '😀')).toBe(true)
    expect(canAddEmoji(msg(2), '🦀')).toBe(true)
  })
})

describe('reaction tooltip', () => {
  test('names up to three reactors, then "and N others"', () => {
    expect(reactorsText(['alice'], 1)).toBe('alice')
    expect(reactorsText(['alice', 'bob'], 2)).toBe('alice and bob')
    expect(reactorsText(['alice', 'bob', 'carol'], 3)).toBe('alice, bob and carol')
    expect(reactorsText(['alice', 'bob', 'carol', 'dave'], 4)).toBe('alice, bob, carol and 1 other')
    expect(reactorsText(['alice', 'bob', 'carol'], 6)).toBe('alice, bob, carol and 3 others')
    expect(reactorsText(['alice', 'bob'], 5, 2)).toBe('alice, bob and 3 others')
    expect(reactorsText([], 2)).toBe('2 people')
  })

  test('label with shortcode, and streamer mode hides names', () => {
    expect(reactionLabel('😭', 'sob', ['Alice', 'Bob', 'Carol', 'Dan', 'Eve'], 5, false)).toBe(
      '😭 :sob: reacted by Alice, Bob, Carol and 2 others'
    )
    expect(reactionLabel('😭', 'sob', ['Alice'], 5, true)).toBe('😭 :sob: reacted by 5 people')
    expect(reactionLabel('😭', null, null, 1, false)).toBe('😭 reacted by 1 person')
  })

  test('shortcodes resolve skin tones and missing variation selectors', () => {
    const data = [
      {
        emoji: '👍',
        name: 'thumbs up',
        category: 'people',
        keywords: [],
        shortcodes: ['thumbsup', '+1'],
        skins: ['👍🏻', '👍🏽'],
        version: 1,
      },
      {
        emoji: '❤️',
        name: 'red heart',
        category: 'people',
        keywords: [],
        shortcodes: ['heart'],
        skins: null,
        version: 1,
      },
    ] as Emoji[]
    expect(emojiCode(data, '👍🏽')).toBe('thumbsup')
    expect(emojiCode(data, '❤')).toBe('heart')
    expect(emojiCode(data, '🦀')).toBeNull()
  })

  test('frecency base of a picked variant', () => {
    const prefs = noteUse(EMPTY_PREFS, '👍', '👍🏽', 1)
    expect(emojiBase(prefs, '👍🏽')).toBe('👍')
    expect(emojiBase(prefs, '👍')).toBe('👍')
    expect(emojiBase(prefs, '🦀')).toBe('🦀')
    expect(emojiBase(prefs, '👋🏿')).toBe('👋')
    expect(emojiBase(prefs, '🧑🏻‍❤️‍💋‍🧑🏼')).toBe('🧑‍❤️‍💋‍🧑')
  })
})

describe('absolute counts from events', () => {
  test('applying an event twice or over a page that has it changes nothing', () => {
    const page = [r('😭', 2), r('✅', 1, true)]
    const once = applyReaction(page, '😭', true, false, 9, 2)
    expect(once).toBe(page)
    const added = applyReaction(page, '😭', true, false, 9, 3)
    expect(shape(added)).toEqual(['😭3', '✅1*'])
    expect(applyReaction(added, '😭', true, false, 9, 3)).toBe(added)
    const gone = applyReaction(added, '✅', false, true, 9, 0)
    expect(shape(gone)).toEqual(['😭3'])
    expect(applyReaction(gone, '✅', false, true, 9, 0)).toBe(gone)
    expect(shape(applyReaction(gone, '🦀', true, false, 9, 1))).toEqual(['😭3', '🦀1'])
  })

  test('own events set me, others keep it', () => {
    const list = [r('😭', 1, true)]
    expect(shape(applyReaction(list, '😭', true, false, 9, 2))).toEqual(['😭2*'])
    expect(shape(applyReaction(list, '😭', false, true, 9, 1))).toEqual(['😭1'])
  })
})

describe('emoji forms', () => {
  test('text and emoji presentation are one chip', () => {
    expect(sameEmoji('❤', '❤️')).toBe(true)
    expect(sameEmoji('👍', '👍🏽')).toBe(false)
    expect(reactorKey(1, '❤')).toBe(reactorKey(1, '❤️'))
    const list = applyReaction([r('❤', 1)], '❤️', true, true, 9, 2)
    expect(shape(list)).toEqual(['❤️2*'])
    expect(shape(applyReaction(list, '❤', false, true, 9))).toEqual(['❤️1'])
    expect(reacted(msg(1, { reactions: [r('❤️', 1, true)] }), '❤')).toBe(true)
  })
})

describe('limits and read-only channels', () => {
  test('a full message only takes emojis it already has', () => {
    const reactions = Array.from({ length: 20 }, (_, i) => r(String.fromCodePoint(0x1f600 + i), 1))
    const m = msg(1, { reactions })
    expect(reactionsFull(m)).toBe(true)
    expect(canAddEmoji(m, '🦀')).toBe(false)
    expect(canAddEmoji(m, '😀')).toBe(true)
    expect(reactionsFull(msg(1, { reactions: reactions.slice(1) }))).toBe(false)
  })

  test('read_only lists channels without send permission', () => {
    const d = serverDetail('s', { read_only: [3] })
    expect(readOnly(d, 3)).toBe(true)
    expect(readOnly(d, 1)).toBe(false)
    expect(readOnly(undefined, 3)).toBe(false)
    expect(readOnly(serverDetail('s'), 3)).toBe(false)
    expect(readOnly(d, null)).toBe(false)
  })
})
