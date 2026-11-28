import { flush } from './helpers/test_clock'
import { shownPeer } from './shown_peer'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
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
  maskFileName,
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
import { home } from './home_instance'
import { maskOf, useStore } from '../store'
import { MarkdownMessage } from '../../components/markdown_message'
import { MaskControl, Masked, MaskedWords } from '../../components/ui'
import { nameRevealKey } from '../../components/display_name'
import { Name } from '../../components/name'
import { personName } from '../names'
import { shownUser } from '../people'
import { ProfileHandle } from '../../components/profile_card'
import { dmPlaceholder } from '../display_name'
import { ReplyPreview } from '../../components/replies'
import { Tile } from '../../components/voice_grid'
import { VOICE_STATUS_ON } from '../voice_status'
import { VoiceRow } from '../../components/voice_row'
import { P2pRoom } from '../place/place'
import {
  ChannelAccess,
  MemberPicker,
  roleItems,
  roleMenuItems,
} from '../../components/p2p/p2p_server_roles'
import { AuditRow } from '../../components/audit_log'

import type { ChannelView, MemberView, RoleView, ServerView } from '../p2p/server'
import { P } from '../p2p/state'
import { nestedInteractive } from './nesting'
import { PlaceProvider } from '../place/react'
import { peerPlace } from './helpers/peer_place'
import type { Message } from '../types'
import { ownsP2pServer } from '../p2p/server/types'
import { embed, me, media, memoryStorage, msg, user } from './fixtures'
import { readText } from './masked_text'
import samples from './fixtures/profanity.json'

interface Sample {
  text: string
  masked: string
  file_name: string
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

