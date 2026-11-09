import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  CACHE_MAX,
  cachedMasks,
  lru,
  maskOutsideCode,
  maskProfanity,
  maskRuns,
  parseProfanity,
  profanityKey,
  profanityValue,
  remarkMask,
  resetMasking,
  setMasking,
  type Matcher,
} from '../profanity'
import { messageFilterOn, siteFilterOn } from '../rules'
import { home } from '../instances'
import { maskOf, useStore, resetSessionCaches } from '../store'
import { MarkdownMessage } from '../../components/markdown_message'
import { MaskControl, Masked } from '../../components/ui'
import { NameWithUsername } from '../../components/display_name'
import { dmPlaceholder } from '../display_name'
import { ReplyPreview } from '../../components/replies'
import { Tile } from '../../components/voice_grid'
import { nestedInteractive } from './nesting'
import { ChatSourceProvider, type ChatSource } from '../../components/chat_source'
import type { Message } from '../types'
import { ownsP2pServer } from '../p2p/server/types'
import { embed, me, memoryStorage, msg, user } from './fixtures'
import samples from './fixtures/profanity.json'

afterAll(resetSessionCaches)

interface Sample {
  text: string
  masked: string
  profane: boolean
}

const SAMPLES = samples as Sample[]
const known = new Map(SAMPLES.map(s => [s.text, s.masked]))

// Masks whole words the way the wasm matcher does for the fixture samples.
const WORDS = /fuck|shit|asshole/gi
const fake: Matcher = text =>
  known.get(text) ?? text.replace(WORDS, w => w.replace(/[\p{L}\p{N}]/gu, '*'))

const counted = () => {
  const calls: string[] = []
  const matcher: Matcher = text => {
    calls.push(text)
    return fake(text)
  }
  return { calls, load: () => Promise.resolve(matcher) }
}

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const WASM = join(ROOT, '..', 'public', 'wasm')

const md = (text: string, mask: Matcher) =>
  renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkMask(mask)]}>{text}</ReactMarkdown>
  )

// The same with each masked word's wrapper left out: the text as it reads.
const mdText = (text: string, mask: Matcher) =>
  md(text, mask).replace(/<span data-masked="[^"]*" data-mask-word="[^"]*">([^<]*)<\/span>/g, '$1')

beforeEach(resetMasking)
afterEach(resetMasking)

describe('the setting', () => {
  test('is on by default and parsed defensively', () => {
    expect(profanityKey('alice')).toBe('rchat_profanity:alice')
    expect(profanityKey(null)).toBe('rchat_profanity:guest')
    for (const raw of [null, '', 'nope', '[]', '{"v":9,"on":false}', '{"v":1,"on":"no"}'])
      expect(parseProfanity(raw)).toBe(true)
    expect(parseProfanity(profanityValue(true))).toBe(true)
    expect(parseProfanity(profanityValue(false))).toBe(false)
  })

  test('a choice saved before the default changed is kept', () => {
    expect(parseProfanity('{"v":1,"on":false}')).toBe(false)
    expect(parseProfanity('{"v":1,"on":true}')).toBe(true)
  })
})

describe('loading and caching', () => {
  test('the matcher loads only once the setting is on, and only once', async () => {
    const { calls, load } = counted()
    let loads = 0
    const loader = () => {
      loads += 1
      return load()
    }
    expect(await setMasking(false, loader)).toBe(false)
    expect(loads).toBe(0)
    expect(maskProfanity('fuck')).toBe('fuck')
    expect(await setMasking(true, loader)).toBe(true)
    expect(await setMasking(true, loader)).toBe(true)
    expect(loads).toBe(1)
    expect(maskProfanity('fuck')).toBe('****')
    expect(maskProfanity('fuck')).toBe('****')
    expect(calls).toEqual(['fuck'])
    await setMasking(false, loader)
    expect(maskProfanity('fuck')).toBe('fuck')
  })

  test('a failed load masks nothing and the next turn on tries again', async () => {
    expect(await setMasking(true, () => Promise.reject(new Error('missing')))).toBe(false)
    expect(maskProfanity('fuck')).toBe('fuck')
    expect(await setMasking(true, counted().load)).toBe(true)
    expect(maskProfanity('fuck')).toBe('****')
  })

  test('the cache is bounded and keeps recent strings', async () => {
    const cache = lru<number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.get('a')
    cache.set('c', 3)
    expect([cache.get('a'), cache.get('b'), cache.get('c'), cache.size()]).toEqual([
      1,
      undefined,
      3,
      2,
    ])
    await setMasking(true, counted().load)
    for (let i = 0; i < CACHE_MAX + 50; i += 1) maskProfanity(`line ${i}`)
    expect(cachedMasks()).toBe(CACHE_MAX)
  })
})

