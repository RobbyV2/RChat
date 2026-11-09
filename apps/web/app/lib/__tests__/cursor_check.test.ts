import { describe, expect, test } from 'bun:test'
import { cursorFaults, type CursorNode } from '../cursor_check'

const node = (over: Partial<CursorNode>): CursorNode => ({
  label: 'button "Send"',
  cursor: 'pointer',
  clickable: true,
  disabled: false,
  typing: false,
  drag: false,
  ...over,
})

describe('cursor faults', () => {
  test('a clickable element shows the hand', () => {
    expect(cursorFaults([node({})])).toEqual([])
    expect(cursorFaults([node({ cursor: 'default' })])).toEqual([
      { label: 'button "Send"', cursor: 'default', want: 'pointer' },
    ])
  })

  test('something that does nothing on click keeps its cursor', () => {
    expect(cursorFaults([node({ clickable: false, cursor: 'default' })])).toEqual([])
    expect(cursorFaults([node({ clickable: false, cursor: 'text' })])).toEqual([])
  })

  test('a disabled control never shows the hand', () => {
    expect(cursorFaults([node({ disabled: true, cursor: 'default' })])).toEqual([])
    expect(cursorFaults([node({ disabled: true, cursor: 'not-allowed' })])).toEqual([])
    expect(cursorFaults([node({ disabled: true, cursor: 'pointer' })])).toEqual([
      { label: 'button "Send"', cursor: 'pointer', want: 'default or not-allowed' },
    ])
  })

  test('text fields and drag handles keep their own cursor', () => {
    expect(cursorFaults([node({ typing: true, cursor: 'text' })])).toEqual([])
    expect(cursorFaults([node({ drag: true, cursor: 'grab' })])).toEqual([])
  })
})
