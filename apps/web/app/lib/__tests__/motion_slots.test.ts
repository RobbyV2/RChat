import { describe, expect, test } from 'bun:test'
import { OWNERS, SLOTS, SLOT_IDS, slotOf } from '../motion/slots'

describe('the slot catalog', () => {
  test('24 slots, in the catalog order', () => {
    expect(SLOT_IDS).toEqual([
      'dialog',
      'sheet',
      'menu',
      'tooltip',
      'panel',
      'drawer',
      'thread',
      'route',
      'message.arrive',
      'message.send',
      'message.remove',
      'reaction.add',
      'reaction.count',
      'badge',
      'press',
      'hover',
      'reorder',
      'drag',
      'toast',
      'typing',
      'call.tile',
      'palette',
      'toggle',
      'expand',
    ])
    expect(SLOTS.map(s => s.id)).toEqual([...SLOT_IDS])
    expect(new Set(SLOT_IDS).size).toBe(24)
  })

  test('every slot says where it plays and which components own it', () => {
    for (const s of SLOTS) {
      expect(s.where.length).toBeGreaterThan(5)
      if (!(OWNERS as readonly string[]).includes(s.owner)) throw new Error(`${s.id} ${s.owner}`)
    }
  })

  test('the 20 component groups each own at least one slot', () => {
    expect(OWNERS).toHaveLength(20)
    expect(new Set(OWNERS).size).toBe(20)
    const used = new Set<string>(SLOTS.map(s => s.owner))
    for (const o of OWNERS) if (!used.has(o)) throw new Error(o)
  })

  test('each slot says when its animation plays', () => {
    const plays = (id: string) => SLOTS.find(s => s.id === id)?.plays
    for (const s of SLOTS)
      if (!['both', 'enter', 'exit', 'change', 'hold'].includes(s.plays)) throw new Error(s.id)
    expect(plays('dialog')).toBe('both')
    expect(plays('message.arrive')).toBe('enter')
    expect(plays('message.remove')).toBe('exit')
    expect(plays('reaction.count')).toBe('change')
    expect(plays('reorder')).toBe('change')
    expect(plays('press')).toBe('hold')
    expect(plays('hover')).toBe('hold')
    expect(plays('drag')).toBe('hold')
  })

  test('only reorder measures its start at run time', () => {
    expect(SLOTS.filter(s => s.flip).map(s => s.id)).toEqual(['reorder'])
  })

  test('a slot is found by id, and an unknown id is not', () => {
    expect(slotOf('call.tile')?.owner).toBe('call tiles')
    expect(slotOf('look.switch')).toBeUndefined()
    expect(slotOf('toString')).toBeUndefined()
  })
})
