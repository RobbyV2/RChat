import { describe, expect, test } from 'bun:test'
import type { TrustKind } from '../trust/policy'
import { RESOLVE_BACKOFF_MS, parseRequired, withTrust, type Outgoing } from '../trust/retry'
import type { Trust } from '../trust/token'

const ORIGIN = 'https://chat.example.com'
const CLIENT = 'AAECAwQFBgcICQoLDA0ODw'
const NOW = 1_767_225_610_000
const BEARER = { Authorization: 'Bearer session-token' }

interface Answer {
  status: number
  headers: { get(name: string): string | null }
}
const answer = (status: number, headers: Record<string, string> = {}): Answer => ({
  status,
  headers: { get: name => headers[name.toLowerCase()] ?? null },
})
const ok = (headers: Record<string, string> = {}) => answer(200, headers)
const refused = (required = 'general') =>
  answer(429, { 'x-trust-required': required, 'retry-after': '300' })
const limited = () => answer(429, { 'retry-after': '7' })

const trust = (n: number, kind: TrustKind = 'general'): Trust => ({
  token: `t1.1.${kind}${n}.tag`,
  kind,
  expiresAt: NOW / 1000 + 3600,
  budget: 3000,
  remaining: 3000,
  renewAt: NOW / 1000 + 2880,
})

const rig = (
  script: Answer[],
  start: {
    general?: Trust
    signin?: Trust
    advertised?: boolean
    wanted?: boolean
    solves?: boolean
  } = {}
) => {
  const sent: { url: string; headers: Record<string, string> }[] = []
  const solves: { kind: TrustKind; priority: string; minWork?: number }[] = []
  const sleeps: number[] = []
  const dates: (string | null)[] = []
  const tokens: Record<TrustKind, Trust | null> = {
    general: start.general ?? null,
    signin: start.signin ?? null,
  }
  let minted = 0
  const send = withTrust(
    async (req: Outgoing) => {
      sent.push({ url: req.url, headers: { ...req.headers } })
      return script.shift() ?? ok()
    },
    {
      origin: ORIGIN,
      advertised: () => start.advertised !== false,
      wants: () => start.wanted !== false,
      clientId: () => CLIENT,
      token: kind => tokens[kind],
      setToken: (kind, t) => {
        tokens[kind] = t
      },
      solve: async (kind, ask) => {
        solves.push({ kind, ...ask })
        await Promise.resolve()
        if (start.solves === false) return null
        minted += 1
        tokens[kind] = trust(minted, kind)
        return tokens[kind]
      },
      serverNow: () => NOW,
      sleep: async ms => {
        sleeps.push(ms)
      },
      date: header => dates.push(header),
    }
  )
  const header = (name: string): (string | null)[] => sent.map(s => s.headers[name] ?? null)
  const carried = () => header('X-Trust-Token')
  return { send, sent, solves, sleeps, dates, tokens, carried, header }
}

const GET = { url: `${ORIGIN}/api/v1/servers/lobby`, headers: BEARER }

describe('parseRequired', () => {
  test('reads the kind and an optional level', () => {
    expect(parseRequired('general')).toEqual({ kind: 'general', level: null })
    expect(parseRequired('signin')).toEqual({ kind: 'signin', level: null })
    expect(parseRequired('general; level=4194304')).toEqual({ kind: 'general', level: 4_194_304 })
    expect(parseRequired(' General ;LEVEL=8 ')).toEqual({ kind: 'general', level: 8 })
  })

  test('anything else is no trust refusal', () => {
    for (const header of [null, '', 'page', 'bearer', 'general signin'])
      expect(parseRequired(header)).toBeNull()
    for (const header of [
      'general; level=',
      'general; level=-4',
      'general; level=1e9',
      'general; x=1',
    ])
      expect(parseRequired(header)).toEqual({ kind: 'general', level: null })
  })
})

