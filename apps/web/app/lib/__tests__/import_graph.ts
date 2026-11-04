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

// The value imports of a file: relative ones resolved to files, and bare (package) specifiers.
const edges = (file: string): { files: string[]; packages: string[] } => {
  const text = readFileSync(file, 'utf8')
  const files: string[] = []
  const packages: string[] = []
  for (const re of [IMPORT, EXPORT])
    for (const m of text.matchAll(re)) {
      const [, typeKw, spec, path] = m
      if (typeKw || typeOnly(spec)) continue
      if (!path.startsWith('.')) packages.push(path)
      else {
        const p = resolve(file, path)
        if (p) files.push(p)
      }
    }
  return { files, packages }
}

const closure = (entry: string) => {
  const start = join(ROOT, entry)
  const seen = new Set<string>()
  const packages = new Set<string>(edges(start).packages)
  const todo = [start]
  while (todo.length) {
    const f = todo.pop()!
    for (const p of edges(f).files)
      if (!seen.has(p)) {
        seen.add(p)
        for (const x of edges(p).packages) packages.add(x)
        todo.push(p)
      }
  }
  seen.delete(start)
  return { files: seen, packages }
}

export const importsOf = (entry: string): Set<string> =>
  new Set([...closure(entry).files].map(p => relative(ROOT, p)))

// The packages (bare specifiers) the same walk imports.
export const packagesOf = (entry: string): Set<string> => closure(entry).packages
