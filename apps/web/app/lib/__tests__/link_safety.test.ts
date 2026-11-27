import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_LINK_PREFS,
  RISK_TEXT,
  TRUSTED_MAX,
  forgetHost,
  isTrusted,
  labelHost,
  linkPrefsKey,
  linkPrefsValue,
  linkRisks,
  needsWarning,
  outgoing,
  parseLinkPrefs,
  shownHost,
  stripLink,
  stripTracking,
  trustHost,
  trustable,
  webLink,
} from '../link_safety'

const url = (s: string) => webLink(s)!

describe('link prefs', () => {
  test('they are kept per account, versioned, and bad values fall back to the defaults', () => {
    expect(linkPrefsKey('alice')).toBe('rchat_links:alice')
    expect(linkPrefsKey(null)).toBe('rchat_links:guest')
    for (const raw of [null, '', '{', '[]', '{"v":2,"warn":false}', '7'])
      expect(parseLinkPrefs(raw)).toEqual(DEFAULT_LINK_PREFS)
    const prefs = { warn: false, strip: true, trusted: ['github.com'] }
    expect(parseLinkPrefs(linkPrefsValue(prefs))).toEqual(prefs)
    expect(
      parseLinkPrefs(
        JSON.stringify({
          v: 1,
          warn: 'no',
          strip: 1,
          trusted: ['WWW.Example.com.', 'example.com', 3, 'a b', 'x..y', 'ok.org'],
        })
      )
    ).toEqual({ warn: true, strip: false, trusted: ['example.com', 'ok.org'] })
    const many = Array.from({ length: TRUSTED_MAX + 5 }, (_, i) => `h${i}.com`)
    expect(parseLinkPrefs(JSON.stringify({ v: 1, trusted: many })).trusted).toHaveLength(
      TRUSTED_MAX
    )
  })

  test('trusting covers the host and its subdomains, and can be undone', () => {
    const p = trustHost(DEFAULT_LINK_PREFS, 'www.GitHub.com')
    expect(p.trusted).toEqual(['github.com'])
    expect(trustHost(p, 'github.com')).toBe(p)
    expect(isTrusted(p, url('https://github.com/x'))).toBe(true)
    expect(isTrusted(p, url('https://gist.github.com/x'))).toBe(true)
    expect(isTrusted(p, url('https://notgithub.com/x'))).toBe(false)
    expect(isTrusted(p, url('https://github.com.evil.io/x'))).toBe(false)
    expect(forgetHost(p, 'github.com').trusted).toEqual([])
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
    expect(needsWarning(trustHost(p, 'evil.io'), 'https://www.evil.io', local, false)).toBe(false)
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

  test('only plain host names can be trusted', () => {
    expect(trustable('github.com')).toBe(true)
    expect(trustable('[2001:db8::1]')).toBe(false)
    expect(trustHost(DEFAULT_LINK_PREFS, '[2001:db8::1]').trusted).toEqual([])
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
