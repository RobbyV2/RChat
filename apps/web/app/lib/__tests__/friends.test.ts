import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { useStore, resetSessionCaches } from '../store'
import { home } from '../instances'
import {
  addRequest,
  friendOrder,
  parseAddCommand,
  parseNames,
  parsePrivacy,
  placeFriend,
  setOnline,
} from '../friends'
import { mergePings, pingCount } from '../pings'
import { dmPingCount } from '../selectors'
import { friendMenuItem } from '../../components/friends'
import type { Friend, FriendRequest, Ping, WsEvent } from '../types'
import { me, memoryStorage, user } from './fixtures'

afterAll(resetSessionCaches)

const st = () => useStore.getState()
const dispatch = (ev: WsEvent) => st().applyWsEvent(ev)
const tick = () => new Promise(r => setTimeout(r, 0))
const friend = (name: string, online = false, display = name): Friend => ({
  user: user(name, { display_name: display }),
  since: 1,
  online,
})
const request = (name: string, incoming = true, at = 1): FriendRequest => ({
  user: user(name),
  created_at: at,
  incoming,
})
const page = <T>(list: T[], hasMore = false) => ({ list, hasMore, loading: false, q: '' })
const friendPing = (id: number, kind: Ping['kind'] = 'friend_request', actor = 'bob'): Ping => ({
  id,
  kind,
  scope: 'friends',
  server: null,
  message_id: 0,
  thread_root_id: null,
  actor: user(actor, { display_name: actor.toUpperCase() }),
  emoji: null,
  excerpt: '',
  created_at: 1,
})

type Call = { method: string; url: string; body?: string }
let calls: Call[] = []
let routes: [RegExp, unknown, number?][] = []
const realFetch = globalThis.fetch
const g = globalThis as { window?: unknown; document?: unknown }
const real = { window: g.window, document: g.document }

beforeEach(() => {
  calls = []
  routes = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      method: init?.method ?? 'GET',
      url: url.replace(/^https?:\/\/[^/]+/, ''),
      body: init?.body as string | undefined,
    })
    const hit = routes.find(([re]) => re.test(url))
    return new Response(JSON.stringify(hit ? hit[1] : []), { status: hit?.[2] ?? 200 })
  }) as typeof fetch
  Object.assign(globalThis, { localStorage: memoryStorage })
  g.window = {
    location: { pathname: '/', href: 'http://x/', origin: 'http://x', protocol: 'http:' },
    history: { state: null, pushState: () => {}, replaceState: () => {} },
  }
  g.document = { cookie: '', visibilityState: 'visible' }
  useStore.setState({
    token: 'tok',
    me: me('alice'),
    guest: false,
    panel: null,
    activeDialog: null,
    friends: page([]),
    onlineFriends: page([]),
    incomingRequests: page([]),
    outgoingRequests: page([]),
    friendCounts: { incoming: 0, outgoing: 0 },
    privacy: null,
    pings: {},
    notices: [],
    toast: null,
  })
})

afterEach(() => {
  home.ws.stop()
  globalThis.fetch = realFetch
  g.window = real.window
  g.document = real.document
  useStore.setState({ token: null, panel: null, pings: {}, notices: [] })
})

