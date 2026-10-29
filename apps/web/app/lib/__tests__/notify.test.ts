import { describe, expect, test } from 'bun:test'
import {
  EMPTY_NOTIFY,
  MUTE_CHOICES,
  extendMute,
  keepScopes,
  messageAlert,
  muteEnd,
  muteUntilFor,
  mutedText,
  nextExpiry,
  notifyKey,
  notifyValue,
  parseNotify,
  pingShown,
  pingToast,
  pruneNotify,
  renameServerRule,
  resetAll,
  resetScope,
  resolve,
  ruleSummary,
  scopeOfKey,
  setDesktop,
  setLevel,
  setMute,
  unreadShown,
  type NotifyScope,
} from '../notify'

const NOW = new Date(2026, 9, 28, 14, 0).getTime()
const server: NotifyScope = { kind: 'server', name: 's' }
const chan: NotifyScope = { kind: 'channel', id: 1, server: 's' }
const dm: NotifyScope = { kind: 'dm', id: 4 }

describe('defaults', () => {
  test('servers and their channels: only @mentions; DMs: all messages; nothing muted', () => {
    expect(resolve(EMPTY_NOTIFY, server, NOW)).toEqual({ level: 'mentions', muted: false })
    expect(resolve(EMPTY_NOTIFY, chan, NOW)).toEqual({ level: 'mentions', muted: false })
    expect(resolve(EMPTY_NOTIFY, dm, NOW)).toEqual({ level: 'all', muted: false })
    expect(resolve(EMPTY_NOTIFY, { kind: 'channel', id: 9, server: null }, NOW).level).toBe(
      'mentions'
    )
  })

  test('the store key is per account, guests share one', () => {
    expect(notifyKey('bob')).toBe('rchat_notify:bob')
    expect(notifyKey(null)).toBe('rchat_notify:guest')
  })
})

describe('resolution', () => {
  test('channel rule, then server rule, then the default', () => {
    let p = setLevel(EMPTY_NOTIFY, server, 'all')
    expect(resolve(p, chan, NOW).level).toBe('all')
    p = setLevel(p, chan, 'nothing')
    expect(resolve(p, chan, NOW).level).toBe('nothing')
    expect(resolve(p, { kind: 'channel', id: 2, server: 's' }, NOW).level).toBe('all')
    p = setLevel(p, chan, null)
    expect(resolve(p, chan, NOW).level).toBe('all')
  })

  test('a muted server mutes its channels; a muted channel leaves the server alone', () => {
    const p = setMute(EMPTY_NOTIFY, server, NOW + 1000)
    expect(resolve(p, chan, NOW).muted).toBe(true)
    expect(muteEnd(p, chan, NOW)).toBeNull()
    const q = setMute(EMPTY_NOTIFY, chan, 'forever')
    expect(resolve(q, chan, NOW).muted).toBe(true)
    expect(resolve(q, server, NOW).muted).toBe(false)
    expect(muteEnd(q, chan, NOW)).toBe('forever')
  })

  test('expired mutes are ignored', () => {
    const p = setMute(EMPTY_NOTIFY, dm, NOW - 1)
    expect(resolve(p, dm, NOW).muted).toBe(false)
    expect(muteEnd(p, dm, NOW)).toBeNull()
    expect(resolve(setMute(EMPTY_NOTIFY, dm, NOW + 1), dm, NOW).muted).toBe(true)
  })

  test('levels equal to the default are not stored for servers and DMs', () => {
    expect(setLevel(EMPTY_NOTIFY, server, 'mentions')).toBe(EMPTY_NOTIFY)
    expect(setLevel(EMPTY_NOTIFY, dm, 'all')).toBe(EMPTY_NOTIFY)
    expect(setLevel(EMPTY_NOTIFY, chan, 'mentions').channels).toEqual({ 1: { level: 'mentions' } })
    const p = setLevel(EMPTY_NOTIFY, dm, 'nothing')
    expect(p.dms).toEqual({ 4: { level: 'nothing' } })
    expect(setLevel(p, dm, 'all').dms).toEqual({})
  })

  test('mute and level live side by side; unmuting keeps the level', () => {
    let p = setLevel(EMPTY_NOTIFY, dm, 'mentions')
    p = setMute(p, dm, 'forever')
    expect(p.dms[4]).toEqual({ level: 'mentions', muteUntil: 'forever' })
    p = setMute(p, dm, null)
    expect(p.dms[4]).toEqual({ level: 'mentions' })
    expect(resetScope(p, dm).dms).toEqual({})
  })

  test('reset all keeps the desktop switch', () => {
    const p = setDesktop(setMute(setLevel(EMPTY_NOTIFY, server, 'all'), dm, 'forever'), true)
    expect(resetAll(p)).toEqual({ ...EMPTY_NOTIFY, desktop: true })
  })
})

