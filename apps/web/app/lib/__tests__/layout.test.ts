import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  SPACES,
  dockLook,
  firstLineLook,
  gridLook,
  liftLook,
  rowLook,
  smaller,
  stackLook,
  surfaceLook,
  typeLook,
  type Space,
} from '../layout'

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

test('a stack can turn into a centered row from a width on', () => {
  has(
    stackLook('sm', 'stretch', 'start', false, 'md'),
    'flex-col',
    'md:flex-row',
    'md:items-center'
  )
  expect(stackLook('sm').includes('flex-row')).toBe(false)
})

test('wrapped lines and grid rows may sit apart by their own step of the scale', () => {
  has(rowLook('sm', 'center', 'start', true, 'xs'), 'gap-(--space-sm)', 'gap-y-(--space-xs)')
  expect(rowLook('sm', 'center', 'start', true).includes('gap-y')).toBe(false)
  has(gridLook(2, 'md', 'stretch', '2xs'), 'gap-(--space-md)', 'gap-y-(--space-2xs)')
})

test('a row surface lays its children side by side; elevation and full round are named', () => {
  has(surface({ row: true }), 'flex-row')
  expect(surface().includes('flex-row')).toBe(false)
  has(surface({ elevation: 2, radius: 'full' }), 'shadow-elevation-2', 'rounded-full')
  expect(surface().includes('shadow')).toBe(false)
})

test('an icon beside text sits in a box one text line high', () => {
  has(firstLineLook, 'h-lh', 'items-center', 'shrink-0')
})

test('a surface can sit its children apart along its line, and draw a dashed edge', () => {
  has(surface({ row: true, justify: 'between' }), 'flex-row', 'justify-between')
  has(rowLook('sm', 'center', 'around'), 'justify-around')
  has(surface({ border: 'dashed' }), 'border', 'border-dashed', 'border-outline')
})

test('a docked bar sits inside the pane, above the home indicator or the keyboard', () => {
  has(dockLook(), 'mx-(--space-md)', 'keyboard:mb-(--space-md)', 'shrink-0')
  has(dockLook('sm'), 'flex-col', 'gap-(--space-sm)')
  expect(dockLook().includes('env(safe-area-inset-bottom)')).toBe(true)
})

test('a box gives its text a type step and a color from the tokens', () => {
  expect(typeLook('sm', 'muted')).toBe('text-sm text-on-surface-variant')
  expect(typeLook(undefined, 'error')).toBe('text-error')
  expect(typeLook()).toBe('')
})

test('a safe surface pads its lower edge by its own step or the home indicator, whichever is more', () => {
  has(surface({ pad: 'md', safe: true }), 'pb-[max(var(--space-md),env(safe-area-inset-bottom))]')
  has(
    surface({ pad: 'lg', inset: 'bar', safe: true }),
    'pb-[max(var(--space-md),env(safe-area-inset-bottom))]'
  )
  expect(surface().includes('safe-area')).toBe(false)
})

test('a surface inset at its sides only sets no padding above or below', () => {
  const look = surface({ pad: 'lg', inset: 'sides' }).split(' ')
  expect(look).toContain('px-(--space-lg)')
  expect(look).toContain('py-0')
  expect(look.some(w => /^(p|pt|pb)-/.test(w))).toBe(false)
})

test('a chip surface pads two steps less above and below than at its sides', () => {
  has(surface({ pad: 'md', inset: 'chip' }), 'px-(--space-md)', 'py-(--space-xs)')
  has(surface({ pad: '2xs', inset: 'chip' }), 'px-(--space-2xs)', 'py-0')
})

test('a grid can pair a label column with a value column', () => {
  has(
    gridLook('pair', 'md', 'stretch', '2xs'),
    'grid-cols-[auto_minmax(0,1fr)]',
    'gap-y-(--space-2xs)'
  )
  has(gridLook('thirds', 'md'), 'grid-cols-[minmax(0,1fr)_minmax(0,2fr)]')
})

test('a line surface keeps a hair above and below; a lifted box overlaps by a step of the scale', () => {
  has(surface({ pad: 'lg', inset: 'line' }), 'px-(--space-lg)', 'py-(--space-2xs)')
  has(liftLook('2xl'), 'relative', '-mt-(--space-2xl)')
})

test('a surface safe at its sides pads them by its own step or the screen inset', () => {
  has(
    surface({ pad: 'sm', safe: 'all' }),
    'pl-[max(var(--space-sm),env(safe-area-inset-left))]',
    'pr-[max(var(--space-sm),env(safe-area-inset-right))]',
    'pb-[max(var(--space-sm),env(safe-area-inset-bottom))]'
  )
  expect(surface({ pad: 'sm', safe: 'sides' }).includes('inset-bottom')).toBe(false)
})
