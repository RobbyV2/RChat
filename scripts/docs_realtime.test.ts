import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (path: string) => readFileSync(join(import.meta.dir, '..', path), 'utf8')

// The variant names of `enum <name>` in a Rust source, in snake_case.
const variants = (source: string, name: string) => {
  const start = source.indexOf(`pub enum ${name} {`) + 1 || source.indexOf(`enum ${name} {`) + 1
  expect(start > 0).toBe(true)
  const body = source.slice(start, source.indexOf('\n}\n', start))
  return [...body.matchAll(/^ {4}([A-Z][A-Za-z0-9]*)\b/gm)].map(m =>
    m[1].replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
  )
}

const page = read('docs/src/content/docs/api/realtime.mdx')

// The names in column `column` of the table rows of the page's section `heading`.
const listed = (heading: string, column: number) => {
  const start = page.indexOf(`## ${heading}\n`)
  expect(start >= 0).toBe(true)
  const end = page.indexOf('\n## ', start + 1)
  const rows = page
    .slice(start, end < 0 ? undefined : end)
    .split('\n')
    .filter(l => l.startsWith('| '))
    .slice(1)
  const cells = rows.map(r => r.split('|')[column + 1] ?? '')
  return new Set(cells.flatMap(c => [...c.matchAll(/`([a-z][a-z0-9_]*)`/g)].map(m => m[1])))
}

// Events the server uses between its own parts and never sends to a client.
const INTERNAL = ['user_shown', 'tokens_revoked']

describe('realtime events page', () => {
  test('lists every event the server sends, and only those', () => {
    const events = variants(read('apps/server/src/ws/event.rs'), 'WsEvent')
    const table = listed('Events the server sends', 1)
    expect(INTERNAL.filter(e => events.includes(e))).toEqual(INTERNAL)
    expect(events.filter(e => !INTERNAL.includes(e) && !table.has(e))).toEqual([])
    expect([...table].filter(e => !events.includes(e))).toEqual([])
  })

  test('lists every frame a client sends, and only those', () => {
    const frames = variants(read('apps/server/src/ws/protocol.rs'), 'ClientMsg')
    const table = listed('Frames the client sends', 0)
    expect(frames).toContain('auth')
    expect(frames.filter(f => !table.has(f))).toEqual([])
    expect([...table].filter(f => !frames.includes(f))).toEqual([])
  })
})
