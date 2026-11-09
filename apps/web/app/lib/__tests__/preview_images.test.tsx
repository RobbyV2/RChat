import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { previewPath } from '../media_src'
import { resetSessionCaches, useStore } from '../store'
import { MarkdownMessage } from '../../components/markdown_message'
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
  beforeEach(() => {
    Object.assign(initial, {
      me: me('alice'),
      settings: { ...saved.settings, asset_previews: true },
    })
  })
  afterEach(() => {
    Object.assign(initial, saved)
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
})
