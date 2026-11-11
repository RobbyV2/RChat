// The vintage style's tokens. It re-maps every Material token the app already uses (so every
// component keeps working) and adds the bevel, title-bar and dither tokens its own CSS uses.
// Light is the 1995-98 desktop (silver windows, navy title bars, teal desktop); dark is the
// late-90s homepage at night (black, navy, cyan links, yellow highlights).

export type Tokens = Record<string, string>

export const VINTAGE_LIGHT: Tokens = {
  '--color-primary': '#000080',
  '--color-on-primary': '#ffffff',
  '--color-primary-container': '#000080',
  '--color-on-primary-container': '#ffffff',
  '--color-secondary': '#006060',
  '--color-on-secondary': '#ffffff',
  '--color-secondary-container': '#000080',
  '--color-on-secondary-container': '#ffffff',
  '--color-tertiary': '#800080',
  '--color-on-tertiary': '#ffffff',
  '--color-tertiary-container': '#ffccff',
  '--color-on-tertiary-container': '#400040',
  '--color-error': '#b00000',
  '--color-on-error': '#ffffff',
  '--color-error-container': '#ffd0d0',
  '--color-on-error-container': '#600000',
  '--color-surface': '#ffffff',
  '--color-on-surface': '#000000',
  '--color-surface-variant': '#c0c0c0',
  '--color-on-surface-variant': '#303030',
  '--color-surface-container-lowest': '#ffffff',
  '--color-surface-container-low': '#c0c0c0',
  '--color-surface-container': '#c0c0c0',
  '--color-surface-container-high': '#d4d0c8',
  '--color-surface-container-highest': '#dfdfdf',
  '--color-surface-dim': '#a0a0a0',
  '--color-surface-bright': '#ffffff',
  '--color-outline': '#505050',
  '--color-outline-variant': '#808080',
  '--color-inverse-surface': '#000080',
  '--color-inverse-on-surface': '#ffffff',
  '--color-inverse-primary': '#00ffff',
  '--color-scrim': '#000000',
  '--color-spoiler': '#000000',
  '--color-status-green': '#006400',
  '--color-status-yellow': '#806000',
  '--color-status-red': '#b00000',
  '--color-danger': '#b00000',
  '--color-on-danger': '#ffffff',
  '--color-mute': '#b00000',
  '--color-on-mute': '#ffffff',
  '--color-mute-hover': '#800000',
  '--color-mute-fg': '#b00000',
  '--color-code-blue': '#0000c0',
  '--color-code-orange': '#804000',
  // Vintage-only.
  '--vt-face': '#c0c0c0',
  '--vt-light': '#ffffff',
  '--vt-hi': '#dfdfdf',
  '--vt-shade': '#808080',
  '--vt-dark': '#000000',
  '--vt-title-from': '#000080',
  // The 1998 gradient ends at #1084d0, which gives white text only 4.0:1.
  '--vt-title-to': '#0a6ab8',
  '--vt-title-text': '#ffffff',
  '--vt-title-off-from': '#606060',
  '--vt-title-off-to': '#707070',
  '--vt-title-off-text': '#ffffff',
  '--vt-desktop': '#008080',
  '--vt-desktop-text': '#ffffff',
  '--vt-dither-a': '#008080',
  '--vt-dither-b': '#007070',
  '--vt-link': '#0000ee',
  '--vt-visited': '#551a8b',
  '--vt-focus': '#000000',
  '--vt-marquee': '#000080',
}