describe('masking rules', () => {
  test('each letter of a match becomes a star, spacing and punctuation stay', () => {
    for (const s of SAMPLES) {
      expect(s.masked.length).toBe(s.text.length)
      if (!s.profane) expect(s.masked).toBe(s.text)
      for (let i = 0; i < s.text.length; i += 1)
        if (s.masked[i] !== s.text[i]) expect(s.masked[i]).toBe('*')
    }
    expect(known.get('f.u.c.k off')).toBe('*.*.*.* off')
    expect(known.get('what the shit.')).toBe('what the ****.')
  })

  test('code blocks and inline code stay as written', () => {
    const html = mdText('shit `fuck` here\n\n```\nfuck this\n```\n\nand `a shit` b', fake)
    expect(html).toContain('<code>fuck</code>')
    expect(html).toContain('fuck this')
    expect(html).toContain('<code>a shit</code>')
    expect(html).toContain('**** <code>')
    expect(html.includes('shit <code>')).toBe(false)
    expect(maskOutsideCode('shit `fuck` x ```\nshit', fake)).toBe('**** `fuck` x ```\nshit')
    expect(maskOutsideCode('no code shit', fake)).toBe('no code ****')
  })

  test('words split by formatting are masked, code still splits them', () => {
    const html = mdText('f**u**ck, sh*i*t and [fu](https://example.com/x)ck but fu`x`ck', fake)
    expect(html).toContain('*<strong>*</strong>**, **<em>*</em>* and ')
    expect(html).toContain('<a href="https://example.com/x">**</a>** but fu<code>x</code>ck')
  })

  test('text the matcher only rewrote (lone surrogates) comes back as it was', async () => {
    const lossy: Matcher = text => text.replace(/[\uD800-\uDFFF]/g, '\uFFFD')
    await setMasking(true, () => Promise.resolve(lossy))
    expect(maskProfanity('a\uD800 b')).toBe('a\uD800 b')
    expect(maskProfanity('x\uD83D\uDE00')).toBe('x\uD83D\uDE00')
  })

  test('links keep their target and mask only the visible text', () => {
    const html = mdText('[shit list](https://example.com/shit) and https://example.com/fuck', fake)
    expect(html).toContain('href="https://example.com/shit"')
    expect(html).toContain('>**** list</a>')
    expect(html).toContain('href="https://example.com/fuck"')
    expect(html).toContain('>https://example.com/****</a>')
  })
})

