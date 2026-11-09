import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'bun:test'
import {
  FOLDER_BASE,
  FOLDER_MIX,
  FOLDER_PRESETS,
  folderColors,
  folderDefaults,
  folderStyle,
  type FolderColors,
} from '../folder_colors'
import { hslHex } from '../profile'
import { contrast, luminance } from '../server_colors'
import { themeToken } from './theme_tokens'

type Theme = 'dark' | 'light'
const THEMES: Theme[] = ['dark', 'light']
const HEX = /^#[0-9a-f]{6}$/

// Today's purple pair, measured from the stylesheet: the icon is `primary`, the open folder's
// background is 22% of it over the rail, the closed tile's 26%.
const TODAY: Record<Theme, FolderColors & { pair: number; tilePair: number; lift: number }> = {
  dark: {
    icon: '#d0bcff',
    onIcon: '#381e72',
    group: '#393447',
    tile: '#413b50',
    hover: '#544c68',
    drop: '#514963',
    pair: 7.015,
    tilePair: 6.266,
    lift: 1.615,
  },
  light: {
    icon: '#6750a4',
    onIcon: '#ffffff',
    group: '#ded9eb',
    tile: '#d7d2e7',
    hover: '#c8c0de',
    drop: '#cbc4e0',
    pair: 4.672,
    tilePair: 4.375,
    lift: 1.379,
  },
}

const picks = () => {
  const out = [
    '#000000',
    '#ffffff',
    '#050505',
    '#fdfdfd',
    '#808080',
    '#ff0000',
    '#00ff00',
    '#0000ff',
    '#ffff00',
    '#00ffff',
    '#ff00ff',
    '#000033',
    '#330000',
    '#fffff0',
    '#f0f0ff',
    '#d0bcff',
    '#6750a4',
  ]
  for (let hue = 0; hue < 360; hue += 15)
    for (const sat of [0.15, 0.5, 1])
      for (const light of [0.03, 0.15, 0.35, 0.5, 0.65, 0.85, 0.97])
        out.push(hslHex(hue, sat, light))
  return [...out, ...FOLDER_PRESETS.map(p => p.color)]
}

const hueOf = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  if (d === 0) return null
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}

const colorsOnly = ({ icon, onIcon, group, tile, hover, drop }: FolderColors): FolderColors => ({
  icon,
  onIcon,
  group,
  tile,
  hover,
  drop,
})

describe("today's folder pair", () => {
  test('the base colors are the theme tokens the folder styles use', () => {
    for (const theme of THEMES) {
      const base: Record<string, string> = FOLDER_BASE[theme]
      expect(base.icon).toBe(themeToken(theme, 'primary'))
      expect(base.onIcon).toBe(themeToken(theme, 'on-primary'))
      expect(base.surface).toBe(themeToken(theme, 'surface-container-lowest'))
    }
  })

  test('the default colors are the ones drawn today', () => {
    for (const theme of THEMES) {
      const now = folderDefaults(theme)
      expect(now).toEqual(colorsOnly(TODAY[theme]))
      expect(Math.abs(contrast(now.icon, now.group) - TODAY[theme].pair) < 0.001).toBe(true)
      expect(Math.abs(contrast(now.icon, now.tile) - TODAY[theme].tilePair) < 0.001).toBe(true)
    }
  })

  test('the stylesheet falls back to the same mixes', () => {
    const css = readFileSync(fileURLToPath(new URL('../../globals.css', import.meta.url)), 'utf8')
    const rule = (selector: string) => {
      const at = css.indexOf(`\n${selector} {`)
      if (at < 0) throw new Error(`No ${selector} rule`)
      return css
        .slice(at, css.indexOf('}', at))
        .replace(/\s+/g, ' ')
        .replace(/\( /g, '(')
        .replace(/ \)/g, ')')
    }
    const mixed = (percent: number) =>
      `color-mix(in srgb, var(--color-primary) ${percent}%, var(--color-surface-container-lowest))`
    expect(rule('.folder-group')).toContain(`var(--folder-group, ${mixed(FOLDER_MIX.group)})`)
    expect(rule('.folder-tile')).toContain(`var(--folder-tile, ${mixed(FOLDER_MIX.tile)})`)
    expect(rule('.folder-tile:hover')).toContain(`var(--folder-hover, ${mixed(FOLDER_MIX.hover)})`)
    expect(rule('[data-drop-target][data-drag-box]')).toContain(
      `var(--folder-drop, ${mixed(FOLDER_MIX.drop)})`
    )
    expect(rule('[data-drop-target][data-drag-box]')).toContain(
      'var(--folder-icon, var(--color-primary))'
    )
    expect(rule('.folder-icon')).toContain('color: var(--folder-icon, var(--color-primary))')
    expect(rule('.folder-badge')).toContain('background: var(--folder-icon, var(--color-primary))')
    expect(rule('.folder-badge')).toContain('color: var(--folder-on-icon, var(--color-on-primary))')
  })
})

