import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { api } from './home_instance'
import { useStore } from '../store'
import { ALL_PERMS, Perm } from '../types'
import { member, paged } from './fixtures'

const realFetch = globalThis.fetch
let requests: URL[] = []
let next: string | null = null

beforeEach(() => {
  requests = []
  next = null
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(new URL(String(input), 'http://localhost'))
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: next ? { 'X-Next-Cursor': next } : {},
    })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('cursor pages', () => {
  test('member search sends the prefix, the admins filter and the cursor', async () => {
    next = 'abc'
    const page = await api.listMembers('club', 'c1', { q: 'Al b', admins: true })
    expect(page.next).toBe('abc')
    const qs = requests[0].searchParams
    expect(qs.get('q')).toBe('Al b')
    expect(qs.get('admins')).toBe('1')
    expect(qs.get('cursor')).toBe('c1')
    expect(qs.get('offset')).toBeNull()
  })

  test('a missing header means the last page', async () => {
    const page = await api.listDms(null, 50)
    expect(page).toEqual({ items: [], next: null })
    expect(requests[0].searchParams.get('cursor')).toBeNull()
    expect(requests[0].searchParams.get('limit')).toBe('50')
  })

  test('unreads ask for the capped list', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      requests.push(new URL(String(input), 'http://localhost'))
      return new Response(JSON.stringify({ items: [], more: true }), { status: 200 })
    }) as typeof fetch
    expect(await api.getUnreads()).toEqual({ items: [], more: true })
    expect(requests.map(r => r.search)).toEqual([''])
  })
})

describe('admin perms', () => {
  test('say which bits they set, so older bits stay as stored', async () => {
    const bodies: unknown[] = []
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch
    await api.setAdminPerms('club', 'bob', Perm.Kick)
    expect(bodies).toEqual([{ perms: Perm.Kick, mask: ALL_PERMS }])
  })
})

describe('resetting a member server profile', () => {
  test('posts the fields and the lock, and lifts a lock by its own route', async () => {
    const sent: [string, string, unknown][] = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null
      sent.push([init?.method ?? 'GET', new URL(String(input), 'http://localhost').pathname, body])
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch
    await api.resetMemberProfile('club', 'bob b', ['avatar', 'name'], 604800, ' spam ')
    await api.resetMemberProfile('club', 'bob', ['bio'], null, '')
    await api.unlockMemberProfile('club', 'bob')
    expect(sent).toEqual([
      [
        'POST',
        '/api/servers/club/members/bob%20b/profile/reset',
        { fields: ['name', 'avatar'], lock_secs: 604800, reason: 'spam' },
      ],
      ['POST', '/api/servers/club/members/bob/profile/reset', { fields: ['bio'] }],
      ['DELETE', '/api/servers/club/members/bob/profile/lock', null],
    ])
  })
})

describe('notePresence', () => {
  test('patches the loaded member and the cached member info', () => {
    useStore.setState({
      members: { club: paged([member('bob', { online: false })]) },
      memberInfo: { club: { carol: member('carol', { online: true }) } },
    })
    useStore.getState().notePresence('club', 'bob', true)
    useStore.getState().notePresence('club', 'carol', false)
    const s = useStore.getState()
    expect(s.members.club.list[0].online).toBe(true)
    expect(s.memberInfo.club.carol?.online).toBe(false)
    useStore.getState().notePresence('club', 'bob', true)
    useStore.getState().notePresence('club', 'nobody', true)
    expect(useStore.getState().members).toBe(s.members)
    expect(useStore.getState().memberInfo).toBe(s.memberInfo)
  })
})
