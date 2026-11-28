import { expect, test } from 'bun:test'
import type { P2pChat } from '../p2p/app/store'
import type { P2pMessage } from '../p2p/dm'
import { featureAt, isUnsupported } from '../place/feature'
import { messages, type Messages } from '../place/messages'
import { HostedServer, P2pDm, type Place } from '../place/place'
import type { RChatState } from '../store_types'
import { me, msg, user } from './fixtures'
import { createPeerFixture } from './peer_fixture'
import { testAccount } from './test_account'

const at = (place: Place): Messages => {
  const here = featureAt(messages, place)
  if (isUnsupported(here)) throw new Error(here.line)
  return here
}

const settled = () => new Promise(r => setTimeout(r, 0))

const hosted = (state: Partial<RChatState>) => {
  const account = testAccount('ann')
  account.store.setState({
    me: me('ann'),
    view: { kind: 'channel', server: 'club', channelId: 1 },
    ...state,
  })
  return { account, list: at(HostedServer.open(account, 'club')) }
}

const from = (ids: number[], author = 'bob') =>
  ids.map(id => msg(id, { author: user(author), created_at: id * 10 }))

test('a hosted list marks the first message after the read marker and counts what follows', () => {
  const { list } = hosted({
    messages: { c1: from([1, 2, 3, 4, 5]) },
    unreadAnchor: { c1: 2 },
    older: { c1: { more: false, loading: false } },
  })
  expect(list.unread.get()).toEqual({
    divider: 2,
    banner: { count: 3, more: false, since: 30_000 },
  })
  expect(list.unread.get()).toBe(list.unread.get())
})

test('a hosted list read to its end has no line and no banner', () => {
  const { list } = hosted({ messages: { c1: from([1, 2]) }, unreadAnchor: { c1: 2 } })
  expect(list.unread.get()).toEqual({ divider: -1, banner: null })
  expect(list.unread.initial?.()).toEqual({ divider: -1, banner: null })
})

test('your own last message moves the hosted line past it', () => {
  const rows = [...from([1, 2]), ...from([3], 'ann'), ...from([4])]
  const { list } = hosted({
    messages: { c1: rows },
    unreadAnchor: { c1: 1 },
    older: { c1: { more: false, loading: false } },
  })
  expect(list.unread.get().divider).toBe(3)
})

test('a hosted list opened below its unread part asks the instance once it is watched', async () => {
  const { account, list } = hosted({
    messages: { c1: from([1, 2]) },
    unreadAnchor: { c1: 2 },
    newer: { c1: { more: true, loading: false } },
  })
  const asked: [string, number][] = []
  account.api.getUnreadCount = async (scope, after) => {
    asked.push([scope, after])
    return { count: 7, more: true, since: 5, latest: 9 }
  }
  expect(list.unread.get()).toEqual({ divider: -1, banner: null })
  let changes = 0
  const off = list.unread.subscribe(() => void (changes += 1))
  const stop = list.watchUnread()
  await settled()
  expect(asked).toEqual([['c1', 2]])
  expect(changes).toBeGreaterThan(0)
  expect(list.unread.get()).toEqual({ divider: -1, banner: { count: 7, more: true, since: 5000 } })
  account.store.setState({ typing: {} })
  await settled()
  expect(asked.length).toBe(1)
  stop()
  off()
})

const row = (id: string, seq: number, sender = 'PEER'): P2pMessage =>
  ({ id, sender, seq, ts: seq, sortKey: id, reactions: [], reply: null }) as unknown as P2pMessage

const peer = (chat: Partial<P2pChat>) => {
  const app = createPeerFixture(testAccount('ann'), 'ann')
  app.useP2p.setState({
    me: 'ME',
    chat: {
      room: 'dm',
      peer: 'PEER',
      messages: [],
      more: false,
      loading: false,
      readSeq: 0,
      missed: [],
      ...chat,
    },
  })
  return { app, list: at(P2pDm.open(app, 'dm')) }
}

test('a P2P list marks the first message after the read marker and counts what follows', () => {
  const { list } = peer({ messages: [row('a', 1), row('b', 2), row('c', 3)], readSeq: 1 })
  expect(list.unread.get()).toEqual({ divider: 1, banner: { count: 2, more: false, since: 2 } })
})

test('a P2P list with nothing unread, or with none open, has no line', () => {
  expect(peer({ messages: [row('a', 1)], readSeq: 1 }).list.unread.get().banner).toBeNull()
  const { app, list } = peer({})
  app.useP2p.setState({ chat: null })
  expect(list.unread.get()).toEqual({ divider: -1, banner: null })
})

test('a P2P list whose unread part may start before its rows looks the first one up', async () => {
  const { app, list } = peer({
    messages: [row('a', 5), row('b', 6)],
    readSeq: 2,
    more: true,
    unread: 4,
    unreadSeq: 6,
  })
  let looked = 0
  app.p2pDm.firstUnread = async () => {
    looked += 1
    return { id: 'a', ts: 5 }
  }
  expect(list.unread.get()).toEqual({ divider: -1, banner: { count: 4, more: false, since: null } })
  const stop = list.watchUnread()
  await settled()
  expect(looked).toBe(1)
  expect(list.unread.get().divider).toBe(0)
  const jumped: string[] = []
  app.p2pDm.jumpTo = async id => void jumped.push(id)
  list.toUnread()
  expect(jumped).toEqual(['a'])
  stop()
})
