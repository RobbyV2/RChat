import { afterEach, describe, expect, test } from 'bun:test'
import { client } from '../client/client'
import type { P2pState } from '../p2p/app/store'
import type { ServerView } from '../p2p/server/types'
import { applyVoiceState, withoutVoiceRooms } from '../slices/rtc'
import { applyServerChange } from '../slices/servers'
import { getHomeSession, resetSessionCaches, useStore } from '../store'
import type { RChatState } from '../store_types'
import type { Channel } from '../types'
import { channelTarget } from '../viewing'
import {
  hostedVoiceCounter,
  hostedVoiceCounts,
  memoLast,
  p2pVoiceCounter,
  p2pVoiceCounts,
  voiceBadgeTitle,
  voiceLabel,
  voiceListsWanted,
  voiceSum,
} from '../voice_rail'
import { me, memoryStorage, serverDetail, textChannel } from './fixtures'
import { shownPeer } from './shown_peer'
import { answerPrompt } from './helpers/viewing'

afterEach(() => {
  resetSessionCaches()
  memoryStorage.clear()
})

const st = () => useStore.getState()
const voiceRoom = (id: number, over: Partial<Channel> = {}): Channel => ({
  id,
  name: `v${id}`,
  kind: 'voice',
  slowmode_seconds: 0,
  ...over,
})
const viewing = getHomeSession().viewing
const hosted = (over: Partial<RChatState> = {}) => ({
  servers: {
    club: serverDetail('club', { channels: [textChannel(1), voiceRoom(2), voiceRoom(3)] }),
    arena: serverDetail('arena', { channels: [voiceRoom(5)] }),
  },
  voiceUsers: { 2: ['a', 'b'], 3: ['c'], 5: ['d'] },
  voiceServers: { 2: 'club', 3: 'club', 5: 'arena' },
  voiceAudio: {},
  channelLabelEpoch: 0,
  channelLabelEpochs: {},
  ...over,
})

const room = (id: string, channels: { id: string; kind: string; sensitive?: true }[]) =>
  ({
    id,
    name: id,
    channels: channels.map(c => ({ name: c.id, pos: 0, ...c })),
    voice: Object.fromEntries(
      channels.map(c => [c.id, [{ ik: 'x', video: false, muted: false, deafened: false }]])
    ),
  }) as unknown as ServerView

