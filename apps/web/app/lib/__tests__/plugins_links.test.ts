import { describe, expect, test } from 'bun:test'
import {
  OPEN_MAX,
  canon,
  changedUrls,
  hostOf,
  internalPath,
  linkVerdict,
  openTarget,
} from '../plugins/links'

describe('what ui.open may open', () => {
  test('an https link, with the host it really goes to', () => {
    expect(openTarget('https://example.com/a?b=1#c')).toEqual({
      href: 'https://example.com/a?b=1#c',
      scheme: 'https',
      site: 'example.com',
    })
    expect(openTarget('HTTPS://Example.COM')).toEqual({
      href: 'https://example.com/',
      scheme: 'https',
      site: 'example.com',
    })
    expect(openTarget('https://example.com:8443/x')?.site).toBe('example.com')
    expect(openTarget('https://xn--80ak6aa92e.com/')?.site).toBe('xn--80ak6aa92e.com')
    expect(openTarget('https://\u0430\u0440\u0440\u04cf\u0435.com/')?.site).toBe(
      'xn--80ak6aa92e.com'
    )
  })

  test('a mailto link to one address, with the mail domain as its site', () => {
    expect(openTarget('mailto:bo@example.org?subject=Hi')).toEqual({
      href: 'mailto:bo@example.org?subject=Hi',
      scheme: 'mailto',
      site: 'example.org',
    })
    expect(openTarget('mailto:Bo.B+tag@One.Example')?.site).toBe('one.example')
    expect(openTarget('mailto:bo@example.org?SUBJECT=Hi&body=See%20you')?.site).toBe('example.org')
    expect(openTarget('mailto:bo%40example.org')?.site).toBe('example.org')
    for (const bad of [
      'mailto:',
      'mailto:nobody',
      'mailto:@',
      'mailto:a@',
      'mailto:?to=a@b.example',
    ])
      expect(openTarget(bad)).toBeNull()
  })

  test('a mailto link that reaches anyone but the address shown is refused', () => {
    for (const bad of [
      'mailto:a@one.example,b@two.example',
      'mailto:a@one.example%2Cb@two.example',
      'mailto:a@one.example;b@two.example',
      'mailto:a@one.example?to=b@two.example',
      'mailto:a@one.example?cc=b@two.example',
      'mailto:a@one.example?subject=Hi&bcc=b@two.example',
      'mailto:a@one.example?CC=b@two.example',
      'mailto:a@one.example?attach=/etc/passwd',
      'mailto:a@one.example?x-header=1',
      'mailto:a@b@one.example',
      'mailto:a%20b@one.example',
      'mailto:a%0Abcc:b@two.example@one.example',
      'mailto:<a@one.example>',
      'mailto:"a"@one.example',
      'mailto:a@one.example%',
    ])
      expect(openTarget(bad)).toBeNull()
    expect(linkVerdict('mailto:a@one.example?cc=b@two.example', [], true)).toBe('text')
  })

  test('nothing else', () => {
    for (const bad of [
      'http://example.com/',
      'javascript:alert(1)',
      'data:text/html,<p>x',
      'blob:https://example.com/1',
      'file:///etc/passwd',
      'ftp://example.com/',
      'tel:+123',
      'rchat://open',
      '//example.com/x',
      '/channels/1',
      'example.com',
      '',
      'https://',
      'https:///x',
    ])
      expect(openTarget(bad)).toBeNull()
    for (const bad of [null, undefined, 7, {}, ['https://example.com']])
      expect(openTarget(bad)).toBeNull()
  })

  test('at most 2,048 characters', () => {
    const base = 'https://example.com/'
    expect(openTarget(base + 'a'.repeat(OPEN_MAX - base.length))).not.toBeNull()
    expect(openTarget(base + 'a'.repeat(OPEN_MAX - base.length + 1))).toBeNull()
    expect(OPEN_MAX).toBe(2048)
  })

  test('no spaces, control characters or sign-in parts that hide where it goes', () => {
    for (const bad of [
      ' https://example.com/',
      'https://example.com/ ',
      'ht\ntps://example.com/',
      'https://exa\tmple.com/',
      'https://example.com/a b',
      'https://example.com/\u0000',
      'https://good.example@evil.example/',
      'https://user:pass@example.com/',
      'https://example.com\\@evil.example/',
    ])
      expect(openTarget(bad)).toBeNull()
  })
})

