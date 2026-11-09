import { describe, expect, test } from 'bun:test'
import {
  BANNER_PRESETS,
  GEAR_CHIP_ALPHA,
  MIN_CONTRAST,
  MIN_NON_TEXT,
  NAME_PRESETS,
  ON_DARK,
  ON_LIGHT,
  THEME_CHIP,
  THEME_ON_SURFACE,
  contrast,
  contrastWarning,
  gearChip,
  gearRing,
  headerColors,
  luminance,
  mix,
  onColor,
} from '../server_colors'

describe('contrast helpers', () => {
  test('luminance and contrast follow WCAG', () => {
    expect(luminance('#000000')).toBe(0)
    expect(luminance('#ffffff')).toBe(1)
    expect(contrast('#000000', '#ffffff')).toBe(21)
    expect(contrast('#ffffff', '#000000')).toBe(21)
    expect(contrast('#777777', '#777777')).toBe(1)
    expect(contrast('#767676', '#ffffff') >= 4.5).toBe(true)
  })

  test('mix blends channels', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mix('#ff0066', '#ff0066', 0.7)).toBe('#ff0066')
    expect(mix('#102030', '#000000', 0)).toBe('#102030')
  })

  test('onColor picks the more readable text color', () => {
    expect(onColor('#ffffff')).toBe(ON_LIGHT)
    expect(onColor('#ffe8a3')).toBe(ON_LIGHT)
    expect(onColor('#000000')).toBe(ON_DARK)
    expect(onColor('#4f46b8')).toBe(ON_DARK)
    for (const bg of ['#ffffff', '#000000', '#ff0066', '#808080', '#00ff00', '#0000ff'])
      expect(contrast(bg, onColor(bg)) >= 3).toBe(true)
  })

  test('the automatic name color reads at 4.5:1 on every grey', () => {
    for (let v = 0; v < 256; v++) {
      const bg = mix('#000000', '#ffffff', v / 255)
      expect(contrast(bg, onColor(bg)) >= MIN_CONTRAST).toBe(true)
    }
  })

  test('the gear chip keeps the icon readable on any banner in both themes', () => {
    for (const theme of ['dark', 'light'] as const)
      for (let i = 0; i < 4096; i++) {
        const bg = `#${[i >> 8, (i >> 4) & 15, i & 15].map(c => (c * 17).toString(16).padStart(2, '0')).join('')}`
        expect(contrast(gearChip(theme, bg), THEME_ON_SURFACE[theme]) >= MIN_CONTRAST).toBe(true)
      }
  })

  test('the gear focus ring shows on any banner', () => {
    for (let i = 0; i < 4096; i++) {
      const bg = `#${[i >> 8, (i >> 4) & 15, i & 15].map(c => (c * 17).toString(16).padStart(2, '0')).join('')}`
      expect(contrast(gearRing(bg), bg) >= MIN_NON_TEXT).toBe(true)
    }
  })

  test('the gear chip is the theme surface over the banner', () => {
    expect(gearChip('dark', '#ffffff')).toBe(mix('#ffffff', THEME_CHIP.dark, GEAR_CHIP_ALPHA))
    expect(gearChip('light', '#000000')).toBe(mix('#000000', THEME_CHIP.light, GEAR_CHIP_ALPHA))
  })

  test('presets are valid and readable with their automatic text color', () => {
    for (const { color } of [...BANNER_PRESETS, ...NAME_PRESETS]) {
      expect(/^#[0-9a-f]{6}$/.test(color)).toBe(true)
    }
    for (const { color } of BANNER_PRESETS)
      expect(contrast(color, onColor(color)) >= MIN_CONTRAST).toBe(true)
  })
})

describe('headerColors', () => {
  test('nothing set keeps the theme', () => {
    expect(headerColors(null, null)).toBeNull()
    expect(headerColors(undefined, 'red')).toBeNull()
  })

  test('a banner alone gets an automatic name color', () => {
    expect(headerColors('#FFFFFF', null)).toEqual({ bg: '#ffffff', fg: ON_LIGHT, gear: ON_LIGHT })
    expect(headerColors('#000000', null)?.fg).toBe(ON_DARK)
  })

  test('a custom name color wins over the automatic one, the gear stays readable', () => {
    const both = headerColors('#ff0066', '#ffd166')
    expect(both?.fg).toBe('#ffd166')
    expect(both?.gear).toBe(onColor('#ff0066'))
  })

  test('a name color alone keeps the theme background and gear', () => {
    expect(headerColors(null, '#ABCDEF')).toEqual({ bg: null, fg: '#abcdef', gear: null })
  })
})

describe('contrastWarning', () => {
  test('no name color, no warning', () => {
    expect(contrastWarning('#ffffff', null)).toBeNull()
    expect(contrastWarning(null, null)).toBeNull()
  })

  test('warns below 4.5:1 against the banner', () => {
    expect(contrastWarning('#ffffff', '#1b1b1f')).toBeNull()
    expect(contrastWarning('#ffffff', '#ffd166')).toContain('hard to read on this banner')
    expect(contrastWarning('#ffffff', '#fefefe')).toContain('(1.0:1')
  })

  test('without a banner, checks both themes', () => {
    expect(contrastWarning(null, '#ffffff')).toContain('the light theme')
    expect(contrastWarning(null, '#ffffff')?.includes('the dark theme')).toBe(false)
    expect(contrastWarning(null, '#000000')).toContain('the dark theme')
    expect(contrastWarning(null, '#808080')).toContain('the dark theme (')
    expect(contrastWarning(null, '#808080')).toContain('the light theme (')
  })
})
