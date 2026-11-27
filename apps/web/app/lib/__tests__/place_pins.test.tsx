import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { PinsButton, PinsWindow } from '../../components/pins'
import { AccountProvider } from '../client/react'
import { P2pProvider } from '../client/p2p_react'
import type { P2pMessage } from '../p2p/dm'
import { featureAt, isUnsupported } from '../place/feature'
import { pins } from '../place/pins'
import { PlaceProvider } from '../place/react'
import type { RChatState } from '../store_types'
import type { View } from '../view'
import { msg, user } from './fixtures'
import { placeContract, type ContractWorld } from './helpers/place_contract'

// Ann's side with one message pinned by Bob in the conversation on screen, and what the side is
// asked recorded.
const seat = (world: ContractWorld, calls: unknown[][], open = true) => {
  const { place } = world.ann
  if (place.kind === 'hostedServer' || place.kind === 'hostedDm') {
    const view: View =
      place.kind === 'hostedServer'
        ? { kind: 'channel', server: world.server, channelId: 1 }
        : { kind: 'dm', dmId: world.dmId }
    const key = place.kind === 'hostedServer' ? 'c1' : `d${world.dmId}`
    const state = {
      view,
      pins: open
        ? { key, list: [msg(5, { author: user('bob'), content: 'bring the map' })], failed: false }
        : null,
      openPins: () => void calls.push(['open']),
      closePins: () => void calls.push(['close']),
      jumpTo: async (...a: unknown[]) => void calls.push(['jump', ...a]),
      openPinned: async (...a: unknown[]) => void calls.push(['show', ...a]),
      unpinMessage: async (id: number) => void calls.push(['unpin', id]),
      askConfirm: (c: { action: () => void }) => c.action(),
    } as unknown as Partial<RChatState>
    world.ann.account.store.setState(state)
    Object.assign(world.ann.account.store.getInitialState(), world.ann.account.store.getState())
  } else {
    const pinned = {
      id: 'e5',
      sender: 'B',
      ts: 5_000,
      body: 'bring the map',
      att: [],
      reactions: [],
      edited: null,
      pinned: 6_000,
    } as unknown as P2pMessage
    const state = {
      chat: { room: world.room, ch: place.kind === 'p2pRoom' ? 'c1' : null },
      pins: open ? { room: world.room, list: [pinned] } : null,
    }
    place.app.useP2p.setState(state as never)
    Object.assign(place.app.useP2p.getInitialState(), state, { me: 'A' })
    world.ann.account.store.setState({
      askConfirm: (c: { action: () => void }) => c.action(),
    } as unknown as Partial<RChatState>)
    Object.assign(place.app.p2pDm, {
      openPins: async () => void calls.push(['open']),
      closePins: () => void calls.push(['close']),
      jumpTo: async (id: string) => void calls.push(['jump', id]),
      pin: async (...a: unknown[]) => void calls.push(['pin', ...a]),
    })
  }
  const here = featureAt(pins, place)
  if (isUnsupported(here)) throw new Error(here.line)
  return here
}

placeContract(pins, (kind, world) => {
  const hosted = kind === 'hostedServer' || kind === 'hostedDm'
  const inDm = kind === 'hostedDm' || kind === 'p2pDm'
  const scope = () => (kind === 'hostedServer' ? 'c1' : `d${world().dmId}`)

  test('the open list holds the pinned messages of the conversation on screen', () => {
    const here = seat(world(), [])
    const state = here.state.get()
    expect(here.state.get()).toBe(state)
    expect(state.open).toBe(true)
    expect(state.place).toBe(inDm ? 'conversation' : 'channel')
    expect(state.profiles).toBe(hosted)
    expect(state.list?.map(p => [p.key, p.message.content])).toEqual([
      [hosted ? '5' : 'e5', 'bring the map'],
    ])
  })

  test('a closed list holds nothing', () => {
    const state = seat(world(), [], false).state.get()
    expect([state.open, state.list]).toEqual([false, null])
  })

  test('opening, jumping, showing and unpinning run on the side of the place', () => {
    const calls: unknown[][] = []
    const here = seat(world(), calls)
    const key = hosted ? '5' : 'e5'
    here.open()
    here.jump(key)
    here.show(key)
    here.unpin(key)
    expect(calls).toEqual(
      hosted
        ? [['open'], ['close'], ['jump', scope(), 5], ['show', scope(), 5], ['unpin', 5]]
        : [['open'], ['close'], ['jump', 'e5'], ['jump', 'e5'], ['pin', 'e5', false]]
    )
  })

  test('one button and one list draw either side', () => {
    seat(world(), [])
    const { ann } = world()
    const html = renderToStaticMarkup(
      <AccountProvider session={ann.account}>
        <P2pProvider identity={ann.app}>
          <PlaceProvider place={ann.place}>
            <PinsButton />
            <PinsWindow canUnpin />
          </PlaceProvider>
        </P2pProvider>
      </AccountProvider>
    )
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('bring the map')
    expect(html).toContain(`Pinned messages in this ${inDm ? 'conversation' : 'channel'}`)
    expect(html).toContain('aria-label="Unpin Message"')
  })
})
