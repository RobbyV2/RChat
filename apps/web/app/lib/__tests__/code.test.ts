import { describe, expect, test } from 'bun:test'
import { readStart } from '../api'
import {
  autoDetects,
  decodeText,
  fenceLang,
  fenceTag,
  fileLang,
  highlightSplit,
  lineCount,
  pickGuess,
} from '../code'
import { highlightCode } from '../highlight_data'
import type { CodeNode } from '../highlight'

const enc = (s: string) => new TextEncoder().encode(s)

const elements = (n: CodeNode): string[] => [
  ...(n.type === 'element' ? [n.tagName ?? ''] : []),
  ...(n.children ?? []).flatMap(elements),
]

const text = (n: CodeNode): string =>
  n.type === 'text' ? (n.value ?? '') : (n.children ?? []).map(text).join('')

const stream = (chunks: Uint8Array[]) => {
  let pulled = 0
  let canceled = false
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      const next = chunks[pulled]
      pulled += 1
      if (next) c.enqueue(next)
      else c.close()
    },
    cancel() {
      canceled = true
    },
  })
  return { body, pulled: () => pulled, canceled: () => canceled }
}

describe('languages', () => {
  test('fence tags and aliases', () => {
    expect(fenceLang('rs')).toBe('rust')
    expect(fenceLang('Python')).toBe('python')
    expect(fenceLang(' ts ')).toBe('typescript')
    expect(fenceLang('c++')).toBe('cpp')
    expect(fenceLang('yml')).toBe('yaml')
    expect(fenceLang('toml')).toBe('ini')
    expect(fenceLang('html')).toBe('xml')
    expect(fenceLang('brainfuck')).toBeNull()
    expect(fenceLang('constructor')).toBeNull()
    expect(fenceLang('__proto__')).toBeNull()
  })

  test('fence tag from the code class', () => {
    expect(fenceTag(['language-rs'])).toBe('rs')
    expect(fenceTag('language-py')).toBe('py')
    expect(fenceTag(['other', 'language-go'])).toBe('go')
    expect(fenceTag(undefined)).toBeNull()
    expect(fenceTag([])).toBeNull()
  })

  test('text file names', () => {
    expect(fileLang('main.rs')).toBe('rust')
    expect(fileLang('SCRIPT.PY')).toBe('python')
    expect(fileLang('data.json')).toBe('json')
    expect(fileLang('README.md')).toBe('markdown')
    expect(fileLang('page.html')).toBe('xml')
    expect(fileLang('Dockerfile')).toBe('dockerfile')
    expect(fileLang('dir/Makefile')).toBe('makefile')
    expect(fileLang('notes.txt')).toBe('plaintext')
    expect(fileLang('a.png')).toBeNull()
    expect(fileLang('logo.svg')).toBeNull()
    expect(fileLang('setup.exe')).toBeNull()
    expect(fileLang('noext')).toBeNull()
    expect(fileLang('x.toString')).toBeNull()
  })
})

describe('decodeText', () => {
  test('accepts UTF-8 text and drops a BOM', () => {
    expect(decodeText(enc('fn main() {}\n'), false)).toBe('fn main() {}\n')
    expect(decodeText(enc('﻿hé ✓'), false)).toBe('hé ✓')
    expect(decodeText(new Uint8Array(), false)).toBe('')
  })

  test('refuses NUL bytes in the first 64 KB', () => {
    expect(decodeText(new Uint8Array([0x61, 0, 0x62]), false)).toBeNull()
    const early = new Uint8Array(70 * 1024).fill(0x61)
    early[60 * 1024] = 0
    expect(decodeText(early, false) === null).toBe(true)
    const late = new Uint8Array(70 * 1024).fill(0x61)
    late[66 * 1024] = 0
    expect(decodeText(late, false)?.length).toBe(70 * 1024)
  })

  test('refuses invalid UTF-8', () => {
    expect(decodeText(new Uint8Array([0x61, 0xff, 0x62]), false)).toBeNull()
    expect(decodeText(new Uint8Array([0xc3]), false)).toBeNull()
    expect(decodeText(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), false)).toBeNull()
  })

  test('drops a character split by the cut', () => {
    const full = enc('ab✓')
    expect(decodeText(full.subarray(0, 4), true)).toBe('ab')
    expect(decodeText(full.subarray(0, 3), true)).toBe('ab')
    expect(decodeText(full, true)).toBe('ab✓')
    const emoji = enc('a\u{1F600}')
    expect(decodeText(emoji.subarray(0, 4), true)).toBe('a')
    expect(decodeText(emoji.subarray(0, 4), false)).toBeNull()
  })
})

