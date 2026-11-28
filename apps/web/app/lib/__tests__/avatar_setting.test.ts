import { describe, expect, test } from 'bun:test'
import { AVATAR_MODES, builtIn, ownColor, parseAvatarMode, picturesShown } from '../avatar_setting'

const identicon = { username: 'carol', avatar_kind: 'identicon' as const, avatar_color: '#AABBCC' }
const color = { username: 'dave', avatar_kind: 'color' as const, avatar_color: '#112233' }

describe('what this device draws for people', () => {
  test('a stored value that is not a mode reads as the default', () => {
    for (const mode of AVATAR_MODES) expect(parseAvatarMode(mode)).toBe(mode)
    for (const bad of [null, undefined, '', 'off', 1, {}, 'PICTURES'])
      expect(parseAvatarMode(bad)).toBe('pictures')
  })

  test('pictures and built-in keep each person their own avatar', () => {
    for (const mode of ['pictures', 'builtin'] as const) {
      expect(builtIn(identicon, mode)).toEqual({ kind: 'identicon', color: '#AABBCC' })
      expect(builtIn(color, mode)).toEqual({ kind: 'color', color: '#112233' })
    }
  })

  test('a forced kind draws everyone with it, whatever they chose', () => {
    expect(builtIn(identicon, 'identicon')).toEqual({ kind: 'identicon', color: '#aabbcc' })
    expect(builtIn(color, 'identicon')).toEqual({ kind: 'identicon', color: null })
    expect(builtIn(color, 'color')).toEqual({ kind: 'color', color: '#112233' })
    expect(builtIn(identicon, 'color')).toEqual({ kind: 'color', color: ownColor('carol') })
    expect(/^#[0-9a-f]{6}$/.test(ownColor('carol'))).toBe(true)
    expect(ownColor('carol')).toBe(ownColor('carol'))
  })

  test('pictures load only in the pictures mode, outside streamer mode, where they are served', () => {
    expect(picturesShown({ mode: 'pictures', streamer: false, served: true })).toBe(true)
    expect(picturesShown({ mode: 'pictures', streamer: true, served: true })).toBe(false)
    expect(picturesShown({ mode: 'pictures', streamer: false, served: false })).toBe(false)
    for (const mode of ['builtin', 'identicon', 'color'] as const)
      expect(picturesShown({ mode, streamer: false, served: true })).toBe(false)
  })
})
