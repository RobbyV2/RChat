// The looks of the layout primitives (`components/layout.tsx`): every gap and padding comes from
// one spacing scale, the `--space-*` tokens of globals.css, and every alignment from a fixed set
// of choices. A screen is built from these boxes and the controls; it sets no spacing of its own.

export const SPACES = ['none', '3xs', '2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl'] as const
export type Space = (typeof SPACES)[number]

const GAP: Record<Space, string> = {
  none: 'gap-0',
  '3xs': 'gap-(--space-3xs)',
  '2xs': 'gap-(--space-2xs)',
  xs: 'gap-(--space-xs)',
  sm: 'gap-(--space-sm)',
  md: 'gap-(--space-md)',
  lg: 'gap-(--space-lg)',
  xl: 'gap-(--space-xl)',
  '2xl': 'gap-(--space-2xl)',
  '3xl': 'gap-(--space-3xl)',
}

const PAD: Record<Space, string> = {
  none: 'p-0',
  '3xs': 'p-(--space-3xs)',
  '2xs': 'p-(--space-2xs)',
  xs: 'p-(--space-xs)',
  sm: 'p-(--space-sm)',
  md: 'p-(--space-md)',
  lg: 'p-(--space-lg)',
  xl: 'p-(--space-xl)',
  '2xl': 'p-(--space-2xl)',
  '3xl': 'p-(--space-3xl)',
}

const PAD_X: Record<Space, string> = {
  none: 'px-0',
  '3xs': 'px-(--space-3xs)',
  '2xs': 'px-(--space-2xs)',
  xs: 'px-(--space-xs)',
  sm: 'px-(--space-sm)',
  md: 'px-(--space-md)',
  lg: 'px-(--space-lg)',
  xl: 'px-(--space-xl)',
  '2xl': 'px-(--space-2xl)',
  '3xl': 'px-(--space-3xl)',
}

const PAD_Y: Record<Space, string> = {
  none: 'py-0',
  '3xs': 'py-(--space-3xs)',
  '2xs': 'py-(--space-2xs)',
  xs: 'py-(--space-xs)',
  sm: 'py-(--space-sm)',
  md: 'py-(--space-md)',
  lg: 'py-(--space-lg)',
  xl: 'py-(--space-xl)',
  '2xl': 'py-(--space-2xl)',
  '3xl': 'py-(--space-3xl)',
}

// The step below `s` on the scale (`none` stays `none`).
export const smaller = (s: Space): Space => SPACES[Math.max(0, SPACES.indexOf(s) - 1)]

export type StackAlign = 'stretch' | 'start' | 'center' | 'end'
export type RowAlign = 'center' | 'baseline' | 'start' | 'end' | 'stretch'
export type Justify = 'start' | 'center' | 'end' | 'between'

const ITEMS: Record<RowAlign, string> = {
  stretch: 'items-stretch',
  start: 'items-start',
  center: 'items-center',
  end: 'items-end',
  baseline: 'items-baseline',
}

const JUSTIFY: Record<Justify, string> = {
  start: 'justify-start',
  center: 'justify-center',
  end: 'justify-end',
  between: 'justify-between',
}

// The looks below leave the display (`flex`, `grid`) to the component, so a placement can hide a
// box (`hidden md:flex`).

// A column: children one under the other, `gap` apart; `divided` draws a line between them.
export const stackLook = (
  gap: Space,
  align: StackAlign = 'stretch',
  justify: Justify = 'start',
  divided = false
) =>
  `min-w-0 flex-col ${GAP[gap]} ${ITEMS[align]} ${JUSTIFY[justify]}${
    divided ? ' divide-y divide-outline-variant' : ''
  }`

// A line: children side by side, `gap` apart, on one center (or baseline) line; `wrap` lets a
// line that runs out of room continue under itself with the same gap.
export const rowLook = (
  gap: Space,
  align: RowAlign = 'center',
  justify: Justify = 'start',
  wrap = false
) => `min-w-0 ${wrap ? 'flex-wrap' : 'flex-nowrap'} ${GAP[gap]} ${ITEMS[align]} ${JUSTIFY[justify]}`

export type SurfaceTone =
  'plain' | 'lowest' | 'low' | 'base' | 'high' | 'highest' | 'primary' | 'secondary' | 'error'
