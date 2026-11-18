import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const APP = fileURLToPath(new URL('../../', import.meta.url))

type Sources = Record<string, string>

const read = (f: string) => readFileSync(`${APP}${f}`, 'utf8')

// The app's scripts: TypeScript and JavaScript, with or without JSX, tests aside.
const scanned = (files: string[]) =>
  files.filter(f => /\.[cm]?[jt]sx?$/.test(f) && !f.includes('__tests__')).sort()

const app = (): Sources =>
  Object.fromEntries(
    scanned(readdirSync(APP, { recursive: true, encoding: 'utf8' })).map(f => [f, read(f)])
  )

// Web Storage throws in some browsers (blocked or failing site data), so the app reaches it only
// through the guarded helpers in lib/instances.ts: readLocal, writeLocal and sessionStore. The
// theme script in layout.tsx is a string that runs before the app and reads storage once, inside
// its own try.
const HELPERS = ['lib/instances.ts']
const THEME_SCRIPT = 'layout.tsx'
const THEME_HTML =
  'try{var d=window.__RCHAT_DESKTOP__;if(d&&d.os)document.documentElement.dataset.chrome=d.os}catch(e){}' +
  "try{var t=localStorage.getItem('rchat_theme')||'dark';document.documentElement.dataset.theme=t;" +
  `var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content',t==='light'?'#fef7ff':'#141218')}catch(e){}`
const STORAGE = new Set(['localStorage', 'sessionStorage'])
const IN_CODE =
  /\b(?:local|session)Storage\s*(?:\??\.[\w$]|\[)|\breturn\s+(?:local|session)Storage\b/

const KINDS: Record<string, ts.ScriptKind> = {
  ts: ts.ScriptKind.TS,
  mts: ts.ScriptKind.TS,
  cts: ts.ScriptKind.TS,
  tsx: ts.ScriptKind.TSX,
  js: ts.ScriptKind.JS,
  mjs: ts.ScriptKind.JS,
  cjs: ts.ScriptKind.JS,
  jsx: ts.ScriptKind.JSX,
}

const parse = (file: string, src: string) =>
  ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    KINDS[file.slice(file.lastIndexOf('.') + 1)] ?? ts.ScriptKind.TSX
  )

const text = (n: ts.Node) => (ts.isStringLiteral(n) || ts.isTemplateLiteralToken(n) ? n.text : null)

const scriptContext = (node: ts.Node) => {
  const parent = node.parent
  if (!parent) return
  if (
    ts.isPropertyAssignment(parent) &&
    parent.initializer === node &&
    (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name)) &&
    parent.name.text === '__html'
  ) {
    const attr = ts.findAncestor(parent, ts.isJsxAttribute)
    const tag = attr?.parent.parent.tagName
    if (
      attr &&
      ts.isIdentifier(attr.name) &&
      attr.name.text === 'dangerouslySetInnerHTML' &&
      tag &&
      ts.isIdentifier(tag) &&
      tag.text === 'script'
    )
      return 'script'
  }
  if (
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    ts.isIdentifier(parent.expression)
  ) {
    if (parent.expression.text === 'Function' && parent.arguments?.at(-1) === node)
      return 'function'
    if (
      ts.isCallExpression(parent) &&
      parent.expression.text === 'eval' &&
      parent.arguments[0] === node
    )
      return 'eval'
  }
}

const scriptText = (node: ts.Node): string | undefined => {
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isParenthesizedExpression(node)) return scriptText(node.expression)
  if (ts.isTemplateExpression(node)) {
    // A placeholder keeps the JavaScript on either side of an interpolation together.
    return (
      node.head.text +
      node.templateSpans
        .map(span => (scriptText(span.expression) ?? 'value') + span.literal.text)
        .join('')
    )
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = scriptText(node.left)
    const right = scriptText(node.right)
    if (left !== undefined && right !== undefined) return left + right
  }
}

const scanStorage = (file: string, src: string) => {
  let count = 0
  let themeSeen = false
  const visit = (n: ts.Node) => {
    const context = scriptContext(n)
    if (context) {
      const body = scriptText(n)
      if (body !== undefined) {
        if (
          context === 'script' &&
          file === THEME_SCRIPT &&
          !themeSeen &&
          ts.isStringLiteralLike(n) &&
          body === THEME_HTML
        ) {
          themeSeen = true
          return
        }
        if (scanStorage('inline.js', body).count > 0) {
          count++
          return
        }
      }
    }
    const s = text(n)
    if (
      (ts.isIdentifier(n) && STORAGE.has(n.text)) ||
      (s !== null && (STORAGE.has(s) || IN_CODE.test(s)))
    )
      count++
    ts.forEachChild(n, visit)
  }
  visit(parse(file, src))
  return { count, themeSeen }
}

