import { describe, expect, test } from 'bun:test'
import {
  GROUP_WINDOW,
  continues,
  groupPlaces,
  messageCue,
  messagePlaces,
  p2pCue,
  type GroupPlace,
} from '../message_groups'
import type { P2pMessage } from '../p2p/dm'
import type { OutgoingStatus } from '../store_types'
import type { Message } from '../types'
import { msg, user } from './fixtures'

// Local noon, so a few minutes either way stay on one calendar day in any time zone.
const NOON = new Date(2026, 10, 17, 12, 0).getTime() / 1000
const MIN = 60

const at = (id: number, seconds: number, over: Partial<Message> = {}) =>
  msg(id, { created_at: NOON + seconds, ...over })

const firsts = (places: GroupPlace[]) => places.map(p => p.first)
const lasts = (places: GroupPlace[]) => places.map(p => p.last)

const bob = user('bob')
const hook = (name: string, over: Partial<Message['author']> = {}) =>
  user('@webhook:7', { display_name: name, ...over })

const quote = {
  id: 1,
  author: user('bob'),
  content: 'hi',
  has_media: false,
  deleted: false,
  mention: false,
  forward: null,
}

const forward = {
  author: bob,
  created_at: NOON - 3600,
  source_id: 1,
  origin: null,
  dropped: null,
  origin_channel: null,
  origin_channel_id: null,
  origin_server: null,
  origin_server_channel: null,
}

describe('messages from one author', () => {
  test('a run within seven minutes shows one header', () => {
    const places = messagePlaces([at(1, 0), at(2, 1 * MIN), at(3, 3 * MIN)])
    expect(firsts(places)).toEqual([true, false, false])
    expect(lasts(places)).toEqual([false, false, true])
  })

  test('seven minutes is the longest gap that joins', () => {
    expect(GROUP_WINDOW).toBe(7 * MIN)
    expect(firsts(messagePlaces([at(1, 0), at(2, 7 * MIN)]))).toEqual([true, false])
    expect(firsts(messagePlaces([at(1, 0), at(2, 7 * MIN + 1)]))).toEqual([true, true])
  })

  test('the gap counts from the previous message, not the first of the group', () => {
    const places = messagePlaces([at(1, 0), at(2, 5 * MIN), at(3, 10 * MIN), at(4, 15 * MIN)])
    expect(firsts(places)).toEqual([true, false, false, false])
  })

  test('a longer gap starts a new header', () => {
    const places = messagePlaces([at(1, 0), at(2, 1 * MIN), at(3, 20 * MIN), at(4, 21 * MIN)])
    expect(firsts(places)).toEqual([true, false, true, false])
    expect(lasts(places)).toEqual([false, true, false, true])
  })

  test('a different author starts a new header, and the first author again after them', () => {
    const places = messagePlaces([at(1, 0), at(2, 1 * MIN, { author: bob }), at(3, 2 * MIN)])
    expect(firsts(places)).toEqual([true, true, true])
    expect(lasts(places)).toEqual([true, true, true])
  })

  test('an account keeps its group when its display name differs between messages', () => {
    const places = messagePlaces([
      at(1, 0, { author: user('alice', { display_name: 'Alice' }) }),
      at(2, 1 * MIN, { author: user('alice', { display_name: 'Ally' }) }),
    ])
    expect(firsts(places)).toEqual([true, false])
  })

  test('a message a little before the previous one (a skewed clock) joins', () => {
    expect(firsts(messagePlaces([at(1, 0), at(2, -30)]))).toEqual([true, false])
    expect(firsts(messagePlaces([at(1, 0), at(2, -8 * MIN)]))).toEqual([true, true])
  })

  test('a new calendar day starts a new header', () => {
    const late = new Date(2026, 10, 17, 23, 58).getTime() / 1000
    const early = new Date(2026, 10, 18, 0, 1).getTime() / 1000
    const places = messagePlaces([msg(1, { created_at: late }), msg(2, { created_at: early })])
    expect(firsts(places)).toEqual([true, true])
  })

  test('the first row always shows its header', () => {
    expect(firsts(messagePlaces([at(1, 0)]))).toEqual([true])
    expect(lasts(messagePlaces([at(1, 0)]))).toEqual([true])
    expect(messagePlaces([])).toEqual([])
  })
})

