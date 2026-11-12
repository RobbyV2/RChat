import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownMessage } from '../../components/markdown_message'
import { Snippet, SpoilerLine } from '../../components/replies'
import { clipOf } from '../forward'
import { inboxSnippet } from '../inbox'
import { hiddenOnScreen, hiddenWords } from '../masked_reveal'
import { alertBody } from '../notices'
import { snippet } from '../palette_results'
import { previewText } from '../invite'
import { plainLine, snippetParts } from '../replies'
import { CLOSE, OPEN, replaceSpoilers, spoilerParts } from '../spoilers'
import { resetSessionCaches, useStore } from '../store'
import { me, msg, user } from './fixtures'

// A spoiler crossed by other markers (bold, italics, strike, code, links, mentions, blocks) on
// its opening or closing side. `shown` is what a reader sees before revealing anything.
interface Crossed {
  kind: string
  text: string
  shown: string
}

const CROSSED: Crossed[] = [
  { kind: 'bold ends inside', text: '**a ||secret** b|| c', shown: 'a  c' },
  { kind: 'bold starts inside', text: 'a ||secret **b|| c** d', shown: 'a  c d' },
  { kind: 'bold around the opening only', text: '**||secret**|| c', shown: ' c' },
  { kind: 'italics end inside', text: '*a ||secret* b|| c', shown: 'a  c' },
  { kind: 'italics start inside', text: 'a ||secret *b|| c* d', shown: 'a  c d' },
  { kind: 'underscore italics end inside', text: '_a ||secret_ b|| c', shown: 'a  c' },
  { kind: 'strike ends inside', text: '~~a ||secret~~ b|| c', shown: 'a  c' },
  { kind: 'strike starts inside', text: 'a ||secret ~~b|| c~~ d', shown: 'a  c d' },
  { kind: 'bold italics end inside', text: '***a ||secret*** b|| c', shown: 'a  c' },
  {
    kind: 'a link ends inside',
    text: '[a ||secret](https://x.example/) b|| c',
    shown: 'a  c',
  },
  {
    kind: 'a link starts inside',
    text: 'a ||secret [b|| c](https://x.example/) d',
    shown: 'a  c d',
  },
  {
    kind: 'the spoiler ends in a link target',
    text: 'a ||secret [b](https://x.example/||c) d',
    shown: 'a  d',
  },
  {
    kind: 'the spoiler starts in a link target',
    text: 'a [b](https://x.example/||c) secret|| d',
    shown: 'a  d',
  },
  { kind: 'code inside a crossed spoiler', text: '**a ||secret `x`** b|| c', shown: 'a  c' },
  {
    kind: 'two spoilers, each crossed',
    text: '||secret ~~a|| b~~ **c ||secret** d|| e',
    shown: ' b c  e',
  },
  { kind: 'a list starts inside', text: 'a ||secret\n- hidden|| c', shown: 'a\nc' },
  { kind: 'a heading ends inside', text: '# a ||secret\nhidden|| c', shown: 'a\nc' },
]

