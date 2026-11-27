import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_LINK_PREFS,
  RISK_TEXT,
  TRUSTED_MAX,
  forgetSite,
  isTrusted,
  labelHost,
  linkPrefsKey,
  linkPrefsValue,
  linkRisks,
  needsWarning,
  outgoing,
  parseLinkPrefs,
  shownHost,
  siteOf,
  stripLink,
  stripTracking,
  trustSite,
  webLink,
} from '../link_safety'

const url = (s: string) => webLink(s)!
const site = (host: string) => siteOf(host)!

describe('link prefs', () => {
  test('they are kept per account, versioned, and bad values fall back to the defaults', () => {
    expect(linkPrefsKey('alice')).toBe('rchat_links:alice')
    expect(linkPrefsKey(null)).toBe('rchat_links:guest')
    for (const raw of [null, '', '{', '[]', '{"v":2,"warn":false}', '7'])
      expect(parseLinkPrefs(raw)).toEqual(DEFAULT_LINK_PREFS)
    const prefs = { warn: false, strip: true, trusted: [site('github.com')] }
    expect(parseLinkPrefs(linkPrefsValue(prefs))).toEqual(prefs)
    expect<{ warn: boolean; strip: boolean; trusted: readonly string[] }>(
      parseLinkPrefs(
        JSON.stringify({
          v: 1,
          warn: 'no',
          strip: 1,
          trusted: ['Example.com.', 'example.com', 3, 'a b', 'x..y', 'ok.org'],
        })
      )
    ).toEqual({ warn: true, strip: false, trusted: ['example.com', 'ok.org'] })
    const many = Array.from({ length: TRUSTED_MAX + 5 }, (_, i) => `h${i}.com`)
    expect<readonly string[]>(
      parseLinkPrefs(JSON.stringify({ v: 1, trusted: many })).trusted
    ).toHaveLength(TRUSTED_MAX)
  })

  test('trusting covers the site and its subdomains, and can be undone', () => {
    const p = trustSite(DEFAULT_LINK_PREFS, site('www.GitHub.com'))
    expect<readonly string[]>(p.trusted).toEqual(['github.com'])
    expect(trustSite(p, site('gist.github.com'))).toBe(p)
    expect(isTrusted(p, url('https://github.com/x'))).toBe(true)
    expect(isTrusted(p, url('https://gist.github.com/x'))).toBe(true)
    expect(isTrusted(p, url('https://GITHUB.com./x'))).toBe(true)
    expect(isTrusted(p, url('https://notgithub.com/x'))).toBe(false)
    expect(isTrusted(p, url('https://github.com.evil.io/x'))).toBe(false)
    expect<readonly string[]>(forgetSite(p, site('github.com')).trusted).toEqual([])
  })

  test('a site is the registrable domain, so a public suffix is never trusted as a whole', () => {
    expect<string | null>(siteOf('www.example.com')).toBe('example.com')
    expect<string | null>(siteOf('docs.example.com')).toBe('example.com')
    expect<string | null>(siteOf('www.com')).toBe('www.com')
    expect<string | null>(siteOf('www.co.uk')).toBe('www.co.uk')
    expect<string | null>(siteOf('shop.www.co.uk')).toBe('www.co.uk')
    expect<string | null>(siteOf('news.bbc.co.uk')).toBe('bbc.co.uk')
    expect<string | null>(siteOf('alice.github.io')).toBe('alice.github.io')
    expect<string | null>(siteOf('www.github.io')).toBe('www.github.io')
    for (const suffix of ['com', 'co.uk', 'github.io', 'blogspot.com', 'xn--55qx5d.cn'])
      expect<string | null>(siteOf(suffix)).toBeNull()
    expect<string | null>(siteOf('localhost')).toBeNull()
    expect<string | null>(siteOf('a_b.example.com')).toBe('example.com')
    expect<string | null>(siteOf('-x.example.com')).toBe('example.com')
    expect<string | null>(siteOf('192.168.1.20')).toBe('192.168.1.20')
    expect<string | null>(siteOf('[2001:db8::1]')).toBeNull()
    expect<string | null>(siteOf('')).toBeNull()
    const com = trustSite(DEFAULT_LINK_PREFS, site('www.com'))
    expect(isTrusted(com, url('https://www.com/'))).toBe(true)
    expect(isTrusted(com, url('https://a.www.com/'))).toBe(true)
    expect(isTrusted(com, url('https://evil.com/'))).toBe(false)
    expect(isTrusted(com, url('https://com/'))).toBe(false)
    const uk = trustSite(DEFAULT_LINK_PREFS, site('www.co.uk'))
    expect<readonly string[]>(uk.trusted).toEqual(['www.co.uk'])
    expect(isTrusted(uk, url('https://evil.co.uk/'))).toBe(false)
    const pages = trustSite(DEFAULT_LINK_PREFS, site('www.github.io'))
    expect(isTrusted(pages, url('https://evil.github.io/'))).toBe(false)
  })

  test('international names are sites in their ASCII form', () => {
    const host = url('https://www.bücher.de/a').hostname
    expect<string | null>(siteOf(host)).toBe('xn--bcher-kva.de')
    const p = trustSite(DEFAULT_LINK_PREFS, site(host))
    expect(isTrusted(p, url('https://shop.bücher.de/'))).toBe(true)
    expect(isTrusted(p, url('https://bucher.de/'))).toBe(false)
    expect<string | null>(siteOf(url('https://www.公司.cn/').hostname)).toBe('www.xn--55qx5d.cn')
    expect<string | null>(siteOf(url('https://公司.cn/').hostname)).toBeNull()
  })

  test('stored entries that are not a site themselves are dropped', () => {
    const stored = ['com', 'co.uk', 'github.io', 'docs.example.com', 'www.example.com', 'ok.org']
    expect<readonly string[]>(
      parseLinkPrefs(JSON.stringify({ v: 1, trusted: stored })).trusted
    ).toEqual(['ok.org'])
  })
})

