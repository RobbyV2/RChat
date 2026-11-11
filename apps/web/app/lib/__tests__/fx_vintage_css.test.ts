import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliDecompressSync } from 'node:zlib'
import {
  BEVEL,
  DITHER,
  FORCED_COLORS_BEVEL,
  VINTAGE_DARK,
  VINTAGE_LIGHT,
  faceOverrides,
  fontFaceCss,
} from '../fx/vintage_tokens'
import frozen from './fixtures/fx_color_tokens.json'
import metrics from './fixtures/fx_font_metrics.json'

const app = fileURLToPath(new URL('../..', import.meta.url))
const fontDir = fileURLToPath(new URL('../../../public/fonts', import.meta.url))
const css = readFileSync(join(app, 'vintage.css'), 'utf8')

interface Rule {
  selector: string
  decls: [string, string][]
  // The `@media` condition the rule sits in, or null.
  media: string | null
}

// Splits on `sep` outside quotes and parentheses.
const split = (text: string, sep: string) => {
  const out: string[] = []
  let depth = 0
  let quote = ''
  let cur = ''
  for (const c of text) {
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '(') depth += 1
    else if (c === ')') depth -= 1
    else if (c === sep && depth === 0) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  out.push(cur)
  return out.map(s => s.trim()).filter(Boolean)
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim()

// A reader for the plain CSS the style sheet is written in: rules, `@font-face` and `@media`.
const parse = (text: string, media: string | null = null): Rule[] => {
  const rules: Rule[] = []
  let at = 0
  while (at < text.length) {
    const open = text.indexOf('{', at)
    if (open < 0) break
    let depth = 1
    let end = open + 1
    while (depth > 0 && end < text.length) {
      if (text[end] === '{') depth += 1
      else if (text[end] === '}') depth -= 1
      end += 1
    }
    const selector = flat(text.slice(at, open))
    const body = text.slice(open + 1, end - 1)
    if (selector.startsWith('@media')) rules.push(...parse(body, selector.slice(6).trim()))
    else
      rules.push({
        selector,
        media,
        decls: split(body, ';').map(d => {
          const colon = d.indexOf(':')
          return [d.slice(0, colon).trim(), flat(d.slice(colon + 1))] as [string, string]
        }),
      })
    at = end
  }
  return rules
}

const rules = parse(css.replace(/\/\*[\s\S]*?\*\//g, ''))
const faces = rules.filter(r => r.selector === '@font-face')
const styled = rules.filter(r => r.selector !== '@font-face')
const get = (r: Rule, prop: string) => r.decls.find(([p]) => p === prop)?.[1]
const parts = (r: Rule) => split(r.selector, ',')

const ROOT = ":root[data-style='vintage']"
const LIGHT = `${ROOT}[data-theme='light']`
const block = (selector: string) =>
  Object.fromEntries(
    styled.filter(r => r.selector === selector && r.media === null).flatMap(r => r.decls)
  )

describe('the reader', () => {
  test('reads rules, media blocks and values with commas, colons and semicolons in them', () => {
    const read = parse(
      `a, b { color: red; background: url("data:x;y,{z}") 0 0 / 2px, linear-gradient(1deg, a, b) }
       @media (forced-colors: active) { c { outline: 1px solid ButtonBorder; } }`
    )
    expect(read).toEqual([
      {
        selector: 'a, b',
        media: null,
        decls: [
          ['color', 'red'],
          ['background', 'url("data:x;y,{z}") 0 0 / 2px, linear-gradient(1deg, a, b)'],
        ],
      },
      {
        selector: 'c',
        media: '(forced-colors: active)',
        decls: [['outline', '1px solid ButtonBorder']],
      },
    ])
  })
})

describe('tokens', () => {
  test('dark is the base and light sits under the light theme, exactly as the token file has them', () => {
    const dark = block(ROOT)
    const light = block(LIGHT)
    for (const [name, value] of Object.entries(VINTAGE_DARK))
      expect([name, dark[name]]).toEqual([name, value])
    for (const [name, value] of Object.entries(VINTAGE_LIGHT))
      expect([name, light[name]]).toEqual([name, value])
    const colors = (b: Record<string, string>) =>
      Object.keys(b)
        .filter(name => /^#[0-9a-f]{6}$/.test(b[name]))
        .sort()
    expect(colors(dark)).toEqual(Object.keys(VINTAGE_DARK).sort())
    expect(colors(light)).toEqual(Object.keys(VINTAGE_LIGHT).sort())
  })

  test('every color token of the frozen app list is re-mapped in both', () => {
    expect(frozen.tokens).toHaveLength(45)
    for (const name of frozen.tokens) {
      expect([name, block(ROOT)[name] !== undefined]).toEqual([name, true])
      expect([name, block(LIGHT)[name] !== undefined]).toEqual([name, true])
    }
  })

  test('the bevels and the dither are the token file values', () => {
    const dark = block(ROOT)
    expect(dark['--vt-bevel-raised']).toBe(BEVEL.raised)
    expect(dark['--vt-bevel-sunken']).toBe(BEVEL.sunken)
    expect(dark['--vt-bevel-pressed']).toBe(BEVEL.pressed)
    expect(dark['--vt-bevel-window']).toBe(BEVEL.window)
    expect(dark['--vt-dither']).toBe(DITHER)
  })

  test('every variable the sheet reads is one it defines, or the app font', () => {
    const defined = new Set([...Object.keys(block(ROOT)), '--font-sans'])
    const read = [...css.matchAll(/var\((--[a-z0-9-]+)/g)].map(m => m[1])
    expect(read.length).toBeGreaterThan(20)
    expect([...new Set(read.filter(name => !defined.has(name)))]).toEqual([])
  })
})

describe('scope', () => {
  test('every rule is under the vintage style, so no page changes until it is switched on', () => {
    expect(styled.length).toBeGreaterThan(20)
    const loose = styled.flatMap(r => parts(r).filter(s => !s.startsWith(ROOT)))
    expect(loose).toEqual([])
  })

  test('only font faces and media blocks sit outside rules', () => {
    const at = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/@[a-z-]+/g)].map(m => m[0])
    expect([...new Set(at)].sort()).toEqual(['@font-face', '@media'])
    const media = [...new Set(styled.map(r => r.media).filter(m => m !== null))].sort()
    expect(media).toEqual(['(forced-colors: active)', '(prefers-contrast: more)'])
  })

  test('nothing imports the sheet or the fonts yet', () => {
    const files = (readdirSync(app, { recursive: true }) as string[]).filter(
      f => /\.(css|tsx?)$/.test(f) && !f.includes('__tests__') && f !== 'vintage.css'
    )
    expect(files.length).toBeGreaterThan(100)
    const users = files.filter(f =>
      /vintage\.css|\/fonts\//.test(readFileSync(join(app, f), 'utf8'))
    )
    expect(users).toEqual([])
  })
})

describe('look, not layout', () => {
  const SIZING =
    /^(?:(?:min-|max-)?(?:width|height|inline-size|block-size)|padding(?:-.+)?|margin(?:-.+)?|gap|row-gap|column-gap|font|font-size|line-height|letter-spacing|word-spacing|border|border-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?|border(?:-.+)?-width|border-style|inset(?:-.+)?|top|right|bottom|left|flex(?:-.+)?|grid(?:-.+)?|display|position|box-sizing|transform|zoom)$/

  test('one rule sets a size: the minimum width of text buttons in footers and settings rows', () => {
    const sized = styled.flatMap(r =>
      r.decls
        .filter(([prop]) => SIZING.test(prop))
        .map(([prop, value]) => [r.selector, prop, value])
    )
    expect(sized).toEqual([[`${ROOT} .vt-wide`, 'min-width', 'min(88px, 100%)']])
  })

  test('the pattern knows the properties that move things', () => {
    for (const prop of [
      'width',
      'min-height',
      'padding-left',
      'margin',
      'gap',
      'font-size',
      'line-height',
      'border',
      'border-top-width',
      'font',
    ])
      expect([prop, SIZING.test(prop)]).toEqual([prop, true])
    for (const prop of [
      'color',
      'background',
      'box-shadow',
      'outline',
      'outline-offset',
      'border-radius',
      'border-color',
      'font-family',
      'cursor',
      'scrollbar-color',
      'text-decoration',
    ])
      expect([prop, SIZING.test(prop)]).toEqual([prop, false])
  })

  test('no rule can clip or hide text', () => {
    const clips = styled.flatMap(r =>
      r.decls
        .filter(([prop]) =>
          /^(clip-path|clip|mask(-.+)?|overflow(-.+)?|text-overflow|visibility|opacity)$/.test(prop)
        )
        .map(([prop]) => [r.selector, prop])
    )
    expect(clips).toEqual([])
  })

  test('pixel faces only on titles and web buttons, and the opt-in for all text', () => {
    const fonts = styled
      .filter(r => get(r, 'font-family') !== undefined)
      .map(r => [r.selector, get(r, 'font-family')])
    expect(fonts).toEqual([
      [`${ROOT} .vt-title`, "'Pixelify Sans', var(--font-sans)"],
      [`${ROOT} .retro-button`, "'Silkscreen', var(--font-sans)"],
      [`${ROOT}[data-vt-pixel='on'] body`, "'Pixelify Sans', var(--font-sans)"],
    ])
  })

  test('bevels are shadows from the tokens', () => {
    const shadows = styled.filter(r => r.media === null && get(r, 'box-shadow') !== undefined)
    expect(shadows.length).toBeGreaterThan(6)
    for (const r of shadows)
      expect([
        r.selector,
        /^var\(--vt-bevel-(raised|sunken|pressed|window)\)$/.test(get(r, 'box-shadow')!),
      ]).toEqual([r.selector, true])
  })

  test('the desktop is dithered, and solid on request or for more contrast', () => {
    const desk = `${ROOT} .vt-desktop`
    expect(block(desk).background).toBe('var(--vt-dither)')
    expect(block(desk).color).toBe('var(--vt-desktop-text)')
    expect(block(`${ROOT}[data-vt-dither='off'] .vt-desktop`).background).toBe('var(--vt-desktop)')
    const contrast = styled.filter(r => r.media === '(prefers-contrast: more)')
    expect(contrast.map(r => [r.selector, r.decls])).toEqual([
      [desk, [['background', 'var(--vt-desktop)']]],
    ])
  })

  test('classic cursors: the arrow on the chrome, the hand on what is clickable, text left alone', () => {
    const OFF = `${ROOT}:not([data-vt-cursors='off'])`
    const cursors = styled.filter(r => get(r, 'cursor') !== undefined)
    expect(cursors.map(r => parts(r).every(s => s.startsWith(OFF)))).toEqual([true, true, true])
    const [arrow, doc, hand] = cursors
    expect(arrow.selector).toBe(`${OFF} :where(.vt-desktop, .vt-window, .vt-menu, .vt-title-bar)`)
    expect(doc.selector).toBe(`${OFF} .vt-doc`)
    expect(get(doc, 'cursor')).toBe('auto')
    expect(hand.selector.startsWith(`${OFF} :where( button,`)).toBe(true)
    const image = /^url\("data:image\/svg\+xml,[^"]+"\) \d+ \d+, (default|pointer)$/
    expect([image.exec(get(arrow, 'cursor')!)?.[1], image.exec(get(hand, 'cursor')!)?.[1]]).toEqual(
      ['default', 'pointer']
    )
  })
})

describe('forced colors', () => {
  const forced = styled.filter(r => r.media === '(forced-colors: active)')
  const outline = split(FORCED_COLORS_BEVEL, ';').map(d => {
    const colon = d.indexOf(':')
    return [d.slice(0, colon).trim(), d.slice(colon + 1).trim()] as [string, string]
  })

  test('an inset outline stands in for the bevels, never a border', () => {
    expect(forced.length).toBeGreaterThan(0)
    expect(
      forced.flatMap(r => r.decls.map(([prop]) => prop)).filter(p => p.startsWith('border'))
    ).toEqual([])
    const edged = forced.find(r => get(r, 'outline') !== undefined)!
    expect(edged.decls.filter(([p]) => p.startsWith('outline'))).toEqual(outline)
    expect(get(edged, 'box-shadow')).toBe('none')
  })

  test('every beveled element gets the outline, except while it shows its focus ring', () => {
    const beveled = styled
      .filter(r => r.media === null && get(r, 'box-shadow') !== undefined)
      .flatMap(parts)
      .filter(s => !/:active|\.vt-on|-webkit-scrollbar/.test(s))
    const edged = forced.filter(r => get(r, 'outline') !== undefined).flatMap(parts)
    expect(edged.every(s => s.endsWith(':not(:focus-visible)'))).toBe(true)
    expect(edged.map(s => s.replace(':not(:focus-visible)', '')).sort()).toEqual(
      [...new Set(beveled)].sort()
    )
  })

  test('the chosen menu item uses the system highlight', () => {
    const chosen = forced.find(r => parts(r).includes(`${ROOT} .vt-menu-item.vt-on`))!
    expect(parts(chosen)).toEqual([
      `${ROOT} .vt-menu-item:hover`,
      `${ROOT} .vt-menu-item:focus-visible`,
      `${ROOT} .vt-menu-item.vt-on`,
    ])
    expect(chosen.decls).toEqual([
      ['background', 'Highlight'],
      ['color', 'HighlightText'],
      ['forced-color-adjust', 'none'],
    ])
  })

  test('gradients and the dither are off', () => {
    const plain = forced.filter(r => get(r, 'background-image') === 'none').flatMap(parts)
    expect(plain).toContain(`${ROOT} .vt-title-bar`)
    expect(plain).toContain(`${ROOT} .vt-desktop`)
  })
})

describe('fonts', () => {
  test('nothing is fetched from another origin', () => {
    const urls = [...css.matchAll(/url\(([^)]*)\)/g)].map(m => m[1])
    expect(urls.length).toBeGreaterThan(3)
    for (const url of urls)
      expect([
        url,
        /^(\/fonts\/[a-z0-9-]+\.woff2|"data:image\/svg\+xml,[^"]*")$/.test(url),
      ]).toEqual([url, true])
    const own = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/url\("data:[^"]*"\)/g, '')
    expect(/@import|https?:|\/\/[a-z]/i.test(own)).toBe(false)
  })

  test('Pixelify Sans carries the metric overrides worked out from the fonts', () => {
    const o = faceOverrides(metrics.pixelify, metrics.roboto)
    const want = parse(fontFaceCss('Pixelify Sans', '/fonts/pixelify-sans.woff2', o))[0].decls
    const face = faces.find(f => get(f, 'font-family') === "'Pixelify Sans'")!
    const percent = (value: string | undefined) =>
      value?.endsWith('%') ? Number(value.slice(0, -1)) : value
    for (const [prop, value] of want)
      expect([prop, percent(get(face, prop))]).toEqual([prop, percent(value)])
    expect(
      ['size-adjust', 'ascent-override', 'descent-override', 'line-gap-override'].map(prop =>
        percent(get(face, prop))
      )
    ).toEqual([87.87, 105.57, 27.78, 0])
    expect(get(face, 'font-weight')).toBe('400 700')
  })

  test('Silkscreen has its two weights and no overrides', () => {
    const silk = faces.filter(f => get(f, 'font-family') === "'Silkscreen'")
    expect(silk.map(f => [get(f, 'font-weight'), get(f, 'src')])).toEqual([
      ['400', "url(/fonts/silkscreen-400.woff2) format('woff2')"],
      ['700', "url(/fonts/silkscreen-700.woff2) format('woff2')"],
    ])
    expect(silk.some(f => get(f, 'size-adjust') !== undefined)).toBe(false)
    expect(faces).toHaveLength(3)
  })

  test('every face swaps in late and covers only the bundled blocks', () => {
    for (const f of faces) {
      expect(get(f, 'font-display')).toBe('swap')
      expect(get(f, 'unicode-range')).toBe('U+0020-007E, U+00A0-00FF, U+0100-017F')
    }
  })
})

// A reader for the parts of a WOFF2 file this test needs: the table directory and the tables
// that are stored as they are (cmap, name, head, hhea, fvar).
const KNOWN = (
  'cmap head hhea hmtx maxp name OS/2 post cvt_ fpgm glyf loca prep CFF_ VORG EBDT EBLC gasp hdmx ' +
  'kern LTSH PCLT VDMX vhea vmtx BASE GDEF GPOS GSUB EBSC JSTF MATH CBDT CBLC COLR CPAL SVG_ sbix ' +
  'acnt avar bdat bloc bsln cvar fdsc feat fmtx fvar gvar hsty just lcar mort morx opbd prop trak ' +
  'Zapf Silf Glat Gloc Feat Sill'
)
  .split(' ')
  .map(tag => tag.replace('_', ' '))
const woff2 = (file: string) => {
  const buf = readFileSync(join(fontDir, file))
  const signature = buf.toString('latin1', 0, 4)
  const count = buf.readUInt16BE(12)
  const packed = buf.readUInt32BE(20)
  let at = 48
  const base128 = () => {
    let n = 0
    for (let i = 0; i < 5; i++) {
      const b = buf[at++]
      n = n * 128 + (b & 127)
      if (!(b & 128)) break
    }
    return n
  }
  const dir: { tag: string; length: number }[] = []
  for (let i = 0; i < count; i++) {
    const flags = buf[at++]
    const index = flags & 63
    const tag = index === 63 ? buf.toString('latin1', at, (at += 4)) : (KNOWN[index] ?? `#${index}`)
    const version = flags >> 6
    const original = base128()
    const transformed =
      tag === 'glyf' || tag === 'loca' ? version === 0 : tag === 'hmtx' ? version === 1 : false
    dir.push({ tag, length: transformed ? base128() : original })
  }
  const data = brotliDecompressSync(buf.subarray(at, at + packed))
  const tables: Record<string, Buffer> = {}
  let offset = 0
  for (const { tag, length } of dir) {
    tables[tag] = data.subarray(offset, offset + length)
    offset += length
  }
  return { signature, tables }
}

const codepoints = (cmap: Buffer) => {
  const out = new Set<number>()
  for (let i = 0; i < cmap.readUInt16BE(2); i++) {
    const sub = cmap.readUInt32BE(4 + i * 8 + 4)
    const format = cmap.readUInt16BE(sub)
    if (format === 12) {
      for (let g = 0; g < cmap.readUInt32BE(sub + 12); g++) {
        const from = cmap.readUInt32BE(sub + 16 + g * 12)
        const to = cmap.readUInt32BE(sub + 20 + g * 12)
        for (let c = from; c <= to; c++) out.add(c)
      }
    } else if (format === 4) {
      const segs = cmap.readUInt16BE(sub + 6) / 2
      const ends = sub + 14
      const starts = ends + segs * 2 + 2
      for (let s = 0; s < segs; s++) {
        const to = cmap.readUInt16BE(ends + s * 2)
        const from = cmap.readUInt16BE(starts + s * 2)
        for (let c = from; c <= to && c < 0xffff; c++) out.add(c)
      }
    } else throw new Error(`cmap format ${format}`)
  }
  return [...out].sort((a, b) => a - b)
}

// A Windows entry of the name table: 0 is the copyright, 5 the version.
const nameString = (name: Buffer, id: number) => {
  const strings = name.readUInt16BE(4)
  for (let i = 0; i < name.readUInt16BE(2); i++) {
    const rec = 6 + i * 12
    if (name.readUInt16BE(rec) !== 3 || name.readUInt16BE(rec + 6) !== id) continue
    const raw = name.subarray(
      strings + name.readUInt16BE(rec + 10),
      strings + name.readUInt16BE(rec + 10) + name.readUInt16BE(rec + 8)
    )
    return Buffer.from(raw).swap16().toString('utf16le')
  }
  return null
}

describe('the bundled files', () => {
  const FILES = [
    ['pixelify-sans.woff2', 'OFL-pixelify-sans.txt', metrics.pixelify, 'Pixelify Sans'],
    ['silkscreen-400.woff2', 'OFL-silkscreen.txt', metrics.silkscreen, 'Silkscreen'],
    ['silkscreen-700.woff2', 'OFL-silkscreen.txt', metrics.silkscreen, 'Silkscreen'],
  ] as const
  const inBlocks = (c: number) =>
    (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || (c >= 0x100 && c <= 0x17f)
  const license = (file: string) => readFileSync(join(fontDir, file), 'utf8')

  test('the folder holds the three fonts and their two licenses, and nothing else', () => {
    expect(existsSync(fontDir)).toBe(true)
    expect(readdirSync(fontDir).sort()).toEqual([
      'OFL-pixelify-sans.txt',
      'OFL-silkscreen.txt',
      'pixelify-sans.woff2',
      'silkscreen-400.woff2',
      'silkscreen-700.woff2',
    ])
  })

  for (const [file, ofl, face, family] of FILES)
    test(`${file}: Latin, Latin-1 and Latin Extended-A only, with the measured metrics`, () => {
      const { signature, tables } = woff2(file)
      expect(signature).toBe('wOF2')
      const points = codepoints(tables.cmap)
      expect(points.filter(c => !inBlocks(c))).toEqual([])
      expect(points.filter(c => c >= 0x20 && c <= 0x7e)).toHaveLength(95)
      expect(points.filter(c => c >= 0xa0 && c <= 0xff).length).toBeGreaterThanOrEqual(94)
      expect(tables.head.readUInt16BE(18)).toBe(face.upm)
      expect(tables.hhea.readInt16BE(4)).toBe(face.ascent)
      expect(tables.hhea.readInt16BE(6)).toBe(face.descent)
      expect(tables.hhea.readInt16BE(8)).toBe(face.lineGap)
      expect(nameString(tables.name, 0)).toBe(license(ofl).split('\n')[0])
      expect(nameString(tables.name, 0)).toContain(family)
      expect(readFileSync(join(fontDir, file)).length).toBeLessThan(20_000)
    })

  test('the generator records where each font came from and its version', () => {
    const script = readFileSync(join(app, '../../../scripts/fx/gen_font_metrics.py'), 'utf8')
    expect(script).toContain('google/fonts 8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5')
    for (const [file, , , family] of FILES) {
      const version = /^Version (\d+\.\d+)/.exec(nameString(woff2(file).tables.name, 5) ?? '')
      const line = script.split('\n').find(l => l.startsWith(`#   ${family} `))
      expect([file, line?.includes(` ${version?.[1]} `)]).toEqual([file, true])
    }
  })

  test('Pixelify Sans keeps its weight axis, 400 to 700', () => {
    const { fvar } = woff2('pixelify-sans.woff2').tables
    const axis = fvar.readUInt16BE(4)
    expect(fvar.readUInt16BE(8)).toBe(1)
    expect(fvar.toString('latin1', axis, axis + 4)).toBe('wght')
    expect([fvar.readInt32BE(axis + 4) / 65536, fvar.readInt32BE(axis + 12) / 65536]).toEqual([
      400, 700,
    ])
    expect(woff2('silkscreen-400.woff2').tables.fvar).toBeUndefined()
  })

  test('each license is the SIL Open Font License 1.1 with its own copyright and no reserved name', () => {
    const pixelify = license('OFL-pixelify-sans.txt')
    const silkscreen = license('OFL-silkscreen.txt')
    expect(pixelify.split('\n')[0]).toBe(
      'Copyright 2021 The Pixelify Sans Project Authors (https://github.com/eifetx/Pixelify-Sans)'
    )
    expect(silkscreen.split('\n')[0]).toBe(
      'Copyright 2001 The Silkscreen Project Authors (https://github.com/googlefonts/silkscreen)'
    )
    const body = (text: string) => text.slice(text.indexOf('\n'))
    expect(body(pixelify)).toBe(body(silkscreen))
    for (const text of [pixelify, silkscreen]) {
      expect(text.includes('\r')).toBe(false)
      expect(text).toContain('SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007')
      expect(text).toContain(
        'This Font Software is licensed under the SIL Open Font License, Version 1.1.'
      )
      expect(text).toContain('PERMISSION & CONDITIONS')
      expect(text).toContain('OTHER DEALINGS IN THE FONT SOFTWARE.')
      const head = text.slice(0, text.indexOf('SIL OPEN FONT LICENSE'))
      expect(/reserved font name/i.test(head)).toBe(false)
      expect(text.length).toBeGreaterThan(4300)
    }
  })
})