const bare = (sources: Sources): string[] =>
  Object.entries(sources).flatMap(([f, src]) => {
    if (HELPERS.includes(f)) return []
    const { count: n } = scanStorage(f, src)
    return n === 0 ? [] : [`${f}: ${n}`]
  })

test('only the storage helpers reach localStorage and sessionStorage', () => {
  const src = app()
  expect(Object.keys(src).filter(f => f.startsWith('components/')).length).toBeGreaterThan(50)
  expect(Object.keys(src).filter(f => f.startsWith('lib/')).length).toBeGreaterThan(200)
  expect(Object.keys(src)).toContain(THEME_SCRIPT)
  expect(bare(src)).toEqual([])
}, 60_000)

test('the theme script reads storage inside its own try', () => {
  expect(scanStorage(THEME_SCRIPT, read(THEME_SCRIPT))).toEqual({ count: 0, themeSeen: true })
})

test('a bare storage call is caught, a helper call and a comment are not', () => {
  expect(bare({ 'components/x.tsx': "const t = localStorage.getItem('rchat_theme')" })).toEqual([
    'components/x.tsx: 1',
  ])
  expect(bare({ 'lib/x.ts': 'const s = () => window.sessionStorage' })).toEqual(['lib/x.ts: 1'])
  expect(bare({ 'lib/x.ts': 'keepAsker(() => sessionStorage)' })).toEqual(['lib/x.ts: 1'])
  expect(bare({ 'components/x.tsx': "const t = readLocal('rchat_theme')" })).toEqual([])
  expect(bare({ 'lib/x.ts': 'sessionStore.setItem(KEY, "1")' })).toEqual([])
  expect(bare({ 'lib/x.ts': '// The web one keeps them in localStorage.\nconst a = 1' })).toEqual(
    []
  )
  expect(bare({ 'lib/x.ts': '/* kept in sessionStorage */ const a = 1' })).toEqual([])
  expect(bare({ 'lib/instances.ts': 'return window.localStorage' })).toEqual([])
})

test('a storage name in text is not a call, other ways of naming it are', () => {
  expect(bare({ 'lib/x.ts': "console.warn('localStorage write failed')" })).toEqual([])
  expect(bare({ 'lib/x.ts': "console.warn('Cannot read localStorage')" })).toEqual([])
  expect(bare({ 'lib/x.ts': "console.info('Preferences are saved in localStorage.')" })).toEqual([])
  expect(
    bare({
      'components/x.tsx':
        'const p = <p dangerouslySetInnerHTML={{ __html: "Kept in localStorage." }} />',
    })
  ).toEqual([])
  expect(
    bare({ 'components/x.tsx': 'export const A = () => <p>Kept in localStorage</p>' })
  ).toEqual([])
  expect(bare({ 'lib/x.ts': "const s = window['localStorage']" })).toEqual(['lib/x.ts: 1'])
  expect(bare({ 'lib/x.ts': 'const s = window[`sessionStorage`]' })).toEqual(['lib/x.ts: 1'])
  expect(bare({ 'lib/x.ts': 'const { sessionStorage: s } = window' })).toEqual(['lib/x.ts: 1'])
  expect(bare({ 'lib/x.ts': 'const s = window.local\\u0053torage' })).toEqual(['lib/x.ts: 1'])
})

test('a comment opener in a string does not hide code up to a later JSX comment', () => {
  const src = [
    "const glob = 'src/*'",
    "const t = localStorage.getItem('rchat_theme')",
    'export const A = () => <div>{/* note */}</div>',
  ].join('\n')
  expect(bare({ 'components/x.tsx': src })).toEqual(['components/x.tsx: 1'])
})

test('two slashes in a string do not hide the rest of the line', () => {
  const src = "const sep = ' // '; const t = sessionStorage.getItem('k')"
  expect(bare({ 'lib/x.ts': src })).toEqual(['lib/x.ts: 1'])
})