describe('rows that start their own header', () => {
  test('a reply starts a header, and a plain message after it joins it', () => {
    const places = messagePlaces([at(1, 0), at(2, 1 * MIN, { reply_to: quote }), at(3, 2 * MIN)])
    expect(firsts(places)).toEqual([true, true, false])
  })

  test('a forwarded card starts a header, and a plain message after it joins it', () => {
    const places = messagePlaces([at(1, 0), at(2, 1 * MIN, { forward }), at(3, 2 * MIN)])
    expect(firsts(places)).toEqual([true, true, false])
  })

  test('join, leave, pin and call lines stand alone, and the next message shows its header', () => {
    for (const kind of ['join', 'leave', 'pin', 'call'] as const) {
      const places = messagePlaces([at(1, 0), at(2, 1 * MIN, { kind }), at(3, 2 * MIN)])
      expect(firsts(places)).toEqual([true, true, true])
      expect(lasts(places)).toEqual([true, true, true])
    }
  })

  test('a poll joins its author group like any message', () => {
    const places = messagePlaces([at(1, 0), at(2, 1 * MIN, { kind: 'poll' }), at(3, 2 * MIN)])
    expect(firsts(places)).toEqual([true, false, false])
  })
})

describe('webhook posts', () => {
  test('the same hook under the same name and avatar joins', () => {
    const places = messagePlaces([
      at(1, 0, { author: hook('CI'), webhook: { id: 7, embeds: [] } }),
      at(2, 1 * MIN, { author: hook('CI'), webhook: { id: 7, embeds: [] } }),
    ])
    expect(firsts(places)).toEqual([true, false])
  })

  test('the same hook under another name or avatar starts a new header', () => {
    expect(
      firsts(
        messagePlaces([
          at(1, 0, { author: hook('CI') }),
          at(2, 1 * MIN, { author: hook('Nightly') }),
        ])
      )
    ).toEqual([true, true])
    expect(
      firsts(
        messagePlaces([
          at(1, 0, { author: hook('CI', { avatar_kind: 'color', avatar_color: '#112233' }) }),
          at(2, 1 * MIN, { author: hook('CI', { avatar_kind: 'color', avatar_color: '#445566' }) }),
        ])
      )
    ).toEqual([true, true])
  })

  test('a hook never joins an account, whatever names they show', () => {
    const places = messagePlaces([
      at(1, 0, { author: user('ci', { display_name: 'CI' }) }),
      at(2, 1 * MIN, { author: hook('CI') }),
    ])
    expect(firsts(places)).toEqual([true, true])
  })
})

describe('separators', () => {
  test('the new messages line starts a new header below it', () => {
    const places = messagePlaces([at(1, 0), at(2, 1 * MIN), at(3, 2 * MIN)], new Set([2]))
    expect(firsts(places)).toEqual([true, false, true])
    expect(lasts(places)).toEqual([false, true, true])
  })

  test('a separator above the first row changes nothing', () => {
    expect(firsts(messagePlaces([at(1, 0), at(2, 1 * MIN)], new Set([0])))).toEqual([true, false])
  })
})

describe('a changing list', () => {
  test('edits and reactions change no header', () => {
    const plain = [at(1, 0), at(2, 1 * MIN), at(3, 2 * MIN)]
    const touched = [
      at(1, 0, { edited_at: NOON + 30 * MIN }),
      at(2, 1 * MIN, { reactions: [{ emoji: '👍', count: 2, me: true, first_at: NOON }] }),
      at(3, 2 * MIN, { edited_at: NOON + 40 * MIN, reactions: [] }),
    ]
    expect(messagePlaces(touched)).toEqual(messagePlaces(plain))
  })

  test('a message arriving live joins the group above it, which then ends with it', () => {
    const before = [at(1, 0), at(2, 1 * MIN)]
    expect(lasts(messagePlaces(before))).toEqual([false, true])
    const after = messagePlaces([...before, at(3, 2 * MIN)])
    expect(firsts(after)).toEqual([true, false, false])
    expect(lasts(after)).toEqual([false, false, true])
  })

  test('a message arriving live from someone else starts its own header', () => {
    const after = messagePlaces([at(1, 0), at(2, 1 * MIN), at(3, 2 * MIN, { author: bob })])
    expect(firsts(after)).toEqual([true, false, true])
    expect(lasts(after)).toEqual([false, true, true])
  })

  test('deleting from the middle of a group keeps the next row joined while the rule holds', () => {
    const list = [at(1, 0), at(2, 3 * MIN), at(3, 6 * MIN)]
    expect(firsts(messagePlaces(list.filter(m => m.id !== 2)))).toEqual([true, false])
  })

  test('deleting the message that bridged a gap gives the next row its header back', () => {
    const list = [at(1, 0), at(2, 5 * MIN), at(3, 10 * MIN)]
    expect(firsts(messagePlaces(list))).toEqual([true, false, false])
    expect(firsts(messagePlaces(list.filter(m => m.id !== 2)))).toEqual([true, true])
  })

  test('deleting the group head gives the next row the header', () => {
    const list = [at(1, 0, { author: bob }), at(2, 1 * MIN), at(3, 2 * MIN)]
    expect(firsts(messagePlaces(list))).toEqual([true, true, false])
    expect(firsts(messagePlaces(list.filter(m => m.id !== 2)))).toEqual([true, true])
  })

  test('deleting the other author between two runs merges them', () => {
    const list = [at(1, 0), at(2, 1 * MIN, { author: bob }), at(3, 2 * MIN)]
    expect(firsts(messagePlaces(list.filter(m => m.id !== 2)))).toEqual([true, false])
  })

  test('an older page loaded above joins the group that was first', () => {
    const shown = [at(10, 10 * MIN), at(11, 11 * MIN)]
    expect(firsts(messagePlaces(shown))).toEqual([true, false])
    const older = [at(8, 0, { author: bob }), at(9, 8 * MIN)]
    const places = messagePlaces([...older, ...shown])
    expect(firsts(places)).toEqual([true, true, false, false])
    expect(lasts(places)).toEqual([true, false, false, true])
  })

  test('an older page from long before keeps the first group header', () => {
    const shown = [at(10, 60 * MIN), at(11, 61 * MIN)]
    const places = messagePlaces([at(8, 0), at(9, 1 * MIN), ...shown])
    expect(firsts(places)).toEqual([true, false, true, false])
  })
})

