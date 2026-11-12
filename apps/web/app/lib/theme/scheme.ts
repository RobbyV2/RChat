import { contrast, hex, toHex, type Rgb } from './color'
import { hctOf, solve } from './hct'

export type Mode = 'light' | 'dark' | 'black'
export type PaletteName = 'p' | 's' | 't' | 'n' | 'nv' | 'e'
export type Role = [PaletteName, number]

export const TODAY_SEED = '#6750a4'

export interface Palettes {
  [k: string]: { hue: number; chroma: number }
}

// Tonal palettes from the accent's hue and chroma. An accent under chroma 12 is monochrome.
export const palettesOf = (seed: string): Palettes => {
  const { hue, chroma } = hctOf(hex(seed))
  const mono = chroma < 12
  return {
    p: { hue, chroma: mono ? chroma : Math.max(48, chroma) },
    s: { hue, chroma: mono ? chroma / 3 : 16 },
    t: { hue: (hue + 60) % 360, chroma: mono ? chroma / 2 : 24 },
    n: { hue, chroma: mono ? Math.min(chroma, 6) : 6 },
    nv: { hue, chroma: mono ? Math.min(chroma, 8) : 8 },
    e: { hue: 25, chroma: 84 },
  }
}

// Each token is one tone of one palette; the modes differ only in the tone.
const DARK: Record<string, Role> = {
  primary: ['p', 80],
  'on-primary': ['p', 20],
  'primary-container': ['p', 30],
  'on-primary-container': ['p', 90],
  secondary: ['s', 80],
  'on-secondary': ['s', 20],
  'secondary-container': ['s', 30],
  'on-secondary-container': ['s', 90],
  tertiary: ['t', 80],
  'on-tertiary': ['t', 20],
  'tertiary-container': ['t', 30],
  'on-tertiary-container': ['t', 90],
  surface: ['n', 6],
  'on-surface': ['n', 90],
  'surface-variant': ['nv', 30],
  'on-surface-variant': ['nv', 80],
  'surface-container-lowest': ['n', 4],
  'surface-container-low': ['n', 10],
  'surface-container': ['n', 12],
  'surface-container-high': ['n', 17],
  'surface-container-highest': ['n', 22],
  'surface-dim': ['n', 6],
  'surface-bright': ['n', 24],
  outline: ['nv', 60],
  'outline-variant': ['nv', 30],
  'inverse-surface': ['n', 90],
  'inverse-on-surface': ['n', 20],
  'inverse-primary': ['p', 40],
  spoiler: ['n', 21],
}
const LIGHT: Record<string, Role> = {
  primary: ['p', 40],
  'on-primary': ['p', 100],
  'primary-container': ['p', 90],
  'on-primary-container': ['p', 10],
  secondary: ['s', 40],
  'on-secondary': ['s', 100],
  'secondary-container': ['s', 90],
  'on-secondary-container': ['s', 10],
  tertiary: ['t', 40],
  'on-tertiary': ['t', 100],
  'tertiary-container': ['t', 90],
  'on-tertiary-container': ['t', 10],
  surface: ['n', 98],
  'on-surface': ['n', 10],
  'surface-variant': ['nv', 90],
  'on-surface-variant': ['nv', 30],
  'surface-container-lowest': ['n', 100],
  'surface-container-low': ['n', 96],
  'surface-container': ['n', 94],
  'surface-container-high': ['n', 92],
  'surface-container-highest': ['n', 90],
  'surface-dim': ['n', 87],
  'surface-bright': ['n', 98],
  outline: ['nv', 50],
  'outline-variant': ['nv', 80],
  'inverse-surface': ['n', 20],
  'inverse-on-surface': ['n', 95],
  'inverse-primary': ['p', 80],
  spoiler: ['n', 17],
}
// Black is the high-contrast look: black surfaces with each step at least 3.5 L* apart, and
// stronger text and outlines than Dark.
const BLACK: Record<string, Role> = {
  ...DARK,
  surface: ['n', 0],
  'surface-dim': ['n', 0],
  'surface-container-lowest': ['n', 0],
  'surface-container-low': ['n', 4],
  'surface-container': ['n', 8],
  'surface-container-high': ['n', 12],
  'surface-container-highest': ['n', 17],
  'surface-bright': ['n', 22],
  'surface-variant': ['nv', 22],
  'on-surface': ['n', 95],
  'inverse-surface': ['n', 95],
  outline: ['nv', 70],
  'outline-variant': ['nv', 45],
  spoiler: ['n', 17],
}
export const ROLES: Record<Mode, Record<string, Role>> = { light: LIGHT, dark: DARK, black: BLACK }