describe('masked words', () => {
  test('runs keep plain text and each masked word with what it hides', () => {
    expect(maskRuns('hey, shit and fuck', 'hey, **** and ****')).toEqual([
      { text: 'hey, ' },
      { text: '****', hidden: 'shit', word: 0 },
      { text: ' and ' },
      { text: '****', hidden: 'fuck', word: 1 },
    ])
    expect(maskRuns('f.u.c.k off', '*.*.*.* off')).toEqual([
      { text: '*.*.*.*', hidden: 'f.u.c.k', word: 0 },
      { text: ' off' },
    ])
    expect(maskRuns('clean', 'clean')).toEqual([{ text: 'clean' }])
    expect(maskRuns('', '')).toEqual([])
    expect(maskRuns('a😀shit', 'a😀****')).toEqual([
      { text: 'a😀' },
      { text: '****', hidden: 'shit', word: 0 },
    ])
    expect(maskRuns('shit', '***')).toEqual([{ text: '***', hidden: 'shit', word: 0 }])
  })

  test('a masked message keeps every word revealable, one button per word', () => {
    const html = md('hey, shit `fuck` and fuck', fake)
    expect(html).toContain('hey, <span data-masked="shit" data-mask-word="0.0">****</span> ')
    expect(html).toContain('<code>fuck</code>')
    expect(html).toContain(' and <span data-masked="fuck" data-mask-word="0.1">****</span>')
  })

  test('the pieces of a word split by formatting reveal together', () => {
    const html = md('f**u**ck and a [sh](https://x.co)it', fake)
    expect(html).toContain(
      '<span data-masked="f" data-mask-word="0.0">*</span><strong><span data-masked="u" data-mask-word="0.0">*</span></strong><span data-masked="ck" data-mask-word="0.0">**</span>'
    )
    expect(html).toContain(
      '<a href="https://x.co"><span data-masked="sh" data-mask-word="0.1">**</span></a><span data-masked="it" data-mask-word="0.1">**</span>'
    )
  })

  test('words in separate blocks are numbered apart', () => {
    const html = md('shit\n\n# fuck\n\n| a |\n| - |\n| shit |', fake)
    const words = [...html.matchAll(/data-mask-word="([^"]+)"/g)].map(m => m[1])
    expect(words.length).toBe(3)
    expect(new Set(words).size).toBe(3)
  })
})

