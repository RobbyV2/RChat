import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Overlay, Sheet, TopDialog } from '../../components/ui'

const attr = (html: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(html)?.[1]

test('a top dialog is a labelled modal dialog with the shared look and a scrolling body', () => {
  const html = renderToStaticMarkup(
    <TopDialog labelledBy="t" describedBy="d" onCancel={() => {}}>
      <h2 id="t">Open this app?</h2>
    </TopDialog>
  )
  expect(html.startsWith('<dialog')).toBe(true)
  expect(attr(html, 'aria-modal')).toBe('true')
  expect(attr(html, 'aria-labelledby')).toBe('t')
  expect(attr(html, 'aria-describedby')).toBe('d')
  const cls = attr(html, 'class')?.split(' ') ?? []
  expect(cls).toContain('backdrop:bg-scrim/60')
  expect(cls).toContain('w-[min(24rem,calc(100%-2rem))]')
  expect(html).toContain('<div class="min-h-0 flex-1 overflow-y-auto p-6"><h2 id="t">')
})

test('a wide top dialog is 32rem at most', () => {
  const html = renderToStaticMarkup(
    <TopDialog labelledBy="t" wide onCancel={() => {}}>
      x
    </TopDialog>
  )
  expect(attr(html, 'class')?.split(' ')).toContain('w-[min(32rem,calc(100%-2rem))]')
  expect(html).toContain('overflow-y-auto p-6 flex flex-col')
})

const panelOf = (html: string) => /<div ([^>]*role="(?:dialog|menu)"[^>]*)>/.exec(html)?.[1] ?? ''

test('a sheet is a labelled modal panel over a dim backdrop, on its layer', () => {
  const html = renderToStaticMarkup(
    <Sheet aria-label="Inbox" onClose={() => {}} data-inbox="">
      body
    </Sheet>
  )
  expect(html).toContain('fixed inset-x-0 top-app h-app *:pointer-events-auto z-top')
  expect(html).toContain('data-backdrop')
  expect(html).toContain('bg-scrim/40')
  const panel = panelOf(html)
  expect(panel).toContain('aria-modal="true"')
  expect(panel).toContain('aria-label="Inbox"')
  expect(panel).toContain('data-inbox=""')
  expect(panel).toContain('rounded-t-3xl')
  expect(panel).toContain('data-sheet=""')
  expect(html).toContain('pt-3 pb-2')
  const palette = renderToStaticMarkup(
    <Sheet aria-label="Command palette" layer="palette" onClose={() => {}}>
      body
    </Sheet>
  )
  expect(palette).toContain('z-palette')
})

test('a floating panel is placed by `at` and keeps the floating look', () => {
  const html = renderToStaticMarkup(
    <Sheet
      sheet={false}
      aria-label="Inbox"
      float={{ at: 'top-2 right-3 w-104', backdrop: 'dim' }}
      onClose={() => {}}
    >
      <span>body</span>
    </Sheet>
  )
  const panel = panelOf(html)
  expect(panel).toContain('absolute top-2 right-3 w-104 rounded-2xl')
  expect(panel).not.toContain('rounded-t-3xl')
  expect(html).not.toContain('pt-3 pb-2')
})

test('the backdrop dims the app area, as a dialog backdrop does', () => {
  const html = renderToStaticMarkup(
    <Sheet aria-label="Pins" onClose={() => {}}>
      body
    </Sheet>
  )
  expect(html).toContain('class="absolute inset-0 bg-scrim/40"')
  expect(html).toContain('top-app h-app')
})

test('only a grip with drag handlers keeps touches from scrolling', () => {
  const plain = renderToStaticMarkup(
    <Sheet role="menu" scroll onClose={() => {}}>
      body
    </Sheet>
  )
  expect(plain).toContain('pt-3 pb-2')
  expect(plain).not.toContain('touch-none')
  const handle = renderToStaticMarkup(
    <Sheet aria-label="Emoji" gripProps={{ onTouchStart: () => {} }} onClose={() => {}}>
      body
    </Sheet>
  )
  expect(handle).toContain('touch-none')
})

test('a list sheet is at least 16rem high, so it does not jump while it loads', () => {
  const html = renderToStaticMarkup(
    <Sheet aria-label="Pins" height="list" onClose={() => {}}>
      body
    </Sheet>
  )
  expect(panelOf(html)).toContain('min-h-64 max-h-[85%]')
})

test('a floating panel with no backdrop is not modal and leaves the app pressable', () => {
  const html = renderToStaticMarkup(
    <Sheet
      sheet={false}
      aria-label="Inbox"
      float={{ at: 'top-2 right-3', backdrop: 'none' }}
      onClose={() => {}}
    >
      body
    </Sheet>
  )
  expect(html).not.toContain('data-backdrop')
  expect(/^<div class="pointer-events-none [^"]*\*:pointer-events-auto/.test(html)).toBe(true)
  expect(panelOf(html)).not.toContain('aria-modal')
})

test('a sheet menu is not a modal dialog and keeps a long press from selecting', () => {
  const html = renderToStaticMarkup(
    <Sheet role="menu" scroll selectable={false} onClose={() => {}}>
      body
    </Sheet>
  )
  const panel = panelOf(html)
  expect(panel).toContain('role="menu"')
  expect(panel).not.toContain('aria-modal')
  expect(panel).toContain('overflow-y-auto')
  expect(panel).toContain('select-none')
})

test('a clear overlay takes presses without a scrim', () => {
  const html = renderToStaticMarkup(
    <Overlay backdrop="clear" onClose={() => {}}>
      <div>menu</div>
    </Overlay>
  )
  expect(html).toContain('data-backdrop')
  expect(html).not.toContain('bg-scrim')
})
