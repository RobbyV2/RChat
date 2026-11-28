import { expect, test } from 'bun:test'
import { ESLint } from 'eslint'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const RULE = '@typescript-eslint/no-restricted-imports'

const found = async (file: string, code: string) => {
  const [result] = await new ESLint({ cwd: root }).lintText(code, {
    filePath: join(root, 'apps/web/app/lib/p2p/server', file),
  })
  return result.messages.filter(m => m.ruleId === RULE).length
}

const uses = (part: string) => `import { ${part} } from './rt'\nexport const x = ${part}\n`

test('each part of the runtime record is written only by the modules that own it', async () => {
  expect(await found('storage.ts', uses('storePart'))).toBe(0)
  expect(await found('receive.ts', uses('storePart'))).toBe(1)
  expect(await found('views.ts', uses('syncPart'))).toBe(1)
  expect(await found('receive.ts', uses('syncPart'))).toBe(0)
  expect(await found('index.ts', uses('viewPart'))).toBe(0)
  expect(await found('load.ts', uses('viewPart'))).toBe(1)
  expect(await found('moderation.ts', uses('xferPart'))).toBe(1)
  expect(await found('transfer.ts', uses('xferPart'))).toBe(0)
  expect(await found('emit.ts', uses('modPart'))).toBe(1)
  expect(await found('emit.ts', "import { type Rt } from './rt'\nexport type X = Rt\n")).toBe(0)
}, 180_000)