describe('the cue of an instance message', () => {
  test('names the account, or a hook with the name and avatar it posted under', () => {
    expect(messageCue(at(1, 0)).who).toBe(messageCue(at(2, 0)).who)
    expect(messageCue(at(1, 0)).who).not.toBe(messageCue(at(2, 0, { author: bob })).who)
    expect(messageCue(at(1, 0, { author: hook('CI') })).who).not.toBe(
      messageCue(at(2, 0, { author: hook('CD') })).who
    )
  })

  test('a reply whose quote is deleted starts a header', () => {
    const cue = messageCue(at(1, 0, { reply_to: { ...quote, author: null, deleted: true } }))
    expect(cue.head).toBe(true)
  })

  test('continues needs a row before it', () => {
    expect(continues(undefined, messageCue(at(1, 0)))).toBe(false)
    expect(continues(messageCue(at(1, 0)), messageCue(at(2, 1 * MIN)))).toBe(true)
  })
})

describe('sends on their way to the server', () => {
  const out = (
    id: number,
    seconds: number,
    status: OutgoingStatus,
    over: Partial<Message> = {}
  ) => ({
    msg: at(id, seconds, over),
    status,
  })

  test('a send joins the delivered group above it, and the sends queued behind it too', () => {
    const places = messagePlaces([at(1, 0)], undefined, [
      out(-1, 1 * MIN, 'sending'),
      out(-2, 2 * MIN, 'queued'),
    ])
    expect(firsts(places)).toEqual([true, false, false])
    expect(lasts(places)).toEqual([false, false, true])
  })

  test('the confirmed message takes the place of its send', () => {
    const sending = messagePlaces([at(1, 0)], undefined, [out(-1, 1 * MIN, 'sending')])
    const confirmed = messagePlaces([at(1, 0), at(2, 1 * MIN + 1)])
    expect(confirmed).toEqual(sending)
  })

  test('a failed send shows its header, and the send queued behind it its own', () => {
    const places = messagePlaces([at(1, 0)], undefined, [
      out(-1, 1 * MIN, 'failed'),
      out(-2, 2 * MIN, 'queued'),
    ])
    expect(firsts(places)).toEqual([true, true, true])
    expect(lasts(places)).toEqual([true, true, true])
  })

  test('a send after someone else or a long gap, or a reply, starts a header', () => {
    expect(
      firsts(messagePlaces([at(1, 0, { author: bob })], undefined, [out(-1, 1 * MIN, 'sending')]))
    ).toEqual([true, true])
    expect(firsts(messagePlaces([at(1, 0)], undefined, [out(-1, 20 * MIN, 'sending')]))).toEqual([
      true,
      true,
    ])
    expect(
      firsts(
        messagePlaces([at(1, 0)], undefined, [out(-1, 1 * MIN, 'sending', { reply_to: quote })])
      )
    ).toEqual([true, true])
  })

  test('a separator above the first send starts a header', () => {
    const places = messagePlaces([at(1, 0)], new Set([1]), [out(-1, 1 * MIN, 'sending')])
    expect(firsts(places)).toEqual([true, true])
  })

  test('the first send of an empty list shows its header', () => {
    const places = messagePlaces([], undefined, [out(-1, 0, 'sending'), out(-2, 1 * MIN, 'queued')])
    expect(firsts(places)).toEqual([true, false])
  })
})

