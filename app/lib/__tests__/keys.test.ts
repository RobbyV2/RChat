import { describe, expect, test } from 'bun:test'
import { composing, enterKey, sendKey } from '../keys'

const ev = (key: string, over: { shift?: boolean; code?: number; composing?: boolean } = {}) => ({
  key,
  shiftKey: over.shift ?? false,
  keyCode: over.code ?? 13,
  nativeEvent: { isComposing: over.composing ?? false },
})

describe('enter handling', () => {
  test('a plain enter sends, shift+enter does not', () => {
    expect(sendKey(ev('Enter'))).toBe(true)
    expect(sendKey(ev('Enter', { shift: true }))).toBe(false)
    expect(sendKey(ev('a'))).toBe(false)
  })

  test('enter while an IME is composing only commits the composition', () => {
    expect(composing(ev('Enter', { composing: true }))).toBe(true)
    expect(composing(ev('Enter', { code: 229 }))).toBe(true)
    expect(sendKey(ev('Enter', { composing: true, code: 229 }))).toBe(false)
    expect(sendKey(ev('Enter', { code: 229 }))).toBe(false)
    expect(enterKey(ev('Enter', { composing: true }))).toBe(false)
    expect(enterKey(ev('Enter'))).toBe(true)
  })
})
