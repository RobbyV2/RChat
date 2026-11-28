import { describe, expect, test } from 'bun:test'
import { ESLint, RuleTester } from 'eslint'
import { join } from 'node:path'
import rule from '../apps/web/eslint/buttons.mjs'

RuleTester.describe = describe
RuleTester.it = test

const tester = new RuleTester({
  languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
})

tester.run('buttons', rule, {
  valid: [
    { code: '<Button onClick={save}>Save</Button>' },
    { code: '<IconButton icon={X} label="Close" />' },
    { code: '<Row as="span" gap="sm" />' },
    { code: '<a href="/docs" className="underline">Docs</a>' },
    { code: 'createElement(as, props)' },
    { code: "document.createElement('button')" },
    { code: '<a href={url} className="truncate underline">{name}</a>' },
    { code: '<div className={tileLook("idle")} />' },
    { code: '<div role="menu" />' },
  ],
  invalid: [
    { code: '<button onClick={save}>Save</button>', errors: [{ messageId: 'raw' }] },
    {
      code: '<button type="button" className="rounded-full bg-primary" />',
      errors: [{ messageId: 'raw' }],
    },
    { code: '<Surface as="button" pad="sm" />', errors: [{ messageId: 'raw' }] },
    { code: "<Row as={'button'} gap='sm' />", errors: [{ messageId: 'raw' }] },
    { code: "createElement('button', { onClick: save })", errors: [{ messageId: 'raw' }] },
    { code: "React.createElement('button', null)", errors: [{ messageId: 'raw' }] },
    { code: '<span role="button" tabIndex={0} onClick={open} />', errors: [{ messageId: 'role' }] },
    { code: '<Surface role={\'button\'} pad="sm" />', errors: [{ messageId: 'role' }] },
    {
      code: "<a href={url} className={`inline-flex ${iconButtonLook('plain', 'sm')}`} />",
      errors: [{ messageId: 'anchor' }],
    },
    {
      code: "<Link href=\"/login\" className={buttonLook('danger', 'sm')}>Log out</Link>",
      errors: [{ messageId: 'anchor' }],
    },
    {
      code: '<Row as="a" href="/docs" className={cls(chipLook(true))} />',
      errors: [{ messageId: 'anchor' }],
    },
  ],
})

describe('where the rule holds', () => {
  const root = join(import.meta.dir, '..')
  const eslint = new ESLint({ cwd: root })
  const SOURCE = '<button type="button" />\n'
  const flagged = async (file: string) =>
    (await eslint.lintText(SOURCE, { filePath: join(root, file) }))[0].messages.some(
      m => m.ruleId === 'rchat/buttons'
    )

  test('every screen, with no file left out', async () => {
    for (const file of [
      'apps/web/app/components/home.tsx',
      'apps/web/app/components/p2p/p2p_home.tsx',
      'apps/web/app/components/layout/index.tsx',
      'apps/web/app/widget/page.tsx',
      'apps/web/app/components/a_new_screen.tsx',
    ])
      expect([file, await flagged(file)]).toEqual([file, true])
  })

  test('the controls themselves are where a button element is written', async () => {
    for (const file of ['apps/web/app/components/controls.tsx', 'apps/web/app/components/ui.tsx'])
      expect([file, await flagged(file)]).toEqual([file, false])
  })
})
