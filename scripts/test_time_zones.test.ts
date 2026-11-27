import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(import.meta.dir, '..', 'apps', 'web', 'app', 'lib', '__tests__')

const files = (at: string): string[] =>
  readdirSync(at, { withFileTypes: true }).flatMap(e =>
    e.isDirectory()
      ? files(join(at, e.name))
      : /\.test\.tsx?$/.test(e.name)
        ? [join(at, e.name)]
        : []
  )

// The web tests run in one process in a random order, and Bun follows `process.env.TZ` as it
// changes: a file that moves the zone puts back the zone it found, by name. Unsetting TZ would
// move every later file to the machine's own zone.
test('test files that change the time zone put back the zone they found, by name', () => {
  const wrong = files(dir).filter(f => {
    const src = readFileSync(f, 'utf8')
    if (!/process\.env\.TZ\s*=/.test(src)) return false
    return (
      /delete\s+process\.env\.TZ/.test(src) ||
      !src.includes('Intl.DateTimeFormat().resolvedOptions().timeZone')
    )
  })
  expect(wrong).toEqual([])
})