describe('derived folder colors', () => {
  test('picking the theme purple gives back today’s pair', () => {
    expect(folderColors('#d0bcff', 'dark')).toEqual({
      ...colorsOnly(TODAY.dark),
      onIcon: '#372366',
    })
    expect(folderColors('#6750a4', 'light')).toEqual(colorsOnly(TODAY.light))
  })

  test('each theme gets its own tone of the pick', () => {
    expect(folderColors('#ff0000', 'dark')).toEqual({
      icon: '#ffb1b1',
      onIcon: '#670000',
      group: '#443136',
      tile: '#4d383c',
      hover: '#65484c',
      drop: '#614549',
    })
    expect(folderColors('#ff0000', 'light')).toEqual({
      icon: '#b30000',
      onIcon: '#ffefef',
      group: '#eec7c7',
      tile: '#ebbdbd',
      hover: '#e4a3a3',
      drop: '#e5a8a8',
    })
    expect(folderColors('#3F9B5B', 'dark')).toEqual({
      icon: '#7cd898',
      onIcon: '#003711',
      group: '#273a30',
      tile: '#2b4236',
      hover: '#365643',
      drop: '#345240',
    })
    expect(folderColors('#3f9b5b', 'light')).toEqual({
      icon: '#106c2c',
      onIcon: '#f7fffa',
      group: '#cadfd1',
      tile: '#c1d9c8',
      hover: '#a9cab3',
      drop: '#aecdb7',
    })
  })

  test('the two theme purples map to each other', () => {
    expect(folderColors('#6750a4', 'dark').icon).toBe('#cfbcff')
    expect(folderColors('#d0bcff', 'light').icon).toBe('#675396')
  })

  test('very light, very dark and grey picks become a readable tone, not the pick', () => {
    for (const pick of ['#000000', '#050505', '#808080', '#fdfdfd', '#ffffff']) {
      expect(folderColors(pick, 'dark').icon).toBe('#c5c5c5')
      expect(folderColors(pick, 'light').icon).toBe('#5f5f5f')
    }
    expect(folderColors('#000033', 'dark').icon).toBe('#c2c2f5')
    expect(folderColors('#000033', 'light').icon).toBe('#5a5a8d')
    expect(folderColors('#fffff0', 'dark').icon).toBe('#c7c7b8')
    expect(folderColors('#fffff0', 'light').icon).toBe('#606051')
  })

  test('the icon and its background keep today’s contrast for every pick', () => {
    for (const theme of THEMES) {
      const now = TODAY[theme]
      const surface = FOLDER_BASE[theme].surface
      for (const pick of picks()) {
        const c = folderColors(pick, theme)
        const fail = (what: string, got: number) =>
          new Error(`${theme} ${pick} ${what}: ${got.toFixed(3)} ${JSON.stringify(c)}`)
        for (const value of Object.values(c)) expect(HEX.test(value)).toBe(true)
        const pair = contrast(c.icon, c.group)
        if (Math.abs(pair - now.pair) > 0.06) throw fail('icon on the open folder', pair)
        const tilePair = contrast(c.icon, c.tile)
        if (Math.abs(tilePair - now.tilePair) > 0.1) throw fail('icon on the closed tile', tilePair)
        const lift = contrast(c.group, surface)
        if (Math.abs(lift - now.lift) > 0.2) throw fail('folder against the rail', lift)
        const lighter = luminance(c.icon) > luminance(c.group)
        if (lighter !== (theme === 'dark')) throw fail('icon side', luminance(c.icon))
      }
    }
  })

  test('the badge glyph, hover, drop highlight, unread dot and mini grid still read', () => {
    for (const theme of THEMES) {
      const dot = themeToken(theme, 'error')
      const mini = themeToken(theme, 'surface-container-high')
      const miniNow = contrast(mini, TODAY[theme].tile)
      for (const pick of picks()) {
        const c = folderColors(pick, theme)
        const fail = (what: string, got: number) =>
          new Error(`${theme} ${pick} ${what}: ${got.toFixed(3)} ${JSON.stringify(c)}`)
        const glyph = contrast(c.onIcon, c.icon)
        if (glyph < 6) throw fail('badge glyph', glyph)
        const hover = contrast(c.icon, c.hover)
        if (hover < 3) throw fail('icon on hover', hover)
        const drop = contrast(c.icon, c.drop)
        if (drop < 3) throw fail('icon on the drop highlight', drop)
        if (contrast(c.drop, c.group) < 1.15)
          throw fail('drop highlight', contrast(c.drop, c.group))
        for (const bg of [c.group, c.tile]) {
          const unread = contrast(dot, bg)
          if (unread < 3) throw fail('unread dot', unread)
        }
        const grid = contrast(mini, c.tile)
        if (Math.abs(grid - miniNow) > 0.2) throw fail('mini grid', grid)
      }
    }
  })

  test('the hue of a colorful pick is kept', () => {
    for (const theme of THEMES)
      for (let hue = 0; hue < 360; hue += 15)
        for (const light of [0.15, 0.5, 0.85]) {
          const pick = hslHex(hue, 1, light)
          const want = hueOf(pick) as number
          const got = hueOf(folderColors(pick, theme).icon)
          const off =
            got === null ? 180 : Math.min(Math.abs(got - want), 360 - Math.abs(got - want))
          if (off > 3) throw new Error(`${theme} ${pick}: hue ${want} became ${got}`)
        }
  })
})

