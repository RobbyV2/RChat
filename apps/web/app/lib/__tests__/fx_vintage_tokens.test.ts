import { describe, expect, test } from 'bun:test'
import {
  FORCED_COLORS_BEVEL,
  VINTAGE_DARK,
  VINTAGE_LIGHT,
  contrast,
  faceOverrides,
  fontFaceCss,
  pairsFor,
} from '../fx/vintage_tokens'
import frozenPairs from './fixtures/fx_color_pairs.json'
import frozen from './fixtures/fx_color_tokens.json'
import fonts from './fixtures/fx_font_metrics.json'

// A frozen copy of the app's color tokens: the style is not wired in yet, so a new token in
// `globals.css` must not fail this test.
const appTokens = frozen.tokens

describe('vintage tokens', () => {
  test('cover every color token the app defined when the list was frozen', () => {
    expect(appTokens.length).toBe(45)
    for (const t of appTokens) {
      expect([t, VINTAGE_LIGHT[t] !== undefined]).toEqual([t, true])
      expect([t, VINTAGE_DARK[t] !== undefined]).toEqual([t, true])
    }
  })
  test('light and dark define the same names, all #rrggbb', () => {
    expect(Object.keys(VINTAGE_DARK).sort()).toEqual(Object.keys(VINTAGE_LIGHT).sort())
    for (const v of [...Object.values(VINTAGE_LIGHT), ...Object.values(VINTAGE_DARK)])
      expect([v, /^#[0-9a-f]{6}$/.test(v)]).toEqual([v, true])
  })
  for (const [name, tokens] of [
    ['light', VINTAGE_LIGHT],
    ['dark', VINTAGE_DARK],
  ] as const)
    test(`${name}: every text and control pair meets WCAG 2.2 AA`, () => {
      const bad = pairsFor(tokens)
        .filter(p => p.ratio < p.min)
        .map(p => `${p.fg} on ${p.bg}: ${p.ratio.toFixed(2)} < ${p.min}`)
      expect(bad).toEqual([])
    })
  test('the contrast formula', () => {
    expect(Math.abs(contrast('#000000', '#ffffff') - 21)).toBeLessThan(5e-6)
    expect(Math.abs(contrast('#000000', '#c0c0c0') - 11.54)).toBeLessThan(0.05)
  })
})

// Every same-element `text-*` and `bg-*` pair the components used when the list was frozen
// (`fixtures/fx_color_pairs.json`, the scan of `components/**/*.tsx`) must reach 4.5:1 in both
// vintage variants. Frozen because the style is not wired in yet, so a new pair in a component
// must not fail this test. Pairs with an opacity modifier are left to the axe run of the browser
// checks.
const pairs = frozenPairs.pairs

describe('class pairs the app used when the list was frozen', () => {
  test('the list holds them', () => {
    expect(pairs.length).toBe(30)
    expect(new Set(pairs.map(p => `${p.fg} on ${p.bg}`)).size).toBe(30)
    expect(
      pairs.some(p => p.fg === '--color-outline' && p.bg === '--color-surface-container-high')
    ).toBe(true)
    for (const p of pairs) {
      expect([p.fg, p.fg in VINTAGE_LIGHT]).toEqual([p.fg, true])
      expect([p.bg, p.bg in VINTAGE_LIGHT]).toEqual([p.bg, true])
    }
  })
  for (const [name, vintage] of [
    ['light', VINTAGE_LIGHT],
    ['dark', VINTAGE_DARK],
  ] as const)
    test(`${name}: every text pair the components used is at least 4.5:1`, () => {
      const bad: string[] = []
      for (const { fg, bg, file } of pairs) {
        // Text needs 4.5:1. The vintage style is new, so it meets that even where the standard
        // theme doesn't yet.
        const want = 4.5
        const got = contrast(vintage[fg], vintage[bg])
        if (got + 0.005 < want)
          bad.push(`${fg} on ${bg} (${file}): ${got.toFixed(2)} < ${want.toFixed(2)}`)
      }
      expect(bad).toEqual([])
    })
})

describe('pixel face metrics', () => {
  const o = faceOverrides(fonts.pixelify, fonts.roboto)
  const em = (m: { upm: number }, x: number) => x / m.upm
  test('Pixelify Sans sets text at the standard face average width', () => {
    const scaled = em(fonts.pixelify, fonts.pixelify.avgWidth) * o.sizeAdjust
    expect(Math.abs(scaled / em(fonts.roboto, fonts.roboto.avgWidth) - 1)).toBeLessThan(0.001)
  })
  test('and in its line box', () => {
    const box = (o.ascentOverride + o.descentOverride + o.lineGapOverride) * o.sizeAdjust
    const want =
      (fonts.roboto.ascent - fonts.roboto.descent + fonts.roboto.lineGap) / fonts.roboto.upm
    expect(Math.abs(box / want - 1)).toBeLessThan(0.001)
    expect(
      Math.abs(o.ascentOverride * o.sizeAdjust - fonts.roboto.ascent / fonts.roboto.upm)
    ).toBeLessThan(5e-5)
  })
  test('the values the style sheet uses', () => {
    expect(fontFaceCss('Pixelify Sans', '/fonts/pixelify-sans.woff2', o)).toBe(
      "@font-face { font-family: 'Pixelify Sans'; src: url(/fonts/pixelify-sans.woff2) format('woff2'); font-display: swap; size-adjust: 87.87%; ascent-override: 105.57%; descent-override: 27.78%; line-gap-override: 0.00%; }"
    )
  })
  test('forced colors use an inset outline, never a border', () => {
    expect(FORCED_COLORS_BEVEL).toContain('outline-offset: -1px')
    expect(FORCED_COLORS_BEVEL).not.toContain('border')
  })
})
