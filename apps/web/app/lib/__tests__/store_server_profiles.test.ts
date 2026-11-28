import { flush } from './helpers/test_clock'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { cachedProfile, profileKey, rememberProfile } from '../profile'
import { lookOf } from '../server_profile'
import { sessionMark } from '../slices/ctx'
import { resetSessionCaches, useStore } from '../store'
import { mayEditProfile, profileLockedFor } from '../selectors'
import type { Member, MemberLook, Profile, ProfilesMode, ServerProfile, WsEvent } from '../types'
import { CHANGE_PROFILE } from '../types'
import { me, member, paged, serverDetail, until } from './fixtures'
import { writeJson } from '../api/masks'

const st = () => useStore.getState()
const dispatch = (ev: WsEvent) => st().applyWsEvent(ev)
const tick = () => flush()
const robert: MemberLook = { name: 'Robert', avatar_kind: 'color', avatar_color: '#112233' }
const shown = () => lookOf(st(), { server: 's' }, 'bob')

const realFetch = globalThis.fetch
let requests: string[] = []
let directory: Record<string, Member> = {}

beforeEach(() => {
  resetSessionCaches()
  requests = []
  directory = { bob: member('bob', { profile: robert }) }
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    requests.push(url)
    const names = new URL(url).searchParams.getAll('usernames')
    const rows = names.length
      ? names.flatMap(n => (directory[n] ? [directory[n]] : []))
      : Object.values(directory)
    return new Response(writeJson(rows), { status: 200 })
  }) as typeof fetch
  useStore.setState({
    guest: false,
    view: null,
    profile: null,
    profileLocks: {},
    settings: { ...st().settings, server_profiles: true, display_names: true },
    me: me('alice', {
      servers: [{ name: 's', display_name: 's', creator: null, is_admin: false }],
    }),
    servers: { s: serverDetail('s', { profiles_mode: 'all' }) },
    members: { s: paged([member('bob', { profile: robert })]) },
    memberInfo: { s: { bob: member('bob', { profile: robert }) } },
  })
})

afterEach(() => {
  globalThis.fetch = realFetch
})

const fetchedMembers = () => requests.filter(r => r.includes('/servers/s/members'))

describe('server profile events', () => {
  test('member_profile sets and takes away a look in the member list and the lookups', () => {
    useStore.setState({
      members: { s: paged([member('bob')]) },
      memberInfo: { s: { bob: member('bob') } },
    })
    const key = profileKey('bob', 's')
    rememberProfile(key, { username: 'bob' } as unknown as Profile, sessionMark())
    dispatch({ type: 'member_profile', server: 's', username: 'bob', profile: robert, bio: false })
    expect(st().members.s?.list[0]?.profile).toEqual(robert)
    expect(st().memberInfo.s?.bob?.profile).toEqual(robert)
    expect(shown()).toEqual(robert)
    expect(cachedProfile(key)).not.toBeNull()
    dispatch({ type: 'member_profile', server: 's', username: 'bob', profile: null, bio: true })
    expect(st().members.s?.list[0]?.profile).toBeUndefined()
    expect(st().memberInfo.s?.bob?.profile).toBeUndefined()
    expect(shown()).toBeNull()
    expect(cachedProfile(key)).toBeNull()
  })

  test('a stricter server mode hides what was loaded at once; a looser one fetches it again', async () => {
    const mode = (profiles_mode: ProfilesMode): WsEvent => ({
      type: 'server_updated',
      server: { name: 's', display_name: 's', creator: null, has_password: false, profiles_mode },
    })
    dispatch(mode('no_names'))
    expect(st().servers.s?.profiles_mode).toBe('no_names')
    expect(st().me?.servers[0]?.profiles_mode).toBe('no_names')
    expect(shown()).toEqual({ ...robert, name: null })
    dispatch(mode('off'))
    expect(shown()).toBeNull()
    await tick()
    expect(fetchedMembers()).toEqual([])
    dispatch(mode('all'))
    await until(() => fetchedMembers().length >= 2)
    expect(fetchedMembers().some(r => r.includes('usernames=bob'))).toBe(true)
    expect(shown()).toEqual(robert)
  })

  test('the site switch hides looks at once, and turning it back on fetches them again', async () => {
    const on = (server_profiles: boolean): WsEvent => ({
      type: 'settings_changed',
      settings: { ...st().settings, server_profiles },
    })
    dispatch(on(false))
    expect(shown()).toBeNull()
    await tick()
    expect(fetchedMembers()).toEqual([])
    dispatch(on(true))
    await until(() => fetchedMembers().length >= 2)
    expect(shown()).toEqual(robert)
  })
})

