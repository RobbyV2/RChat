import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const APP = fileURLToPath(new URL('../../', import.meta.url))

type Sources = Record<string, string>

const read = (f: string) => readFileSync(`${APP}${f}`, 'utf8')

const app = (): Sources =>
  Object.fromEntries(
    readdirSync(APP, { recursive: true, encoding: 'utf8' })
      .filter(f => /\.tsx?$/.test(f) && !f.includes('__tests__'))
      .sort()
      .map(f => [f, read(f)])
  )

// Web Storage throws in some browsers (blocked or failing site data), so the app reaches it only
// through the guarded helpers in lib/instances.ts: readLocal, writeLocal and sessionStore. The
// theme script in layout.tsx runs before the app, inside its own try.
const HELPERS = ['lib/instances.ts']
const THEME_SCRIPT = 'layout.tsx'

const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')

const bare = (sources: Sources): string[] =>
  Object.entries(sources).flatMap(([f, src]) => {
    if (HELPERS.includes(f) || f === THEME_SCRIPT) return []
    const n = code(src).match(/\b(?:localStorage|sessionStorage)\b/g)?.length ?? 0
    return n === 0 ? [] : [`${f}: ${n}`]
  })

test('only the storage helpers reach localStorage and sessionStorage', () => {
  const src = app()
  expect(Object.keys(src).filter(f => f.startsWith('components/')).length).toBeGreaterThan(50)
  expect(Object.keys(src).filter(f => f.startsWith('lib/')).length).toBeGreaterThan(200)
  expect(bare(src)).toEqual([])
}, 60_000)

test('the theme script reads storage inside its own try', () => {
  const script = read(THEME_SCRIPT)
  expect(code(script).match(/\blocalStorage\b/g)).toHaveLength(1)
  expect(script).toContain("try{var t=localStorage.getItem('rchat_theme')||'dark'")
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
