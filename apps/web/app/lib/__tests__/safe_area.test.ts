import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = fileURLToPath(new URL('../..', import.meta.url))
const read = (path: string) => readFileSync(join(APP, path), 'utf8')

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sources(path)
    return /\.tsx?$/.test(e.name) ? [path] : []
  })

const utility = (css: string, name: string) =>
  css.match(new RegExp(`@utility ${name} \\{([^}]*)\\}`))?.[1] ?? ''

describe('the top safe-area inset', () => {
  test('the home screen app draws under the status bar', () => {
    expect(read('layout.tsx')).toContain("statusBarStyle: 'black-translucent'")
  })

  test('the app and its full-height layers start below the inset', () => {
    const css = read('globals.css')
    expect(css).toContain('--safe-top: calc(env(safe-area-inset-top, 0px) + var(--titlebar-h))')
    expect(/\nbody \{[^}]*padding-top: var\(--safe-top\)/.test(css)).toBe(true)
    expect(utility(css, 'top-app')).toContain('top: var(--safe-top)')
    expect(utility(css, 'h-app')).toContain('- var(--safe-top)')
    expect(utility(css, 'min-h-app')).toContain('- var(--safe-top)')
  })

  test('only the home screen app backs the white status bar text in the light theme', () => {
    const css = read('globals.css')
    const strip = css.indexOf(":root[data-theme='light'] body::before")
    expect(strip > 0).toBe(true)
    const media = css.lastIndexOf('@media (display-mode: standalone) {', strip)
    expect(media >= 0 && !css.slice(media, strip).includes('\n}')).toBe(true)
  })

  test('nothing adds the inset a second time', () => {
    const found = sources(APP)
      .filter(f => readFileSync(f, 'utf8').includes('safe-area-inset-top'))
      .map(f => relative(APP, f))
    expect(found).toEqual([])
  })
})
