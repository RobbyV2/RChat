import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const src = join(import.meta.dir, '..', 'apps/server/src')
const read = new RegExp(
  [
    String.raw`\benv::(var|vars|var_os|vars_os)\b`,
    String.raw`\benv::\{[^}]*\b(var|vars|var_os|vars_os)\b`,
    String.raw`\benv::\*`,
    String.raw`\benv::\{\s*$`,
    String.raw`\bstd::env as\b`,
    String.raw`\bstd::\{[^}]*\benv\b`,
    String.raw`\benv_secret\b`,
    String.raw`\b(try_)?from_(default_)?env\w*`,
    String.raw`\bdotenvy::vars?\b`,
    String.raw`\bdotenvy::\{[^}]*\bvars?\b`,
    String.raw`\bEnvironment\b`,
    String.raw`\bfmt::(try_)?init\b`,
  ].join('|')
)
const testModule = /^(pub(\([a-z]+\))? )?mod \w+ \{$/
// The logger reads RUST_LOG before AppConfig::load, so config errors get logged.
const allowed = [
  'bin/server.rs: tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),',
]

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (name === 'tests' || name === 'tests.rs') return []
    if (statSync(path).isDirectory()) return files(path)
    return name.endsWith('.rs') ? [path] : []
  })

const reads = (code: string) => {
  const lines = code.split('\n')
  const found: { line: number; text: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '#[cfg(test)]' && testModule.test(lines[i + 1] ?? '')) {
      while (i < lines.length && !lines[i].startsWith('}')) i++
      continue
    }
    if (read.test(lines[i])) found.push({ line: i + 1, text: lines[i] })
  }
  return found
}

const scan = () =>
  files(src)
    .map(path => relative(src, path))
    .filter(path => path !== 'config.rs')
    .flatMap(path =>
      reads(readFileSync(join(src, path), 'utf8')).map(({ line, text }) => ({
        line,
        read: `${path}: ${text.trim()}`,
      }))
    )

describe('env reads', () => {
  test('only config.rs reads the environment', () => {
    const offenders = scan()
      .filter(({ read }) => !allowed.includes(read))
      .map(({ line, read }) => `${read} (line ${line})`)
    expect(offenders).toEqual([])
  })

  test('every allowed read is still there', () => {
    const found = scan().map(({ read }) => read)
    expect(allowed.filter(read => !found.includes(read))).toEqual([])
  })

  test('the scan sees reads before a test module and skips the module', () => {
    const code = [
      'fn a() { std::env::var("A"); }',
      '#[cfg(test)]',
      'mod tests;',
      'fn b() { crate::config::env_secret("B"); }',
      '#[cfg(test)]',
      'mod tests {',
      '    fn c() { std::env::var_os("C"); }',
      '}',
    ].join('\n')
    expect(reads(code).map(({ line }) => line)).toEqual([1, 4])
  })

  test('every way to read the environment counts', () => {
    const ways = [
      'let all = std::env::vars();',
      'let all = env::vars_os();',
      'use std::env::var;',
      'use std::env::{self, var};',
      'use std::env as e;',
      'let v = names.map(std::env::var);',
      'EnvFilter::try_from_default_env()',
      'EnvFilter::from_env("LOG")',
      'let v = dotenvy::var("X");',
      'config::Environment::default()',
      'use std::env::*;',
      'use std::{env as e, fs};',
      'use std::env::{',
      'use config::{Config, Environment};',
      'use dotenvy::{dotenv, var};',
      'tracing_subscriber::fmt::init();',
      'EnvFilter::builder().from_env_lossy()',
      'let key = name.and_then(env_secret);',
    ]
    for (const way of ways) expect(reads(way).length).toBe(1)
    expect(reads('let dir = std::env::temp_dir();')).toEqual([])
    expect(reads('let root = env!("CARGO_MANIFEST_DIR");')).toEqual([])
  })

  test('code after a test module is still scanned', () => {
    const code = [
      '#[cfg(test)]',
      'pub(crate) mod util {',
      '    fn a() { std::env::var("A"); }',
      '}',
      'fn b() { std::env::var("B"); }',
      '#[cfg(test)]',
      'mod tests {',
      '    fn c() { std::env::var("C"); }',
      '} // tests',
      'fn d() {',
      '    std::env::var("D");',
      '}',
    ].join('\n')
    expect(reads(code).map(({ line }) => line)).toEqual([5, 11])
  })
})
