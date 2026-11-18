import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../components/${file}`, import.meta.url)), 'utf8')

// The attribute text of every `<tag ...>` element in `code`.
const elements = (code: string, tag: string) =>
  [...code.matchAll(new RegExp(`<${tag}\\b`, 'g'))].map(m => {
    const from = (m.index ?? 0) + m[0].length
    const ends = [code.indexOf('/>', from), code.indexOf('>\n', from)].filter(i => i > 0)
    return code.slice(from, Math.min(...ends))
  })

test('a reply focus request reaches the guest editor as well as the account editor', () => {
  const composer = source('message_composer.tsx')
  const editors = elements(composer, 'TextComposer')
  expect(editors.length).toBeGreaterThan(0)
  for (const attrs of editors) expect(attrs).toContain('inputRef={inputRef}')
  for (const attrs of elements(composer, 'textarea')) expect(attrs).toContain('ref={inputRef}')
  const fields = elements(source('text_composer.tsx'), 'textarea')
  expect(fields).toHaveLength(1)
  expect(fields[0]).toContain('ref={inputRef}')
})
