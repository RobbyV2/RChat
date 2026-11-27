// Finishes the built site in dist: lists the hashes of its inline scripts in script-hashes.txt
// (the instance allows exactly these inline scripts on the pages it serves at /docs), and writes
// gzip and brotli copies of its text files, which the instance sends to browsers that take them.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
const RUNS = /^(module|text\/javascript|application\/javascript)$/i
const attr = (attrs: string, name: string) =>
  new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']?([^"'\\s>]*)`, 'i').exec(attrs)

// The text of every inline script in `html` that a browser runs.
export function inlineScripts(html: string): string[] {
  const found: string[] = []
  for (const [, attrs, body] of html.matchAll(SCRIPT)) {
    if (attr(attrs, 'src')) continue
    const type = attr(attrs, 'type')?.[1]
    if (type !== undefined && !RUNS.test(type)) continue
    found.push(body)
  }
  return found
}

export const scriptHash = (text: string) =>
  `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })

// Text the instance sends compressed. Smaller files go as they are.
export const COMPRESSED = /\.(html|js|mjs|css|json|svg|txt|xml)$/
const SMALLEST = 1024

export function finish(dist = join(import.meta.dir, '..', 'dist')) {
  const hashes = new Set<string>()
  for (const path of files(dist)) {
    if (path.endsWith('.html'))
      for (const script of inlineScripts(readFileSync(path, 'utf8'))) hashes.add(scriptHash(script))
  }
  const sorted = [...hashes].sort()
  writeFileSync(join(dist, 'script-hashes.txt'), sorted.map(h => `${h}\n`).join(''))
  for (const path of files(dist)) {
    if (!COMPRESSED.test(path)) continue
    const data = readFileSync(path)
    if (data.length < SMALLEST) continue
    writeFileSync(`${path}.gz`, gzipSync(data, { level: 9 }))
    writeFileSync(
      `${path}.br`,
      brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } })
    )
  }
  return sorted
}

if (import.meta.main) finish()
