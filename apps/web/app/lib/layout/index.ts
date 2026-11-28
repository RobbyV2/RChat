// The looks of the layout primitives (`components/layout`): every gap and padding comes from
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

const ROW_GAP: Record<Space, string> = {
  none: 'gap-y-0',
  '3xs': 'gap-y-(--space-3xs)',
  '2xs': 'gap-y-(--space-2xs)',
  xs: 'gap-y-(--space-xs)',
  sm: 'gap-y-(--space-sm)',
  md: 'gap-y-(--space-md)',
  lg: 'gap-y-(--space-lg)',
  xl: 'gap-y-(--space-xl)',
  '2xl': 'gap-y-(--space-2xl)',
  '3xl': 'gap-y-(--space-3xl)',
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

// The bottom padding of a surface at the lower edge of the screen: its own, or the home
// indicator's inset when that is larger.
const PAD_SAFE_BOTTOM: Record<Space, string> = {
  none: 'pb-[env(safe-area-inset-bottom)]',
  '3xs': 'pb-[max(var(--space-3xs),env(safe-area-inset-bottom))]',
  '2xs': 'pb-[max(var(--space-2xs),env(safe-area-inset-bottom))]',
  xs: 'pb-[max(var(--space-xs),env(safe-area-inset-bottom))]',
  sm: 'pb-[max(var(--space-sm),env(safe-area-inset-bottom))]',
  md: 'pb-[max(var(--space-md),env(safe-area-inset-bottom))]',
  lg: 'pb-[max(var(--space-lg),env(safe-area-inset-bottom))]',
  xl: 'pb-[max(var(--space-xl),env(safe-area-inset-bottom))]',
  '2xl': 'pb-[max(var(--space-2xl),env(safe-area-inset-bottom))]',
  '3xl': 'pb-[max(var(--space-3xl),env(safe-area-inset-bottom))]',
}

// The same at the left and right edges (a notch, a rounded corner).
const PAD_SAFE_LEFT: Record<Space, string> = {
  none: 'pl-[env(safe-area-inset-left)]',
  '3xs': 'pl-[max(var(--space-3xs),env(safe-area-inset-left))]',
  '2xs': 'pl-[max(var(--space-2xs),env(safe-area-inset-left))]',
  xs: 'pl-[max(var(--space-xs),env(safe-area-inset-left))]',
  sm: 'pl-[max(var(--space-sm),env(safe-area-inset-left))]',
  md: 'pl-[max(var(--space-md),env(safe-area-inset-left))]',
  lg: 'pl-[max(var(--space-lg),env(safe-area-inset-left))]',
  xl: 'pl-[max(var(--space-xl),env(safe-area-inset-left))]',
  '2xl': 'pl-[max(var(--space-2xl),env(safe-area-inset-left))]',
  '3xl': 'pl-[max(var(--space-3xl),env(safe-area-inset-left))]',
}

const PAD_SAFE_RIGHT: Record<Space, string> = {
  none: 'pr-[env(safe-area-inset-right)]',
  '3xs': 'pr-[max(var(--space-3xs),env(safe-area-inset-right))]',
  '2xs': 'pr-[max(var(--space-2xs),env(safe-area-inset-right))]',
  xs: 'pr-[max(var(--space-xs),env(safe-area-inset-right))]',
  sm: 'pr-[max(var(--space-sm),env(safe-area-inset-right))]',
  md: 'pr-[max(var(--space-md),env(safe-area-inset-right))]',
  lg: 'pr-[max(var(--space-lg),env(safe-area-inset-right))]',
  xl: 'pr-[max(var(--space-xl),env(safe-area-inset-right))]',
  '2xl': 'pr-[max(var(--space-2xl),env(safe-area-inset-right))]',
  '3xl': 'pr-[max(var(--space-3xl),env(safe-area-inset-right))]',
}

// Which edges of a surface keep clear of the screen's own insets: the lower edge (`true` or
// `bottom`), the sides, or all three.
export type SurfaceSafe = boolean | 'bottom' | 'sides' | 'all'

// The step below `s` on the scale (`none` stays `none`).
export const smaller = (s: Space): Space => SPACES[Math.max(0, SPACES.indexOf(s) - 1)]

export type StackAlign = 'stretch' | 'start' | 'center' | 'end'
export type RowAlign = 'center' | 'baseline' | 'start' | 'end' | 'stretch'
export type Justify = 'start' | 'center' | 'end' | 'between' | 'around'
export type Breakpoint = 'sm' | 'md' | 'lg'

// A column that turns into a centered row from a width on.
const ROW_FROM: Record<Breakpoint, string> = {
  sm: 'sm:flex-row sm:items-center',
  md: 'md:flex-row md:items-center',
  lg: 'lg:flex-row lg:items-center',
}

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
  around: 'justify-around',
}

