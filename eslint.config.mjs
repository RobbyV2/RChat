import eslint from '@eslint/js'
import { includeIgnoreFile } from 'eslint/config'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import tseslint from 'typescript-eslint'
import spacing from './apps/web/eslint/spacing.mjs'

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

// Screens that take all their spacing from the layout boxes: hand-written spacing classes there
// fail the lint.
const LAID_OUT = [
  'apps/web/app/components/admin/{accounts,admin_host,admin_page,announcements,audit,danger,dialogs,encryption,overview,servers,source,staff_view,users}.tsx',
]

const SINKS = ['TO_REQUEST', 'TO_STORE', 'TO_CRYPTO', 'TO_SCREEN']

// Each secret sink may be imported only by the modules that are that sink.
const sinkRule = allowed => ({
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          group: ['**/secret'],
          importNames: SINKS.filter(name => !allowed.includes(name)),
          message: 'Only the module that sends, stores or shows a secret may reveal it.',
        },
      ],
    },
  ],
})

const REQUEST_SINKS = [
  'apps/web/app/lib/api.ts',
  'apps/web/app/lib/api/**',
  'apps/web/app/lib/ws.ts',
  'apps/web/app/lib/instances.ts',
]
const STORE_SINKS = ['apps/web/app/lib/client/credentials.ts']
const SCREEN_SINKS = ['apps/web/app/components/**', 'apps/web/app/**/page.tsx']
const TEST_FILES = ['apps/web/app/**/__tests__/**', 'apps/web/app/**/*.test.{ts,tsx}']

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
  ...(LAID_OUT.length
    ? [
        {
          files: LAID_OUT,
          plugins: { rchat: { rules: { spacing } } },
          rules: { 'rchat/spacing': 'error' },
        },
      ]
    : []),
  {
    files: ['apps/web/app/**/*.{ts,tsx}'],
    ignores: [
      'apps/web/app/lib/api.ts',
      'apps/web/app/lib/api/**',
      'apps/web/app/**/__tests__/**',
      'apps/web/app/**/*.test.{ts,tsx}',
    ],
    rules: {
      'no-restricted-globals': [
        'error',
        ...['fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource'].map(name => ({
          name,
          message: 'Requests and sockets leave through the API client (app/lib/api).',
        })),
      ],
      'no-restricted-properties': [
        'error',
        ...['window', 'globalThis', 'self'].flatMap(object =>
          ['fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource'].map(property => ({
            object,
            property,
            message: 'Requests and sockets leave through the API client (app/lib/api).',
          }))
        ),
        {
          object: 'navigator',
          property: 'sendBeacon',
          message: 'Requests leave through the API client (app/lib/api).',
        },
      ],
    },
  },
  {
    files: ['apps/web/app/**/*.{ts,tsx}'],
    ignores: [...REQUEST_SINKS, ...STORE_SINKS, ...SCREEN_SINKS, ...TEST_FILES],
    rules: sinkRule([]),
  },
  {
    files: ['apps/web/app/**/*.{ts,tsx}'],
    ignores: ['apps/web/app/lib/log.ts', ...TEST_FILES],
    rules: { 'no-console': 'error' },
  },
  { files: REQUEST_SINKS, rules: sinkRule(['TO_REQUEST']) },
  { files: STORE_SINKS, rules: sinkRule(['TO_STORE']) },
  { files: SCREEN_SINKS, ignores: TEST_FILES, rules: sinkRule(['TO_SCREEN']) },
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
        SMOKE_SERVER: 'readonly',
        fetch: 'readonly',
      },
    },
  }
)
