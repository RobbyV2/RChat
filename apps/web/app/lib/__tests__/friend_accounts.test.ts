import { test, expect } from 'bun:test'
import { friendNames } from '../client/friend_names'
import { testAccount } from './test_account'
import { client } from '../client/client'
import { user } from './fixtures'
import type { Ping } from '../types'

test('qualified Friends names select an eligible sender and require another submission', () => {
  const targets = [
    { account: 1, host: 'alpha.example', lastShown: 4 },
    { account: 2, host: 'alpha.example', lastShown: 6 },
    { account: 3, host: 'beta.example:8443', lastShown: 1 },
  ]
  expect(friendNames('Éléa, @bob bob', 1, targets)).toEqual({ names: ['éléa', 'bob'] })
  expect(friendNames('bob@alpha.example', 1, targets)).toEqual({ names: ['bob'] })
  expect(friendNames('Éléa@alpha.example', 3, targets)).toEqual({
    error: 'éléa is on alpha.example. Send as your account there.',
    as: 2,
  })
  expect(friendNames('carol@beta.example:8443', 2, targets)).toEqual({
    error: 'carol is on beta.example:8443. Send as your account there.',
    as: 3,
  })
  expect(friendNames('bob@new.example', 1, targets)).toEqual({
    error: "You're not signed in on new.example. Friends are per instance.",
    host: 'new.example',
  })
  expect(friendNames('bob@alpha.example@beta.example:8443', 1, targets).error).toBe(
    'Enter a username or username@host.'
  )
  expect(friendNames('alice@alpha.example carol@beta.example:8443', 1, targets).error).toBe(
    'Add names from one instance at a time.'
  )
})

test('a hidden account with a saved Friends panel keeps its ping until that account section is displayed', () => {
  const a = testAccount('alice', 'https://a-friends.example'),
    b = testAccount('alice', 'https://b-friends.example')
  const old = client.shown()
  try {
    client.show(a, 'none')
    b.store.setState({ panel: { kind: 'friends', tab: 'pending' } })
    const ping = {
      id: 11,
      scope: 'friends',
      kind: 'friend_request',
      actor: user('carol'),
      server: null,
      thread_root_id: null,
    } as Ping
    b.store.getState().applyWsEvent({ type: 'ping', username: 'alice', ping })
    expect(b.store.getState().pings.friends?.ids).toEqual([11])
    expect(a.store.getState().pings.friends).toBeUndefined()
    const hide = b.store.getState().observeFriendsPanel()
    expect(b.store.getState().pings.friends).toBeUndefined()
    hide()
    b.store.getState().applyWsEvent({ type: 'ping', username: 'alice', ping: { ...ping, id: 12 } })
    expect(b.store.getState().pings.friends?.ids).toEqual([12])
    expect(client.shown()).toBe(a)
  } finally {
    client.show(old, 'none')
    a.store.dispose()
    b.store.dispose()
  }
})

const peer = user('bob')
const friend = { user: peer, online: true, since: 3 }
const request = { user: peer, incoming: true, created_at: 2 }
const page = <T>(list: T[]) => ({ list, hasMore: false, loading: false, q: '' })

