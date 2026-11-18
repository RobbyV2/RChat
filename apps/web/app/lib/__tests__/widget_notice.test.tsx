import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { WidgetNotice } from '../../components/widget_notice'
import { systemParts, systemText } from '../system_messages'
import { msg, user } from './fixtures'

const text = (html: string) => html.replace(/<[^>]*>/g, '')

// The row's text up to its time.
const lead = (html: string, wording: string) => text(html).slice(0, wording.length)

test('a member joining reads as the channel notice in a widget, with no author header', () => {
  const join = msg(225, {
    kind: 'join',
    content: '',
    author: user('cellist', { display_name: 'Cello' }),
    created_at: 1_800_000_000,
  })
  const html = renderToStaticMarkup(<WidgetNotice message={join} />)
  const [before, after] = systemParts(join)
  const wording = before + 'Cello(cellist)' + after
  expect(lead(html, wording)).toBe(wording)
  expect(html).toContain('data-mid="225"')
  expect(html).toContain('class="streamer')
  expect(html).not.toContain('data-author-avatar')
  expect(html).not.toContain('aria-labelledby')
})

test('a member leaving reads as the channel notice in a widget', () => {
  const leave = msg(226, { kind: 'leave', content: '', author: user('violist') })
  const html = renderToStaticMarkup(<WidgetNotice message={leave} />)
  expect(lead(html, systemText(leave))).toBe(systemText(leave))
})

test('a pin reads as a notice in a widget, not as an empty post', () => {
  const pin = msg(227, {
    kind: 'pin',
    content: '',
    author: user('harpist', { display_name: 'Harp' }),
  })
  const html = renderToStaticMarkup(<WidgetNotice message={pin} />)
  expect(lead(html, 'Harp(harpist) pinned a message.')).toBe('Harp(harpist) pinned a message.')
  expect(html).toContain('data-system="pin"')
  expect(html).not.toContain('data-author-avatar')
})
