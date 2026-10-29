import { describe, expect, test } from 'bun:test'
import {
  DAMAGED,
  JSON_MAX,
  LINK_MAX,
  NEWER,
  NOT_CONFIG,
  PREFIX,
  SECTIONS,
  STASH_MS,
  buildConfig,
  configPath,
  decodeConfig,
  describeChanges,
  encodeConfig,
  linkDoc,
  parseConfigLink,
  parseConfigPath,
  sanitizeConfig,
  stashConfig,
  takeStashedConfig,
  type ConfigDoc,
  type ConfigSource,
  type SectionKey,
} from '../config_transfer'
import { EMPTY_NOTIFY, setLevel, setMute } from '../notify'
import { EMPTY_PREFS, MAX_USED, noteUse } from '../emoji'

const NOW = 1_800_000_000_000
const ALL = new Set<SectionKey>(SECTIONS.map(s => s.key))

const source = (over: Partial<ConfigSource> = {}): ConfigSource => {
  let notify = setLevel(EMPTY_NOTIFY, { kind: 'server', name: 'club' }, 'all')
  notify = setMute(notify, { kind: 'dm', id: 7 }, 'forever')
  notify = setMute(notify, { kind: 'channel', id: 12, server: 'club' }, NOW + 60_000)
  let emoji = noteUse(EMPTY_PREFS, '👍', '👍🏽', NOW - 1000)
  emoji = { ...noteUse(emoji, '🎉', '🎉', NOW - 500), tone: 3 }
  return {
    theme: 'light',
    streamer: true,
    appearOffline: true,
    layout: {
      servers: ['rchat', { id: 'f1', name: 'Games', servers: ['club', 'arena'], open: true }],
      dmOrder: [7, 3],
      dmPinned: [7],
      selfPin: 'unpinned',
      collapsed: { club: [12], arena: [15] },
    },
    notify,
    emoji,
    calls: 'p2p',
    typing: false,
    ...over,
  }
}

const inflateRaw = async (text: string) => {
  const b64 = text.slice(PREFIX.length).replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64)
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0))
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Response(stream).text()
}

