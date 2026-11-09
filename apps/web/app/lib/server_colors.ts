import { validColor } from './profile'

export const ON_DARK = '#ffffff'
export const ON_LIGHT = '#000000'
export const MIN_CONTRAST = 4.5
// Focus rings and other non-text parts (WCAG 1.4.11).
export const MIN_NON_TEXT = 3
export const THEME_SURFACES = { dark: '#1d1b20', light: '#f7f2fa' } as const
export const THEME_ON_SURFACE = { dark: '#e6e0e9', light: '#1d1b20' } as const
// The gear on a banner sits on a chip of the theme's surface-container-high, mostly opaque.
export const THEME_CHIP = { dark: '#2b2930', light: '#ece6f0' } as const
export const GEAR_CHIP_ALPHA = 0.85
export const GEAR_CHIP_CSS = `color-mix(in srgb, var(--color-surface-container-high) ${Math.round(GEAR_CHIP_ALPHA * 100)}%, transparent)`

export const BANNER_PRESETS = [
  { color: '#4f46b8', label: 'Indigo' },
  { color: '#1d6b86', label: 'Deep teal' },
  { color: '#2f7a4f', label: 'Forest' },
  { color: '#b4471b', label: 'Ember' },
  { color: '#b0245e', label: 'Raspberry' },
  { color: '#262a33', label: 'Graphite' },
  { color: '#e9ddff', label: 'Lavender' },
  { color: '#ffe8a3', label: 'Butter' },
]

export const NAME_PRESETS = [
  { color: '#ffffff', label: 'White' },
  { color: '#1b1b1f', label: 'Ink' },
  { color: '#ffd166', label: 'Gold' },
  { color: '#9ff0c8', label: 'Mint' },
  { color: '#c3c8ff', label: 'Periwinkle' },
  { color: '#ffb3c1', label: 'Blush' },
]

const hexRgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
]

const toHex = (rgb: number[]) =>
  `#${rgb
    .map(c =>
      Math.round(Math.max(0, Math.min(255, c)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`

export const luminance = (hex: string) => {
  const [r, g, b] = hexRgb(hex).map(c => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

export const mix = (from: string, to: string, amount: number) => {
  const a = hexRgb(from)
  const b = hexRgb(to)
  return toHex(a.map((c, i) => c + (b[i] - c) * amount))
}

export const onColor = (bg: string) =>
  contrast(bg, ON_DARK) >= contrast(bg, ON_LIGHT) ? ON_DARK : ON_LIGHT

// The gear's focus ring sits on the banner, so it takes the banner's text color.
export const gearRing = (banner: string) => onColor(banner)

// What the chip looks like over a banner.
export const gearChip = (theme: keyof typeof THEME_CHIP, banner: string) =>
  mix(banner, THEME_CHIP[theme], GEAR_CHIP_ALPHA)

export interface HeaderColors {
  bg: string | null
  fg: string | null
  gear: string | null
}

export const headerColors = (
  banner: string | null | undefined,
  name: string | null | undefined
): HeaderColors | null => {
  const bg = validColor(banner) ? banner.toLowerCase() : null
  const custom = validColor(name) ? name.toLowerCase() : null
  if (!bg && !custom) return null
  const gear = bg ? gearRing(bg) : null
  return { bg, fg: custom ?? gear, gear }
}

const ratio = (value: number) => `${(Math.floor(value * 10) / 10).toFixed(1)}:1`

export const contrastWarning = (
  banner: string | null | undefined,
  name: string | null | undefined
) => {
  if (!validColor(name)) return null
  if (validColor(banner)) {
    const value = contrast(banner, name)
    return value < MIN_CONTRAST
      ? `The name is hard to read on this banner (${ratio(value)}, aim for at least 4.5:1).`
      : null
  }
  const failing = (['dark', 'light'] as const)
    .map(theme => ({ theme, value: contrast(THEME_SURFACES[theme], name) }))
    .filter(t => t.value < MIN_CONTRAST)
  if (failing.length === 0) return null
  const where = failing.map(t => `the ${t.theme} theme (${ratio(t.value)})`).join(' and ')
  return `Without a banner, the name is hard to read in ${where}. Aim for at least 4.5:1, or pick a banner.`
}