describe('mute durations', () => {
  test('exact choices', () => {
    expect(MUTE_CHOICES.map(c => c.label)).toEqual([
      '15 minutes',
      '1 hour',
      '3 hours',
      '8 hours',
      '24 hours',
      'Until I turn it back on',
    ])
    expect(MUTE_CHOICES.map(c => muteUntilFor(c.ms, NOW))).toEqual([
      NOW + 15 * 60_000,
      NOW + 3_600_000,
      NOW + 3 * 3_600_000,
      NOW + 8 * 3_600_000,
      NOW + 24 * 3_600_000,
      'forever',
    ])
  })

  test('muted subtitle: time today, date otherwise, forever', () => {
    const at = new Date(2026, 9, 28, 16, 30).getTime()
    expect(mutedText(at, NOW, 'en-US')).toBe('Muted until 4:30 PM')
    const tomorrow = new Date(2026, 9, 29, 9, 5).getTime()
    expect(mutedText(tomorrow, NOW, 'en-US')).toBe('Muted until Oct 29, 9:05 AM')
    expect(mutedText('forever', NOW)).toBe('Muted until you turn it back on')
  })

  test('rule summaries', () => {
    const at = new Date(2026, 9, 28, 16, 30).getTime()
    expect(ruleSummary({ level: 'nothing' }, NOW)).toBe('Nothing')
    expect(ruleSummary({ muteUntil: at }, NOW, 'en-US')).toBe('Muted until 4:30 PM')
    expect(ruleSummary({ level: 'all', muteUntil: 'forever' }, NOW)).toBe(
      'All messages, muted until you turn it back on'
    )
    expect(ruleSummary({ muteUntil: NOW - 1 }, NOW)).toBe('Default')
  })
})

describe('expiry and pruning', () => {
  test('next expiry is the earliest running timed mute', () => {
    let p = setMute(EMPTY_NOTIFY, server, NOW + 5000)
    p = setMute(p, chan, NOW + 2000)
    p = setMute(p, dm, 'forever')
    p = setMute(p, { kind: 'dm', id: 5 }, NOW - 10)
    expect(nextExpiry(p, NOW)).toBe(NOW + 2000)
    expect(nextExpiry(p, NOW + 2000)).toBe(NOW + 5000)
    expect(nextExpiry(p, NOW + 5000)).toBeNull()
    expect(nextExpiry(EMPTY_NOTIFY, NOW)).toBeNull()
  })

  test('prune drops expired mutes, keeps levels, and is a no-op otherwise', () => {
    let p = setLevel(setMute(EMPTY_NOTIFY, server, NOW + 1000), server, 'all')
    p = setMute(p, chan, NOW + 1000)
    p = setMute(p, dm, 'forever')
    expect(pruneNotify(p, NOW)).toBe(p)
    const later = pruneNotify(p, NOW + 1000)
    expect(later.servers).toEqual({ s: { level: 'all' } })
    expect(later.channels).toEqual({})
    expect(later.dms).toEqual({ 4: { muteUntil: 'forever' } })
    expect(later.dms).toBe(p.dms)
  })
})

describe('parsing', () => {
  test('round trip', () => {
    const p = setDesktop(setLevel(setMute(EMPTY_NOTIFY, chan, NOW + 60_000), server, 'all'), true)
    expect(parseNotify(notifyValue(p), NOW)).toEqual(p)
  })

  test('bad input gives defaults', () => {
    for (const raw of [null, '', '{', 'null', '[]', '"x"', '{"v":2}', '{"servers":{}}'])
      expect(parseNotify(raw, NOW)).toEqual(EMPTY_NOTIFY)
  })

  test('bad entries are dropped, good ones kept; expired mutes pruned on read', () => {
    const raw = JSON.stringify({
      v: 1,
      servers: { s: { level: 'loud' }, t: { level: 'all', muteUntil: -5 }, '': { level: 'all' } },
      channels: {
        1: { muteUntil: NOW - 1 },
        x: { level: 'all' },
        2: 'all',
        3: { level: 'nothing' },
      },
      dms: { 4: { muteUntil: 'forever', extra: 1 }, 5: { muteUntil: 'later' } },
      desktop: 'yes',
    })
    expect(parseNotify(raw, NOW)).toEqual({
      v: 1,
      servers: { t: { level: 'all' } },
      channels: { 3: { level: 'nothing' } },
      dms: { 4: { muteUntil: 'forever' } },
      desktop: false,
    })
  })
})