describe('withTrust', () => {
  test('sends the token it holds and reads what is left', async () => {
    const r = rig([ok({ 'x-trust-remaining': '2999' })], { general: trust(0) })
    const res = await r.send(GET)
    expect(res.status).toBe(200)
    expect(r.sent).toEqual([
      { url: GET.url, headers: { ...BEARER, 'X-Trust-Token': 't1.1.general0.tag' } },
    ])
    expect(r.solves).toEqual([])
    expect(r.tokens.general).toEqual({ ...trust(0), remaining: 2999 })
  })

  test('notes X-Trust-Renew so the session renews', async () => {
    const r = rig([ok({ 'x-trust-remaining': '500', 'x-trust-renew': '1' })], { general: trust(0) })
    await r.send(GET)
    expect(r.tokens.general).toEqual({ ...trust(0), remaining: 500, renewAt: 0 })
  })

  test('solves before the first request when it has no token', async () => {
    const r = rig([ok()])
    await r.send(GET)
    expect(r.solves).toEqual([{ kind: 'general', priority: 'foreground' }])
    expect(r.carried()).toEqual(['t1.1.general1.tag'])
  })

  test('a token that expired or ran out by the server clock counts as none', async () => {
    for (const stale of [
      { ...trust(0), expiresAt: NOW / 1000 },
      { ...trust(0), remaining: 0 },
    ]) {
      const r = rig([ok()], { general: stale })
      await r.send(GET)
      expect(r.solves).toHaveLength(1)
      expect(r.carried()).toEqual(['t1.1.general1.tag'])
    }
  })

  test('a 429 with X-Trust-Required and no token: solve, then retry once', async () => {
    const r = rig([refused(), ok()], { wanted: false })
    const res = await r.send(GET)
    expect(res.status).toBe(200)
    expect(r.carried()).toEqual([null, 't1.1.general1.tag'])
    expect(r.solves).toEqual([{ kind: 'general', priority: 'foreground' }])
    expect(r.sleeps).toEqual([])
  })

  test('a second 429 waits: the answer goes back with its Retry-After', async () => {
    const r = rig([refused(), refused(), ok()], { wanted: false })
    const res = await r.send(GET)
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('300')
    expect(r.sent).toHaveLength(2)
    expect(r.solves).toHaveLength(1)
    expect(r.sleeps).toEqual([])
    expect(r.tokens.general).toBeNull()
  })

  test('a 429 with X-Trust-Required on a request that carried a token drops it and solves at once', async () => {
    const r = rig([refused(), ok({ 'x-trust-remaining': '2998' })], { general: trust(0) })
    const res = await r.send(GET)
    expect(res.status).toBe(200)
    expect(r.carried()).toEqual(['t1.1.general0.tag', 't1.1.general1.tag'])
    expect(r.solves).toEqual([{ kind: 'general', priority: 'foreground' }])
    expect(r.sleeps).toEqual([])
    expect(r.tokens.general).toEqual({ ...trust(1), remaining: 2998 })
  })

  test('refused again, it solves after 2, 4 and 8 seconds, then gives the 429 back', async () => {
    expect(RESOLVE_BACKOFF_MS).toEqual([2000, 4000, 8000])
    const r = rig([refused(), refused(), refused(), refused(), refused(), ok()], {
      general: trust(0),
    })
    const res = await r.send(GET)
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('300')
    expect(r.carried()).toEqual([
      't1.1.general0.tag',
      't1.1.general1.tag',
      't1.1.general2.tag',
      't1.1.general3.tag',
      't1.1.general4.tag',
    ])
    expect(r.sleeps).toEqual([2000, 4000, 8000])
    expect(r.solves).toHaveLength(4)
    expect(r.tokens.general).toBeNull()
  })

  test('a refusal in the middle of the backoff that then passes stops there', async () => {
    const r = rig([refused(), refused(), refused(), ok()], { general: trust(0) })
    const res = await r.send(GET)
    expect(res.status).toBe(200)
    expect(r.sleeps).toEqual([2000, 4000])
    expect(r.sent).toHaveLength(4)
  })

  test('a 429 without X-Trust-Required is not about trust', async () => {
    const r = rig([limited(), ok()], { general: trust(0) })
    const res = await r.send(GET)
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('7')
    expect(r.sent).toHaveLength(1)
    expect(r.solves).toEqual([])
    expect(r.tokens.general).toEqual(trust(0))
  })

  test('a level hint solves with that much work', async () => {
    const r = rig([refused('general; level=4194304'), ok()], { general: trust(0) })
    await r.send(GET)
    expect(r.solves).toEqual([{ kind: 'general', priority: 'foreground', minWork: 4_194_304 }])
  })

  test('sign-in requests carry the sign-in token, never the general one', async () => {
    const r = rig([ok()], { general: trust(0) })
    await r.send({ url: `${ORIGIN}/api/v1/auth/login`, headers: {}, kind: 'signin' })
    expect(r.solves).toEqual([{ kind: 'signin', priority: 'foreground' }])
    expect(r.carried()).toEqual(['t1.1.signin1.tag'])
    expect(r.tokens.general).toEqual(trust(0))
  })

  test('the refusal says which token the route wants', async () => {
    const r = rig([refused('signin'), ok()], { general: trust(0) })
    await r.send({ url: `${ORIGIN}/api/v1/servers/lobby/guest_access`, headers: {} })
    expect(r.solves).toEqual([{ kind: 'signin', priority: 'foreground' }])
    expect(r.carried()).toEqual(['t1.1.general0.tag', 't1.1.signin1.tag'])
    expect(r.tokens.general).toEqual(trust(0))
  })

  test('an instance that keeps asking for the other token gets no endless solving', async () => {
    const r = rig(
      [refused('signin'), refused('general'), refused('signin'), refused('general'), ok()],
      { general: trust(0) }
    )
    const res = await r.send({ url: `${ORIGIN}/api/v1/servers/lobby/guest_access`, headers: {} })
    expect(res.status).toBe(429)
    expect(r.sent).toHaveLength(2)
    expect(r.solves).toEqual([{ kind: 'signin', priority: 'foreground' }])
    expect(r.tokens.general).toEqual(trust(0))
  })

  test('X-Trust-Client goes on requests without a session and on sign-ins', async () => {
    const r = rig([], { general: trust(0), signin: trust(0, 'signin') })
    await r.send({ url: `${ORIGIN}/api/v1/servers/lobby`, headers: {} })
    await r.send({ url: '/api/v1/servers/lobby' })
    await r.send(GET)
    await r.send({ url: `${ORIGIN}/api/v1/auth/login`, headers: BEARER, kind: 'signin' })
    await r.send({ url: `${ORIGIN}/api/v1/me`, headers: { authorization: 'Bearer lower' } })
    expect(r.header('X-Trust-Client')).toEqual([CLIENT, CLIENT, null, CLIENT, null])
  })

  test('nothing of it ever goes to another origin', async () => {
    const r = rig([refused(), ok()], { general: trust(0) })
    for (const url of [
      'https://other.example.org/api/v1/servers/lobby',
      'https://chat.example.com.evil.test/api/v1/me',
      'http://chat.example.com/api/v1/me',
    ]) {
      const res = await r.send({ url, headers: {} })
      expect(res.status === 429 || res.status === 200).toBe(true)
    }
    expect(r.sent.map(s => s.headers)).toEqual([{}, {}, {}])
    expect(r.solves).toEqual([])
    expect(r.tokens.general).toEqual(trust(0))
  })

  test('an instance without trust never gets a header and is never solved for', async () => {
    const r = rig([refused(), ok()], { advertised: false, general: trust(0) })
    expect((await r.send({ url: `${ORIGIN}/api/v1/servers/lobby`, headers: {} })).status).toBe(429)
    await r.send(GET)
    expect(r.sent.map(s => s.headers)).toEqual([{}, BEARER])
    expect(r.solves).toEqual([])
  })

  test('accounts never send it with media, guests do', async () => {
    const r = rig([], { general: trust(0) })
    await r.send({ url: `${ORIGIN}/api/v1/media/7`, headers: BEARER, media: true })
    await r.send({
      url: `${ORIGIN}/api/v1/messages/9/embeds/0/image`,
      headers: BEARER,
      media: true,
    })
    await r.send({ url: `${ORIGIN}/api/v1/media/7`, headers: {}, media: true })
    expect(r.carried()).toEqual([null, null, 't1.1.general0.tag'])
    expect(r.sent[2].headers['X-Trust-Client']).toBe(CLIENT)
    expect(r.solves).toEqual([])
    const none = rig([refused()])
    expect(
      (await none.send({ url: `${ORIGIN}/api/v1/media/7`, headers: BEARER, media: true })).status
    ).toBe(429)
    expect(none.solves).toEqual([])
  })

  test('a solve that gives nothing sends the request as it is, once', async () => {
    const r = rig([refused(), ok()], { solves: false })
    const res = await r.send(GET)
    expect(res.status).toBe(429)
    expect(r.sent).toEqual([{ url: GET.url, headers: BEARER }])
    expect(r.solves).toHaveLength(1)
  })

  test('requests refused together share one new token', async () => {
    const r = rig([refused(), refused(), ok(), ok()], { general: trust(0) })
    const [a, b] = await Promise.all([r.send(GET), r.send(GET)])
    expect([a.status, b.status]).toEqual([200, 200])
    expect(r.solves).toHaveLength(1)
    expect(r.carried()).toEqual([
      't1.1.general0.tag',
      't1.1.general0.tag',
      't1.1.general1.tag',
      't1.1.general1.tag',
    ])
  })

  test('an answer to an old token does not write over a newer one', async () => {
    const r = rig([ok({ 'x-trust-remaining': '10' })], { general: trust(0) })
    const sending = r.send(GET)
    r.tokens.general = trust(5)
    await sending
    expect(r.tokens.general).toEqual(trust(5))
  })

  test('every answer gives its Date to the clock', async () => {
    const r = rig([refused(), ok({ date: 'Thu, 01 Jan 2026 00:00:10 GMT' })], { general: trust(0) })
    await r.send(GET)
    expect(r.dates).toEqual([null, 'Thu, 01 Jan 2026 00:00:10 GMT'])
  })

  test('the request it was given is left as it was', async () => {
    const r = rig([], { general: trust(0) })
    const req = { url: `${ORIGIN}/api/v1/servers/lobby`, headers: { Accept: 'application/json' } }
    await r.send(req)
    expect(req).toEqual({
      url: `${ORIGIN}/api/v1/servers/lobby`,
      headers: { Accept: 'application/json' },
    })
    expect(r.sent[0].headers.Accept).toBe('application/json')
  })
})
