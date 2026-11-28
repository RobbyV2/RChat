import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Anchored, PaneCorner } from '../../components/ui'

const panelOf = (html: string) => /<div[^>]*role="dialog"[^>]*>/.exec(html)?.[0] ?? ''
const classes = (tag: string) => (/class="([^"]*)"/.exec(tag)?.[1] ?? '').split(' ')

const render = (props: Partial<Parameters<typeof Anchored>[0]> = {}) =>
  renderToStaticMarkup(
    <Anchored anchor={{ el: null }} label="Pinned messages" onClose={() => {}} {...props}>
      list
    </Anchored>
  )

describe('Anchored', () => {
  test('is a dialog on its own layer with the one panel look: surface, shape and shadow', () => {
    const html = render()
    const panel = panelOf(html)
    expect(panel).toContain('aria-label="Pinned messages"')
    expect(panel).toContain('tabindex="-1"')
    expect(panel).not.toContain('aria-modal')
    for (const c of [
      'fixed',
      'w-104',
      'rounded-2xl',
      'border-outline-variant',
      'bg-surface-container-high',
      'shadow-elevation-3',
      'overflow-hidden',
    ])
      expect(classes(panel)).toContain(c)
    expect(/^<div data-popover="" class="pointer-events-none [^"]* z-popover"/.test(html)).toBe(
      true
    )
    expect(html).not.toContain('data-backdrop')
  })

  test('until its place is measured it is laid out unseen and takes no presses', () => {
    const panel = panelOf(render({ size: 'card', raised: true, scroll: true }))
    for (const c of ['invisible', 'pointer-events-none', 'w-75', 'overflow-y-auto'])
      expect(classes(panel)).toContain(c)
    expect(panel).not.toContain('style=')
    expect(render({ raised: true })).toContain('z-top')
  })

  test('each size is one fixed box kept inside the window', () => {
    expect(classes(panelOf(render({ size: 'text' })))).toContain('w-112')
    expect(classes(panelOf(render({ size: 'picker' })))).toContain('w-110')
    for (const size of ['card', 'list', 'text', 'picker'] as const)
      expect(/max-w-(screen-inset|popover)/.test(panelOf(render({ size })))).toBe(true)
  })

  test('what it holds learns whether it is a sheet', () => {
    const html = renderToStaticMarkup(
      <Anchored anchor={{ point: { x: 4, y: 8 } }} label="Card" onClose={() => {}}>
        {sheet => <b>{sheet ? 'sheet' : 'floating'}</b>}
      </Anchored>
    )
    expect(html).toContain('<b>floating</b>')
  })

  test('the corner a header list is anchored to sits under the header at the end of its pane', () => {
    const html = renderToStaticMarkup(<PaneCorner ref={() => {}} />)
    expect(html).toBe(
      '<span aria-hidden="true" class="pointer-events-none absolute top-12 right-2"></span>'
    )
  })
})