describe('the hosted voice count', () => {
  test('counts the people in the listed voice channels of each server', () => {
    expect(hostedVoiceCounts(hosted(), 'alice', viewing)).toEqual({ club: 3, arena: 1 })
  })

  test('leaves out a room closed by a viewing choice until it is opened here', async () => {
    const s = hosted({
      servers: { club: serverDetail('club', { channels: [voiceRoom(2, { sensitive: true })] }) },
    })
    expect(hostedVoiceCounts(s, 'alice', viewing)).toEqual({})
    const target = channelTarget('alice', 'instance', 'club', voiceRoom(2), viewing.connection)
    const opening = viewing.requestViewing({ ...target, sensitive: true })
    answerPrompt(viewing, true, false)
    try {
      expect(!!(await opening)).toBe(true)
      expect(hostedVoiceCounts(s, 'alice', viewing)).toEqual({ club: 2 })
    } finally {
      viewing.leaveVisit()
    }
  })

  test('leaves out channels the server does not list and text channels', () => {
    const s = hosted({
      servers: { club: serverDetail('club', { channels: [textChannel(2)] }) },
      voiceUsers: { 2: ['a'], 9: ['b'] },
      voiceServers: { 2: 'club', 9: 'club' },
    })
    expect(hostedVoiceCounts(s, 'alice', viewing)).toEqual({})
  })

  test('counts nothing for a server without a channel list from the current epoch', () => {
    const stale = hosted({ channelLabelEpoch: 2, channelLabelEpochs: { club: 1, arena: 2 } })
    expect(hostedVoiceCounts(stale, 'alice', viewing)).toEqual({ arena: 1 })
    expect(voiceListsWanted(stale)).toEqual(['club'])
    const missing = hosted({ servers: {} })
    expect(hostedVoiceCounts(missing, 'alice', viewing)).toEqual({})
    expect(voiceListsWanted(missing)).toEqual(['arena', 'club'])
    expect(voiceListsWanted(hosted())).toEqual([])
  })

  test('works the counts out once per change of rosters, lists or viewing choices', () => {
    const calls: string[] = []
    const count = hostedVoiceCounter({
      connection: viewing.connection,
      canView: t => {
        calls.push(t.key)
        return viewing.canView({ ...t, sensitive: false })
      },
    })
    const s = { ...hosted(), me: me('alice') }
    const first = count(s, 0)
    expect(count({ ...s }, 0)).toBe(first)
    expect(calls).toHaveLength(3)
    expect(count(s, 1)).toEqual(first)
    expect(calls).toHaveLength(6)
    expect(count({ ...s, voiceUsers: { 2: ['a'] } }, 1)).toEqual({ club: 1 })
  })

  test('a voice state keeps the channel server while people are in it', () => {
    const empty = {
      voiceUsers: {},
      voiceServers: {},
      voiceMuted: {},
      voiceHushed: {},
      voiceAudio: {},
    }
    const ev = (users: string[]) =>
      ({ type: 'voice_state', server: 'club', channel_id: 4, users }) as const
    const on = applyVoiceState(empty as unknown as RChatState, ev(['a']))
    expect([on.voiceUsers, on.voiceServers]).toEqual([{ 4: ['a'] }, { 4: 'club' }])
    const off = applyVoiceState({ ...empty, ...on } as unknown as RChatState, ev([]))
    expect([off.voiceUsers, off.voiceServers]).toEqual([{}, {}])
  })

  test('a renamed server keeps its badge', () => {
    const s = { ...st(), ...hosted({ channelLabelEpoch: 1, channelLabelEpochs: { club: 1 } }) }
    const server = { name: 'lounge', display_name: 'Lounge', creator: null, has_password: false }
    const out = {
      ...s,
      ...applyServerChange(s, { type: 'server_renamed', old_name: 'club', server }),
    }
    expect(out.voiceServers).toEqual({ 2: 'lounge', 3: 'lounge', 5: 'arena' })
    expect(hostedVoiceCounts(out, 'alice', viewing)).toEqual({ lounge: 3 })
    const same = applyServerChange(s, {
      type: 'server_updated',
      server: { ...server, name: 'club' },
    })
    expect(same.voiceServers).toBe(s.voiceServers)
  })

  test('rooms that go take their roster, server and marks along', () => {
    const s = {
      ...hosted(),
      voiceMuted: { 2: ['a'] },
      voiceHushed: { 5: ['d'] },
      voiceAudio: { 2: { b: { muted: true, deafened: false } } },
    }
    const out = withoutVoiceRooms(s, id => id === 2)
    expect(out).toEqual({
      voiceUsers: { 3: ['c'], 5: ['d'] },
      voiceServers: { 3: 'club', 5: 'arena' },
      voiceMuted: {},
      voiceAudio: {},
    })
    expect(withoutVoiceRooms(s, () => false)).toEqual({})
  })
})