describe('the warning', () => {
  const local = ['https://chat.example']
  test('only web links to other sites from other people ask first', () => {
    const p = DEFAULT_LINK_PREFS
    expect(needsWarning(p, 'https://evil.io/a', local, false)).toBe(true)
    expect(needsWarning(p, 'https://evil.io/a', local, true)).toBe(false)
    expect(needsWarning(p, 'https://chat.example/s/den', local, false)).toBe(false)
    expect(needsWarning(p, 'mailto:a@b.c', local, false)).toBe(false)
    expect(needsWarning(p, 'javascript:alert(1)', local, false)).toBe(false)
    expect(needsWarning(p, undefined, local, false)).toBe(false)
    expect(needsWarning({ ...p, warn: false }, 'https://evil.io', local, false)).toBe(false)
    expect(needsWarning(trustSite(p, site('evil.io')), 'https://www.evil.io', local, false)).toBe(
      false
    )
  })

  test('it names the host as people trust it', () => {
    expect(shownHost(url('https://WWW.Example.COM/a'))).toBe('example.com')
    expect(shownHost(url('https://bücher.de'))).toBe('xn--bcher-kva.de')
  })

  test('text that names another site, look-alike letters and credentials are called out', () => {
    expect(labelHost('https://trusted.com/login')).toBe('trusted.com')
    expect(labelHost('www.Trusted.com')).toBe('trusted.com')
    expect(labelHost('click here')).toBeNull()
    expect(labelHost('v1.2')).toBeNull()
    expect(linkRisks(url('https://evil.io/x'), 'https://trusted.com')).toEqual(['label'])
    expect(linkRisks(url('https://trusted.com/x'), 'trusted.com/login')).toEqual([])
    expect(linkRisks(url('https://evil.io/x'), 'click here')).toEqual([])
    expect(linkRisks(url('https://evil.io/x'), null)).toEqual([])
    expect(linkRisks(url('https://аpple.com'), null)).toEqual(['lookalike'])
    expect(linkRisks(url('https://bank.com@evil.io/'), null)).toEqual(['credentials'])
    for (const text of Object.values(RISK_TEXT)) expect(text).not.toContain('—')
  })
})