describe('readStart', () => {
  test('stops after the limit and cancels the rest', async () => {
    const s = stream([enc('abcd'), enc('efgh'), enc('ijkl'), enc('mnop')])
    const got = await readStart(s.body, 6)
    expect(new TextDecoder().decode(got.bytes)).toBe('abcdef')
    expect(got.cut).toBe(true)
    expect(s.canceled()).toBe(true)
  })

  test('reads a file that fits, even exactly', async () => {
    const got = await readStart(stream([enc('abc'), enc('def')]).body, 6)
    expect(new TextDecoder().decode(got.bytes)).toBe('abcdef')
    expect(got.cut).toBe(false)
    const small = await readStart(stream([enc('hi')]).body, 6)
    expect(new TextDecoder().decode(small.bytes)).toBe('hi')
    expect(small.cut).toBe(false)
  })
})

describe('auto-detection rules', () => {
  test('only for fences over three lines', () => {
    expect(autoDetects('a\nb\nc')).toBe(false)
    expect(autoDetects('a\nb\nc\nd')).toBe(true)
    expect(autoDetects('x\n'.repeat(20 * 1024))).toBe(false)
  })

  test('needs a clear winner', () => {
    expect(
      pickGuess([
        ['rust', 15],
        ['css', 11],
      ])
    ).toBe('rust')
    expect(
      pickGuess([
        ['css', 9],
        ['lua', 8],
        ['python', 7],
      ])
    ).toBeNull()
    expect(pickGuess([['go', 6]])).toBeNull()
    expect(pickGuess([])).toBeNull()
  })

  test('split for highlighting ends on a line', () => {
    expect(highlightSplit('abc', 10)).toEqual(['abc', ''])
    expect(highlightSplit('ab\ncd\nef', 7)).toEqual(['ab\ncd\n', 'ef'])
    expect(highlightSplit('abcdefgh', 4)).toEqual(['abcd', 'efgh'])
  })

  test('line count', () => {
    expect(lineCount('')).toBe(1)
    expect(lineCount('a')).toBe(1)
    expect(lineCount('a\nb')).toBe(2)
    expect(lineCount('a\nb\n')).toBe(2)
  })
})

describe('highlightCode', () => {
  test('tags tokens of a named language', () => {
    const out = highlightCode('fn main() { let x = 1; }', 'rust')
    expect(out?.lang).toBe('rust')
    expect(elements(out!.nodes).every(t => t === 'span')).toBe(true)
    expect(elements(out!.nodes).length > 0).toBe(true)
    expect(text(out!.nodes)).toBe('fn main() { let x = 1; }')
  })

  test('keeps markup as text', () => {
    const src = '<script>alert(1)</script>\n<img src=x onerror=alert(1)>'
    const out = highlightCode(src, 'xml')
    expect(elements(out!.nodes).every(t => t === 'span')).toBe(true)
    expect(text(out!.nodes)).toBe(src)
  })

  test('guesses only clear cases', () => {
    const rust =
      'use std::fs;\n\nfn main() -> Result<(), Box<dyn std::error::Error>> {\n    let text = fs::read_to_string("a.txt")?;\n    for line in text.lines() {\n        println!("{line}");\n    }\n    Ok(())\n}\n'
    expect(highlightCode(rust, null)?.lang).toBe('rust')
    expect(
      highlightCode('hello there\nthis is just text\nwith lines\nnothing more\n', null)
    ).toBeNull()
    expect(highlightCode('fn main() {}\n', null)).toBeNull()
    expect(highlightCode('anything', 'plaintext')).toBeNull()
  })
})
