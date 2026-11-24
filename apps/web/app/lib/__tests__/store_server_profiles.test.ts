import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { cachedProfile, profileKey, rememberProfile } from '../profile'
import { lookOf } from '../server_profile'
import { sessionMark } from '../slices/ctx'
import { resetSessionCaches, useStore } from '../store'
import type { Member, MemberLook, Profile, ProfilesMode, WsEvent } from '../types'
import { me, member, paged, serverDetail, until } from './fixtures'

afterAll(resetSessionCaches)

const st = () => useStore.getState()
const dispatch = (ev: WsEvent) => st().applyWsEvent(ev)
const tick = () => new Promise(r => setTimeout(r, 0))
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
    return new Response(JSON.stringify(rows), { status: 200 })
  }) as typeof fetch
  useStore.setState({
    guest: false,
    view: null,
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