describe('effects', () => {
  const p = setMute(
    setLevel(setLevel(EMPTY_NOTIFY, server, 'nothing'), dm, 'mentions'),
    chan,
    'forever'
  )

  test('scope keys map to rules', () => {
    expect(scopeOfKey('c1', 's')).toEqual(chan)
    expect(scopeOfKey('d4', null)).toEqual(dm)
    expect(scopeOfKey('t5', null)).toBeNull()
    expect(scopeOfKey('cx', null)).toBeNull()
  })

  test('pings badge unless the level is Nothing, muted or not', () => {
    expect(pingShown(p, 'c1', 's')).toBe(false)
    expect(pingShown(p, 'c2', 's')).toBe(false)
    expect(pingShown(p, 'c2', 'other')).toBe(true)
    expect(pingShown(setMute(EMPTY_NOTIFY, dm, 'forever'), 'd4', null)).toBe(true)
  })

  test('unread dots hide only while muted', () => {
    expect(unreadShown(p, 'c1', 's', NOW)).toBe(false)
    expect(unreadShown(p, 'c2', 's', NOW)).toBe(true)
    expect(unreadShown(p, 'd4', null, NOW)).toBe(true)
  })

  test('toasts', () => {
    expect(pingToast({ level: 'mentions', muted: false })).toBe(true)
    expect(pingToast({ level: 'all', muted: true })).toBe(false)
    expect(pingToast({ level: 'nothing', muted: false })).toBe(false)
    expect(messageAlert({ level: 'all', muted: false }, false)).toBe(true)
    expect(messageAlert({ level: 'all', muted: false }, true)).toBe(false)
    expect(messageAlert({ level: 'all', muted: true }, false)).toBe(false)
    expect(messageAlert({ level: 'mentions', muted: false }, false)).toBe(false)
  })
})

describe('untrusted documents', () => {
  test('prototype keys never reach Object.prototype or shadow lookups', () => {
    const raw =
      '{"v":1,"servers":{"__proto__":{"level":"all"},"constructor":{"muteUntil":"forever"}},' +
      '"channels":{"__proto__":{"level":"nothing"}},"dms":{"__proto__":{"level":"nothing"}},' +
      '"desktop":true}'
    const p = parseNotify(raw, NOW)
    expect(({} as Record<string, unknown>).level).toBeUndefined()
    expect(Object.keys(p.servers)).toEqual(['constructor'])
    expect(Object.keys(p.channels)).toEqual([])
    expect(resolve(p, { kind: 'server', name: 'constructor' }, NOW).muted).toBe(true)
    for (const name of ['toString', 'hasOwnProperty', '__proto__', 'valueOf'])
      expect(resolve(p, { kind: 'server', name }, NOW)).toEqual({ level: 'mentions', muted: false })
    expect(resolve(EMPTY_NOTIFY, { kind: 'server', name: 'constructor' }, NOW).muted).toBe(false)
    const set = setLevel(p, { kind: 'server', name: '__proto__' }, 'all')
    expect(set).toBe(p)
    expect(parseNotify(notifyValue(p), NOW)).toEqual(p)
  })
})

describe('folder mute', () => {
  test('only extends: longer and forever mutes stay', () => {
    const a: NotifyScope = { kind: 'server', name: 'a' }
    const b: NotifyScope = { kind: 'server', name: 'b' }
    let p = setMute(setMute(EMPTY_NOTIFY, a, NOW + 3_600_000), b, 'forever')
    p = extendMute(p, a, NOW + 900_000, NOW)
    p = extendMute(p, b, NOW + 900_000, NOW)
    expect(muteEnd(p, a, NOW)).toBe(NOW + 3_600_000)
    expect(muteEnd(p, b, NOW)).toBe('forever')
    p = extendMute(p, a, NOW + 7_200_000, NOW)
    expect(muteEnd(p, a, NOW)).toBe(NOW + 7_200_000)
    p = extendMute(p, a, 'forever', NOW)
    expect(muteEnd(p, a, NOW)).toBe('forever')
    expect(muteEnd(extendMute(EMPTY_NOTIFY, a, NOW + 1, NOW), a, NOW)).toBe(NOW + 1)
  })
})

describe('membership', () => {
  const p = setLevel(
    setMute(setMute(setMute(EMPTY_NOTIFY, server, 'forever'), chan, 'forever'), dm, 'forever'),
    { kind: 'server', name: 'gone' },
    'all'
  )

  test('rules for scopes left behind are dropped', () => {
    const kept = keepScopes(p, {
      server: name => name === 's',
      channel: id => id !== 1,
      dm: () => false,
    })
    expect(Object.keys(kept.servers)).toEqual(['s'])
    expect(kept.channels).toEqual({})
    expect(kept.dms).toEqual({})
    expect(kept.desktop).toBe(p.desktop)
  })

  test('identity when everything is kept', () => {
    const all = { server: () => true, channel: () => true, dm: () => true }
    expect(keepScopes(p, all)).toBe(p)
  })

  test('a renamed server keeps its rule', () => {
    const r = renameServerRule(p, 's', 't')
    expect(resolve(r, { kind: 'server', name: 't' }, NOW).muted).toBe(true)
    expect(resolve(r, server, NOW).muted).toBe(false)
    expect(renameServerRule(p, 'none', 't')).toBe(p)
  })
})