// Text and attributes that come from another place in the message (a reference's definition, a
// footnote) or that the page shows outside the text (a title, a target). `shown` when it is
// short enough to spell out.
const ELSEWHERE: { kind: string; text: string; shown?: string }[] = [
  {
    kind: 'a reference link, the spoiler in its title',
    text: '[a][r] b\n\n[r]: https://x.example/ "||secret||"',
    shown: ' b',
  },
  {
    kind: 'a reference link, the spoiler in its target',
    text: '[a][r] b\n\n[r]: https://x.example/||secret||',
    shown: ' b',
  },
  {
    kind: 'a reference image, the spoiler in its title',
    text: '![a][r] b\n\n[r]: https://x.example/ "||secret||"',
    shown: ' b',
  },
  {
    kind: 'a reference image, the spoiler in its target',
    text: '![a][r] b\n\n[r]: https://x.example/||secret||',
    shown: ' b',
  },
  {
    kind: 'a collapsed reference',
    text: '[r][] b\n\n[r]: https://x.example/ "||secret||"',
    shown: ' b',
  },
  {
    kind: 'a shortcut reference',
    text: '[r] b\n\n[r]: https://x.example/ "||secret||"',
    shown: ' b',
  },
  {
    kind: 'the definition comes first',
    text: '[r]: https://x.example/ "||secret||"\n\n[a][r] b',
    shown: ' b',
  },
  {
    kind: 'two references to one definition',
    text: '[a][r] and [c][r]\n\n[r]: https://x.example/ "||secret||"',
    shown: ' and ',
  },
  {
    kind: 'a spoiler that opens in a title and closes in the text after it',
    text: '[x][r] y\n\n[r]: https://x.example/ "||secret"\nveiled|| c',
    shown: ' y\nc',
  },
  {
    kind: 'the label is the spoiler',
    text: '[a][||secret||] b\n\n[||secret||]: https://x.example/',
    shown: ' b',
  },
  {
    kind: 'an inline link title',
    text: '[a](https://x.example/ "||secret||") b',
    shown: ' b',
  },
  {
    kind: 'an inline image title',
    text: '![a](https://x.example/ "||secret||") b',
    shown: ' b',
  },
  {
    kind: 'a definition inside a spoiler, in a list item',
    text: '- ||one\n- [r]: https://veiled.example/ "veiled title"\n- two||\n\n[see][r]',
  },
  {
    kind: 'a definition inside a spoiler, after a heading',
    text: '# ||Heading\n[r]: https://veiled.example/ "veiled title"\nend||\n\n[see][r]',
  },
  {
    kind: 'a definition inside a spoiler, a shortcut reference',
    text: '- ||one\n- [r]: https://veiled.example/ "veiled title"\n- two||\n\n[r] b',
  },
  {
    kind: 'a definition inside a spoiler, an image reference',
    text: '- ||one\n- [r]: https://veiled.example/i.png "veiled title"\n- two||\n\n![pic][r] b',
  },
  { kind: 'footnote text', text: 'a[^1] b\n\n[^1]: ||secret||' },
  { kind: 'a footnote label', text: 'a[^||secret||] b\n\n[^||secret||]: note' },
  {
    kind: 'a footnote, label and text',
    text: 'a[^||secret||] b\n\n[^||secret||]: note ||secret||',
  },
  { kind: 'a footnote reference inside', text: 'a ||secret[^n] veiled|| b\n\n[^n]: note' },
  { kind: 'an autolink', text: 'a <https://x.example/||secret||> b' },
  { kind: 'a bare address', text: 'a https://x.example/||secret|| b' },
  { kind: 'an address inside', text: 'a ||https://x.example/secret|| b' },
  { kind: 'raw HTML with an attribute', text: 'a <b title="||secret||">x</b> b' },
  { kind: 'a raw HTML block', text: '<div title="||secret||">x</div>' },
  { kind: 'a timestamp inside', text: 'a ||secret <t:1700000000:R>|| b', shown: 'a  b' },
  { kind: 'an emoji shortcode', text: 'a ||:secret:|| :se||cret:|| b' },
]

// Code is never a spoiler marker, on either side: the reader finds no spoiler here.
const CODE = ['`a ||secret` b|| c', 'a ||secret `b|| c` d']

// The text of static markup that a reader sees: tags dropped, and hidden spoilers with all they
// hold.
const seen = (html: string) => {
  let out = ''
  let hiding = 0
  const open: boolean[] = []
  for (const part of html.split(/(<[^>]+>)/)) {
    if (!part.startsWith('<')) {
      if (!hiding) out += part
    } else if (part.startsWith('</')) {
      if (open.pop()) hiding -= 1
    } else if (!part.endsWith('/>')) {
      const hides = part.includes('data-spoiler="hidden"')
      open.push(hides)
      if (hides) hiding += 1
    }
  }
  return out
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/^\n|\n$/g, '')
}

const hiddenCount = (html: string) => html.split('data-spoiler="hidden"').length - 1

// The tags of static markup outside hidden spoilers, with their attributes (what a pointer, the
// status bar or a screen reader can read without revealing anything).
const visibleTags = (html: string) => {
  let out = ''
  let hiding = 0
  const open: boolean[] = []
  for (const part of html.split(/(<[^>]+>)/)) {
    if (!part.startsWith('<')) continue
    if (part.startsWith('</')) {
      if (open.pop()) hiding -= 1
      continue
    }
    if (!hiding) out += part
    if (part.endsWith('/>')) continue
    const hides = part.includes('data-spoiler="hidden"')
    open.push(hides)
    if (hides) hiding += 1
  }
  return out
}

