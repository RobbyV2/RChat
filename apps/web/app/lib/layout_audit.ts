// Spacing faults on a rendered screen, from boxes measured in the page (see
// scripts/layout_audit_browser.ts): a surface padded unevenly or off the spacing scale, a gap off
// the scale, and children of a centered row that do not share one center line. Lengths are CSS
// pixels; the scale is the `--space-*` steps of globals.css.

export const SCALE_PX = [0, 2, 4, 6, 8, 12, 16, 24, 32, 48] as const

export interface Sides {
  top: number
  right: number
  bottom: number
  left: number
}

export interface AuditNode {
  label: string
  // Has a surface of its own: a background, or a border on every side.
  surface: boolean
  padding: Sides
  // A flex or grid container's gaps (null when it is neither).
  gap: { row: number; column: number } | null
  // A flex row whose children are centered on one line: their vertical centers.
  centers: number[] | null
}

export type AuditIssue =
  | { kind: 'uneven'; label: string; padding: Sides }
  | { kind: 'off-scale-padding'; label: string; value: number }
  | { kind: 'off-scale-gap'; label: string; value: number }
  | { kind: 'misaligned'; label: string; spread: number }

const onScale = (px: number, tolerance: number) =>
  SCALE_PX.some(step => Math.abs(step - px) <= tolerance)

export function auditIssues(nodes: AuditNode[], tolerance = 0.5): AuditIssue[] {
  const out: AuditIssue[] = []
  for (const n of nodes) {
    const p = n.padding
    if (n.surface && p.top + p.right + p.bottom + p.left > 0) {
      // Even on every side, or a bar: the same at both sides and the same above and below.
      if (Math.abs(p.left - p.right) > tolerance || Math.abs(p.top - p.bottom) > tolerance)
        out.push({ kind: 'uneven', label: n.label, padding: p })
      for (const value of new Set([p.top, p.right, p.bottom, p.left]))
        if (!onScale(value, tolerance))
          out.push({ kind: 'off-scale-padding', label: n.label, value })
    }
    if (n.gap)
      for (const value of new Set([n.gap.row, n.gap.column]))
        if (!onScale(value, tolerance)) out.push({ kind: 'off-scale-gap', label: n.label, value })
    if (n.centers && n.centers.length > 1) {
      const spread = Math.max(...n.centers) - Math.min(...n.centers)
      if (spread > 1 + tolerance) out.push({ kind: 'misaligned', label: n.label, spread })
    }
  }
  return out
}

const px = (n: number) => `${Math.round(n * 10) / 10}px`

export const describeAudit = (i: AuditIssue) => {
  switch (i.kind) {
    case 'uneven':
      return `${i.label} is padded unevenly (${px(i.padding.top)} ${px(i.padding.right)} ${px(i.padding.bottom)} ${px(i.padding.left)})`
    case 'off-scale-padding':
      return `${i.label} has padding ${px(i.value)}, off the spacing scale`
    case 'off-scale-gap':
      return `${i.label} has a gap of ${px(i.value)}, off the spacing scale`
    case 'misaligned':
      return `${i.label} has children ${px(i.spread)} off one center line`
  }
}
