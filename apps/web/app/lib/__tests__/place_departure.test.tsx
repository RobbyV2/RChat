import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DepartureSection } from '../../components/departure_section'
import { P2pProvider } from '../client/p2p_react'
import { AccountProvider } from '../client/react'
import type { ServerView } from '../p2p/server'
import { departure } from '../place/departure'
import { featureAt, isUnsupported } from '../place/feature'
import type { ConfirmRequest, RChatState } from '../store_types'
import { placeContract, type ContractWorld } from './helpers/place_contract'

// Ann's side of a server or room she is in (or, `out`, was), with what she is asked and what
// the side is told recorded.
const seat = (world: ContractWorld, calls: unknown[][], out = false) => {
  const { place, account } = world.ann
  account.store.setState({
    askConfirm: (c: ConfirmRequest) => {
      calls.push(['ask', c.title])
      c.action?.('', undefined)
    },
    closeDialog: () => void calls.push(['close']),
    deleteServer: async (s: string) => void calls.push(['delete', s]),
  } as unknown as Partial<RChatState>)
  if (place.kind === 'p2pRoom') {
    const view = {
      id: world.room,
      name: 'Harbor',
      me: out ? 'left' : 'join',
      owner: 'B',
      members: [],
    }
    const state = { servers: { [world.room]: view as unknown as ServerView } }
    place.app.useP2p.setState(state as never)
    Object.assign(place.app.useP2p.getInitialState(), state)
    Object.assign(place.app.p2pServer, {
      leave: async (r: string) => void calls.push(['leave', r]),
      forget: async (r: string) => void calls.push(['forget', r]),
    })
    Object.assign(place.app.p2p, { closeDialog: () => void calls.push(['close']) })
  }
  Object.assign(account.store.getInitialState(), account.store.getState())
  return featureAt(departure, place)
}

placeContract(departure, (kind, world) => {
  if (kind === 'hostedDm' || kind === 'p2pDm') {
    test('a DM has no settings to leave from', () => {
      const here = seat(world(), [])
      expect(isUnsupported(here) && here.why).toBe('not_in_dms')
    })
    return
  }
  const hosted = kind === 'hostedServer'

  test('the end of the settings says what it does, asks, then does it on the side of the place', () => {
    const calls: unknown[][] = []
    const here = seat(world(), calls)
    if (isUnsupported(here)) throw new Error(here.line)
    const state = here.state.get()
    expect(here.state.get()).toBe(state)
    expect(state.kind).toBe(hosted ? 'delete' : 'leave')
    here.go()
    expect(calls).toEqual(
      hosted
        ? [['ask', 'Delete Server'], ['close'], ['delete', world().server]]
        : [
            ['ask', 'Leave Server'],
            ['leave', world().room],
          ]
    )
  })

  if (!hosted)
    test('a room you are out of is removed from this device', () => {
      const calls: unknown[][] = []
      const here = seat(world(), calls, true)
      if (isUnsupported(here)) throw new Error(here.line)
      expect(here.state.get().kind).toBe('forget')
      here.go()
      expect(calls).toEqual([['ask', 'Remove Server'], ['close'], ['forget', world().room]])
    })

  test('one section draws either side', () => {
    seat(world(), [])
    const { account, app, place } = world().ann
    const html = renderToStaticMarkup(
      <AccountProvider session={account}>
        <P2pProvider identity={app}>
          <DepartureSection place={place} />
        </P2pProvider>
      </AccountProvider>
    )
    expect(html).toContain(hosted ? '>Delete server<' : '>Leave server<')
  })
})