// How a surface pads its content: `even` the same on all four sides; `bar` (a header, footer or
// toolbar line) one step less above and below than at the sides; `chip` (a pill, a tag, a chip)
// two steps less; `line` (a line of a list or a chat) a hair above and below; `sides` only at
// the sides.
export type SurfaceInset = 'even' | 'bar' | 'sides' | 'chip' | 'line'

// The padding above and below a surface whose sides are padded by `pad`.
const above = (pad: Space, inset: SurfaceInset): Space =>
  inset === 'even'
    ? pad
    : inset === 'bar'
      ? smaller(pad)
      : inset === 'chip'
        ? smaller(smaller(pad))
        : inset === 'line'
          ? '2xs'
          : 'none'

// The type step and the color a box gives the text in it (its children inherit both).
export type BoxText = '3xs' | '2xs' | 'xs' | 'sm' | 'base' | 'lg'
export type BoxInk = 'strong' | 'muted' | 'primary' | 'tertiary' | 'error'

const TEXT: Record<BoxText, string> = {
  '3xs': 'text-3xs',
  '2xs': 'text-2xs',
  xs: 'text-xs',
  sm: 'text-sm',
  base: 'text-base',
  lg: 'text-lg',
}

const INK: Record<BoxInk, string> = {
  strong: 'text-on-surface',
  muted: 'text-on-surface-variant',
  primary: 'text-primary',
  tertiary: 'text-tertiary',
  error: 'text-error',
}

export const typeLook = (text?: BoxText, ink?: BoxInk) =>
  [text ? TEXT[text] : '', ink ? INK[ink] : ''].filter(Boolean).join(' ')

// The looks below leave the display (`flex`, `grid`) to the component, so a placement can hide a
// box (`hidden md:flex`).

// A column: children one under the other, `gap` apart; `divided` draws a line between them;
// `rowFrom` lays them side by side, centered, from that width on.
export const stackLook = (
  gap: Space,
  align: StackAlign = 'stretch',
  justify: Justify = 'start',
  divided = false,
  rowFrom?: Breakpoint
) =>
  `min-w-0 flex-col ${GAP[gap]} ${ITEMS[align]} ${JUSTIFY[justify]}${
    divided ? ' divide-y divide-outline-variant' : ''
  }${rowFrom ? ` ${ROW_FROM[rowFrom]}` : ''}`

// A line: children side by side, `gap` apart, on one center (or baseline) line; `wrap` lets a
// line that runs out of room continue under itself, `lineGap` apart (`gap` unless given).
export const rowLook = (
  gap: Space,
  align: RowAlign = 'center',
  justify: Justify = 'start',
  wrap = false,
  lineGap?: Space
) =>
  `min-w-0 ${wrap ? 'flex-wrap' : 'flex-nowrap'} ${GAP[gap]}${
    lineGap ? ` ${ROW_GAP[lineGap]}` : ''
  } ${ITEMS[align]} ${JUSTIFY[justify]}`

export type SurfaceTone =
  'plain' | 'lowest' | 'low' | 'base' | 'high' | 'highest' | 'primary' | 'secondary' | 'error'
export type SurfaceRadius = 'none' | 'md' | 'lg' | 'xl' | 'group' | 'hero' | 'full'
export type Elevation = 0 | 1 | 2 | 3
// A line along every side, or only along the top or bottom (a header or footer of a panel), or a
// dashed one (a place something can go, or a draft).
export type SurfaceBorder = boolean | 'top' | 'bottom' | 'dashed'