describe('the host a link shows', () => {
  test('the real host of an https or http link, lowercase', () => {
    expect(hostOf('https://Docs.Example.com/x')).toBe('docs.example.com')
    expect(hostOf('http://example.com:8080/')).toBe('example.com')
    expect(hostOf('https://example.com.evil.example/')).toBe('example.com.evil.example')
    expect(hostOf('https://good.example@evil.example/')).toBe('evil.example')
    expect(hostOf('https://good.example\\@evil.example/')).toBe('good.example')
  })

  test('none for a link that goes to no host', () => {
    for (const u of ['mailto:a@b.example', '/channels/1', 'javascript:alert(1)', 'not a url', ''])
      expect(hostOf(u)).toBeNull()
  })
})

describe('comparing links', () => {
  test('the same place written two ways is the same link', () => {
    const same = [
      ['https://example.com', 'https://example.com/'],
      ['HTTPS://EXAMPLE.COM/a', 'https://example.com/a'],
      ['https://example.com:443/a', 'https://example.com/a'],
      ['https://example.com/a/../b', 'https://example.com/b'],
      [' https://example.com/a ', 'https://example.com/a'],
      ['/channels/1', '/channels/1'],
    ]
    for (const [a, b] of same) if (canon(a) !== canon(b)) throw new Error(`${a} ${b}`)
  })

  test('different places are different links', () => {
    const differ = [
      ['https://example.com/a', 'https://example.com/A'],
      ['https://example.com/a', 'https://example.com/a?x=1'],
      ['https://example.com/a', 'https://example.com/a#x'],
      ['https://example.com/a', 'http://example.com/a'],
      ['https://example.com/a', 'https://example.com:8443/a'],
      ['https://example.com/a', 'https://example.org/a'],
      ['https://example.com/a', 'https://example.com./a'],
      ['https://example.com/a', 'https://u@example.com/a'],
      ['/channels/1', '/channels/2'],
      ['/channels/1', 'https://example.com/channels/1'],
    ]
    for (const [a, b] of differ) if (canon(a) === canon(b)) throw new Error(`${a} ${b}`)
  })
})

describe('the link rule', () => {
  const input = ['https://example.com/a', '/channels/1', 'https://cdn.example.com/cat.png']

  test('a link that was in the input is kept, however it is written', () => {
    expect(linkVerdict('https://example.com/a', input, false)).toBe('kept')
    expect(linkVerdict('HTTPS://example.com:443/a', input, false)).toBe('kept')
    expect(linkVerdict('/channels/1', input, true)).toBe('kept')
  })

  test('a changed or added link is plain text without ui:open', () => {
    expect(linkVerdict('https://evil.example/a', input, false)).toBe('text')
    expect(linkVerdict('https://example.com/a?track=1', input, false)).toBe('text')
    expect(linkVerdict('https://example.com/b', [], false)).toBe('text')
  })

  test('with ui:open it is a marked link, if it could be opened at all', () => {
    expect(linkVerdict('https://evil.example/a', input, true)).toBe('marked')
    expect(linkVerdict('mailto:bo@example.org', input, true)).toBe('marked')
    for (const u of ['http://evil.example/', 'javascript:alert(1)', '/settings', 'evil.example'])
      expect(linkVerdict(u, input, true)).toBe('text')
  })

  test('the links of an output that were not in the input', () => {
    const output = [
      'https://example.com/a',
      'https://evil.example/x',
      'https://EXAMPLE.com/a',
      'https://evil.example/x',
      'https://cdn.example.com/dog.png',
    ]
    expect(changedUrls(input, output)).toEqual([
      'https://evil.example/x',
      'https://cdn.example.com/dog.png',
    ])
    expect(changedUrls(input, input)).toEqual([])
    expect(changedUrls([], [])).toEqual([])
  })
})

describe("a plugin's own links inside the app", () => {
  const origin = 'https://chat.example'

  test('a path on the app is internal', () => {
    expect(internalPath('/channels/1?x=1#m2', origin)).toBe('/channels/1?x=1#m2')
    expect(internalPath('https://chat.example/plugin/dice/board', origin)).toBe(
      '/plugin/dice/board'
    )
    expect(internalPath('HTTPS://CHAT.EXAMPLE/a/../b', origin)).toBe('/b')
  })

  test('anything that leaves the app is not', () => {
    for (const u of [
      'https://evil.example/channels/1',
      '//evil.example/x',
      '/..//evil.example/x',
      '/.//evil.example',
      '/a/..//evil.example',
      '/%2e%2e//evil.example/x',
      'https://chat.example/..//evil.example/x',
      '/\\evil.example/x',
      '\\\\evil.example/x',
      'https://chat.example.evil.example/',
      'https://chat.example:8443/',
      'http://chat.example/',
      'javascript:alert(1)',
      'channels/1',
      './x',
      '?x=1',
      '#m2',
      '',
      '/a b',
      '/a\nb',
    ])
      expect(internalPath(u, origin)).toBeNull()
    expect(internalPath('/x', 'not an origin')).toBeNull()
  })
})
