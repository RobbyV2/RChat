import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  badgeLook,
  buttonLook,
  chipLook,
  coverLook,
  iconButtonLook,
  pillLook,
  placed,
  rowLook,
  tabLook,
  type ButtonSize,
  type ButtonVariant,
  type IconButtonSize,
  type IconButtonTone,
  type Look,
  type Place,
} from '../controls'

const VARIANTS: ButtonVariant[] = ['filled', 'tonal', 'text', 'danger', 'filled-danger']
const SIZES: ButtonSize[] = ['sm', 'md']
const TONES: IconButtonTone[] = [
  'plain',
  'inherit',
  'primary',
  'danger',
  'error',
  'filled',
  'filled-danger',
  'overlay',
]
const ICON_SIZES: IconButtonSize[] = ['xs', 'sm', 'md', 'lg']

const classes = (s: string) => s.split(/\s+/).filter(Boolean)

const has = (look: string, ...wanted: string[]) => {
  const c = classes(look)
  expect(wanted.filter(w => !c.includes(w))).toEqual([])
}

describe('button looks', () => {
  test('every button is at least 44 px on a coarse pointer and keeps its size with a mouse', () => {
    for (const v of VARIANTS)
      for (const s of SIZES) {
        const c = classes(buttonLook(v, s))
        expect(c).toContain('pointer-coarse:min-h-11')
        expect(c).toContain('pointer-coarse:min-w-11')
        expect(c.filter(x => /^(min-)?[hw]-|^size-/.test(x))).toEqual([])
      }
  })

  test('the two sizes are 32 and 36 px high', () => {
    has(buttonLook('text', 'sm'), 'px-3', 'py-1.5')
    has(buttonLook('text', 'md'), 'px-4', 'py-2')
  })

  test('every button shows focus and a disabled state', () => {
    for (const v of VARIANTS)
      has(buttonLook(v, 'md'), 'focus-visible:outline-2', 'disabled:opacity-40')
  })

  test('hover never lights up a disabled control or covers a chosen one', () => {
    const looks = [
      ...VARIANTS.flatMap(v => SIZES.map(s => buttonLook(v, s))),
      ...TONES.flatMap(t => ICON_SIZES.map(s => iconButtonLook(t, s))),
      rowLook('plain'),
      rowLook('muted'),
      rowLook('plain', 'card'),
      chipLook(false),
      tabLook,
      coverLook,
    ]
    for (const look of looks)
      expect(classes(look).filter(c => c.startsWith('hover:') || c.includes(':hover:'))).toEqual([])
    const css = readFileSync(fileURLToPath(new URL('../../globals.css', import.meta.url)), 'utf8')
    const idle = /@custom-variant hover-idle \{[^]*?\n\}/.exec(css)?.[0] ?? ''
    expect(css).toContain("@custom-variant expanded (&[aria-expanded='true'][aria-haspopup]);")
    for (const state of [
      ':disabled',
      "[aria-pressed='true']",
      "[aria-current='true']",
      "[aria-current='page']",
      "[aria-selected='true']",
    ])
      expect(idle).toContain(state)
  })

  test('each variant has its own colors', () => {
    const looks = new Set(VARIANTS.map(v => buttonLook(v, 'sm')))
    expect(looks.size).toBe(VARIANTS.length)
    has(buttonLook('filled-danger', 'md'), 'bg-error', 'text-on-error')
  })
})

describe('icon button looks', () => {
  test('every size is a fixed square that grows to 44 px on a coarse pointer', () => {
    const box = { xs: 'size-5', sm: 'size-7', md: 'size-8', lg: 'size-9' }
    for (const t of TONES)
      for (const s of ICON_SIZES) {
        const c = classes(iconButtonLook(t, s))
        expect(c).toContain(box[s])
        expect(c).toContain('pointer-coarse:size-11')
        expect(c).toContain('shrink-0')
      }
  })

  test('the one inside a chip grows into its margin on a coarse pointer, so the chip keeps its size', () => {
    has(iconButtonLook('plain', 'xs'), 'size-5', 'pointer-coarse:size-11', 'pointer-coarse:-m-3')
    expect(classes(iconButtonLook('plain', 'sm'))).not.toContain('pointer-coarse:-m-3')
  })

  test('pressed and open states follow the ARIA attributes', () => {
    has(
      iconButtonLook('plain', 'md'),
      'pressed:bg-secondary-container',
      'pressed:text-on-secondary-container',
      'expanded:bg-on-surface/8'
    )
  })

  test('the shape is round unless asked to be square', () => {
    expect(classes(iconButtonLook('plain', 'md'))).toContain('rounded-full')
    expect(classes(iconButtonLook('plain', 'md', 'square'))).toContain('rounded-lg')
  })
})

