import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { TopDialog } from '../../components/ui'

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
