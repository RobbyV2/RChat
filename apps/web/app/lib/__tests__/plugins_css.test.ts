import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DURATION_VARS } from '../motion/tokens'
import {
  A11Y_ATTRS,
  APP_FONTS,
  APP_VARIABLES,
  CSS_MAX_BYTES,
  CSS_MAX_STORED_BYTES,
  SELECTORS,
  sanitizeCss,
  serialize,
  tokenize,
  type Token,
} from '../plugins/css'

const APP = ':where([data-rc-app])'
const out = (css: string, plugin: string | null = 'me') => sanitizeCss(css, { plugin }).css
const kinds = (css: string) => tokenize(css).map(t => t.type)
const values = (css: string) => tokenize(css).map(t => ('value' in t ? t.value : t.type))

describe('css: the tokenizer', () => {
  test('names, functions, at-keywords and hashes', () => {
    expect(values('a -b --c _d \u00e9')).toEqual([
      'a',
      'whitespace',
      '-b',
      'whitespace',
      '--c',
      'whitespace',
      '_d',
      'whitespace',
      '\u00e9',
    ])
    expect(tokenize('rgb(')).toEqual([{ type: 'function', value: 'rgb' }])
    expect(tokenize('@media')).toEqual([{ type: 'at', value: 'media' }])
    expect(tokenize('#a1')).toEqual([{ type: 'hash', value: 'a1', id: true }])
    expect(tokenize('#1a')).toEqual([{ type: 'hash', value: '1a', id: false }])
    expect(kinds('# @ - . +')).toEqual([
      'delim',
      'whitespace',
      'delim',
      'whitespace',
      'delim',
      'whitespace',
      'delim',
      'whitespace',
      'delim',
    ])
  })

  test('numbers, percentages and dimensions keep how they were written', () => {
    expect(tokenize('1 +2.5 -.5 1e3 1E-2 50% 10px -3em 1e')).toEqual([
      { type: 'number', value: '1' },
      { type: 'whitespace' },
      { type: 'number', value: '+2.5' },
      { type: 'whitespace' },
      { type: 'number', value: '-.5' },
      { type: 'whitespace' },
      { type: 'number', value: '1e3' },
      { type: 'whitespace' },
      { type: 'number', value: '1E-2' },
      { type: 'whitespace' },
      { type: 'percentage', value: '50' },
      { type: 'whitespace' },
      { type: 'dimension', value: '10', unit: 'px' },
      { type: 'whitespace' },
      { type: 'dimension', value: '-3', unit: 'em' },
      { type: 'whitespace' },
      { type: 'dimension', value: '1', unit: 'e' },
    ])
  })

  test('strings, and the ones a newline breaks', () => {
    expect(tokenize(`"a'b" 'c"d'`)).toEqual([
      { type: 'string', value: "a'b" },
      { type: 'whitespace' },
      { type: 'string', value: 'c"d' },
    ])
    expect(tokenize('"a\\"b"')).toEqual([{ type: 'string', value: 'a"b' }])
    expect(tokenize('"a\\\nb"')).toEqual([{ type: 'string', value: 'ab' }])
    expect(tokenize('"never closed')).toEqual([{ type: 'string', value: 'never closed' }])
    expect(kinds('"a\nb"')).toEqual(['bad-string', 'whitespace', 'ident', 'string'])
  })

  test('urls, quoted or bare, and the bad ones', () => {
    expect(tokenize('url(a.png)')).toEqual([{ type: 'url', value: 'a.png' }])
    expect(tokenize('url(  a.png  )')).toEqual([{ type: 'url', value: 'a.png' }])
    expect(tokenize('URL(a.png)')).toEqual([{ type: 'url', value: 'a.png' }])
    expect(tokenize('url("a.png")')).toEqual([
      { type: 'function', value: 'url' },
      { type: 'string', value: 'a.png' },
      { type: ')' },
    ])
    expect(tokenize("url( 'a.png')")[0]).toEqual({ type: 'function', value: 'url' })
    for (const bad of ['url(a b)', 'url(a"b)', 'url(a(b)', "url(a'b)", 'url(a\u0001b)'])
      expect(kinds(bad)[0]).toBe('bad-url')
    expect(tokenize('url(a\\)b)')).toEqual([{ type: 'url', value: 'a)b' }])
    expect(tokenize('url(never')).toEqual([{ type: 'url', value: 'never' }])
  })

  test('escapes are decoded, so a spelled-out name is the name', () => {
    expect(tokenize('u\\72l(x)')).toEqual([{ type: 'url', value: 'x' }])
    expect(tokenize('\\75 rl(x)')).toEqual([{ type: 'url', value: 'x' }])
    expect(tokenize('@\\69mport')).toEqual([{ type: 'at', value: 'import' }])
    expect(tokenize('\\000062ody')).toEqual([{ type: 'ident', value: 'body' }])
    expect(tokenize('a\\ b')).toEqual([{ type: 'ident', value: 'a b' }])
    expect(tokenize('\\0 \\110000 \\d800')).toEqual([
      { type: 'ident', value: '\ufffd\ufffd\ufffd' },
    ])
    expect(tokenize('a\\')).toEqual([{ type: 'ident', value: 'a\ufffd' }])
    expect(kinds('\\\na')).toEqual(['delim', 'whitespace', 'ident'])
  })

  test('an escaped character outside the basic plane stays whole', () => {
    const face = String.fromCodePoint(0x1f600)
    expect(tokenize(`\\${face}x\\!`)).toEqual([{ type: 'ident', value: `${face}x!` }])
    expect(tokenize(`"\\${face}"`)).toEqual([{ type: 'string', value: face }])
    expect(tokenize(serialize(tokenize(`\\${face}x`)))).toEqual([
      { type: 'ident', value: `${face}x` },
    ])
  })

  test('comments vanish without joining what they split', () => {
    expect(tokenize('ur/**/l(x)')).toEqual([
      { type: 'ident', value: 'ur' },
      { type: 'function', value: 'l' },
      { type: 'ident', value: 'x' },
      { type: ')' },
    ])
    expect(tokenize('a/* b */c/* never closed')).toEqual([
      { type: 'ident', value: 'a' },
      { type: 'ident', value: 'c' },
    ])
    expect(kinds('/ * /')).toEqual(['delim', 'whitespace', 'delim', 'whitespace', 'delim'])
  })

  test('punctuation, and the old comment markers', () => {
    expect(kinds('a:b;c,d[e](f){g}')).toEqual([
      'ident',
      ':',
      'ident',
      ';',
      'ident',
      ',',
      'ident',
      '[',
      'ident',
      ']',
      '(',
      'ident',
      ')',
      '{',
      'ident',
      '}',
    ])
    expect(kinds('<!-- -->')).toEqual(['cdo', 'whitespace', 'cdc'])
    expect(kinds('\r\n\f\t ')).toEqual(['whitespace'])
    expect(tokenize('\u0000')).toEqual([{ type: 'ident', value: '\ufffd' }])
  })
})

describe('css: writing tokens back', () => {
  const same = (css: string) => {
    const tokens = tokenize(css)
    const again = tokenize(serialize(tokens))
    if (JSON.stringify(again) !== JSON.stringify(tokens))
      throw new Error(`${css} -> ${serialize(tokens)}`)
  }

  test('what is written reads back as the same tokens', () => {
    for (const css of [
      'a{color:red}',
      '.a > .b ~ c + d || e',
      'a/**/b',
      'ur/**/l(x)',
      '1/**/px 1/**/e3 1/**/% 1/**/.5 -/**/a @/**/media #/**/a 1/**/-a',
      'a/**/( a/**/-1 a/**/1 a/**/-->',
      '+/**/1 ./**/5 //**/* -/**/- </**/!-- -/**/-/**/>',
      '\\31 23 \\-a -\\31 \\- a\\.b a\\ b \\7f \\1',
      '"a\\"b\\\\c\\a d" \'x\'',
      '#\\31 a #a\\.b',
      '1\\65 3 1e 1ex 1\\45 -2',
      '\u00e9\u{1f600}x \\26 B',
      'url( "a b" ) url("a.png") f(url("a"))',
      '@media (min-width: 10px) and (max-width: 2e2px) { a { b: c !important } }',
      '--x: { a: b }; grid-template-areas: "a b" "c d"',
    ])
      same(css)
  })

  test('random runs of tokens read back as themselves', () => {
    const POOL: Token[] = [
      { type: 'ident', value: 'a' },
      { type: 'ident', value: '-b' },
      { type: 'ident', value: 'e3' },
      { type: 'ident', value: 'url' },
      { type: 'ident', value: '9 x' },
      { type: 'function', value: 'f' },
      { type: 'at', value: 'm' },
      { type: 'hash', value: 'h', id: true },
      { type: 'hash', value: '1', id: false },
      { type: 'string', value: 'a"\\\nb' },
      { type: 'number', value: '1' },
      { type: 'number', value: '-.5' },
      { type: 'percentage', value: '5' },
      { type: 'dimension', value: '2', unit: 'px' },
      { type: 'dimension', value: '2', unit: 'e3' },
      { type: 'dimension', value: '2', unit: '-x' },
      { type: 'whitespace' },
      { type: 'cdc' },
      { type: 'cdo' },
      { type: ':' },
      { type: ';' },
      { type: ',' },
      { type: '(' },
      { type: ')' },
      { type: '[' },
      { type: ']' },
      { type: '{' },
      { type: '}' },
      ...'#-@.+/*%!<>=~|&'.split('').map((value): Token => ({ type: 'delim', value })),
    ]
    let seed = 12345
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648)
    for (let run = 0; run < 400; run++) {
      const tokens: Token[] = []
      for (let i = 0; i < 12; i++) {
        const t = POOL[next() % POOL.length]
        if (t.type === 'whitespace' && tokens[tokens.length - 1]?.type === 'whitespace') continue
        tokens.push(t)
      }
      const again = tokenize(serialize(tokens))
      if (JSON.stringify(again) !== JSON.stringify(tokens)) throw new Error(serialize(tokens))
    }
  })

  test('a bare url is written quoted, with the same address', () => {
    expect(serialize(tokenize('url(a.png)'))).toBe('url("a.png")')
    expect(tokenize(serialize(tokenize('url(a\\)b\\"c)')))).toEqual([
      { type: 'function', value: 'url' },
      { type: 'string', value: 'a)b"c' },
      { type: ')' },
    ])
  })

  test('tokens that hold no meaning are never written', () => {
    expect(serialize(tokenize('url(a b) "x\n \\\n'))).not.toContain('url')
    expect(
      serialize([{ type: 'bad-url' }, { type: 'bad-string' }, { type: 'delim', value: '\\' }])
    ).toBe('')
  })
})

