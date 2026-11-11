import { describe, expect, test } from 'bun:test'
import { fxAllowed, heldBackLine, type FxInput, type MotionChoice } from '../fx/gate'

const base: FxInput = {
  instanceOn: true,
  prefsOn: true,
  kindOn: true,
  placeOn: true,
  reducedMotion: false,
  motion: 'device',
  lowPower: false,
  sharingScreen: false,
  pageVisible: true,
}
const mode = (over: Partial<FxInput>) => fxAllowed({ ...base, ...over })

describe('the gate', () => {
  test('any switch off, a screen share or a hidden page: off', () => {
    for (const k of ['instanceOn', 'prefsOn', 'kindOn', 'placeOn', 'pageVisible'] as const)
      expect([k, mode({ [k]: false })]).toEqual([k, 'off'])
    expect(mode({ sharingScreen: true })).toBe('off')
    expect(mode({ paused: true })).toBe('off')
    expect(mode({ paused: true, motion: 'always' })).toBe('off')
  })
  test('reduced motion: off unless the user chose otherwise', () => {
    expect(mode({ reducedMotion: true })).toBe('off')
    expect(mode({ reducedMotion: true, motion: 'still' })).toBe('still')
    expect(mode({ reducedMotion: true, motion: 'always' })).toBe('motion')
  })
  test('still pictures by choice; low power never more than still', () => {
    expect(mode({ motion: 'still' })).toBe('still')
    expect(mode({ lowPower: true })).toBe('still')
    expect(mode({ lowPower: true, motion: 'always' })).toBe('still')
    expect(mode({ lowPower: true, reducedMotion: true })).toBe('off')
  })
  test('whole-UI effects and the trail need full motion', () => {
    expect(mode({ wholeUi: true })).toBe('motion')
    for (const over of [
      { motion: 'still' as MotionChoice },
      { lowPower: true },
      { reducedMotion: true },
    ])
      expect(mode({ ...over, wholeUi: true })).toBe('off')
    expect(mode({ reducedMotion: true, motion: 'always', wholeUi: true })).toBe('motion')
  })
  test('the full table has no other outcome', () => {
    const seen = new Set<string>()
    for (const reducedMotion of [false, true])
      for (const motion of ['device', 'still', 'always'] as const)
        for (const lowPower of [false, true])
          for (const wholeUi of [false, true])
            seen.add(mode({ reducedMotion, motion, lowPower, wholeUi }))
    expect([...seen].sort()).toEqual(['motion', 'off', 'still'])
  })
})

describe('what settings say', () => {
  test('lines', () => {
    expect(heldBackLine({ ...base, instanceOn: false }, 'Alpha')).toBe(
      'Fun effects are turned off on Alpha.'
    )
    expect(heldBackLine({ ...base, reducedMotion: true }, 'Alpha')).toBe(
      'Your device asks for less motion, so effects are off.'
    )
    expect(heldBackLine({ ...base, reducedMotion: true, motion: 'always' }, 'Alpha')).toBeNull()
    expect(heldBackLine({ ...base, lowPower: true }, 'Alpha')).toBe(
      'Battery saver is on, so effects are still pictures.'
    )
    expect(heldBackLine({ ...base, paused: true }, 'Alpha')).toBe(
      'Effects are paused on this device for now.'
    )
    expect(heldBackLine(base, 'Alpha')).toBeNull()
  })
})
