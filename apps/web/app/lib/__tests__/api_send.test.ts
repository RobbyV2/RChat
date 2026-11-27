import { afterEach, describe, expect, test } from 'bun:test'
import { ApiClient, ApiError, RETRY_AFTER_MS, type Pace } from '../api'

interface Sent {
  url: string
  init: RequestInit
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const DOWN = 'down'

// Answers requests in order; `DOWN` is a network failure.
const serve = (...answers: (Response | typeof DOWN)[]) => {
  const sent: Sent[] = []
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    sent.push({ url: String(input), init })
    const answer = answers[Math.min(sent.length, answers.length) - 1]
    if (answer === DOWN) throw new TypeError('network')
    return answer.clone()
  }) as typeof fetch
  return sent
}

const paced = () => {
  const waits: number[] = []
  const pace: Pace = {
    wait: async ms => {
      waits.push(ms)
    },
  }
  return { waits, pace }
}

const fails = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (e: unknown) => e
  )
  if (!(e instanceof ApiError)) throw new Error('expected an ApiError')
  return e
}

const client = (pace?: Pace) => {
  const c = new ApiClient('https://chat.example/api', 'include', pace)
  c.prefix = 'v1'
  return c
}

const header = (s: Sent, name: string) => (s.init.headers as Record<string, string>)[name]
const ok = () =>
  new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
const limited = (after: string) =>
  new Response('{"error":"Slow down"}', { status: 429, headers: { 'Retry-After': after } })

describe('retries', () => {
  test('a GET is sent again after a network failure', async () => {
    const { waits, pace } = paced()
    const sent = serve(DOWN, DOWN, ok())
    const res = await client(pace).send('GET', '/me')
    expect(res.status).toBe(200)
    expect(sent.length).toBe(3)
    expect(waits).toEqual([...RETRY_AFTER_MS])
  })

  test('a GET gives up after the last wait', async () => {
    const { waits, pace } = paced()
    const sent = serve(DOWN)
    const failure = await fails(client(pace).send('GET', '/me'))
    expect(failure.status).toBe(0)
    expect(sent.length).toBe(RETRY_AFTER_MS.length + 1)
    expect(waits.length).toBe(RETRY_AFTER_MS.length)
  })

  test('a request that changes something is sent once', async () => {
    const { waits, pace } = paced()
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const sent = serve(DOWN, ok())
      await fails(client(pace).send(method, '/x', { a: 1 }))
      expect(sent.length).toBe(1)
    }
    expect(waits).toEqual([])
  })

  test('a request that refuses redirects is sent once', async () => {
    const { pace } = paced()
    const sent = serve(DOWN, ok())
    await fails(client(pace).send('GET', '/x', undefined, { redirect: 'error' }))
    expect(sent.length).toBe(1)
  })

  test('a keepalive request and one that opts out are sent once', async () => {
    const { pace } = paced()
    let sent = serve(DOWN, ok())
    await fails(client(pace).send('GET', '/x', undefined, { keepalive: true }))
    expect(sent.length).toBe(1)
    sent = serve(DOWN, ok())
    await fails(client(pace).send('GET', '/x', undefined, { retry: false }))
    expect(sent.length).toBe(1)
  })

  test('a stopped request is not sent again', async () => {
    const { waits, pace } = paced()
    const stop = new AbortController()
    stop.abort()
    const sent = serve(DOWN, ok())
    await fails(client(pace).send('GET', '/x', undefined, { signal: stop.signal }))
    expect(sent.length).toBe(1)
    expect(waits).toEqual([])
  })
})

describe('asked waits', () => {
  test('a GET waits a short Retry-After out once and asks again', async () => {
    const { waits, pace } = paced()
    const sent = serve(limited('2'), ok())
    const res = await client(pace).send('GET', '/me')
    expect(res.status).toBe(200)
    expect(sent.length).toBe(2)
    expect(waits).toEqual([2000])
  })

  test('a second refusal is returned', async () => {
    const { waits, pace } = paced()
    const sent = serve(limited('1'), limited('1'), ok())
    const res = await client(pace).send('GET', '/me')
    expect(res.status).toBe(429)
    expect(sent.length).toBe(2)
    expect(waits).toEqual([1000])
  })

  test('a long wait, or none named, is returned at once', async () => {
    const { waits, pace } = paced()
    serve(limited('60'))
    expect((await client(pace).send('GET', '/me')).status).toBe(429)
    serve(new Response('{}', { status: 503 }))
    expect((await client(pace).send('GET', '/me')).status).toBe(503)
    expect(waits).toEqual([])
  })

  test('a refused write is returned at once', async () => {
    const { waits, pace } = paced()
    const sent = serve(limited('1'), ok())
    expect((await client(pace).send('POST', '/x', {})).status).toBe(429)
    expect(sent.length).toBe(1)
    expect(waits).toEqual([])
  })

  test('the error of a refusal carries the seconds to wait', async () => {
    serve(limited('60'))
    const failure = await fails(client().req('POST', '/auth/login', {}))
    expect(failure.retryAfter).toBe(60)
    expect(failure.message).toBe('Slow down')
    serve(new Response('{"error":"No"}', { status: 400, headers: { 'Retry-After': '9' } }))
    expect((await fails(client().req('POST', '/x', {}))).retryAfter).toBeNull()
  })
})

