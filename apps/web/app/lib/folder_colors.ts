import { hslHex, validColor } from './profile'
import { contrast, mix } from './server_colors'
import type { Theme } from './types'

export interface FolderColors {
  icon: string
  onIcon: string
  group: string
  tile: string
  hover: string
  drop: string
}

// The default folder: `primary` and `on-primary` over `surface-container-lowest`.
export const FOLDER_BASE = {
  dark: { icon: '#d0bcff', onIcon: '#381e72', surface: '#0f0d13' },
  light: { icon: '#6750a4', onIcon: '#ffffff', surface: '#ffffff' },
} as const

// Percent of the icon color over the rail in each folder background.
export const FOLDER_MIX = { group: 22, tile: 26, hover: 36, drop: 34 } as const

export const FOLDER_PRESETS = [
  { color: '#d9483b', label: 'Red' },
  { color: '#e0822a', label: 'Orange' },
  { color: '#c9a227', label: 'Yellow' },
  { color: '#3f9b5b', label: 'Green' },
  { color: '#2a9d9a', label: 'Teal' },
  { color: '#3b82d9', label: 'Blue' },
  { color: '#c2569f', label: 'Pink' },
  { color: '#7a7f8a', label: 'Grey' },
]

const STEPS = 24

const channels = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)

const lightnessOf = (hex: string) => {
  const rgb = channels(hex)
  return (Math.max(...rgb) + Math.min(...rgb)) / 2
}

const hueChroma = (hex: string) => {
  const [r, g, b] = channels(hex)
  const max = Math.max(r, g, b)
  const chroma = max - Math.min(r, g, b)
  if (chroma === 0) return { hue: 0, chroma }
  const turn = ((g - b) / chroma) % 6
  const sixth =
    max === r
      ? turn < 0
        ? turn + 6
        : turn
      : max === g
        ? (b - r) / chroma + 2
        : (r - g) / chroma + 4
  return { hue: sixth * 60, chroma }
}

// The pick's hue at a lightness, as colorful as the pick where that lightness allows it.
const tone = (hue: number, chroma: number, light: number) => {
  const room = 1 - Math.abs(2 * light - 1)
  return hslHex(hue, chroma <= 0 ? 0 : room <= chroma ? 1 : chroma / room, light)
}

const tints = (icon: string, theme: Theme) => {
  const surface = FOLDER_BASE[theme].surface
  return {
    group: mix(surface, icon, FOLDER_MIX.group / 100),
    tile: mix(surface, icon, FOLDER_MIX.tile / 100),
    hover: mix(surface, icon, FOLDER_MIX.hover / 100),
    drop: mix(surface, icon, FOLDER_MIX.drop / 100),
  }
}

export const folderDefaults = (theme: Theme): FolderColors => {
  const { icon, onIcon } = FOLDER_BASE[theme]
  return { icon, onIcon, ...tints(icon, theme) }
}

// The icon tone whose contrast with its own open-folder background equals the default pair's.
const iconTone = (hue: number, chroma: number, theme: Theme) => {
  const base = folderDefaults(theme)
  const want = contrast(base.icon, base.group)
  const ratio = (light: number) => {
    const icon = tone(hue, chroma, light)
    return contrast(icon, tints(icon, theme).group)
  }
  let lo = 0
  let hi = 1
  for (let i = 0; i < STEPS; i++) {
    const mid = (lo + hi) / 2
    if (ratio(mid) < want === (theme === 'dark')) lo = mid
    else hi = mid
  }
  return tone(hue, chroma, Math.abs(ratio(hi) - want) < Math.abs(ratio(lo) - want) ? hi : lo)
}

// The badge glyph: the tone nearest the icon that reads on it like the default glyph does.
const glyphTone = (hue: number, chroma: number, icon: string, theme: Theme) => {
  const base = FOLDER_BASE[theme]
  const want = contrast(base.onIcon, base.icon)
  const reads = (light: number) => contrast(tone(hue, chroma, light), icon) >= want
  const dark = theme === 'dark'
  let near = lightnessOf(icon)
  let far = dark ? 0 : 1
  for (let i = 0; i < STEPS; i++) {
    const mid = (near + far) / 2
    if (reads(mid)) far = mid
    else near = mid
  }
  return tone(hue, chroma, far)
}

const CACHE_MAX = 200
const cache = new Map<string, FolderColors>()

export const folderColors = (pick: string, theme: Theme): FolderColors => {
  const key = `${theme}${pick.toLowerCase()}`
  const known = cache.get(key)
  if (known) return known
  const { hue, chroma } = hueChroma(pick)
  const icon = iconTone(hue, chroma, theme)
  const colors = { icon, onIcon: glyphTone(hue, chroma, icon, theme), ...tints(icon, theme) }
  if (cache.size >= CACHE_MAX) cache.clear()
  cache.set(key, colors)
  return colors
}

export type FolderStyle = Record<
  | '--folder-icon'
  | '--folder-on-icon'
  | '--folder-group'
  | '--folder-tile'
  | '--folder-hover'
  | '--folder-drop',
  string
>

export const folderStyle = (
  color: string | null | undefined,
  theme: Theme
): FolderStyle | undefined => {
  if (!validColor(color)) return undefined
  const c = folderColors(color, theme)
  return {
    '--folder-icon': c.icon,
    '--folder-on-icon': c.onIcon,
    '--folder-group': c.group,
    '--folder-tile': c.tile,
    '--folder-hover': c.hover,
    '--folder-drop': c.drop,
  }
}
