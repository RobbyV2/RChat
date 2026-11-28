import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const smoke = readFileSync(join(root, 'apps/desktop/scripts/smoke.js'), 'utf8')
const web = join(root, 'apps/web/app')
const app = readdirSync(web, { recursive: true, encoding: 'utf8' })
  .filter(file => /\.tsx?$/.test(file) && !file.includes('__tests__'))
  .map(file => readFileSync(join(web, file), 'utf8'))
  .join('\n')

describe('desktop smoke', () => {
  // The smoke run drives the real page in CI only, so every text and attribute it waits for must
  // still be in the app.
  test('every text the smoke run looks for is in the app', () => {
    const texts = [...smoke.matchAll(/\b(?:find|exact)\('[^']+', '([^']+)'\)/g)].map(m => m[1])
    expect(texts.length).toBeGreaterThan(3)
    for (const text of texts) expect(app.includes(text), text).toBe(true)
  })

  test('every attribute the smoke run selects is in the app', () => {
    const attrs = [...smoke.matchAll(/querySelector\('(?:[a-z]+)?\[([a-z-]+)(?:="([^"]+)")?\]'\)/g)]
    expect(attrs.length).toBeGreaterThan(2)
    // An icon control's `label` is its `aria-label`.
    const written = (name: string, value: string) =>
      app.includes(`${name}="${value}"`) ||
      (name === 'aria-label' && app.includes(` label="${value}"`))
    for (const [, name, value] of attrs) {
      const used =
        name === 'data-settings-section'
          ? new RegExp(`\\b${value}: '`).test(app)
          : value === undefined
            ? app.includes(name)
            : written(name, value)
      expect(used, `${name}=${value}`).toBe(true)
    }
  })
})