export const VINTAGE_DARK: Tokens = {
  '--color-primary': '#00ffff',
  '--color-on-primary': '#000000',
  '--color-primary-container': '#000080',
  '--color-on-primary-container': '#ffffff',
  '--color-secondary': '#00ff00',
  '--color-on-secondary': '#000000',
  '--color-secondary-container': '#000080',
  '--color-on-secondary-container': '#ffff00',
  '--color-tertiary': '#ff66ff',
  '--color-on-tertiary': '#000000',
  '--color-tertiary-container': '#400040',
  '--color-on-tertiary-container': '#ffccff',
  '--color-error': '#ff6060',
  '--color-on-error': '#000000',
  '--color-error-container': '#600000',
  '--color-on-error-container': '#ffd0d0',
  '--color-surface': '#000000',
  '--color-on-surface': '#e0e0e0',
  '--color-surface-variant': '#24244a',
  '--color-on-surface-variant': '#b8b8d0',
  '--color-surface-container-lowest': '#000000',
  '--color-surface-container-low': '#0b0b18',
  '--color-surface-container': '#10102a',
  '--color-surface-container-high': '#1a1a3a',
  '--color-surface-container-highest': '#24244a',
  '--color-surface-dim': '#000000',
  '--color-surface-bright': '#2c2c58',
  '--color-outline': '#8888aa',
  '--color-outline-variant': '#404060',
  '--color-inverse-surface': '#e0e0e0',
  '--color-inverse-on-surface': '#000000',
  '--color-inverse-primary': '#000080',
  '--color-scrim': '#000000',
  '--color-spoiler': '#24244a',
  '--color-status-green': '#00ff00',
  '--color-status-yellow': '#ffff00',
  '--color-status-red': '#ff6060',
  '--color-danger': '#d00000',
  '--color-on-danger': '#ffffff',
  '--color-mute': '#d00000',
  '--color-on-mute': '#ffffff',
  '--color-mute-hover': '#a00000',
  '--color-mute-fg': '#ff6060',
  '--color-code-blue': '#80c0ff',
  '--color-code-orange': '#ffb060',
  '--vt-face': '#24244a',
  '--vt-light': '#7070a8',
  '--vt-hi': '#3a3a6a',
  '--vt-shade': '#101028',
  '--vt-dark': '#000000',
  '--vt-title-from': '#000080',
  '--vt-title-to': '#800080',
  '--vt-title-text': '#ffff00',
  '--vt-title-off-from': '#202040',
  '--vt-title-off-to': '#303060',
  '--vt-title-off-text': '#a0a0c0',
  '--vt-desktop': '#000000',
  '--vt-desktop-text': '#e0e0e0',
  '--vt-dither-a': '#000000',
  '--vt-dither-b': '#0b0b24',
  '--vt-link': '#00ffff',
  '--vt-visited': '#ff66ff',
  '--vt-focus': '#ffff00',
  '--vt-marquee': '#ffff00',
}

const lin = (c: number) => {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
export const luminance = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
}
export const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

// The pairs the app draws text or controls with, and the minimum each needs (WCAG 2.2: 4.5 for
// text, 3 for large text, icons, borders and focus rings).
export const PAIRS: [string, string, number][] = [
  ...(
    [
      '--color-surface',
      '--color-surface-container-lowest',
      '--color-surface-container-low',
      '--color-surface-container',
      '--color-surface-container-high',
      '--color-surface-container-highest',
      '--color-surface-variant',
    ] as const
  ).flatMap(bg => [
    ['--color-on-surface', bg, 4.5] as [string, string, number],
    ['--color-on-surface-variant', bg, 4.5] as [string, string, number],
    ['--color-primary', bg, 3] as [string, string, number],
  ]),
  ['--color-primary', '--color-surface', 4.5],
  ['--color-on-primary', '--color-primary', 4.5],
  ['--color-on-primary-container', '--color-primary-container', 4.5],
  ['--color-on-secondary', '--color-secondary', 4.5],
  ['--color-on-secondary-container', '--color-secondary-container', 4.5],
  ['--color-on-tertiary', '--color-tertiary', 4.5],
  ['--color-on-tertiary-container', '--color-tertiary-container', 4.5],
  ['--color-error', '--color-surface', 4.5],
  ['--color-on-error', '--color-error', 4.5],
  ['--color-on-error-container', '--color-error-container', 4.5],
  ['--color-on-danger', '--color-danger', 4.5],
  ['--color-on-mute', '--color-mute', 4.5],
  ['--color-mute-fg', '--color-surface', 4.5],
  ['--color-inverse-on-surface', '--color-inverse-surface', 4.5],
  ['--color-outline', '--color-surface', 3],
  ['--color-outline', '--color-surface-container', 3],
  ['--color-status-green', '--color-surface', 3],
  ['--color-status-yellow', '--color-surface', 3],
  ['--color-status-red', '--color-surface', 3],
  ['--color-code-blue', '--color-surface-container-high', 4.5],
  ['--color-code-orange', '--color-surface-container-high', 4.5],
  ['--vt-title-text', '--vt-title-from', 4.5],
  ['--vt-title-text', '--vt-title-to', 4.5],
  ['--vt-title-off-text', '--vt-title-off-from', 4.5],
  ['--vt-title-off-text', '--vt-title-off-to', 4.5],
  ['--vt-link', '--color-surface', 4.5],
  ['--vt-visited', '--color-surface', 4.5],
  ['--vt-focus', '--color-surface', 3],
  ['--vt-focus', '--vt-face', 3],
  ['--color-on-surface', '--vt-face', 4.5],
  ['--vt-marquee', '--color-surface', 4.5],
  // Text on the dithered desktop (empty states sit on it).
  ['--vt-desktop-text', '--vt-dither-a', 4.5],
  ['--vt-desktop-text', '--vt-dither-b', 4.5],
  ['--vt-desktop-text', '--vt-desktop', 4.5],
]

