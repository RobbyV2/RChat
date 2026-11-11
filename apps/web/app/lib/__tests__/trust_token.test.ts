import { describe, expect, test } from 'bun:test'
import {
  clockOffset,
  expired,
  fromHeaders,
  fromSignIn,
  fromTokenAnswer,
  offsetOf,
  parseStored,
  pushOffset,
  renewDue,
  serialize,
  usable,
  type Trust,
} from '../trust/token'

const ISSUED = 1_767_225_610
const TRUST: Trust = {
  token: 't1.1.eyJ2IjoxfQ.3zNRILTD7EPHkOT1Xs2Rjw',
  kind: 'general',
  expiresAt: ISSUED + 43_200,
  budget: 30_000,
  remaining: 30_000,
  renewAt: ISSUED + 34_560,
}
const at = (seconds: number) => seconds * 1000
const headers = (h: Record<string, string>) => ({
  get: (name: string) => h[name.toLowerCase()] ?? null,
})

describe('stored tokens', () => {
  test('a token survives being stored', () => {
    expect(JSON.parse(serialize(TRUST))).toEqual({ v: 1, ...TRUST })
    expect(parseStored(serialize(TRUST))).toEqual(TRUST)
    expect(parseStored(serialize({ ...TRUST, kind: 'signin', remaining: 0 }))).toEqual({
      ...TRUST,
      kind: 'signin',
      remaining: 0,
    })
  })

  test('nothing stored, bad JSON, another version or a missing field is no token', () => {
    const stored = { v: 1, ...TRUST }
    for (const raw of [
      null,
      '',
      'not json',
      '{',
      'null',
      '[]',
      '"t1.1.x.y"',
      JSON.stringify({ ...stored, v: 0 }),
      JSON.stringify({ ...stored, v: 2 }),
      JSON.stringify({ ...TRUST }),
      JSON.stringify({ ...stored, token: undefined }),
      JSON.stringify({ ...stored, token: '' }),
      JSON.stringify({ ...stored, token: 'c1.1.x.y' }),
      JSON.stringify({ ...stored, token: 7 }),
      JSON.stringify({ ...stored, kind: 'page' }),
      JSON.stringify({ ...stored, kind: undefined }),
      JSON.stringify({ ...stored, expiresAt: '1767268810' }),
      JSON.stringify({ ...stored, expiresAt: undefined }),
      JSON.stringify({ ...stored, expiresAt: -1 }),
      JSON.stringify({ ...stored, budget: null }),
      JSON.stringify({ ...stored, budget: 1.5 }),
      JSON.stringify({ ...stored, remaining: undefined }),
      JSON.stringify({ ...stored, remaining: -1 }),
      JSON.stringify({ ...stored, renewAt: 'soon' }),
    ])
      expect(parseStored(raw)).toBeNull()
  })

  test('fields it does not know are dropped', () => {
    expect(parseStored(JSON.stringify({ v: 1, ...TRUST, session: 'secret' }))).toEqual(TRUST)
  })
})

describe('renewDue', () => {
  test('at 80% of the life', () => {
    expect(renewDue(TRUST, at(ISSUED))).toBe(false)
    expect(renewDue(TRUST, at(TRUST.renewAt) - 1)).toBe(false)
    expect(renewDue(TRUST, at(TRUST.renewAt))).toBe(true)
    expect(renewDue(TRUST, at(TRUST.expiresAt + 5))).toBe(true)
  })

  test('with 20% of the budget or less left', () => {
    expect(renewDue({ ...TRUST, remaining: 6001 }, at(ISSUED))).toBe(false)
    expect(renewDue({ ...TRUST, remaining: 6000 }, at(ISSUED))).toBe(true)
    expect(renewDue({ ...TRUST, remaining: 0 }, at(ISSUED))).toBe(true)
    expect(renewDue({ ...TRUST, kind: 'signin', budget: 10, remaining: 3 }, at(ISSUED))).toBe(false)
    expect(renewDue({ ...TRUST, kind: 'signin', budget: 10, remaining: 2 }, at(ISSUED))).toBe(true)
  })

  test('once the server said X-Trust-Renew', () => {
    const seen = fromHeaders(TRUST, headers({ 'x-trust-remaining': '29990', 'x-trust-renew': '1' }))
    expect(renewDue(seen, at(ISSUED))).toBe(true)
    expect(renewDue(parseStored(serialize(seen))!, at(ISSUED))).toBe(true)
  })
})

describe('fromHeaders', () => {
  test('takes what is left from X-Trust-Remaining', () => {
    expect(fromHeaders(TRUST, headers({ 'x-trust-remaining': '29412' }))).toEqual({
      ...TRUST,
      remaining: 29_412,
    })
    expect(fromHeaders(TRUST, headers({ 'x-trust-remaining': '0' })).remaining).toBe(0)
  })

  test('a response without the headers, or with nonsense in them, changes nothing', () => {
    expect(fromHeaders(TRUST, headers({}))).toBe(TRUST)
    for (const value of ['', 'many', '-4', '1.5', '1e3', ' '])
      expect(fromHeaders(TRUST, headers({ 'x-trust-remaining': value }))).toBe(TRUST)
    expect(fromHeaders(TRUST, headers({ 'x-trust-renew': '0' }))).toBe(TRUST)
  })

  test('what is left never grows past the budget', () => {
    expect(fromHeaders(TRUST, headers({ 'x-trust-remaining': '99999999' })).remaining).toBe(30_000)
  })
})