// The error family is the same in every accent.
export const FIXED: Record<Mode, Record<string, string>> = {
  dark: {
    error: '#f2b8b5',
    'on-error': '#601410',
    'error-container': '#8c1d18',
    'on-error-container': '#f9dedc',
  },
  light: {
    error: '#b3261e',
    'on-error': '#ffffff',
    'error-container': '#f9dedc',
    'on-error-container': '#410e0b',
  },
  black: {
    error: '#f2b8b5',
    'on-error': '#601410',
    'error-container': '#8c1d18',
    'on-error-container': '#f9dedc',
  },
}

// `more` is increased contrast on Light and Dark. `saturation` (0 to 1) scales every derived
// palette's chroma.
export interface DeriveOpts {
  more?: boolean
  saturation?: number
}

// Increased contrast moves text and edge tones to Black's targets, never a surface, and derives
// the error family so it can move too.
export const MORE: Record<'light' | 'dark', Record<string, Role>> = {
  light: {
    ...LIGHT,
    primary: ['p', 31],
    secondary: ['s', 30],
    tertiary: ['t', 30],
    outline: ['nv', 41],
    'outline-variant': ['nv', 57],
    error: ['e', 37],
    'on-error': ['e', 100],
    'error-container': ['e', 90],
    'on-error-container': ['e', 10],
  },
  dark: {
    ...DARK,
    'on-surface-variant': ['nv', 90],
    outline: ['nv', 66],
    'outline-variant': ['nv', 45],
    'inverse-primary': ['p', 30],
    error: ['e', 80],
    'on-error': ['e', 20],
    'error-container': ['e', 30],
    'on-error-container': ['e', 90],
  },
}

// Under increased contrast each status color takes the nearest tone that reaches 4.5:1 on
// every surface.
export const STATUS: Record<'light' | 'dark', Record<string, string>> = {
  light: { 'status-green': '#2e7d32', 'status-yellow': '#b26a00', 'status-red': '#b3261e' },
  dark: { 'status-green': '#7dd97b', 'status-yellow': '#ffd54f', 'status-red': '#f2b8b5' },
}
export const SURFACES = [
  'surface',
  'surface-container-lowest',
  'surface-container-low',
  'surface-container',
  'surface-container-high',
  'surface-container-highest',
]

const nearestPassing = (color: string, surfaces: Rgb[], min: number): string => {
  const ok = (c: Rgb) => surfaces.every(sf => contrast(c, sf) >= min)
  if (ok(hex(color))) return color
  const { hue, chroma, tone } = hctOf(hex(color))
  for (let d = 1; d <= 100; d++)
    for (const t of [tone - d, tone + d]) {
      if (t < 0 || t > 100) continue
      const c = solve(hue, chroma, t)
      if (ok(c)) return toHex(c)
    }
  return color
}

const scaled = (pal: Palettes, saturation: number): Palettes => {
  if (saturation >= 1) return pal
  const out: Palettes = {}
  for (const [k, v] of Object.entries(pal))
    out[k] = k === 'e' ? v : { hue: v.hue, chroma: v.chroma * Math.max(0, saturation) }
  return out
}

export const tokens = (
  seed: string,
  mode: Mode,
  outline?: OutlineChoice,
  opts: DeriveOpts = {}
): Record<string, string> => {
  const pal = scaled(palettesOf(seed), opts.saturation ?? 1)
  const more = opts.more === true && mode !== 'black'
  const roles = more ? MORE[mode as 'light' | 'dark'] : ROLES[mode]
  const out: Record<string, string> = more ? {} : { ...FIXED[mode] }
  for (const [name, [p, tone]] of Object.entries(roles))
    out[name] = toHex(solve(pal[p].hue, pal[p].chroma, tone))
  if (more) {
    const surfaces = SURFACES.map(k => hex(out[k]))
    for (const [k, v] of Object.entries(STATUS[mode as 'light' | 'dark']))
      out[k] = nearestPassing(v, surfaces, 4.5)
  }
  if (mode === 'black') {
    out.focus = out.primary
    if (outline) out.outline = outlineFor(seed, outline).color
  }
  return out
}

// The width in px of Black's control outline.
export const outlineWidth = (asked: unknown): 1 | 2 | 3 => (asked === 2 || asked === 3 ? asked : 1)

export type OutlineChoice =
  | { kind: 'preset'; id: 'neutral' | 'accent' | 'white' | 'yellow' | 'cyan' }
  | { kind: 'custom'; color: string }

export const OUTLINE_MIN = 4.5

const PRESET: Record<'white' | 'yellow' | 'cyan', string> = {
  white: '#ffffff',
  yellow: '#ffd600',
  cyan: '#00e5ff',
}

const blackSurfaces = (seed: string) => {
  const pal = palettesOf(seed)
  return BLACK_SURFACES.map(k => solve(pal.n.hue, pal.n.chroma, BLACK[k][1]))
}

const passes = (c: Rgb, surfaces: Rgb[]) => surfaces.every(sf => contrast(c, sf) >= OUTLINE_MIN)

