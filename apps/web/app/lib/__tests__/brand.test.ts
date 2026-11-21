import { expect, test } from 'bun:test'
import { assetUrl, brandOf } from '../brand'
import { MARK_SIZES, logoError, logoSize, markError, markRect, sizeError } from '../brand_images'

test('a brand is read with what is missing or odd left unset', () => {
  expect(brandOf(null)).toBeNull()
  expect(brandOf('RChat')).toBeNull()
  expect(brandOf({ error: 'Not found' })).toBeNull()
  expect(brandOf({ instance_name: 'Example Chat' })).toEqual({
    instance_name: 'Example Chat',
    app_name: 'Example Chat',
    short_name: 'Example Chat',
    about: '',
    links: [],
    login_note: '',
    suggestions: { mode: 'add', list: [] },
    assets: {},
  })
  const sent = brandOf({
    instance_name: 'Example Chat',
    app_name: 'Example App',
    short_name: 'Example',
    about: 'Run by us.',
    links: [
      { label: 'Help', url: 'https://help.example.com/' },
      { label: 'Bad', url: 'javascript:alert(1)' },
      { label: 'Plain', url: 'http://plain.example.com/' },
      'nope',
    ],
    login_note: 'Ask IT.',
    suggestions: {
      mode: 'replace',
      list: [{ url: 'https://a.example', label: 'A' }, { url: 'ftp://b.example' }, null],
    },
    assets: {
      logo: '/brand/logo.png?v=3f2a9c1e5b7d0a46',
      'mark-192': 'https://evil.example/brand/mark-192.png?v=1',
      'mark-32': '/brand/mark-32.png?v=abc',
      'mark-512': '/brand/logo.png?v=abc',
      banner: '/brand/banner.png?v=abc',
    },
  })
  expect(sent?.links).toEqual([{ label: 'Help', url: 'https://help.example.com/' }])
  expect(sent?.suggestions).toEqual({
    mode: 'replace',
    list: [{ url: 'https://a.example', label: 'A' }],
  })
  expect(sent?.assets).toEqual({
    logo: '/brand/logo.png?v=3f2a9c1e5b7d0a46',
    'mark-32': '/brand/mark-32.png?v=abc',
  })
  expect([sent?.app_name, sent?.short_name, sent?.about, sent?.login_note]).toEqual([
    'Example App',
    'Example',
    'Run by us.',
    'Ask IT.',
  ])
  expect(assetUrl('https://chat.example.com/', '/brand/logo.png?v=1')).toBe(
    'https://chat.example.com/brand/logo.png?v=1'
  )
})

test('a mark is a square of 512 pixels or more, made in every size the app needs', () => {
  expect(markError(512, 512)).toBeNull()
  expect(markError(2048, 2048)).toBeNull()
  expect(markError(600, 512)).toBe('Use a square image.')
  expect(markError(256, 256)).toBe('Use an image of 512 by 512 pixels or more.')
  expect(markError(0, 0)).toBe("That file can't be read as an image.")
  expect(markError(Number.NaN, 512)).toBe("That file can't be read as an image.")
  expect(MARK_SIZES.map(m => [m.kind, m.size])).toEqual([
    ['mark-32', 32],
    ['mark-180', 180],
    ['mark-192', 192],
    ['mark-512', 512],
    ['mark-maskable', 512],
  ])
  expect(markRect({ size: 192, maskable: false })).toEqual({ x: 0, y: 0, side: 192 })
  expect(markRect({ size: 512, maskable: true })).toEqual({ x: 51, y: 51, side: 410 })
})

test('a logo keeps its shape and fits the largest one', () => {
  expect(logoError(300, 100)).toBeNull()
  expect(logoError(0, 100)).toBe("That file can't be read as an image.")
  expect(logoSize(300, 100)).toEqual({ width: 300, height: 100 })
  expect(logoSize(2048, 1024)).toEqual({ width: 2048, height: 1024 })
  expect(logoSize(4096, 1024)).toEqual({ width: 2048, height: 512 })
  expect(logoSize(1000, 4096)).toEqual({ width: 250, height: 1024 })
  expect(logoSize(5000, 1)).toEqual({ width: 2048, height: 1 })
  expect(sizeError(1024 * 1024)).toBeNull()
  expect(sizeError(1024 * 1024 + 1)).toBe('The image is over 1 MiB. Use a simpler one.')
})
