import { describe, expect, test } from 'bun:test'
import {
  EMPTY_HOME,
  RECENTS_MAX,
  TIPS,
  dismissTip,
  dropRecent,
  greeting,
  homeValue,
  isNewAccount,
  parseHome,
  pushRecent,
  shownTips,
  unreadChannels,
  unreadRows,
} from '../home'
import { paletteShortcut, registerPalette, usePalette } from '../palette'

const names = { channel: null, serverName: null }

describe('home prefs', () => {
  test('bad or foreign data gives the defaults', () => {
    for (const raw of [null, '', '{', '[]', '"x"', '{"v":2,"recents":[]}', 'null'])
      expect(parseHome(raw)).toEqual(EMPTY_HOME)
  })

  test('parsing keeps valid entries only, deduplicated and capped', () => {
    const recents = [
      { kind: 'dm', dmId: 3, at: 5 },
      { kind: 'dm', dmId: 3, at: 4 },
      { kind: 'dm', dmId: -1, at: 4 },
      { kind: 'channel', server: '', channelId: 2 },
      { kind: 'channel', server: 's', channelId: 2, channel: 'x'.repeat(500), serverName: 7 },
      'junk',
      ...Array.from({ length: 30 }, (_, i) => ({ kind: 'dm', dmId: 100 + i, at: 1 })),
    ]
    const out = parseHome(JSON.stringify({ v: 1, recents, tips: ['a', 'a', 3, 'b'] }))
    expect(out.recents).toHaveLength(RECENTS_MAX)
    expect(out.recents[0]).toEqual({ kind: 'dm', dmId: 3, at: 5 })
    expect(out.recents[1]).toEqual({
      kind: 'channel',
      server: 's',
      channelId: 2,
      channel: 'x'.repeat(100),
      serverName: null,
      at: 0,
    })
    expect(out.tips).toEqual(['a', 'b'])
    expect(parseHome(homeValue(out))).toEqual(out)
  })

  test('a visit goes first, keeps earlier names and drops the oldest past the cap', () => {
    let p = pushRecent(
      EMPTY_HOME,
      { kind: 'channel', server: 's', channelId: 1 },
      { channel: 'general', serverName: 'Space' },
      1
    )
    p = pushRecent(p, { kind: 'dm', dmId: 9 }, names, 2)
    p = pushRecent(p, { kind: 'channel', server: 's', channelId: 1 }, names, 3)
    expect(p.recents).toEqual([
      {
        kind: 'channel',
        server: 's',
        channelId: 1,
        channel: 'general',
        serverName: 'Space',
        at: 3,
      },
      { kind: 'dm', dmId: 9, at: 2 },
    ])
    for (let i = 0; i < 20; i++) p = pushRecent(p, { kind: 'dm', dmId: 50 + i }, names, 10 + i)
    expect(p.recents).toHaveLength(RECENTS_MAX)
    expect(p.recents[0]).toEqual({ kind: 'dm', dmId: 69, at: 29 })
    expect(dropRecent(p, 'd69').recents[0]).toEqual({ kind: 'dm', dmId: 68, at: 28 })
    expect(dropRecent(p, 'd1')).toBe(p)
  })

  test('dismissed tips stay dismissed and the next ones show', () => {
    expect(shownTips(EMPTY_HOME).map(t => t.id)).toEqual([TIPS[0].id, TIPS[1].id])
    const p = dismissTip(EMPTY_HOME, TIPS[0].id)
    expect(dismissTip(p, TIPS[0].id)).toBe(p)
    expect(shownTips(p).map(t => t.id)).toEqual([TIPS[1].id, TIPS[2].id])
    const all = TIPS.reduce((acc, t) => dismissTip(acc, t.id), EMPTY_HOME)
    expect(shownTips(parseHome(homeValue(all)))).toEqual([])
  })

  test('tips are short plain text without em dashes', () => {
    for (const t of TIPS) {
      expect(t.text.length < 80).toBe(true)
      expect(t.text.includes('—')).toBe(false)
      expect(t.text.includes('RChat')).toBe(false)
    }
  })
})

describe('home helpers', () => {
  test('greeting by hour', () => {
    expect(greeting(6)).toBe('Good morning')
    expect(greeting(13)).toBe('Good afternoon')
    expect(greeting(20)).toBe('Good evening')
    expect(greeting(2)).toBe('Good evening')
  })

  test('a new account has no visits, no DMs and only the default server', () => {
    expect(isNewAccount(0, 0, 1)).toBe(true)
    expect(isNewAccount(0, 0, 0)).toBe(true)
    expect(isNewAccount(1, 0, 1)).toBe(false)
    expect(isNewAccount(0, 1, 1)).toBe(false)
    expect(isNewAccount(0, 0, 2)).toBe(false)
  })

  test('unread channels are counted per server, muted ones left out', () => {
    const reads = {
      c1: { lastRead: 1, latest: 2, server: 'a' },
      c2: { lastRead: 1, latest: 3, server: 'a' },
      c3: { lastRead: 3, latest: 3, server: 'a' },
      c4: { lastRead: 0, latest: 3, server: 'b' },
      c5: { lastRead: 0, latest: 3 },
      d6: { lastRead: 0, latest: 3 },
    }
    expect(unreadChannels(reads, () => true)).toEqual({ a: 2, b: 1 })
    expect(unreadChannels(reads, s => s !== 'c4')).toEqual({ a: 2 })
  })

  test('servers that ping come first, the rest keep their order', () => {
    expect(
      unreadRows([
        { name: 'a', pings: 0, channels: 2 },
        { name: 'b', pings: 0, channels: 0 },
        { name: 'c', pings: 3, channels: 1 },
        { name: 'd', pings: 0, channels: 1 },
        { name: 'e', pings: 1, channels: 0 },
      ]).map(r => r.name)
    ).toEqual(['c', 'e', 'a', 'd'])
  })
})

describe('palette registry', () => {
  test('nothing offers the palette until it registers', () => {
    expect(usePalette.getState().open).toBe(null)
    const open = () => {}
    registerPalette(open)
    expect(usePalette.getState().open).toBe(open)
    registerPalette(null)
    expect(usePalette.getState().open).toBe(null)
    expect(paletteShortcut(true)).toBe('⌘K')
    expect(paletteShortcut(false)).toBe('Ctrl+K')
  })
})