describe('in messages', () => {
  const storage = new Map<string, string>()

  beforeEach(() => {
    storage.clear()
    Object.assign(globalThis, {
      localStorage: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => void storage.set(k, v),
        removeItem: (k: string) => void storage.delete(k),
      },
    })
    useStore.setState({ me: me('alice'), guest: false })
  })

  afterEach(() => {
    Object.assign(globalThis, { localStorage: memoryStorage })
    useStore.setState({ me: null, profanityOn: false, profanityReady: false })
  })

  const message = msg(1, { content: 'hey, shit `fuck`', author: user('bob') })
  const render = () => renderToStaticMarkup(<MarkdownMessage message={message} />)

  test('turning it on masks what you see and never the message', async () => {
    await setMasking(true, counted().load)
    await setMasking(false)
    expect(render()).toContain('hey, shit')
    useStore.getState().setProfanityOn(true)
    expect(storage.get('rchat_profanity:alice')).toBe('{"v":1,"on":true}')
    await new Promise(r => setTimeout(r, 0))
    expect(useStore.getState().profanityReady).toBe(true)
    const mask = maskOf(useStore.getState())
    expect(mask('hey, shit')).toBe('hey, ****')
    const html = mdText(message.content, mask)
    expect(html).toContain('hey, **** <code>fuck</code>')
    expect(message.content).toBe('hey, shit `fuck`')
    useStore.getState().setProfanityOn(false)
    expect(useStore.getState().profanityReady).toBe(false)
    expect(maskOf(useStore.getState())('hey, shit')).toBe('hey, shit')
    expect(maskProfanity('hey, shit')).toBe('hey, shit')
    expect(storage.get('rchat_profanity:alice')).toBe('{"v":1,"on":false}')
  })

  // Server rendering reads the store's initial state, so the test state goes there.
  const initial = useStore.getInitialState()
  const masking = async (on: Partial<typeof initial>) => {
    await setMasking(true, counted().load)
    Object.assign(initial, { profanityOn: true, profanityReady: true, me: me('alice'), ...on })
  }
  afterEach(() => {
    Object.assign(initial, { profanityOn: false, profanityReady: false, me: null })
  })

  test('in plain text a masked word is a real button, and the hidden word is not in the page', async () => {
    await masking({})
    const html = render()
    expect(html).toContain(
      '<button type="button" data-masked-word="" aria-label="Masked word" title="Show masked word"'
    )
    expect(html).toContain('>****</button>')
    expect(html.includes('role="button"')).toBe(false)
    expect(html).toContain('>fuck</code>')
    expect(html.includes('shit')).toBe(false)
  })

  test('inside another control a masked word is a plain span that reads as masked', async () => {
    await masking({})
    for (const html of [
      renderToStaticMarkup(
        <button type="button">
          <Masked text="shit club" />
        </button>
      ),
      renderToStaticMarkup(
        <a href="/x">
          <Masked text="shit club" />
        </a>
      ),
      renderToStaticMarkup(
        <MaskControl>
          <Masked text="shit club" />
        </MaskControl>
      ),
    ]) {
      const word = html.slice(html.indexOf('<span data-masked-word'))
      expect(word.startsWith('<span data-masked-word=""')).toBe(true)
      expect(/role=|tabindex=|aria-label=/.test(word.slice(0, word.indexOf('>')))).toBe(false)
      expect(html).toContain(
        '<span aria-hidden="true">****</span><span class="sr-only">masked</span>'
      )
    }
  })

  test('no interactive element nests inside another where masked text renders', async () => {
    await masking({
      settings: { ...useStore.getInitialState().settings, asset_previews: true },
    })
    const quoted = msg(4, {
      content: 'a [shit link](https://x.co) and ||shit|| and https://e1.com',
      author: user('shitlord'),
      embeds: [embed(1, { url: 'https://e1.com', title: 'shit title', site_name: 'shit site' })],
    })
    const reply = {
      id: 3,
      author: user('shitlord'),
      content: 'shit reply',
      has_media: false,
      deleted: false,
      mention: false,
    }
    const html =
      renderToStaticMarkup(<MarkdownMessage message={quoted} />) +
      renderToStaticMarkup(<ReplyPreview quote={reply} avatar={24} onJump={() => {}} />) +
      renderToStaticMarkup(
        <label>
          <input type="checkbox" />
          <Masked text="shit option" />
        </label>
      )
    expect(html).toContain('data-masked-word')
    expect(nestedInteractive(html)).toEqual([])
    expect(nestedInteractive('<button><span role="button" tabindex="0">x</span></button>')).toEqual(
      ['<span role="button" tabindex="0">']
    )
  })

  test('your own messages and names are never masked for you', async () => {
    await masking({})
    const mine = msg(2, { content: 'hey, shit', author: user('alice') })
    expect(renderToStaticMarkup(<MarkdownMessage message={mine} />)).toContain('hey, shit')
    const hook = msg(3, {
      content: 'hey, shit',
      author: user('alice'),
      webhook: { id: 1, name: 'alice', avatar: null, embeds: [] },
    } as Partial<Message>)
    expect(renderToStaticMarkup(<MarkdownMessage message={hook} />).includes('shit')).toBe(false)
    const named = (by: string) => renderToStaticMarkup(<Masked text="shit head" by={by} />)
    expect(named('alice')).toBe('shit head')
    expect(named('bob')).toContain(
      '<span aria-hidden="true">****</span><span class="sr-only">masked</span></span> head'
    )
    expect(renderToStaticMarkup(<Masked text="shit head" own />)).toBe('shit head')
    expect(renderToStaticMarkup(<Masked text="no `shit` here, shit" code />)).toContain(
      'no `shit` here, <span'
    )
  })

  test("names with their usernames: yours stay plain, other people's are masked with reveal", async () => {
    await masking({})
    const name = (u: string, own?: boolean) =>
      renderToStaticMarkup(
        <button type="button">
          <NameWithUsername user={user(u, { display_name: 'shit head' })} own={own} />
        </button>
      )
    const mine = name('alice')
    expect(mine).toContain('shit head')
    expect(mine).toContain('(alice)')
    expect(mine.includes('data-masked-word')).toBe(false)
    const theirs = name('shit')
    expect(theirs.includes('shit')).toBe(false)
    expect(theirs.split('<span data-masked-word').length - 1).toBe(2)
    expect(theirs).toContain('(<span data-masked-word')
    expect(nestedInteractive(theirs)).toEqual([])
    expect(name('alice', false).includes('shit')).toBe(false)
    const tile = (u: string) =>
      renderToStaticMarkup(
        <Tile
          tile={{
            key: u,
            user: user(u, { display_name: 'shit head' }),
            stream: null,
            hasVideo: false,
            muted: false,
            deafened: false,
            speaking: false,
            mirror: false,
            pending: false,
            tint: '#000000',
            screen: false,
            shareId: null,
          }}
          server={null}
          focused={false}
          compact
          onToggle={() => {}}
        />
      )
    expect(tile('alice')).toContain('aria-label="Focus shit head (alice)"')
    expect(tile('shit')).toContain('aria-label="Focus **** head (****)"')
    const mask = (t: string) => t.replace(/shit/g, '****')
    expect(dmPlaceholder(user('shit'), false, mask)).toBe('Message @****')
    expect(dmPlaceholder(user('shit'), true, mask)).toBe('Send a direct message')
  })

  test('your own text is never masked, whatever the filter', async () => {
    await masking({})
    expect(maskOf(useStore.getInitialState())('shit')).toBe('****')
    expect(maskOf(useStore.getInitialState(), true)('shit')).toBe('shit')
    const v = { owner: 'IK_A', owners: ['IK_A', 'IK_B'] }
    expect(ownsP2pServer(v, 'IK_A')).toBe(true)
    expect(ownsP2pServer(v, 'IK_B')).toBe(true)
    expect(ownsP2pServer(v, 'IK_C')).toBe(false)
    expect(ownsP2pServer(v, null)).toBe(false)
    expect(ownsP2pServer(undefined, 'IK_A')).toBe(false)
  })

  test('in a P2P conversation your own identity is you', async () => {
    await masking({})
    const source = { self: 'IK_ME' } as unknown as ChatSource
    const p2p = (by: string) =>
      renderToStaticMarkup(
        <ChatSourceProvider value={source}>
          <Masked text="shit" by={by} />
        </ChatSourceProvider>
      )
    expect(p2p('IK_ME')).toBe('shit')
    expect(p2p('alice')).toContain('>****</span>')
  })

  test('an account that never chose has it on, one that turned it off keeps it off', async () => {
    const g = globalThis as { window?: unknown; document?: unknown; fetch: typeof fetch }
    const real = { window: g.window, document: g.document, fetch: g.fetch }
    g.window = {
      location: { pathname: '/', href: 'http://x/', origin: 'http://x', protocol: 'http:' },
      history: { state: null, pushState: () => {}, replaceState: () => {} },
    }
    g.document = { cookie: '' }
    const signIn = async (username: string) => {
      g.fetch = (async () =>
        new Response(JSON.stringify({ token: 'tok', user: me(username) }), {
          status: 200,
        })) as unknown as typeof fetch
      useStore.setState({ me: null })
      await useStore.getState().login({ username, password: 'x' } as never)
    }
    try {
      await setMasking(true, counted().load)
      await signIn('alice')
      expect(useStore.getState().profanityOn).toBe(true)
      expect(storage.has('rchat_profanity:alice')).toBe(false)
      await new Promise(r => setTimeout(r, 0))
      expect(maskOf(useStore.getState())('hey, shit')).toBe('hey, ****')
      useStore.getState().setProfanityOn(false)
      storage.set('rchat_profanity:bob', '{"v":1,"on":false}')
      await signIn('bob')
      expect(useStore.getState().profanityOn).toBe(false)
      await signIn('alice')
      expect(useStore.getState().profanityOn).toBe(false)
    } finally {
      home.ws.stop()
      Object.assign(g, real)
      useStore.setState({ token: null })
    }
  })

  test('an imported config sets it', async () => {
    await setMasking(true, counted().load)
    expect(await useStore.getState().applyConfig({ v: 1, profanity: true }, ['profanity'])).toBe(
      null
    )
    expect(useStore.getState().profanityOn).toBe(true)
    expect(storage.get('rchat_profanity:alice')).toBe('{"v":1,"on":true}')
  })
})

