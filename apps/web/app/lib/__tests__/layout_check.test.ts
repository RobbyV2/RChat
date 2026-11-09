import { describe, expect, test } from 'bun:test'
import { layoutIssues, type Frame, type LayoutNode } from '../layout_check'

const frame: Frame = { width: 400, height: 800, safe: { top: 0, right: 0, bottom: 0, left: 0 } }

let next = 0
const node = (
  box: [number, number, number, number],
  over: Partial<LayoutNode> = {}
): LayoutNode => {
  const [left, top, right, bottom] = box
  return {
    id: next++,
    parent: null,
    label: `n${next - 1}`,
    box: { left, top, right, bottom },
    flow: true,
    inline: false,
    clipX: false,
    clipY: false,
    scrollX: false,
    scrollY: false,
    ellipsis: false,
    content: true,
    ...over,
  }
}

const tree = (...nodes: LayoutNode[]) => {
  next = 0
  return nodes
}

describe('layout issues', () => {
  test('a child that sticks out of its parent', () => {
    next = 0
    const row = node([0, 0, 280, 40])
    const send = node([250, 4, 300, 36], { parent: row.id, label: 'Send' })
    expect(layoutIssues([row, send], frame)).toEqual([
      { kind: 'overflow', node: 'Send', parent: 'n0', by: 20 },
    ])
  })

  test('half a pixel of rounding is not an overflow', () => {
    next = 0
    const row = node([0, 0, 280, 40])
    const send = node([250, 4, 280.5, 36], { parent: row.id })
    expect(layoutIssues([row, send], frame)).toEqual([])
  })

  test('a scrolling parent may hold more than it shows', () => {
    next = 0
    const list = node([0, 0, 280, 400], { clipX: true, clipY: true, scrollX: true, scrollY: true })
    const row = node([0, 300, 280, 900], { parent: list.id })
    expect(layoutIssues([list, row], frame)).toEqual([])
  })

  test('a parent that scrolls only vertically still bounds its width', () => {
    next = 0
    const list = node([0, 0, 280, 400], { clipX: true, clipY: true, scrollY: true })
    const card = node([0, 0, 320, 100], { parent: list.id, label: 'card' })
    expect(layoutIssues([list, card], frame)).toEqual([
      { kind: 'overflow', node: 'card', parent: 'n0', by: 40 },
    ])
  })

  test('text cut on purpose with an ellipsis is fine', () => {
    next = 0
    const name = node([0, 0, 80, 20], { clipX: true, clipY: true, ellipsis: true })
    const inner = node([0, 0, 200, 20], { parent: name.id, inline: true })
    expect(layoutIssues([name, inner], frame)).toEqual([])
  })

  test('siblings in flow must not overlap', () => {
    next = 0
    const header = node([0, 0, 400, 56])
    const title = node([16, 18, 200, 38], { parent: header.id, label: 'title' })
    const clock = node([150, 18, 230, 38], { parent: header.id, label: 'clock' })
    expect(layoutIssues([header, title, clock], frame)).toEqual([
      { kind: 'overlap', node: 'title', other: 'clock', by: 20 },
    ])
  })

  test('positioned and inline siblings may overlap', () => {
    next = 0
    const tile = node([0, 0, 48, 48])
    const icon = node([0, 0, 48, 48], { parent: tile.id })
    const badge = node([36, -4, 52, 12], { parent: tile.id, flow: false })
    const a = node([0, 0, 48, 40], { parent: tile.id, inline: true })
    const b = node([0, 20, 48, 48], { parent: tile.id, inline: true })
    expect(layoutIssues([tile, icon, badge, a, b], frame)).toEqual([])
  })

  test('a positioned badge cut off by a clipping ancestor', () => {
    next = 0
    const card = node([0, 0, 200, 100], { clipX: true, clipY: true })
    const body = node([0, 0, 200, 100], { parent: card.id })
    const badge = node([190, -6, 210, 10], { parent: body.id, flow: false, label: 'badge' })
    expect(layoutIssues([card, body, badge], frame)).toEqual([
      { kind: 'clipped', node: 'badge', parent: 'n0', by: 10 },
    ])
  })

  test('content past the right edge of the page', () => {
    next = 0
    const page = node([0, 0, 460, 800], { content: false, label: 'page' })
    expect(layoutIssues([page], frame)).toEqual([{ kind: 'offscreen', node: 'page', by: 60 }])
  })

  test('content under the status bar of a home screen app', () => {
    const notch: Frame = { ...frame, safe: { top: 47, right: 0, bottom: 34, left: 0 } }
    next = 0
    const header = node([0, 0, 400, 56], { label: 'header' })
    const bar = node([0, 0, 400, 47], { content: false, label: 'backdrop' })
    expect(layoutIssues([header, bar], notch)).toEqual([{ kind: 'unsafe', node: 'header', by: 47 }])
  })

  test('content scrolled out of view is not under the status bar', () => {
    const notch: Frame = { ...frame, safe: { top: 47, right: 0, bottom: 34, left: 0 } }
    next = 0
    const list = node([0, 103, 400, 700], {
      clipX: true,
      clipY: true,
      scrollY: true,
      scrollX: true,
      content: false,
    })
    const row = node([0, 0, 400, 60], { parent: list.id })
    expect(layoutIssues([list, row], notch)).toEqual([])
  })

  test('a negative margin reaches out of the parent on purpose', () => {
    next = 0
    const name = node([10, 0, 100, 20])
    const pill = node([4, 0, 100, 20], {
      parent: name.id,
      bleed: { left: 6, top: 0, right: 0, bottom: 0 },
    })
    const wider = node([2, 0, 100, 20], {
      parent: name.id,
      bleed: { left: 6, top: 0, right: 0, bottom: 0 },
      label: 'wider',
    })
    expect(layoutIssues([name, pill, wider], frame)).toEqual([
      { kind: 'overflow', node: 'wider', parent: 'n0', by: 2 },
    ])
  })

  test('siblings pulled over each other with a negative margin may overlap', () => {
    next = 0
    const card = node([0, 0, 400, 200])
    const banner = node([0, 0, 400, 60], { parent: card.id })
    const avatar = node([12, 28, 76, 92], {
      parent: card.id,
      bleed: { left: 0, top: 32, right: 0, bottom: 0 },
    })
    expect(layoutIssues([card, banner, avatar], frame)).toEqual([])
  })

  test('an inline span may be taller than its line but not wider than its block', () => {
    next = 0
    const h1 = node([0, 0, 300, 36])
    const name = node([120, -3, 200, 39], { parent: h1.id, inline: true })
    const long = node([120, 0, 330, 36], { parent: h1.id, inline: true, label: 'long' })
    expect(layoutIssues([h1, name, long], frame)).toEqual([
      { kind: 'overflow', node: 'long', parent: 'n0', by: 30 },
    ])
  })

  test('list content may scroll under the home indicator', () => {
    const notch: Frame = { ...frame, safe: { top: 47, right: 0, bottom: 34, left: 0 } }
    next = 0
    const list = node([0, 103, 400, 800], {
      clipX: true,
      clipY: true,
      scrollY: true,
      scrollX: true,
      content: false,
      endRoom: 34,
    })
    const row = node([0, 740, 400, 800], { parent: list.id })
    expect(layoutIssues([list, row], notch)).toEqual([])
  })

  test('a list that ends under the home indicator pads its end clear of it', () => {
    const notch: Frame = { ...frame, safe: { top: 47, right: 0, bottom: 34, left: 0 } }
    next = 0
    const list = node([0, 103, 400, 800], {
      clipX: true,
      clipY: true,
      scrollY: true,
      scrollX: true,
      content: false,
      endRoom: 12,
      label: 'list',
    })
    expect(layoutIssues([list], notch)).toEqual([{ kind: 'unsafe', node: 'list', by: 22 }])
  })

  test('nodes come in any order', () => {
    const items = tree(node([0, 0, 280, 40]), node([250, 4, 300, 36]))
    items[1].parent = items[0].id
    expect(layoutIssues([items[1], items[0]], frame)).toHaveLength(1)
  })
})
