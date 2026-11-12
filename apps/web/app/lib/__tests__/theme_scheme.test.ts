import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { channelDiff, contrast, hex, lstar, toHex } from '../theme/color'
import { hctOf, solve } from '../theme/hct'
import {
  BLACK_SURFACES,
  BLACK_TEXT_MIN,
  DEFAULT_LOOK,
  FIXED,
  MORE,
  OUTLINE_MIN,
  ROLES,
  STATUS,
  SURFACES,
  TEXT_PAIRS,
  TODAY,
  TODAY_SEED,
  UI_PAIRS,
  outlineFor,
  outlineWidth,
  palettesOf,
  parseLook,
  resolveMode,
  schemeFor,
  tokens,
  type DeriveOpts,
  type Mode,
  type OutlineChoice,
} from '../theme/scheme'
import vectors from './fixtures/theme_vectors.json'

type Tokens = Record<string, string>

const SEEDS = vectors.sweep.seeds

// The sweeps derive 296 accents many times over; each derivation is done once.
setDefaultTimeout(60_000)
const derived = new Map<string, Tokens>()
const sweep = (seed: string, mode: Mode, outline?: OutlineChoice, opts?: DeriveOpts): Tokens => {
  const key = JSON.stringify([seed, mode, outline ?? null, opts ?? null])
  const got = derived.get(key) ?? tokens(seed, mode, outline, opts)
  derived.set(key, got)
  return got
}
const SATURATION = vectors.saturation as unknown as {
  seed: string
  mode: Mode
  saturation: number
  more: boolean
  tokens: Tokens
}[]
const PRESETS: OutlineChoice[] = (['neutral', 'accent', 'white', 'yellow', 'cyan'] as const).map(
  id => ({ kind: 'preset', id })
)
const ratio = (t: Tokens, fg: string, bg: string) => contrast(hex(t[fg]), hex(t[bg]))
const r2 = (n: number) => Math.round(n * 100) / 100
const least = (xs: number[]) => xs.reduce((a, b) => Math.min(a, b), Infinity)

const line = (t: Tokens) =>
  Object.keys(t)
    .sort()
    .map(k => `${k}:${t[k]}`)
    .join(',')
const digest = (rows: string[]) => createHash('sha256').update(rows.join('\n')).digest('hex')

describe('palettes from the accent', () => {
  test('a colorful accent: primary keeps at least chroma 48, the rest are fixed', () => {
    const { hue, chroma } = hctOf(hex('#0061a4'))
    const p = palettesOf('#0061a4')
    expect(p.p).toEqual({ hue, chroma: Math.max(48, chroma) })
    expect(p.s).toEqual({ hue, chroma: 16 })
    expect(p.t).toEqual({ hue: (hue + 60) % 360, chroma: 24 })
    expect(p.n).toEqual({ hue, chroma: 6 })
    expect(p.nv).toEqual({ hue, chroma: 8 })
    expect(p.e).toEqual({ hue: 25, chroma: 84 })
    expect(palettesOf('#ff0000').p.chroma).toBeGreaterThan(48)
  })

  test('an accent under chroma 12 gives a monochrome scheme', () => {
    const { hue, chroma } = hctOf(hex('#5e5e62'))
    expect(chroma).toBeLessThan(12)
    const p = palettesOf('#5e5e62')
    expect(p.p).toEqual({ hue, chroma })
    expect(p.s).toEqual({ hue, chroma: chroma / 3 })
    expect(p.t).toEqual({ hue: (hue + 60) % 360, chroma: chroma / 2 })
    expect(p.n).toEqual({ hue, chroma: Math.min(chroma, 6) })
    expect(p.nv).toEqual({ hue, chroma: Math.min(chroma, 8) })
  })
})