// Hidden spoilers that hold nothing: a control to tab to with nothing behind it.
const emptyCovers = (html: string) => {
  let empty = 0
  const open: (string | null)[] = []
  for (const part of html.split(/(<[^>]+>)/)) {
    if (!part.startsWith('<')) {
      for (let i = 0; i < open.length; i += 1) if (open[i] !== null) open[i] += part
    } else if (part.startsWith('</')) {
      const held = open.pop()
      if (held !== null && held !== undefined && held.trim() === '') empty += 1
    } else if (!part.endsWith('/>')) {
      open.push(part.includes('data-spoiler="hidden"') ? '' : null)
    }
  }
  return empty
}
const MARKS = new RegExp(`[${OPEN[1]}${CLOSE[1]}]`)

const initial = useStore.getInitialState()
const saved = { ...initial }

describe('the message view keeps a crossed spoiler hidden', () => {
  beforeEach(() => {
    Object.assign(initial, { me: me('alice') })
  })

  afterEach(() => {
    Object.assign(initial, saved)
    resetSessionCaches()
  })

  const render = (content: string, over = {}) =>
    renderToStaticMarkup(<MarkdownMessage message={msg(1, { content, ...over })} />)

  test('every inline kind, on both sides of the spoiler', () => {
    for (const { kind, text, shown } of CROSSED) {
      const html = render(text)
      expect([kind, seen(html)]).toEqual([kind, shown])
      expect([kind, hiddenCount(html) > 0, html.includes('||'), MARKS.test(html)]).toEqual([
        kind,
        true,
        false,
        false,
      ])
    }
  })

  test('formatting still applies around and inside the hidden part', () => {
    const html = render('**a ||secret** b|| c')
    expect(html).toContain('<strong>a <span data-spoiler="hidden"')
    expect(html).toContain('<span class="invisible" aria-hidden="true">secret</span>')
    const inner = render('a ||secret **b|| c** d')
    expect(inner).toContain('<span class="invisible" aria-hidden="true">b</span>')
    expect(inner).toContain(' c</strong> d')
  })

  test('code is no marker on either side, as the reader says', () => {
    for (const text of CODE) {
      expect(spoilerParts(text).some(p => p.spoiler)).toBe(false)
      const html = render(text)
      expect([text, hiddenCount(html), seen(html).includes('secret')]).toEqual([text, 0, true])
      expect(MARKS.test(html)).toBe(false)
    }
  })

  test('a mention cut by a marker is hidden with the spoiler and pings nobody', () => {
    const bob = user('bob')
    Object.assign(initial, {
      token: 'tok',
      me: me('carol'),
      dms: [{ id: 9, other: bob, is_self: false }],
    })
    const dm = (content: string) =>
      render(content, { channel_id: null, dm_id: 9, author: user('carol') })
    const whole = dm('@bob ||secret @bob|| @bob')
    expect(seen(whole)).toBe('@bob  @bob')
    expect(whole.split('data-mention="bob"').length - 1).toBe(3)
    const start = dm('||secret @bo||b c')
    expect(seen(start)).toBe('b c')
    expect(start.includes('data-mention')).toBe(false)
    const end = dm('@bo||b secret|| c')
    expect(seen(end)).toBe('@bo c')
    expect(end.includes('data-mention')).toBe(false)
  })

  test('tables, images and raw HTML hide what the spoiler holds', () => {
    const table = render('| a | b |\n|---|---|\n| x ||secret|| y | z |')
    expect(seen(table).includes('secret')).toBe(false)
    expect(seen(table)).toContain('x')
    expect(MARKS.test(table)).toBe(false)
    const g = globalThis as { window?: unknown }
    const realWindow = g.window
    g.window = { location: { href: 'https://chat.example/', origin: 'https://chat.example' } }
    try {
      const image = render('![||secret||](https://x.example/i.png) t')
      expect(seen(image)).toBe(' t')
      expect(hiddenCount(image)).toBe(1)
    } finally {
      g.window = realWindow
    }
    const raw = render('<div>||secret||</div>')
    expect(seen(raw).includes('secret')).toBe(false)
    expect(hiddenCount(raw)).toBe(1)
  })

  test('text and attributes that come from elsewhere in the message stay hidden too', () => {
    const g = globalThis as { window?: unknown }
    const realWindow = g.window
    g.window = { location: { href: 'https://chat.example/', origin: 'https://chat.example' } }
    try {
      for (const { kind, text, shown } of ELSEWHERE) {
        const html = render(text)
        const read = seen(html)
        expect([kind, /secret|veiled/.test(read)]).toEqual([kind, false])
        if (shown !== undefined) expect([kind, read]).toEqual([kind, shown])
        expect([
          kind,
          /secret|veiled/i.test(visibleTags(html).replace(/data-spoiler="hidden"/g, '')),
        ]).toEqual([kind, false])
        expect([kind, emptyCovers(html), MARKS.test(html)]).toEqual([kind, 0, false])
        expect([kind, hiddenCount(html) > 0]).toEqual([kind, true])
      }
    } finally {
      g.window = realWindow
    }
  })

  test('a reference is hidden whole and reveals with the others to its definition', () => {
    const html = render('[a][r] and [c][r] d\n\n[r]: https://x.example/ "||secret||"')
    expect(hiddenCount(html)).toBe(2)
    expect(html.split('data-spoiler="hidden"')[0].includes('title=')).toBe(false)
    expect(html).toContain('<span class="invisible" aria-hidden="true"><a title="secret"')
    // Once revealed, a title reads without its markers, inline and by reference.
    for (const [text, title] of [
      ['[a](https://x.example/ "||secret||") b', 'title="secret"'],
      ['[a](https://x.example/ "see ||secret|| here") b', 'title="see secret here"'],
      ['[a][r] b\n\n[r]: https://x.example/ "the ||secret||"', 'title="the secret"'],
      ['[x][r] y\n\n[r]: https://x.example/ "||secret"\nveiled|| c', 'title="secret"'],
    ]) {
      const g = globalThis as { window?: unknown }
      const realWindow = g.window
      g.window = { location: { href: 'https://chat.example/', origin: 'https://chat.example' } }
      try {
        const shown = render(text)
        expect([text, shown.includes(title), /title="[^"]*\|\|/.test(shown)]).toEqual([
          text,
          true,
          false,
        ])
      } finally {
        g.window = realWindow
      }
    }
    const plain = render('[a][r] b\n\n[r]: https://x.example/ "t"')
    expect([hiddenCount(plain), seen(plain)]).toEqual([0, 'a b'])
    expect(plain).toContain('title="t"')
  })

  test('a footnote keeps its text readable and its hidden label out of the page', () => {
    const html = render('a[^||secret||] b\n\n[^||secret||]: the note')
    expect(seen(html)).toContain('the note')
    expect(/secret/i.test(visibleTags(html))).toBe(false)
    expect(html.includes('user-content-fn-')).toBe(true)
    const both = render('a[^||secret||] b\n\n[^||secret||]: note ||secret||')
    expect(seen(both)).toContain('note')
    expect(seen(both).includes('secret')).toBe(false)
  })

  test('webhook embed text follows the same rule', () => {
    const webhook = { id: 3, embeds: [{ description: '**a ||secret** b|| c' }] }
    const html = render('', { webhook })
    expect(seen(html)).toContain('a  c')
    expect(seen(html).includes('secret')).toBe(false)
  })
})

