import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const css = readFileSync(fileURLToPath(new URL('../../globals.css', import.meta.url)), 'utf8')

const block = (start: string) => {
  const from = css.indexOf(start)
  if (from < 0) throw new Error(`No ${start} block in globals.css`)
  return css.slice(from, css.indexOf('\n}', from))
}

const BLOCKS = { dark: block('@theme {'), light: block(":root[data-theme='light'] {") }

export const themeToken = (theme: 'dark' | 'light', name: string) => {
  const found = new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6});`).exec(BLOCKS[theme])
  if (!found) throw new Error(`No --color-${name} in the ${theme} theme`)
  return found[1]
}
