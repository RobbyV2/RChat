import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { VoiceRow } from '../../components/voice_row'
import { AccountProvider } from '../client/react'
import { P2pProvider } from '../client/p2p_react'
import type { ServerView } from '../p2p/server'
import type { ChannelEntry } from '../place/channels'
import { featureAt, isUnsupported } from '../place/feature'
import { PlaceProvider } from '../place/react'
import { voice } from '../place/voice'
import type { RChatState } from '../store_types'
import type { Channel } from '../types'
import { serverDetail, textChannel } from './fixtures'
import { placeContract, type ContractWorld } from './helpers/place_contract'

// Ann's side of a server or room with Bob, muted, in its voice channel, and what the side is
// asked recorded.
const seat = (world: ContractWorld, calls: unknown[][]) => {
  const { place } = world.ann
  if (place.kind === 'hostedServer') {
    const state = {
      servers: {
        [world.server]: serverDetail(world.server, {
          channels: [{ ...textChannel(3), name: 'deck', kind: 'voice' }] as unknown as Channel[],
        }),
      },
      voiceUsers: { 3: ['bob'] },
      voiceAudio: { 3: { bob: { muted: true, deafened: false } } },
      joinVoice: async (...a: unknown[]) => void calls.push(['join', ...a]),
    } as unknown as Partial<RChatState>
    world.ann.account.store.setState(state)
    Object.assign(world.ann.account.store.getInitialState(), world.ann.account.store.getState())
  } else if (place.kind === 'p2pRoom') {
    const view = {
      id: world.room,
      name: 'Harbor',
      me: 'join',
      perms: -1,
      owners: [],
      members: [{ ik: 'B', name: 'Bob' }],
      memberList: { hide: false, roles: null, channels: [] },
      channels: [{ id: 'c3', name: 'deck', kind: 'voice' }],
      voice: { c3: [{ ik: 'B', video: false, muted: true, deafened: false }] },
    } as unknown as ServerView
    const state = { servers: { [world.room]: view } }
    place.app.useP2p.setState(state as never)
    Object.assign(place.app.useP2p.getInitialState(), state, { me: 'A' })
    Object.assign(place.app.p2pVoice, {
      join: async (...a: unknown[]) => void calls.push(['join', ...a]),
    })
  }
  return featureAt(voice, place)
}

placeContract(voice, (kind, world) => {
  const hosted = kind === 'hostedServer'
  if (kind === 'hostedDm' || kind === 'p2pDm') {
    test('a DM has no voice channels', () => {
      const here = seat(world(), [])
      expect(isUnsupported(here) && here.why).toBe('not_in_dms')
    })
    return
  }
  const key = hosted ? '3' : 'c3'
  const open = (calls: unknown[][] = []) => {
    const here = seat(world(), calls)
    if (isUnsupported(here)) throw new Error(here.line)
    return here
  }

  test('a channel lists who is in it, and how they sound', () => {
    const here = open()
    const state = here.channel(key).get()
    expect(here.channel(key).get()).toBe(state)
    expect(state.connected).toBe(false)
    expect(state.seats.map(s => [s.key, s.self, s.face.kind, s.status.mic, s.speaking])).toEqual([
      [hosted ? 'bob' : 'B', false, hosted ? 'account' : 'key', 'self', false],
    ])
    expect(here.channel(hosted ? '4' : 'c4').get().seats).toEqual([])
  })

  test('entering a channel you are not in joins it', () => {
    const calls: unknown[][] = []
    open(calls).enter(key)
    expect(calls).toEqual([hosted ? ['join', world().server, 3] : ['join', world().room, 'c3']])
  })

  test('one row draws either side', () => {
    open()
    const { ann } = world()
    const channel: ChannelEntry = {
      key,
      name: 'deck',
      kind: 'voice',
      private: true,
      active: false,
      connected: false,
    }
    const html = renderToStaticMarkup(
      <AccountProvider session={ann.account}>
        <P2pProvider identity={ann.app}>
          <PlaceProvider place={ann.place}>
            <VoiceRow channel={channel} own={false} menu={() => {}} />
          </PlaceProvider>
        </P2pProvider>
      </AccountProvider>
    )
    expect(html).toContain('Join voice channel deck, 1 connected')
    expect(html).toContain('title="1 in voice"')
    expect(html).toContain('aria-label="Private channel"')
    expect(html.replace(/<[^>]+>/g, ' ')).toContain(hosted ? 'bob' : 'Bob')
  })
})