describe('everything that shortens a message keeps a crossed spoiler hidden', () => {
  afterEach(resetSessionCaches)

  const all = [...CROSSED, ...ELSEWHERE].map(c => c.text)
  const leaks = (text: string) => /secret|hidden|veiled/.test(text)
  const shownOf = (parts: { text: string; spoiler: boolean }[]) =>
    parts
      .filter(p => !p.spoiler)
      .map(p => p.text)
      .join('')

  test('the reader (search results, the palette index)', () => {
    for (const text of all) {
      expect([text, leaks(shownOf(spoilerParts(text)))]).toEqual([text, false])
      expect([text, leaks(replaceSpoilers(text, () => '█'))]).toEqual([text, false])
      const html = renderToStaticMarkup(<SpoilerLine parts={spoilerParts(text)} />)
      expect([
        text,
        leaks(seen(html.replaceAll('data-reply-spoiler', 'data-spoiler="hidden"'))),
      ]).toEqual([text, false])
    }
  })

  test('reply, forward and link card snippets', () => {
    for (const text of all) {
      const line = plainLine(text)
      expect([text, line, leaks(shownOf(snippetParts(line)))]).toEqual([text, line, false])
      const clip = clipOf(msg(4, { content: text, author: user('bob') }))
      expect([text, leaks(shownOf(snippetParts(clip.snippet)))]).toEqual([text, false])
      const html = renderToStaticMarkup(<Snippet quote={{ content: line, has_media: false }} />)
      expect([text, html.includes('||')]).toEqual([text, false])
    }
  })

  test('reply snippets read like the server (reply_snippet in messages.rs)', () => {
    for (const [text, want] of [
      ['**a ||secret** b|| c', 'a ||secret b|| c'],
      ['a ||secret **b|| c** d', 'a ||secret b|| c d'],
      ['_a ||secret_ b|| c', 'a ||secret b|| c'],
      ['~~a ||secret~~ b|| c', 'a ||secret b|| c'],
      ['[a ||secret](https://x.example/) b|| c', 'a ||secret b|| c'],
      ['a ||secret [b|| c](https://x.example/) d', 'a ||secret b|| c d'],
      ['a ||secret [b](https://x.example/||c) d', 'a ||secret b|| d'],
      ['a [b](https://x.example/||c) secret|| d', 'a b|| secret|| d'],
      ['a ![b](https://x.example/||c) secret|| d', 'a !b|| secret|| d'],
      ['# a ||secret\nhidden|| c', 'a ||secret||'],
      ['[a][r] b\n\n[r]: https://x.example/ "||secret||"', '[a][r] b'],
      ['[r]: https://x.example/ "||secret||"\n\n[a][r] b', '[r]: https://x.example/ "||secret||"'],
      ['[r]: https://x.example/||secret||\n[a][r] b', '[r]: https://x.example/||secret||'],
      ['[a][||secret||] b\n\n[||secret||]: https://x.example/', '[a][||secret||] b'],
      ['[a](https://x.example/ "||secret||") b', 'a b'],
      ['a[^||secret||] b\n\n[^||secret||]: note', 'a[^||secret||] b'],
      ['a <https://x.example/||secret||> b', 'a https://x.example/||secret|| b'],
      ['* * *\n||secret||', '||secret||'],
      ['> ```\n> ||x||\n> ```\n||secret||', '\\|\\|x\\|\\|'],
    ])
      expect([text, plainLine(text)]).toEqual([text, want])
  })

  test('toasts, notifications, the inbox and invite previews', () => {
    for (const text of all) {
      expect([text, leaks(alertBody(text, false))]).toEqual([text, false])
      expect([text, leaks(previewText(text))]).toEqual([text, false])
      const row = inboxSnippet({ content: text, media: null, mediaSpoiler: false }, false, t => t)
      expect([text, leaks(row)]).toEqual([text, false])
    }
  })

  test('thread titles and message rows in the palette', () => {
    for (const text of all) expect([text, leaks(snippet(text, t => t))]).toEqual([text, false])
  })

  test('an excerpt cut inside a crossed spoiler', () => {
    for (const text of [
      '**a ||secret and more** to',
      '_a ||secret_ and then',
      'a [b](u||c) secret and',
    ])
      expect([text, leaks(alertBody(text, false))]).toEqual([text, false])
  })
})

describe('masked words under a hidden spoiler', () => {
  // Stand-ins for masked words: under a hidden spoiler, in the palette, or in plain view.
  const word = (under: 'spoiler' | 'palette' | null) => ({
    closest: (q: string) =>
      (under === 'spoiler' && q === '[data-spoiler="hidden"]') ||
      (under === 'palette' && q === '[data-palette]')
        ? {}
        : null,
  })

  test('"Show masked text" leaves them alone until the spoiler is revealed', () => {
    const list = [word(null), word('spoiler'), word(null), word('palette')]
    const found = (q: string) => (q === '[data-masked-word]' ? list : [])
    const row = { querySelectorAll: found } as unknown as Element
    expect(hiddenWords(row)).toEqual([list[0], list[2], list[3]] as unknown as Element[])
    const only = { querySelectorAll: () => [list[1]] } as unknown as Element
    expect(hiddenWords(only)).toEqual([])
    const g = globalThis as { document?: unknown }
    const had = Object.hasOwn(g, 'document')
    const real = g.document
    g.document = { querySelectorAll: found }
    try {
      expect(hiddenOnScreen()).toEqual([list[0], list[2]] as unknown as Element[])
    } finally {
      if (had) g.document = real
      else delete g.document
    }
  })
})
