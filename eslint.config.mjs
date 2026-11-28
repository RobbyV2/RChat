import eslint from '@eslint/js'
import { includeIgnoreFile } from 'eslint/config'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import tseslint from 'typescript-eslint'
import buttons from './apps/web/eslint/buttons.mjs'
import nameMark from './apps/web/eslint/name_mark.mjs'
import overlays from './apps/web/eslint/overlays.mjs'
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

// The layout boxes and the controls: they carry the spacing scale themselves.
const SPACING_SOURCES = [
  'apps/web/app/components/{controls,ui}.tsx',
  'apps/web/app/components/layout/index.tsx',
]

// The controls: the only files that write a button element.
const CONTROL_SOURCES = ['apps/web/app/components/{controls,ui}.tsx']

// The overlay primitives: the only file that pins a box over the window.
const OVERLAY_SOURCES = ['apps/web/app/components/ui.tsx']

// The components that put the streamer mark on what they draw.
const MARK_OWNERS = [
  'apps/web/app/components/{name,covered,user_avatar}.tsx',
  'apps/web/app/components/p2p/key_avatar.tsx',
]

const rchat = { rules: { spacing, buttons, overlays, 'name-mark': nameMark } }

const SINKS = ['TO_REQUEST', 'TO_STORE', 'TO_CRYPTO', 'TO_SCREEN']

// Only the motion folder reaches the engine; a screen names a slot (app/lib/motion/play.ts).
const ENGINE_IMPORTS = {
  group: ['**/motion/wire', '**/motion/engine', '**/motion/dom', '**/motion/start'],
  message:
    'Only app/lib/motion reaches the engine. A screen names a slot (app/lib/motion/play.ts).',
}
const MOTION_FILES = ['apps/web/app/lib/motion/**']

// Each secret sink may be imported only by the modules that are that sink.
const sinkRule = (allowed, engine = false) => ({
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          group: ['**/secret'],
          importNames: SINKS.filter(name => !allowed.includes(name)),
          message: 'Only the module that sends, stores or shows a secret may reveal it.',
        },
        ...(engine ? [] : [ENGINE_IMPORTS]),
      ],
    },
  ],
})

const REQUEST_SINKS = [
  'apps/web/app/lib/api.ts',
  'apps/web/app/lib/api/**',
  'apps/web/app/lib/ws.ts',
  'apps/web/app/lib/instances.ts',
  'apps/web/app/lib/widget_connection.ts',
]
const STORE_SINKS = ['apps/web/app/lib/client/credentials.ts']
const SCREEN_SINKS = ['apps/web/app/components/**', 'apps/web/app/**/page.tsx']
const TEST_FILES = ['apps/web/app/**/__tests__/**', 'apps/web/app/**/*.test.{ts,tsx}']

// The time and timers come from the clock (app/lib/clock.ts); only it and its device adapter read
// the globals.
const TIMERS = [
  'setTimeout',
  'setInterval',
  'requestAnimationFrame',
  'clearTimeout',
  'clearInterval',
  'cancelAnimationFrame',
]
const CLOCK_MESSAGE =
  'The time and timers come from the clock: session.time, useClock() or time() (app/lib/clock.ts).'
const networkGlobals = ['fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource'].map(name => ({
  name,
  message: 'Requests and sockets leave through the API client (app/lib/api).',
}))
const networkProperties = [
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
]
const clockGlobals = TIMERS.map(name => ({ name, message: CLOCK_MESSAGE }))
const clockProperties = [
  ...['window', 'globalThis', 'self'].flatMap(object =>
    TIMERS.map(property => ({ object, property, message: CLOCK_MESSAGE }))
  ),
  { object: 'Date', property: 'now', message: CLOCK_MESSAGE },
  { object: 'performance', property: 'now', message: CLOCK_MESSAGE },
  { object: 'AbortSignal', property: 'timeout', message: CLOCK_MESSAGE },
]
const DATE_SYNTAX = {
  selector: "NewExpression[callee.name='Date'][arguments.length=0]",
  message: CLOCK_MESSAGE,
}
const clockOnly = { 'no-restricted-syntax': ['error', DATE_SYNTAX] }
// An animation starts only in the motion engine: a screen names a slot (app/lib/motion/play.ts).
const SLOT_MESSAGE =
  'Animations play through a slot: plays, playsOn or look from app/lib/motion/play.ts. Keyframe classes that show a state are in app/lib/motion/functional.ts.'