describe('the server clock', () => {
  const DATE = 'Thu, 01 Jan 2026 00:00:10 GMT'
  const SERVER = Date.parse(DATE)

  test('clockOffset is how far the server is ahead of this device', () => {
    expect(clockOffset(DATE, SERVER)).toBe(0)
    expect(clockOffset(DATE, SERVER + 7_200_000)).toBe(-7_200_000)
    expect(clockOffset(DATE, SERVER - 90_000)).toBe(90_000)
    for (const header of [null, '', 'yesterday']) expect(clockOffset(header, SERVER)).toBeNull()
  })

  test('the offset is the median of the last 5 samples', () => {
    expect(offsetOf([])).toBe(0)
    expect(offsetOf([400])).toBe(400)
    expect(offsetOf([400, 600])).toBe(500)
    expect(offsetOf([900, -100, 300])).toBe(300)
    let samples: number[] = []
    for (const s of [1, 2, 3, 4, 5, 6, 7_000_000]) samples = pushOffset(samples, s)
    expect(samples).toEqual([3, 4, 5, 6, 7_000_000])
    expect(offsetOf(samples)).toBe(5)
    const before = [1, 2]
    expect(pushOffset(before, 3)).toEqual([1, 2, 3])
    expect(before).toEqual([1, 2])
  })

  test('a device clock 2 hours fast still sees an expired token as expired', () => {
    const device = at(TRUST.expiresAt + 60) + 7_200_000
    const offset = offsetOf(
      pushOffset([], clockOffset(new Date(at(TRUST.expiresAt + 60)).toUTCString(), device)!)
    )
    expect(expired(TRUST, device + offset)).toBe(true)
    expect(usable(TRUST, device + offset)).toBe(false)
  })

  test('a device clock 2 hours slow does not make a dead token look fresh', () => {
    const device = at(TRUST.expiresAt + 60) - 7_200_000
    expect(expired(TRUST, device)).toBe(false)
    const offset = offsetOf(
      pushOffset([], clockOffset(new Date(at(TRUST.expiresAt + 60)).toUTCString(), device)!)
    )
    expect(expired(TRUST, device + offset)).toBe(true)
    expect(renewDue(TRUST, device + offset)).toBe(true)
  })

  test('a device clock 2 hours fast does not throw a fresh token away', () => {
    const device = at(ISSUED + 60) + 7_200_000
    const offset = offsetOf(
      pushOffset([], clockOffset(new Date(at(ISSUED + 60)).toUTCString(), device)!)
    )
    expect(expired(TRUST, device + offset)).toBe(false)
    expect(usable(TRUST, device + offset)).toBe(true)
    expect(renewDue(TRUST, device + offset)).toBe(false)
  })
})

describe('usable', () => {
  test('until it expires or runs out', () => {
    expect(usable(TRUST, at(ISSUED))).toBe(true)
    expect(usable(TRUST, at(TRUST.expiresAt) - 1)).toBe(true)
    expect(usable(TRUST, at(TRUST.expiresAt))).toBe(false)
    expect(usable({ ...TRUST, remaining: 1 }, at(ISSUED))).toBe(true)
    expect(usable({ ...TRUST, remaining: 0 }, at(ISSUED))).toBe(false)
  })
})

describe('tokens from answers', () => {
  const answer = {
    token: TRUST.token,
    kind: 'general',
    expires_at: TRUST.expiresAt,
    budget: 30_000,
    renew_at: TRUST.renewAt,
    level: 1_048_576,
  }

  test('POST /pow/token', () => {
    expect(fromTokenAnswer(answer)).toEqual(TRUST)
    expect(fromTokenAnswer({ ...answer, kind: 'signin', budget: 10 })).toEqual({
      ...TRUST,
      kind: 'signin',
      budget: 10,
      remaining: 10,
    })
  })

  test('the trust field of a sign-in answer is a general token for the new session', () => {
    const { kind: _kind, ...trust } = answer
    expect(fromSignIn({ token: 'session', user: { id: 1 }, trust })).toEqual(TRUST)
  })

  test('answers without one, or with a broken one, give no token', () => {
    for (const body of [
      null,
      undefined,
      'x',
      {},
      { token: 'session', user: {} },
      { trust: null },
      { trust: 't1.1.x.y' },
      { trust: { ...answer, token: 'g1.1.x.y' } },
      { trust: { ...answer, expires_at: 'never' } },
      { trust: { ...answer, budget: undefined } },
      { trust: { ...answer, renew_at: null } },
    ])
      expect(fromSignIn(body)).toBeNull()
    for (const body of [
      null,
      {},
      { ...answer, kind: 'page' },
      { ...answer, token: 7 },
      { error: 'x' },
    ])
      expect(fromTokenAnswer(body)).toBeNull()
  })
})