describe('folder style', () => {
  test('no color, or a bad one, leaves the stylesheet defaults', () => {
    for (const theme of THEMES)
      for (const color of [undefined, null, '', 'red', '#abc', '#12345g'])
        expect(folderStyle(color, theme)).toBeUndefined()
  })

  test('a color sets every folder variable for the theme', () => {
    expect(folderStyle('#FF0000', 'light')).toEqual({
      '--folder-icon': '#b30000',
      '--folder-on-icon': '#ffefef',
      '--folder-group': '#eec7c7',
      '--folder-tile': '#ebbdbd',
      '--folder-hover': '#e4a3a3',
      '--folder-drop': '#e5a8a8',
    })
    expect(folderStyle('#ff0000', 'dark')?.['--folder-icon']).toBe('#ffb1b1')
  })
})

describe('folder presets', () => {
  test('are labeled, valid, distinct picks that stay distinct in both themes', () => {
    expect(FOLDER_PRESETS.length).toBeGreaterThanOrEqual(6)
    expect(FOLDER_PRESETS.length).toBeLessThanOrEqual(10)
    for (const p of FOLDER_PRESETS) {
      expect(HEX.test(p.color)).toBe(true)
      expect(p.label.length).toBeGreaterThan(0)
    }
    expect(new Set(FOLDER_PRESETS.map(p => p.label)).size).toBe(FOLDER_PRESETS.length)
    for (const theme of THEMES)
      expect(new Set(FOLDER_PRESETS.map(p => folderColors(p.color, theme).icon)).size).toBe(
        FOLDER_PRESETS.length
      )
  })
})
