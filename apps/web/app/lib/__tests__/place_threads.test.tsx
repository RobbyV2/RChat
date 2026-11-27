import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThreadsButton, ThreadsWindow } from '../../components/threads'
import { AccountProvider } from '../client/react'
import { P2pProvider } from '../client/p2p_react'
import type { P2pMessage } from '../p2p/dm'
import { featureAt, isUnsupported } from '../place/feature'
import { PlaceProvider } from '../place/react'
import { threads } from '../place/threads'
import type { RChatState } from '../store_types'
import type { View } from '../view'
import { msg, user } from './fixtures'
import { placeContract, type ContractWorld } from './helpers/place_contract'

// Ann's side with one thread started by Bob in the conversation on screen, and what the side is
// asked recorded.
const seat = (world: ContractWorld, calls: unknown[][], open = true) => {
  const { place } = world.ann
  if (place.kind === 'hostedServer' || place.kind === 'hostedDm') {
    const view: View =
      place.kind === 'hostedServer'
        ? { kind: 'channel', server: world.server, channelId: 1 }
        : { kind: 'dm', dmId: world.dmId }
    const key = place.kind === 'hostedServer' ? 'c1' : `d${world.dmId}`
    const root = msg(5, { author: user('bob'), content: 'who brings the map', reply_count: 2 })
    const page = async (...a: unknown[]) => {
      calls.push(['page', ...a])
      return { items: [{ root, last_reply_at: 9 }], next: null }
    }
    Object.assign(world.ann.account.api, { channelThreads: page, dmThreads: page })
    const state = {
      view,
      threads: open ? key : null,
      pings: { t5: {} },
      openThreads: () => void calls.push(['open']),
      closeThreads: () => void calls.push(['close']),
      openThread: async (m: { id: number }) => void calls.push(['thread', m.id]),
      jumpTo: async (...a: unknown[]) => void calls.push(['jump', ...a]),
    } as unknown as Partial<RChatState>
    world.ann.account.store.setState(state)
    Object.assign(world.ann.account.store.getInitialState(), world.ann.account.store.getState())
  } else {
    const root = {
      id: 'e5',
      sender: 'B',
      ts: 5_000,
      body: 'who brings the map',
      att: [],
      reactions: [],
      edited: null,
      pinned: null,
      replies: 2,
      lastReply: 9_000,
    } as unknown as P2pMessage
    const chat = { room: world.room, ch: place.kind === 'p2pRoom' ? 'c1' : null }
    const state = { chat, threads: open ? (chat.ch ? `${chat.room}/${chat.ch}` : chat.room) : null }
    place.app.useP2p.setState(state as never)
    Object.assign(place.app.useP2p.getInitialState(), state, { me: 'A' })
    Object.assign(place.app.p2pDm, {
      openThreads: () => void calls.push(['open']),
      closeThreads: () => void calls.push(['close']),
      jumpTo: async (id: string) => void calls.push(['jump', id]),
    })
    Object.assign(place.app.p2pThread, {
      list: async () => [{ root, last: '9', pinged: true }],
      open: async (id: string) => void calls.push(['thread', id]),
    })
  }
  const here = featureAt(threads, place)
  if (isUnsupported(here)) throw new Error(here.line)
  return here
}

placeContract(threads, (kind, world) => {
  const hosted = kind === 'hostedServer' || kind === 'hostedDm'
  const scope = () => (kind === 'hostedServer' ? 'c1' : `d${world().dmId}`)

  test('the list is open for the conversation on screen only', () => {
    const here = seat(world(), [])
    const state = here.state.get()
    expect(here.state.get()).toBe(state)
    expect(state.open).not.toBeNull()
    expect(state.byKey).toBe(!hosted)
    expect(seat(world(), [], false).state.get().open).toBeNull()
  })

  test('a page lists the threads with their roots, replies and unread pings', async () => {
    const here = seat(world(), [])
    const page = await here.page('', null)
    const rows = here.state.get().shown(page.items)
    expect(rows.map(r => [r.key, r.root.content, r.replies, r.lastAt, r.pinged])).toEqual([
      [hosted ? '5' : 'e5', 'who brings the map', 2, 9, true],
    ])
    expect(page.next).toBeNull()
    expect((await here.page('nothing like it', null)).items.length).toBe(hosted ? 1 : 0)
  })

  test('opening a thread and jumping to its root close the list first', async () => {
    const calls: unknown[][] = []
    const here = seat(world(), calls)
    const [row] = (await here.page('', null)).items
    calls.length = 0
    here.open()
    here.openThread(row)
    here.jump(row)
    expect(calls).toEqual(
      hosted
        ? [['open'], ['close'], ['thread', 5], ['close'], ['jump', scope(), 5]]
        : [['open'], ['close'], ['thread', 'e5'], ['close'], ['jump', 'e5']]
    )
  })

  test('one button and one list draw either side', () => {
    seat(world(), [])
    const { ann } = world()
    const html = renderToStaticMarkup(
      <AccountProvider session={ann.account}>
        <P2pProvider identity={ann.app}>
          <PlaceProvider place={ann.place}>
            <ThreadsButton />
            <ThreadsWindow />
          </PlaceProvider>
        </P2pProvider>
      </AccountProvider>
    )
    expect(html).toContain('title="Threads"')
    expect(html).toContain('aria-label="Threads"')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('Loading threads')
  })
})