describe('today from the seed', () => {
  for (const mode of ['dark', 'light'] as const) {
    test(`${mode}: every derived token is within 3 per channel of today's`, () => {
      const got = tokens(TODAY_SEED, mode)
      for (const [name, want] of Object.entries(TODAY[mode])) {
        const d = channelDiff(hex(got[name]), hex(want))
        if (d > 3) throw new Error(`${mode} ${name}: ${got[name]} vs ${want} (${d})`)
      }
    })
  }

  test('the 58 derived tokens come out as recorded: 26 exact, at most 3 off', () => {
    const rows = vectors.report as [Mode, string, string, string, number, number][]
    expect(rows).toHaveLength(58)
    let exact = 0
    let worst = 0
    for (const [mode, name, today, derived, diff] of rows) {
      if (TODAY[mode as 'light' | 'dark'][name] !== today) throw new Error(`${mode} ${name} today`)
      const got = tokens(TODAY_SEED, mode)[name]
      if (got !== derived) throw new Error(`${mode} ${name}: ${got} vs ${derived}`)
      if (diff === 0) exact++
      worst = Math.max(worst, channelDiff(hex(got), hex(today)))
    }
    expect(exact).toBe(26)
    expect(worst).toBe(3)
  })
})

describe("today's stylesheet", () => {
  const css = readFileSync(fileURLToPath(new URL('../../globals.css', import.meta.url)), 'utf8')
  const block = (start: string): Tokens => {
    const from = css.indexOf(start)
    if (from < 0) throw new Error(`No ${start} block in globals.css`)
    const text = css.slice(from, css.indexOf('\n}', from))
    return Object.fromEntries(
      [...text.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6});/g)].map(m => [m[1], m[2]])
    )
  }
  const SHEET = { dark: block('@theme {'), light: block(":root[data-theme='light'] {") }

  for (const mode of ['dark', 'light'] as const) {
    test(`${mode}: the default accent is exactly the literal token table`, () => {
      const got = schemeFor(TODAY_SEED, mode)
      expect(Object.keys(got)).toHaveLength(33)
      for (const [name, value] of Object.entries(got))
        if (SHEET[mode][name] !== value)
          throw new Error(`${mode} ${name}: ${value} vs ${SHEET[mode][name]}`)
    })

    test(`${mode}: the error family and the status colors are the stylesheet's`, () => {
      for (const [name, value] of Object.entries({ ...FIXED[mode], ...STATUS[mode] }))
        if (SHEET[mode][name] !== value) throw new Error(`${mode} ${name}`)
    })
  }

  test('Black keeps the dark error family', () => {
    expect(FIXED.black).toEqual(FIXED.dark)
  })
})

describe('contrast over a grid of accent colors', () => {
  test('the grid has 296 accents', () => {
    expect(SEEDS).toHaveLength(296)
  })

  for (const mode of ['light', 'dark', 'black'] as Mode[]) {
    test(`${mode}: text pairs at least 4.5:1, outlines at least 3:1`, () => {
      for (const seed of SEEDS) {
        const t = sweep(seed, mode)
        for (const [fg, bg] of TEXT_PAIRS) {
          const r = ratio(t, fg, bg)
          if (r < 4.5) throw new Error(`${mode} ${seed} ${fg}/${bg} ${r.toFixed(2)}`)
        }
        for (const [fg, bg] of UI_PAIRS) {
          const r = ratio(t, fg, bg)
          if (r < 3) throw new Error(`${mode} ${seed} ${fg}/${bg} ${r.toFixed(2)}`)
        }
      }
    })
  }

  test('the weakest pairs are the recorded ones: light 5.23 and 3.63, dark 5.44 and 4.49', () => {
    for (const mode of ['light', 'dark'] as const) {
      const all = SEEDS.map(seed => sweep(seed, mode))
      const text = least(all.flatMap(t => TEXT_PAIRS.map(([fg, bg]) => ratio(t, fg, bg))))
      const ui = least(all.flatMap(t => UI_PAIRS.map(([fg, bg]) => ratio(t, fg, bg))))
      expect({ text: r2(text), ui: r2(ui) }).toEqual(vectors.sweep.worst[mode])
    }
    expect(vectors.sweep.worst.light).toEqual({ text: 5.23, ui: 3.63 })
    expect(vectors.sweep.worst.dark).toEqual({ text: 5.44, ui: 4.49 })
  })

  test('every token of every accent is the recorded one, in all three modes', () => {
    for (const mode of ['light', 'dark', 'black'] as const)
      expect(digest(SEEDS.map(seed => line(sweep(seed, mode))))).toBe(vectors.sweep.digests[mode])
  })
})

