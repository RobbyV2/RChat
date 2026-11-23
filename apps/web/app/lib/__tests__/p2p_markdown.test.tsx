import { beforeEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChatSourceProvider, type ChatSource } from '../../components/chat_source'
import { MarkdownMessage, messageLinkAction } from '../../components/markdown_message'
import { AccountProvider } from '../client/react'
import { api } from '../instances'
import { testAccount } from './test_account'
import type { Message } from '../types'

// In a P2P conversation nothing loads by itself: images from the instance (or anywhere) are
// links, and instance embeds and previews are never shown.

const ORIGIN = api.origin()

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

  test('instance messages show same-origin images', () => {
    const html = render(text + ' ![asset](/asset.png)', false)
    expect(html).toContain(`<img src="${ORIGIN}/api/media/7"`)
    expect(html).toContain('<img src="/asset.png"')
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

describe('inline images follow the account rendering the message', () => {
  for (const origin of [ORIGIN, 'https://secondary.test']) {
    test(`secondary on ${origin} only previews its own uploaded media`, () => {
      const owner = testAccount('reader', origin)
      try {
        const renderImage = (src: string) =>
          withWindow(() =>
            renderToStaticMarkup(
              <AccountProvider session={owner}>
                <MarkdownMessage message={{ ...message(`![photo](${src})`), embeds: [] }} />
              </AccountProvider>
            )
          )
        for (const src of ['/api/media/7', 'api/media/7', `${origin}/api/v1/media/7`]) {
          const html = renderImage(src)
          expect(html).toContain('animate-pulse')
          expect(html).not.toContain('<img')
        }
        for (const src of [
          '/api/media/7?private',
          '/api/media/7/other',
          '/api/media/%FF',
          '/api/messages/1/embeds/0/image',
          `${ORIGIN}/private/image.png`,
          ...(origin === ORIGIN ? [] : [`${ORIGIN}/api/media/7`]),
        ]) {
          const html = renderImage(src)
          expect(html).toContain(`href="${new URL(src, origin).href}"`)
          expect(html).not.toContain('animate-pulse')
          expect(html).not.toContain('<img')
        }
      } finally {
        owner.store.dispose()
      }
    })
  }
})

test('inline links classify and dispatch for the rendering account', async () => {
  const owner = testAccount('reader', 'https://secondary.test')
  try {
    const calls: unknown[] = []
    owner.store.setState({
      openInvite: (...args) => void calls.push(args),
      openMessage: async (...args) => void calls.push(args),
    })
    for (const path of ['/invite/club/', '/dm/3/91/']) {
      const renderLink = (href: string) =>
        withWindow(() =>
          renderToStaticMarkup(
            <AccountProvider session={owner}>
              <MarkdownMessage
                message={{ ...message(`[open](${href})`), embeds: [], no_previews: true }}
              />
            </AccountProvider>
          )
        )
      const local = owner.shareOrigin + path
      expect(renderLink(local)).not.toContain('target="_blank"')
      expect(renderLink(ORIGIN + path)).toContain('target="_blank"')
      await messageLinkAction(owner, local)!()
    }
    expect(calls).toEqual([
      ['club', null, undefined],
      [91, 'push', { kind: 'dm', dmId: 3 }],
    ])
    const stale = messageLinkAction(owner, '/invite/club/')
    owner.lifetime.endSession()
    stale!()
    expect(calls).toHaveLength(2)
  } finally {
    owner.store.dispose()
  }
})
