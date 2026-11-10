import { describe, expect, test } from 'bun:test'
import {
  CARD_CONTACTS,
  cardRows,
  homeCard,
  onlineText,
  p2pEntry,
  statusText,
  type CardInput,
} from '../p2p/home_card'
import type { Contact } from '../p2p/contacts'
import { SQUATTED } from '../p2p/node'

const contact = (ik: string, over: Partial<Contact> = {}): Contact =>
  ({
    ik,
    name: ik,
    petname: null,
    profile: null,
    certs: [],
    revocations: [],
    state: 'mutual',
    ignored: false,
    intros: [],
    verified: false,
    verifiedAt: null,
    added: 1,
    ...over,
  }) as Contact

const input = (over: Partial<CardInput> = {}): CardInput => ({
  enabled: true,
  loading: false,
  status: 'online',
  paused: false,
  elsewhere: false,
  contacts: [],
  presence: {},
  serverInvites: 0,
  coOwnerAsks: 0,
  transferAsks: 0,
  ...over,
})

describe('the Peer-to-peer card on Home', () => {
  test('P2P that was never turned on shows Off and nothing else', () => {
    const card = homeCard(
      input({
        enabled: false,
        status: 'off',
        contacts: [contact('a'), contact('b', { state: 'incoming' })],
        presence: { a: 'online' },
        serverInvites: 2,
        coOwnerAsks: 1,
        transferAsks: 1,
      })
    )
    expect(card).toEqual({
      state: 'off',
      status: 'Off',
      online: 0,
      top: [],
      requests: 0,
      invites: 0,
      asks: 0,
    })
    expect(cardRows(card)).toEqual([])
  })

  test('the status line follows the P2P node', () => {
    const line = (over: Partial<CardInput>) => {
      const { state, status } = homeCard(input(over))
      return [state, status]
    }
    expect(line({ loading: true, status: 'starting' })).toEqual(['starting', 'Starting…'])
    expect(line({ status: 'online' })).toEqual(['online', 'Online'])
    expect(line({ status: 'starting' })).toEqual(['connecting', 'Connecting…'])
    expect(line({ status: 'connecting' })).toEqual(['connecting', 'Connecting…'])
    expect(line({ status: 'paused' })).toEqual(['paused', 'Paused'])
    expect(line({ status: 'connecting', paused: true })).toEqual(['paused', 'Paused'])
    expect(line({ status: 'squatted' })).toEqual(['blocked', SQUATTED])
    expect(line({ status: 'moved' })).toEqual(['moved', 'Moved to another device'])
    expect(line({ elsewhere: true })).toEqual(['elsewhere', 'Open in another tab'])
    expect(line({ elsewhere: true, loading: true })).toEqual(['elsewhere', 'Open in another tab'])
    expect(statusText('online', true)).toBe('Online')
    expect(statusText('squatted', true)).toBe('Paused')
  })

  test('online contacts are counted and the first few are shown by name', () => {
    const names = ['dana', 'Eve', 'bob', 'zed', 'amy', 'cat', 'fay', 'gus']
    const contacts = [
      ...names.map(n => contact(n)),
      contact('off'),
      contact('dialing'),
      contact('asked', { state: 'incoming' }),
      contact('sent', { state: 'outgoing' }),
      contact('gone', { state: 'blocked' }),
      contact('hidden', { ignored: true }),
      contact('pet', { petname: 'Aaron' }),
    ]
    const presence = Object.fromEntries([
      ...[...names, 'asked', 'sent', 'gone', 'hidden', 'pet'].map(n => [n, 'online'] as const),
      ['dialing', 'dialing'] as const,
    ])
    const card = homeCard(input({ contacts, presence }))
    expect(card.online).toBe(9)
    expect(card.top.map(c => c.ik)).toEqual(['pet', 'amy', 'bob', 'cat', 'dana', 'Eve'])
    expect(card.top).toHaveLength(CARD_CONTACTS)
    expect(homeCard(input({ contacts })).online).toBe(0)
    expect([0, 1, 2].map(onlineText)).toEqual([
      'No contacts online',
      '1 contact online',
      '2 contacts online',
    ])
  })

  test('requests, invites and asks are counted and listed only when there are some', () => {
    const contacts = [
      contact('r1', { state: 'incoming' }),
      contact('r2', { state: 'incoming' }),
      contact('r3', { state: 'incoming', ignored: true }),
      contact('m'),
    ]
    const card = homeCard(
      input({ contacts, serverInvites: 1, coOwnerAsks: 2, transferAsks: 1, status: 'connecting' })
    )
    expect([card.requests, card.invites, card.asks]).toEqual([2, 1, 3])
    expect(cardRows(card)).toEqual([
      { id: 'requests', count: 2, text: '2 message requests' },
      { id: 'invites', count: 1, text: '1 server invite' },
      { id: 'asks', count: 3, text: '3 co-owner or transfer requests' },
    ])
    const one = homeCard(input({ contacts: [contact('r', { state: 'incoming' })], coOwnerAsks: 1 }))
    expect(cardRows(one)).toEqual([
      { id: 'requests', count: 1, text: '1 message request' },
      { id: 'asks', count: 1, text: '1 co-owner or transfer request' },
    ])
    expect(cardRows(homeCard(input()))).toEqual([])
  })

  test('a P2P action turns P2P on first, or opens P2P while it cannot act', () => {
    expect(p2pEntry('off')).toBe('enable')
    expect(p2pEntry('elsewhere')).toBe('home')
    expect(p2pEntry('starting')).toBe('home')
    for (const state of ['online', 'connecting', 'paused', 'blocked', 'moved'] as const)
      expect(p2pEntry(state)).toBe('dialog')
  })
})
