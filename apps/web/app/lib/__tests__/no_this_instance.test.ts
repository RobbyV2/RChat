import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// UI text names the instance (`instanceLabel`) instead of saying "this instance". Comments
// don't count, nor the admin page's feature rows, which describe the admin's own instance.
const APP = fileURLToPath(new URL('../..', import.meta.url))
const SKIP = new Set(['lib/admin_rows.ts', 'lib/admin/rows.gen.ts'])

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })

const scanned = () =>
  sources(APP)
    .map(path => relative(APP, path))
    .filter(rel => !SKIP.has(rel))

const NBSP = /&nbsp;|&#160;|&#xa0;/gi

// The text a file can show, in source order, each piece with where its text starts: string and
// template literals and JSX text. Comments are not part of it.
const textsOf = (rel: string, source: string) => {
  const kind = rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const file = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, false, kind)
  const texts: { at: number; text: string }[] = []
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n))
      texts.push({ at: n.pos, text: n.text.replace(NBSP, s => ' '.repeat(s.length)) })
    else if (ts.isStringLiteralLike(n) || ts.isTemplateLiteralToken(n))
      texts.push({ at: n.getStart(file) + 1, text: n.text })
    ts.forEachChild(n, visit)
  }
  visit(file)
  return { file, texts }
}

// Every "this instance" in the file's text, also when the words sit in neighbouring strings or
// text nodes or across a line break, with the line of its first word.
const hitsIn = (rel: string, source: string) => {
  const { file, texts } = textsOf(rel, source)
  const starts: number[] = []
  let joined = ''
  for (const t of texts) {
    starts.push(joined.length)
    joined += `${t.text} `
  }
  return [...joined.matchAll(/\bthis\s+instance\b/gi)].map(m => {
    const at = m.index ?? 0
    let i = starts.length - 1
    while (starts[i] > at) i -= 1
    const { line } = file.getLineAndCharacterOfPosition(texts[i].at + at - starts[i])
    return `${rel}:${line + 1}: ${m[0].replace(/\s+/g, ' ')}`
  })
}

describe('no "this instance" in UI text', () => {
  test('comments are left out of the scan, text is not', () => {
    const source = [
      '// Links on this instance open in place.',
      '/* What this instance',
      '   budgets. */',
      "const a = 'https://x' // this instance",
      "const b = 'Off on this instance.'",
      'const c = <input accept="image/*" />',
      'const d = <p>Off on this instance.</p>',
      'const e = <p>{/* this instance */}</p>',
    ].join('\n')
    expect(hitsIn('x.tsx', source)).toEqual(['x.tsx:5: this instance', 'x.tsx:7: this instance'])
  })

  test('text wrapped onto the next line', () => {
    const source = [
      'const a = (',
      '  <p>',
      '    Outgoing webhooks are turned off on this',
      '    instance.',
      '  </p>',
      ')',
    ].join('\n')
    expect(hitsIn('x.tsx', source)).toEqual(['x.tsx:3: this instance'])
  })

  test("the words joined by {' '} or split across text nodes and strings", () => {
    const source = [
      "const a = <p>Off on this{' '}instance.</p>",
      'const b = <p>Off on this <b>instance</b>.</p>',
      "const c = 'Off on this ' +",
      "  'instance.'",
    ].join('\n')
    expect(hitsIn('x.tsx', source)).toEqual([
      'x.tsx:1: this instance',
      'x.tsx:2: this instance',
      'x.tsx:3: this instance',
    ])
  })

  test('the scan reads every source file of the app, pages included, but no tests', () => {
    const files = scanned()
    expect(files).toContain('login/page.tsx')
    expect(files).toContain('[[...slug]]/page.tsx')
    expect(files).toContain('[[...slug]]/app_shell.tsx')
    expect(files).toContain('layout.tsx')
    expect(files).toContain('components/settings_menu.tsx')
    expect(files).toContain('lib/instance_label.ts')
    expect(files).toContain('lib/features.ts')
    expect(files).not.toContain('lib/admin_rows.ts')
    expect(files).not.toContain('lib/admin/rows.gen.ts')
    expect(files.filter(f => f.includes('__tests__'))).toEqual([])
  })

  test('the app names the instance', () => {
    const hits = scanned().flatMap(rel => hitsIn(rel, readFileSync(join(APP, rel), 'utf8')))
    expect(hits).toEqual([])
  }, 120_000)
})