describe('the site filter line', () => {
  test('shows only when the site filter covers at least one target', () => {
    const off = Object.fromEntries(
      [
        'messages',
        'links',
        'usernames',
        'server_names',
        'channel_names',
        'role_names',
        'file_names',
        'bios',
        'channel_topics',
        'category_names',
      ].map(k => [k, false])
    )
    expect(siteFilterOn({ profanity_filter: true })).toBe(true)
    expect(siteFilterOn({ profanity_filter: false })).toBe(false)
    expect(siteFilterOn({ profanity_filter: true, profanity_targets: off })).toBe(false)
    expect(
      siteFilterOn({ profanity_filter: true, profanity_targets: { ...off, links: true } })
    ).toBe(false)
    expect(
      siteFilterOn({ profanity_filter: true, profanity_targets: { ...off, bios: true } })
    ).toBe(true)
  })

  test('the composer line shows only while the site filter checks messages', () => {
    const off = Object.fromEntries(
      [
        'messages',
        'links',
        'usernames',
        'server_names',
        'channel_names',
        'role_names',
        'file_names',
        'bios',
        'channel_topics',
        'category_names',
      ].map(k => [k, false])
    )
    expect(messageFilterOn({ profanity_filter: true })).toBe(true)
    expect(messageFilterOn({ profanity_filter: false })).toBe(false)
    expect(
      messageFilterOn({ profanity_filter: true, profanity_targets: { ...off, bios: true } })
    ).toBe(false)
    expect(
      messageFilterOn({ profanity_filter: false, profanity_targets: { ...off, messages: true } })
    ).toBe(false)
    expect(
      messageFilterOn({ profanity_filter: true, profanity_targets: { ...off, messages: true } })
    ).toBe(true)
  })
})