const ME = 'ik-me'
const PEER = 'ik-peer'
const p2p = (id: string, seconds: number, over: Partial<P2pMessage> = {}): P2pMessage => ({
  id,
  sender: ME,
  ts: (NOON + seconds) * 1000,
  sentTs: (NOON + seconds) * 1000,
  sortKey: id,
  seq: 1,
  body: 'hello',
  reply: null,
  mentions: [],
  fwd: null,
  att: [],
  edited: null,
  reactions: [],
  pinned: null,
  late: false,
  pending: false,
  failed: false,
  call: null,
  ...over,
})

const p2pPlaces = (list: P2pMessage[], breaks?: Set<number>) =>
  groupPlaces(list.map(p2pCue), breaks)

describe('P2P messages', () => {
  test('one sender within seven minutes shows one header', () => {
    const places = p2pPlaces([
      p2p('a', 0),
      p2p('b', 1 * MIN),
      p2p('c', 8 * MIN),
      p2p('d', 16 * MIN),
    ])
    expect(firsts(places)).toEqual([true, false, false, true])
  })

  test('another sender starts a new header', () => {
    expect(firsts(p2pPlaces([p2p('a', 0), p2p('b', 1 * MIN, { sender: PEER })]))).toEqual([
      true,
      true,
    ])
  })

  test('pending sends join the delivered group above them', () => {
    const places = p2pPlaces([
      p2p('a', 0),
      p2p('b', 1 * MIN, { pending: true }),
      p2p('c', 2 * MIN, { pending: true }),
      p2p('d', 3 * MIN),
    ])
    expect(firsts(places)).toEqual([true, false, false, false])
    expect(lasts(places)).toEqual([false, false, false, true])
  })

  test('a delivered send sits where it sat while pending', () => {
    const sent = [p2p('a', 0), p2p('b', 1 * MIN), p2p('c', 2 * MIN)]
    const pending = sent.map((p, i) => (i ? { ...p, pending: true } : p))
    expect(p2pPlaces(pending)).toEqual(p2pPlaces(sent))
  })

  test('a failed send shows its header, and so does the next message', () => {
    const places = p2pPlaces([
      p2p('a', 0),
      p2p('b', 1 * MIN, { pending: true, failed: true }),
      p2p('c', 2 * MIN, { pending: true }),
    ])
    expect(firsts(places)).toEqual([true, true, true])
    expect(lasts(places)).toEqual([true, true, true])
  })

  test('a pending send after another sender starts its own header', () => {
    const places = p2pPlaces([p2p('a', 0, { sender: PEER }), p2p('b', 1 * MIN, { pending: true })])
    expect(firsts(places)).toEqual([true, true])
  })

  test('a reply or a forward starts a header; the next plain message joins it', () => {
    const reply = { id: 'x', sender: PEER, body: 'hi' }
    const fwd = { name: 'Bob', ts: 1, body: 'old', att: [] } as unknown as P2pMessage['fwd']
    for (const over of [{ reply }, { fwd }]) {
      const places = p2pPlaces([p2p('a', 0), p2p('b', 1 * MIN, over), p2p('c', 2 * MIN)])
      expect(firsts(places)).toEqual([true, true, false])
    }
  })

  test('a message that arrived late shows its header, so its note shows', () => {
    const places = p2pPlaces([p2p('a', 0), p2p('b', 1 * MIN, { late: true })])
    expect(firsts(places)).toEqual([true, true])
  })

  test('system, call, hidden and slow-mode rows stand alone', () => {
    const lines: Partial<P2pMessage>[] = [
      { system: { kind: 'join', ik: ME } },
      { system: { kind: 'pin', ik: ME, target: 'a' } },
      { call: { kind: 'voice' } as unknown as P2pMessage['call'] },
      { removed: true },
      { slowHidden: true },
    ]
    for (const over of lines) {
      const places = p2pPlaces([p2p('a', 0), p2p('b', 1 * MIN, over), p2p('c', 2 * MIN)])
      expect(firsts(places)).toEqual([true, true, true])
    }
  })

  test('the new messages line starts a new header', () => {
    const places = p2pPlaces([p2p('a', 0), p2p('b', 1 * MIN)], new Set([1]))
    expect(firsts(places)).toEqual([true, true])
  })

  test('an edit or a reaction changes no header', () => {
    const plain = p2pPlaces([p2p('a', 0), p2p('b', 1 * MIN)])
    const touched = p2pPlaces([
      p2p('a', 0, { edited: (NOON + 600) * 1000 }),
      p2p('b', 1 * MIN, { reactions: [{ key: '👍', count: 1, me: true, first: 0, by: [] }] }),
    ])
    expect(touched).toEqual(plain)
  })
})
