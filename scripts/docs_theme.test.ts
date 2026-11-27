import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appTheme, declarations, renderTheme } from '../docs/scripts/theme'

const read = (path: string) => readFileSync(join(import.meta.dir, '..', path), 'utf8')
const defaults = readFileSync(
  Bun.resolveSync('tailwindcss/theme.css', join(import.meta.dir, '..', 'apps/web')),
  'utf8'
)
const theme = appTheme(read('apps/web/app/globals.css'), defaults)

describe('declarations', () => {
  test('reads the custom properties of one block, across lines, without nested blocks', () => {
    const css = `/* a { --x: 1; } */
@theme {
  --font-sans:
    Roboto, sans-serif;
  --color-a: #fff;
  @keyframes spin {
    from {
      --inner: 1;
    }
  }
  --color-b: rgb(0 0 0 / 0.1);
}
:root[data-theme='light'] {
  --color-a: #000;
}`
    expect([...declarations(css, '@theme')]).toEqual([
      ['--font-sans', 'Roboto, sans-serif'],
      ['--color-a', '#fff'],
      ['--color-b', 'rgb(0 0 0 / 0.1)'],
    ])
    expect([...declarations(css, ":root[data-theme='light']")]).toEqual([['--color-a', '#000']])
    expect(declarations(css, '@theme default').size).toBe(0)
    expect([...declarations(':root { --a: 1; --b: 2; }\n:root { --a: 3; }', ':root')]).toEqual([
      ['--a', '3'],
      ['--b', '2'],
    ])
  })
})

describe('the app theme', () => {
  test('has the colors of both themes from globals.css and the Tailwind scales the app uses', () => {
    expect(theme.dark.get('--color-surface')).toBe('#141218')
    expect(theme.light.get('--color-surface')).toBe('#fef7ff')
    expect(theme.dark.get('--text-sm')).toBe('0.875rem')
    expect(theme.dark.get('--radius-lg')).toBe('0.5rem')
    expect(theme.dark.has('--space-md')).toBe(true)
    expect(theme.dark.has('--titlebar-h')).toBe(false)
    expect(theme.dark.has('--font-mono')).toBe(true)
    expect(theme.dark.get('--font-sans')).toStartWith('Roboto')
    expect([...theme.dark.keys()].some(name => name.startsWith('--animate-'))).toBe(false)
    expect([...theme.dark.keys()].some(name => name.startsWith('--text-shadow'))).toBe(false)
    for (const name of theme.light.keys()) expect(theme.dark.has(name)).toBe(true)
  })

  test('renders dark on :root and light under the theme attribute', () => {
    const css = renderTheme(theme)
    expect(css).toContain(':root,\n::backdrop {\n')
    expect(css).toContain(":root[data-theme='light'],\n[data-theme='light'] ::backdrop {\n")
    expect(css).toContain('  --color-surface: #fef7ff;\n')
  })

  test('the site styles take every value from the app tokens', () => {
    const custom = read('docs/src/styles/custom.css').replace(/\/\*[\s\S]*?\*\//g, '')
    const used = [...custom.matchAll(/var\((--[\w-]+)\)/g)].map(m => m[1])
    expect(used.length).toBeGreaterThan(0)
    for (const name of used) expect(theme.dark.has(name)).toBe(true)
    expect(custom).not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/i)
  })
})
