import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  markSpoilers,
  parseSpoilers,
  replaceSpoilers,
  spoilerParts,
  spoilersKey,
  spoilersValue,
} from '../spoilers'
import { postedLinks, previewUrls, spoileredUrls } from '../embed_links'
import { findInvites, previewText, visibleLinks } from '../invite'
import { alertBody } from '../notices'
import { plainLine, snippetParts } from '../replies'
import { clipOf } from '../forward'
import { resetMasking, setMasking } from '../profanity'
import { resetSessionCaches, useStore } from '../store'
import { MarkdownMessage } from '../../components/markdown_message'
import { Snippet, SpoilerLine } from '../../components/replies'
import { me, msg, user } from './fixtures'
import fixture from './fixtures/spoilers.json'

interface PartsCase {
  text: string
  cut?: boolean
  parts: [string, boolean][]
}

interface LinksCase {
  text: string
  urls: string[]
}

const PARTS = fixture.spoilers as PartsCase[]
const LINKS = fixture.links as LinksCase[]

describe('the shared reader (fixture also read by apps/server/src/spoilers.rs)', () => {
  test('splits every case like the server', () => {
    expect(PARTS.length > 20).toBe(true)
    for (const c of PARTS)
      expect([c.text, spoilerParts(c.text, c.cut).map(p => [p.text, p.spoiler])]).toEqual([
        c.text,
        c.parts,
      ])
  })

  test('links in spoilers get no preview, like extract_urls', () => {
    expect(LINKS.length > 10).toBe(true)
    for (const c of LINKS) expect([c.text, previewUrls(c.text)]).toEqual([c.text, c.urls])
  })

  test('spoilered links are known to the card, and visible copies win', () => {
    expect(spoileredUrls('a ||https://x.example/s|| https://y.example/')).toEqual([
      'https://x.example/s',
    ])
    expect(spoileredUrls('||https://x.example/|| https://x.example/')).toEqual([])
    expect(spoileredUrls('`||https://x.example/||`')).toEqual([])
    expect(postedLinks('see https://x.example/a, ok')).toEqual(['https://x.example/a'])
  })

  test('the renderer markers wrap only what the reader paired', () => {
    expect(markSpoilers('a ||b|| `||c||` \\||d||')).toBe('a <\uE000|b<\uE001| `||c||` \\||d||')
    expect(markSpoilers('no pairs ||')).toBe('no pairs ||')
    expect(replaceSpoilers('x ||y|| z', () => '#')).toBe('x # z')
  })

  test('the setting is parsed defensively', () => {
    expect(spoilersKey('alice')).toBe('rchat_spoilers:alice')
    expect(spoilersKey(null)).toBe('rchat_spoilers:guest')
    for (const raw of [null, '', 'x', '[]', '{"v":2,"show":"always"}', '{"v":1,"show":"no"}'])
      expect(parseSpoilers(raw)).toBe('click')
    expect(parseSpoilers(spoilersValue('always'))).toBe('always')
  })
})

// Server rendering reads the store's initial state, so the test state goes there.
const initial = useStore.getInitialState()
const saved = { ...initial }
const setInitial = (part: Partial<typeof initial>) => Object.assign(initial, part)

