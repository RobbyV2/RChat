import { describe, expect, test } from 'bun:test'
import {
  appAsset,
  clientConsent,
  instanceDocument,
  PublicRequest,
  publicSettings,
} from '../api/public'

const capture = async (request: PublicRequest) => {
  let seen: { url: string; init: RequestInit } | undefined
  await request.send(async (url, init = {}) => {
    seen = { url, init }
    return new Response('{}')
  })
  if (!seen) throw new Error('nothing was sent')
  return seen
}

const all = () => [
  instanceDocument('https://other.example', 'document', 1000),
  instanceDocument('https://other.example', 'wellKnown', 1000),
  publicSettings('https://chat.example/api/', 1000),
  clientConsent({ receipt: 'r1', action: 'allow' }),
  appAsset('fieldNotes'),
]

describe('public requests', () => {
  test('none carries a cookie, a token or a grant', async () => {
    for (const request of all()) {
      const { init } = await capture(request)
      expect(init.credentials).toBe('omit')
      const names = Object.keys(init.headers as Record<string, string>).map(n => n.toLowerCase())
      expect(names.filter(n => n !== 'accept' && n !== 'content-type')).toEqual([])
    }
  })

  test('each goes to its fixed address', () => {
    expect(all().map(r => r.url)).toEqual([
      'https://other.example/api/instance',
      'https://other.example/.well-known/rchat',
      'https://chat.example/api/v1/settings',
      '/api/auth/oidc/client-consent',
      '/app-examples/field-notes.json',
    ])
  })

  test('an instance document is asked for as JSON, without following a redirect', async () => {
    const { init } = await capture(instanceDocument('https://other.example', 'document', 1000))
    expect(init.method).toBe('GET')
    expect(init.redirect).toBe('manual')
    expect(init.headers).toEqual({ Accept: 'application/json' })
    expect(init.signal instanceof AbortSignal).toBe(true)
    expect(init.body).toBeUndefined()
  })

  test('a consent decision is posted to this site only', async () => {
    const { init } = await capture(clientConsent({ receipt: 'r1', action: 'describe' }))
    expect(init.method).toBe('POST')
    expect(init.mode).toBe('same-origin')
    expect(init.redirect).toBe('error')
    expect(init.cache).toBe('no-store')
    expect(JSON.parse(String(init.body))).toEqual({ receipt: 'r1', action: 'describe' })
  })

  test('fields outside a consent decision are not sent', async () => {
    const extra = { receipt: 'r1', action: 'cancel', token: 'tok' } as Parameters<
      typeof clientConsent
    >[0]
    const { init } = await capture(clientConsent(extra))
    expect(JSON.parse(String(init.body))).toEqual({ receipt: 'r1', action: 'cancel' })
  })

  test('a public request cannot be built outside its builders', () => {
    const Raw = PublicRequest as unknown as new (key: symbol, plan: object) => unknown
    expect(() => new Raw(Symbol('public request'), { url: 'https://x.example' })).toThrow()
  })
})