test('parked owner reconciles HTTP mutations without events or changes to the shown account', async () => {
  const owner = testAccount('alice', 'https://owner.example')
  const shown = client.shown()
  const before = shown.store.getState()
  const state = owner.store.getState
  try {
    owner.mode = 'parked'
    owner.store.setState({
      friends: page([]),
      onlineFriends: page([]),
      incomingRequests: page([request]),
      friendCounts: { incoming: 1, outgoing: 0 },
    })
    const accepted = Promise.withResolvers<typeof friend>()
    owner.api.acceptFriend = () => accepted.promise
    owner.api.friendSummary = async () => ({ incoming: 0, outgoing: 0, pings: 0, pings_until: 0 })
    const accepting = state().acceptFriend(peer)
    expect(state().incomingRequests.list).toEqual([request])
    accepted.resolve(friend)
    await accepting
    expect(state().friends.list).toEqual([friend])
    expect(state().onlineFriends.list).toEqual([friend])
    expect(state().incomingRequests.list).toEqual([])
    expect(state().friendCounts.incoming).toBe(0)
    const removed = Promise.withResolvers<unknown>()
    owner.api.removeFriend = () => removed.promise
    const removing = state().removeFriend(peer)
    removed.resolve({})
    await removing
    expect(state().friends.list).toEqual([])
    expect(state().onlineFriends.list).toEqual([])

    for (const op of ['deny', 'cancel', 'block'] as const) {
      const incoming = op !== 'cancel'
      owner.store.setState({
        friends: page(op === 'block' ? [friend] : []),
        onlineFriends: page(op === 'block' ? [friend] : []),
        incomingRequests: page(incoming ? [request] : []),
        outgoingRequests: page(incoming ? [] : [{ ...request, incoming }]),
        friendCounts: { incoming: +incoming, outgoing: +!incoming },
      })
      const held = Promise.withResolvers<{ user: typeof peer; blocked_at: number }>()
      owner.api.denyFriend = owner.api.cancelFriendRequest = owner.api.block = () => held.promise
      const pending =
        op === 'block'
          ? state().blockUser('bob')
          : op === 'cancel'
            ? state().cancelFriendRequest('bob')
            : state().denyFriend('bob')
      held.resolve({ user: peer, blocked_at: 4 })
      await pending
      expect(state().incomingRequests.list).toEqual([])
      expect(state().outgoingRequests.list).toEqual([])
      expect(state().friends.list).toEqual([])
      expect(state().onlineFriends.list).toEqual([])
      expect(state().friendCounts).toEqual({ incoming: 0, outgoing: 0 })
    }
    expect(client.shown()).toBe(shown)
    expect(shown.store.getState().friends).toBe(before.friends)
    expect(shown.store.getState().friendCounts).toBe(before.friendCounts)
  } finally {
    owner.store.dispose()
  }
})

test('held accept respects echoed events, later removal, and a replacement session', async () => {
  const owner = testAccount('alice')
  const state = owner.store.getState
  try {
    owner.api.friendSummary = async () => ({ incoming: 0, outgoing: 0, pings: 0, pings_until: 0 })
    owner.api.removeFriend = async () => ({})
    for (const after of ['echo', 'remove', 'session'] as const) {
      owner.store.setState({
        friends: page([]),
        onlineFriends: page([]),
        incomingRequests: page([request]),
        friendCounts: { incoming: 1, outgoing: 0 },
      })
      const held = Promise.withResolvers<typeof friend>()
      owner.api.acceptFriend = () => held.promise
      const pending = state().acceptFriend(peer)
      if (after === 'echo') {
        state().applyWsEvent({ type: 'friend_request_removed', username: 'alice', other: 'bob' })
        state().applyWsEvent({ type: 'friend_added', username: 'alice', friend })
        state().applyWsEvent({
          type: 'friend_presence',
          username: 'alice',
          friend: 'bob',
          online: false,
        })
      } else if (after === 'remove') await state().removeFriend(peer)
      else owner.lifetime.endSession()
      held.resolve(friend)
      await pending
      expect(state().friends.list).toEqual(after === 'echo' ? [{ ...friend, online: false }] : [])
      expect(state().onlineFriends.list).toEqual([])
      expect(state().incomingRequests.list).toEqual(after === 'session' ? [request] : [])
      expect(state().friendCounts.incoming).toBe(after === 'session' ? 1 : 0)
    }
  } finally {
    owner.store.dispose()
  }
})

