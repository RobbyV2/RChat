// Writes src/styles/theme.css: the app's design tokens from apps/web/app/globals.css, over the
// Tailwind defaults it builds on, as plain custom properties. Dark is on :root and light under
// [data-theme='light'], the attribute both the app and Starlight switch.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type Tokens = Map<string, string>

export interface AppTheme {
  dark: Tokens
  light: Tokens
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The custom properties declared directly in the blocks opened by `prelude`, in order; a later
// block's value wins. Nested blocks such as keyframes are skipped.
export function declarations(css: string, prelude: string): Tokens {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const tokens: Tokens = new Map()
  for (const open of text.matchAll(new RegExp(`(?:^|[\\s}])${escaped(prelude)}\\s*\\{`, 'g'))) {
    let depth = 0
    let statement = ''
    for (let i = open.index + open[0].length - 1; i < text.length; i++) {
      const c = text[i]
      if (c === '{' || c === '}') {
        depth += c === '{' ? 1 : -1
        statement = ''
        if (depth === 0) break
      } else if (depth === 1) {
        if (c !== ';') statement += c
        else {
          const found = /^\s*(--[\w-]+)\s*:\s*([\s\S]*?)\s*$/.exec(statement)
          if (found) tokens.set(found[1], found[2].replace(/\s+/g, ' '))
          statement = ''
        }
      }
    }
  }
  return tokens
}

// The Tailwind defaults the app's classes use and globals.css doesn't set: the type scale, radii,
// the spacing unit and the monospace font. The spacing scale comes from globals.css's :root.
const FROM_DEFAULTS = /^--(?:text-(?!shadow-)[\w-]+|radius-[\w-]+|spacing|font-mono)$/

export function appTheme(globals: string, defaults: string): AppTheme {
  const dark: Tokens = new Map(
    [...declarations(defaults, '@theme default')].filter(([name]) => FROM_DEFAULTS.test(name))
  )
  for (const [name, value] of declarations(globals, '@theme'))
    if (!name.startsWith('--animate-')) dark.set(name, value)
  for (const [name, value] of declarations(globals, ':root'))
    if (name.startsWith('--space-')) dark.set(name, value)
  const light = declarations(globals, ":root[data-theme='light']")
  for (const [mode, tokens] of [
    ['dark', dark],
    ['light', light],
  ] as const)
    if (!tokens.has('--color-surface'))
      throw new Error(`globals.css has no ${mode} --color-surface where scripts/theme.ts reads it`)
  return { dark, light }
}

const block = (selectors: string[], tokens: Tokens) =>
  `${selectors.join(',\n')} {\n${[...tokens].map(([name, value]) => `  ${name}: ${value};`).join('\n')}\n}\n`

export const renderTheme = ({ dark, light }: AppTheme) =>
  [
    block([':root', '::backdrop'], dark),
    block([":root[data-theme='light']", "[data-theme='light'] ::backdrop"], light),
  ].join('\n')

const root = join(import.meta.dir, '..', '..')

export function writeTheme(out = join(import.meta.dir, '..', 'src/styles/theme.css')) {
  const web = join(root, 'apps/web')
  const globals = readFileSync(join(web, 'app/globals.css'), 'utf8')
  const defaults = readFileSync(Bun.resolveSync('tailwindcss/theme.css', web), 'utf8')
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, renderTheme(appTheme(globals, defaults)))
}

if (import.meta.main) writeTheme()
