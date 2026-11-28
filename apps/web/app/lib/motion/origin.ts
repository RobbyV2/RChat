// Where a menu or popover grows from as it opens: the point or the control that opened it.

interface Box {
  left: number
  top: number
  width: number
  height: number
}

const within = (n: number, max: number) => Math.round(Math.max(0, Math.min(n, max)))

// The point that opened a menu, inside the menu's own box.
export const originAt = (point: { x: number; y: number }, box: Box) =>
  `${within(point.x - box.left, box.width)}px ${within(point.y - box.top, box.height)}px`

interface Sides {
  top?: unknown
  left?: unknown
  right?: unknown
  bottom?: unknown
  transformOrigin?: string | number
}

// The corner of a popover that its place holds still, unless the place names its own origin.
export const originOf = (at: Sides) =>
  at.transformOrigin ??
  `${at.top === undefined && at.bottom !== undefined ? 'bottom' : 'top'} ${
    at.left === undefined && at.right !== undefined ? 'right' : 'left'
  }`
