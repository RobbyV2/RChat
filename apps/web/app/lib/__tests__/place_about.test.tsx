import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { OverviewSection } from '../../components/overview_section'
import { P2pProvider } from '../client/p2p_react'
import { AccountProvider } from '../client/react'
import type { ServerView } from '../p2p/server'
import { P } from '../p2p/state'
import { about } from '../place/about'
import { featureAt, isUnsupported } from '../place/feature'
import type { RChatState } from '../store_types'
import { serverDetail } from './fixtures'
import { placeContract, type ContractWorld } from './helpers/place_contract'

// Ann's side of a server or room called Harbor, which she may change unless `reader`, and what
// the side is asked recorded.
const seat = (world: ContractWorld, calls: unknown[][], reader = false) => {
  const { place, account } = world.ann
  if (place.kind === 'hostedServer') {
    account.store.setState({
      servers: { [world.server]: { ...serverDetail(world.server), display_name: 'Harbor' } },
      renameServer: async (...a: unknown[]) => void calls.push(['rename', ...a]),
      closeDialog: () => void calls.push(['close']),
    } as unknown as Partial<RChatState>)
  } else if (place.kind === 'p2pRoom') {
    const view = {
      id: world.room,
      name: 'Harbor',
      me: 'join',
      perms: reader ? 0 : P.ManageServer,
      color: null,
      about: { text: 'by the sea', icon: 'letter' },
      owners: [],
      members: [],
    } as unknown as ServerView
    const state = { servers: { [world.room]: view } }
    place.app.useP2p.setState(state as never)
    Object.assign(place.app.useP2p.getInitialState(), state)
    Object.assign(place.app.p2pServer, {
      rename: async (...a: unknown[]) => void calls.push(['rename', ...a]),
      setAbout: async (...a: unknown[]) => void calls.push(['about', ...a]),
    })
  }
  Object.assign(account.store.getInitialState(), account.store.getState())
  return featureAt(about, place)
}

placeContract(about, (kind, world) => {
  if (kind === 'hostedDm' || kind === 'p2pDm') {
    test('a DM has no overview', () => {
      const here = seat(world(), [])
      expect(isUnsupported(here) && here.why).toBe('not_in_dms')
    })
    return
  }
  const hosted = kind === 'hostedServer'
  const open = (calls: unknown[][] = [], reader = false) => {
    const here = seat(world(), calls, reader)
    if (isUnsupported(here)) throw new Error(here.line)
    return here
  }

  test('the name and the about show, and a rename goes to the side of the place', async () => {
    const calls: unknown[][] = []
    const here = open(calls)
    const s = here.state.get()
    expect(here.state.get()).toBe(s)
    expect([s.ready, s.shown, s.name, s.canRename, s.editable]).toEqual([
      true,
      true,
      'Harbor',
      true,
      true,
    ])
    expect(s.glyph.kind).toBe(hosted ? 'hosted' : 'room')
    expect(await here.rename('Cove')).toBeNull()
    expect(calls).toEqual(
      hosted ? [['rename', world().server, 'Cove'], ['close']] : [['rename', world().room, 'Cove']]
    )
  })

  if (!hosted)
    test('who may not change it reads it, with the line that says why', () => {
      const s = open([], true).state.get()
      expect([s.canRename, s.editable, s.picture]).toEqual([false, false, null])
      expect(s.renameLocked).toContain('Manage server')
    })

  test('one section draws either side', () => {
    open()
    const { account, app, place } = world().ann
    const html = renderToStaticMarkup(
      <AccountProvider session={account}>
        <P2pProvider identity={app}>
          <OverviewSection place={place} />
        </P2pProvider>
      </AccountProvider>
    )
    expect(html).toContain('data-overview')
    expect(html).toContain('aria-label="Server name"')
    expect(html).toContain('value="Harbor"')
  })
})
