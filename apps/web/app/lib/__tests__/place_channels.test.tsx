import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChannelList } from '../../components/channel_list'
import { AccountProvider } from '../client/react'
import type { ServerView } from '../p2p/server'
import { P } from '../p2p/state'
import { channels, unfolded } from '../place/channels'
import { featureAt, isUnsupported } from '../place/feature'
import type { RChatState } from '../store_types'
import type { Channel } from '../types'
import { serverDetail, textChannel } from './fixtures'
import { placeContract, type ContractWorld } from './helpers/place_contract'

// Ann's side of a server or room she manages: one loose channel on screen, and a category with
// a text channel and a private voice channel. What the side is asked is recorded.
const seat = (world: ContractWorld, calls: unknown[][]) => {
  const { place } = world.ann
  if (place.kind === 'hostedServer') {
    const list = [
      { ...textChannel(1), category_id: null, position: 0 },
      { ...textChannel(2), category_id: 9, position: 0 },
      { ...textChannel(3), kind: 'voice', category_id: 9, position: 1, restrict_view: true },
    ] as unknown as Channel[]
    const state = {
      servers: {
        [world.server]: serverDetail(world.server, {
          channels: list,
          categories: [{ id: 9, name: 'Deck', position: 0 }],
        } as never),
      },
      view: { kind: 'channel', server: world.server, channelId: 1 },
      me: {
        ...world.ann.account.store.getState().me,
        servers: [{ name: world.server, is_admin: true, creator: 'ann' }],
      },
      openChannel: async (...a: unknown[]) => void calls.push(['open', ...a]),
      setCategoriesCollapsed: (server: string, ids: number[], collapsed: boolean) => {
        calls.push(['fold', server, ids, collapsed])
        const s = world.ann.account.store.getState()
        world.ann.account.store.setState({
          layout: { ...s.layout, collapsed: collapsed ? { [server]: ids } : {} },
        })
      },
    } as unknown as Partial<RChatState>
    world.ann.account.store.setState(state)
    Object.assign(world.ann.account.store.getInitialState(), world.ann.account.store.getState())
  } else if (place.kind === 'p2pRoom') {
    const view = {
      id: world.room,
      name: 'Harbor',
      me: 'join',
      perms: P.ManageChannels,
      owners: ['A'],
      members: [],
      channels: [
        { id: 'c1', name: 'c1', kind: 'text', pos: 0, cat: null },
        { id: 'c2', name: 'c2', kind: 'text', pos: 0, cat: 'k9' },
        { id: 'c3', name: 'c3', kind: 'voice', pos: 1, cat: 'k9', restrict_view: true },
      ],
      categories: [{ id: 'k9', name: 'Deck', pos: 0 }],
    } as unknown as ServerView
    const state = { servers: { [world.room]: view }, server: { room: world.room, ch: 'c1' } }
    place.app.useP2p.setState(state as never)
    Object.assign(place.app.useP2p.getInitialState(), state, { me: 'A' })
    Object.assign(place.app.p2pServer, {
      openChannel: async (id: string) => void calls.push(['open', id]),
    })
  }
  return featureAt(channels, place)
}

placeContract(channels, (kind, world) => {
  const hosted = kind === 'hostedServer'
  if (kind === 'hostedDm' || kind === 'p2pDm') {
    test('a DM has no channels', () => {
      const here = seat(world(), [])
      expect(isUnsupported(here) && here.why).toBe('not_in_dms')
    })
    return
  }
  const listed = (calls: unknown[][] = []) => {
    const here = seat(world(), calls)
    if (isUnsupported(here)) throw new Error(here.line)
    return here
  }
  const ids = hosted ? ['1', '2', '3', '9'] : ['c1', 'c2', 'c3', 'k9']

  test('the channels come in their categories, with the one on screen marked', () => {
    const here = listed()
    const state = here.state.get()
    expect(here.state.get()).toBe(state)
    expect([state.ready, state.canManage, state.empty]).toEqual([true, true, null])
    expect(state.uncategorized.map(c => [c.key, c.name, c.kind, c.active])).toEqual([
      [ids[0], 'c1', 'text', true],
    ])
    expect(state.categories.map(g => [g.key, g.name, g.open])).toEqual([[ids[3], 'Deck', true]])
    expect(state.categories[0].channels.map(c => [c.key, c.kind, c.private])).toEqual([
      [ids[1], 'text', false],
      [ids[2], 'voice', true],
    ])
  })

  test('a folded category keeps only the channel on screen', () => {
    const calls: unknown[][] = []
    const here = listed(calls)
    here.setOpen(ids[3], false)
    const [category] = here.state.get().categories
    expect(category.open).toBe(false)
    expect(unfolded(category)).toEqual([])
    here.setOpen(ids[3], true)
    expect(here.state.get().categories[0].open).toBe(true)
    here.open(ids[1])
    expect(calls.at(-1)).toEqual(hosted ? ['open', world().server, 2] : ['open', 'c2'])
  })

  test('one list draws either side', () => {
    const here = listed()
    const html = renderToStaticMarkup(
      <AccountProvider session={world().ann.account}>
        <ChannelList
          channels={here}
          state={here.state.get()}
          look={() => ({ muted: false, bold: false })}
          end={c => <i>{`end ${c.key}`}</i>}
          voice={c => <b key={c.key}>{`voice ${c.key}`}</b>}
        />
      </AccountProvider>
    )
    expect(html).toContain('c1')
    expect(html).toContain('Deck')
    expect(html).toContain(`<i>end ${ids[1]}</i>`)
    expect(html).toContain(`<b>voice ${ids[2]}</b>`)
    expect(html).toContain('aria-expanded="true"')
  })
})