describe('the hosted voice badge in the store', () => {
  const seed = () =>
    useStore.setState({
      me: me('alice'),
      ...hosted(),
      voiceMuted: { 2: ['a'] },
    })
  const counts = () => hostedVoiceCounts(st(), 'alice', viewing)

  test('leaving a server clears its rosters, so a rejoin starts from none', () => {
    seed()
    st().applyWsEvent({ type: 'member_left', server: 'club', username: 'alice' })
    expect(st().voiceUsers).toEqual({ 5: ['d'] })
    expect(st().voiceServers).toEqual({ 5: 'arena' })
    expect(st().voiceMuted).toEqual({})
    useStore.setState({ servers: { ...st().servers, club: hosted().servers.club } })
    expect(counts()).toEqual({ arena: 1 })
  })

  test('a deleted channel leaves the roster and its server', () => {
    seed()
    st().applyWsEvent({ type: 'channel_deleted', server: 'club', channel_id: 2 })
    expect(st().voiceServers).toEqual({ 3: 'club', 5: 'arena' })
    expect(counts()).toEqual({ club: 1, arena: 1 })
  })

  test('turning the socket off clears every roster', () => {
    seed()
    const store = client.shown().store
    store.setSocket(false)
    try {
      expect([st().voiceUsers, st().voiceServers, st().voiceMuted]).toEqual([{}, {}, {}])
      expect(counts()).toEqual({})
    } finally {
      store.setSocket(true)
    }
  })

  test('a room closed here drops out of the rosters and their servers', () => {
    seed()
    useStore.setState({
      servers: {
        ...st().servers,
        club: serverDetail('club', { channels: [voiceRoom(2, { sensitive: true }), voiceRoom(3)] }),
      },
    })
    expect(st().voiceServers).toEqual({ 3: 'club', 5: 'arena' })
    expect(counts()).toEqual({ club: 1, arena: 1 })
  })
})

describe('the P2P voice count', () => {
  const peer = () => shownPeer()
  const rooms = () => ({
    R1: room('R1', [
      { id: 'a', kind: 'voice' },
      { id: 'b', kind: 'voice', sensitive: true },
      { id: 't', kind: 'text' },
    ]),
    R2: room('R2', [{ id: 'c', kind: 'voice' }]),
  })
  const state = (servers: Record<string, ServerView>) =>
    ({ ...peer().useP2p.getState(), account: 'alice', servers }) as P2pState
  const visible = (s: P2pState) => (r: string, ch: string) => peer().peerVisible(s, r, ch)

  test('counts the listed voice channels open here, and none a marked room holds', () => {
    const s = state(rooms())
    expect(p2pVoiceCounts(s.servers, visible(s))).toEqual({ R1: 1, R2: 1 })
  })

  test('leaves out the people of a channel the room does not list for us', () => {
    const r = rooms().R2
    const s = state({
      R2: {
        ...r,
        voice: { ...r.voice, hidden: [{ ik: 'y', video: false, muted: false, deafened: false }] },
      },
    })
    expect(p2pVoiceCounts(s.servers, visible(s))).toEqual({ R2: 1 })
    expect(p2pVoiceCounts({ R2: { ...r, channels: [] } }, visible(s))).toEqual({})
  })

  test('works the counts out once per change of rooms or viewing choices', () => {
    let calls = 0
    const count = p2pVoiceCounter<P2pState>(() => {
      calls += 1
      return true
    })
    const s = state(rooms())
    const first = count(s, 0)
    expect(first).toEqual({ R1: 2, R2: 1 })
    expect(count({ ...s }, 0)).toBe(first)
    expect(calls).toBe(3)
    count(s, 1)
    expect(calls).toBe(6)
  })
})

describe('the badge text', () => {
  test('says how many, or only that voice is on in streamer mode', () => {
    expect(voiceBadgeTitle(3, false)).toBe('3 in voice')
    expect(voiceBadgeTitle(3, true)).toBe('Voice active')
  })

  test('adds voice to a tile label only while someone is in voice', () => {
    expect(voiceLabel(2)).toBe(', voice active')
    expect(voiceLabel(0)).toBe('')
  })

  test('sums the servers of a folder', () => {
    expect(voiceSum({ a: 2, b: 1 }, ['a', 'b', 'c'])).toBe(3)
    expect(voiceSum({ a: 2 }, [])).toBe(0)
  })

  test('a kept value is the same until an input changes', () => {
    const memo = memoLast<object>()
    const a = memo([1, 'x'], () => ({}))
    expect(memo([1, 'x'], () => ({}))).toBe(a)
    expect(memo([2, 'x'], () => ({}))).not.toBe(a)
  })
})