test('JavaScript files are scanned too', () => {
  expect(
    scanned([
      'lib/a.js',
      'components/b.jsx',
      'lib/c.mjs',
      'lib/d.cjs',
      'lib/e.ts',
      'components/f.tsx',
      'lib/__tests__/g.ts',
      'globals.css',
      'lib/h.json',
    ])
  ).toEqual([
    'components/b.jsx',
    'components/f.tsx',
    'lib/a.js',
    'lib/c.mjs',
    'lib/d.cjs',
    'lib/e.ts',
  ])
  expect(bare({ 'lib/x.js': "export const t = () => localStorage.getItem('k')" })).toEqual([
    'lib/x.js: 1',
  ])
  expect(
    bare({ 'components/x.jsx': 'export const A = () => <p>{sessionStorage.length}</p>' })
  ).toEqual(['components/x.jsx: 1'])
  expect(bare({ 'lib/x.mjs': '// localStorage\nexport const a = 1' })).toEqual([])
})

test('storage used as code inside a string or a template is caught', () => {
  const inline = `export const A = () => <script dangerouslySetInnerHTML={{ __html: "localStorage.setItem('a', '1')" }} />`
  expect(bare({ 'components/x.tsx': inline })).toEqual(['components/x.tsx: 1'])
  expect(bare({ 'lib/x.ts': "eval('window.localStorage.clear()')" })).toEqual(['lib/x.ts: 1'])
  expect(bare({ 'lib/x.ts': "const s = new Function('return localStorage')()" })).toEqual([
    'lib/x.ts: 1',
  ])
  expect(bare({ 'lib/x.ts': "const s = window[`localStorage${''}`]" })).toEqual(['lib/x.ts: 1'])
  expect(bare({ 'lib/x.js': "eval(`sessionStorage.setItem('k', '${v}')`)" })).toEqual([
    'lib/x.js: 1',
  ])
  expect(bare({ 'lib/x.ts': 'eval(`${a}localStorage[k]${b}`)' })).toEqual(['lib/x.ts: 1'])
  expect(bare({ 'lib/x.ts': "eval(`var k = '${k}'; sessionStorage.removeItem(k)`)" })).toEqual([
    'lib/x.ts: 1',
  ])
  expect(bare({ 'lib/x.ts': 'const t = `${n} localStorage keys left`' })).toEqual([])
})

test('only the theme script of layout.tsx holds storage code in a string', () => {
  const page = (...scripts: string[]) =>
    `export const L = () => <body>${scripts
      .map(s => `<script dangerouslySetInnerHTML={{ __html: ${JSON.stringify(s)} }} />`)
      .join('')}</body>`
  expect(bare({ [THEME_SCRIPT]: page(THEME_HTML) })).toEqual([])
  expect(
    bare({
      [THEME_SCRIPT]: page(
        THEME_HTML.replace('document.documentElement.dataset.theme=t', 'other(t)')
      ),
    })
  ).toEqual([`${THEME_SCRIPT}: 1`])
  expect(bare({ [THEME_SCRIPT]: page(THEME_HTML, 'sessionStorage.clear()') })).toEqual([
    `${THEME_SCRIPT}: 1`,
  ])
  for (const script of [
    "window['localStorage'].getItem('theme')",
    "window.localStorage?.getItem('theme')",
  ]) {
    expect(bare({ [THEME_SCRIPT]: page(THEME_HTML, script) })).toEqual([`${THEME_SCRIPT}: 1`])
  }
  expect(bare({ [THEME_SCRIPT]: page(THEME_HTML, THEME_HTML) })).toEqual([`${THEME_SCRIPT}: 1`])
  expect(bare({ [THEME_SCRIPT]: page(`${THEME_HTML}localStorage.clear()`) })).toEqual([
    `${THEME_SCRIPT}: 1`,
  ])
  expect(bare({ 'components/x.tsx': page(THEME_HTML) })).toEqual(['components/x.tsx: 1'])
})

for (const expression of [
  "new Function('return window.sessionStorage')()",
  "Function('key', \"return window['sessionStorage'].getItem(key)\")",
  'eval("const prefs = window[\'localStorage\']; prefs.clear()")',
  "eval('const prefs = window.' + 'localStorage; prefs.clear()')",
  "eval(`window['sessionStorage'].setItem('theme', '${theme}')`)",
  "eval(`localStorage.${method}('theme')`)",
  "eval(`notify('${sessionStorage.length}')`)",
]) {
  test(`checks the JavaScript body in ${expression}`, () => {
    expect(bare({ 'lib/settings.js': expression })).toEqual(['lib/settings.js: 1'])
  })
}
