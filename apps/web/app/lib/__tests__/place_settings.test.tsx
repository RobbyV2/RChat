import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ServerSettingsPage } from '../../components/server_settings_page'
import { AccountProvider } from '../client/react'
import { P2pProvider } from '../client/p2p_react'
import type { ServerView } from '../p2p/server'
import { featureAt, isUnsupported } from '../place/feature'
import { PlaceProvider } from '../place/react'
import { settings } from '../place/settings'
import type { RChatState } from '../store_types'
import { serverDetail } from './fixtures'
import { placeContract, type ContractWorld } from './helpers/place_contract'

// Ann's side of a server or room she runs, and what the side is asked recorded.
const seat = (world: ContractWorld, calls: unknown[][], admin = true) => {
  const { place } = world.ann
  if (place.kind === 'hostedServer') {
    const state = {
      servers: { [world.server]: serverDetail(world.server) },
      me: {
        ...world.ann.account.store.getState().me,
        servers: [{ name: world.server, is_admin: admin, creator: 'ann' }],
      },
      closeDialog: () => void calls.push(['close']),
    } as unknown as Partial<RChatState>
    world.ann.account.store.setState(state)
    Object.assign(world.ann.account.store.getInitialState(), world.ann.account.store.getState())
  } else if (place.kind === 'p2pRoom') {
    const view = {
      id: world.room,
      name: 'Harbor',
      me: 'join',
      perms: 0,
      members: [],
    } as unknown as ServerView
    const state = { servers: admin ? { [world.room]: view } : {} }
    place.app.useP2p.setState(state as never)
    Object.assign(place.app.useP2p.getInitialState(), state)
    Object.assign(place.app.p2p, { closeDialog: () => void calls.push(['close']) })
  }
  return featureAt(settings, place)
}

placeContract(settings, (kind, world) => {
  if (kind === 'hostedDm' || kind === 'p2pDm') {
    test('a DM has no settings', () => {
      const here = seat(world(), [])
      expect(isUnsupported(here) && here.why).toBe('not_in_dms')
    })
    return
  }
  const open = (calls: unknown[][] = [], admin = true) => {
    const here = seat(world(), calls, admin)
    if (isUnsupported(here)) throw new Error(here.line)
    return here
  }

  test('the sections you see are listed in nav order, each with what search finds', () => {
    const here = open()
    const sections = here.sections.get()
    expect(here.sections.get()).toBe(sections)
    const ids = sections?.map(s => s.id) ?? []
    expect(ids).toContain('overview')
    expect(ids).toContain('roles')
    expect(ids).toContain('channels')
    expect(ids).toContain('bans')
    expect(sections?.every(s => s.label !== '' && s.rows.length > 0)).toBe(true)
  })

  test('a place with nothing to show you has no sections', () => {
    expect(open([], false).sections.get()).toBeNull()
  })

  test('closing runs on the side of the place', () => {
    const calls: unknown[][] = []
    open(calls).close()
    expect(calls).toEqual([['close']])
  })

  test('one page draws either side', () => {
    open()
    const { ann } = world()
    const html = renderToStaticMarkup(
      <AccountProvider session={ann.account}>
        <P2pProvider identity={ann.app}>
          <PlaceProvider place={ann.place}>
            <ServerSettingsPage first="roles" render={id => <p>{`body ${id}`}</p>} actor={null} />
          </PlaceProvider>
        </P2pProvider>
      </AccountProvider>
    )
    expect(html).toContain('aria-label="Server Settings"')
    expect(html).toContain('data-settings-section="roles" aria-current="page"')
    expect(html).toContain('<p>body roles</p>')
  })
})
