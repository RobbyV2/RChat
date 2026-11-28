import { describe, expect, test } from 'bun:test'
import { ESLint, RuleTester } from 'eslint'
import { join } from 'node:path'
import rule from '../apps/web/eslint/overlays.mjs'

RuleTester.describe = describe
RuleTester.it = test
RuleTester.itOnly = test.only

const tester = new RuleTester({
  languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
})

tester.run('overlays', rule, {
  valid: [
    { code: '<Dialog title="Rename" onClose={close} />' },
    { code: '<div className="absolute inset-0 rounded-xl" />' },
    { code: '<div className="fixed top-2 right-2" />' },
    { code: 'const text = "The dialog is fixed in place"' },
  ],
  invalid: [
    { code: '<dialog open />', errors: [{ messageId: 'own' }] },
    { code: '<div className="fixed inset-0 z-top bg-scrim/60" />', errors: [{ messageId: 'own' }] },
    { code: '<Stack gap="sm" place="fixed inset-0" />', errors: [{ messageId: 'own' }] },
    {
      code: 'const cls = `fixed ${on ? "flex" : "hidden"} inset-0`',
      errors: [{ messageId: 'own' }],
    },
  ],
})

describe('where the rule holds', () => {
  const root = join(import.meta.dir, '..')
  const eslint = new ESLint({ cwd: root })
  const flagged = async (file: string) =>
    (await eslint.lintText('<dialog open />\n', { filePath: join(root, file) }))[0].messages.some(
      m => m.ruleId === 'rchat/overlays'
    )

  test('every screen and the controls, but the overlay primitives', async () => {
    for (const file of [
      'apps/web/app/components/p2p/p2p_home.tsx',
      'apps/web/app/components/controls.tsx',
      'apps/web/app/components/layout/index.tsx',
      'apps/web/app/components/a_new_screen.tsx',
    ])
      expect([file, await flagged(file)]).toEqual([file, true])
    expect(await flagged('apps/web/app/components/ui.tsx')).toBe(false)
  })
})
