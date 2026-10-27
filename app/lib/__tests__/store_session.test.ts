import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { api } from '../instances'
import { useStore } from '../store'
import { me, serverDetail } from './fixtures'

const st = () => useStore.getState()
const realFetch = globalThis.fetch
const g = globalThis as { window?: unknown; document?: unknown }
const realWindow = g.window
const realDocument = g.document

type Call = { method: string; url: string; auth: string | null }
let calls: Call[] = []
let reply: (url: string) => Response = () => new Response('[]')

beforeEach(() => {
  calls = []
  g.window = {
    location: { pathname: '/', href: 'http://x/', origin: 'http://x', protocol: 'http:' },
    history: { state: null, pushState: () => {}, replaceState: () => {} },
  }
  g.document = { cookie: '' }
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ method: init?.method ?? 'GET', url, auth: headers.Authorization ?? null })
    return reply(url)
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  g.window = realWindow
  g.document = realDocument
  api.setToken(null)
  useStore.setState({ token: null, me: null, view: null, servers: {}, error: null, notices: [] })
})

describe('session', () => {
  test('logout sends the last read marks, then revokes the token it used', async () => {
    api.setToken('tok')
    useStore.setState({ token: 'tok', me: me('bob'), authExpired: false, reads: {} })
    st().markRead('d424242', 1_000_000_000)
    st().logout()
    expect(st().token).toBeNull()
    api.setToken('next')
    await new Promise(r => setTimeout(r, 10))
    const posts = calls.filter(c => c.method === 'POST')
    expect(posts.map(c => [c.url.replace(/^.*\/api/, ''), c.auth])).toEqual([
      ['/read', 'Bearer tok'],
      ['/auth/logout', 'Bearer tok'],
    ])
  })

  test('refreshing the account only takes the password kind', async () => {
    reply = () =>
      new Response(JSON.stringify(me('bob', { password_kind: 'words', appear_offline: false })))
    api.setToken('tok')
    useStore.setState({ token: 'tok', me: me('bob', { appear_offline: true }) })
    await st().refreshAccount()
    expect(st().me?.password_kind).toBe('words')
    expect(st().me?.appear_offline).toBe(true)
  })

  test('a failed login without an error text still says something', async () => {
    reply = () => new Response('{}', { status: 500, statusText: '' })
    await st().login({ username: 'bob', password: 'x' } as never)
    expect(st().error).toBe('HTTP 500')
  })

  test('an expired session does not try to revoke a dead token', () => {
    api.setToken('tok')
    useStore.setState({ token: 'tok', me: me('bob'), authExpired: true })
    st().logout()
    expect(calls.some(c => c.url.endsWith('/auth/logout'))).toBe(false)
  })

  test('a server that answers banned is dropped once with a notice and no error toast', async () => {
    reply = url =>
      url.includes('/servers/club')
        ? new Response(JSON.stringify({ error: 'You are banned from this server' }), {
            status: 403,
          })
        : new Response('[]')
    api.setToken('tok')
    const club = { name: 'club', display_name: 'Club', has_password: false }
    useStore.setState({
      token: 'tok',
      me: me('bob', { servers: [club] } as never),
      servers: { lounge: serverDetail('lounge') },
      view: { kind: 'channel', server: 'lounge', channelId: 1 },
    })
    await st().openServer('club')
    await st().openServer('club')
    expect(st().error).toBeNull()
    expect(st().notices.map(n => [n.lead, n.name])).toEqual([['You were banned from', 'Club']])
    expect(st().me?.servers.some(s => s.name === 'club')).toBe(false)
    expect(st().view).toEqual({ kind: 'channel', server: 'lounge', channelId: 1 })
    reply = () => new Response('[]')
  })
})