describe('the accent presets', () => {
  test('Purple, Blue, Teal, Green, Amber, Orange, Rose and Gray', () => {
    expect(vectors.presets.map(p => `${p.name} ${p.seed}`)).toEqual([
      'Purple #6750a4',
      'Blue #0061a4',
      'Teal #006a6a',
      'Green #386a20',
      'Amber #7c5800',
      'Orange #8b5000',
      'Rose #984061',
      'Gray #5e5e62',
    ])
  })

  for (const mode of ['light', 'dark', 'black'] as const)
    test(`${mode}: each preset derives its recorded tokens`, () => {
      for (const p of vectors.presets) {
        const got = tokens(p.seed, mode)
        const want: Tokens = p[mode]
        expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort())
        for (const [name, value] of Object.entries(want))
          if (got[name] !== value) throw new Error(`${p.name} ${mode} ${name}: ${got[name]}`)
      }
    })
})

describe('black', () => {
  test('surfaces are black and elevation steps stay apart', () => {
    const t = tokens(TODAY_SEED, 'black')
    expect(t.surface).toBe('#000000')
    expect(t['surface-container-lowest']).toBe('#000000')
    const steps = [
      'surface-container-low',
      'surface-container',
      'surface-container-high',
      'surface-container-highest',
    ].map(k => lstar(hex(t[k])))
    for (let i = 1; i < steps.length; i++)
      expect(steps[i] - steps[i - 1]).toBeGreaterThanOrEqual(3.5)
    expect(ROLES.black.primary).toEqual(ROLES.dark.primary)
  })
})

describe('migration (light and dark stay exactly today)', () => {
  test("the default accent gives exactly today's light and dark tokens", () => {
    expect(schemeFor('#6750A4', 'dark')).toEqual(TODAY.dark)
    expect(schemeFor('#6750a4', 'light')).toEqual(TODAY.light)
  })

  test('black and other accents are derived', () => {
    expect(schemeFor('#6750a4', 'black').surface).toBe('#000000')
    expect(schemeFor('#6750a4', 'black')['on-surface']).not.toBe(TODAY.dark['on-surface'])
    expect(schemeFor('#0061a4', 'dark').primary).not.toBe(TODAY.dark.primary)
  })

  test("the returned table is a copy, so a caller can't change today's", () => {
    schemeFor(TODAY_SEED, 'dark').primary = '#000000'
    expect(schemeFor(TODAY_SEED, 'dark').primary).toBe('#d0bcff')
  })
})