export type SurfaceRadius = 'none' | 'md' | 'lg' | 'xl' | 'group' | 'hero'
// How a surface pads its content: `even` the same on all four sides; `bar` (a header, footer or
// toolbar line) one step less above and below than at the sides.
export type SurfaceInset = 'even' | 'bar'
// A line along every side, or only along the top or bottom (a header or footer of a panel).
export type SurfaceBorder = boolean | 'top' | 'bottom'

const BORDER: Record<'true' | 'false' | 'top' | 'bottom', string> = {
  true: 'border border-outline-variant',
  false: '',
  top: 'border-t border-outline-variant',
  bottom: 'border-b border-outline-variant',
}

const TONE: Record<SurfaceTone, string> = {
  plain: '',
  lowest: 'bg-surface-container-lowest text-on-surface',
  low: 'bg-surface-container-low text-on-surface',
  base: 'bg-surface-container text-on-surface',
  high: 'bg-surface-container-high text-on-surface',
  highest: 'bg-surface-container-highest text-on-surface',
  primary: 'bg-primary-container text-on-primary-container',
  secondary: 'bg-secondary-container text-on-secondary-container',
  error: 'bg-error-container text-on-error-container',
}

const RADIUS: Record<SurfaceRadius, string> = {
  none: 'rounded-none',
  md: 'rounded-lg',
  lg: 'rounded-xl',
  xl: 'rounded-2xl',
  group: 'rounded-group',
  hero: 'rounded-hero',
}

// A card: its own surface, padded by `pad` on every side (or as `inset` says), holding its
// children as a column `gap` apart. A `fit` surface is as wide as its content, so an image or code
// in it leaves no empty space beside it; otherwise it fills its place.
export const surfaceLook = ({
  pad,
  gap,
  tone,
  radius,
  border,
  inset,
  fit,
  align,
}: {
  pad: Space
  gap: Space
  tone: SurfaceTone
  radius: SurfaceRadius
  border: SurfaceBorder
  inset: SurfaceInset
  fit: boolean
  align: StackAlign
}) =>
  [
    'min-w-0 flex-col',
    inset === 'even' ? PAD[pad] : `${PAD_X[pad]} ${PAD_Y[smaller(pad)]}`,
    GAP[gap],
    ITEMS[align],
    TONE[tone],
    RADIUS[radius],
    BORDER[String(border) as keyof typeof BORDER],
    fit ? 'w-fit max-w-full' : '',
  ]
    .filter(Boolean)
    .join(' ')

export type Columns = 1 | 2 | 3 | 4 | 6
export type GridColumns = Columns | { base?: Columns; sm?: Columns; md?: Columns; lg?: Columns }

const COLS = {
  base: {
    1: 'grid-cols-1',
    2: 'grid-cols-2',
    3: 'grid-cols-3',
    4: 'grid-cols-4',
    6: 'grid-cols-6',
  },
  sm: {
    1: 'sm:grid-cols-1',
    2: 'sm:grid-cols-2',
    3: 'sm:grid-cols-3',
    4: 'sm:grid-cols-4',
    6: 'sm:grid-cols-6',
  },
  md: {
    1: 'md:grid-cols-1',
    2: 'md:grid-cols-2',
    3: 'md:grid-cols-3',
    4: 'md:grid-cols-4',
    6: 'md:grid-cols-6',
  },
  lg: {
    1: 'lg:grid-cols-1',
    2: 'lg:grid-cols-2',
    3: 'lg:grid-cols-3',
    4: 'lg:grid-cols-4',
    6: 'lg:grid-cols-6',
  },
} satisfies Record<string, Record<Columns, string>>

// Equal columns, `gap` apart both ways; `cols` may change at the sm, md and lg widths.
export const gridLook = (cols: GridColumns, gap: Space, align: RowAlign = 'stretch') => {
  const by = typeof cols === 'number' ? { base: cols } : cols
  const steps = (['base', 'sm', 'md', 'lg'] as const).flatMap(k => {
    const n = by[k]
    return n === undefined ? [] : [COLS[k][n]]
  })
  return `min-w-0 ${steps.join(' ')} ${GAP[gap]} ${ITEMS[align]}`
}
