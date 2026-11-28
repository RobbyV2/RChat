import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { BACKGROUND } from '../api'
import { api } from './home_instance'
import { writeJson } from '../api/masks'

const realFetch = globalThis.fetch
let sent: { path: string; background: string | null }[] = []

beforeEach(() => {
  sent = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    sent.push({
      path: new URL(String(input), 'http://localhost').pathname,
      background: headers.get('x-background'),
    })
    const body = String(input).includes('/me')
      ? { username: 'alice', display_name: 'Alice', avatar_kind: 'identicon' }
      : { ok: true }
    return new Response(writeJson(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('background requests', () => {
  test('polls and read marks say they run in the background', async () => {
    expect(BACKGROUND).toEqual({ 'X-Background': '1' })
    await api.me(true).catch(() => {})
    await api.getSettings(true).catch(() => {})
    await api.postRead('c1', 5)
    await api.postReadBatch(['c1'])
    expect(sent.map(s => s.background)).toEqual(['1', '1', '1', '1'])
  })

  test('requests the user makes do not', async () => {
    await api.me().catch(() => {})
    await api.getSettings().catch(() => {})
    expect(sent.map(s => s.background)).toEqual([null, null])
  })
})
