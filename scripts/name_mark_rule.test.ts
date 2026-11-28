import { expect, test } from 'bun:test'
import { ESLint } from 'eslint'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')

const found = async (code: string, file = 'apps/web/app/components/x.tsx') => {
  const [result] = await new ESLint({ cwd: root }).lintText(code, { filePath: join(root, file) })
  return result.messages.filter(m => m.ruleId === 'rchat/name-mark').length
}

test('the streamer class cannot be written by hand', async () => {
  expect(await found('export const X = () => <span className="streamer truncate">a</span>\n')).toBe(
    1
  )
  expect(await found('export const X = () => <span className="streamer">a</span>\n')).toBe(1)
  expect(
    await found(
      "export const X = ({ on }: { on: boolean }) => <span className={`${on ? 'streamer ' : ''}truncate`}>a</span>\n"
    )
  ).toBe(1)
  expect(await found("export const mark = (on: boolean) => (on ? 'streamer' : '')\n")).toBe(1)
  expect(await found("export const look = 'flex streamer'\n", 'apps/web/app/lib/x.ts')).toBe(1)
  expect(await found("export const mark = 'streamer'\n", 'apps/web/app/lib/x.ts')).toBe(1)
  expect(await found("export const box = { className: 'streamer' }\n")).toBe(1)
  expect(await found("export const list = ['streamer', 'truncate'].join(' ')\n")).toBe(1)
}, 180_000)

test('the word as a key or in a sentence is not a class', async () => {
  const key =
    "type Key = 'theme' | 'streamer'\nexport const row: { key: Key } = { key: 'streamer' }\nexport const is = (k: Key) => k === 'streamer'\nexport const has = (s: Set<Key>) => s.has('streamer')\nexport const f = (k: Key) => {\n  switch (k) {\n    case 'streamer':\n      return 1\n    default:\n      return 0\n  }\n}\n"
  expect(await found(key, 'apps/web/app/lib/x.ts')).toBe(0)
  expect(
    await found(
      "export const label = (on: boolean) => (on ? 'Turn off streamer mode' : 'Turn on streamer mode')\n"
    )
  ).toBe(0)
  expect(await found('export const X = () => <p>Hidden in streamer mode.</p>\n')).toBe(0)
  expect(
    await found(
      'export const X = ({ streamer }: { streamer: boolean }) => <p>{streamer ? 1 : 2}</p>\n'
    )
  ).toBe(0)
}, 180_000)

test('the components that own the mark may write it', async () => {
  const code = 'export const X = () => <span className="streamer">a</span>\n'
  for (const file of ['name', 'covered', 'user_avatar', 'p2p/key_avatar'])
    expect(await found(code, `apps/web/app/components/${file}.tsx`)).toBe(0)
  expect(await found(code, 'apps/web/app/components/controls.tsx')).toBe(1)
  expect(await found(code, 'apps/web/app/widget/page.tsx')).toBe(1)
}, 180_000)
