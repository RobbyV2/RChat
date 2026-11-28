import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SPACES } from '../layout'
import { SCALE_PX, auditIssues, describeAudit, type AuditNode, lines } from '../layout_audit'

const css = readFileSync(fileURLToPath(new URL('../../globals.css', import.meta.url)), 'utf8')

const node = (o: Partial<AuditNode>): AuditNode => ({
  label: 'div',
  surface: false,
  padding: { top: 0, right: 0, bottom: 0, left: 0 },
  gap: null,
  centers: null,
  ...o,
})

test('the audit scale is the spacing tokens, in pixels', () => {
  const tokens = SPACES.filter(s => s !== 'none').map(
    s => Number(new RegExp(`--space-${s}: ([0-9.]+)rem;`).exec(css)?.[1]) * 16
  )
  expect([0, ...tokens]).toEqual([...SCALE_PX])
})

test('a surface padded more at one side than the other is uneven; a bar is not', () => {
  const card = node({ surface: true, padding: { top: 12, right: 16, bottom: 12, left: 8 } })
  expect(auditIssues([card]).map(i => i.kind)).toEqual(['uneven'])
  const bar = node({ surface: true, padding: { top: 12, right: 16, bottom: 12, left: 16 } })
  expect(auditIssues([bar])).toEqual([])
  const box = node({ padding: { top: 0, right: 16, bottom: 4, left: 3 } })
  expect(auditIssues([box])).toEqual([])
})

test('padding and gaps off the scale are found once per value', () => {
  const issues = auditIssues([
    node({ surface: true, padding: { top: 10, right: 10, bottom: 10, left: 10 } }),
    node({ gap: { row: 20, column: 20 } }),
    node({ gap: { row: 8, column: 12 } }),
  ])
  expect(issues.map(describeAudit)).toEqual([
    'div has padding 10px, off the spacing scale',
    'div has a gap of 20px, off the spacing scale',
  ])
})

test('a centered row whose children do not share one center line is misaligned', () => {
  expect(auditIssues([node({ centers: [20, 20.5, 19.8] })])).toEqual([])
  const [issue] = auditIssues([node({ label: 'header', centers: [20, 24] })])
  expect(describeAudit(issue)).toBe('header has children 4px off one center line')
})

test('a row that wraps is checked line by line', () => {
  const two = [
    { top: 0, bottom: 32 },
    { top: 4, bottom: 28 },
    { top: 40, bottom: 72 },
  ]
  expect(lines(two).map(line => line.length)).toEqual([2, 1])
  expect(auditIssues([node({ wrapped: two })])).toEqual([])
  const [issue] = auditIssues([
    node({
      label: 'chips',
      wrapped: [
        { top: 0, bottom: 32 },
        { top: 10, bottom: 30 },
        { top: 40, bottom: 72 },
      ],
    }),
  ])
  expect(issue).toEqual({ kind: 'misaligned', label: 'chips', spread: 4 })
})
