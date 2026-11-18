import { afterAll, describe, expect, test } from 'bun:test'
import { EMPTY_NOTIFY, type NotifyPrefs } from '../notify'
import type { Contact } from '../p2p/contacts'
import { p2pTileCount } from '../p2p/alerts'
import type { RoomSummary } from '../p2p/app/store'
import type { PingCount } from '../pings'
import { dmTile } from '../selectors'
import { resetSessionCaches, useStore } from '../store'
import type { RChatState } from '../store_types'

afterAll(resetSessionCaches)

const ping = (scope: string, n: number, server: string | null = null): PingCount => ({
  scope,
  server,
  bulk: n,
  bulkUntil: 100,
  ids: [],
})

const contact = (ik: string, state: Contact['state'] = 'mutual') =>
  ({ ik, state, name: ik, added: 1 }) as Contact

const room = (id: string, peer: string, pings: number, unread = 0) =>
  ({ id, peer, pings, unread }) as RoomSummary

const state = (over: Partial<RChatState> = {}): RChatState => ({
  ...useStore.getState(),
  pings: {},
  groupPings: {},
  reads: {},
  notifyPrefs: EMPTY_NOTIFY,
  ...over,
})

const quiet = (room: string): NotifyPrefs => ({
  ...EMPTY_NOTIFY,
  p2p: { [room]: { level: 'nothing' } },
})

describe('the DM tile count', () => {
  const pings = {
    d5: ping('d5', 2),
    friends: ping('friends', 1),
    c3: ping('c3', 4, 'lounge'),
  }

  test('instance DM and friend pings, without server pings', () => {
    expect(dmTile(state({ pings }), { rooms: {}, contacts: [] }).pings).toBe(3)
  })

  test('adds the pings of P2P conversations with listed contacts', () => {
    const p2p = {
      rooms: { r1: room('r1', 'ann', 2), r2: room('r2', 'bea', 5) },
      contacts: [contact('ann'), contact('bea', 'blocked')],
    }
    expect(dmTile(state({ pings }), p2p).pings).toBe(5)
  })

  test('a P2P conversation set to Nothing does not count', () => {
    const p2p = { rooms: { r1: room('r1', 'ann', 2) }, contacts: [contact('ann')] }
    expect(dmTile(state({ pings, notifyPrefs: quiet('r1') }), p2p).pings).toBe(3)
  })
})

describe('the DM tile dot', () => {
  const none = { rooms: {}, contacts: [] }

  test('off with nothing unread anywhere', () => {
    expect(dmTile(state(), none).unread).toBe(false)
  })

  test('on for an unread instance DM', () => {
    expect(dmTile(state({ reads: { d5: { lastRead: 1, latest: 3 } } }), none).unread).toBe(true)
  })

  test('on for an unread P2P conversation with a listed contact only', () => {
    const listed = { rooms: { r1: room('r1', 'ann', 0, 2) }, contacts: [contact('ann')] }
    const unlisted = {
      rooms: { r1: room('r1', 'ann', 0, 2) },
      contacts: [contact('ann', 'outgoing')],
    }
    expect(dmTile(state(), listed).unread).toBe(true)
    expect(dmTile(state(), unlisted).unread).toBe(false)
  })
})

describe('the DM tile counts', () => {
  const p2p = {
    rooms: { r1: room('r1', 'ann', 2, 1) },
    contacts: [contact('ann')],
  }
  const pings = { d5: ping('d5', 2) }

  test('are computed once while what they count stays the same', () => {
    const s = state({ pings })
    const tile = dmTile(s, p2p)
    expect(tile).toEqual({ pings: 4, unread: true })
    expect(dmTile({ ...s, rtcTick: s.rtcTick + 1 }, p2p)).toBe(tile)
    expect(dmTile({ ...s, toast: { id: 1, text: 'Saved' } }, { ...p2p })).toBe(tile)
  })

  test('are computed again when the pings, reads, settings or P2P conversations change', () => {
    const s = state({ pings })
    const tile = dmTile(s, p2p)
    expect(dmTile(s, { ...p2p, rooms: { ...p2p.rooms } })).not.toBe(tile)
    expect(dmTile(s, { ...p2p, contacts: [...p2p.contacts] })).not.toBe(tile)
    expect(dmTile({ ...s, pings: { ...pings } }, p2p)).not.toBe(tile)
    expect(dmTile({ ...s, reads: {} }, p2p)).not.toBe(tile)
    expect(dmTile({ ...s, notifyPrefs: quiet('r1') }, p2p)).toEqual({ pings: 2, unread: true })
  })
})

describe('the P2P tile count', () => {
  const base = { contacts: [], serverInvites: [], coOwnerAsks: [], transferAsks: [] }

  test('zero with nothing waiting', () => {
    expect(p2pTileCount(base)).toBe(0)
  })

  test('message requests, server invites and asks, and no conversation pings', () => {
    expect(
      p2pTileCount({
        contacts: [contact('ann', 'incoming'), contact('bea'), contact('cy', 'incoming')],
        serverInvites: [{ room: 'r', name: 'Den', from: 'bea', at: 1 }],
        coOwnerAsks: [{ key: 'k', from: 'bea', name: 'Den' }],
        transferAsks: [
          { key: 't', kind: 'take', from: 'bea', room: 'r', to: 'me', name: 'Den' },
          { key: 'u', kind: 'cosign', from: 'bea', room: 's', to: 'me', name: 'Nook' },
        ],
      })
    ).toBe(6)
  })
})