describe('Black as the high-contrast mode', () => {
  test(`text pairs at least ${BLACK_TEXT_MIN}:1, outline and focus at least ${OUTLINE_MIN}:1 on every surface, dividers 3:1, for every accent and outline preset`, () => {
    for (const seed of SEEDS) {
      for (const outline of PRESETS) {
        const t = sweep(seed, 'black', outline)
        for (const [fg, bg] of TEXT_PAIRS) {
          const r = ratio(t, fg, bg)
          if (r < BLACK_TEXT_MIN) throw new Error(`black ${seed} ${fg}/${bg} ${r.toFixed(2)}`)
        }
        for (const sf of BLACK_SURFACES) {
          for (const k of ['outline', 'focus']) {
            const r = ratio(t, k, sf)
            if (r < OUTLINE_MIN)
              throw new Error(`black ${seed} ${JSON.stringify(outline)} ${k}/${sf} ${r.toFixed(2)}`)
          }
        }
        if (ratio(t, 'outline-variant', 'surface') < 3)
          throw new Error(`black ${seed} outline-variant`)
      }
    }
  })

  test('the weakest are the recorded ones: text 7.16, outline 5.33, focus 7.18', () => {
    const all = SEEDS.flatMap(seed => PRESETS.map(o => sweep(seed, 'black', o)))
    const on = (k: string) => least(all.flatMap(t => BLACK_SURFACES.map(sf => ratio(t, k, sf))))
    const got = {
      text: r2(least(all.flatMap(t => TEXT_PAIRS.map(([fg, bg]) => ratio(t, fg, bg))))),
      outline: r2(on('outline')),
      focus: r2(on('focus')),
      divider: r2(least(all.map(t => ratio(t, 'outline-variant', 'surface')))),
    }
    expect(got).toEqual(vectors.sweep.worst.black)
    expect(got).toMatchObject({ text: 7.16, outline: 5.33, focus: 7.18 })
  })

  test('surfaces are black and elevation steps stay apart', () => {
    const t = tokens(TODAY_SEED, 'black')
    expect(t.surface).toBe('#000000')
    expect(t['surface-dim']).toBe('#000000')
    expect(t['surface-container-lowest']).toBe('#000000')
    const steps = BLACK_SURFACES.slice(1).map(k => lstar(hex(t[k])))
    for (let i = 1; i < steps.length; i++)
      expect(steps[i] - steps[i - 1]).toBeGreaterThanOrEqual(3.5)
  })

  test('Black text is stronger than Dark', () => {
    const b = tokens(TODAY_SEED, 'black')
    const d = TODAY.dark
    expect(ratio(b, 'on-surface', 'surface')).toBeGreaterThan(ratio(d, 'on-surface', 'surface'))
    expect(ratio(b, 'outline', 'surface')).toBeGreaterThan(ratio(d, 'outline', 'surface'))
  })

  test("Black's own tones: text n95, outline nv70, dividers nv45, focus the primary", () => {
    expect(ROLES.black['on-surface']).toEqual(['n', 95])
    expect(ROLES.black['inverse-surface']).toEqual(['n', 95])
    expect(ROLES.black.outline).toEqual(['nv', 70])
    expect(ROLES.black['outline-variant']).toEqual(['nv', 45])
    expect(ROLES.black['surface-variant']).toEqual(['nv', 22])
    expect(ROLES.black.spoiler).toEqual(['n', 17])
    const tones = BLACK_SURFACES.map(k => ROLES.black[k][1])
    expect(tones).toEqual([0, 4, 8, 12, 17, 22])
    const t = tokens(TODAY_SEED, 'black')
    expect(t['on-surface']).toBe('#f5eff7')
    expect(t.outline).toBe('#afa9b4')
    expect(t.focus).toBe(t.primary)
    expect('focus' in tokens(TODAY_SEED, 'dark')).toBe(false)
    expect('focus' in tokens(TODAY_SEED, 'light')).toBe(false)
  })

  test('the default outline is neutral; a weak custom color is raised in tone until it passes', () => {
    expect(outlineFor(TODAY_SEED, { kind: 'preset', id: 'neutral' }).adjusted).toBe(false)
    const dark = outlineFor(TODAY_SEED, { kind: 'custom', color: '#203040' })
    expect(dark.adjusted).toBe(true)
    for (const sf of BLACK_SURFACES)
      expect(
        contrast(hex(dark.color), hex(tokens(TODAY_SEED, 'black')[sf]))
      ).toBeGreaterThanOrEqual(OUTLINE_MIN)
    expect(outlineFor(TODAY_SEED, { kind: 'custom', color: '#ffd600' })).toEqual({
      color: '#ffd600',
      adjusted: false,
    })
  })

  test('custom outline colors over a grid all end above the floor', () => {
    for (let h = 0; h < 360; h += 30)
      for (const t of [5, 20, 40, 60, 80]) {
        const got = outlineFor(TODAY_SEED, { kind: 'custom', color: toHex(solve(h, 40, t)) })
        for (const sf of BLACK_SURFACES)
          expect(
            contrast(hex(got.color), hex(tokens(TODAY_SEED, 'black')[sf]))
          ).toBeGreaterThanOrEqual(OUTLINE_MIN)
      }
  })

  test('a raised color keeps its hue', () => {
    const asked = hctOf(hex('#7a0000'))
    const got = outlineFor(TODAY_SEED, { kind: 'custom', color: '#7a0000' })
    expect(got.adjusted).toBe(true)
    expect(hctOf(hex(got.color)).tone).toBeGreaterThan(asked.tone)
    expect(Math.abs(hctOf(hex(got.color)).hue - asked.hue)).toBeLessThan(8)
  })
})

