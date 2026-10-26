export const EDGE = 48
export const MAX_SCROLL = 16
export const OFF_SIDE = 48
const LAYOUT_UNIT = 64

export interface Span {
  top: number
  bottom: number
}

export interface Box extends Span {
  key: string
  onto?: Span | null
}

export interface Slot {
  index: number
  line: number | null
  noop: boolean
  onto: string | null
}

export interface DropTarget {
  zone: string
  index: number
  onto: string | null
}

const mid = (b: Box) => (b.top + b.bottom) / 2

export const layoutSpan = ({ top, bottom }: Span, height: number): Span => {
  const center = Math.round(((top + bottom) / 2) * LAYOUT_UNIT) / LAYOUT_UNIT
  return { top: center - height / 2, bottom: center + height / 2 }
}

export const ontoBand = (top: number, bottom: number, open = false): Span => {
  const edge = (bottom - top) / 4
  return { top: top + edge, bottom: open ? bottom : bottom - edge }
}

export const slotAt = (items: Box[], y: number, key: string): Slot => {
  const from = items.findIndex(b => b.key === key)
  const rest = items.filter(b => b.key !== key)
  const hit = rest.findIndex(b => b.onto && y >= b.onto.top && y <= b.onto.bottom)
  if (hit !== -1) return { index: hit, line: null, noop: false, onto: rest[hit].key }
  const index = rest.filter(b => mid(b) < y).length
  const noop = from !== -1 && index === from
  if (rest.length === 0) return { index: 0, line: null, noop, onto: null }
  const gap = items.length > 1 ? Math.max(0, items[1].top - items[0].bottom) : 0
  const line =
    index === 0
      ? rest[0].top - gap / 2
      : index === rest.length
        ? rest[rest.length - 1].bottom + gap / 2
        : (rest[index - 1].bottom + rest[index].top) / 2
  return { index, line, noop, onto: null }
}

export const nearestSpan = (spans: Span[], y: number): number => {
  let best = -1
  let dist = Infinity
  spans.forEach((s, i) => {
    const d = y < s.top ? s.top - y : y > s.bottom ? y - s.bottom : 0
    if (d < dist) {
      best = i
      dist = d
    }
  })
  return best
}

export const autoScrollStep = (y: number, top: number, bottom: number): number => {
  const edge = Math.min(EDGE, (bottom - top) / 4)
  if (edge <= 0) return 0
  if (y < top + edge) return -Math.ceil(MAX_SCROLL * Math.min(1, (top + edge - y) / edge))
  if (y > bottom - edge) return Math.ceil(MAX_SCROLL * Math.min(1, (y - bottom + edge) / edge))
  return 0
}

export const offSide = (x: number, left: number, right: number) =>
  x < left - OFF_SIDE || x > right + OFF_SIDE