// The outline color in Black. A pick under 4.5:1 on any Black surface keeps its hue and chroma
// and is raised in tone until it passes.
export const outlineFor = (
  seed: string,
  choice: OutlineChoice
): { color: string; adjusted: boolean } => {
  const pal = palettesOf(seed)
  const want: Rgb =
    choice.kind === 'custom'
      ? hex(choice.color)
      : choice.id === 'neutral'
        ? solve(pal.nv.hue, pal.nv.chroma, 70)
        : choice.id === 'accent'
          ? solve(pal.p.hue, pal.p.chroma, 70)
          : hex(PRESET[choice.id])
  const surfaces = blackSurfaces(seed)
  if (passes(want, surfaces)) return { color: toHex(want), adjusted: false }
  const { hue, chroma, tone } = hctOf(want)
  for (let t = Math.ceil(tone); t <= 100; t++) {
    const c = solve(hue, chroma, t)
    if (passes(c, surfaces)) return { color: toHex(c), adjusted: true }
  }
  return { color: '#ffffff', adjusted: true }
}

export type ModeSetting = 'light' | 'dark' | 'black' | 'device'
export interface Device {
  moreContrast: boolean
  forcedColors: boolean
  prefersLight: boolean
}
export interface Resolved {
  mode: Mode
  more: boolean
}

// What a mode setting shows on a device; `manualMore` is increased contrast set by hand.
export const resolveMode = (setting: ModeSetting, d: Device, manualMore = false): Resolved => {
  if (setting === 'black') return { mode: 'black', more: false }
  if (setting !== 'device') return { mode: setting, more: manualMore }
  if (d.forcedColors) return { mode: 'black', more: false }
  if (d.moreContrast)
    return d.prefersLight ? { mode: 'light', more: true } : { mode: 'black', more: false }
  return { mode: d.prefersLight ? 'light' : 'dark', more: manualMore }
}

export interface LookV2 {
  v: 2
  mode: ModeSetting
  light: string
  dark: string
  black: string
  accent: string
  outline: OutlineChoice
}
export const DEFAULT_LOOK: LookV2 = {
  v: 2,
  mode: 'dark',
  light: 'core.standard',
  dark: 'core.standard',
  black: 'core.standard',
  accent: TODAY_SEED,
  outline: { kind: 'preset', id: 'neutral' },
}

const COLOR = /^#[0-9a-f]{6}$/i
const MODES: ModeSetting[] = ['light', 'dark', 'black', 'device']
const OUTLINES = ['neutral', 'accent', 'white', 'yellow', 'cyan']

// The stored look. Version 1 kept Black as the dark theme `core.black`.
export const parseLook = (raw: string | null, legacyTheme: string | null): LookV2 => {
  const base: LookV2 = { ...DEFAULT_LOOK, mode: legacyTheme === 'light' ? 'light' : 'dark' }
  let x: unknown
  try {
    x = raw ? JSON.parse(raw) : null
  } catch {
    return base
  }
  if (typeof x !== 'object' || x === null) return base
  const o = x as Record<string, unknown>
  const str = (v: unknown, d: string) => (typeof v === 'string' && v.length <= 200 ? v : d)
  const accent =
    typeof o.accent === 'string' && COLOR.test(o.accent) ? o.accent.toLowerCase() : TODAY_SEED
  const mode = MODES.includes(o.mode as ModeSetting) ? (o.mode as ModeSetting) : base.mode
  if (o.v === 1) {
    const wasBlack = o.dark === 'core.black'
    return {
      ...base,
      accent,
      mode: wasBlack && mode === 'dark' ? 'black' : mode,
      light: str(o.light, 'core.standard'),
      dark: wasBlack ? 'core.standard' : str(o.dark, 'core.standard'),
    }
  }
  if (o.v !== 2) return base
  const oc = o.outline as Record<string, unknown> | undefined
  const outline: OutlineChoice =
    oc && oc.kind === 'custom' && typeof oc.color === 'string' && COLOR.test(oc.color)
      ? { kind: 'custom', color: oc.color.toLowerCase() }
      : oc && oc.kind === 'preset' && OUTLINES.includes(oc.id as string)
        ? { kind: 'preset', id: oc.id as 'neutral' }
        : DEFAULT_LOOK.outline
  return {
    v: 2,
    accent,
    outline,
    mode,
    light: str(o.light, 'core.standard'),
    dark: str(o.dark, 'core.standard'),
    black: str(o.black, 'core.standard'),
  }
}

