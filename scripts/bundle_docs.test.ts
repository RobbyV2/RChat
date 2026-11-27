import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bundled, skipped } from './bundle_docs'

const read = (path: string) => readFileSync(join(import.meta.dir, '..', path), 'utf8')

describe('docs in the static app', () => {
  test('DOCS_BUILD=off leaves them out, anything else builds them', () => {
    expect(skipped({ DOCS_BUILD: 'off' })).toBe(true)
    expect(skipped({ DOCS_BUILD: ' OFF ' })).toBe(true)
    for (const v of [undefined, '', 'on', '0']) expect(skipped({ DOCS_BUILD: v })).toBe(false)
  })

  test('compressed copies stay out of the app', () => {
    expect(bundled('/x/docs/dist/index.html')).toBe(true)
    expect(bundled('/x/docs/dist/_astro/page.js')).toBe(true)
    expect(bundled('/x/docs/dist/index.html.gz')).toBe(false)
    expect(bundled('/x/docs/dist/index.html.br')).toBe(false)
  })

  test('the client build and the app builds bundle them', () => {
    expect(read('package.json')).toContain('bun run build:desktop && bun scripts/bundle_docs.ts')
    const recipes = read('jfiles/src/build.just')
    for (const recipe of ['build-static api_url', 'build-client'])
      expect(recipes.slice(recipes.indexOf(`${recipe}:`)).split('\n\n')[0]).toContain(
        'bun scripts/bundle_docs.ts'
      )
  })
})
