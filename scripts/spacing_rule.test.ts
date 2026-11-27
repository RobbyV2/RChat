import { describe, expect, test } from 'bun:test'
import { RuleTester } from 'eslint'
import rule, { handSpacing } from '../apps/web/eslint/spacing.mjs'

RuleTester.describe = describe
RuleTester.it = test
RuleTester.itOnly = test.only

const tester = new RuleTester({
  languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
})

test('hand-written padding, margins, gaps and arbitrary values are found, with any variant', () => {
  expect(
    handSpacing('flex px-4 md:gap-2 hover:-mt-1 w-[13rem] text-[11px] gap-(--space-sm)')
  ).toEqual(['px-4', 'md:gap-2', 'hover:-mt-1', 'w-[13rem]', 'text-[11px]', 'gap-(--space-sm)'])
  expect(
    handSpacing('flex items-center ml-auto mx-auto text-sm rounded-xl data-[flash]:bg-primary')
  ).toEqual([])
})

tester.run('spacing', rule, {
  valid: [
    { code: '<div className="flex min-w-0 items-center text-sm" />' },
    { code: '<p className={on ? "text-primary" : "text-on-surface"} />' },
    { code: '<Row gap="sm" place="ml-auto" />' },
  ],
  invalid: [
    { code: '<div className="flex gap-2" />', errors: [{ messageId: 'hand' }] },
    {
      code: '<p className={`mt-1 ${x ? "px-3" : ""}`} />',
      errors: [{ messageId: 'hand' }, { messageId: 'hand' }],
    },
    { code: '<span className={["py-0.5", cls].join(" ")} />', errors: [{ messageId: 'hand' }] },
  ],
})