test('a newer outgoing request survives an old cancel reply and an old count response', async () => {
  const owner = testAccount('alice')
  const state = owner.store.getState
  const outgoing = { ...request, incoming: false }
  const summary = { incoming: 0, outgoing: 1, pings: 0, pings_until: 0 }
  const stale = Promise.withResolvers<typeof summary>()
  const held = Promise.withResolvers<unknown>()
  try {
    owner.store.setState({
      outgoingRequests: page([outgoing]),
      friendCounts: { incoming: 0, outgoing: 1 },
    })
    owner.api.cancelFriendRequest = () => held.promise
    owner.api.friendSummary = () => stale.promise
    const cancel = state().cancelFriendRequest('bob')
    state().applyWsEvent({ type: 'friend_request_removed', username: 'alice', other: 'bob' })
    owner.api.friendSummary = async () => summary
    const replacement = { ...outgoing, created_at: 4 }
    state().applyWsEvent({ type: 'friend_request_added', username: 'alice', request: replacement })
    held.resolve({})
    await cancel
    stale.resolve({ ...summary, outgoing: 0 })
    await stale.promise
    expect(state().outgoingRequests.list).toEqual([replacement])
    expect(state().friendCounts.outgoing).toBe(1)
  } finally {
    owner.store.dispose()
  }
})

test('parked accept preserves newer profile and presence before its first friend row exists', async () => {
  const a = testAccount('alice', 'https://accept-a.example')
  const b = testAccount('alice', 'https://accept-b.example')
  const previous = client.shown()
  try {
    client.show(a, 'none')
    b.mode = 'parked'
    const elsewhere = user('bob', { display_name: 'Alpha Bob' })
    a.store.setState({ friends: page([{ ...friend, user: elsewhere }]) })
    for (const online of [false, true]) {
      b.store.setState({
        friends: page([]),
        onlineFriends: page([]),
        incomingRequests: page([request]),
        friendCounts: { incoming: 1, outgoing: 0 },
      })
      b.api.friendSummary = async () => ({ incoming: 0, outgoing: 0, pings: 0, pings_until: 0 })
      const held = Promise.withResolvers<typeof friend>()
      b.api.acceptFriend = () => held.promise
      const state = b.store.getState
      const accepting = state().acceptFriend(peer)
      const fresh = user('bob', { display_name: 'Beta Bob', avatar_color: '#aabbcc' })
      state().applyWsEvent({
        type: 'friend_presence',
        username: 'alice',
        friend: 'bob',
        online: !online,
      })
      state().applyWsEvent({ type: 'user_updated', user: fresh })
      state().applyWsEvent({ type: 'friend_presence', username: 'alice', friend: 'bob', online })
      a.store.getState().applyWsEvent({ type: 'user_updated', user: elsewhere })
      expect(state().friends.list).toEqual([])
      held.resolve({ ...friend, online: !online })
      await accepting
      const expected = { ...friend, user: fresh, online }
      expect(state().friends.list).toEqual([expected])
      expect(state().onlineFriends.list).toEqual(online ? [expected] : [])
      expect(state().incomingRequests.list).toEqual([])
      expect(state().friendCounts.incoming).toBe(0)
      expect(a.store.getState().friends.list).toEqual([{ ...friend, user: elsewhere }])
      expect(client.shown()).toBe(a)
    }
  } finally {
    client.show(previous, 'none')
    a.store.dispose()
    b.store.dispose()
  }
})

for (const status of ['sent', 'accepted', 'friends'] as const) {
  test(`a delayed send reporting ${status} uses the latest profile from its own account`, async () => {
    const owner = testAccount('alice', 'https://send-b.example')
    try {
      const fresh = user('bob', { display_name: 'Updated Bob' })
      const held = Promise.withResolvers<Awaited<ReturnType<typeof owner.api.sendFriendRequest>>>()
      owner.api.sendFriendRequest = () => held.promise
      owner.api.friendSummary = async () => ({ incoming: 0, outgoing: 1, pings: 0, pings_until: 0 })
      owner.api.friendRequests = async () => ({ items: [], next: null })
      owner.api.friends = async () => ({ items: [], next: null })
      const sending = owner.store.getState().sendFriendRequest('bob')
      owner.store.getState().applyWsEvent({ type: 'user_updated', user: fresh })
      held.resolve({ status, user: peer })
      expect(await sending).toEqual({ ok: true, status, user: fresh })
    } finally {
      owner.store.dispose()
    }
  })
}