  test('a load running when masking starts over installs nothing', async () => {
    let finish: (m: Matcher) => void = () => {}
    const slow = setMasking(true, () => new Promise<Matcher>(done => void (finish = done)))
    resetMasking()
    expect(await setMasking(true, () => Promise.resolve(t => t.replace(/new/g, '***')))).toBe(true)
    finish(t => t.replace(/old/g, '***'))
    expect(await slow).toBe(false)
    expect(maskProfanity('old new')).toBe('old ***')
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

  test('words split by formatting are masked, code splits them', () => {
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
    await flush()
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
          <Name
            of={personName(shownUser(user(u, { display_name: 'shit head' }), null), own)}
            withUsername
          />
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
    const tile = (u: string, p2p?: { own: boolean }) =>
      renderToStaticMarkup(
        <Tile
          tile={{
            ...(p2p ? { local: true, own: p2p.own } : {}),
            key: u,
            user: user(u, { display_name: 'shit head' }),
            stream: null,
            hasVideo: false,
            status: VOICE_STATUS_ON,
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
    // A P2P call names people by their P2P name, masked unless the tile is your own.
    const ownTile = tile('shit', { own: true })
    expect(ownTile).toContain('aria-label="Focus shit head"')
    expect(ownTile.includes('data-masked-word')).toBe(false)
    const peerTile = tile('alice', { own: false })
    expect(peerTile).toContain('aria-label="Focus **** head"')
    expect(peerTile.includes('(alice)')).toBe(false)
    expect(peerTile).toContain('data-masked-word')
    const mask = (t: string) => t.replace(/shit/g, '****')
    expect(dmPlaceholder(user('shit'), false, mask)).toBe('Message @****')
    expect(dmPlaceholder(user('shit'), true, mask)).toBe('Send a direct message')
  })

  test('a name pair is revealed whole: one reveal opens the display name and the username', async () => {
    await masking({})
    const words = (html: string) => html.split('data-masked-word').length - 1
    const pair = (u: string, display: string, open: string[]) =>
      renderToStaticMarkup(
        <MaskedWords open={open}>
          <Name of={personName(shownUser(user(u, { display_name: display }), null))} withUsername />
        </MaskedWords>
      )
    expect(pair('shit', 'fuck head', [])).toBe(pair('fuck', 'shit head', []))
    const text = (html: string) => html.replace(/<[^>]+>/g, '')
    const shown = pair('shit', 'fuck head', [nameRevealKey('shit')])
    expect(words(shown)).toBe(0)
    expect(text(shown)).toBe('fuck head(shit)')
    expect(words(pair('shit', 'fuck head', [nameRevealKey('fuck')]))).toBe(2)
    const two = renderToStaticMarkup(
      <MaskedWords open={[nameRevealKey('shit')]}>
        <Name
          of={personName(shownUser(user('shit', { display_name: 'fuck head' }), null))}
          withUsername
        />
        <Name
          of={personName(shownUser(user('fuck', { display_name: 'shit head' }), null))}
          withUsername
        />
      </MaskedWords>
    )
    expect(words(two)).toBe(2)
    expect(text(two).startsWith('fuck head(shit)')).toBe(true)
    expect(text(two).includes('shit head')).toBe(false)
    const alone = renderToStaticMarkup(
      <Name
        of={personName(shownUser(user('shit', { display_name: 'fuck head' }), null))}
        withUsername
      />
    )
    expect(words(alone)).toBe(2)
    expect(alone.includes('shit') || alone.includes('fuck')).toBe(false)
  })

  test('the profile card shows the username as written', async () => {
    await masking({})
    const html = renderToStaticMarkup(<ProfileHandle user={user('shit')} remote={null} />)
    expect(html).toContain('@shit')
    expect(html.includes('data-masked-word')).toBe(false)
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
    const place = peerPlace(shownPeer(), { me: 'IK_ME' })
    const p2p = (by: string) =>
      renderToStaticMarkup(
        <PlaceProvider place={place}>
          <Masked text="shit" by={by} />
        </PlaceProvider>
      )
    expect(p2p('IK_ME')).toBe('shit')
    expect(p2p('alice')).toContain('>****</span>')
    const p2pInitial = () => shownPeer().useP2p.getInitialState()
    const was = { me: p2pInitial().me, name: p2pInitial().name, servers: p2pInitial().servers }
    try {
      const view = {
        id: 'room',
        channels: [{ id: 'c1', name: 'talk', kind: 'voice' }],
        voice: {
          c1: [
            { ik: 'IK_ME', video: false },
            { ik: 'IK_PEER', video: false },
          ],
        },
        members: [
          { ik: 'IK_ME', name: 'shit head' },
          { ik: 'IK_PEER', name: 'shit face' },
        ],
        memberList: { hide: false, roles: null, channels: [] },
      } as unknown as ServerView
      Object.assign(p2pInitial(), { me: 'IK_ME', name: 'shit head', servers: { room: view } })
      const roster = renderToStaticMarkup(
        <PlaceProvider place={P2pRoom.open(shownPeer(), 'room')}>
          <VoiceRow
            channel={{
              key: 'c1',
              name: 'talk',
              kind: 'voice',
              private: false,
              active: true,
              connected: false,
            }}
            own={false}
            menu={() => {}}
          />
        </PlaceProvider>
      )
      const shown = roster.replace(/<[^>]+>/g, ' ')
      expect(shown).toContain('shit head')
      expect(shown.includes('shit face')).toBe(false)
      expect(roster.split('data-masked-word').length - 1).toBe(1)
    } finally {
      Object.assign(p2pInitial(), was)
    }
  })

  test('your own name in P2P channel access is never masked', async () => {
    await masking({})
    const p2pInitial = () => shownPeer().useP2p.getInitialState()
    const was = { me: p2pInitial().me, servers: p2pInitial().servers }
    const live = shownPeer().useP2p.getState().servers
    const people = [
      { ik: 'IK_ME', name: 'shit head', m: 'join', below: false, owner: false },
      { ik: 'IK_PEER', name: 'shit face', m: 'join', below: true, owner: false },
    ]
    const view = (owner: string) =>
      ({
        id: 'room',
        rules: 4,
        owner,
        owners: [],
        rank: [0],
        roles: [
          { id: 'R1', name: 'shit crew', below: true, bits: 0 },
          { id: 'R2', name: 'shit squad', below: true, bits: 0 },
        ],
        members: people,
        channels: [],
        categories: [],
        separators: [],
        chans: {},
      }) as unknown as ServerView
    const none = { allow: 0, deny: 0 }
    const channel = {
      id: 'c1',
      kind: 'text',
      restrict_view: true,
      over: { 'u:IK_ME': none, 'u:IK_PEER': none, 'r:R1': none },
    } as unknown as ChannelView
    const access = (owner: string) => {
      const v = view(owner)
      Object.assign(p2pInitial(), { me: 'IK_ME', servers: { room: v } })
      shownPeer().useP2p.setState({ servers: { room: v } })
      return renderToStaticMarkup(<ChannelAccess v={v} c={channel} />)
    }
    try {
      const owned = access('IK_ME')
      expect(owned).toContain('aria-label="Remove shit head"')
      expect(owned).toContain('aria-label="Remove **** face"')
      expect(owned).toContain('aria-label="Remove shit crew"')
      expect(owned).toContain('>shit squad</option>')
      const member = access('IK_OWNER')
      expect(member).toContain('aria-label="Remove shit head"')
      expect(member).toContain('title="Remove shit head"')
      expect(member).toContain('aria-label="Remove **** crew"')
      expect(member).toContain('>**** squad</option>')
      const picker = renderToStaticMarkup(
        <MemberPicker people={people as MemberView[]} onPick={() => {}} />
      )
      const shown = picker.replace(/<[^>]+>/g, ' ')
      expect(shown).toContain('shit head')
      expect(shown.includes('shit face')).toBe(false)
    } finally {
      Object.assign(p2pInitial(), was)
      shownPeer().useP2p.setState({ servers: live })
    }
  })

  test('role names in your own P2P server are never masked in menus and confirms', async () => {
    await masking({})
    const { profanityOn, profanityReady } = useStore.getState()
    const was = shownPeer().useP2p.getState().me
    const ME = { ik: 'IK_ME', name: 'me', m: 'join', below: false, owner: false, roles: ['R1'] }
    const PEER = { ik: 'IK_PEER', name: 'peer', m: 'join', below: true, owner: false, roles: [] }
    const crew = { id: 'R1', name: 'shit crew', below: true, held: false, holders: 1 }
    const view = (owner: string) =>
      ({
        id: 'room',
        owner,
        owners: [],
        me: 'join',
        perms: P.ManageRoles,
        rank: [0],
        roles: [crew, { id: 'R2', name: 'shit squad', below: true, held: false, holders: 0 }],
        members: [ME, PEER],
      }) as unknown as ServerView
    const said = (run: () => void) => {
      run()
      return useStore.getState().confirm?.body
    }
    useStore.setState({ profanityOn: true, profanityReady: true })
    shownPeer().useP2p.setState({ me: 'IK_ME' })
    try {
      const owned = view('IK_ME')
      const labels = (v: ServerView) =>
        roleMenuItems(v, PEER as unknown as MemberView).map(i => i.label)
      expect(labels(owned)).toEqual(['shit crew', 'shit squad'])
      const take = (v: ServerView) =>
        roleMenuItems(v, ME as unknown as MemberView).find(i => i.checked)?.action
      expect(said(() => take(owned)?.())).toBe(
        "Remove shit crew from yourself? You can't give it back to yourself."
      )
      const remove = (v: ServerView) =>
        roleItems(v, crew as unknown as RoleView).find(i => i.label === 'Delete Role')?.action
      expect(said(() => remove(owned)?.())).toBe('Delete shit crew? Members who have it lose it.')
      const theirs = view('IK_OWNER')
      expect(labels(theirs)).toEqual(['**** crew', '**** squad'])
      expect(said(() => take(theirs)?.())).toContain('Remove **** crew from yourself?')
      expect(said(() => remove(theirs)?.())).toContain('Delete **** crew?')
    } finally {
      useStore.setState({ profanityOn, profanityReady, confirm: null })
      shownPeer().useP2p.setState({ me: was })
    }
  })

  test('your own name in the audit log is never masked', async () => {
    await masking({ me: me('shit') })
    const row = renderToStaticMarkup(
      <AuditRow
        entry={{
          id: 1,
          action: 'member.kick',
          actor: user('shit', { display_name: 'fuck head' }),
          staff: false,
          target: {
            kind: 'user',
            id: null,
            name: 'fuck',
            user: user('fuck', { display_name: 'fuck face' }),
            staff: false,
            deleted: false,
          },
          details: {},
          hidden: false,
          created_at: 0,
        }}
      />
    )
    const shown = row.replace(/<span class="sr-only">masked<\/span>/g, '').replace(/<[^>]+>/g, '')
    expect(shown).toContain('fuck head(shit) kicked **** face(****)')
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
      await flush()
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

describe('file names', () => {
  // As the matcher reads them: "cun.ts" is a listed word in text, and its stem "cun" in a file name.
  const readings = {
    text: (t: string) => t.replace(/cun\.ts/g, '***.**'),
    file: (t: string) => t.replace(/fuck/g, '****'),
  }
  const initial = useStore.getInitialState()

  beforeEach(async () => {
    await setMasking(true, () => Promise.resolve(readings))
    Object.assign(initial, { profanityOn: true, profanityReady: true, me: me('alice') })
    useStore.setState({ profanityOn: true, profanityReady: true, me: me('alice') })
  })

  afterEach(() => {
    Object.assign(initial, { profanityOn: false, profanityReady: false, me: null })
    useStore.setState({ profanityOn: false, profanityReady: false, me: null })
  })

  test('the name of a file is read as one, every other text as text', () => {
    expect(maskProfanity('cun.ts')).toBe('***.**')
    expect(maskFileName('cun.ts')).toBe('cun.ts')
    expect(maskFileName('fuck.ts')).toBe('****.ts')
    expect(maskOf(useStore.getState(), false, true)('cun.ts')).toBe('cun.ts')
    expect(maskOf(useStore.getState(), true, true)('fuck.ts')).toBe('fuck.ts')
    expect(renderToStaticMarkup(<Masked text="cun.ts" file />)).toBe('cun.ts')
    expect(readText(renderToStaticMarkup(<Masked text="cun.ts" />))).toBe('***.**')
  })

  test('an attachment shows its name with it, the message text keeps the text reading', () => {
    const settings = initial.settings
    Object.assign(initial, { settings: { ...settings, asset_previews: false } })
    for (const file of [
      media({ filename: 'cun.ts', mime: 'text/plain' }),
      media({ filename: 'cun.ts', removed: true }),
    ]) {
      const message = msg(1, { content: 'see cun.ts', author: user('bob'), media: file })
      const html = readText(renderToStaticMarkup(<MarkdownMessage message={message} />))
      expect(html).toContain('see ***.**')
      for (const part of file.removed ? ['File cun.ts '] : ['title="cun.ts"', '>cun<', '>.ts<'])
        expect(html).toContain(part)
    }
    Object.assign(initial, { settings })
  })

  test('one matcher for all text reads file names too', async () => {
    resetMasking()
    await setMasking(true, () => Promise.resolve(fake))
    expect(maskFileName('shit.txt')).toBe('****.txt')
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
  // CI's build job sets RCHAT_WASM=required right after building the module.
  const required = process.env.RCHAT_WASM === 'required'

  // Locally `just src build-wasm` first.
  test(`matches the Rust fixture${built ? '' : ' (wasm not built, skipped)'}`, async () => {
    expect(built || !required).toBe(true)
    if (!built) return
    const mod = (await import(join(WASM, 'rust_next_wasm.js'))) as {
      initSync: (init: { module: Uint8Array }) => unknown
      mask_profanity: Matcher
      mask_file_name: Matcher
      is_profane: (text: string) => boolean
    }
    mod.initSync({ module: readFileSync(join(WASM, 'rust_next_wasm_bg.wasm')) })
    for (const s of SAMPLES) {
      expect(mod.mask_profanity(s.text)).toBe(s.masked)
      expect(mod.mask_file_name(s.text)).toBe(s.file_name)
      expect(mod.is_profane(s.text)).toBe(s.profane)
    }
  })
})
