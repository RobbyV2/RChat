export interface Trigger {
  start: number
  end: number
  query: string
}

const FENCE = /^\s*(```|~~~)/
const OPENERS = /[\s([{"'>*~]/

export function inCode(text: string, pos: number) {
  const lines = text.slice(0, pos).split('\n')
  const cur = lines.pop() ?? ''
  let fenced = false
  for (const line of lines) if (FENCE.test(line)) fenced = !fenced
  if (fenced || FENCE.test(cur)) return true
  let open: number | null = null
  for (const m of cur.matchAll(/`+/g)) {
    if (open === null) open = m[0].length
    else if (open === m[0].length) open = null
  }
  return open !== null
}

export function findTrigger(
  text: string,
  caret: number,
  char: string,
  min: number,
  allowed: RegExp = /[\p{L}\p{N}_+-]/u
): Trigger | null {
  let i = caret
  while (i > 0 && allowed.test(text[i - 1])) i--
  if (i === 0 || text[i - 1] !== char) return null
  const start = i - 1
  if (start > 0 && !OPENERS.test(text[start - 1])) return null
  const query = text.slice(i, caret)
  if (query.length < min || inCode(text, start)) return null
  return { start, end: caret, query }
}

export const spliceText = (text: string, start: number, end: number, insert: string) =>
  text.slice(0, start) + insert + text.slice(end)

export interface Rect {
  top: number
  left: number
  right: number
  bottom: number
}

export interface Size {
  width: number
  height: number
}

export type Side = 'top' | 'bottom'
export type Align = 'start' | 'end'

export const POPOVER_GAP = 8
export const VIEWPORT_MARGIN = 8

export function placePopover(
  anchor: Rect,
  size: Size,
  viewport: Size,
  side: Side = 'top',
  align: Align = 'end'
) {
  const m = VIEWPORT_MARGIN
  const above = anchor.top - POPOVER_GAP - size.height
  const below = anchor.bottom + POPOVER_GAP
  const fitsAbove = above >= m
  const fitsBelow = below + size.height <= viewport.height - m
  const top =
    side === 'top'
      ? fitsAbove || !fitsBelow
        ? above
        : below
      : fitsBelow || !fitsAbove
        ? below
        : above
  const left = align === 'end' ? anchor.right - size.width : anchor.left
  const clamp = (v: number, max: number) => Math.max(m, Math.min(v, max - m))
  return {
    top: clamp(top, viewport.height - size.height),
    left: clamp(left, viewport.width - size.width),
  }
}

export const keepDismissal = (dismissed: string | null, scope: string | null) =>
  dismissed !== null && dismissed === scope ? dismissed : null

export function scrollToShow(top: number, height: number, scrollTop: number, view: number) {
  if (top < scrollTop) return top
  if (top + height > scrollTop + view) return top + height - view
  return scrollTop
}