const KEYFRAME_CLASS = '/(^|[\\s:])animate-/'
const motionSyntax = [
  { selector: "CallExpression[callee.property.name='animate']", message: SLOT_MESSAGE },
  { selector: "CallExpression[callee.property.name='getAnimations']", message: SLOT_MESSAGE },
  { selector: `Literal[value=${KEYFRAME_CLASS}]`, message: SLOT_MESSAGE },
  { selector: `TemplateElement[value.raw=${KEYFRAME_CLASS}]`, message: SLOT_MESSAGE },
  { selector: 'JSXAttribute[name.name=/^data-motion/]', message: SLOT_MESSAGE },
  { selector: 'Property[key.value=/^data-motion/]', message: SLOT_MESSAGE },
]
const clockSyntax = { 'no-restricted-syntax': ['error', DATE_SYNTAX, ...motionSyntax] }
// A component names a request and hands it on; it never holds the client that sends it.
const ASK_MESSAGE =
  'Components name a request with ask (app/lib/asks) and give it to a load (components/loaded.tsx) or to sendTo. They never hold the API client.'
const NETWORK_FILES = ['apps/web/app/lib/api.ts', 'apps/web/app/lib/api/**']
const CLOCK_FILES = ['apps/web/app/lib/clock.ts', 'apps/web/app/lib/platform/time.ts']

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
      'docs/dist/**',
      'docs/.astro/**',
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
    files: ['apps/web/app/**/*.tsx', 'docs/src/**/*.tsx'],
    ignores: [...SPACING_SOURCES, ...TEST_FILES],
    plugins: { rchat },
    rules: { 'rchat/spacing': 'error' },
  },
  {
    files: ['apps/web/app/**/*.{ts,tsx}'],
    ignores: [...CONTROL_SOURCES, ...TEST_FILES],
    plugins: { rchat },
    rules: { 'rchat/buttons': 'error' },
  },
  {
    files: ['apps/web/app/**/*.{ts,tsx}'],
    ignores: [...OVERLAY_SOURCES, ...TEST_FILES],
    plugins: { rchat },
    rules: { 'rchat/overlays': 'error' },
  },
  {
    files: ['apps/web/app/**/*.{ts,tsx}'],
    ignores: [...MARK_OWNERS, ...TEST_FILES],
    plugins: { rchat },
    rules: { 'rchat/name-mark': 'error' },
  },
  {
    files: ['apps/web/app/**/*.{ts,tsx}', 'docs/src/**/*.{ts,tsx}'],
    ignores: [...NETWORK_FILES, ...CLOCK_FILES, ...TEST_FILES],
    rules: {
      'no-restricted-globals': ['error', ...networkGlobals, ...clockGlobals],
      'no-restricted-properties': ['error', ...networkProperties, ...clockProperties],
      ...clockSyntax,
    },
  },
  {
    files: NETWORK_FILES,
    ignores: TEST_FILES,
    rules: {
      'no-restricted-globals': ['error', ...clockGlobals],
      'no-restricted-properties': ['error', ...clockProperties],
      ...clockSyntax,
    },
  },
  {
    files: CLOCK_FILES,
    rules: {
      'no-restricted-globals': ['error', ...networkGlobals],
      'no-restricted-properties': ['error', ...networkProperties],
    },
  },
  {
    files: ['apps/web/app/**/*.{ts,tsx}', 'docs/src/**/*.{ts,tsx}'],
    ignores: [...REQUEST_SINKS, ...STORE_SINKS, ...SCREEN_SINKS, ...TEST_FILES],
    rules: sinkRule([]),
  },
  {
    files: ['apps/web/app/**/*.{ts,tsx}', 'docs/src/**/*.{ts,tsx}'],
    ignores: ['apps/web/app/lib/log.ts', ...TEST_FILES],
    rules: { 'no-console': 'error' },
  },
  {
    files: ['apps/web/app/components/**'],
    ignores: TEST_FILES,
    rules: {
      'no-restricted-syntax': [
        ...clockSyntax['no-restricted-syntax'],
        { selector: "MemberExpression[computed=false][property.name='api']", message: ASK_MESSAGE },
        { selector: "ObjectPattern > Property[key.name='api']", message: ASK_MESSAGE },
      ],
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/lib/api', '**/lib/api/*'],
              allowTypeImports: true,
              message:
                'Components get data through loads (components/loaded.tsx) and store actions, and read a failure through app/lib/api_errors.',
            },
          ],
        },
      ],
    },
  },
  {
    files: MOTION_FILES,
    ignores: TEST_FILES,
    rules: { ...clockOnly, ...sinkRule([], true) },
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