describe('friend helpers', () => {
  test('names and the add command', () => {
    expect(parseNames('alice, @Bob  carol bob')).toEqual(['alice', 'bob', 'carol'])
    expect(parseNames('@ , ,')).toEqual([])
    expect(parseNames('a b c d e f g h i j k l').length).toBe(10)
    expect(parseAddCommand('Add friend alice')).toEqual(['alice'])
    expect(parseAddCommand('add friends alice bob carol')).toEqual(['alice', 'bob', 'carol'])
    expect(parseAddCommand('friends @dora')).toEqual(['dora'])
    expect(parseAddCommand('add friend')).toBeNull()
    expect(parseAddCommand('open settings')).toBeNull()
  })

  test('privacy is read defensively', () => {
    expect(parsePrivacy({ dms: 'friends', friend_requests: 'servers' })).toEqual({
      dms: 'friends',
      friend_requests: 'servers',
    })
    expect(parsePrivacy({ dms: 'nobody' })).toEqual({
      dms: 'everyone',
      friend_requests: 'everyone',
    })
    expect(parsePrivacy(null).friend_requests).toBe('everyone')
  })

  test('friends stay in server order', () => {
    const list = [friend('a', false, 'Amy'), friend('c', false, 'Cat')]
    expect(friendOrder(user('x', { display_name: 'b' }), user('y', { display_name: 'B' }))).toBe(-1)
    const b = friend('b', true, 'bea')
    expect(placeFriend(list, b, false).map(f => f.user.username)).toEqual(['a', 'b', 'c'])
    const z = friend('z', false, 'Zed')
    expect(placeFriend(list, z, true).map(f => f.user.username)).toEqual(['a', 'c'])
    expect(placeFriend(list, z, false).map(f => f.user.username)).toEqual(['a', 'c', 'z'])
    expect(setOnline(list, 'a', false)).toBe(list)
    expect(setOnline(list, 'a', true)[0].online).toBe(true)
    expect(
      addRequest([request('b'), request('c')], request('c', true, 5)).map(r => r.user.username)
    ).toEqual(['c', 'b'])
  })
})