export const pairsFor = (t: Tokens) =>
  PAIRS.map(([fg, bg, min]) => ({ fg, bg, min, ratio: contrast(t[fg], t[bg]) }))

// The two-pixel bevels (raised and sunken) as box-shadows, like the 1995 controls.
export const BEVEL = {
  raised:
    'inset -1px -1px var(--vt-dark), inset 1px 1px var(--vt-light), inset -2px -2px var(--vt-shade), inset 2px 2px var(--vt-hi)',
  sunken:
    'inset -1px -1px var(--vt-light), inset 1px 1px var(--vt-shade), inset -2px -2px var(--vt-hi), inset 2px 2px var(--vt-dark)',
  pressed:
    'inset -1px -1px var(--vt-light), inset 1px 1px var(--vt-dark), inset -2px -2px var(--vt-hi), inset 2px 2px var(--vt-shade)',
  window:
    'inset -1px -1px var(--vt-dark), inset 1px 1px var(--vt-hi), inset -2px -2px var(--vt-shade), inset 2px 2px var(--vt-light)',
} as const

// The 2x2 checker dither, from two tokens; no image file.
export const DITHER =
  'repeating-conic-gradient(var(--vt-dither-a) 0 25%, var(--vt-dither-b) 0 50%) 0 0 / 2px 2px'

// Fonts. The vintage style keeps the standard body font; the pixel faces appear
// only on title bars, dialog titles and the web-button wall. Pixelify Sans gets `@font-face`
// metric overrides so it sets text at the standard face's average width and line box (Roboto's,
// the first face of `--font-sans`), so a title takes the space it took before. Silkscreen is
// only on the web buttons, which have their own minimum box.
export interface FontMetrics {
  upm: number
  ascent: number
  descent: number
  lineGap: number
  avgWidth: number
}

export interface FaceOverrides {
  sizeAdjust: number
  ascentOverride: number
  descentOverride: number
  lineGapOverride: number
}

// The face scaled to the target's average advance; ascent, descent and line gap given as
// percentages of the used size, which `size-adjust` scales again (hence the division).
export function faceOverrides(face: FontMetrics, target: FontMetrics): FaceOverrides {
  const sizeAdjust = target.avgWidth / target.upm / (face.avgWidth / face.upm)
  return {
    sizeAdjust,
    ascentOverride: target.ascent / target.upm / sizeAdjust,
    descentOverride: Math.abs(target.descent) / target.upm / sizeAdjust,
    lineGapOverride: target.lineGap / target.upm / sizeAdjust,
  }
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`
export const fontFaceCss = (family: string, src: string, o: FaceOverrides) =>
  `@font-face { font-family: '${family}'; src: url(${src}) format('woff2'); font-display: swap; ` +
  `size-adjust: ${pct(o.sizeAdjust)}; ascent-override: ${pct(o.ascentOverride)}; ` +
  `descent-override: ${pct(o.descentOverride)}; line-gap-override: ${pct(o.lineGapOverride)}; }`

// Where the pixel faces may be used; everything else keeps `--font-sans`.
export const PIXEL_FACE_TARGETS = ['title bars', 'dialog titles', 'the web-button wall'] as const

// Forced colors: an inset outline in place of the bevel shadows; a border would add 2 px to
// every auto-sized box.
export const FORCED_COLORS_BEVEL = 'outline: 1px solid ButtonBorder; outline-offset: -1px;'