const deflate = async (json: string) => {
  const stream = new Blob([new TextEncoder().encode(json)])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'))
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return PREFIX + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

describe('encoding', () => {
  test('round trips every section through the rc1 string', async () => {
    const doc = buildConfig(source(), ALL)
    const text = await encodeConfig(doc)
    expect(text.startsWith('rc1.')).toBe(true)
    expect(/^rc1\.[A-Za-z0-9_-]+$/.test(text)).toBe(true)
    const back = await decodeConfig(text, NOW)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(JSON.parse(JSON.stringify(back.doc))).toEqual(JSON.parse(JSON.stringify(doc)))
    expect(back.doc.theme).toBe('light')
    expect(back.doc.layout?.servers[1]).toEqual({
      id: 'f1',
      name: 'Games',
      servers: ['club', 'arena'],
      open: true,
    })
    expect(back.doc.layout?.collapsed).toEqual({ club: [12], arena: [15] })
    expect(back.doc.notify?.dms['7']).toEqual({ muteUntil: 'forever' })
    expect(back.doc.emoji?.tone).toBe(3)
  })

  test('whitespace and line breaks in a pasted string are ignored', async () => {
    const text = await encodeConfig({ v: 1, theme: 'dark' })
    const wrapped = `  ${text.slice(0, 6)}\n${text.slice(6)}  `
    const back = await decodeConfig(wrapped, NOW)
    expect(back).toEqual({ ok: true, doc: { v: 1, theme: 'dark' } })
  })

  test('garbage, truncation and newer versions are refused with a reason', async () => {
    expect(await decodeConfig('hello', NOW)).toEqual({ ok: false, error: NOT_CONFIG })
    expect(await decodeConfig('rc1.', NOW)).toEqual({ ok: false, error: DAMAGED })
    expect(await decodeConfig('rc1.@@@', NOW)).toEqual({ ok: false, error: DAMAGED })
    const good = await encodeConfig(buildConfig(source(), ALL))
    expect((await decodeConfig(good.slice(0, good.length - 9), NOW)).ok).toBe(false)
    expect(await decodeConfig(await deflate('not json'), NOW)).toEqual({
      ok: false,
      error: DAMAGED,
    })
    expect(await decodeConfig(await deflate('[1,2]'), NOW)).toEqual({ ok: false, error: DAMAGED })
    expect(await decodeConfig(await deflate('{"v":"1"}'), NOW)).toEqual({
      ok: false,
      error: DAMAGED,
    })
    expect(await decodeConfig(await deflate('{"v":2,"theme":"dark"}'), NOW)).toEqual({
      ok: false,
      error: NEWER,
    })
  })

  test('a small string that inflates past the cap is refused', async () => {
    const bomb = await deflate(`{"v":1,"pad":"${'a'.repeat(JSON_MAX + 10)}"}`)
    expect(bomb.length < 20_000).toBe(true)
    expect(await decodeConfig(bomb, NOW)).toEqual({ ok: false, error: DAMAGED })
  })

  test('a full config fits in a share link', async () => {
    const text = await encodeConfig(linkDoc(buildConfig(source(), ALL)))
    expect(text.length < LINK_MAX).toBe(true)
  })
})

describe('sanitizing', () => {
  test('unknown sections and fields are dropped, so later sections are skipped safely', () => {
    const out = sanitizeConfig(
      {
        v: 1,
        theme: 'dark',
        identity: { enc: 'secret-blob' },
        token: 'abc',
        layout: { servers: ['a'], dmOrder: [], dmPinned: [], selfPin: 'auto', extra: 1 },
      },
      NOW
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(Object.keys(out.doc).sort()).toEqual(['layout', 'theme', 'v'])
    expect(Object.keys(out.doc.layout ?? {}).sort()).toEqual([
      'dmOrder',
      'dmPinned',
      'selfPin',
      'servers',
    ])
  })

  test('wrong types are dropped per section, not for the whole document', () => {
    const out = sanitizeConfig(
      {
        v: 1,
        theme: 'neon',
        streamer: 'yes',
        appearOffline: 1,
        layout: 'nope',
        notify: [1],
        emoji: { tone: 99, used: { '😀': { n: 1e12, at: NOW + 1e9, last: '😀' }, bad: 5 } },
      },
      NOW
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.doc.theme).toBeUndefined()
    expect(out.doc.streamer).toBeUndefined()
    expect(out.doc.appearOffline).toBeUndefined()
    expect(out.doc.layout).toBeUndefined()
    expect(out.doc.notify).toBeUndefined()
    expect(out.doc.emoji?.tone).toBe(0)
    expect(out.doc.emoji?.used).toEqual({ '😀': { n: 1e6, at: NOW, last: '😀' } })
  })

  test('collapsed categories are kept as clean ids per server and left out when empty', () => {
    const out = sanitizeConfig(
      {
        v: 1,
        layout: {
          servers: [],
          collapsed: { club: [3, 3, -1, 'x', 8], ['x'.repeat(65)]: [4], empty: [], bad: 5 },
        },
      },
      NOW
    )
    if (!out.ok) throw new Error('rejected')
    expect(out.doc.layout?.collapsed).toEqual({ club: [3, 8] })
    for (const collapsed of ['no', [3, 8], { club: 'no' }]) {
      const none = sanitizeConfig({ v: 1, layout: { servers: [], collapsed } }, NOW)
      if (!none.ok) throw new Error('rejected')
      expect(none.doc.layout && 'collapsed' in none.doc.layout).toBe(false)
    }
  })

  test('layout is clamped: names, folder ids, folder names, counts, ids', () => {
    const many = Array.from({ length: 1500 }, (_, i) => `s${i}`)
    const out = sanitizeConfig(
      {
        v: 1,
        layout: {
          servers: [
            '',
            'x'.repeat(65),
            'ok',
            { id: 'y'.repeat(40), name: 'Long', servers: ['p', 'q'], open: false },
            { id: 'f', name: `  ${'n'.repeat(80)} `, servers: ['m', 'n', 'ok'], open: 'yes' },
            { id: 'g', name: 'Lonely', servers: ['solo'], open: true },
            ...many,
          ],
          dmOrder: [1, 1, -2, 2.5, '3', ...Array.from({ length: 1200 }, (_, i) => i + 10)],
          dmPinned: [4, 0, null],
          selfPin: 'weird',
        },
      },
      NOW
    )
    if (!out.ok) throw new Error('rejected')
    const l = out.doc.layout
    if (!l) throw new Error('no layout')
    expect(l.servers.slice(0, 5)).toEqual([
      'ok',
      'p',
      'q',
      { id: 'f', name: 'n'.repeat(50), servers: ['m', 'n'], open: false },
      'solo',
    ])
    const names = l.servers.flatMap(e => (typeof e === 'string' ? [e] : e.servers))
    expect(names.length).toBe(1000)
    expect(new Set(names).size).toBe(names.length)
    expect(l.dmOrder[0]).toBe(1)
    expect(l.dmOrder.length).toBe(1000)
    expect(l.dmOrder.every(id => Number.isSafeInteger(id) && id > 0)).toBe(true)
    expect(l.dmPinned).toEqual([4])
    expect(l.selfPin).toBe('auto')
  })

  test('notification rules go through the notify parser (prototype keys stay inert)', () => {
    const raw = JSON.parse(
      '{"v":1,"notify":{"servers":{"__proto__":{"level":"all"},"constructor":{"level":"nothing"},"club":{"level":"bogus","muteUntil":5}},"channels":{"abc":{"level":"all"},"12":{"level":"all"}},"dms":{"7":{"muteUntil":"forever"}},"desktop":"yes"}}'
    ) as unknown
    const out = sanitizeConfig(raw, NOW)
    if (!out.ok || !out.doc.notify) throw new Error('rejected')
    const n = out.doc.notify
    expect(Object.getPrototypeOf(n.servers)).toBeNull()
    expect(Object.keys(n.servers)).toEqual(['constructor'])
    expect(Object.keys(n.channels)).toEqual(['12'])
    expect(n.dms['7']).toEqual({ muteUntil: 'forever' })
    expect(n.desktop).toBe(false)
    expect(({} as Record<string, unknown>).level).toBeUndefined()
  })

  test('emoji entries that are not emoji are dropped', () => {
    const good = { n: 2, at: NOW, last: '👍🏽' }
    const out = sanitizeConfig(
      {
        v: 1,
        emoji: {
          v: 1,
          tone: 0,
          used: {
            '👍': good,
            '🇯🇵': { n: 1, at: NOW, last: '🇯🇵' },
            '1️⃣': { n: 1, at: NOW, last: '1️⃣' },
            hello: { n: 5, at: NOW, last: 'hello' },
            '😀': { n: 5, at: NOW, last: 'junk text' },
            '<b>': { n: 5, at: NOW, last: '😀' },
            '😀😀': { n: 5, at: NOW, last: '😀😀' },
            a1: { n: 5, at: NOW, last: '1' },
          },
        },
      },
      NOW
    )
    if (!out.ok || !out.doc.emoji) throw new Error('rejected')
    expect(Object.keys(out.doc.emoji.used).sort()).toEqual(['1️⃣', '🇯🇵', '👍'].sort())
    expect(out.doc.emoji.used['👍']).toEqual(good)
  })

  test('emoji keep at most the most frecent entries', () => {
    const mojis = Array.from({ length: MAX_USED + 30 }, (_, i) => String.fromCodePoint(0x1f400 + i))
    const used = Object.fromEntries(
      Array.from({ length: MAX_USED + 30 }, (_, i) => [
        mojis[i],
        { n: i + 1, at: NOW, last: mojis[i] },
      ])
    )
    const out = sanitizeConfig({ v: 1, emoji: { v: 1, tone: 2, used } }, NOW)
    if (!out.ok || !out.doc.emoji) throw new Error('rejected')
    expect(Object.keys(out.doc.emoji.used).length).toBe(MAX_USED)
    expect(out.doc.emoji.used[mojis[MAX_USED + 29]] === undefined).toBe(false)
    expect(out.doc.emoji.used[mojis[0]]).toBeUndefined()
  })
})

describe('building', () => {
  test('only chosen sections are written, and only known fields of each', () => {
    const src = source()
    const leaky = {
      ...src,
      layout: { ...src.layout, dmSeen: 99, token: 'tok' } as ConfigSource['layout'],
    }
    const doc = buildConfig(leaky, new Set<SectionKey>(['theme', 'layout']))
    expect(Object.keys(doc).sort()).toEqual(['layout', 'theme', 'v'])
    expect(JSON.stringify(doc).includes('tok')).toBe(false)
    expect(JSON.stringify(doc).includes('dmSeen')).toBe(false)
  })

  test('account sections are left out when the session has none', () => {
    const doc = buildConfig(source({ appearOffline: null, emoji: null }), ALL)
    expect(doc.appearOffline).toBeUndefined()
    expect(doc.emoji).toBeUndefined()
    expect(doc.theme).toBe('light')
  })

  test('link documents keep only sections allowed in links', () => {
    const doc = { ...buildConfig(source(), ALL), identity: 'x' } as ConfigDoc
    const link = linkDoc(doc)
    expect(Object.keys(link).sort()).toEqual(
      [
        'appearOffline',
        'calls',
        'emoji',
        'layout',
        'notify',
        'streamer',
        'theme',
        'typing',
        'v',
      ].sort()
    )
  })
})

describe('preview', () => {
  test('lists each section with the current and the incoming value', () => {
    const incoming = buildConfig(source(), ALL)
    const mine = source({
      theme: 'dark',
      streamer: true,
      layout: { servers: [], dmOrder: [], dmPinned: [], selfPin: 'auto' },
    })
    const rows = describeChanges(incoming, mine)
    const by = Object.fromEntries(rows.map(r => [r.key, r]))
    expect(rows.map(r => r.key)).toEqual([
      'theme',
      'streamer',
      'appearOffline',
      'layout',
      'notify',
      'emoji',
      'calls',
      'typing',
    ])
    expect([by.theme.now, by.theme.next, by.theme.same]).toEqual(['Dark', 'Light', false])
    expect([by.streamer.now, by.streamer.next, by.streamer.same]).toEqual(['On', 'On', true])
    expect(by.layout.next).toBe('3 servers, 1 folder, 1 pinned DM, 2 collapsed categories')
    expect(by.layout.now).toBe('Default order, 0 pinned DMs')
    expect(by.notify.next).toBe('3 custom settings')
    expect(by.emoji.next).toBe('2 frequent emoji, skin tone 3')
    expect([by.calls.next, by.calls.same]).toEqual(['Direct (P2P)', true])
    expect(by.notify.same).toBe(true)
    expect([by.typing.now, by.typing.next, by.typing.same]).toEqual(['Off', 'Off', true])
  })

  test('typing indicators travel as a plain switch', async () => {
    const doc = buildConfig(source({ typing: false }), new Set<SectionKey>(['typing']))
    expect(doc).toEqual({ v: 1, typing: false })
    expect(buildConfig(source({ typing: null }), ALL).typing).toBeUndefined()
    const decoded = await decodeConfig(await encodeConfig(doc))
    expect(decoded).toEqual({ ok: true, doc: { v: 1, typing: false } })
    for (const typing of ['no', 0, null, {}]) {
      const out = sanitizeConfig({ v: 1, typing })
      expect(out.ok && out.doc.typing).toBeUndefined()
    }
    const rows = describeChanges({ v: 1, typing: true }, source({ typing: false }))
    expect(rows).toEqual([
      { key: 'typing', label: 'Typing indicators', now: 'Off', next: 'On', same: false },
    ])
  })

  test('a logged-out device shows account sections as needing an account', () => {
    const rows = describeChanges(
      buildConfig(source(), ALL),
      source({ appearOffline: null, layout: null, notify: null, emoji: null })
    )
    const by = Object.fromEntries(rows.map(r => [r.key, r]))
    expect(by.appearOffline.now).toBeNull()
    expect(by.layout.now).toBeNull()
    expect(by.theme.now).toBe('Light')
  })
})

describe('links and stash', () => {
  test('paths and pasted links parse only 12-char base62 ids of this origin', () => {
    expect(configPath('AbC123xyz789')).toBe('/config/AbC123xyz789/')
    expect(parseConfigPath('/config/AbC123xyz789/')).toBe('AbC123xyz789')
    expect(parseConfigPath('/config/AbC123xyz789')).toBe('AbC123xyz789')
    for (const bad of ['/config/', '/config/short/', '/config/AbC123xyz78!/', '/config/a/b/'])
      expect(parseConfigPath(bad)).toBeNull()
    expect(
      parseConfigLink('https://chat.example/config/AbC123xyz789/', 'https://chat.example')
    ).toBe('AbC123xyz789')
    expect(
      parseConfigLink('https://evil.example/config/AbC123xyz789/', 'https://chat.example')
    ).toBeNull()
    expect(parseConfigLink('rc1.abc', 'https://chat.example')).toBeNull()
  })

  test('a stash is taken once, sanitized, and expires', () => {
    const mem = new Map<string, string>()
    const store = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    }
    const doc = buildConfig(source(), ALL)
    stashConfig(doc, ['layout', 'notify', 'bogus' as SectionKey], store, NOW)
    const got = takeStashedConfig(store, NOW + 1000)
    expect(got?.keys).toEqual(['layout', 'notify'])
    expect(got?.doc.layout).toEqual(doc.layout)
    expect(takeStashedConfig(store, NOW + 1000)).toBeNull()
    stashConfig(doc, ['layout'], store, NOW)
    expect(takeStashedConfig(store, NOW + STASH_MS)).toBeNull()
    expect(mem.size).toBe(0)
    mem.set('rchat_config_stash', '{bad')
    expect(takeStashedConfig(store, NOW)).toBeNull()
  })

  test('the inflated JSON is exactly the document', async () => {
    const doc = buildConfig(source(), new Set<SectionKey>(['theme', 'streamer']))
    expect(JSON.parse(await inflateRaw(await encodeConfig(doc)))).toEqual(doc)
  })
})