// Today's values in globals.css: dark in @theme, light under [data-theme='light'].
export const TODAY: Record<'light' | 'dark', Record<string, string>> = {
  dark: {
    primary: '#d0bcff',
    'on-primary': '#381e72',
    'primary-container': '#4f378b',
    'on-primary-container': '#eaddff',
    secondary: '#ccc2dc',
    'on-secondary': '#332d41',
    'secondary-container': '#4a4458',
    'on-secondary-container': '#e8def8',
    tertiary: '#efb8c8',
    'on-tertiary': '#492532',
    'tertiary-container': '#633b48',
    'on-tertiary-container': '#ffd8e4',
    error: '#f2b8b5',
    'on-error': '#601410',
    'error-container': '#8c1d18',
    'on-error-container': '#f9dedc',
    surface: '#141218',
    'on-surface': '#e6e0e9',
    'surface-variant': '#49454f',
    'on-surface-variant': '#cac4d0',
    'surface-container-lowest': '#0f0d13',
    'surface-container-low': '#1d1b20',
    'surface-container': '#211f26',
    'surface-container-high': '#2b2930',
    'surface-container-highest': '#36343b',
    'surface-dim': '#141218',
    'surface-bright': '#3b383e',
    outline: '#938f99',
    'outline-variant': '#49454f',
    'inverse-surface': '#e6e0e9',
    'inverse-on-surface': '#322f35',
    'inverse-primary': '#6750a4',
    spoiler: '#34313a',
  },
  light: {
    primary: '#6750a4',
    'on-primary': '#ffffff',
    'primary-container': '#eaddff',
    'on-primary-container': '#21005d',
    secondary: '#625b71',
    'on-secondary': '#ffffff',
    'secondary-container': '#e8def8',
    'on-secondary-container': '#1d192b',
    tertiary: '#7d5260',
    'on-tertiary': '#ffffff',
    'tertiary-container': '#ffd8e4',
    'on-tertiary-container': '#31111d',
    error: '#b3261e',
    'on-error': '#ffffff',
    'error-container': '#f9dedc',
    'on-error-container': '#410e0b',
    surface: '#fef7ff',
    'on-surface': '#1d1b20',
    'surface-variant': '#e7e0ec',
    'on-surface-variant': '#49454f',
    'surface-container-lowest': '#ffffff',
    'surface-container-low': '#f7f2fa',
    'surface-container': '#f3edf7',
    'surface-container-high': '#ece6f0',
    'surface-container-highest': '#e6e0e9',
    'surface-dim': '#ded8e1',
    'surface-bright': '#fef7ff',
    outline: '#79747e',
    'outline-variant': '#cac4d0',
    'inverse-surface': '#322f35',
    'inverse-on-surface': '#f5eff7',
    'inverse-primary': '#d0bcff',
    spoiler: '#2b2930',
  },
}

// Light and Dark keep text pairs at 4.5:1 and the pairs of UI_PAIRS at 3:1.
export const TEXT_PAIRS: [string, string][] = [
  ['on-primary', 'primary'],
  ['on-primary-container', 'primary-container'],
  ['on-secondary', 'secondary'],
  ['on-secondary-container', 'secondary-container'],
  ['on-tertiary', 'tertiary'],
  ['on-tertiary-container', 'tertiary-container'],
  ['on-error', 'error'],
  ['on-error-container', 'error-container'],
  ['on-surface', 'surface'],
  ['on-surface-variant', 'surface'],
  ['on-surface', 'surface-container-lowest'],
  ['on-surface', 'surface-container-low'],
  ['on-surface', 'surface-container'],
  ['on-surface', 'surface-container-high'],
  ['on-surface', 'surface-container-highest'],
  ['on-surface-variant', 'surface-container-highest'],
  ['on-surface-variant', 'surface-variant'],
  ['inverse-on-surface', 'inverse-surface'],
  ['primary', 'surface'],
  ['primary', 'surface-container'],
  ['primary', 'surface-container-high'],
]
export const UI_PAIRS: [string, string][] = [
  ['outline', 'surface'],
  ['outline', 'surface-container'],
  ['outline', 'surface-container-high'],
  ['primary', 'surface-container-highest'],
]

// Black keeps text pairs at 7:1, the outline and focus at OUTLINE_MIN on every surface below,
// and dividers at 3:1 on the surface.
export const BLACK_TEXT_MIN = 7
export const BLACK_SURFACES = [
  'surface',
  'surface-container-low',
  'surface-container',
  'surface-container-high',
  'surface-container-highest',
  'surface-bright',
]

// What the app applies. The default accent in Light and Dark is today's literal table, unless
// increased contrast or a saturation below 1 moves it.
export const schemeFor = (
  seed: string,
  mode: Mode,
  outline: OutlineChoice = DEFAULT_LOOK.outline,
  opts: DeriveOpts = {}
): Record<string, string> => {
  const plain = opts.more !== true && (opts.saturation ?? 1) >= 1
  return seed.toLowerCase() === TODAY_SEED && mode !== 'black' && plain
    ? { ...TODAY[mode] }
    : tokens(seed, mode, mode === 'black' ? outline : undefined, opts)
}
