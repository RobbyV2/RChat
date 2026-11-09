import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { useStore, resetSessionCaches } from '../store'
import type { Friend, FriendRequest, Message, WsEvent } from '../types'
import { me, msg, serverDetail, user } from './fixtures'

afterAll(resetSessionCaches)

const st = () => useStore.getState()
const dispatch = (ev: WsEvent) => st().applyWsEvent(ev)
const page = <T>(list: T[]) => ({ list, hasMore: false, loading: false, q: '' })
const painted = user('alice', { avatar_color: '#4f46b8' })
const quote = (author: string): Message['reply_to'] => ({
  id: 10,
  author: user(author),
  content: 'hello',
  has_media: false,
  deleted: false,
  mention: false,
})
const friend = (name: string): Friend => ({ user: user(name), since: 1, online: true })
const request = (name: string, incoming: boolean): FriendRequest => ({
  user: user(name),
  created_at: 1,
  incoming,
})

beforeEach(() => {
  useStore.setState({
    me: me('bob'),
    token: 't',
    guest: false,
    view: { kind: 'channel', server: 's', channelId: 1 },
    servers: { s: serverDetail('s') },
    messages: {
      c1: [
        msg(10, { author: user('alice') }),
        msg(11, { author: user('bob'), reply_to: quote('alice') }),
        msg(12, { author: user('carol'), reply_to: quote('carol') }),
        msg(13, { author: user('alice'), reply_to: quote('alice') }),
      ],
    },
    panel: null,
    friends: page([friend('alice'), friend('carol')]),
    onlineFriends: page([friend('alice')]),
    incomingRequests: page([request('alice', true), request('dora', true)]),
    outgoingRequests: page([request('alice', false)]),
  })
})

describe('a changed avatar shows live', () => {
  test('on reply previews that quote the user', () => {
    const before = st().messages.c1
    dispatch({ type: 'user_updated', user: painted })
    const [own, reply, other, both] = st().messages.c1
    expect(own.author).toEqual(painted)
    expect(reply.author).toEqual(user('bob'))
    expect(reply.reply_to?.author).toEqual(painted)
    expect(reply.reply_to?.content).toBe('hello')
    expect(both.author).toEqual(painted)
    expect(both.reply_to?.author).toEqual(painted)
    expect(other).toBe(before[2])
  })

  test('in the friends lists and friend requests', () => {
    const before = st()
    dispatch({ type: 'user_updated', user: painted })
    expect(st().friends.list.map(f => f.user)).toEqual([painted, user('carol')])
    expect(st().friends.list[0]).toMatchObject({ since: 1, online: true })
    expect(st().friends.list[1]).toBe(before.friends.list[1])
    expect(st().onlineFriends.list.map(f => f.user)).toEqual([painted])
    expect(st().incomingRequests.list.map(r => r.user)).toEqual([painted, user('dora')])
    expect(st().incomingRequests.list[0].incoming).toBe(true)
    expect(st().outgoingRequests.list.map(r => r.user)).toEqual([painted])
  })

  test('an update for someone else leaves the lists alone', () => {
    const before = st()
    dispatch({ type: 'user_updated', user: user('zed', { avatar_color: '#112233' }) })
    expect(st().friends).toBe(before.friends)
    expect(st().onlineFriends).toBe(before.onlineFriends)
    expect(st().incomingRequests).toBe(before.incomingRequests)
    expect(st().outgoingRequests).toBe(before.outgoingRequests)
    expect(st().messages.c1[1]).toBe(before.messages.c1[1])
  })
})
