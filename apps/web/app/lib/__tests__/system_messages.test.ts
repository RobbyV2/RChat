import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_CHANNEL,
  JOIN_LINES,
  LEAVE_LINE,
  SITE_NAME,
  bySite,
  choiceId,
  isNotice,
  isStorage,
  isSystem,
  sealsFromHere,
  systemChoices,
  systemParts,
  systemText,
} from '../system_messages'
import { canQuote } from '../replies'
import { canForward } from '../forward'
import { canPin } from '../pins'
import { newSince } from '../lists'
import type { Channel } from '../types'
import type { P2pMessage } from '../p2p/dm'
import { UNREADABLE_TEXT } from '../sealing'
import { asMessage } from '../p2p/shown_message'
import { msg, user } from './fixtures'

const channel = (id: number, name: string, kind: Channel['kind'] = 'text'): Channel => ({
  id,
  name,
  kind,
  slowmode_seconds: 0,
  category_id: null,
  my_perms: null,
  topic: null,
})

describe('system messages', () => {
  test('join and leave rows are system rows', () => {
    expect(isSystem(msg(1, { kind: 'join' }))).toBe(true)
    expect(isSystem(msg(1, { kind: 'leave' }))).toBe(true)
    expect(isSystem(msg(1))).toBe(false)
    expect(isSystem(msg(1, { kind: 'pin' }))).toBe(false)
  })

  test('join lines are picked from the message id, the same on every client', () => {
    const bob = user('bob', { display_name: 'BOB' })
    const lines = [6, 7, 8, 9, 10, 11].map(id =>
      systemText(msg(id, { kind: 'join', author: bob, content: '' }))
    )
    expect(lines).toEqual([
      'BOB joined the party.',
      'BOB is here.',
      'Welcome, BOB. Say hi!',
      'BOB just showed up.',
      'Everyone welcome BOB!',
      'BOB hopped into the server.',
    ])
    expect(systemText(msg(12, { kind: 'join', author: bob }))).toBe(lines[0])
    expect(JOIN_LINES).toHaveLength(6)
  })

  test('a display name in a system line keeps its username', () => {
    const renamed = user('bob', { display_name: 'alice' })
    expect(systemText(msg(6, { kind: 'join', author: renamed, content: '' }))).toBe(
      'alice (bob) joined the party.'
    )
  })

  test('leave has one line and never shows a reason', () => {
    for (const id of [1, 2, 3])
      expect(
        systemText(msg(id, { kind: 'leave', author: user('bob', { display_name: 'BOB' }) }))
      ).toBe('BOB left the server.')
    expect(LEAVE_LINE).toBe('{name} left the server.')
  })

  test('names with replacement patterns stay literal', () => {
    const author = user('bob', { display_name: "$& $` $' $1" })
    expect(systemText(msg(1, { kind: 'leave', author }))).toBe("$& $` $' $1 (bob) left the server.")
  })

  test('parts split around the name', () => {
    expect(systemParts(msg(8, { kind: 'join' }))).toEqual(['Welcome, ', '. Say hi!'])
    expect(systemParts(msg(6, { kind: 'join' }))).toEqual(['', ' joined the party.'])
    expect(systemParts(msg(10, { kind: 'join' }))).toEqual(['Everyone welcome ', '!'])
    expect(systemParts(msg(3, { kind: 'leave' }))).toEqual(['', ' left the server.'])
  })

  test('no replies, forwards or pins on system rows', () => {
    for (const kind of ['join', 'leave'] as const) {
      const m = msg(5, { kind, content: '' })
      expect(canQuote(m)).toBe(false)
      expect(canForward(m)).toBe(false)
      expect(canPin(m)).toBe(false)
    }
  })

  test('they count as new messages from others', () => {
    const list = [msg(1), msg(2, { kind: 'join', author: user('bob', { display_name: 'BOB' }) })]
    expect(newSince(list, 1, 'alice')).toBe(1)
  })

  test('channel choices list text channels after the default', () => {
    const channels = [channel(1, 'lounge', 'voice'), channel(2, 'general'), channel(3, 'random')]
    expect(systemChoices(channels, null)).toEqual([
      { value: '', label: DEFAULT_CHANNEL },
      { value: '2', label: '#general', channel: 'general' },
      { value: '3', label: '#random', channel: 'random' },
    ])
    const rooms = [
      { id: 'c1', name: 'general', kind: 'text' },
      { id: 'c2', name: 'lounge', kind: 'voice' },
    ]
    expect(systemChoices(rooms, 'c1').map(c => c.value)).toEqual(['', 'c1'])
    expect(systemChoices(rooms, 'c9').at(-1)).toEqual({ value: 'c9', label: 'Hidden channel' })
    expect(systemChoices(channels, 9).at(-1)).toEqual({ value: '9', label: 'Hidden channel' })
    expect(systemChoices(channels, 3)).toHaveLength(3)
    expect(choiceId('')).toBeNull()
    expect(choiceId('3')).toBe(3)
  })

  test('storage rows say who changed encrypted storage, or that the site did', () => {
    const bob = user('bob', { display_name: 'BOB' })
    const row = (content: string, author = bob) => msg(1, { kind: 'storage', author, content })
    expect(isStorage(row('on')) && isSystem(row('on')) && isNotice(row('on'))).toBe(true)
    expect(isStorage(msg(1))).toBe(false)
    expect(systemText(row('on'))).toBe('BOB turned on encrypted storage for new messages.')
    expect(systemText(row('off'))).toBe(
      'BOB turned off encrypted storage for new messages. Messages stored encrypted stay encrypted.'
    )
    const site = user('')
    expect(bySite(row('forced', site))).toBe(true)
    expect(bySite(row('on'))).toBe(false)
    expect(bySite(msg(1, { kind: 'join', author: site }))).toBe(false)
    expect(systemText(row('forced', site))).toBe(`${SITE_NAME} now requires encrypted storage.`)
    expect(systemText(row('unforced', site))).toBe(
      `${SITE_NAME} no longer requires encrypted storage.`
    )
    expect(systemText(row('on', site))).toBe(
      `${SITE_NAME} turned on encrypted storage for new messages.`
    )
    expect(systemParts(row('on'))).toEqual(['', ' turned on encrypted storage for new messages.'])
    expect(systemText(row('later'))).toBe('BOB changed how messages are stored.')
    expect(canQuote(row('on'))).toBe(false)
  })

  test('a P2P storage line and an unreadable P2P message read like hosted ones', () => {
    const bob = user('bob', { display_name: 'BOB' })
    const row: P2pMessage = {
      id: 'e',
      sender: 'ik',
      ts: 1000,
      sentTs: 1000,
      sortKey: 'k',
      seq: 1,
      body: '',
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
    }
    for (const on of [true, false]) {
      const m = asMessage(
        { ...row, system: { kind: 'storage', ik: 'ik', on } },
        1,
        0,
        () => bob,
        ''
      )
      const hosted = msg(1, { kind: 'storage', author: bob, content: on ? 'on' : 'off' })
      expect(isStorage(m) && isSystem(m) && sealsFromHere(m) === on).toBe(true)
      expect(systemText(m)).toBe(systemText(hosted))
    }
    const lost = asMessage({ ...row, unavailable: true, unreadable: true }, 1, 0, () => bob, '')
    expect([lost.unreadable, lost.content]).toEqual([true, `_${UNREADABLE_TEXT}_`])
  })
})
