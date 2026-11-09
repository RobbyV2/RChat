import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { api } from '../instances'
import { previewPath } from '../media_src'
import { resetSessionCaches, useStore } from '../store'
import { MarkdownMessage } from '../../components/markdown_message'
import type { MessageMedia } from '../types'
import { me, msg } from './fixtures'

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
  beforeEach(() => {
    Object.assign(initial, {
      me: me('alice'),
      settings: { ...saved.settings, asset_previews: true },
    })
    api.setToken(null)
  })
  afterEach(() => {
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
  })
  const attached = (filename: string) =>
    renderToStaticMarkup(<MarkdownMessage message={msg(5, { media: file(filename) })} />)

  test("an account on the page's own API gets media and previews by address", () => {
    api.setBase('/api')
    api.setToken('tok')
    expect(render('/api/messages/5/embeds/0/image?v=0123456789abcdef')).toContain(
      '<img src="/api/messages/5/embeds/0/image?v=0123456789abcdef"'
    )
    expect(attached('pic.png')).toContain('<img src="/api/media/f1"')
    const html = attached('report.pdf')
    expect(html).toContain('<a href="/api/media/f1" download="report.pdf"')
    expect(html.includes('<button')).toBe(false)
  })

  test('an account on an API at another origin never loads them by address', () => {
    api.setBase('https://chat.b.com/api')
    api.setToken('tok')
    const preview = render('/api/messages/5/embeds/0/image?v=0123456789abcdef')
    expect(preview).toContain('Page')
    expect(preview.includes('<img')).toBe(false)
    expect(preview.includes('/embeds/0/image')).toBe(false)
    const picture = attached('pic.png')
    expect(picture.includes('<img')).toBe(false)
    expect(picture.includes('chat.b.com')).toBe(false)
    const html = attached('report.pdf')
    expect(html).toContain('<button title="Download report.pdf"')
    expect(html.includes('href="https://chat.b.com')).toBe(false)
    expect(html.includes('download=')).toBe(false)
  })
})
