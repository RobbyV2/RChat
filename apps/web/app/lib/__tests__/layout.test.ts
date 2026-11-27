import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SPACES, gridLook, rowLook, smaller, stackLook, surfaceLook, type Space } from '../layout'

const css = readFileSync(fileURLToPath(new URL('../../globals.css', import.meta.url)), 'utf8')
const rem = (s: Space) => Number(new RegExp(`--space-${s}: ([0-9.]+)rem;`).exec(css)?.[1])
const has = (look: string, ...want: string[]) => {
  for (const w of want) expect(look.split(' ')).toContain(w)
}

const surface = (o: Partial<Parameters<typeof surfaceLook>[0]> = {}) =>
  surfaceLook({
    pad: 'lg',
    gap: 'none',
    tone: 'high',
    radius: 'xl',
    border: false,
    inset: 'even',
    fit: false,
    align: 'stretch',
    ...o,
  })

const every = () =>
  SPACES.flatMap(s => [
    stackLook(s),
    rowLook(s, 'baseline', 'between', true),
    surface({ pad: s, gap: s }),
    surface({ pad: s, inset: 'bar' }),
    gridLook({ base: 1, md: 3 }, s),
  ])

test('the scale is the globals.css tokens, each step larger than the one before', () => {
  const steps = SPACES.filter(s => s !== 'none').map(rem)
  for (const v of steps) expect(Number.isFinite(v)).toBe(true)
  for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeGreaterThan(steps[i - 1])
})

test('every gap and padding the boxes set is a step of the scale', () => {
  for (const look of every())
    for (const word of look.split(' ')) {
      if (!/^-?(p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y)-/.test(word)) continue
      expect(/^(p|px|py|gap)-(0|\(--space-[a-z0-9]+\))$/.test(word)).toBe(true)
      const token = /--space-([a-z0-9]+)/.exec(word)?.[1]
      if (token) expect(SPACES.includes(token as Space)).toBe(true)
    }
})

test('a surface pads every side the same, and a bar one step less above and below', () => {
  has(surface(), 'p-(--space-lg)')
  expect(surface().includes('px-')).toBe(false)
  has(surface({ inset: 'bar' }), 'px-(--space-lg)', 'py-(--space-md)')
  expect(smaller('none')).toBe('none')
  expect(smaller('3xs')).toBe('none')
})

test('a fit surface is as wide as its content and no wider than its place', () => {
  has(surface({ fit: true }), 'w-fit', 'max-w-full')
  expect(surface().includes('w-fit')).toBe(false)
})

test('a row keeps its children on one center line unless told baseline, and wraps on request', () => {
  has(rowLook('sm'), 'items-center', 'flex-nowrap')
  has(rowLook('sm', 'baseline', 'start', true), 'items-baseline', 'flex-wrap')
})

test('the looks leave the display to the box, so a placement can hide it', () => {
  for (const look of every())
    for (const word of look.split(' '))
      expect(['flex', 'grid', 'block', 'hidden'].includes(word)).toBe(false)
})

test('grid columns change only at the named widths', () => {
  has(
    gridLook({ base: 1, sm: 2, lg: 4 }, 'md'),
    'grid-cols-1',
    'sm:grid-cols-2',
    'lg:grid-cols-4',
    'gap-(--space-md)'
  )
  has(gridLook(3, 'none'), 'grid-cols-3')
})

test('a divided stack lines its children apart, and a surface lines one edge or all', () => {
  has(stackLook('none', 'stretch', 'start', true), 'divide-y', 'divide-outline-variant')
  expect(stackLook('sm').includes('divide')).toBe(false)
  has(surface({ border: true }), 'border', 'border-outline-variant')
  has(surface({ border: 'bottom' }), 'border-b')
  expect(surface({ border: 'bottom' }).split(' ').includes('border')).toBe(false)
  expect(surface().includes('border')).toBe(false)
})
