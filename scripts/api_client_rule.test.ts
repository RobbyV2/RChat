import { expect, test } from 'bun:test'
import { ESLint } from 'eslint'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const RULE = '@typescript-eslint/no-restricted-imports'

const found = async (file: string, code: string, rule = RULE) => {
  const [result] = await new ESLint({ cwd: root }).lintText(code, {
    filePath: join(root, file),
  })
  return result.messages.filter(m => m.ruleId === rule).length
}

test('a component cannot import the API client, only its types', async () => {
  const value = "import { ApiError } from '../lib/api'\nexport const x = ApiError\n"
  const nested = "import { createApi } from '../../lib/api'\nexport const x = createApi\n"
  const type = "import type { ConfigShare } from '../lib/api'\nexport type X = ConfigShare\n"
  const errors = "import { missing } from '../lib/api_errors'\nexport const x = missing\n"
  expect(await found('apps/web/app/components/x.tsx', value)).toBe(1)
  expect(await found('apps/web/app/components/admin/x.tsx', nested)).toBe(1)
  expect(await found('apps/web/app/components/x.tsx', type)).toBe(0)
  expect(await found('apps/web/app/components/x.tsx', errors)).toBe(0)
  expect(
    await found(
      'apps/web/app/lib/x.ts',
      "import { ApiError } from './api'\nexport const x = ApiError\n"
    )
  ).toBe(0)
}, 60_000)

test('app code cannot reach the API client of a session, only name requests', async () => {
  const held = (code: string, file = 'apps/web/app/components/x.tsx') =>
    found(file, code, 'no-restricted-syntax')
  const call = 'export const x = (account: { api: { me(): unknown } }) => account.api.me()\n'
  const taken =
    'export const x = (account: { api: unknown }) => {\n  const { api } = account\n  return api\n}\n'
  const handed = 'export const x = (conn: { api: unknown }) => [conn.api]\n'
  const named =
    "import { ask, sendTo } from '../lib/asks'\nexport const x = (account: Parameters<typeof sendTo>[0]) => sendTo(account, ask.me())\n"
  expect(await held(call)).toBe(1)
  expect(await held(taken)).toBe(1)
  expect(await held(handed)).toBe(1)
  expect(await held(named)).toBe(0)
  expect(await held(call, 'apps/web/app/components/admin/x.tsx')).toBe(1)
  expect(await held(call, 'apps/web/app/lib/x.ts')).toBe(1)
  expect(await held(call, 'apps/web/app/lib/place/x.ts')).toBe(1)
  expect(await held(call, 'apps/web/app/lib/actions/x.ts')).toBe(1)
  expect(await held(call, 'apps/web/app/lib/motion/x.ts')).toBe(1)
  expect(await held(call, 'apps/web/app/lib/clock.ts')).toBe(1)
  expect(await held(call, 'apps/web/app/widget/page.tsx')).toBe(1)
  expect(await held(call, 'apps/web/app/login/page.tsx')).toBe(1)
  expect(await held(taken, 'apps/web/app/lib/x.ts')).toBe(1)
  for (const owner of ['api.ts', 'asks.ts', 'store.ts', 'slices/x.ts', 'x_store.ts', 'client/x.ts'])
    expect(await held(call, `apps/web/app/lib/${owner}`)).toBe(0)
  expect(await held('export const x = () => new Date()\n', 'apps/web/app/components/x.tsx')).toBe(1)
}, 60_000)