describe('friends in the store', () => {
  test('events keep the lists current', async () => {
    useStore.setState({
      friends: page([friend('bob', false, 'Bob')]),
      onlineFriends: page([]),
      incomingRequests: page([request('dora')]),
    })
    routes = [[/\/api\/friends\/summary$/, { incoming: 2, outgoing: 0, pings: 1, pings_until: 9 }]]
    dispatch({ type: 'friend_request_added', username: 'alice', request: request('erin', true, 3) })
    dispatch({ type: 'friend_request_added', username: 'bob', request: request('zed') })
    expect(st().incomingRequests.list.map(r => r.user.username)).toEqual(['erin', 'dora'])
    await tick()
    expect(st().friendCounts).toEqual({ incoming: 2, outgoing: 0 })
    expect(pingCount(st().pings.friends)).toBe(1)
    dispatch({ type: 'friend_request_removed', username: 'alice', other: 'dora' })
    expect(st().incomingRequests.list.map(r => r.user.username)).toEqual(['erin'])

    dispatch({ type: 'friend_added', username: 'alice', friend: friend('carol', true, 'Carol') })
    expect(st().friends.list.map(f => f.user.username)).toEqual(['bob', 'carol'])
    expect(st().onlineFriends.list.map(f => f.user.username)).toEqual(['carol'])
    dispatch({ type: 'friend_presence', username: 'alice', friend: 'bob', online: true })
    expect(st().friends.list[0].online).toBe(true)
    expect(st().onlineFriends.list.map(f => f.user.username)).toEqual(['bob', 'carol'])
    dispatch({ type: 'friend_presence', username: 'alice', friend: 'carol', online: false })
    expect(st().onlineFriends.list.map(f => f.user.username)).toEqual(['bob'])
    dispatch({ type: 'friend_removed', username: 'alice', friend: 'bob' })
    expect(st().friends.list.map(f => f.user.username)).toEqual(['carol'])
    expect(st().onlineFriends.list).toEqual([])
    dispatch({
      type: 'privacy_changed',
      username: 'alice',
      privacy: { dms: 'friends', friend_requests: 'nobody' },
    })
    expect(st().privacy).toEqual({ dms: 'friends', friend_requests: 'nobody' })
  })

  test('a friend request pings, toasts and counts on the DM button', () => {
    dispatch({ type: 'ping', username: 'alice', ping: friendPing(4) })
    expect(pingCount(st().pings.friends)).toBe(1)
    expect(dmPingCount(st())).toBe(1)
    expect(st().notices.map(n => n.action)).toEqual(['sent you a friend request'])
    dispatch({ type: 'ping', username: 'alice', ping: friendPing(4) })
    expect(pingCount(st().pings.friends)).toBe(1)
    const before = st().pings
    expect('friends' in mergePings(before, before, [])).toBe(true)
    st().openFriends('pending')
    expect(st().panel).toEqual({ kind: 'friends', tab: 'pending' })
    expect(pingCount(st().pings.friends)).toBe(0)
    expect(calls.filter(c => c.url === '/api/friends/seen')).toEqual([
      { method: 'POST', url: '/api/friends/seen', body: '{"pings_until":4}' },
    ])
  })

  test('with the panel open a ping is seen at once', () => {
    st().openFriends()
    calls = []
    dispatch({ type: 'ping', username: 'alice', ping: friendPing(7, 'friend_accept') })
    expect(pingCount(st().pings.friends)).toBe(0)
    expect(st().notices).toEqual([])
    expect(calls.map(c => c.url)).toEqual(['/api/friends/seen'])
  })

  test('sending several requests reports each one', async () => {
    routes = [[/requests$/, { status: 'sent', user: user('bob', { display_name: 'Bob' }) }]]
    const out = await st().sendFriendRequests(['bob', 'carol'])
    expect(calls.map(c => `${c.method} ${c.url} ${c.body}`)).toEqual([
      'POST /api/friends/requests {"username":"bob"}',
      'POST /api/friends/requests {"username":"carol"}',
    ])
    expect(Object.values(out).every(r => r.ok)).toBe(true)
    expect(st().toast?.text).toBe('Sent 2 of 2 friend requests')
    routes = [[/requests$/, { error: 'Could not send a friend request to that user.' }, 404]]
    expect(await st().sendFriendRequest('nobody')).toEqual({
      ok: false,
      error: 'Could not send a friend request to that user.',
    })
    st().askAddFriends(['bob', 'carol'])
    expect(st().activeDialog).toEqual({ kind: 'add_friends', names: ['bob', 'carol'] })
  })

  test('privacy changes are sent and rolled back on failure', async () => {
    routes = [[/\/api\/me\/privacy$/, { dms: 'everyone', friend_requests: 'everyone' }]]
    await st().loadPrivacy()
    expect(st().privacy).toEqual({ dms: 'everyone', friend_requests: 'everyone' })
    routes = [[/\/api\/me\/privacy$/, { dms: 'friends', friend_requests: 'everyone' }]]
    await st().setPrivacy({ dms: 'friends' })
    expect(calls.at(-1)).toEqual({
      method: 'PATCH',
      url: '/api/me/privacy',
      body: '{"dms":"friends"}',
    })
    expect(st().privacy?.dms).toBe('friends')
    routes = [[/\/api\/me\/privacy$/, { error: 'nope' }, 500]]
    await st().setPrivacy({ friend_requests: 'nobody' })
    expect(st().privacy).toEqual({ dms: 'friends', friend_requests: 'everyone' })
  })

  test('"Add friend" is offered only when no relation is known', () => {
    useStore.setState({
      friends: page([friend('bob')]),
      outgoingRequests: page([request('carol', false)]),
    })
    expect(friendMenuItem(user('bob'))).toBeNull()
    expect(friendMenuItem(user('carol'))).toBeNull()
    expect(friendMenuItem(user('alice'))).toBeNull()
    expect(friendMenuItem(user('dora'))?.label).toBe('Add friend')
  })

  test('list pages use the friends endpoints', async () => {
    await st().loadFriends('Bo', true)
    await st().loadOnlineFriends('', true)
    await st().loadFriendRequests(false, true)
    expect(calls.map(c => c.url)).toEqual([
      '/api/friends?limit=50&q=Bo',
      '/api/friends?limit=50&q=&online=true',
      '/api/friends/requests?limit=50&incoming=false',
    ])
  })
})