describe('rows, chips, badges', () => {
  test('a row marks the open one through aria-current and is 44 px on a coarse pointer', () => {
    has(
      rowLook('plain'),
      'current:bg-secondary-container',
      'selected:bg-secondary-container',
      'pointer-coarse:min-h-11',
      'text-on-surface'
    )
    expect(classes(rowLook('danger'))).toContain('text-error')
    expect(classes(rowLook('primary'))).toContain('text-primary')
  })

  test('a chip is 44 px on a coarse pointer and shows the chosen one filled', () => {
    expect(classes(chipLook(false))).toContain('pointer-coarse:min-h-11')
    expect(classes(chipLook(true))).toContain('bg-secondary-container')
    expect(classes(chipLook(false))).toContain('border-outline')
  })

  test('badges and pills take their size from the type scale', () => {
    has(badgeLook('danger'), 'text-2xs', 'bg-danger')
    has(pillLook('tertiary'), 'text-2xs', 'bg-tertiary-container')
  })

  test('no look uses an arbitrary text size', () => {
    const all = [
      ...VARIANTS.flatMap(v => SIZES.map(s => buttonLook(v, s))),
      ...TONES.flatMap(t => ICON_SIZES.map(s => iconButtonLook(t, s))),
      rowLook('plain'),
      chipLook(true),
      badgeLook('primary'),
      pillLook('neutral'),
    ]
    for (const look of all) expect(look.includes('text-[')).toBe(false)
  })
})

describe('placement', () => {
  test('the placement follows the look', () => {
    expect(placed('inline-flex', 'rounded-full', 'ml-auto shrink-0')).toBe(
      'inline-flex rounded-full ml-auto shrink-0'
    )
    expect(placed('inline-flex', 'rounded-full')).toBe('inline-flex rounded-full')
  })

  test("a placement that sets the display or the position replaces the control's own", () => {
    expect(placed('inline-flex relative', 'look', 'hidden md:inline-flex')).toBe(
      'relative look hidden md:inline-flex'
    )
    expect(placed('inline-flex relative', 'look', 'absolute top-2 right-2')).toBe(
      'inline-flex look absolute top-2 right-2'
    )
    expect(placed('flex', 'look', 'md:hidden')).toBe('flex look md:hidden')
  })

  test('a look takes any class but spacing, flow and arbitrary values', () => {
    const look = <S extends string>(s: Look<S>) => s
    look('text-sm font-medium text-on-surface-variant truncate')
    look('border-primary hover:bg-on-surface/8 w-72 data-[flash]:bg-primary')
    const on = Math.random() > 2
    look(on ? 'text-primary' : 'text-on-surface')
    // @ts-expect-error: padding comes from the box
    look('text-sm px-3')
    // @ts-expect-error: a margin comes from the parent's gap
    look('mt-1')
    // @ts-expect-error: also behind a variant
    look('md:gap-2')
    // @ts-expect-error: an arbitrary value is off the scales
    look('w-[13rem]')
    // @ts-expect-error: how the children line up is the box's own choice
    look('items-start')
    const computed: string = 'text-sm'
    // @ts-expect-error: a computed string cannot be checked
    look(computed)
  })

  test('only layout classes type check as a placement', () => {
    const place = <S extends string>(s: Place<S>) => s
    place('ml-auto shrink-0')
    place('absolute top-1.5 right-1.5 md:opacity-0 md:group-hover/cat:opacity-100')
    place('hidden md:inline-flex self-start')
    // @ts-expect-error: a color is a look
    place('ml-auto bg-primary')
    // @ts-expect-error: padding is a look
    place('px-3')
    // @ts-expect-error: a hover color is a look
    place('hover:text-error')
    // @ts-expect-error: a text size is a look
    place('text-xs')
    // @ts-expect-error: a fixed size is a look
    place('size-11')
    // @ts-expect-error: a ring is a look, though it starts like an edge
    place('inset-ring-2')
    // @ts-expect-error: an arbitrary variant can reach into the children
    place('[&_svg]:hidden')
    // @ts-expect-error: layers come from the layer tokens
    place('z-50')
    place('z-top md:group-hover/cat:opacity-100 pointer-coarse:-mr-2.5 top-1/2 -translate-y-1/2')
    const computed: string = 'ml-auto'
    // @ts-expect-error: a computed string is not checked, so it is refused
    place(computed)
    expect(place('w-full')).toBe('w-full')
  })
})
