import { createElement, type AllHTMLAttributes, type ReactNode, type Ref } from 'react'
import { placed, type LayoutPlace } from '../lib/controls'
import {
  gridLook,
  rowLook,
  stackLook,
  surfaceLook,
  type GridColumns,
  type Justify,
  type RowAlign,
  type Space,
  type StackAlign,
  type SurfaceBorder,
  type SurfaceInset,
  type SurfaceRadius,
  type SurfaceTone,
} from '../lib/layout'

// The boxes every screen is laid out with. Their spacing and alignment come only from their props
// (the scale and choices of `lib/layout.ts`); they take no class names or styles, so a screen
// cannot add space of its own. `place` puts a box in its parent (see `LayoutPlace`).

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

type Box<S extends string> = Omit<AllHTMLAttributes<HTMLElement>, 'className' | 'style' | 'as'> & {
  as?: Tag
  place?: LayoutPlace<S>
  ref?: Ref<HTMLElement>
  children?: ReactNode
}

function render<S extends string>(
  display: string,
  look: string,
  { as = 'div', place, ...rest }: Box<S>
) {
  return createElement(as, { ...rest, className: placed(display, look, place) })
}

// Children one under the other, `gap` apart; `divided` draws a line between them.
export function Stack<const S extends string = never>({
  gap,
  align,
  justify,
  divided,
  ...box
}: Box<S> & { gap: Space; align?: StackAlign; justify?: Justify; divided?: boolean }) {
  return render('flex', stackLook(gap, align, justify, divided), box)
}

// Children side by side on one line (center, or text baseline), `gap` apart; `wrap` continues a
// full line under itself.
export function Row<const S extends string = never>({
  gap,
  align,
  justify,
  wrap,
  ...box
}: Box<S> & { gap: Space; align?: RowAlign; justify?: Justify; wrap?: boolean }) {
  return render('flex', rowLook(gap, align, justify, wrap), box)
}

// A card: a surface padded by `pad` on every side (`inset="bar"` for a header or toolbar line),
// its children a column `gap` apart. `fit` makes it as wide as its content (an image, a code), so
// nothing leaves empty space beside it. `tone="plain"` pads without a surface of its own;
// `border="bottom"` (or `top`) lines one edge, as a panel's header or footer.
export function Surface<const S extends string = never>({
  pad,
  gap = 'none',
  tone = 'high',
  radius = 'xl',
  border = false,
  inset = 'even',
  fit = false,
  align = 'stretch',
  ...box
}: Box<S> & {
  pad: Space
  gap?: Space
  tone?: SurfaceTone
  radius?: SurfaceRadius
  border?: SurfaceBorder
  inset?: SurfaceInset
  fit?: boolean
  align?: StackAlign
}) {
  return render('flex', surfaceLook({ pad, gap, tone, radius, border, inset, fit, align }), box)
}

// Equal columns, `gap` apart both ways.
export function Grid<const S extends string = never>({
  cols,
  gap,
  align,
  ...box
}: Box<S> & { cols: GridColumns; gap: Space; align?: RowAlign }) {
  return render('grid', gridLook(cols, gap, align), box)
}
