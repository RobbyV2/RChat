import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import SearchPanel from '../../components/search_panel'
import { AccountProvider } from '../client/react'
import { P2pProvider } from '../client/p2p_react'
import type { P2pMessage } from '../p2p/dm'
import type { ServerView } from '../p2p/server'
import { featureAt, isUnsupported } from '../place/feature'
import { PlaceProvider } from '../place/react'
import { accountSearch, search, type SearchFilters } from '../place/search'
import type { RChatState } from '../store_types'
import { msg, serverDetail, textChannel, user } from './fixtures'
import { placeContract, type ContractWorld } from './helpers/place_contract'

const FILTERS: SearchFilters = {
  q: 'noon',
  from: '',
  channel: '',
  hasFile: false,
  beforeTs: null,
  afterTs: null,
}

// Ann's side with one result written by Bob, and what the side is asked recorded.
const seat = (world: ContractWorld, calls: unknown[][]) => {
  const { place } = world.ann
  if (place.kind === 'hostedServer' || place.kind === 'hostedDm') {
    const state = {
      servers: { [world.server]: serverDetail(world.server, { channels: [textChannel(1)] }) },
      search: {
        results: [
          {
            message: msg(5, { author: user('bob'), content: 'we meet at noon' }),
            server: world.server,
            channel_name: 'c1',
          },
        ],
        hasMore: true,
        loading: false,
        cursor: 'next',
      },
      searchRun: async (...a: unknown[]) => void calls.push(['run', ...a]),
      closePanel: () => void calls.push(['close']),
      openResult: async (r: { message: { id: number } }) => void calls.push(['open', r.message.id]),
      discoverChannels: async (name: string) => void calls.push(['discover', name]),
    } as unknown as Partial<RChatState>
    world.ann.account.store.setState(state)
    Object.assign(world.ann.account.store.getInitialState(), world.ann.account.store.getState())
  } else {
    const hit = { id: 'e5', sender: 'B', ts: 5_000, body: 'we meet at noon', att: [] }
    const view = {
      id: world.room,
      name: 'Harbor',
      owners: [],
      members: [{ ik: 'B', name: 'Bob' }],
      channels: [{ id: 'c1', name: 'c1', kind: 'text' }],
    } as unknown as ServerView
    const state = {
      servers: { [world.room]: view },
      search: {
        hits: [{ room: world.room, ch: 'c1', m: hit as unknown as P2pMessage }],
        loading: false,
        next: 'next',
        indexing: false,
      },
    }
    place.app.useP2p.setState(state as never)
    Object.assign(place.app.useP2p.getInitialState(), state, { me: 'A' })
    Object.assign(place.app.p2pSearch, {
      run: async (...a: unknown[]) => void calls.push(['run', ...a]),
      close: () => void calls.push(['close']),
      openHit: async (h: { m: { id: string } }) => void calls.push(['open', h.m.id]),
    })
  }
  const here = featureAt(search, place)
  if (isUnsupported(here)) throw new Error(here.line)
  return here
}

placeContract(search, (kind, world) => {
  const hosted = kind === 'hostedServer' || kind === 'hostedDm'
  const inDm = kind === 'hostedDm' || kind === 'p2pDm'

  test('a result names its place and its author, and opens on its side', () => {
    const calls: unknown[][] = []
    const here = seat(world(), calls)
    const state = here.state.get()
    expect(here.state.get()).toBe(state)
    const [hit] = state.hits
    expect([hit.channel, hit.content, hit.own, hit.forwarded]).toEqual([
      'c1',
      'we meet at noon',
      false,
      false,
    ])
    expect(hit.author?.kind).toBe(hosted ? 'account' : 'key')
    expect(state.hasMore).toBe(true)
    expect(state.byIdentity).toBe(!hosted)
    expect(state.note === null).toBe(hosted)
    hit.onOpen()
    expect(calls).toEqual([['open', hosted ? 5 : 'e5']])
  })

  test('the channel choices are those of a server or a room, and a DM has none', () => {
    const { channels } = seat(world(), []).state.get()
    if (inDm) expect(channels).toBeUndefined()
    else expect(channels?.map(c => [c.id, c.name])).toEqual([[hosted ? '1' : 'c1', 'c1']])
  })

  test('a search runs and closes on the side of the place', () => {
    const calls: unknown[][] = []
    const here = seat(world(), calls)
    here.run({ ...FILTERS, channel: hosted ? '1' : 'c1' }, true)
    here.close()
    const asked = hosted
      ? { q: 'noon', from: '', channelId: 1, hasFile: false, beforeTs: null, afterTs: null }
      : { q: 'noon', from: '', ch: 'c1', hasFile: false, beforeTs: null, afterTs: null }
    expect(calls).toEqual([['run', asked, true], ['close']])
    expect(here.steps('a')).toBe(hosted)
  })

  test('watching looks up the servers of results that are not loaded', () => {
    const calls: unknown[][] = []
    const here = seat(world(), calls)
    const { account } = world().ann
    if (hosted) account.store.setState({ servers: {} })
    const stop = here.watch()
    account.store.setState({ toast: null })
    stop()
    expect(calls).toEqual(hosted ? [['discover', world().server]] : [])
  })

  test('one panel draws either side', () => {
    seat(world(), [])
    const { ann } = world()
    const html = renderToStaticMarkup(
      <AccountProvider session={ann.account}>
        <P2pProvider identity={ann.app}>
          <PlaceProvider place={ann.place}>
            <SearchPanel />
          </PlaceProvider>
        </P2pProvider>
      </AccountProvider>
    )
    expect(html).toContain('we meet at noon')
    expect(html.includes('Searches messages stored on this device')).toBe(!hosted)
  })

  test('outside a place an account searches its instance', () => {
    const { account } = world().ann
    expect(accountSearch(account)).toBe(accountSearch(account))
    expect(accountSearch(account).state.get().byIdentity).toBe(false)
  })
})
