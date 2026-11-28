import { expect, test } from 'bun:test'
import { ESLint } from 'eslint'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const RULES = ['no-restricted-globals', 'no-restricted-properties']

const found = async (file: string, code: string) => {
  const [result] = await new ESLint({ cwd: root }).lintText(code, {
    filePath: join(root, file),
  })
  return result.messages.filter(m => RULES.includes(m.ruleId ?? '')).length
}

test('only the settings module reaches Web Storage', async () => {
  const forms = [
    "export const x = localStorage.getItem('rchat_theme')\n",
    'export const x = () => window.sessionStorage\n',
    "export const x = window['localStorage']\n",
    'export const { sessionStorage: x } = window\n',
    'export const x = globalThis.localStorage\n',
    'export const x = (keep: (s: () => Storage) => void) => keep(() => sessionStorage)\n',
  ]
  for (const code of forms) {
    expect([code, await found('apps/web/app/lib/x.ts', code)]).toEqual([code, 1])
    expect([code, await found('apps/web/app/components/x.tsx', code)]).toEqual([code, 1])
    expect([code, await found('apps/web/app/lib/api.ts', code)]).toEqual([code, 1])
    expect([code, await found('apps/web/app/lib/clock.ts', code)]).toEqual([code, 1])
    expect([code, await found('apps/web/app/lib/platform/web_records.ts', code)]).toEqual([code, 1])
    expect([code, await found('apps/web/app/lib/settings.ts', code)]).toEqual([code, 0])
  }
  const fine = [
    "import { readLocal } from './settings'\nexport const x = readLocal('rchat_theme')\n",
    "export const x = 'Kept in localStorage.'\n",
    '// The web one keeps them in localStorage.\nexport const x = 1\n',
  ]
  for (const code of fine)
    expect([code, await found('apps/web/app/lib/x.ts', code)]).toEqual([code, 0])
}, 120_000)

test('only the web adapters of the platform call the clipboard, sharing, notices and badges', async () => {
  const forms = [
    "export const x = () => navigator.clipboard.writeText('a')\n",
    "export const x = () => navigator.share({ text: 'a' })\n",
    "export const x = () => new Notification('a')\n",
    'export const x = () => Notification.permission\n',
    'export const x = () => window.Notification\n',
  ]
  for (const code of forms) {
    expect([code, await found('apps/web/app/components/x.tsx', code)]).toEqual([code, 1])
    expect([code, await found('apps/web/app/lib/x.ts', code)]).toEqual([code, 1])
    expect([code, await found('apps/web/app/lib/settings.ts', code)]).toEqual([code, 1])
    expect([code, await found('apps/web/app/lib/platform/web_sharing.ts', code)]).toEqual([code, 0])
    expect([code, await found('apps/web/app/lib/platform/web_notifications.ts', code)]).toEqual([
      code,
      0,
    ])
  }
  expect(await found('apps/web/app/lib/platform/web_sharing.ts', 'export const x = fetch\n')).toBe(
    1
  )
  expect(
    await found('apps/web/app/lib/platform/web_sharing.ts', 'export const x = localStorage\n')
  ).toBe(1)
}, 120_000)

test('only the schema module turns JSON text into a value', async () => {
  const forms = [
    'export const x = (t: string): unknown => JSON.parse(t)\n',
    "export const x = (t: string): unknown => JSON['parse'](t)\n",
  ]
  for (const code of forms) {
    expect([code, await found('apps/web/app/lib/x.ts', code)]).toEqual([code, 1])
    expect([code, await found('apps/web/app/components/x.tsx', code)]).toEqual([code, 1])
    expect([code, await found('apps/web/app/lib/p2p/x.ts', code)]).toEqual([code, 1])
    expect([code, await found('apps/web/app/lib/api.ts', code)]).toEqual([code, 1])
    expect([code, await found('apps/web/app/lib/settings.ts', code)]).toEqual([code, 1])
    expect([code, await found('apps/web/app/lib/schema.ts', code)]).toEqual([code, 0])
  }
  const fine =
    "import { anything, parseJson } from './schema'\nexport const x = (t: string) => parseJson(t, anything)\n"
  expect(await found('apps/web/app/lib/x.ts', fine)).toBe(0)
  expect(await found('apps/web/app/lib/x.ts', 'export const x = JSON.stringify({})\n')).toBe(0)
}, 120_000)
