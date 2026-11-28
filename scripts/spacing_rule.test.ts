import { describe, expect, test } from 'bun:test'
import { RuleTester } from 'eslint'
import rule, { classList, handSpacing } from '../apps/web/eslint/spacing.mjs'

RuleTester.describe = describe
RuleTester.it = test

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

test('a class list is told from other text', () => {
  expect(classList('flex items-center gap-2 rounded-lg px-2')).toBe(true)
  expect(classList('rounded-full p-1')).toBe(true)
  expect(classList('Pick a channel to start talking.')).toBe(false)
  expect(classList('m-1')).toBe(false)
})

tester.run('spacing', rule, {
  valid: [
    { code: '<div className="flex min-w-0 items-center text-sm" />' },
    { code: '<p className={on ? "text-primary" : "text-on-surface"} />' },
    { code: '<Row gap="sm" place="ml-auto" />' },
    { code: 'const title = "Open the channel list and pick one"' },
    { code: 'const look = "flex items-center rounded-lg text-sm"' },
    { code: '<Row gap="sm" look="text-sm font-medium hover:bg-primary" />' },
  ],
  invalid: [
    { code: '<div className="flex gap-2" />', errors: [{ messageId: 'hand' }] },
    {
      code: '<p className={`mt-1 ${x ? "px-3" : ""}`} />',
      errors: [{ messageId: 'hand' }, { messageId: 'hand' }],
    },
    { code: '<span className={["py-0.5", cls].join(" ")} />', errors: [{ messageId: 'hand' }] },
    { code: '<Row gap="sm" look="text-sm mt-2" />', errors: [{ messageId: 'hand' }] },
    { code: 'const box = "flex items-center gap-2 rounded-lg"', errors: [{ messageId: 'hand' }] },
    {
      code: 'const cls = `relative flex px-3 ${on ? "bg-primary" : ""}`',
      errors: [{ messageId: 'hand' }],
    },
    {
      code: '<PreviewRow contentClassName="flex min-w-0 items-center gap-1.5" />',
      errors: [{ messageId: 'hand' }],
    },
  ],
})
