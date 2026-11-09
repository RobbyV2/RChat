import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_CHANNEL,
  JOIN_LINES,
  LEAVE_LINE,
  choiceId,
  isSystem,
  systemChoices,
  systemParts,
  systemText,
} from '../system_messages'
import { canQuote } from '../replies'
import { canForward } from '../forward'
import { canPin } from '../pins'
import { newSince } from '../lists'
import type { Channel } from '../types'
import { msg, user } from './fixtures'

const channel = (id: number, name: string, kind: Channel['kind'] = 'text'): Channel => ({
  id,
  name,
  kind,
  slowmode_seconds: 0,
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
      { value: '2', label: '#general' },
      { value: '3', label: '#random' },
    ])
    expect(systemChoices(channels, 9).at(-1)).toEqual({ value: '9', label: 'Hidden channel' })
    expect(systemChoices(channels, 3)).toHaveLength(3)
    expect(choiceId('')).toBeNull()
    expect(choiceId('3')).toBe(3)
  })
})
