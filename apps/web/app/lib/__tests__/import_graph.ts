import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// A static import walker for layering tests: from a repo-relative entry, the repo-relative paths
// its relative `import ... from` and `export ... from` statements reach, transitively. Type-only
// imports and exports (erased at build time) and dynamic imports don't count.

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))

const IMPORT = /^[ \t]*import\s+(type\s+)?(?:([\w*\s{},$]*?)\s+from\s+)?['"]([^'"]+)['"]/gm
const EXPORT =
  /^[ \t]*export\s+(type\s+)?(\*(?:\s+as\s+[\w$]+)?|\{[\w\s,$]*\})\s+from\s+['"]([^'"]+)['"]/gm

const typeOnly = (spec: string | undefined) => {
  if (!spec) return false
  const m = /^\{([\s\S]*)\}$/.exec(spec.trim())
  if (!m) return false
  const names = m[1]
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  return names.length > 0 && names.every(n => /^type\s/.test(n))
}

const resolve = (from: string, spec: string): string | null => {
  const base = join(dirname(from), spec)
  for (const p of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ])
    if (existsSync(p) && statSync(p).isFile()) return p
  return null
}

const edges = (file: string): string[] => {
  const text = readFileSync(file, 'utf8')
  const out: string[] = []
  for (const re of [IMPORT, EXPORT])
    for (const m of text.matchAll(re)) {
      const [, typeKw, spec, path] = m
      if (typeKw || typeOnly(spec) || !path.startsWith('.')) continue
      const p = resolve(file, path)
      if (p) out.push(p)
    }
  return out
}

export const importsOf = (entry: string): Set<string> => {
  const start = join(ROOT, entry)
  const seen = new Set<string>()
  const todo = [start]
  while (todo.length) {
    const f = todo.pop()!
    for (const p of edges(f))
      if (!seen.has(p)) {
        seen.add(p)
        todo.push(p)
      }
  }
  seen.delete(start)
  return new Set([...seen].map(p => relative(ROOT, p)))
}
