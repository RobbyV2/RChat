import { expect, test } from 'bun:test'
import { ESLint } from 'eslint'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const RULE = '@typescript-eslint/no-restricted-imports'

const found = async (file: string, code: string) => {
  const [result] = await new ESLint({ cwd: root }).lintText(code, {
    filePath: join(root, file),
  })
  return result.messages.filter(m => m.ruleId === RULE).length
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