const stored = (over: Partial<ServerProfile> = {}): ServerProfile => ({
  look: { name: 'Ally', avatar_kind: null, avatar_color: null },
  bio: null,
  banner_color: null,
  effective: { ...me('alice'), display_name: 'Ally' },
  effective_banner: null,
  effective_bio: null,
  mode: 'all',
  locked_until: null,
  ...over,
})

// Answers the own-profile routes of server `s` with `reply`, and notes each request.
const profileRoutes = (reply: (method: string, body: unknown) => Response) => {
  const calls: [string, string, unknown][] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
    calls.push([method, new URL(String(input)).pathname, body])
    return reply(method, body)
  }) as typeof fetch
  return calls
}

const json = (data: unknown, status = 200) => new Response(writeJson(data), { status })

describe('your own server profile', () => {
  test('loading, saving and clearing keep the server page current', async () => {
    const calls = profileRoutes(method =>
      json(method === 'DELETE' ? stored({ look: { ...robert, name: null } }) : stored())
    )
    expect(await st().loadMyProfile('s')).toEqual({ ok: true, value: stored() })
    expect(st().servers.s?.my_profile).toEqual(stored())
    expect(await st().saveMyProfile('s', { name: 'Ally' })).toBeNull()
    expect(await st().clearMyProfile('s')).toBeNull()
    expect(st().servers.s?.my_profile?.look.name).toBeNull()
    expect(calls).toEqual([
      ['GET', '/api/servers/s/profile', undefined],
      ['PATCH', '/api/servers/s/profile', { name: 'Ally' }],
      ['DELETE', '/api/servers/s/profile', undefined],
    ])
  })

  test('a profile that cannot be read answers the refusal, not an empty profile', async () => {
    profileRoutes(() => json({ error: 'Try again later' }, 503))
    const tried = await st().loadMyProfile('s')
    expect(tried.ok).toBe(false)
    expect(!tried.ok && tried.refusal.status).toBe(503)
  })

  test('a server that is not open answers its profile too', async () => {
    profileRoutes(() => json(stored()))
    useStore.setState({ servers: {} })
    expect(await st().loadMyProfile('s')).toEqual({ ok: true, value: stored() })
    expect(st().servers).toEqual({})
  })

  test('a refused save answers the reason, and a lock is read again', async () => {
    let locked = false
    const calls = profileRoutes(method => {
      if (method === 'GET') return json(stored({ locked_until: locked ? 4102444800 : null }))
      locked = true
      return json(
        {
          error: 'A moderator locked your server profile',
          reason: { kind: 'locked', until: 4102444800 },
        },
        403
      )
    })
    expect(await st().saveMyProfile('s', { name: 'Ally' })).toBe(
      'A moderator locked your server profile'
    )
    await until(() => st().servers.s?.my_profile?.locked_until === 4102444800)
    expect(st().servers.s?.my_profile?.locked_until).toBe(4102444800)
    expect(calls.map(c => c[0])).toEqual(['PATCH', 'GET'])
  })

  test('a look event about you reads your profile again; one about someone else does not', async () => {
    const calls = profileRoutes(() => json(stored({ locked_until: 4102444800 })))
    dispatch({ type: 'member_profile', server: 's', username: 'bob', profile: null, bio: false })
    await tick()
    expect(calls).toEqual([])
    dispatch({ type: 'member_profile', server: 's', username: 'alice', profile: null, bio: false })
    await until(() => st().servers.s?.my_profile !== undefined)
    expect(st().servers.s?.my_profile?.locked_until).toBe(4102444800)
  })

  test('an open card of the member reads the profile again on a look event', () => {
    const card = { user: member('bob'), server: 's', x: 0, y: 0 }
    useStore.setState({ profile: card })
    dispatch({ type: 'member_profile', server: 's', username: 'carol', profile: null, bio: true })
    expect(st().profile).toBe(card)
    dispatch({ type: 'member_profile', server: 's', username: 'bob', profile: null, bio: true })
    expect(st().profile).toEqual({ ...card, rev: 1 })
    useStore.setState({ profile: null })
  })

  test('the editor stays shut for a member the server says may not change their profile', () => {
    const before = st().servers
    useStore.setState({ servers: { s: serverDetail('s', { my_perms: CHANGE_PROFILE | 131072n }) } })
    expect(mayEditProfile(st(), 's')).toBe(true)
    useStore.setState({ servers: { s: serverDetail('s', { my_perms: 131072n }) } })
    expect(mayEditProfile(st(), 's')).toBe(false)
    useStore.setState({ servers: before })
  })

  test('the editor opens for a signed-in member while profiles show and no timeout runs', () => {
    expect(mayEditProfile(st(), 's')).toBe(true)
    expect(mayEditProfile(st(), 'elsewhere')).toBe(false)
    useStore.setState({ servers: { s: serverDetail('s', { profiles_mode: 'no_names' }) } })
    expect(mayEditProfile(st(), 's')).toBe(true)
    useStore.setState({ servers: { s: serverDetail('s', { profiles_mode: 'off' }) } })
    expect(mayEditProfile(st(), 's')).toBe(false)
    // A server not opened here: its summary says.
    const summary = { name: 's', display_name: 's', creator: null, is_admin: false }
    useStore.setState({
      servers: {},
      me: me('alice', { servers: [{ ...summary, profiles_mode: 'off' }] }),
    })
    expect(mayEditProfile(st(), 's')).toBe(false)
    useStore.setState({ me: me('alice', { servers: [{ ...summary, profiles_mode: 'no_names' }] }) })
    expect(mayEditProfile(st(), 's')).toBe(true)
    useStore.setState({
      servers: { s: serverDetail('s', { profiles_mode: 'all' }) },
      settings: { ...st().settings, server_profiles: false },
    })
    expect(mayEditProfile(st(), 's')).toBe(false)
    useStore.setState({
      settings: { ...st().settings, server_profiles: true },
      me: me('alice', {
        servers: [
          {
            name: 's',
            display_name: 's',
            creator: null,
            is_admin: false,
            timed_out_until: Math.floor(Date.now() / 1000) + 600,
          },
        ],
      }),
    })
    expect(mayEditProfile(st(), 's')).toBe(false)
    useStore.setState({ guest: true })
    expect(mayEditProfile(st(), 's')).toBe(false)
  })
})

