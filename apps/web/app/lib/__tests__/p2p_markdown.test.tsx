import { beforeEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChatSourceProvider, type ChatSource } from '../../components/chat_source'
import { MarkdownMessage } from '../../components/markdown_message'
import { api } from '../instances'
import type { Message } from '../types'

// In a P2P conversation nothing loads by itself: images from the instance (or anywhere) are
// links, and instance embeds and previews are never shown.

const ORIGIN = 'http://localhost:3510'

// The window only exists while an instance message renders: P2P messages must not need it.
const withWindow = <T,>(fn: () => T): T => {
  const g = globalThis as { window?: unknown }
  const real = g.window
  g.window = { location: { href: `${ORIGIN}/`, origin: ORIGIN } }
  try {
    return fn()
  } finally {
    g.window = real
  }
}

const source: ChatSource = {
  toggleReaction: () => {},
  loadReactors: async () => [],
  openReactPicker: () => {},
  known: () => '',
  user: username => ({
    username,
    display_name: username,
    avatar_kind: 'identicon',
    avatar_color: null,
  }),
  mine: () => false,
  self: 'me',
  people: () => [],
}

const message = (content: string): Message =>
  ({
    id: 1,
    channel_id: null,
    dm_id: null,
    thread_root_id: null,
    author: { username: 'x', display_name: 'X', avatar_kind: 'identicon', avatar_color: null },
    content,
    created_at: 1,
    reply_count: 0,
    media: null,
    embeds: [
      {
        ord: 0,
        url: 'https://example.com/a',
        title: 'Card',
        description: null,
        site_name: null,
        image_url: '/api/messages/1/embeds/0/image?v=0123456789abcdef',
        banner_removed: false,
      },
    ],
    kind: 'user',
    call: null,
    reactions: [],
    reply_to: null,
    edited_at: null,
  }) as unknown as Message

const render = (content: string, p2p: boolean) => {
  const el = <MarkdownMessage message={message(content)} />
  return p2p
    ? renderToStaticMarkup(<ChatSourceProvider value={source}>{el}</ChatSourceProvider>)
    : withWindow(() => renderToStaticMarkup(el))
}

describe('P2P messages fetch nothing', () => {
  beforeEach(() => api.setToken(null))

  const text = `![pixel](${ORIGIN}/api/media/7) and ![rel](/api/media/8) https://example.com/a`

  test('instance messages still show same-origin images', () => {
    const html = render(text, false)
    expect(html).toContain(`<img src="${ORIGIN}/api/media/7"`)
    expect(html).toContain('/messages/1/embeds/0/image?v=0123456789abcdef')
  })

  test('P2P messages render images as links and show no embeds', () => {
    const html = render(text, true)
    expect(html).not.toContain('<img')
    expect(html).not.toContain('/embeds/0/image')
    expect(html).toContain(`href="${ORIGIN}/api/media/7"`)
    expect(html).toContain('>pixel</a>')
    expect(html).toContain('>rel</a>')
  })
})