describe('the message view', () => {
  beforeEach(() => {
    setInitial({
      me: me('alice'),
      settings: { ...saved.settings, asset_previews: true },
    })
  })

  afterEach(() => {
    resetMasking()
    Object.assign(initial, saved)
    resetSessionCaches()
  })

  const render = (content: string, over = {}) =>
    renderToStaticMarkup(<MarkdownMessage message={msg(1, { content, ...over })} />)
  const hidden = (html: string) => html.split('data-spoiler="hidden"').length - 1

  test('a spoiler is a button until revealed, one per spoiler', () => {
    const html = render('a ||one|| b ||two||')
    expect(hidden(html)).toBe(2)
    expect(html).toContain('role="button"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('aria-label="Spoiler, press to reveal"')
    expect(html.includes('||')).toBe(false)
  })

  test('works inside and around markdown, never in code', () => {
    expect(hidden(render('**||bold||**'))).toBe(1)
    expect(render('||**bold** and _it_||')).toContain('<strong>bold</strong>')
    expect(hidden(render('- ||in a list||\n- plain'))).toBe(1)
    expect(hidden(render('> ||quoted\n> on two lines||'))).toBe(1)
    expect(hidden(render('||line one\nline two||'))).toBe(1)
    const code = render('`||x||` and\n```\n||y||\n```')
    expect(hidden(code)).toBe(0)
    expect(code).toContain('>||x||</code>')
    expect(code).toContain('||y||')
    const inner = render('||see `a||b` here||')
    expect(hidden(inner)).toBe(1)
    expect(inner).toContain('a||b')
  })

  test('escaped, empty, unmatched and split markers stay text', () => {
    expect(render('\\||not||')).toContain('||not||')
    expect(hidden(render('\\||not||'))).toBe(0)
    expect(hidden(render('||||'))).toBe(0)
    expect(hidden(render('one || only'))).toBe(0)
    expect(hidden(render('||para\n\nbreak||'))).toBe(0)
    const split = render('||a **b|| c**')
    expect(hidden(split)).toBe(0)
    expect(split).toContain('||a <strong>b|| c</strong>')
  })

  test('a link inside a spoiler has no preview, a Spoiler card instead', () => {
    const embed = (url: string, title: string) => ({
      ord: 0,
      url,
      site_name: null,
      title,
      description: null,
      image_url: null,
      banner_removed: false,
    })
    const html = render('look ||https://secret.example/x|| now', {
      embeds: [embed('https://secret.example/x', 'Leaked title')],
    })
    expect(html.includes('Leaked title')).toBe(false)
    expect(html).toContain('data-spoiler-link="hidden"')
    const shown = render('look https://open.example/', {
      embeds: [embed('https://open.example/', 'Open title')],
    })
    expect(shown).toContain('Open title')
    expect(shown.includes('data-spoiler-link')).toBe(false)
  })

  test('Show spoilers: Always opens them, except in streamer mode', () => {
    setInitial({ showSpoilers: 'always' })
    const html = render('a ||b|| ||https://s.example/||')
    expect(hidden(html)).toBe(0)
    expect(html).toContain('data-spoiler="shown"')
    expect(html).toContain('data-spoiler-link="shown"')
    setInitial({ streamer: true })
    expect(hidden(render('a ||b||'))).toBe(1)
  })

  test('spoiler attachments stay covered until revealed', () => {
    const media = {
      id: 'm1',
      filename: 'notes.zip',
      removed: false,
      removed_by_author: false,
      spoiler: true,
      kind: 'server' as const,
      hoster: null,
      expires_at: null,
      size: 1,
      mime: null,
      sha256: null,
    }
    const html = render('', { media })
    expect(html).toContain('aria-label="Spoiler attachment, press to reveal"')
    expect(html.includes('notes.zip')).toBe(false)
    setInitial({ showSpoilers: 'always' })
    expect(render('', { media })).toContain('notes.zip')
  })

  test('the profanity filter masks inside spoilers too', async () => {
    await setMasking(true, () => Promise.resolve((t: string) => t.replace(/shit/g, '****')))
    setInitial({ profanityReady: true, showSpoilers: 'always' })
    const html = render('||oh shit||')
    expect(html).toContain('oh ****')
    expect(html.includes('shit')).toBe(false)
  })
})

describe('previews keep spoilers hidden', () => {
  afterEach(resetSessionCaches)

  test('reply and link card snippets carry balanced, escaped spoilers', () => {
    expect(plainLine('a ||secret|| b')).toBe('a ||secret|| b')
    expect(plainLine('||two\nlines|| x')).toBe('||two||')
    expect(plainLine('a ||**bold** `x||y`|| b')).toBe('a ||bold x\\|\\|y|| b')
    expect(plainLine('a \\||b|| `||c||` d\\e')).toBe('a \\|\\|b\\|\\| \\|\\|c\\|\\| d\\\\e')
    expect(plainLine('unmatched || pipes')).toBe('unmatched \\|\\| pipes')
    expect(plainLine('||**||')).toBe('')
    const long = plainLine(`hi ||${'s'.repeat(300)}||`)
    expect(long.startsWith('hi ||s') && long.endsWith('s||')).toBe(true)
    expect(long.length).toBe(3 + 2 + 197 + 2)
  })

  test('snippets read back as parts, pipes and backslashes literal', () => {
    expect(snippetParts('a \\|\\|b\\|\\| ||c|| d\\\\e')).toEqual([
      { text: 'a ||b|| ', spoiler: false },
      { text: 'c', spoiler: true },
      { text: ' d\\e', spoiler: false },
    ])
    expect(snippetParts('||cut off')).toEqual([{ text: 'cut off', spoiler: true }])
  })

  test('the reply preview and forward bar show spoilers as bars', () => {
    const html = renderToStaticMarkup(
      <Snippet quote={{ content: plainLine('hey ||the ending|| ok'), has_media: false }} />
    )
    expect(html).toContain('data-reply-spoiler')
    expect(html).toContain('aria-label="Spoiler"')
    expect(html).toContain('text-transparent')
    const clip = clipOf(msg(4, { content: '||plot twist|| lol', author: user('bob') }))
    expect(snippetParts(clip.snippet)).toEqual([
      { text: 'plot twist', spoiler: true },
      { text: ' lol', spoiler: false },
    ])
  })

  test('search results hide spoilers in raw text', () => {
    const html = renderToStaticMarkup(
      <SpoilerLine parts={spoilerParts('find ||me|| and `||not this||`')} />
    )
    expect(html).toContain('data-reply-spoiler')
    expect(html).toContain('`||not this||`')
  })

  test('toasts, notifications and invite previews use blocks', () => {
    expect(alertBody('look ||the end|| **now**', false)).toBe('look ███████ now')
    expect(alertBody('cut ||secret plan goes on', false)).toBe('cut ████████')
    expect(alertBody('dangling ||', false)).toBe('dangling')
    expect(alertBody('`||code||` ok', false)).toBe('||code|| ok')
    expect(previewText('\\||nope||')).toBe('\\||nope||')
    expect(previewText('a ||b|| c')).toBe('a ███ c')
  })

  test('invite and message link cards skip spoilered links', () => {
    const origin = 'https://chat.example'
    expect(findInvites(`||${origin}/invite/club/||`, origin)).toEqual([])
    expect(findInvites(`\\|| ${origin}/invite/club/ ||`, origin)).toHaveLength(1)
    expect(visibleLinks('a ||https://x.example/1|| https://y.example/2')).toEqual([
      'https://y.example/2',
    ])
  })
})