const walk = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir).flatMap(name => {
        const path = join(dir, name)
        return statSync(path).isDirectory() ? walk(path) : [path]
      })
    : []

// P2P content is never filtered by the instance: P2P code may only use the personal filter.
describe('P2P paths', () => {
  const SITE_RULES = [
    'profanityTargetOn',
    'profanityTargetLocked',
    'siteFilterOn',
    'PROFANITY_TARGETS',
    'profanity_filter',
    'profanity_targets',
    'check_profanity',
  ]
  // Directories of P2P code. A new one fails the test below until it is listed here, so whoever
  // adds P2P code has to look at this rule.
  const P2P_DIRS = ['components/p2p', 'lib/p2p']
  const app = walk(ROOT).filter(f => !f.includes('__tests__'))
  const p2pFiles = () =>
    app
      .filter(
        f => /p2p/i.test(relative(ROOT, f)) || P2P_DIRS.some(d => f.startsWith(join(ROOT, d)))
      )
      .filter(f => /\.tsx?$/.test(f))

  test('every P2P directory is listed', () => {
    const dirs = new Set(
      app.flatMap(f =>
        relative(ROOT, f)
          .split('/')
          .slice(0, -1)
          .map((_, i, parts) => parts.slice(0, i + 1).join('/'))
          .filter(d => /p2p/i.test(d.split('/').pop() ?? ''))
      )
    )
    expect([...dirs].sort()).toEqual([...P2P_DIRS].sort())
  })

  test('never use the site profanity filter', () => {
    const files = p2pFiles()
    expect(files.some(f => f.endsWith(join('lib', 'p2p.ts')))).toBe(true)
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const name of SITE_RULES)
        expect(`${file}: ${text.includes(name)}`).toBe(`${file}: false`)
    }
  })

  test('the personal filter does not depend on site settings', () => {
    const text = readFileSync(join(ROOT, 'lib', 'profanity.ts'), 'utf8')
    for (const name of SITE_RULES) expect(text.includes(name)).toBe(false)
    expect(text.includes("from './rules'")).toBe(false)
    expect(text.includes("from './store'")).toBe(false)
  })
})

describe('the compiled matcher', () => {
  const built = existsSync(join(WASM, 'rust_next_wasm_bg.wasm'))
  // CI's build job sets RCHAT_WASM=required right after wasm-pack; the plain bun job has no wasm.
  const required = process.env.RCHAT_WASM === 'required'

  // Locally `just src build-wasm` first.
  test(`matches the Rust fixture${built ? '' : ' (wasm not built, skipped)'}`, async () => {
    expect(built || !required).toBe(true)
    if (!built) return
    const mod = (await import(join(WASM, 'rust_next_wasm.js'))) as {
      initSync: (init: { module: Uint8Array }) => unknown
      mask_profanity: Matcher
      is_profane: (text: string) => boolean
    }
    mod.initSync({ module: readFileSync(join(WASM, 'rust_next_wasm_bg.wasm')) })
    for (const s of SAMPLES) {
      expect(mod.mask_profanity(s.text)).toBe(s.masked)
      expect(mod.is_profane(s.text)).toBe(s.profane)
    }
  })
})
