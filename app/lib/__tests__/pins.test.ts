import { describe, expect, test } from 'bun:test'
import {
  canPin,
  isPinned,
  noPinsText,
  pinPlace,
  unlinkPin,
  withPinnedAt,
  withoutPin,
} from '../pins'
import { msg } from './fixtures'

describe('pins', () => {
  test('only top-level user messages can be pinned', () => {
    expect(canPin(msg(1))).toBe(true)
    expect(canPin(msg(1, { thread_root_id: 5 }))).toBe(false)
    expect(canPin(msg(1, { kind: 'call' }))).toBe(false)
    expect(canPin(msg(1, { kind: 'pin' }))).toBe(false)
    expect(canPin(msg(-3))).toBe(false)
  })

  test('pinned state', () => {
    const m = msg(1)
    expect(isPinned(m)).toBe(false)
    const pinned = withPinnedAt(m, 50)
    expect(isPinned(pinned)).toBe(true)
    expect(withPinnedAt(pinned, 50)).toBe(pinned)
    expect(withPinnedAt(pinned, null).pinned_at).toBeNull()
    expect(withPinnedAt(m, null)).toBe(m)
  })

  test('a deleted message stops being linked from pin notices', () => {
    const list = [msg(1), msg(2, { kind: 'pin', pin_message_id: 1 }), msg(3)]
    const out = unlinkPin(list, 1)
    expect(out[1].pin_message_id).toBeNull()
    expect(out[0]).toBe(list[0])
    expect(unlinkPin(list, 9)).toBe(list)
  })

  test('removing from the pins list', () => {
    const list = [msg(4), msg(2)]
    expect(withoutPin(list, 4).map(m => m.id)).toEqual([2])
    expect(withoutPin(list, 7)).toBe(list)
  })

  test('copy names the scope', () => {
    expect(pinPlace('c4')).toBe('channel')
    expect(pinPlace('d4')).toBe('conversation')
    expect(noPinsText('c1')).toBe("This channel doesn't have any pinned messages yet.")
    expect(noPinsText('d1')).toBe("This conversation doesn't have any pinned messages yet.")
  })
})