describe('tracking parameters', () => {
  test('they come off, and everything else stays as written', () => {
    expect(stripLink('https://a.com/p?utm_source=x&id=7&fbclid=y#top')).toBe(
      'https://a.com/p?id=7#top'
    )
    expect(stripLink('https://a.com/p?UTM_Medium=1&gclid=2')).toBe('https://a.com/p')
    expect(stripLink('https://a.com/p?id=7&b=%20')).toBe('https://a.com/p?id=7&b=%20')
    expect(stripLink('https://youtu.be/abc?si=xyz&t=42')).toBe('https://youtu.be/abc?t=42')
    expect(stripLink('https://www.youtube.com/watch?v=abc&si=xyz')).toBe(
      'https://www.youtube.com/watch?v=abc'
    )
    expect(stripLink('https://example.com/?si=keep')).toBe('https://example.com/?si=keep')
    expect(stripLink('https://x.com/u/status/1?s=20&t=abc')).toBe('https://x.com/u/status/1')
    expect(stripLink('not a link?utm_source=1')).toBe('not a link?utm_source=1')
  })

  test('a message keeps its words, punctuation and code', () => {
    expect(
      stripTracking('See https://a.com/x?utm_campaign=c&q=1. And `https://b.com/?fbclid=1` too')
    ).toBe('See https://a.com/x?q=1. And `https://b.com/?fbclid=1` too')
    expect(stripTracking('[docs](https://a.com/d?gclid=1)')).toBe('[docs](https://a.com/d)')
    expect(stripTracking('```\nhttps://a.com/?utm_x=1\n```')).toBe(
      '```\nhttps://a.com/?utm_x=1\n```'
    )
    expect(stripTracking('no links here')).toBe('no links here')
    expect(stripTracking('two https://a.com/?fbclid=1 https://b.com/?msclkid=2!')).toBe(
      'two https://a.com/ https://b.com/!'
    )
  })
})

test('a composer strips only when asked to', () => {
  const text = 'https://a.com/?utm_source=x'
  expect(outgoing({ strip: false }, text)).toBe(text)
  expect(outgoing({ strip: true }, text)).toBe('https://a.com/')
})

describe('links read the way the browser reads them', () => {
  const local = ['https://chat.example']
  const base = 'https://chat.example/s/den'
  test('protocol-relative and backslash links to another site ask first; relative ones stay here', () => {
    const p = DEFAULT_LINK_PREFS
    expect(needsWarning(p, '//evil.example/x', local, false, base)).toBe(true)
    expect(needsWarning(p, '/\\evil.example/x', local, false, base)).toBe(true)
    expect(needsWarning(p, '/s/other', local, false, base)).toBe(false)
    expect(webLink('//evil.example/x', base)?.href).toBe('https://evil.example/x')
  })

  test('the link text names a site in any case, with a trailing dot, or inside a sentence', () => {
    expect(labelHost('HTTPS://PayPal.com/login')).toBe('paypal.com')
    expect(labelHost('paypal.com.')).toBe('paypal.com')
    expect(labelHost('Log in at https://paypal.com now')).toBe('paypal.com')
    expect(labelHost('Visit www.paypal.com today')).toBe('paypal.com')
    expect(labelHost('Log in at paypal com')).toBeNull()
    expect(linkRisks(url('https://evil.example/'), 'Log in at https://paypal.com')).toEqual([
      'label',
    ])
  })

  test('tilde fences and indented code keep their links', () => {
    expect(stripTracking('~~~\nhttps://a.com/?utm_x=1\n~~~')).toBe(
      '~~~\nhttps://a.com/?utm_x=1\n~~~'
    )
    expect(stripTracking('text\n\n    https://a.com/?utm_x=1\nhttps://b.com/?utm_x=1')).toBe(
      'text\n\n    https://a.com/?utm_x=1\nhttps://b.com/'
    )
  })
})