describe('resetting a member', () => {
  test('a reset with a lock and an unlock are sent and the lock is remembered', async () => {
    const calls = profileRoutes(() => json({ ok: true }))
    const key = profileKey('bob', 's')
    rememberProfile(key, { username: 'bob' } as unknown as Profile, sessionMark())
    expect(await st().resetMemberProfile('s', 'bob', ['name', 'bio'], 86400, ' spam ')).toBeNull()
    expect(cachedProfile(key)).toBeNull()
    expect(profileLockedFor(st(), 's', 'bob')).toBe(true)
    expect(profileLockedFor(st(), 's', 'bob', Date.now() + 2 * 86_400_000)).toBe(false)
    await st().unlockMemberProfile('s', 'bob')
    expect(profileLockedFor(st(), 's', 'bob')).toBe(false)
    expect(st().profileLocks).toEqual({ s: {} })
    expect(calls).toEqual([
      [
        'POST',
        '/api/servers/s/members/bob/profile/reset',
        { fields: ['name', 'bio'], lock_secs: 86400, reason: 'spam' },
      ],
      ['DELETE', '/api/servers/s/members/bob/profile/lock', undefined],
    ])
  })

  test('a reset without a lock leaves what is known of a lock, and a refusal answers why', async () => {
    profileRoutes(() => json({ ok: true }))
    st().noteProfileLock('s', 'bob', 4102444800)
    expect(await st().resetMemberProfile('s', 'bob', ['name'], null, '')).toBeNull()
    expect(st().profileLocks.s?.bob).toBe(4102444800)
    st().noteProfileLock('s', 'bob', undefined)
    expect(st().profileLocks.s).toEqual({})
    profileRoutes(() => json({ error: 'Missing permission' }, 403))
    expect(await st().resetMemberProfile('s', 'bob', ['name'], -1, '')).toBe('Missing permission')
    expect(profileLockedFor(st(), 's', 'bob')).toBe(false)
  })

  test('a lock until lifted counts as running whatever number the server sends for it', () => {
    st().noteProfileLock('s', 'bob', Number('9223372036854775807'))
    expect(profileLockedFor(st(), 's', 'bob')).toBe(true)
  })
})