describe('the outline presets', () => {
  test('Gray is nv70 and Accent p70 in the accent hue; White, Yellow and Cyan are fixed', () => {
    for (const seed of ['#6750a4', '#0061a4', '#386a20']) {
      const pal = palettesOf(seed)
      const of = (id: 'neutral' | 'accent' | 'white' | 'yellow' | 'cyan') =>
        outlineFor(seed, { kind: 'preset', id }).color
      expect(of('neutral')).toBe(toHex(solve(pal.nv.hue, pal.nv.chroma, 70)))
      expect(of('accent')).toBe(toHex(solve(pal.p.hue, pal.p.chroma, 70)))
      expect(of('white')).toBe('#ffffff')
      expect(of('yellow')).toBe('#ffd600')
      expect(of('cyan')).toBe('#00e5ff')
    }
  })

  test('every preset and the recorded custom colors resolve as recorded', () => {
    expect(vectors.outlines).toHaveLength(48)
    for (const o of vectors.outlines) {
      const got = outlineFor(o.seed, o.choice as OutlineChoice)
      if (got.color !== o.color || got.adjusted !== o.adjusted)
        throw new Error(`${o.seed} ${JSON.stringify(o.choice)}: ${JSON.stringify(got)}`)
    }
  })

  test('every preset passes unadjusted for every accent of the grid', () => {
    const rows: string[] = []
    for (const seed of SEEDS)
      for (const o of PRESETS) {
        const got = outlineFor(seed, o)
        if (got.adjusted) throw new Error(`${seed} ${JSON.stringify(o)}`)
        rows.push(`${seed} ${o.kind === 'preset' ? o.id : ''} ${JSON.stringify(got)}`)
      }
    expect(digest(rows)).toBe(vectors.sweep.digests.outlines)
  })

  test('the outline choice sets the outline in Black only, and leaves dividers and focus', () => {
    const white: OutlineChoice = { kind: 'preset', id: 'white' }
    const plain = tokens(TODAY_SEED, 'black')
    const got = tokens(TODAY_SEED, 'black', white)
    expect(got.outline).toBe('#ffffff')
    expect(got['outline-variant']).toBe(plain['outline-variant'])
    expect(got.focus).toBe(plain.focus)
    expect(tokens(TODAY_SEED, 'dark', white)).toEqual(tokens(TODAY_SEED, 'dark'))
    expect(schemeFor(TODAY_SEED, 'black', white).outline).toBe('#ffffff')
    expect(schemeFor(TODAY_SEED, 'black').outline).toBe(plain.outline)
    expect(schemeFor('#0061a4', 'dark', white)).toEqual(tokens('#0061a4', 'dark'))
  })
})

