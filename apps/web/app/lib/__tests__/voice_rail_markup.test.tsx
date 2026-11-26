import { shownPeer } from './shown_peer'
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { P2pFolderEntry } from '../../components/p2p/p2p_server_view'
import { RailVoiceBadge } from '../../components/rail_voice_badge'
import { FolderEntry } from '../../components/server_rail'
import { type Folder } from '../nav_layout'
import type { ServerView } from '../p2p/server/types'
import { resetSessionCaches, useStore } from '../store'
import type { Channel } from '../types'
import { me, serverDetail } from './fixtures'

// Server rendering reads the stores' initial state, so the test state goes there.
const initial = useStore.getInitialState()
const saved = { ...initial }
const setState = (patch: Partial<typeof initial>) => {
  useStore.setState(patch)
  Object.assign(initial, useStore.getState())
}
const p2pInitial = () => shownPeer().useP2p.getInitialState()
const p2pSaved = { ...p2pInitial() }
const setP2p = (patch: Partial<ReturnType<typeof p2pInitial>>) => {
  shownPeer().useP2p.setState(patch)
  Object.assign(p2pInitial(), shownPeer().useP2p.getState())
}

afterEach(() => {
  setState({
    anim: saved.anim,
    streamer: false,
    servers: {},
    voiceUsers: {},
    voiceServers: {},
    channelLabelEpoch: 0,
    channelLabelEpochs: {},
  })
  setP2p({ servers: {} })
})

afterAll(() => {
  Object.assign(initial, saved)
  Object.assign(p2pInitial(), p2pSaved)
  resetSessionCaches()
})

const F = (over: Partial<Folder> = {}): Folder => ({
  id: 'f1',
  name: 'Games',
  servers: ['a', 'b'],
  open: false,
  ...over,
})
const voiceRoom = (id: number, sensitive = false): Channel => ({
  id,
  name: `v${id}`,
  kind: 'voice',
  slowmode_seconds: 0,
  sensitive,
})
const servers = ['a', 'b'].map(name => ({ name, display_name: name, creator: null }))
const hosted = (sensitive = false) =>
  setState({
    me: me('alice'),
    servers: {
      a: serverDetail('a', { channels: [voiceRoom(1, sensitive)] }),
      b: serverDetail('b', { channels: [voiceRoom(2)] }),
    },
    voiceUsers: { 1: ['x', 'y'], 2: ['z'] },
    voiceServers: { 1: 'a', 2: 'b' },
  })
const room = (id: string, people: number, sensitive?: true) =>
  ({
    id,
    name: `room-${id.slice(0, 2)}`,
    owners: [],
    channels: [{ id: 'vc', name: 'vc', kind: 'voice', pos: 0, sensitive }],
    chans: {},
    voice: {
      vc: Array.from({ length: people }, (_, i) => ({
        ik: `k${i}`,
        video: false,
        muted: false,
        deafened: false,
      })),
    },
  }) as unknown as ServerView
const rooms = [room('A'.repeat(43), 2), room('B'.repeat(43), 1)]
const peers = (list: ServerView[]) =>
  setP2p({ servers: Object.fromEntries(list.map(v => [v.id, v])) })
const tag = (html: string, attr: string) =>
  html.match(new RegExp(`<[a-z]+[^>]*${attr}[^>]*>`))?.[0] ?? ''
const badges = (html: string) => [...html.matchAll(/data-voice-badge="(\d+)"/g)].map(m => m[1])

describe('the rail voice badge', () => {
  test('shows only while someone is in voice, with the count in its title', () => {
    expect(renderToStaticMarkup(<RailVoiceBadge count={0} />)).toBe('')
    const html = renderToStaticMarkup(<RailVoiceBadge count={3} />)
    expect(html).toContain('data-voice-badge="3"')
    expect(html).toContain('title="3 in voice"')
    expect(html).toContain('<span class="sr-only">, voice active</span>')
  })

  test('says only that voice is on in streamer mode', () => {
    setState({ streamer: true })
    const html = renderToStaticMarkup(<RailVoiceBadge count={3} />)
    expect(html).toContain('title="Voice active"')
    expect(html).not.toContain('3 in voice')
  })

  test('pops in only when animations play', () => {
    expect(renderToStaticMarkup(<RailVoiceBadge count={1} />)).not.toContain('animate-badge-pop')
    setState({ anim: { on: true, motion: 'always' } })
    expect(renderToStaticMarkup(<RailVoiceBadge count={1} />)).toContain('animate-badge-pop')
    setState({ anim: { on: true, motion: 'still' } })
    expect(renderToStaticMarkup(<RailVoiceBadge count={1} />)).not.toContain('animate-badge-pop')
  })
})

describe('hosted tiles', () => {
  test('each server tile shows its own count and says voice is active', () => {
    hosted()
    const html = renderToStaticMarkup(
      <FolderEntry folder={F({ open: true })} servers={servers} at={0} />
    )
    expect(badges(html)).toEqual(['2', '1'])
    expect(html).toContain('title="a, voice active"')
    expect(html).toContain('title="b, voice active"')
  })

  test('a collapsed folder sums its servers', () => {
    hosted()
    const html = renderToStaticMarkup(<FolderEntry folder={F()} servers={servers} at={0} />)
    expect(badges(html)).toEqual(['3'])
    expect(tag(html, 'aria-expanded')).toContain(', voice active"')
  })

  test('a room closed by a viewing choice is not counted', () => {
    hosted(true)
    const html = renderToStaticMarkup(
      <FolderEntry folder={F({ open: true })} servers={servers} at={0} />
    )
    expect(badges(html)).toEqual(['1'])
    expect(html).toContain('title="a"')
  })

  test('a server without a current channel list shows no badge', () => {
    hosted()
    setState({ channelLabelEpoch: 1, channelLabelEpochs: { b: 1 } })
    const html = renderToStaticMarkup(
      <FolderEntry folder={F({ open: true })} servers={servers} at={0} />
    )
    expect(badges(html)).toEqual(['1'])
  })
})

describe('P2P tiles', () => {
  test('each room tile shows its count and its label says voice is active', () => {
    setState({ me: me('alice') })
    peers(rooms)
    const html = renderToStaticMarkup(
      <P2pFolderEntry folder={F({ open: true })} list={rooms} at={0} />
    )
    expect(badges(html)).toEqual(['2', '1'])
    expect(html).toContain('aria-label="room-AA, peer-to-peer, voice active"')
  })

  test('a collapsed P2P folder sums its rooms', () => {
    setState({ me: me('alice') })
    peers(rooms)
    const html = renderToStaticMarkup(<P2pFolderEntry folder={F()} list={rooms} at={0} />)
    expect(badges(html)).toEqual(['3'])
    expect(tag(html, 'aria-expanded')).toContain(', voice active"')
  })

  test('a marked room is not counted', () => {
    setState({ me: me('alice') })
    const marked = [room('A'.repeat(43), 2, true), rooms[1]]
    peers(marked)
    const html = renderToStaticMarkup(
      <P2pFolderEntry folder={F({ open: true })} list={marked} at={0} />
    )
    expect(badges(html)).toEqual(['1'])
    expect(html).toContain('aria-label="room-AA, peer-to-peer"')
  })
})
