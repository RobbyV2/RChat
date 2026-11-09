// Layout faults in measured element boxes, for browser layout tests: an element that sticks out
// of its parent or is cut off by an ancestor, siblings that overlap, content past the edge of the
// page or under a safe-area inset (the status bar of a home screen app). No imports, so a test
// script can load it directly.

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

export interface LayoutNode {
  id: number
  // The nearest measured ancestor.
  parent: number | null
  label: string
  box: Box
  // Laid out by its parent (not absolute or fixed).
  flow: boolean
  // display: inline: its box spans lines and its height follows the font, not the line.
  inline: boolean
  // Hides its overflow on that axis (any overflow but visible).
  clipX: boolean
  clipY: boolean
  // Lets the user scroll to its overflow on that axis.
  scrollX: boolean
  scrollY: boolean
  // Truncates its text with an ellipsis on purpose.
  ellipsis: boolean
  // Text, a control or an image: something that must stay readable.
  content: boolean
  // How far negative margins pull it out of its parent on each side, on purpose.
  bleed?: Box
  // A scroll container's room below its last content once scrolled to the end.
  endRoom?: number
}

export interface Frame {
  width: number
  height: number
  safe: { top: number; right: number; bottom: number; left: number }
}

export type LayoutIssue =
  | { kind: 'overflow' | 'clipped'; node: string; parent: string; by: number }
  | { kind: 'overlap'; node: string; other: string; by: number }
  | { kind: 'offscreen' | 'unsafe'; node: string; by: number }

const round = (n: number) => Math.round(n * 10) / 10

const NO_BLEED: Box = { left: 0, top: 0, right: 0, bottom: 0 }

const outside = (inner: Box, outer: Box, x: boolean, y: boolean, bleed = NO_BLEED) =>
  Math.max(
    0,
    x ? outer.left - inner.left - bleed.left : 0,
    x ? inner.right - outer.right - bleed.right : 0,
    y ? outer.top - inner.top - bleed.top : 0,
    y ? inner.bottom - outer.bottom - bleed.bottom : 0
  )

const pulled = (n: LayoutNode) => n.bleed !== undefined && Object.values(n.bleed).some(v => v > 0)

const intersect = (a: Box, b: Box): Box => ({
  left: Math.max(a.left, b.left),
  top: Math.max(a.top, b.top),
  right: Math.min(a.right, b.right),
  bottom: Math.min(a.bottom, b.bottom),
})

const empty = (b: Box) => b.right - b.left <= 0 || b.bottom - b.top <= 0

export function layoutIssues(nodes: LayoutNode[], frame: Frame, tolerance = 1): LayoutIssue[] {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const ancestors = (n: LayoutNode) => {
    const out: LayoutNode[] = []
    for (let p = n.parent; p !== null;) {
      const a = byId.get(p)
      if (!a) break
      out.push(a)
      p = a.parent
    }
    return out
  }
  const issues: LayoutIssue[] = []
  const add = (issue: LayoutIssue) => {
    if (issue.by > tolerance) issues.push({ ...issue, by: round(issue.by) })
  }
  const kids = new Map<number, LayoutNode[]>()
  const sorted = [...nodes].sort((a, b) => a.id - b.id)
  for (const n of sorted) {
    if (empty(n.box)) continue
    const up = ancestors(n)
    const parent = up[0]
    if (parent) {
      const list = kids.get(parent.id) ?? []
      list.push(n)
      kids.set(parent.id, list)
    }
    if (n.flow && parent && !parent.inline && !parent.ellipsis)
      add({
        kind: 'overflow',
        node: n.label,
        parent: parent.label,
        by: outside(n.box, parent.box, !parent.scrollX, !parent.scrollY && !n.inline, n.bleed),
      })
    if (!n.flow) {
      const clip = up.find(a => a.clipX || a.clipY)
      if (clip && !clip.ellipsis)
        add({
          kind: 'clipped',
          node: n.label,
          parent: clip.label,
          by: outside(n.box, clip.box, clip.clipX && !clip.scrollX, clip.clipY && !clip.scrollY),
        })
    }
    let seen = n.box
    for (const a of up)
      if (a.clipX || a.clipY)
        seen = intersect(seen, {
          left: a.clipX ? a.box.left : -Infinity,
          right: a.clipX ? a.box.right : Infinity,
          top: a.clipY ? a.box.top : -Infinity,
          bottom: a.clipY ? a.box.bottom : Infinity,
        })
    if (empty(seen)) continue
    if (!up.some(a => a.scrollX))
      add({ kind: 'offscreen', node: n.label, by: Math.max(-seen.left, seen.right - frame.width) })
    const { safe } = frame
    const inner = {
      left: safe.left,
      top: safe.top,
      right: frame.width - safe.right,
      bottom: frame.height - safe.bottom,
    }
    // Content in a scroll container may pass under an inset while it scrolls.
    if (n.content) {
      const shown = intersect(seen, { left: 0, top: 0, right: frame.width, bottom: frame.height })
      const x = !up.some(a => a.scrollX)
      const y = !up.some(a => a.scrollY)
      if (!empty(shown)) add({ kind: 'unsafe', node: n.label, by: outside(shown, inner, x, y) })
    }
    if (n.scrollY && n.endRoom !== undefined && seen.bottom > inner.bottom)
      add({ kind: 'unsafe', node: n.label, by: seen.bottom - n.endRoom - inner.bottom })
  }
  for (const list of kids.values()) {
    const flat = list.filter(n => n.flow && !n.inline && !pulled(n))
    for (let i = 0; i < flat.length; i++)
      for (let j = i + 1; j < flat.length; j++) {
        const o = intersect(flat[i].box, flat[j].box)
        const w = o.right - o.left
        const h = o.bottom - o.top
        if (w > tolerance && h > tolerance)
          add({ kind: 'overlap', node: flat[i].label, other: flat[j].label, by: Math.min(w, h) })
      }
  }
  return issues
}

export const describeIssue = (i: LayoutIssue) =>
  i.kind === 'overlap'
    ? `${i.node} overlaps ${i.other} by ${i.by}px`
    : i.kind === 'overflow'
      ? `${i.node} sticks out of ${i.parent} by ${i.by}px`
      : i.kind === 'clipped'
        ? `${i.node} is cut off by ${i.parent} by ${i.by}px`
        : i.kind === 'offscreen'
          ? `${i.node} runs ${i.by}px past the edge of the page`
          : `${i.node} reaches ${i.by}px into a safe-area inset`