describe('modes and the stored look', () => {
  const dev = { moreContrast: false, forcedColors: false, prefersLight: false }

  test('Follow device: Light with more contrast on a light device, Black on a dark one or under forced colors', () => {
    expect(resolveMode('device', { ...dev, moreContrast: true, prefersLight: true })).toEqual({
      mode: 'light',
      more: true,
    })
    expect(resolveMode('device', { ...dev, moreContrast: true })).toEqual({
      mode: 'black',
      more: false,
    })
    expect(resolveMode('device', { ...dev, forcedColors: true, prefersLight: true })).toEqual({
      mode: 'black',
      more: false,
    })
    expect(resolveMode('device', { ...dev, prefersLight: true })).toEqual({
      mode: 'light',
      more: false,
    })
    expect(resolveMode('device', dev)).toEqual({ mode: 'dark', more: false })
    expect(resolveMode('black', { ...dev, prefersLight: true }, true)).toEqual({
      mode: 'black',
      more: false,
    })
    expect(resolveMode('light', dev, true)).toEqual({ mode: 'light', more: true })
    expect(resolveMode('device', { ...dev, prefersLight: true }, true)).toEqual({
      mode: 'light',
      more: true,
    })
  })

  test('a mode set by hand ignores the device', () => {
    const loud = { moreContrast: true, forcedColors: true, prefersLight: true }
    expect(resolveMode('dark', loud)).toEqual({ mode: 'dark', more: false })
    expect(resolveMode('light', loud)).toEqual({ mode: 'light', more: false })
    expect(resolveMode('dark', loud, true)).toEqual({ mode: 'dark', more: true })
  })

  test("no stored look: today's mode from the legacy key, today's accent, so today's exact tokens", () => {
    const l = parseLook(null, 'dark')
    expect(l.mode).toBe('dark')
    expect(schemeFor(l.accent, resolveMode(l.mode, dev).mode)).toEqual(TODAY.dark)
    expect(parseLook(null, 'light').mode).toBe('light')
    expect(parseLook('{bad json', null).mode).toBe('dark')
    expect(parseLook(null, null)).toEqual(DEFAULT_LOOK)
  })

  test('a v1 look with Black in the dark list becomes the Black mode', () => {
    const l = parseLook(
      JSON.stringify({
        v: 1,
        mode: 'dark',
        light: 'core.standard',
        dark: 'core.black',
        accent: '#0061A4',
      }),
      null
    )
    expect(l).toMatchObject({
      v: 2,
      mode: 'black',
      dark: 'core.standard',
      black: 'core.standard',
      accent: '#0061a4',
    })
  })

  test('a v1 look without Black keeps its mode and themes', () => {
    const l = parseLook(
      JSON.stringify({ v: 1, mode: 'light', light: 'plugin.a.paper', dark: 'plugin.a.nord' }),
      'dark'
    )
    expect(l).toEqual({
      ...DEFAULT_LOOK,
      mode: 'light',
      light: 'plugin.a.paper',
      dark: 'plugin.a.nord',
    })
  })

  test('v2 round trip and bad fields fall back', () => {
    const l = parseLook(
      JSON.stringify({
        v: 2,
        mode: 'device',
        light: 'a',
        dark: 'b',
        black: 'plugin.x.hc',
        accent: '#00ff00',
        outline: { kind: 'custom', color: '#FFD600' },
      }),
      null
    )
    expect(l).toEqual({
      v: 2,
      mode: 'device',
      light: 'a',
      dark: 'b',
      black: 'plugin.x.hc',
      accent: '#00ff00',
      outline: { kind: 'custom', color: '#ffd600' },
    })
    expect(
      parseLook(
        JSON.stringify({
          v: 2,
          mode: 'neon',
          accent: 'red',
          outline: { kind: 'preset', id: 'pink' },
        }),
        null
      )
    ).toMatchObject({ mode: 'dark', accent: '#6750a4', outline: { kind: 'preset', id: 'neutral' } })
  })

  test('anything that is not a look falls back to the legacy mode', () => {
    for (const raw of ['null', '7', '"dark"', '[]', '{}', '{"v":3,"mode":"black"}', ''])
      expect(parseLook(raw, 'light')).toEqual({ ...DEFAULT_LOOK, mode: 'light' })
    const long = parseLook(JSON.stringify({ v: 2, dark: 'x'.repeat(201), light: 9 }), null)
    expect(long).toEqual(DEFAULT_LOOK)
    expect(
      parseLook(JSON.stringify({ v: 2, outline: { kind: 'custom', color: 'red' } }), null)
    ).toEqual(DEFAULT_LOOK)
  })
})

