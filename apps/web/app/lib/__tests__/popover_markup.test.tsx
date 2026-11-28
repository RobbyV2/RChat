import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Popover } from '../../components/ui'

const classes = (html: string) => (/class="([^"]*)"/.exec(html)?.[1] ?? '').split(' ')

describe('Popover', () => {
  test('is a dialog with the one panel look: surface, shape, shadow and layer', () => {
    const html = renderToStaticMarkup(
      <Popover at="pane" aria-label="Pinned messages">
        list
      </Popover>
    )
    expect(html).toContain('role="dialog"')
    expect(html).toContain('data-popover=""')
    expect(html).toContain('aria-label="Pinned messages"')
    for (const c of [
      'z-popover',
      'rounded-2xl',
      'border-outline-variant',
      'bg-surface-container-high',
      'shadow-elevation-3',
      'overflow-hidden',
    ])
      expect(classes(html)).toContain(c)
  })

  test('in a pane it sits under the header at the end; elsewhere at its measured place', () => {
    const pane = renderToStaticMarkup(<Popover at="pane">x</Popover>)
    expect(classes(pane)).toContain('absolute')
    expect(classes(pane)).toContain('origin-top-right')
    expect(pane).not.toContain('style=')
    const placed = renderToStaticMarkup(
      <Popover at={{ top: 40, left: 12 }} size="text">
        x
      </Popover>
    )
    expect(classes(placed)).toContain('fixed')
    expect(placed).toContain('style="top:40px;left:12px;transform-origin:top left"')
    expect(classes(placed)).toContain('w-112')
  })

  test('until its place is measured it is laid out unseen and takes no presses', () => {
    const html = renderToStaticMarkup(
      <Popover at={null} size="card" layer="top" scroll>
        x
      </Popover>
    )
    for (const c of ['invisible', 'pointer-events-none', 'z-top', 'w-75', 'overflow-y-auto'])
      expect(classes(html)).toContain(c)
    expect(classes(renderToStaticMarkup(<Popover at="pane">x</Popover>))).not.toContain('invisible')
  })
})
