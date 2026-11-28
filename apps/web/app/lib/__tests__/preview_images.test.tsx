import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { api, home } from './home_instance'
import { client } from '../client/client'
import { previewPath } from '../media_src'
import { resetSessionCaches, useStore } from '../store'
import { MarkdownMessage } from '../../components/markdown_message'
import type { MessageMedia } from '../types'
import { me, msg } from './fixtures'
import { Secret } from '../secret'

describe('link preview images', () => {
  test('only this preview path on the instance is accepted', () => {
    for (const prefix of ['/api', '/api/v1'])
      expect(previewPath(7, 1, `${prefix}/messages/7/embeds/1/image?v=0123456789abcdef`)).toBe(
        '/messages/7/embeds/1/image?v=0123456789abcdef'
      )
    for (const raw of [
      'https://tracker.example/p.png?c=42',
      'http://192.168.0.1/cgi-bin/x',
      '//tracker.example/api/messages/7/embeds/1/image?v=00',
      '/api/messages/8/embeds/1/image?v=00',
      '/api/messages/7/embeds/2/image?v=00',
      '/api/messages/7/embeds/1/image?v=00&x=https://e.com',
      '/api/media/abc',
      '/api/v2/messages/7/embeds/1/image?v=00',
      '/api/v1/v1/messages/7/embeds/1/image?v=00',
    ])
      expect(previewPath(7, 1, raw)).toBe(null)
    expect(previewPath(7, 1, null)).toBe(null)
  })

  const initial = useStore.getInitialState()
  const saved = { ...initial }
  const base = api.base
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  beforeEach(() => {
    Object.assign(initial, {
      me: me('alice'),
      settings: { ...saved.settings, asset_previews: true },
    })
    api.setToken(null)
  })
  afterEach(() => {
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor)
    else Reflect.deleteProperty(globalThis, 'document')
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor)
    else Reflect.deleteProperty(globalThis, 'window')
    Object.assign(initial, saved)
    api.setBase(base)
    api.setToken(null)
    resetSessionCaches()
  })

  const embed = (image_url: string | null) => ({
    ord: 0,
    url: 'https://page.example/',
    site_name: null,
    title: 'Page',
    description: null,
    image_url,
    banner_removed: false,
    color: null,
    media_kind: null,
  })
  const render = (image_url: string | null) =>
    renderToStaticMarkup(
      <MarkdownMessage
        message={msg(5, { content: 'see https://page.example/', embeds: [embed(image_url)] })}
      />
    )

  test('the card loads the instance route without a referrer', () => {
    const html = render('/api/messages/5/embeds/0/image?v=0123456789abcdef')
    expect(html).toContain('/messages/5/embeds/0/image?v=0123456789abcdef')
    expect(html).toContain('referrerPolicy="no-referrer"')
  })

  test('a remote image address is never loaded', () => {
    const html = render('https://tracker.example/p.png')
    expect(html).toContain('Page')
    expect(html.includes('tracker.example')).toBe(false)
    expect(html.includes('<img')).toBe(false)
  })

  test('a lone GIF link shows only the GIF, with its badge', () => {
    const url = 'https://media.example/cat.gif'
    const gif = {
      ...embed('/api/messages/5/embeds/0/image?v=0123456789abcdef'),
      url,
      title: null,
      media_kind: 'gif' as const,
    }
    const alone = renderToStaticMarkup(
      <MarkdownMessage message={msg(5, { content: url, embeds: [gif] })} />
    )
    expect(alone).toContain('data-picture-link="gif"')
    expect(alone).toContain('>GIF<')
    expect(alone.includes(`>${url}<`)).toBe(false)
    const said = renderToStaticMarkup(
      <MarkdownMessage message={msg(5, { content: `look ${url}`, embeds: [gif] })} />
    )
    expect(said).toContain('look')
    expect(said).toContain('data-picture-link="gif"')
  })

  const file = (filename: string): MessageMedia => ({
    id: 'f1',
    filename,
    kind: 'server',
    hoster: null,
    expires_at: null,
    size: 10,
    mime: null,
    removed: false,
    removed_by_author: false,
    spoiler: false,
    alt: null,
    sha256: null,
  })
  const attached = (filename: string) =>
    renderToStaticMarkup(<MarkdownMessage message={msg(5, { media: file(filename) })} />)

  test("an account on the page's own API gets media and previews by address", () => {
    api.setBase('/api')
    api.setToken(Secret.of('tok'))
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { cookie: 'rchat_token=tok' },
    })
    expect(render('/api/messages/5/embeds/0/image?v=0123456789abcdef')).toContain(
      '<img src="/api/messages/5/embeds/0/image?v=0123456789abcdef"'
    )
    expect(attached('pic.png')).toContain('<img src="/api/media/f1"')
    const html = attached('report.pdf')
    expect(html).toContain('<a href="/api/media/f1" download="report.pdf"')
    expect(html.includes('<button')).toBe(false)
  })

  test('home attachments, previews and absolute Markdown uploads use the active bearer after an alias swap', async () => {
    const media = client.shown().media
    const document = { cookie: 'rchat_token=alice-token' }
    const page = Object.assign(new EventTarget(), {
      location: new URL(home.origin),
      setInterval,
      clearInterval,
    })
    Object.defineProperty(globalThis, 'window', { configurable: true, value: page })
    Object.defineProperty(globalThis, 'document', { configurable: true, value: document })
    api.setBase('/api')
    api.setToken(Secret.of('alice-token'))
    const md = (url: string) =>
      renderToStaticMarkup(<MarkdownMessage message={msg(5, { content: `![pic](${url})` })} />)
    const absolute = home.origin + '/api/v1/media/f1'
    expect(md(absolute)).toContain('<img src="' + absolute + '"')
    let mode = media.mediaModeFor(undefined)
    const stop = media.subscribe(() => {
      mode = media.mediaModeFor(undefined)
    })
    const originalFetch = globalThis.fetch
    try {
      document.cookie = 'rchat_token=bob-token'
      page.dispatchEvent(new Event('storage'))
      expect(mode).toBe('blob')
      expect(md(absolute)).not.toContain('<img')
      expect(md('/api/media/f1')).not.toContain('<img')
      expect(attached('pic.png')).not.toContain('<img')
      expect(attached('report.pdf')).toContain('title="Download report.pdf"')
      expect(render('/api/messages/5/embeds/0/image?v=0123456789abcdef')).not.toContain('<img')
      const requests: RequestInit[] = []
      globalThis.fetch = (async (_input, init) => {
        requests.push(init ?? {})
        return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]))
      }) as typeof fetch
      const file = media.acquire(absolute)
      try {
        expect((await file.url)?.startsWith('blob:')).toBe(true)
      } finally {
        file.release()
      }
      expect(new Headers(requests[0].headers).get('Authorization')).toBe('Bearer alice-token')
      expect(requests[0].credentials).toBe('omit')
      document.cookie = ''
      expect(media.mediaModeFor(undefined)).toBe('blob')
      Object.defineProperty(document, 'cookie', {
        configurable: true,
        get() {
          throw new DOMException('Blocked', 'SecurityError')
        },
      })
      expect(media.mediaModeFor(undefined)).toBe('blob')
      // Anonymous widgets still render public same-origin Markdown images directly.
      api.setToken(null)
      expect(md(absolute)).toContain('<img src="' + absolute + '"')
    } finally {
      stop()
      media.clear()
      globalThis.fetch = originalFetch
    }
  })

  test('an account on an API at another origin never loads them by address', () => {
    api.setBase('https://chat.b.com/api')
    api.setToken(Secret.of('tok'))
    const preview = render('/api/messages/5/embeds/0/image?v=0123456789abcdef')
    expect(preview).toContain('Page')
    expect(preview.includes('<img')).toBe(false)
    expect(preview.includes('/embeds/0/image')).toBe(false)
    const picture = attached('pic.png')
    expect(picture.includes('<img')).toBe(false)
    expect(picture.includes('chat.b.com')).toBe(false)
    const html = attached('report.pdf')
    expect(html).toContain('title="Download report.pdf"')
    expect(html.includes('href="https://chat.b.com')).toBe(false)
    expect(html.includes('download=')).toBe(false)
  })
})