describe('derivation inputs: increased contrast and saturation', () => {
  test("increased contrast gives Light and Dark Black's targets for every accent", () => {
    for (const mode of ['light', 'dark'] as const)
      for (const seed of SEEDS) {
        const t = sweep(seed, mode, undefined, { more: true })
        for (const [fg, bg] of TEXT_PAIRS) {
          const r = ratio(t, fg, bg)
          if (r < BLACK_TEXT_MIN)
            throw new Error(`${mode}+more ${seed} ${fg}/${bg} ${r.toFixed(2)}`)
        }
        for (const sf of SURFACES)
          for (const k of ['outline', 'primary']) {
            const r = ratio(t, k, sf)
            if (r < OUTLINE_MIN) throw new Error(`${mode}+more ${seed} ${k}/${sf} ${r.toFixed(2)}`)
          }
        if (ratio(t, 'outline-variant', 'surface') < 3)
          throw new Error(`${mode}+more ${seed} divider`)
        for (const k of Object.keys(STATUS[mode]))
          for (const sf of SURFACES)
            if (ratio(t, k, sf) < 4.5) throw new Error(`${mode}+more ${seed} ${k}/${sf}`)
      }
  })

  test('increased contrast moves only text and edge tones; surfaces stay', () => {
    const plain = tokens(TODAY_SEED, 'light')
    const more = tokens(TODAY_SEED, 'light', undefined, { more: true })
    for (const k of SURFACES) expect(more[k]).toBe(plain[k])
    expect(more.outline).not.toBe(plain.outline)
  })

  test('in Black increased contrast changes nothing', () => {
    expect(tokens(TODAY_SEED, 'black', undefined, { more: true })).toEqual(
      tokens(TODAY_SEED, 'black')
    )
  })

  test("either input off its default leaves today's literal table", () => {
    expect(schemeFor(TODAY_SEED, 'dark', undefined, { more: true })).not.toEqual(TODAY.dark)
    expect(schemeFor(TODAY_SEED, 'dark', undefined, { saturation: 0.5 })).not.toEqual(TODAY.dark)
    expect(schemeFor(TODAY_SEED, 'dark', undefined, { saturation: 1 })).toEqual(TODAY.dark)
    expect(schemeFor(TODAY_SEED, 'dark', undefined, { more: false })).toEqual(TODAY.dark)
  })

  test('saturation scales derived chroma and leaves the error family', () => {
    const gray = tokens('#0061a4', 'light', undefined, { saturation: 0 })
    const [r, g, b] = hex(gray.primary)
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(2)
    expect(gray.error).toBe(tokens('#0061a4', 'light').error)
  })

  test('saturation leaves the error family that increased contrast derives', () => {
    for (const mode of ['light', 'dark'] as const) {
      const full = tokens('#0061a4', mode, undefined, { more: true })
      const gray = tokens('#0061a4', mode, undefined, { more: true, saturation: 0 })
      for (const k of Object.keys(FIXED[mode])) expect(gray[k]).toBe(full[k])
      expect(gray.primary).not.toBe(full.primary)
    }
  })

  test('a custom outline just under the floor is raised by the least that passes', () => {
    const got = outlineFor(TODAY_SEED, { kind: 'custom', color: '#66a6a8' })
    expect(got).toEqual({ color: '#68a8aa', adjusted: true })
    expect(hctOf(hex(got.color)).tone - hctOf(hex('#66a6a8')).tone).toBeLessThan(1)
  })

  test('the Black control outline width is 1, 2 or 3 px, never 0', () => {
    expect(outlineWidth(undefined)).toBe(1)
    expect(outlineWidth(0)).toBe(1)
    expect(outlineWidth(2)).toBe(2)
    expect(outlineWidth(3)).toBe(3)
    expect(outlineWidth(9)).toBe(1)
    expect(outlineWidth('2')).toBe(1)
  })

  test("the increased-contrast tones equal the personal spec's vectors", () => {
    expect(MORE.light).toEqual((vectors.more_contrast as unknown as typeof MORE).light)
    expect(MORE.dark).toEqual((vectors.more_contrast as unknown as typeof MORE).dark)
  })

  test('the tones that move: Light p31, s30, t30, nv41, nv57; Dark nv90, nv66, nv45, p30', () => {
    const moved = (mode: 'light' | 'dark') =>
      Object.fromEntries(
        Object.entries(MORE[mode])
          .filter(([k, role]) => !(k in ROLES[mode]) || ROLES[mode][k].join() !== role.join())
          .map(([k, [p, tone]]) => [k, `${p}${tone}`])
      )
    expect(moved('light')).toEqual({
      primary: 'p31',
      secondary: 's30',
      tertiary: 't30',
      outline: 'nv41',
      'outline-variant': 'nv57',
      error: 'e37',
      'on-error': 'e100',
      'error-container': 'e90',
      'on-error-container': 'e10',
    })
    expect(moved('dark')).toEqual({
      'on-surface-variant': 'nv90',
      outline: 'nv66',
      'outline-variant': 'nv45',
      'inverse-primary': 'p30',
      error: 'e80',
      'on-error': 'e20',
      'error-container': 'e30',
      'on-error-container': 'e90',
    })
  })

  test('increased-contrast and half-saturation tokens come out as recorded', () => {
    for (const m of vectors.more)
      for (const mode of ['light', 'dark'] as const)
        expect(tokens(m.seed, mode, undefined, { more: true })).toEqual(m[mode])
    for (const s of SATURATION) {
      const opts = { saturation: s.saturation, more: s.more }
      expect(tokens(s.seed, s.mode, undefined, opts)).toEqual(s.tokens)
    }
    const of = (mode: 'light' | 'dark', opts: { more?: boolean; saturation?: number }) =>
      digest(SEEDS.map(seed => line(sweep(seed, mode, undefined, opts))))
    expect(of('light', { more: true })).toBe(vectors.sweep.digests.light_more)
    expect(of('dark', { more: true })).toBe(vectors.sweep.digests.dark_more)
    expect(of('dark', { saturation: 0.5 })).toBe(vectors.sweep.digests.half_saturation)
  })

  test('the weakest increased-contrast pairs are the recorded ones', () => {
    for (const mode of ['light', 'dark'] as const) {
      const all = SEEDS.map(seed => sweep(seed, mode, undefined, { more: true }))
      const on = (k: string) => least(all.flatMap(t => SURFACES.map(sf => ratio(t, k, sf))))
      expect({
        text: r2(least(all.flatMap(t => TEXT_PAIRS.map(([fg, bg]) => ratio(t, fg, bg))))),
        outline: r2(on('outline')),
        primary: r2(on('primary')),
        divider: r2(least(all.map(t => ratio(t, 'outline-variant', 'surface')))),
      }).toEqual(vectors.sweep.worst[`${mode}_more`])
    }
  })

  test('saturation above 1 or below 0 is held to the range', () => {
    expect(tokens('#0061a4', 'dark', undefined, { saturation: 3 })).toEqual(
      tokens('#0061a4', 'dark')
    )
    expect(tokens('#0061a4', 'dark', undefined, { saturation: -1 })).toEqual(
      tokens('#0061a4', 'dark', undefined, { saturation: 0 })
    )
  })
})
