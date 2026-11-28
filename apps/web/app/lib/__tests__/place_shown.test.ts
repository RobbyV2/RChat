import { expect, test } from 'bun:test'
import type { P2pChat, P2pThread } from '../p2p/app/store'
import type { Contact } from '../p2p/contacts'
import type { P2pMessage } from '../p2p/dm'
import { chat } from '../place/chat'
import { featureAt, isUnsupported } from '../place/feature'
import { P2pDm, P2pRoom } from '../place/place'
import { reactPickOf, shownOf } from '../place/shown'
import { msg } from './fixtures'
import { createPeerFixture } from './peer_fixture'
import { testAccount } from './test_account'

const row = (id: string, ts: number, over: Partial<P2pMessage> = {}): P2pMessage =>
  ({
    id,
    sender: 'PEER',
    ts,
    sortKey: id,
    body: id,
    reply: null,
    fwd: null,
    att: [],
    edited: null,
    pinned: null,
    reactions: [],
    ...over,
  }) as P2pMessage

const open = (room: string, messages: P2pMessage[], over: Partial<P2pChat> = {}): P2pChat => ({
  room,
  peer: 'PEER',
  messages,
  more: false,
  loading: false,
  readSeq: 0,
  missed: [],
  ...over,
})

const identity = () => {
  const app = createPeerFixture(testAccount('ann'), 'ann')
  const peer = { ik: 'PEER', name: 'Robert', petname: 'Bob', state: 'mutual' } as Contact
  app.useP2p.setState({ me: 'ME', name: 'Ann', contacts: [peer] })
  return app
}

test('a conversation numbers its rows in order and names both parties', () => {
  const app = identity()
  const place = P2pDm.open(app, 'dm')
  const shown = shownOf(place)
  expect(shown.get().rows).toEqual([])
  app.useP2p.setState({
    chat: open('dm', [row('a', 5), row('b', 5, { sender: 'ME' }), row('c', 9)]),
  })
  const list = shown.get()
  expect(list.rows.map(r => r.m.id)).toEqual([5000, 5001, 9000])
  expect(list.idOf(5001)).toBe('b')
  expect(list.message('c')?.ts).toBe(9)
  expect(list.rows.map(r => r.m.author.display_name)).toEqual(['Bob', 'Ann', 'Bob'])
  expect(list.name('ME')).toBe('Ann')
  expect([...list.names]).toEqual([
    ['robert', 'PEER'],
    ['bob', 'PEER'],
    ['ann', 'ME'],
  ])
  expect(list.people('ro').map(u => u.username)).toEqual(['Robert'])
  expect(shown.get()).toBe(list)
})

test('the list of another conversation stays empty', () => {
  const app = identity()
  app.useP2p.setState({ chat: open('other', [row('a', 1)]) })
  expect(shownOf(P2pDm.open(app, 'dm')).get().rows).toEqual([])
  expect(shownOf(P2pRoom.open(app, 'other')).get().rows).toEqual([])
})

test('a quoted message outside the list takes a number of its own', () => {
  const app = identity()
  const reply = { id: 'gone', sender: 'ME', body: 'earlier' } as P2pMessage['reply']
  app.useP2p.setState({
    chat: open('dm', [row('a', 1), row('b', 2, { reply }), row('c', 3, { reply })]),
  })
  const list = shownOf(P2pDm.open(app, 'dm')).get()
  const quoted = list.rows[1].m.reply_to?.id as number
  expect(quoted).toBeLessThan(0)
  expect(list.rows[2].m.reply_to?.id).toBe(quoted)
  expect(list.idOf(quoted)).toBe('gone')
})

test('a conversation shows the calls missed in it among its rows', () => {
  const app = identity()
  const missed = [{ id: 'k', from: 'PEER', video: false, at: 2 }]
  app.useP2p.setState({ chat: open('dm', [row('a', 1), row('b', 3)], { missed }) })
  const list = shownOf(P2pDm.open(app, 'dm')).get()
  expect(list.messages.map(m => m.id)).toEqual(['a', 'call:k', 'b'])
  expect(list.rows[1].p.call?.outcome).toBe('missed')
})

test('the thread of a place is a list of its own, first message first', () => {
  const app = identity()
  const thread: P2pThread = {
    room: 'dm',
    ch: null,
    root: 'a',
    head: row('a', 1),
    messages: [row('r', 4)],
    more: false,
    loading: false,
  }
  app.useP2p.setState({ chat: open('dm', [row('a', 1), row('b', 2)]), thread })
  const main = P2pDm.open(app, 'dm')
  const inThread = P2pDm.open(app, 'dm', 'thread')
  expect(inThread).not.toBe(main)
  expect(inThread).toBe(P2pDm.open(app, 'dm', 'thread'))
  expect(inThread.id).toBe(main.id)
  expect(
    shownOf(inThread)
      .get()
      .messages.map(m => m.id)
  ).toEqual(['a', 'r'])
  expect(
    shownOf(main)
      .get()
      .messages.map(m => m.id)
  ).toEqual(['a', 'b'])
  expect(shownOf(P2pRoom.open(app, 'dm', 'thread')).get().rows).toEqual([])
})

test('each list has its own reaction picker and reacts by its own numbers', () => {
  const app = identity()
  const reacted: string[] = []
  app.p2pDm.react = async id => {
    reacted.push(id)
    return null
  }
  const thread: P2pThread = {
    room: 'dm',
    ch: null,
    root: 'a',
    head: null,
    messages: [row('r', 1)],
    more: false,
    loading: false,
  }
  app.useP2p.setState({ chat: open('dm', [row('a', 1)]), thread })
  const main = P2pDm.open(app, 'dm')
  const inThread = P2pDm.open(app, 'dm', 'thread')
  for (const place of [main, inThread]) {
    const here = featureAt(chat, place)
    if (isUnsupported(here)) throw new Error(here.line)
    here.toggleReaction(msg(1000), '👍', false)
  }
  expect(reacted).toEqual(['a', 'r'])
  const here = featureAt(chat, inThread)
  if (isUnsupported(here)) throw new Error(here.line)
  const m = msg(1000)
  here.openReactPicker(m, null)
  expect(reactPickOf(inThread).get()).toEqual({ m, anchor: null })
  expect(reactPickOf(main).get()).toBeNull()
})
