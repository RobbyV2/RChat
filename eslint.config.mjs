import eslint from '@eslint/js'
import { includeIgnoreFile } from 'eslint/config'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import tseslint from 'typescript-eslint'

const root = dirname(fileURLToPath(import.meta.url))

// The repository's git directory, also from a linked worktree (where `.git` is a file).
const gitDir = () => {
  const dot = join(root, '.git')
  if (!existsSync(dot)) return null
  if (statSync(dot).isDirectory()) return dot
  const own = /^gitdir: (.+)$/m.exec(readFileSync(dot, 'utf8'))?.[1]
  if (!own) return null
  const dir = resolve(root, own)
  const common = join(dir, 'commondir')
  return existsSync(common) ? resolve(dir, readFileSync(common, 'utf8').trim()) : dir
}

// Untracked files this checkout tells git to leave alone are not linted either.
const excluded = () => {
  const dir = gitDir()
  const file = dir && join(dir, 'info', 'exclude')
  return file && existsSync(file) ? [includeIgnoreFile(file, 'git info/exclude')] : []
}

export default tseslint.config(
  ...excluded(),
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      '**/.next/**',
      '**/node_modules/**',
      'target/**',
      'apps/web/public/wasm/**',
      'apps/web/app/lib/fed/gen/**',
      '**/out/**',
      '.remember/**',
      '.venv/**',
      '**/*.config.js',
      '**/*.config.mjs',
    ],
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  {
    files: ['apps/web/public/sw.js'],
    languageOptions: {
      globals: {
        self: 'readonly',
        caches: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
        Promise: 'readonly',
      },
    },
  },
  {
    files: ['scripts/pow/solve.mjs'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        fetch: 'readonly',
      },
    },
  },
  {
    files: ['apps/desktop/scripts/smoke.js'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        location: 'readonly',
        setTimeout: 'readonly',
        addEventListener: 'readonly',
        HTMLInputElement: 'readonly',
        Event: 'readonly',
        TextEncoder: 'readonly',
        sessionStorage: 'readonly',
        SMOKE_INSTANCE: 'readonly',
        SMOKE_HOLD: 'readonly',
      },
    },
  }
)