describe('credentials', () => {
  test('the session token goes with a request, and guest grants only without one', async () => {
    const c = client()
    c.setGrants({ club: 'g1', den: 'g2' })
    let sent = serve(ok())
    await c.send('GET', '/me')
    expect(header(sent[0], 'X-Guest-Grant')).toBe('g1,g2')
    expect(sent[0].url).toBe('https://chat.example/api/v1/me')
    c.setToken('tok')
    sent = serve(ok())
    await c.send('GET', '/me')
    expect(header(sent[0], 'Authorization')).toBe('Bearer tok')
    expect(header(sent[0], 'X-Guest-Grant')).toBeUndefined()
    expect(sent[0].init.credentials).toBe('include')
  })

  test('discovery carries no credentials and is asked once', async () => {
    const c = client()
    c.setToken('tok')
    c.setGrants({ club: 'g1' })
    const sent = serve(DOWN, ok())
    await fails(c.discovery())
    expect(sent.length).toBe(1)
    expect(sent[0].url).toBe('https://chat.example/api/instance')
    expect(header(sent[0], 'Authorization')).toBeUndefined()
    expect(header(sent[0], 'X-Guest-Grant')).toBeUndefined()
    expect(sent[0].init.redirect).toBe('manual')
  })

  test('the sign-in exchange carries no token and no cookie', async () => {
    const c = client()
    c.setToken('tok')
    const sent = serve(ok())
    await c.ssoExchange({ code: 'c' } as Parameters<ApiClient['ssoExchange']>[0])
    expect(sent[0].url).toBe('https://chat.example/api/auth/oidc/exchange')
    expect(sent[0].init.method).toBe('POST')
    expect(header(sent[0], 'Authorization')).toBeUndefined()
    expect(sent[0].init.credentials).toBe('omit')
    expect(sent[0].init.redirect).toBe('error')
    expect(sent[0].init.cache).toBe('no-store')
  })

  test('a file goes out with the token and no cookie, never following a redirect', async () => {
    const c = client()
    c.setToken('tok')
    const sent = serve(new Response('abc'))
    const blob = await c.authedBlob('https://chat.example/api/v1/media/m%201?w=64', 'club')
    expect(await blob.text()).toBe('abc')
    expect(sent[0].url).toBe('https://chat.example/api/v1/media/m%201?w=64')
    expect(header(sent[0], 'Authorization')).toBe('Bearer tok')
    expect(sent[0].init.credentials).toBe('omit')
    expect(sent[0].init.redirect).toBe('error')
    expect(sent[0].init.referrerPolicy).toBe('no-referrer')
  })

  test('a guest file carries only the grant for its server', async () => {
    const c = client()
    c.setGrants({ club: 'g1', den: 'g2' })
    let sent = serve(new Response('abc'))
    await c.mediaStart('m1', 'den', 2)
    expect(sent[0].url).toBe('https://chat.example/api/v1/media/m1')
    expect(header(sent[0], 'X-Guest-Grant')).toBe('g2')
    expect(sent[0].init.credentials).toBe('include')
    sent = serve(new Response('abc'))
    await c.mediaBlob('m1')
    expect(header(sent[0], 'X-Guest-Grant')).toBeUndefined()
  })

  test('an address outside the API is refused without a request', async () => {
    const c = client()
    c.setToken('tok')
    const sent = serve(ok())
    for (const url of ['https://other.example/api/v1/media/m1', 'https://chat.example/media/m1'])
      expect((await fails(c.authedBlob(url))).message).toBe('Could not load the file')
    expect(sent.length).toBe(0)
  })

  test('a file that cannot be fetched fails with the file message', async () => {
    const { pace } = paced()
    serve(DOWN)
    expect((await fails(client(pace).mediaBlob('m1'))).message).toBe('Could not load the file')
    serve(new Response('', { status: 404 }))
    expect((await fails(client(pace).mediaStart('m1', undefined, 4))).status).toBe(404)
  })
})

describe('sockets and probes', () => {
  test('a socket opens at the address given, with nothing added', () => {
    const real = globalThis.WebSocket
    const opened: string[] = []
    globalThis.WebSocket = class {
      constructor(url: string) {
        opened.push(url)
      }
    } as unknown as typeof WebSocket
    try {
      const c = client()
      c.setToken('tok')
      c.socket('wss://chat.example/api/v1/ws')
      expect(opened).toEqual(['wss://chat.example/api/v1/ws'])
    } finally {
      globalThis.WebSocket = real
    }
  })

  test('the health probe carries no credentials', async () => {
    const c = client()
    c.setToken('tok')
    const sent = serve(ok())
    expect(await c.reachable('https://chat.example/api/v1/health')).toBe(true)
    expect(sent[0].init.credentials).toBe('omit')
    expect(sent[0].init.headers).toBeUndefined()
    serve(new Response('', { status: 502 }))
    expect(await c.reachable('https://chat.example/api/v1/health')).toBe(false)
  })
})
