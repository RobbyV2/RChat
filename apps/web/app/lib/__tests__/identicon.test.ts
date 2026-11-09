import { describe, expect, test } from 'bun:test'
import { minidenticon } from 'minidenticons'
import {
  IDENTICON_DEFAULT_BG,
  IDENTICON_MIN_CONTRAST,
  IDENTICON_PRESETS,
  avatarColorFor,
  avatarDraft,
  identiconBackground,
  identiconInk,
  identiconSvg,
} from '../identicon'
import { hslHex } from '../profile'
import { contrast } from '../server_colors'
import { themeToken } from './theme_tokens'

const HEX = /^#[0-9a-f]{6}$/
const NAMES = ['bob', 'carol', 'frank', 'erin', 'admin', 'ivan', 'alice', 'victor']

const backgrounds = () => {
  const out = ['#000000', '#ffffff', '#010101', '#fefefe', '#808080', '#777777']
  for (let hue = 0; hue < 360; hue += 30)
    for (const sat of [0.2, 0.6, 1])
      for (const light of [0.02, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 0.98])
        out.push(hslHex(hue, sat, light))
  return [...out, ...IDENTICON_PRESETS.map(p => p.color)]
}

describe('identicon background', () => {
  test('only identicons with a valid color have a background', () => {
    expect(identiconBackground('identicon', '#A1b2C3')).toBe('#a1b2c3')
    expect(identiconBackground('identicon', null)).toBe(null)
    expect(identiconBackground('identicon', undefined)).toBe(null)
    expect(identiconBackground('color', '#a1b2c3')).toBe(null)
    for (const bad of ['', 'red', '#abc', '#a1b2c3d', 'a1b2c3', 'url(x)'])
      expect(identiconBackground('identicon', bad)).toBe(null)
  })

  test('the default ink stays when it already reads on the background', () => {
    expect(identiconInk('bob', '#ffffff')).toBe('#e00606')
    expect(identiconInk('bob', '#000000')).toBe('#e00606')
    expect(identiconInk('alice', '#000000')).toBe('#9706e0')
  })

  test('the ink moves to the nearest lightness that reaches 3:1', () => {
    expect(identiconInk('carol', '#ffffff')).toBe('#c78605')
    expect(identiconInk('carol', '#ffe8a3')).toBe('#b37905')
    expect(identiconInk('carol', '#e9ddff')).toBe('#ae7604')
    expect(identiconInk('alice', '#262a33')).toBe('#b11ff9')
    expect(identiconInk('alice', '#4f46b8')).toBe('#d588fc')
    expect(identiconInk('alice', '#e00606')).toBe('#40025e')
    expect(identiconInk('admin', '#1d6b86')).toBe('#56c4fb')
    expect(identiconInk('admin', '#808080')).toBe('#023955')
    expect(identiconInk('bob', '#b4471b')).toBe('#460202')
  })

  test('the ink reads at 3:1 on every background, for every identicon hue', () => {
    expect(IDENTICON_MIN_CONTRAST).toBe(3)
    for (const name of NAMES)
      for (const bg of backgrounds()) {
        const ink = identiconInk(name, bg)
        expect(HEX.test(ink)).toBe(true)
        if (contrast(ink, bg) < 3) throw new Error(`${name} on ${bg}: ${ink} ${contrast(ink, bg)}`)
      }
  })

  test('the default picture is the library picture', () => {
    expect(identiconSvg('alice', null)).toBe(minidenticon('alice', 95, 45))
  })

  test('a background only changes the fill', () => {
    const plain = minidenticon('carol', 95, 45)
    const drawn = identiconSvg('carol', '#ffffff')
    expect(plain).toContain('fill="hsl(40 95% 45%)"')
    expect(drawn).toBe(plain.replace('fill="hsl(40 95% 45%)"', 'fill="#c78605"'))
    expect(drawn).toContain('<rect ')
  })

  test('the default background is the theme color behind a plain identicon', () => {
    const bg: Record<string, string> = IDENTICON_DEFAULT_BG
    expect(bg.dark).toBe(themeToken('dark', 'surface-container-highest'))
    expect(bg.light).toBe(themeToken('light', 'surface-container-highest'))
    expect(bg.dark).not.toBe(bg.light)
  })

  test('presets are valid colors with labels', () => {
    expect(IDENTICON_PRESETS.length).toBeGreaterThanOrEqual(6)
    for (const p of IDENTICON_PRESETS) {
      expect(HEX.test(p.color)).toBe(true)
      expect(p.label.length).toBeGreaterThan(0)
    }
    expect(new Set(IDENTICON_PRESETS.map(p => p.color)).size).toBe(IDENTICON_PRESETS.length)
  })
})

describe('avatar draft', () => {
  test('an identicon with a background keeps it and leaves the color at its default', () => {
    expect(avatarDraft({ avatar_kind: 'identicon', avatar_color: '#112233' })).toEqual({
      kind: 'identicon',
      color: '#6750a4',
      background: '#112233',
    })
  })

  test('a color avatar keeps its color and has no identicon background', () => {
    expect(avatarDraft({ avatar_kind: 'color', avatar_color: '#445566' })).toEqual({
      kind: 'color',
      color: '#445566',
      background: null,
    })
  })

  test('missing or bad values fall back to the defaults', () => {
    expect(avatarDraft(null)).toEqual({ kind: 'identicon', color: '#6750a4', background: null })
    expect(avatarDraft({ avatar_kind: 'identicon', avatar_color: 'nope' })).toEqual({
      kind: 'identicon',
      color: '#6750a4',
      background: null,
    })
    expect(avatarDraft({ avatar_kind: 'color', avatar_color: null })).toEqual({
      kind: 'color',
      color: '#6750a4',
      background: null,
    })
  })

  test('the saved color follows the avatar kind', () => {
    expect(avatarColorFor('color', '#445566', '#112233')).toBe('#445566')
    expect(avatarColorFor('identicon', '#445566', '#112233')).toBe('#112233')
    expect(avatarColorFor('identicon', '#445566', null)).toBe(undefined)
  })
})
