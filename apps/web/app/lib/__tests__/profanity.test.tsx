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
  parseProfanity,
  profanityKey,
  profanityValue,
  remarkMask,
  resetMasking,
  setMasking,
  type Matcher,
} from '../profanity'
import { siteFilterOn } from '../rules'
import { maskOf, useStore, resetSessionCaches } from '../store'
import { MarkdownMessage } from '../../components/markdown_message'
import { me, memoryStorage, msg, user } from './fixtures'
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

beforeEach(resetMasking)
afterEach(resetMasking)

describe('the setting', () => {
  test('is off by default and parsed defensively', () => {
    expect(profanityKey('alice')).toBe('rchat_profanity:alice')
    expect(profanityKey(null)).toBe('rchat_profanity:guest')
    for (const raw of [null, '', 'nope', '[]', '{"v":2,"on":true}', '{"v":1,"on":"yes"}'])
      expect(parseProfanity(raw)).toBe(false)
    expect(parseProfanity(profanityValue(true))).toBe(true)
    expect(parseProfanity(profanityValue(false))).toBe(false)
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
    const html = md('shit `fuck` here\n\n```\nfuck this\n```\n\nand `a shit` b', fake)
    expect(html).toContain('<code>fuck</code>')
    expect(html).toContain('fuck this')
    expect(html).toContain('<code>a shit</code>')
    expect(html).toContain('**** <code>')
    expect(html.includes('shit <code>')).toBe(false)
    expect(maskOutsideCode('shit `fuck` x ```\nshit', fake)).toBe('**** `fuck` x ```\nshit')
    expect(maskOutsideCode('no code shit', fake)).toBe('no code ****')
  })

  test('words split by formatting are masked, code still splits them', () => {
    const html = md('f**u**ck, sh*i*t and [fu](https://example.com/x)ck but fu`x`ck', fake)
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
    const html = md('[shit list](https://example.com/shit) and https://example.com/fuck', fake)
    expect(html).toContain('href="https://example.com/shit"')
    expect(html).toContain('>**** list</a>')
    expect(html).toContain('href="https://example.com/fuck"')
    expect(html).toContain('>https://example.com/****</a>')
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
    const html = md(message.content, mask)
    expect(html).toContain('hey, **** <code>fuck</code>')
    expect(message.content).toBe('hey, shit `fuck`')
    useStore.getState().setProfanityOn(false)
    expect(useStore.getState().profanityReady).toBe(false)
    expect(maskOf(useStore.getState())('hey, shit')).toBe('hey, shit')
    expect(maskProfanity('hey, shit')).toBe('hey, shit')
    expect(storage.get('rchat_profanity:alice')).toBe('{"v":1,"on":false}')
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
