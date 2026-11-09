import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = fileURLToPath(new URL('../..', import.meta.url))

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sources(path)
    return e.name.endsWith('.tsx') ? [path] : []
  })

// A text field keeps its intrinsic width (`cols`, `size`) as its smallest flex size unless it
// sets one, which pushes the buttons next to it out of a narrow row in Firefox.
const unshrinkable = (source: string) =>
  [...source.matchAll(/<(textarea|input|select)\b/g)].flatMap(m => {
    const from = (m.index ?? 0) + m[0].length
    const ends = [source.indexOf('/>', from), source.indexOf(`</${m[1]}`, from)].filter(i => i > 0)
    const attrs = source.slice(from, Math.min(...ends))
    const classes = [...attrs.matchAll(/className=(\{`[^`]*`\}|"[^"]*"|\{[^}]*\})/g)].map(c =>
      c[1].split(/[\s`"{}$]+/)
    )
    const bad = classes.some(
      t => t.includes('flex-1') && !t.some(c => /^(min-w-|w-|basis-)/.test(c))
    )
    return bad ? [`${m[1]} at line ${source.slice(0, m.index).split('\n').length}`] : []
  })

describe('form fields in flex rows', () => {
  test('every field that grows with flex-1 also sets a min width', () => {
    const found = sources(APP).flatMap(file =>
      unshrinkable(readFileSync(file, 'utf8')).map(f => `${relative(APP, file)}: ${f}`)
    )
    expect(found).toEqual([])
  })

  test('the check catches a composer textarea without one', () => {
    expect(unshrinkable('<textarea rows={1} className="max-h-40 flex-1 resize-none" />')).toEqual([
      'textarea at line 1',
    ])
    expect(unshrinkable('<textarea rows={1} className="min-w-0 flex-1" />')).toEqual([])
  })
})
