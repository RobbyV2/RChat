import { describe, expect, test } from 'bun:test'
import {
  EXPIRY_PRESETS,
  USE_PRESETS,
  countdown,
  customExpiry,
  emptySecrets,
  isClosed,
  keepSecrets,
  parseSecrets,
  parseUses,
  secretFor,
  statusAt,
  tickMs,
  toLocalInput,
  usesLeftText,
  usesText,
  withSecret,
} from '../passwords'
import type { ServerPassword, ServerPasswords } from '../types'

const pw = (over: Partial<ServerPassword> = {}): ServerPassword => ({
  id: 1,
  label: null,
  created_by: 'alice',
  created_at: 0,
  expires_at: null,
  max_uses: null,
  uses: 0,
  status: 'live',
  ...over,
})

describe('presets', () => {
  test('match the brief', () => {
    expect(EXPIRY_PRESETS.map(p => p.label)).toEqual([
      '30 minutes',
      '1 hour',
      '6 hours',
      '12 hours',
      '1 day',
      '7 days',
      '30 days',
    ])
    expect(EXPIRY_PRESETS.map(p => p.seconds)).toEqual([
      1800, 3600, 21600, 43200, 86400, 604800, 2592000,
    ])
    expect(USE_PRESETS).toEqual([1, 2, 5, 10, 25, 100])
  })
})

describe('countdown', () => {
  test('reads like the invite card', () => {
    expect(countdown(1000 + 3 * 3600, 1000)).toBe('Expires in 3 hours')
    expect(countdown(1000 + 3 * 3600 - 20, 1000)).toBe('Expires in 3 hours')
    expect(countdown(1000 + 1800, 1000)).toBe('Expires in 30 minutes')
    expect(countdown(1000 + 86400, 1000)).toBe('Expires in 1 day')
    expect(countdown(1045, 1000)).toBe('Expires in 45 seconds')
    expect(countdown(1000, 1000)).toBe('Expired')
    expect(countdown(900, 1000)).toBe('Expired')
  })

  test('ticks every second near the end only', () => {
    expect(tickMs(30)).toBe(1000)
    expect(tickMs(120)).toBe(1000)
    expect(tickMs(121)).toBe(30_000)
  })
})

describe('uses', () => {
  test('limited uses read as a fraction, unlimited as a count', () => {
    expect(usesText(3, 10)).toBe('3/10')
    expect(usesText(0, 1)).toBe('0/1')
    expect(usesText(1, null)).toBe('1 use')
    expect(usesText(7, null)).toBe('7 uses')
  })

  test('uses left', () => {
    expect(usesLeftText(2)).toBe('2 uses left')
    expect(usesLeftText(1)).toBe('1 use left')
    expect(usesLeftText(-1)).toBe('0 uses left')
  })

  test('custom uses are whole numbers from 1 to 10000', () => {
    expect(parseUses('1')).toBe(1)
    expect(parseUses(' 250 ')).toBe(250)
    expect(parseUses('10000')).toBe(10000)
    for (const bad of ['0', '10001', '-1', '2.5', '', 'ten', '1e3'])
      expect(parseUses(bad)).toBeNull()
  })
})

describe('status', () => {
  test('a live password past its expiry reads expired before the next refresh', () => {
    expect(statusAt(pw({ expires_at: 100 }), 99)).toBe('live')
    expect(statusAt(pw({ expires_at: 100 }), 100)).toBe('expired')
    expect(statusAt(pw({ status: 'revoked', expires_at: 100 }), 200)).toBe('revoked')
  })

  test('closed means protected without a permanent or live password', () => {
    const s = (over: Partial<ServerPasswords>): ServerPasswords => ({
      protected: true,
      permanent: false,
      closed: false,
      passwords: [],
      ...over,
    })
    expect(isClosed(s({}), 0)).toBe(true)
    expect(isClosed(s({ permanent: true }), 0)).toBe(false)
    expect(isClosed(s({ protected: false }), 0)).toBe(false)
    expect(isClosed(s({ passwords: [pw()] }), 0)).toBe(false)
    expect(isClosed(s({ passwords: [pw({ expires_at: 5 })] }), 10)).toBe(true)
    expect(isClosed(s({ passwords: [pw({ status: 'used_up' })] }), 0)).toBe(true)
  })
})

describe('custom expiry', () => {
  const now = new Date(2026, 9, 27, 12, 0).getTime()
  test('round trips through the datetime input', () => {
    const local = toLocalInput(now + 2 * 3600 * 1000)
    expect(local).toBe('2026-10-27T14:00')
    expect(customExpiry(local, now)).toEqual({ at: Math.floor(now / 1000) + 7200, error: null })
  })

  test('must be at least a minute and at most a year away', () => {
    expect(customExpiry('', now).error).toBe('Pick a date and time')
    expect(customExpiry('nonsense', now).error).toBe('Pick a date and time')
    expect(customExpiry(toLocalInput(now), now).error).toBe('Pick a time at least a minute away')
    expect(customExpiry(toLocalInput(now + 400 * 86400 * 1000), now).error).toBe(
      'Pick a time within a year'
    )
  })
})

describe('secret book', () => {
  test('bad or foreign data falls back to empty', () => {
    for (const raw of [null, '', '{', '[]', '{"v":2,"servers":{}}', '{"v":1,"servers":[]}'])
      expect(parseSecrets(raw)).toEqual(emptySecrets())
  })

  test('drops malformed entries', () => {
    const raw = JSON.stringify({
      v: 1,
      servers: { club: { '1': 'a-b-c-d', x: 'bad', '2': 5, '3': '' }, empty: {}, junk: 4 },
    })
    expect(parseSecrets(raw)).toEqual({ v: 1, servers: { club: { '1': 'a-b-c-d' } } })
  })

  test('stores, finds and prunes by live ids', () => {
    let book = withSecret(emptySecrets(), 'club', 4, 'one')
    book = withSecret(book, 'club', 9, 'two')
    book = withSecret(book, 'den', 1, 'three')
    expect(secretFor(book, 'club', 9)).toBe('two')
    expect(secretFor(book, 'club', 5)).toBeNull()
    expect(parseSecrets(JSON.stringify(book))).toEqual(book)
    book = keepSecrets(book, 'club', [9])
    expect(secretFor(book, 'club', 4)).toBeNull()
    expect(secretFor(book, 'club', 9)).toBe('two')
    book = keepSecrets(book, 'den', [])
    expect(book.servers.den).toBeUndefined()
  })
})