const BORDER: Record<'true' | 'false' | 'top' | 'bottom' | 'dashed', string> = {
  true: 'border border-outline-variant',
  false: '',
  top: 'border-t border-outline-variant',
  bottom: 'border-b border-outline-variant',
  dashed: 'border border-dashed border-outline',
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
  full: 'rounded-full',
}

const SHADOW: Record<Elevation, string> = {
  0: '',
  1: 'shadow-elevation-1',
  2: 'shadow-elevation-2',
  3: 'shadow-elevation-3',
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
  row = false,
  elevation = 0,
  justify = 'start',
  safe = false,
}: {
  pad: Space
  gap: Space
  tone: SurfaceTone
  radius: SurfaceRadius
  border: SurfaceBorder
  inset: SurfaceInset
  fit: boolean
  align: StackAlign
  row?: boolean
  elevation?: Elevation
  justify?: Justify
  safe?: SurfaceSafe
}) =>
  [
    row ? 'min-w-0 flex-row' : 'min-w-0 flex-col',
    inset === 'even' ? PAD[pad] : `${PAD_X[pad]} ${PAD_Y[above(pad, inset)]}`,
    safe === true || safe === 'bottom' || safe === 'all' ? PAD_SAFE_BOTTOM[above(pad, inset)] : '',
    safe === 'sides' || safe === 'all' ? `${PAD_SAFE_LEFT[pad]} ${PAD_SAFE_RIGHT[pad]}` : '',
    GAP[gap],
    ITEMS[align],
    JUSTIFY[justify],
    TONE[tone],
    RADIUS[radius],
    BORDER[String(border) as keyof typeof BORDER],
    fit ? 'w-fit max-w-full' : '',
    SHADOW[elevation],
  ]
    .filter(Boolean)
    .join(' ')

export type Columns = 1 | 2 | 3 | 4 | 6
// Two columns that are not equal: `pair` a label as wide as it needs and its value in the rest;
// `thirds` a third and two thirds.
export type GridPair = 'pair' | 'thirds'
export type GridColumns =
  Columns | GridPair | { base?: Columns; sm?: Columns; md?: Columns; lg?: Columns }

const PAIR: Record<GridPair, string> = {
  pair: 'grid-cols-[auto_minmax(0,1fr)]',
  thirds: 'grid-cols-[minmax(0,1fr)_minmax(0,2fr)]',
}

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

// Equal columns, `gap` apart (rows `lineGap` apart when given); `cols` may change at the sm, md
// and lg widths.
export const gridLook = (
  cols: GridColumns,
  gap: Space,
  align: RowAlign = 'stretch',
  lineGap?: Space
) => {
  if (typeof cols === 'string')
    return `min-w-0 ${PAIR[cols]} ${GAP[gap]}${lineGap ? ` ${ROW_GAP[lineGap]}` : ''} ${ITEMS[align]}`
  const by = typeof cols === 'number' ? { base: cols } : cols
  const steps = (['base', 'sm', 'md', 'lg'] as const).flatMap(k => {
    const n = by[k]
    return n === undefined ? [] : [COLS[k][n]]
  })
  return `min-w-0 ${steps.join(' ')} ${GAP[gap]}${lineGap ? ` ${ROW_GAP[lineGap]}` : ''} ${ITEMS[align]}`
}

// The box an icon sits in beside text: one line of the text high, so a row aligned at its start
// puts the icon on the middle of the first line.
export const firstLineLook = 'h-lh shrink-0 items-center'

// Where a bar at the bottom of a pane sits (the composer, or what stands in for it): inset from the
// sides, and above the home indicator or, while it is open, the on-screen keyboard.
export const dockLook = (gap: Space = 'none') =>
  `mx-(--space-md) mb-[max(var(--space-md),env(safe-area-inset-bottom))] min-w-0 shrink-0 flex-col ${GAP[gap]} keyboard:mb-(--space-md)`

// How far a box is pulled up over what is above it (an avatar over a banner).
export type LiftBy = 'lg' | '2xl' | '3xl'

const LIFT: Record<LiftBy, string> = {
  lg: '-mt-(--space-lg)',
  '2xl': '-mt-(--space-2xl)',
  '3xl': '-mt-(--space-3xl)',
}

export const liftLook = (by: LiftBy) => `relative ${LIFT[by]}`
