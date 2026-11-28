import { createElement, type AllHTMLAttributes, type ReactNode, type Ref } from 'react'
import { placed, type LayoutPlace, type Look } from '../../lib/controls'
import {
  dockLook,
  firstLineLook,
  gridLook,
  liftLook,
  rowLook,
  stackLook,
  surfaceLook,
  typeLook,
  type BoxInk,
  type BoxText,
  type Breakpoint,
  type Elevation,
  type GridColumns,
  type Justify,
  type LiftBy,
  type RowAlign,
  type Space,
  type StackAlign,
  type SurfaceBorder,
  type SurfaceInset,
  type SurfaceRadius,
  type SurfaceTone,
} from '../../lib/layout'

// The boxes every screen is laid out with. Their spacing and alignment come only from their props
// (the scale and choices of `lib/layout.ts`); they take no class names or styles, so a screen
// cannot add space of its own. `place` puts a box in its parent (see `LayoutPlace`); `text` and
// `ink` set the type step and color its text inherits; `look` takes the classes that are neither
// (a color, a border, a size, a state), and no spacing (see `Look`).

type Tag =
  | 'div'
  | 'section'
  | 'article'
  | 'header'
  | 'footer'
  | 'nav'
  | 'aside'
  | 'main'
  | 'ul'
  | 'ol'
  | 'li'
  | 'dl'
  | 'form'
  | 'fieldset'
  | 'label'
  | 'span'
  | 'p'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'legend'
  | 'summary'
  | 'dt'
  | 'dd'
  | 'time'
  | 'figure'
  | 'blockquote'
  | 'kbd'
  | 'code'
  | 'pre'
  | 'button'
  | 'a'

type Box<S extends string, L extends string> = Omit<
  AllHTMLAttributes<HTMLElement>,
  'className' | 'style' | 'as' | 'wrap' | 'cols'
> & {
  as?: Tag
  place?: LayoutPlace<S>
  look?: Look<L>
  text?: BoxText
  ink?: BoxInk
  ref?: Ref<HTMLElement>
  children?: ReactNode
}

function render<S extends string, L extends string>(
  display: string,
  box: string,
  { as = 'div', place, look, text, ink, ...rest }: Box<S, L>
) {
  const own = [box, typeLook(text, ink), look].filter(Boolean).join(' ')
  return createElement(as, { ...rest, className: placed(display, own, place) })
}

// Children one under the other, `gap` apart; `divided` draws a line between them; `rowFrom`
// puts them side by side, centered, from that width on.
export function Stack<const S extends string = never, const L extends string = never>({
  gap,
  align,
  justify,
  divided,
  rowFrom,
  ...box
}: Box<S, L> & {
  gap: Space
  align?: StackAlign
  justify?: Justify
  divided?: boolean
  rowFrom?: Breakpoint
}) {
  return render('flex', stackLook(gap, align, justify, divided, rowFrom), box)
}

// Children side by side on one line (center, or text baseline), `gap` apart; `wrap` continues a
// full line under itself, `lineGap` below it (`gap` unless given).
export function Row<const S extends string = never, const L extends string = never>({
  gap,
  align,
  justify,
  wrap,
  lineGap,
  ...box
}: Box<S, L> & {
  gap: Space
  align?: RowAlign
  justify?: Justify
  wrap?: boolean
  lineGap?: Space
}) {
  return render('flex', rowLook(gap, align, justify, wrap, lineGap), box)
}

// A card: a surface padded by `pad` on every side (`inset="bar"` for a header or toolbar line),
// its children a column `gap` apart. `fit` makes it as wide as its content (an image, a code), so
// nothing leaves empty space beside it. `tone="plain"` pads without a surface of its own;
// `border="bottom"` (or `top`) lines one edge, as a panel's header or footer. A `row` surface lays
// its children side by side, centered; `elevation` lifts it (a popover); a `safe` one at the
// lower edge of the screen keeps its content above the home indicator.
export function Surface<const S extends string = never, const L extends string = never>({
  pad,
  gap = 'none',
  tone = 'high',
  radius = 'xl',
  border = false,
  inset = 'even',
  fit = false,
  row = false,
  align = row ? 'center' : 'stretch',
  elevation = 0,
  justify,
  safe = false,
  ...box
}: Box<S, L> & {
  pad: Space
  gap?: Space
  tone?: SurfaceTone
  radius?: SurfaceRadius
  border?: SurfaceBorder
  inset?: SurfaceInset
  fit?: boolean
  row?: boolean
  align?: StackAlign
  elevation?: Elevation
  justify?: Justify
  safe?: boolean
}) {
  return render(
    'flex',
    surfaceLook({
      pad,
      gap,
      tone,
      radius,
      border,
      inset,
      fit,
      align,
      row,
      elevation,
      justify,
      safe,
    }),
    box
  )
}

// Room around some content without a surface of its own: a `Surface` with no tone and no round
// corners (the padded body of a panel, a line of a list).
export function Inset<const S extends string = never, const L extends string = never>(
  props: Omit<Parameters<typeof Surface<S, L>>[0], 'tone' | 'radius'>
) {
  return <Surface<S, L> {...props} tone="plain" radius="none" />
}

// Equal columns, `gap` apart (rows `lineGap` apart when given).
export function Grid<const S extends string = never, const L extends string = never>({
  cols,
  gap,
  align,
  lineGap,
  ...box
}: Box<S, L> & { cols: GridColumns; gap: Space; align?: RowAlign; lineGap?: Space }) {
  return render('grid', gridLook(cols, gap, align, lineGap), box)
}

// The box of an icon beside text in a `Row align="start"`: one text line high, so the icon sits
// on the middle of the first line however many lines the text takes.
export function FirstLine({ children }: { children: ReactNode }) {
  return <span className={`flex ${firstLineLook}`}>{children}</span>
}

// The place of a bar at the bottom of a pane (the composer, or what stands in for it): inset from
// the sides and above the home indicator, or the keyboard while it is open.
export function Dock({ children }: { children: ReactNode }) {
  return <div className={dockLook}>{children}</div>
}

// Pulls its content up over what is above it (an avatar over a banner).
export function Lift({ by, children }: { by: LiftBy; children: ReactNode }) {
  return <div className={liftLook(by)}>{children}</div>
}
