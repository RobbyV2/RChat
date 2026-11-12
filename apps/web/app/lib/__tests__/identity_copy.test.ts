import { expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = join(fileURLToPath(new URL('..', import.meta.url)), 'identity')
const files = readdirSync(dir).filter(f => f.endsWith('.ts'))

// The string literals that read as sentences. Header names (X-RChat-...) are not copy.
const copy = (source: string) =>
  [...source.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)]
    .map(m => m[2])
    .filter(s => /[A-Za-z]{3,} [A-Za-z]/.test(s))

test('the nine modules are here and nothing in the app imports them', () => {
  expect(files.sort()).toEqual([
    'consent.ts',
    'errors.ts',
    'grants.ts',
    'link_template.ts',
    'protections.ts',
    'proxy_setup.ts',
    'second_factor.ts',
    'session_label.ts',
    'totp_display.ts',
  ])
})

test('no copy uses an em dash, an en dash or the name of the software', () => {
  let lines = 0
  for (const file of files) {
    const source = readFileSync(join(dir, file), 'utf8')
    expect(/[\u2013\u2014]/.test(source)).toBe(false)
    for (const text of copy(source)) {
      lines += 1
      expect(/(?<!X-)RChat/.test(text)).toBe(false)
    }
  }
  expect(lines).toBeGreaterThan(120)
})