describe('css: rules a plugin may write', () => {
  test('a style rule comes back scoped and tidy', () => {
    expect(out('.a { color: red }')).toBe(`${APP} .a{color:red}`)
    expect(out('a:hover, .b > .c { margin: 0 auto !important; padding : 1px ; }')).toBe(
      `${APP} a:hover,${APP} .b > .c{margin:0 auto !important;padding:1px}`
    )
    expect(out('[data-rc="message"]::before{opacity:.5}')).toBe(
      `${APP} [data-rc="message"]::before{opacity:.5}`
    )
  })

  test('the at-rules of the allowlist are kept, with what is inside them scoped', () => {
    expect(out('@media (min-width: 600px) { .a { color: red } }')).toBe(
      `@media (min-width: 600px){${APP} .a{color:red}}`
    )
    expect(out('@supports (display: grid) { .a { display: grid } }')).toBe(
      `@supports (display: grid){${APP} .a{display:grid}}`
    )
    expect(out('@container side (width > 300px) { .a { color: red } }')).toBe(
      `@container side (width > 300px){${APP} .a{color:red}}`
    )
    expect(out('@layer base, extra; @layer base { .a { color: red } }')).toBe(
      `@layer me_base, me_extra;\n@layer me_base{${APP} .a{color:red}}`
    )
    expect(
      out('@keyframes spin { from { transform: rotate(0) } 50%, to { transform: rotate(1turn) } }')
    ).toBe('@keyframes me_spin{from{transform:rotate(0)}50%, to{transform:rotate(1turn)}}')
    expect(
      out('@font-face { font-family: "me_sans"; src: url(asset:fonts/a.woff2) format("woff2"); }')
    ).toBe('@font-face{font-family:"me_sans";src:url("asset:fonts/a.woff2") format("woff2")}')
    expect(out('@media print { @media (width > 1px) { a { color: red } } }')).toBe(
      `@media print{@media (width > 1px){${APP} a{color:red}}}`
    )
  })

  test("a font family a plugin defines starts with the plugin's id and an underscore, so it is never one of the app's", () => {
    const face = (family: string, plugin: string | null = 'me') =>
      out(`@font-face{font-family:${family};src:url(asset:a.woff2)}`, plugin)
    for (const family of ['"me_sans"', 'me_sans', '"ME_Sans"', "'me_a b'", '"me_a-b"', '"me__"'])
      expect(face(family)).toContain('@font-face{font-family:')
    for (const family of [
      '"Roboto"',
      'Roboto',
      '"Segoe UI"',
      'system-ui',
      '"me"',
      '"me_"',
      '"me-sans"',
      'me-sans',
      '"ME-Sans"',
      'mexican',
      '"me_sans"x',
      '"other_sans"',
      '"quickcss_x"',
      '"_me_sans"',
      '"-me_sans"',
      'me_sans serif',
      '"me_sans", serif',
      'var(--f)',
    ])
      expect(face(family)).toBe('')
    expect(out('@font-face{src:url(asset:a.woff2)}')).toBe('')
    expect(out('@font-face{font-family:"me_a";font-family:"Roboto";src:url(asset:a.woff2)}')).toBe(
      ''
    )
    expect(
      out('@font-face{x{} font-family:"Roboto";font-family:"me_a";src:url(asset:a.woff2)}')
    ).toBe('')
    expect(
      out('@font-face{font-family:"me_a";x{} font-family:"Roboto";src:url(asset:a.woff2)}')
    ).toBe('')
    expect(out('@font-face{font-fam\\69ly:"Roboto";src:url(asset:a.woff2)}')).toBe('')
    expect(out('@font-face{FONT-FAMILY : "me_a";src:url(asset:a.woff2)}')).toBe(
      '@font-face{font-family:"me_a";src:url("asset:a.woff2")}'
    )
    expect(out('@font-face{font-family:me\\5f a;src:url(asset:a.woff2)}')).toBe(
      '@font-face{font-family:me_a;src:url("asset:a.woff2")}'
    )
    expect(
      sanitizeCss('@font-face{font-family:"Roboto";src:url(asset:a.woff2)}', { plugin: 'me' })
        .dropped
    ).toEqual(['@font-face'])
    expect(face('"quickcss_x"', null)).toContain('quickcss_x')
    expect(face('"quickcss-x"', null)).toBe('')
    expect(face('"me_x"', null)).toBe('')
    expect(face('"_x"', '')).toBe('')
    expect(face('"quickcss_x"', '')).toContain('quickcss_x')
    expect(face('"a-b_x"', 'a-b')).toContain('a-b_x')
    expect(face('"a_b-x"', 'a')).toContain('a_b-x')
    expect(face('"a-b_x"', 'a')).toBe('')
  })

  test("a plugin can't define a font the app names, whatever its id", () => {
    const face = (family: string, plugin: string) =>
      out(`@font-face{font-family:${family};src:url(asset:a.woff2)}`, plugin)
    for (const [plugin, family] of [
      ['ui', '"ui-monospace"'],
      ['ui', 'UI-Monospace'],
      ['ui', '"ui\\2d monospace"'],
      ['ui', '"ui-serif"'],
      ['ui', '"ui-sans-serif"'],
      ['ui', '"ui-rounded"'],
      ['sfmono', '"SFMono-Regular"'],
      ['sfmono', 'sfmono-regular'],
      ['system', '"system-ui"'],
      ['sans', '"sans-serif"'],
    ])
      expect(face(family, plugin)).toBe('')
    for (const [plugin, family] of [
      ['ui', '"ui-mono"'],
      ['sfmono', '"sfmono-bold"'],
      ['system', '"system-uix"'],
    ])
      expect(face(family, plugin)).toBe('')
    expect(face('"ui_monospace"', 'ui')).toContain('"ui_monospace"')
    expect(face('"sans_serif"', 'sans')).toContain('"sans_serif"')
  })

  test('a font family a plugin defines is printable ASCII, so no case folding makes it an app font', () => {
    const face = (family: string, plugin: string) =>
      out(`@font-face{font-family:${family};src:url(asset:a.woff2)}`, plugin)
    for (const [plugin, family] of [
      ['ui', '"ui-mono\u017fpace"'],
      ['ui', 'ui-mono\\17f pace'],
      ['ui', '"ui-mono\\17fpace"'],
      ['ui', '"ui-\u017fans-serif"'],
      ['sans', '"sans-\u017ferif"'],
      ['sans', '"sans-\u017fERIF"'],
      ['ui', '"ui_mono\u017fpace"'],
      ['me', '"me_\u212aelvin"'],
      ['me', '"me_caf\u00e9"'],
      ['me', '"me_a\u00a0b"'],
      ['me', '"me_a\\9 b"'],
      ['me', '"me_a\\7f b"'],
      ['me', '"me_\\0"'],
      ['me', '"me\uff3fsans"'],
    ])
      expect(face(family, plugin)).toBe('')
    for (const family of ['"me_a b"', '"me_A~z"', "'me_{x}'"])
      expect(face(family, 'me')).toContain('@font-face{font-family:')
  })

  test('no font family the app and Tailwind name holds an underscore, and those an id could start are listed', () => {
    const files = [
      fileURLToPath(new URL('../../globals.css', import.meta.url)),
      fileURLToPath(import.meta.resolve('tailwindcss/theme.css')),
      fileURLToPath(import.meta.resolve('tailwindcss/preflight.css')),
    ]
    const names = new Set<string>()
    for (const file of files) {
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      const lists = [
        ...css.matchAll(/--font-[a-z]+\s*:([^;]*);/g),
        ...css.matchAll(/font-family\s*:([^;]*);/g),
      ].map(m => m[1].replace(/--theme\(\s*--[a-z-]+\s*,/, '').replace(/\)\s*$/, ''))
      for (const list of lists)
        for (const part of list.split(','))
          names.add(
            part
              .trim()
              .replace(/^['"]|['"]$/g, '')
              .toLowerCase()
          )
    }
    for (const name of ['roboto', 'ui-monospace', 'sfmono-regular', 'system-ui', 'sans-serif'])
      expect(names).toContain(name)
    for (const name of names) if (name.includes('_')) throw new Error(`${name} holds an underscore`)
    for (const name of names)
      if (/^[a-z][a-z0-9-]{1,39}-./.test(name) && !APP_FONTS.includes(name))
        throw new Error(`${name} is not in APP_FONTS`)
    for (const name of ['ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'system-ui'])
      expect(APP_FONTS).toContain(name)
    for (const name of APP_FONTS) expect(name).toBe(name.toLowerCase())
  })

  test('every other at-rule is dropped', () => {
    for (const css of [
      '@import url(https://evil.example/x.css);',
      '@import "https://evil.example/x.css";',
      '@\\69mport "https://evil.example/x.css";',
      '@IMPORT "x.css" screen;',
      '@namespace svg url(http://www.w3.org/2000/svg);',
      '@charset "utf-8";',
      '@property --x { syntax: "<color>"; inherits: false; initial-value: red }',
      '@scope (.a) { .b { color: red } }',
      '@page { margin: 0 }',
      '@counter-style x { symbols: "a" }',
      '@document url(https://evil.example/) { a { color: red } }',
      '@starting-style { a { opacity: 0 } }',
      '@view-transition { navigation: auto }',
      '@unknown { a { color: red } }',
      '@media screen { @import "https://evil.example/x.css"; }',
    ])
      expect(out(css)).toBe('')
    expect(out('@import "x.css"; .a{color:red} @charset "x";')).toBe(`${APP} .a{color:red}`)
    expect(sanitizeCss('@import "x.css";').dropped).toEqual(['@import'])
  })

  test('nested rules are not followed', () => {
    expect(out('.a { color: red; .b { color: blue } }')).toBe(`${APP} .a{color:red}`)
    expect(out('.a { & .b { color: blue } color: green; margin: 0 }')).toBe(
      `${APP} .a{color:green;margin:0}`
    )
    expect(out('.a { @media print { color: blue } margin: 0 }')).toBe(`${APP} .a{margin:0}`)
    expect(out('.a { }')).toBe('')
  })

  test('broken css loses the broken part only', () => {
    expect(out('.a { color: red; ] ; margin: 0 }')).toBe(`${APP} .a{color:red;margin:0}`)
    expect(out('.a { color red; margin: 0 }')).toBe(`${APP} .a{margin:0}`)
    expect(out('.a { color: red')).toBe(`${APP} .a{color:red}`)
    expect(out('.a ) { color: red } .b { color: blue }')).toBe(`${APP} .b{color:blue}`)
    expect(out('.a')).toBe('')
    expect(out('<!-- .a{color:red} -->')).toBe(`${APP} .a{color:red}`)
    expect(out('.a { background: "x\n; color: red }')).toBe(`${APP} .a{color:red}`)
    expect(out('.a { background: url(a b); color: red }')).toBe(`${APP} .a{color:red}`)
  })
})

describe('css: no addresses', () => {
  const decl = (value: string, name = 'background') => out(`.a{${name}:${value}}`)
  const kept = (value: string, name = 'background') => `${APP} .a{${name}:${value}}`

  test('an address is removed wherever url() is written', () => {
    for (const value of [
      'url(https://evil.example/x.png)',
      'url("https://evil.example/x.png")',
      "url( 'https://evil.example/x.png' )",
      'URL(https://evil.example/x.png)',
      'u\\72l(https://evil.example/x.png)',
      '\\75 rl("https://evil.example/x.png")',
      'url(//evil.example/x.png)',
      'url(/x.png)',
      'url(x.png)',
      'url(http://evil.example/)',
      'url(data:text/html,evil)',
      'url(data:application/javascript,evil)',
      'url(blob:https://evil.example/1)',
      'url(javascript:evil)',
      'src("https://evil.example/x.png")',
      'url("https://evil.example/x.png" cross-origin(anonymous))',
    ]) {
      expect(decl(`${value} red`)).toBe(kept('red'))
      expect(decl(value)).toBe('')
    }
  })

  test("the plugin's own assets and inline images and fonts stay", () => {
    expect(decl('url(asset:img/a.png)')).toBe(kept('url("asset:img/a.png")'))
    expect(decl('url("asset:img/a.png") no-repeat')).toBe(kept('url("asset:img/a.png") no-repeat'))
    expect(decl('url(data:image/png;base64,AAAA)')).toBe(kept('url("data:image/png;base64,AAAA")'))
    expect(decl('url("data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\'/>")')).toBe(
      kept('url("data:image/svg+xml,\\3c svg xmlns=\'http://www.w3.org/2000/svg\'/>")')
    )
    expect(decl('url(DATA:font/woff2;base64,AAAA)', 'src')).toBe(
      kept('url("DATA:font/woff2;base64,AAAA")', 'src')
    )
    for (const bad of [
      'asset:../a.png',
      'asset:/a.png',
      'asset:a\\\\b.png',
      'asset:',
      'asset:https://evil.example/',
      'data:image',
      'data:imagex/png,a',
      ' data:text/css,a',
    ])
      expect(decl(`url("${bad}")`)).toBe('')
  })

  test('assets become the urls the host gives for them', () => {
    const asset = (path: string) => (path === 'a.png' ? 'blob:https://app.example/1234' : null)
    const got = sanitizeCss('.a{background:url(asset:a.png)} .b{background:url(asset:b.png) red}', {
      plugin: 'me',
      asset,
    })
    expect(got.css).toBe(
      `${APP} .a{background:url("blob:https://app.example/1234")}\n${APP} .b{background:red}`
    )
  })

  test('image-set and image take bare strings, so those are addresses too', () => {
    expect(decl('image-set("https://evil.example/x.png" 1x, "asset:a.png" 2x)')).toBe(
      kept('image-set( 1x, "asset:a.png" 2x)')
    )
    expect(decl('-webkit-image-set("https://evil.example/x.png" 1x)')).toBe(
      kept('-webkit-image-set( 1x)')
    )
    expect(decl('image("https://evil.example/x.png", red)')).toBe(kept('image(, red)'))
    expect(decl('IMAGE-SET(url(https://evil.example/x.png) 1x)')).toBe(kept('IMAGE-SET( 1x)'))
    expect(decl('cross-fade("https://evil.example/x.png", red)')).toBe(kept('cross-fade(, red)'))
    expect(decl('linear-gradient(red, blue), image-set("asset:a.png" 1x)')).toBe(
      kept('linear-gradient(red, blue), image-set("asset:a.png" 1x)')
    )
  })

  test('a string elsewhere is text, not an address', () => {
    expect(decl('"Mine", serif', 'font-family')).toBe(kept('"Mine", serif', 'font-family'))
    expect(decl('"a b" "c d"', 'grid-template-areas')).toBe(
      kept('"a b" "c d"', 'grid-template-areas')
    )
    expect(decl('local("Mine"), url(asset:a.woff2) format("woff2")', 'src')).toBe(
      kept('local("Mine"), url("asset:a.woff2") format("woff2")', 'src')
    )
  })

  test('in a custom property every string and url is an address', () => {
    expect(decl('"https://evil.example/x.png"', '--x')).toBe('')
    expect(decl('url(https://evil.example/x.png)', '--x')).toBe('')
    expect(decl('image-set("https://evil.example/x.png" 1x)', '--x')).toBe(
      kept('image-set( 1x)', '--x')
    )
    expect(decl('"asset:a.png" 4px red', '--x')).toBe(kept('url("asset:a.png") 4px red', '--x'))
    expect(decl('image-set("asset:a.png" 1x)', '--x')).toBe(
      kept('image-set(url("asset:a.png") 1x)', '--x')
    )
    expect(decl('"hello" 4px', '--label')).toBe(kept('4px', '--label'))
    expect(decl('var(--y, "https://evil.example/")', '--x')).toBe(kept('var(--y, )', '--x'))
    expect(decl('4px', '--Gap')).toBe(kept('4px', '--Gap'))
  })

  test('a custom property never holds a string, so none can be shown as text through var()', () => {
    expect(
      out(
        '.a{--t:"data:image/x,You are banned";--u:"asset:Hello.World"} .b::before{content:var(--t) var(--u)}'
      )
    ).toBe(`${APP} .a{--t:url("data:image/x,You are banned");--u:url("asset:Hello.World")}`)
    for (const value of [
      '"data:image/png,Admin"',
      '"asset:Admin"',
      'x "data:font/a;Admin" y',
      'f("data:image/a,Admin")',
      'image-set("data:image/a,Admin" 1x)',
      'var(--y, "data:image/a,Admin")',
      '[ "data:image/a,Admin" ]',
    ]) {
      const tokens = tokenize(out(`.a{--x:${value}}`))
      const strings = tokens.filter(
        (t, n) => t.type === 'string' && tokens[n - 1]?.type !== 'function'
      )
      if (strings.length) throw new Error(value)
      if (!tokens.some(t => t.type === 'function' && t.value === 'url')) throw new Error(value)
    }
    expect(out('.b::before{content:var(--t, "Admin");color:red}')).toBe(
      `${APP} .b::before{color:red}`
    )
    expect(out('.b::before{content:attr(title, "Admin");color:red}')).toBe(
      `${APP} .b::before{color:red}`
    )
    expect(out('.b::before{content:env(x, "Admin");color:red}')).toBe(
      `${APP} .b::before{color:red}`
    )
  })

  test('no address survives in any at-rule', () => {
    const evil = 'https://evil.example/x'
    for (const css of [
      `@font-face{font-family:x;src:url(${evil})}`,
      `@media (min-width:1px){.a{background:url(${evil})}}`,
      `@supports (background:url(${evil})){.a{color:red}}`,
      `@keyframes k{from{background:url(${evil})}}`,
      `@layer x{.a{cursor:url(${evil}),auto}}`,
      `.a{list-style:url(${evil})}`,
      `.a{content:url(${evil})}`,
      `.a{mask:url(${evil}#m)}`,
      `.a{filter:url("${evil}#f")}`,
      `.a{border-image:url(${evil}) 30}`,
      `.a{background:/**/url(/**/"${evil}")}`,
      `.a{background:url(\n${evil}\n)}`,
      `.a{-x:expression(url(${evil}))}`,
    ])
      if (out(css).includes('evil')) throw new Error(css)
  })
})

describe('css: nothing that could end a style element', () => {
  test('no output holds the two characters that start a closing tag', () => {
    for (const css of [
      '.a{color:</style><script>alert(1)</script>}',
      '.a{color:</**/style>}',
      '.a{font-family:"</style><script>alert(1)</script>"}',
      '.a{--x:</style>}',
      '.a{--x:"</style>" url("data:image/svg+xml,</style>")}',
      '.a{background:url("data:image/svg+xml,<svg></svg></style><script>")}',
      '@media (width </style>){.a{color:red}}',
      '@supports (x:</style>){.a{color:red}}',
      '@keyframes </style>{from{opacity:0}}',
      '@layer </style>;',
      '</style><script>alert(1)</script>{color:red}',
      '.a\\<\\/style\\>{color:red}',
      '[data-rc-plugin="me"] .x::before{content:"</style><script>alert(1)</script>"}',
      '[title="</style>"]{color:red}',
      '.a{color:a\\</style><script>alert(1)</script>}',
      '.a{color:a\\3c /style>}',
      '.a{width:1\\</style>}',
      '.a{width:1px\\</style>}',
      '.a{color:@a\\</style>}',
      '.a{color:#a\\</style>}',
      '.a{color:f\\<(1)/style>}',
      '.a{color:<!x}',
      '.a{--x:<!-- </style>}',
      '.a{color:<\\/style>}',
      '@media a\\</style>{.a{color:red}}',
      '@supports (a\\</style>){.a{color:red}}',
      '@container a\\</style>{.a{color:red}}',
      '@layer a\\<, b { .a{color:red} }',
      '.a\\<{color:red} /style>{color:red}',
      '.a{a\\<:b;/style>:c}',
    ]) {
      const got = sanitizeCss(css, { plugin: 'me' }).css
      if (got.includes('</')) throw new Error(`${css} -> ${got}`)
    }
  })

  test('a name that holds the character is kept, with it written as an escape', () => {
    expect(out('.a{font-family:a\\<b}')).toBe(`${APP} .a{font-family:a\\3c b}`)
    expect(out('.a{font-family:a\\</b}')).toBe(`${APP} .a{font-family:a\\3c /b}`)
    expect(out('.a\\<b{color:red}')).toBe(`${APP} .a\\3c b{color:red}`)
    expect(out('#a\\<b{color:red}')).toBe(`${APP} #a\\3c b{color:red}`)
    expect(out('.a{width:1\\<}')).toBe(`${APP} .a{width:1\\3c }`)
    expect(tokenize('a\\3c /b')).toEqual([
      { type: 'ident', value: 'a<' },
      { type: 'delim', value: '/' },
      { type: 'ident', value: 'b' },
    ])
  })

  test('a value where the two characters would meet is dropped, the rest of the rule stays', () => {
    expect(out('.a{color:</style>;margin:0}')).toBe(`${APP} .a{margin:0}`)
    expect(out('.a{color:<!x;margin:0}')).toBe(`${APP} .a{margin:0}`)
    expect(out('.a{color:< /b;margin:0}')).toBe(`${APP} .a{color:< /b;margin:0}`)
    expect(sanitizeCss('@media (a </b){.a{color:red}} .b{color:red}').css).toBe(
      `${APP} .b{color:red}`
    )
  })

  test('the text itself is kept, written another way', () => {
    expect(out('[data-rc-plugin="me"] .x::before{content:"a<b"}')).toBe(
      `${APP} [data-rc-plugin="me"] .x::before{content:"a\\3c b"}`
    )
    expect(tokenize('"a\\3c b"')).toEqual([{ type: 'string', value: 'a<b' }])
    expect(out('@media (400px <= width <= 700px){.a{color:red}}')).toBe(
      `@media (400px <= width <= 700px){${APP} .a{color:red}}`
    )
  })
})

describe('css: scoping', () => {
  const sel = (s: string) => out(`${s}{color:red}`).replace(/\{color:red\}$/, '')

  test('every selector goes under the app container', () => {
    expect(sel('*')).toBe(`${APP} *`)
    expect(sel('a b > c')).toBe(`${APP} a b > c`)
    expect(sel('.a:not(.b):has(> .c)')).toBe(`${APP} .a:not(.b):has(> .c)`)
    expect(sel(':is(.a, .b) .c')).toBe(`${APP} :is(.a, .b) .c`)
    expect(sel('[data-rc="message"] [data-rc="message-author"]')).toBe(
      `${APP} [data-rc="message"] [data-rc="message-author"]`
    )
    expect(sel('.html .body [body] #body-x')).toBe(`${APP} .html .body [body] #body-x`)
    expect(sel('[id] [id="msg-1"] [id^="msg-"] [id*="zzz"] [id|="msg"] [id^=""]')).toBe(
      `${APP} [id] [id="msg-1"] [id^="msg-"] [id*="zzz"] [id|="msg"] [id^=""]`
    )
    expect(sel('[*|id^="msg-"] [ns|title^="rc-p"] [id|="msg"]')).toBe(
      `${APP} [*|id^="msg-"] [ns|title^="rc-p"] [id|="msg"]`
    )
    expect(sel('[class^="rc-prot"] [data-x|="rc"] [title$="protected"]')).toBe(
      `${APP} [class^="rc-prot"] [data-x|="rc"] [title$="protected"]`
    )
    expect(sel('  .a  ,  .b  ')).toBe(`${APP} .a,${APP} .b`)
  })

  test('selectors that name the page, a shadow host, the backdrop or the protected root are refused', () => {
    for (const s of [
      ':root',
      'html',
      'body',
      'HTML',
      'BoDy .a',
      'html > body .a',
      '.a body',
      '\\62ody',
      ':host',
      ':host(.a)',
      ':host-context(.a) .b',
      '::backdrop',
      'dialog::backdrop',
      ':backdrop',
      '#rc-protected',
      '#rc-protected *',
      '[id="rc-protected"]',
      '[id=rc-protected] *',
      '[id*="rc-protected" i]',
      '[id^="rc-prot"]',
      '[id^=rc]',
      '[id$="protected"]',
      '[id*="c-p"]',
      '[id|="rc"]',
      '[id~="rc-protected"]',
      '[ID="RC-PROTECTED"]',
      '[ id ^= "rc-" ] *',
      ':not([id^="rc-p"])',
      '[*|id^="rc-p"]',
      '[|id$="protected"]',
      '[ns|id*="c-p"]',
      '[*|ID|="rc"]',
      '[ * | id ^= rc ]',
      ':scope',
      ':scope > .a',
      '& .a',
      ':is(body, .a)',
      ':not(html) .a',
      '.a:has(~ body)',
      ':where(:root) .a',
      '*|html',
    ])
      expect(sel(s)).toBe('')
  })

  test('a refused selector leaves the rest of its list', () => {
    expect(sel('.a, body, .b')).toBe(`${APP} .a,${APP} .b`)
    expect(sanitizeCss('body, :root{color:red}').dropped).toEqual([
      'selector body',
      'selector :root',
    ])
  })

  test('a selector that is not one is refused', () => {
    for (const s of [
      '',
      ',',
      '.a,',
      ', .a',
      '@media',
      'a;b',
      'url(x)',
      '"a"',
      '.a\\\n',
      'a!b',
      '> .a',
      '.a >',
      '.a > > .b',
      '(.a)',
      '1a',
      '#1',
    ])
      expect(out(`${s}{color:red} .ok{color:red}`)).toBe(`${APP} .ok{color:red}`)
  })

  test('a leading compound of accessibility attributes goes onto the app element itself', () => {
    expect(sel("[data-contrast='more'] .a")).toBe(`${APP}[data-contrast="more"] .a`)
    expect(sel('[data-theme=dark][data-density="compact"] > .a b')).toBe(
      `${APP}[data-theme=dark][data-density="compact"] > .a b`
    )
    expect(sel('[data-theme="black"] [data-rc="composer"]')).toBe(
      `${APP}[data-theme="black"] [data-rc="composer"]`
    )
    for (const attr of A11Y_ATTRS) expect(sel(`[${attr}] .a`)).toBe(`${APP}[${attr}] .a`)
    expect(A11Y_ATTRS).toHaveLength(14)
  })

  test('anything else that leads is an ordinary selector under the app', () => {
    expect(sel('[data-contrast="more"]')).toBe(`${APP} [data-contrast="more"]`)
    expect(sel('[data-contrast="more"].a .b')).toBe(`${APP} [data-contrast="more"].a .b`)
    expect(sel('[data-rc-app] .a')).toBe(`${APP} [data-rc-app] .a`)
    expect(sel('[data-other] .a')).toBe(`${APP} [data-other] .a`)
    expect(sel('[data-theme="dark"] ~ .a')).toBe(`${APP} [data-theme="dark"] ~ .a`)
    expect(sel('[data-theme="dark"] + .a')).toBe(`${APP} [data-theme="dark"] + .a`)
    expect(sel('.x [data-theme="dark"] .a')).toBe(`${APP} .x [data-theme="dark"] .a`)
  })

  test('the stable selector names', () => {
    expect(SELECTORS).toHaveLength(21)
    expect(SELECTORS).toContain('message')
    expect(SELECTORS).toContain('button')
    expect(new Set(SELECTORS).size).toBe(21)
  })
})

describe('css: text only on the plugin own surfaces', () => {
  const OWN = '[data-rc-plugin="me"]'

  test('content with a string is dropped on app elements', () => {
    expect(out('.a::before{content:"Admin";color:red}')).toBe(`${APP} .a::before{color:red}`)
    expect(out(".a::after{content:'x' attr(title)}")).toBe('')
    expect(out('.a::before{content:counter(x) "."}')).toBe('')
    expect(out('.a::before{CONTENT:"x"}')).toBe('')
    expect(out('.a::before{c\\6fntent:"x"}')).toBe('')
  })

  test('content on app elements is none or normal, nothing else', () => {
    for (const v of ['none', 'normal', 'none !important', 'NONE'])
      expect(out(`.a::before{content:${v};color:red}`)).toBe(
        `${APP} .a::before{content:${v};color:red}`
      )
    for (const v of [
      '""',
      "''",
      '" "',
      '"x"',
      'counter(a)',
      'counter(a, decimal)',
      'counter(a, upper-alpha)',
      'counters(a, ".")',
      'attr(title)',
      'attr(data-x, "")',
      'var(--x)',
      'env(x)',
      'url(asset:a.png)',
      'linear-gradient(red, blue)',
      'open-quote',
      'close-quote',
      'none none',
      'normal "x"',
      'none / "alt"',
      'inherit',
      'initial',
      'c\\6funter(a)',
      'none important',
      'none ! x',
      'none !important x',
      '!important',
      'important',
    ])
      expect(out(`.a::before{content:${v};color:red}`)).toBe(`${APP} .a::before{color:red}`)
    expect(out('.a::before{c\\6fntent:"";color:red}')).toBe(`${APP} .a::before{color:red}`)
  })

  test('counters, attr() and escapes that would write text write nothing', () => {
    expect(
      out(
        '.message::after{counter-reset:a 8 b 9;content:counter(a,upper-alpha) counter(b,upper-alpha)}'
      )
    ).toBe('')
    expect(
      out(
        '.message{display:list-item;list-style:upper-alpha inside;counter-reset:list-item 3752127}'
      )
    ).toBe(`${APP} .message{display:list-item}`)
    expect(out('::marker{content:counter(list-item,upper-alpha)}')).toBe('')
    expect(out('.a{content:attr(title)}')).toBe('')
    expect(out('@keyframes k{from{content:counter(a,upper-alpha)}}')).toBe('')
    expect(out('.a::before{content:"";position:fixed;inset:0}')).toBe(
      `${APP} .a::before{position:fixed;inset:0}`
    )
  })

  test('list markers on app elements are the plain symbols', () => {
    for (const v of ['none', 'disc', 'circle', 'square', 'disclosure-open', 'disclosure-closed'])
      expect(out(`.a{list-style-type:${v}}`)).toBe(`${APP} .a{list-style-type:${v}}`)
    for (const v of [
      'none',
      'square inside',
      'outside disc',
      'inside',
      'url(asset:a.png) inside circle',
    ])
      expect(out(`.a{list-style:${v}}`)).not.toBe('')
    for (const v of [
      'decimal',
      'decimal-leading-zero',
      'upper-alpha',
      'lower-latin',
      'lower-roman',
      'lower-greek',
      'georgian',
      'cjk-decimal',
      'mine',
      '"x"',
      'symbols(cyclic "a")',
      'symbols(cyclic a)',
      'var(--x)',
      'attr(title)',
      'inherit',
      'disc disc x',
    ]) {
      expect(out(`.a{list-style-type:${v};color:red}`)).toBe(`${APP} .a{color:red}`)
      expect(out(`.a{list-style:${v} inside;color:red}`)).toBe(`${APP} .a{color:red}`)
    }
  })

  test('counters are not set on app elements', () => {
    for (const d of [
      'counter-reset:a 8',
      'counter-reset:list-item 3752127',
      'counter-set:a 1',
      'counter-increment:a 26',
      'counter-reset:none',
      'COUNTER-RESET:a',
    ])
      expect(out(`.a{${d};color:red}`)).toBe(`${APP} .a{color:red}`)
  })

  test('the other text properties take plain keywords there', () => {
    expect(
      out(
        '.a{text-overflow:ellipsis;hyphenate-character:auto;text-emphasis:filled sesame;text-emphasis-style:dot}'
      )
    ).toBe(
      `${APP} .a{text-overflow:ellipsis;hyphenate-character:auto;text-emphasis:filled sesame;text-emphasis-style:dot}`
    )
    for (const d of [
      'text-overflow:attr(title)',
      'text-overflow:var(--x)',
      'hyphenate-character:var(--x)',
      'hyphenate-character:attr(title)',
      'text-emphasis:counter(a)',
      'text-emphasis-style:counter(a, upper-alpha)',
      '-webkit-text-emphasis:var(--x)',
      'string-set:title content()',
      'string-set:title attr(title)',
      'quotes:none',
    ])
      expect(out(`.a{${d};color:red}`)).toBe(`${APP} .a{color:red}`)
  })

  test('a seeded mix of declarations never leaves one that could write a letter', () => {
    const NAMES = ['content', 'list-style', 'list-style-type', 'counter-reset', 'counter-set']
    NAMES.push(
      'counter-increment',
      'quotes',
      'text-overflow',
      'hyphenate-character',
      'text-emphasis'
    )
    NAMES.push('text-emphasis-style', 'string-set', 'CONTENT', 'c\\6fntent', 'List-Style-Type')
    NAMES.push('--tw-content', '--rc-x', '--color-primary')
    const PARTS = ['none', 'normal', 'disc', 'circle', 'square', 'inside', 'outside', 'upper-alpha']
    PARTS.push('lower-latin', 'decimal', 'lower-roman', 'open-quote', 'inherit', 'initial', 'auto')
    PARTS.push('ellipsis', 'dot', 'a', 'list-item', '8', '3752127', '""', '"A"', "'b'", '" "')
    PARTS.push('counter(a)', 'counter(a,upper-alpha)', 'counter(a, lower-greek)', 'counters(a,".")')
    PARTS.push('attr(title)', 'attr(data-x, "A")', 'var(--x)', 'var(--x, "A")', 'env(x)')
    PARTS.push('symbols(cyclic "A" "B")', 'url(asset:a.png)', 'url("data:image/png,A")', '/')
    PARTS.push('!important', 'c\\6funter(a,upper-alpha)', 'ATTR(title)', 'content()', ',')
    const HEADS = ['.a{', '.a::before{', '.a::marker{', '::marker{', 'li{', '@keyframes k{from{']
    HEADS.push(
      '@media print{.a::after{',
      '[data-rc-plugin="other"] .x::before{',
      '.x [data-rc-plugin="me"]{'
    )
    const KEYWORDS = ['none', 'normal', 'disc', 'circle', 'square', 'disclosure-open']
    KEYWORDS.push('disclosure-closed', 'inside', 'outside', 'auto', 'ellipsis', 'dot', 'important')
    let seed = 20261111
    const next = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n
    let kept = 0
    for (let run = 0; run < 3000; run++) {
      const head = HEADS[next(HEADS.length)]
      const decls: string[] = []
      for (let d = 0; d < 1 + next(3); d++) {
        const value = Array.from({ length: 1 + next(4) }, () => PARTS[next(PARTS.length)]).join(' ')
        decls.push(`${NAMES[next(NAMES.length)]}:${value}`)
      }
      const css = `${head}${decls.join(';')};color:red${'}'.repeat(head.split('{').length - 1)}`
      const got = sanitizeCss(css, { plugin: 'me' }).css
      const body = got.slice(got.lastIndexOf('{', got.indexOf('}')) + 1, got.indexOf('}'))
      for (const d of body.split(';')) {
        const colon = d.indexOf(':')
        const name = d.slice(0, colon)
        if (name === 'color' || d === '') continue
        if (name.startsWith('--')) throw new Error(`${css} -> ${got}`)
        const text = d.slice(colon + 1)
        const value = tokenize(name === 'list-style' ? text.replace(/url\("[^"]*"\)/g, '') : text)
        kept += 1
        const listed = name === 'content' || name.startsWith('list-style')
        const plain = value.every(
          t =>
            t.type === 'whitespace' ||
            (t.type === 'delim' && t.value === '!') ||
            (t.type === 'ident' && (!listed || KEYWORDS.includes(t.value.toLowerCase())))
        )
        if (name.startsWith('counter-') || name === 'quotes' || name === 'string-set' || !plain)
          throw new Error(`${css} -> ${got}`)
        if (name === 'content' && !/^(none|normal)( !important)?$/i.test(text))
          throw new Error(`${css} -> ${got}`)
      }
    }
    expect(kept).toBeGreaterThan(200)
  })

  test('every other way to write text is dropped there too', () => {
    for (const d of [
      'quotes:"<" ">"',
      'quotes:auto',
      'list-style-type:"-"',
      'list-style:"-" inside',
      'list-style-type:symbols(cyclic "a" "b")',
      'hyphenate-character:"="',
      '-webkit-hyphenate-character:"="',
      'text-emphasis:"x"',
      'text-emphasis-style:"x"',
      '-webkit-text-emphasis-style:"x"',
      'text-overflow:"..."',
      'string-set:title "x"',
    ])
      expect(out(`.a{${d};color:red}`)).toBe(`${APP} .a{color:red}`)
    expect(out('.a{list-style-type:disc;text-overflow:ellipsis;hyphenate-character:auto}')).toBe(
      `${APP} .a{list-style-type:disc;text-overflow:ellipsis;hyphenate-character:auto}`
    )
  })

  test("on the plugin's own surfaces every one of them stays", () => {
    for (const d of [
      'content:""',
      'content:counter(a, upper-alpha) " " attr(title)',
      'content:counters(a, ".")',
      'content:var(--x)',
      'list-style:upper-alpha inside',
      'list-style-type:symbols(cyclic "a" "b")',
      'counter-reset:a 8',
      'counter-increment:a',
      'quotes:auto',
      'text-overflow:"..."',
    ])
      expect(out(`${OWN} .x::before{${d}}`)).toBe(`${APP} ${OWN} .x::before{${d}}`)
  })

  test("it is kept in rules that stay inside the plugin's own surfaces", () => {
    expect(out(`${OWN} .x::before{content:"Roll"}`)).toBe(
      `${APP} ${OWN} .x::before{content:"Roll"}`
    )
    expect(out(`[data-rc-plugin='me'] > .x{quotes:"<" ">"}`)).toBe(
      `${APP} ${OWN} > .x{quotes:"\\3c " ">"}`
    )
    expect(out(`[data-rc-plugin=me]::after{content:"x"}`)).toBe(
      `${APP} [data-rc-plugin=me]::after{content:"x"}`
    )
    expect(out(`${OWN}.card li{list-style-type:"-"}`)).toBe(
      `${APP} ${OWN}.card li{list-style-type:"-"}`
    )
    expect(out(`[data-contrast="more"] ${OWN} .x::before{content:"x"}`)).toBe(
      `${APP}[data-contrast="more"] ${OWN} .x::before{content:"x"}`
    )
    expect(out(`${OWN} .a, ${OWN} .b{content:"x"}`)).toBe(
      `${APP} ${OWN} .a,${APP} ${OWN} .b{content:"x"}`
    )
  })

  test('a rule that can reach outside them is not', () => {
    for (const s of [
      '[data-rc-plugin="other"] .x',
      '[data-rc-plugin] .x',
      '[data-rc-plugin^="m"] .x',
      '[data-rc-plugin="me" i] .x',
      '[data-rc-plugin="ME"] .x',
      `.x ${OWN}`,
      `${OWN} ~ .x`,
      `${OWN} + .x`,
      `${OWN} .x ~ .y`,
      `:is(${OWN}, .a) .x`,
      `:not(${OWN}) .x`,
      `.a:has(${OWN})`,
      `${OWN} .a, .b`,
      '.x',
    ])
      expect(out(`${s}::before{content:"x";color:red}`)).toContain('{color:red}')
  })

  test('Quick CSS has no surfaces of its own', () => {
    expect(out(`${OWN} .x::before{content:"x";color:red}`, null)).toBe(
      `${APP} ${OWN} .x::before{color:red}`
    )
    expect(out('.a{color:red;background:url(https://evil.example/x)}', null)).toBe(
      `${APP} .a{color:red}`
    )
    expect(out('[data-rc-plugin="null"] .x{content:"x"}', null)).toBe('')
  })

  test('keyframes have no selector, so no text', () => {
    expect(out('@keyframes k{from{content:"a";opacity:0}}')).toBe(
      '@keyframes me_k{from{opacity:0}}'
    )
  })
})

describe("css: the app's own variables", () => {
  test('a plugin cannot set them, on app elements or on its own', () => {
    for (const name of [
      '--rc-outline-width',
      '--rc-safe-color-on-surface',
      '--rc-x',
      '--color-outline',
      '--color-on-surface',
      '--color-mine',
      '--md-sys-color-primary',
      '--font-sans',
      '--shadow-elevation-1',
      '--animate-speak',
      '--safe-top',
      '--titlebar-h',
      '--rail-cut',
      '--tw-ring-color',
      '--tw-content',
      '--motion-short',
      '--c\\6flor-outline',
    ]) {
      expect(out(`.a{${name}:0;margin:0}`)).toBe(`${APP} .a{margin:0}`)
      expect(out(`.a{${name}:transparent !important;margin:0}`)).toBe(`${APP} .a{margin:0}`)
      expect(out(`[data-rc-plugin="me"]{${name}:0;margin:0}`)).toBe(
        `${APP} [data-rc-plugin="me"]{margin:0}`
      )
      expect(out(`@keyframes k{from{${name}:0;opacity:0}}`)).toBe(
        '@keyframes me_k{from{opacity:0}}'
      )
    }
    expect(sanitizeCss('.a{--rc-outline-width:0}').dropped).toEqual([
      'declaration --rc-outline-width',
    ])
  })

  test("a variable the app's generated text reads cannot be set", () => {
    for (const v of [
      'counter(list-item, upper-roman)',
      'counters(list-item, ".")',
      'attr(title)',
      '"x"',
      'none',
    ])
      expect(out(`.a{--tw-content:${v};margin:0}`)).toBe(`${APP} .a{margin:0}`)
    expect(out('.a::before{--tw-content:counter(list-item, upper-alpha)}')).toBe('')
    expect(out('.a{display:list-item;--tw-content:counter(list-item, lower-greek)}')).toBe(
      `${APP} .a{display:list-item}`
    )
    expect(APP_VARIABLES).toContain('--tw-')
  })

  test('its own names are fine, and reading the app ones is too', () => {
    for (const name of [
      '--x',
      '--my-color',
      '--RC-x',
      '--rcx',
      '--colors-x',
      '--Color-outline',
      '--me-rc-x',
      '--twx',
      '--my-tw-content',
    ])
      expect(out(`.a{${name}:1px}`)).toBe(`${APP} .a{${name}:1px}`)
    expect(out('.a{color:var(--color-primary);outline-width:var(--rc-outline-width, 1px)}')).toBe(
      `${APP} .a{color:var(--color-primary);outline-width:var(--rc-outline-width, 1px)}`
    )
  })

  test('the list covers every variable the stylesheet defines or reads', () => {
    const css = readFileSync(fileURLToPath(new URL('../../globals.css', import.meta.url)), 'utf8')
    const names = new Set<string>()
    for (const m of css.matchAll(/(--[a-z][a-z0-9-]*)\s*:/g)) names.add(m[1])
    for (const m of css.matchAll(/var\(\s*(--[a-z][a-z0-9-]*)/g)) names.add(m[1])
    expect(names.size).toBeGreaterThan(50)
    for (const name of names)
      if (!APP_VARIABLES.some(prefix => name.startsWith(prefix)))
        throw new Error(`${name} is not covered by APP_VARIABLES`)
    expect(APP_VARIABLES).toContain('--rc-')
    expect(APP_VARIABLES).toContain('--color-')
    expect(APP_VARIABLES).toContain('--md-')
    for (const name of Object.keys(DURATION_VARS))
      if (!APP_VARIABLES.some(prefix => name.startsWith(prefix)))
        throw new Error(`${name} is not covered by APP_VARIABLES`)
    for (const prefix of APP_VARIABLES) expect(/^--[a-z]+-$/.test(prefix)).toBe(true)
  })
})

describe('css: reaching into other trees and other elements', () => {
  test('::part() and ::slotted() are refused', () => {
    for (const s of [
      '.a::part(label)',
      'x-el::part(a b)',
      '::part(x)',
      '::slotted(.b)',
      '.a ::slotted(*)',
      ':is(.a::part(x))',
    ])
      expect(out(`${s}{color:red} .ok{color:red}`)).toBe(`${APP} .ok{color:red}`)
  })

  test('a value cannot paint another element or run a worklet', () => {
    expect(out('.a{background:element(#rc-protected)}')).toBe('')
    expect(out('.a{background:-moz-element(#x) red}')).toBe(`${APP} .a{background:red}`)
    expect(out('.a{background-image:paint(checker)}')).toBe('')
    expect(out('.a{background:ELEMENT(#x), linear-gradient(red, blue)}')).toBe(
      `${APP} .a{background:, linear-gradient(red, blue)}`
    )
    expect(out('.a{--x:element(#a) 1px}')).toBe(`${APP} .a{--x:1px}`)
    expect(out('.a{mask:image(element(#a))}')).toBe(`${APP} .a{mask:image()}`)
    expect(sanitizeCss('.a{background:element(#a)}').dropped).toEqual([
      'function element',
      'declaration background',
    ])
  })

  test('a cursor is one of the built-in ones, never an image', () => {
    for (const v of ['pointer', 'not-allowed', 'grab', 'auto !important'])
      expect(out(`.a{cursor:${v}}`)).toBe(`${APP} .a{cursor:${v}}`)
    for (const v of [
      'url(asset:a.png), auto',
      'url(data:image/png;base64,AAAA) 30 30, pointer',
      'image-set("asset:a.png" 1x), auto',
      'var(--c)',
      '"x"',
    ])
      expect(out(`.a{cursor:${v};color:red}`)).toBe(`${APP} .a{color:red}`)
  })
})

describe('css: names for the whole page carry the plugin id', () => {
  test('keyframes are renamed, and so is every use of them in the same sheet', () => {
    expect(out('@keyframes spin{from{opacity:0}} .a{animation:spin 1s infinite}')).toBe(
      `@keyframes me_spin{from{opacity:0}}\n${APP} .a{animation:me_spin 1s infinite}`
    )
    expect(
      out(
        '.a{animation-name:spin, pulse, other} @keyframes spin{to{opacity:1}} @keyframes pulse{to{opacity:1}}'
      )
    ).toBe(
      `${APP} .a{animation-name:me_spin, me_pulse, other}\n@keyframes me_spin{to{opacity:1}}\n@keyframes me_pulse{to{opacity:1}}`
    )
    expect(out('@media print{@keyframes spin{to{opacity:1}}} .a{-webkit-animation:1s spin}')).toBe(
      `@media print{@keyframes me_spin{to{opacity:1}}}\n${APP} .a{-webkit-animation:1s me_spin}`
    )
    expect(out('@keyframes "spin"{to{opacity:1}} .a{animation-name:"spin"}')).toBe(
      `@keyframes "me_spin"{to{opacity:1}}\n${APP} .a{animation-name:"me_spin"}`
    )
  })

  test('a name the plugin did not define is left alone, as are the animation keywords', () => {
    expect(out('.a{animation:sheet-up 160ms ease-out}')).toBe(
      `${APP} .a{animation:sheet-up 160ms ease-out}`
    )
    expect(out('@keyframes Spin{to{opacity:1}} .a{animation:spin 1s}')).toBe(
      `@keyframes me_Spin{to{opacity:1}}\n${APP} .a{animation:spin 1s}`
    )
    expect(
      out(
        '@keyframes infinite{to{opacity:1}} .a{animation:infinite 1s infinite;animation-name:infinite}'
      )
    ).toBe(
      `@keyframes me_infinite{to{opacity:1}}\n${APP} .a{animation:infinite 1s infinite;animation-name:me_infinite}`
    )
    expect(
      out(
        '@keyframes spin{to{opacity:1}} .a{transition:spin 1s;font-family:spin;animation:var(--a, spin) 1s}'
      )
    ).toBe(
      `@keyframes me_spin{to{opacity:1}}\n${APP} .a{transition:spin 1s;font-family:spin;animation:var(--a, spin) 1s}`
    )
  })

  test("no plugin id can make one of the app's names", () => {
    const css = readFileSync(fileURLToPath(new URL('../../globals.css', import.meta.url)), 'utf8')
    const app = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map(m => m[1])
    expect(app).toContain('sheet-up')
    expect(app.length).toBeGreaterThan(4)
    for (const name of app) {
      if (name.includes('_')) throw new Error(`${name} holds an underscore`)
      const words = name.split('-')
      for (let i = 1; i <= words.length; i++) {
        const plugin = words.slice(0, i).join('-')
        const rest = words.slice(i).join('-') || 'x'
        const sheet = `@keyframes ${rest}{to{opacity:1}} @keyframes ${name}{to{opacity:1}} @layer ${rest}{.b{color:red}} .a{anchor-name:--${rest};view-transition-name:${rest};animation:${name} 1s}`
        const got = sanitizeCss(sheet, { plugin }).css
        expect(got).toContain(`view-transition-name:${plugin}_${rest}`)
        for (const t of tokenize(got.replace(/animation:[^;}]*/, '')))
          if ('value' in t && (t.value === name || t.value === `--${name}`))
            throw new Error(`${plugin}: ${got}`)
      }
    }
  })

  test('a name that already carries the id stays, so a second run changes nothing', () => {
    const once = out(
      '@keyframes me_spin{to{opacity:1}} @keyframes spin{to{opacity:1}} .a{animation:me_spin 1s, spin 2s}'
    )
    expect(once).toBe(
      `@keyframes me_spin{to{opacity:1}}\n@keyframes me_spin{to{opacity:1}}\n${APP} .a{animation:me_spin 1s, me_spin 2s}`
    )
    expect(out(once)).toBe(once)
    expect(out('@keyframes me-spin{to{opacity:1}} .a{animation:me-spin 1s}')).toBe(
      `@keyframes me_me-spin{to{opacity:1}}\n${APP} .a{animation:me_me-spin 1s}`
    )
  })

  test('layers are renamed too, at the first name of a path', () => {
    expect(
      out('@layer base, extra.deep; @layer base{.a{color:red}} @layer extra.deep{.b{color:red}}')
    ).toBe(
      `@layer me_base, me_extra.deep;\n@layer me_base{${APP} .a{color:red}}\n@layer me_extra.deep{${APP} .b{color:red}}`
    )
    expect(out('@layer{.a{color:red}}')).toBe(`@layer{${APP} .a{color:red}}`)
    expect(out('@layer me_base{.a{color:red}}')).toBe(`@layer me_base{${APP} .a{color:red}}`)
  })

  test('Quick CSS uses its own prefix', () => {
    expect(
      out('@keyframes spin{to{opacity:1}} .a{animation:spin 1s} @layer x{.a{color:red}}', null)
    ).toBe(
      `@keyframes quickcss_spin{to{opacity:1}}\n${APP} .a{animation:quickcss_spin 1s}\n@layer quickcss_x{${APP} .a{color:red}}`
    )
    expect(out('.a{anchor-name:--tip;view-transition-name:card}', null)).toBe(
      `${APP} .a{anchor-name:--quickcss_tip;view-transition-name:quickcss_card}`
    )
  })

  test('anchor names, and every use of one, carry the id', () => {
    expect(
      out(
        '.a{anchor-name:--tip, --menu} .b{position-anchor:--tip;top:anchor(--tip bottom);width:calc(anchor-size(--menu width) + 2px);anchor-scope:--tip}'
      )
    ).toBe(
      `${APP} .a{anchor-name:--me_tip, --me_menu}\n${APP} .b{position-anchor:--me_tip;top:anchor(--me_tip bottom);width:calc(anchor-size(--me_menu width) + 2px);anchor-scope:--me_tip}`
    )
    expect(
      out('.a{anchor-name:none;anchor-scope:all;top:anchor(top);left:anchor(--x left, 2px)}')
    ).toBe(
      `${APP} .a{anchor-name:none;anchor-scope:all;top:anchor(top);left:anchor(--me_x left, 2px)}`
    )
    expect(out('.a{position-try-fallbacks:flip-block, --b;position-try:most-height --c}')).toBe(
      `${APP} .a{position-try-fallbacks:flip-block, --me_b;position-try:most-height --me_c}`
    )
    expect(out('.a{ANCHOR-NAME:--x !important}')).toBe(`${APP} .a{anchor-name:--me_x !important}`)
  })

  test('view transition and timeline names carry the id', () => {
    expect(
      out(
        '.a{view-transition-name:card} .b{view-transition-name:none} .c{view-transition-name:match-element} .d{view-transition-name:auto !important}'
      )
    ).toBe(
      `${APP} .a{view-transition-name:me_card}\n${APP} .b{view-transition-name:none}\n${APP} .c{view-transition-name:match-element}\n${APP} .d{view-transition-name:auto !important}`
    )
    expect(
      out(
        '.a{scroll-timeline:--s block;view-timeline-name:--v;timeline-scope:--s, --v} .b{animation-timeline:--v, auto;scroll-timeline-name:--t;view-timeline:--w inline}'
      )
    ).toBe(
      `${APP} .a{scroll-timeline:--me_s block;view-timeline-name:--me_v;timeline-scope:--me_s, --me_v}\n${APP} .b{animation-timeline:--me_v, auto;scroll-timeline-name:--me_t;view-timeline:--me_w inline}`
    )
  })

  test('a name cannot come from a variable, an attribute or the parent', () => {
    for (const d of [
      'anchor-name:var(--n)',
      'anchor-name:inherit',
      'anchor-name:INHERIT',
      'position-anchor:var(--n)',
      'view-transition-name:var(--n)',
      'view-transition-name:attr(id type(<custom-ident>))',
      'view-transition-name:inherit',
      'timeline-scope:env(x)',
      'animation-timeline:scroll()',
      'all:inherit',
      'all:INHERIT !important',
    ])
      expect(out(`.a{--n:--rc-mark;${d};color:red}`)).toBe(`${APP} .a{--n:--rc-mark;color:red}`)
    expect(out('.a{all:unset;color:red}')).toBe(`${APP} .a{all:unset;color:red}`)
  })

  test('a name that already carries the id stays, so a second run changes nothing again', () => {
    const once = out(
      '.a{anchor-name:--me_x, --y;view-transition-name:me_card;top:anchor(--me_x top)} .b{view-transition-name:card;animation-timeline:--me_t}'
    )
    expect(once).toBe(
      `${APP} .a{anchor-name:--me_x, --me_y;view-transition-name:me_card;top:anchor(--me_x top)}\n${APP} .b{view-transition-name:me_card;animation-timeline:--me_t}`
    )
    expect(out(once)).toBe(once)
  })

  test('the same names on the plugin own surfaces and in keyframes', () => {
    expect(out('[data-rc-plugin="me"] .x{anchor-name:--x;view-transition-name:x}')).toBe(
      `${APP} [data-rc-plugin="me"] .x{anchor-name:--me_x;view-transition-name:me_x}`
    )
    expect(out('@keyframes k{to{top:anchor(--x top);opacity:1}}')).toBe(
      '@keyframes me_k{to{top:anchor(--me_x top);opacity:1}}'
    )
  })
})

describe('css: caps and repeat runs', () => {
  test('the cap is on what the plugin wrote; what was stored may be larger', () => {
    const big = `${'a,'.repeat(100_000)}a{color:red}`
    expect(big.length).toBeLessThan(CSS_MAX_BYTES)
    const once = sanitizeCss(big, { plugin: 'me' }).css
    expect(once.length).toBeGreaterThan(CSS_MAX_BYTES * 8)
    expect(once.length).toBeLessThan(CSS_MAX_STORED_BYTES)
    expect(sanitizeCss(once, { plugin: 'me' })).toEqual({ css: '', dropped: ['too large'] })
    expect(sanitizeCss(once, { plugin: 'me', maxBytes: CSS_MAX_STORED_BYTES }).css).toBe(once)
    expect(CSS_MAX_STORED_BYTES).toBe(32 * CSS_MAX_BYTES)
    expect(sanitizeCss('.a{color:red}', { maxBytes: 5 })).toEqual({
      css: '',
      dropped: ['too large'],
    })
  }, 60_000)

  test('stored output fits the stored cap with the longest id', () => {
    const plugin = `a${'b'.repeat(39)}`
    for (const make of [
      (n: number) => `@layer ${'a,'.repeat(n)}a;`,
      (n: number) => `@keyframes a{to{opacity:1}}.x{animation:${'a,'.repeat(n)}a}`,
    ]) {
      const n = Math.floor((CSS_MAX_BYTES - 64) / 2)
      const sheet = make(n)
      expect(sheet.length).toBeLessThanOrEqual(CSS_MAX_BYTES)
      const once = sanitizeCss(sheet, { plugin }).css
      expect(once.length).toBeGreaterThan(CSS_MAX_BYTES * 20)
      expect(once.length).toBeLessThanOrEqual(CSS_MAX_STORED_BYTES)
      expect(sanitizeCss(once, { plugin, maxBytes: CSS_MAX_STORED_BYTES }).css).toBe(once)
    }
  }, 120_000)

  test('at most 256 KiB', () => {
    const fill = (bytes: number) => `.a{color:red}/*${'x'.repeat(bytes - 17)}*/`
    expect(CSS_MAX_BYTES).toBe(262144)
    expect(out(fill(CSS_MAX_BYTES))).toBe(`${APP} .a{color:red}`)
    expect(sanitizeCss(fill(CSS_MAX_BYTES + 1))).toEqual({ css: '', dropped: ['too large'] })
    expect(
      sanitizeCss('.a{color:red}/*' + '\u00e9'.repeat(CSS_MAX_BYTES / 2) + '*/').dropped
    ).toEqual(['too large'])
  })

  test('nesting past 64 levels is refused whole', () => {
    expect(sanitizeCss(`.a{color:${'('.repeat(100000)}`)).toEqual({
      css: '',
      dropped: ['nested too deep'],
    })
    expect(out(`.a{width:${'calc('.repeat(20)}1px${')'.repeat(20)}}`)).toContain('calc(')
  })

  test('what comes out goes through again unchanged', () => {
    for (const css of [
      '.a:hover, [data-contrast="more"] .b > c{margin:0 auto !important;background:url(asset:a.png) red}',
      '@media (min-width: 600px){.a{color:red}} @layer x, y; @keyframes k{from{opacity:0}to{opacity:1}}',
      '[data-rc-plugin="me"] .x::before{content:"a\\"b\\\\c";font-family:"A B", serif}',
      '@font-face{font-family:"me_mine";src:local("Mine"), url(data:font/woff2;base64,AAAA) format("woff2")}',
      '.a{--x:calc(1px + 2px);width:var(--x, 3px);transform:translate(-1px, -.5em) rotate(1e1deg)}',
      '#a1.b\\.c[d="e"]:nth-child(2n + 1)::first-line{grid-template-areas:"a b" "c d"}',
    ]) {
      const once = out(css)
      expect(once.length).toBeGreaterThan(10)
      expect(out(once)).toBe(once)
    }
  })

  test('a long run of nested blocks, selectors or rules is read in one pass', () => {
    expect(out(`.a{${'{}'.repeat(50000)}color:red}`)).toBe(`${APP} .a{color:red}`)
    expect(out(`.a{color:red;${'b{}'.repeat(20000)}}`)).toBe(`${APP} .a{color:red}`)
    expect(out('a,'.repeat(20000) + 'a{color:red}').length).toBeGreaterThan(20000 * 20)
    expect(out('.a{color:red}'.repeat(10000)).split('\n')).toHaveLength(10000)
  }, 60_000)

  test('a note is at most 80 characters', () => {
    const got = sanitizeCss(`${'a!'.repeat(500)}{color:red}`).dropped
    expect(got).toHaveLength(1)
    expect(got[0]).toHaveLength(80)
  })

  test('what was dropped is listed, at most 50 notes', () => {
    expect(
      sanitizeCss('@import "x"; body{color:red} .a{background:url(x);content:"x"}').dropped
    ).toEqual([
      '@import',
      'selector body',
      'address',
      'declaration background',
      'declaration content',
    ])
    expect(sanitizeCss('@import "x";'.repeat(80)).dropped).toHaveLength(50)
  })
})
