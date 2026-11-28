import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReactionBar } from '../../components/reactions'
import { msg } from './fixtures'

const m = msg(7, {
  reactions: [
    { emoji: '😀', count: 1, me: true, first_at: 1 },
    { emoji: '🇺🇸', count: 99, me: false, first_at: 2 },
  ],
})

test('reaction pills center the emoji: one line box, moved by the emoji font offset', () => {
  const html = renderToStaticMarkup(<ReactionBar m={m} canReact canRemove />)
  const spans = [...html.matchAll(/<span aria-hidden="true" class="([^"]*)">(😀|🇺🇸)<\/span>/g)]
  expect(spans.map(s => s[2])).toEqual(['😀', '🇺🇸'])
  for (const [, cls] of spans)
    expect(cls.split(' ').sort()).toEqual(
      ['font-emoji', 'leading-none', 'relative', 'text-base', 'top-emoji-shift'].sort()
    )
  expect(html).toContain('<span aria-hidden="true" class="inline-block">99</span>')
})
