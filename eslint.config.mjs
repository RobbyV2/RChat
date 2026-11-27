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

// The layout boxes and the controls: they carry the spacing scale themselves.
const SPACING_SOURCES = ['apps/web/app/components/{layout,controls,ui}.tsx']

// Screens that set spacing classes of their own. On every other screen one fails the lint.
const HAND_SPACED = [
  'apps/web/app/\\[\\[...slug\\]\\]/app_shell.tsx',
  'apps/web/app/components/account_deletion.tsx',
  'apps/web/app/components/account_switcher.tsx',
  'apps/web/app/components/add_instance.tsx',
  'apps/web/app/components/admin/branding.tsx',
  'apps/web/app/components/admin/config.tsx',
  'apps/web/app/components/admin/features.tsx',
  'apps/web/app/components/admin/server_manage.tsx',
  'apps/web/app/components/alt_text.tsx',
  'apps/web/app/components/announcements.tsx',
  'apps/web/app/components/api_console.tsx',
  'apps/web/app/components/app_preview.tsx',
  'apps/web/app/components/audit_log.tsx',
  'apps/web/app/components/autocomplete.tsx',
  'apps/web/app/components/automations/automation_chip.tsx',
  'apps/web/app/components/automations/components_view.tsx',
  'apps/web/app/components/automations/only_you_row.tsx',
  'apps/web/app/components/avatar_picker.tsx',
  'apps/web/app/components/backup_phrase/phrase_input.tsx',
  'apps/web/app/components/backup_phrase/phrase_qr.tsx',
  'apps/web/app/components/backup_phrase/phrase_words.tsx',
  'apps/web/app/components/backup_phrase/reauth_prompt.tsx',
  'apps/web/app/components/backup_phrase/word_check.tsx',
  'apps/web/app/components/banners.tsx',
  'apps/web/app/components/blocking.tsx',
  'apps/web/app/components/call_buttons.tsx',
  'apps/web/app/components/channel_list.tsx',
  'apps/web/app/components/channel_sidebar.tsx',
  'apps/web/app/components/channel_topic.tsx',
  'apps/web/app/components/code_block.tsx',
  'apps/web/app/components/color_field.tsx',
  'apps/web/app/components/composer_field.tsx',
  'apps/web/app/components/config_sync.tsx',
  'apps/web/app/components/context_menu.tsx',
  'apps/web/app/components/date_divider.tsx',
  'apps/web/app/components/display_name.tsx',
  'apps/web/app/components/emoji_picker.tsx',
  'apps/web/app/components/external_link_dialog.tsx',
  'apps/web/app/components/file_card.tsx',
  'apps/web/app/components/folder_dialog.tsx',
  'apps/web/app/components/format_toolbar.tsx',
  'apps/web/app/components/forwards.tsx',
  'apps/web/app/components/friends.tsx',
  'apps/web/app/components/home.tsx',
  'apps/web/app/components/inbox.tsx',
  'apps/web/app/components/instance_badge.tsx',
  'apps/web/app/components/invite_card.tsx',
  'apps/web/app/components/markdown_message.tsx',
  'apps/web/app/components/media_lightbox.tsx',
  'apps/web/app/components/member_search.tsx',
  'apps/web/app/components/member_sidebar.tsx',
  'apps/web/app/components/member_table.tsx',
  'apps/web/app/components/message_composer.tsx',
  'apps/web/app/components/message_editor.tsx',
  'apps/web/app/components/message_link_card.tsx',
  'apps/web/app/components/message_list.tsx',
  'apps/web/app/components/message_pane.tsx',
  'apps/web/app/components/message_toolbar.tsx',
  'apps/web/app/components/notice_stack.tsx',
  'apps/web/app/components/p2p/p2p_badge.tsx',
  'apps/web/app/components/p2p/p2p_call.tsx',
  'apps/web/app/components/p2p/p2p_chat.tsx',
  'apps/web/app/components/p2p/p2p_dm_pane.tsx',
  'apps/web/app/components/p2p/p2p_files.tsx',
  'apps/web/app/components/p2p/p2p_home.tsx',
  'apps/web/app/components/p2p/p2p_server_flows.tsx',
  'apps/web/app/components/p2p/p2p_server_roles.tsx',
  'apps/web/app/components/p2p/p2p_server_settings.tsx',
  'apps/web/app/components/p2p/p2p_server_view.tsx',
  'apps/web/app/components/palette.tsx',
  'apps/web/app/components/palette_settings.tsx',
  'apps/web/app/components/perm_groups.tsx',
  'apps/web/app/components/ping_badge.tsx',
  'apps/web/app/components/pins.tsx',
  'apps/web/app/components/poll_card.tsx',
  'apps/web/app/components/poll_dialog.tsx',
  'apps/web/app/components/preview_reveal.tsx',
  'apps/web/app/components/profile_card.tsx',
  'apps/web/app/components/rail_voice_badge.tsx',
  'apps/web/app/components/reactions.tsx',
  'apps/web/app/components/relay_settings.tsx',
  'apps/web/app/components/replies.tsx',
  'apps/web/app/components/role_order_tools.tsx',
  'apps/web/app/components/rule_editor.tsx',
  'apps/web/app/components/search_panel.tsx',
  'apps/web/app/components/selection.tsx',
  'apps/web/app/components/server_about.tsx',
  'apps/web/app/components/server_access.tsx',
  'apps/web/app/components/server_dialogs.tsx',
  'apps/web/app/components/server_header.tsx',
  'apps/web/app/components/server_profile_dialog.tsx',
  'apps/web/app/components/server_rail.tsx',
  'apps/web/app/components/server_settings.tsx',
  'apps/web/app/components/settings_fields.tsx',
  'apps/web/app/components/settings_menu.tsx',
  'apps/web/app/components/settings_page.tsx',
  'apps/web/app/components/sign_in_step.tsx',
  'apps/web/app/components/skeletons.tsx',
  'apps/web/app/components/system_messages.tsx',
  'apps/web/app/components/text_composer.tsx',
  'apps/web/app/components/thread_panel.tsx',
  'apps/web/app/components/threads.tsx',
  'apps/web/app/components/timestamp.tsx',
  'apps/web/app/components/title_bar.tsx',
  'apps/web/app/components/typing_indicator.tsx',
  'apps/web/app/components/unread_banner.tsx',
  'apps/web/app/components/video_attachment.tsx',
  'apps/web/app/components/viewport_height.tsx',
  'apps/web/app/components/voice_grid.tsx',
  'apps/web/app/components/voice_row.tsx',
  'apps/web/app/components/webhooks.tsx',
  'apps/web/app/components/webhooks_dialog.tsx',
  'apps/web/app/components/word_grid.tsx',
  'apps/web/app/login/page.tsx',
  'apps/web/app/sso/page.tsx',
  'apps/web/app/widget/page.tsx',
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
  'apps/web/app/lib/widget_connection.ts',
]
const STORE_SINKS = ['apps/web/app/lib/client/credentials.ts']
const SCREEN_SINKS = ['apps/web/app/components/**', 'apps/web/app/**/page.tsx']
const TEST_FILES = ['apps/web/app/**/__tests__/**', 'apps/web/app/**/*.test.{ts,tsx}']

// The time and timers come from the clock (app/lib/clock.ts); only its device adapter reads the
// globals.
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
const clockSyntax = {
  'no-restricted-syntax': [
    'error',
    { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: CLOCK_MESSAGE },
  ],
}
const NETWORK_FILES = ['apps/web/app/lib/api.ts', 'apps/web/app/lib/api/**']
const CLOCK_FILES = ['apps/web/app/lib/platform/time.ts']

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
    files: ['apps/web/app/**/*.tsx'],
    ignores: [...SPACING_SOURCES, ...HAND_SPACED, ...TEST_FILES],
    plugins: { rchat: { rules: { spacing } } },
    rules: { 'rchat/spacing': 'error' },
  },
  {
    files: ['apps/web/app/**/*.{ts,tsx}'],
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
