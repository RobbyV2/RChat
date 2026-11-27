import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AccountProvider } from '../client/react'
import { P2pProvider } from '../client/p2p_react'
import type { ServerView } from '../p2p/server'
import { featureAt, isUnsupported } from '../place/feature'
import { named } from '../place/named'
import { usePlaceOnScreen } from '../place/react'
import type { RChatState } from '../store_types'
import type { View } from '../view'
import { serverDetail, textChannel } from './fixtures'
import { placeContract, type ContractWorld } from './helpers/place_contract'

// Ann's side with the place on screen: its first channel, or the conversation with Bob.
const seat = (world: ContractWorld) => {
  const { place } = world.ann
  if (place.kind === 'hostedServer' || place.kind === 'hostedDm') {
    const view: View =
      place.kind === 'hostedServer'
        ? { kind: 'channel', server: world.server, channelId: 1 }
        : { kind: 'dm', dmId: world.dmId }
    const state = {
      view,
      home: false,
      servers: { [world.server]: serverDetail(world.server, { channels: [textChannel(1)] }) },
    } as unknown as Partial<RChatState>
    world.ann.account.store.setState(state)
    Object.assign(world.ann.account.store.getInitialState(), world.ann.account.store.getState())
  } else {
    const view = {
      id: world.room,
      name: 'Harbor',
      owner: null,
      owners: [],
      members: [],
      channels: [{ id: 'c1', name: 'c1', kind: 'text' }],
    } as unknown as ServerView
    const state =
      place.kind === 'p2pRoom'
        ? { servers: { [world.room]: view }, server: { room: world.room, ch: 'c1' } }
        : {
            home: true,
            chat: { room: world.room, peer: 'B' },
            contacts: [{ ik: 'B', name: 'Bob', state: 'mutual' }],
          }
    place.app.useP2p.setState(state as never)
    Object.assign(place.app.useP2p.getInitialState(), state)
  }
  const here = featureAt(named, place)
  if (isUnsupported(here)) throw new Error(here.line)
  return here
}

function OnScreen() {
  return <p>{usePlaceOnScreen()?.id ?? 'none'}</p>
}

placeContract(named, (kind, world) => {
  const inDm = kind === 'hostedDm' || kind === 'p2pDm'

  test('a place on screen has a name', () => {
    const here = seat(world())
    const shown = here.shown.get()
    expect(here.shown.get()).toBe(shown)
    if (inDm) expect(shown).toMatchObject({ kind: 'dm', name: kind === 'hostedDm' ? 'bob' : 'Bob' })
    else expect(shown).toMatchObject({ kind: 'channel', channel: 'c1' })
  })

  test('the place on screen is the one its account or identity shows', () => {
    seat(world())
    const { ann } = world()
    const html = renderToStaticMarkup(
      <AccountProvider session={ann.account}>
        <P2pProvider identity={ann.app}>
          <OnScreen />
        </P2pProvider>
      </AccountProvider>
    )
    expect(html).toBe(`<p>${ann.place.id}</p>`)
  })
})
