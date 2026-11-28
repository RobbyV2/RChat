import { describe, expect, test } from 'bun:test'
import { LOOK_IDS, OWNERS, PLAY_IDS, SLOTS, SLOT_IDS, isLook, slotOf } from '../motion/slots'

describe('the slot catalog', () => {
  test('32 slots, in the catalog order', () => {
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
      'lightbox',
      'lightbox.slide',
      'skeleton.shimmer',
      'image.reveal',
      'banner.unread',
      'toolbar.hover',
      'nav.indicator',
      'typing.channel',
    ])
    expect(SLOTS.map(s => s.id)).toEqual([...SLOT_IDS])
    expect(new Set(SLOT_IDS).size).toBe(32)
  })

  test('every slot says where it plays and which components own it', () => {
    for (const s of SLOTS) {
      expect(s.where.length).toBeGreaterThan(5)
      if (!(OWNERS as readonly string[]).includes(s.owner)) throw new Error(`${s.id} ${s.owner}`)
    }
  })

  test('the 27 component groups each own at least one slot', () => {
    expect(OWNERS).toHaveLength(27)
    expect(new Set(OWNERS).size).toBe(27)
    const used = new Set<string>(SLOTS.map(s => s.owner))
    for (const o of OWNERS) if (!used.has(o)) throw new Error(o)
  })

  test('each slot says when its animation plays', () => {
    const plays = (id: string) => SLOTS.find(s => s.id === id)?.plays
    for (const s of SLOTS)
      if (!['both', 'enter', 'exit', 'change', 'hold', 'loop'].includes(s.plays))
        throw new Error(s.id)
    expect(plays('dialog')).toBe('both')
    expect(plays('message.arrive')).toBe('enter')
    expect(plays('message.remove')).toBe('exit')
    expect(plays('reaction.count')).toBe('change')
    expect(plays('reorder')).toBe('change')
    expect(plays('press')).toBe('hold')
    expect(plays('hover')).toBe('hold')
    expect(plays('drag')).toBe('hold')
  })

  test('the style sheet moves what is held or loops, and the engine plays the rest', () => {
    expect([...LOOK_IDS]).toEqual([
      'press',
      'hover',
      'drag',
      'toggle',
      'expand',
      'skeleton.shimmer',
      'toolbar.hover',
      'nav.indicator',
      'typing.channel',
    ])
    expect(PLAY_IDS).toHaveLength(23)
    expect([...PLAY_IDS, ...LOOK_IDS].sort()).toEqual([...SLOT_IDS].sort())
    for (const s of SLOTS)
      if ((s.plays === 'hold' || s.plays === 'loop') && !isLook(s.id)) throw new Error(s.id)
  })

  test('every slot has a name of its own for Settings', () => {
    expect(new Set(SLOTS.map(s => s.label)).size).toBe(32)
    for (const s of SLOTS) expect(s.label.length).toBeGreaterThan(3)
  })

  test('what comes and goes with its screen plays only on its own', () => {
    expect(SLOTS.filter(s => s.solo).map(s => s.id)).toEqual([
      'message.remove',
      'reaction.add',
      'badge',
      'toast',
      'typing',
      'call.tile',
      'image.reveal',
    ])
    expect(SLOTS.filter(s => s.tail).map(s => s.id)).toEqual(['message.arrive'])
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
