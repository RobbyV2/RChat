import { expect, test } from 'bun:test'
import type { P2pMessage } from '../p2p/dm'
import { featureAt, isUnsupported } from '../place/feature'
import { thread } from '../place/thread'
import type { RChatState } from '../store_types'
import { msg, user } from './fixtures'
import { placeContract, type ContractWorld } from './helpers/place_contract'

// Ann's side with Bob's thread open beside the conversation (two replies said, `placed` of them
// loaded, more stored before them), and what the side is asked recorded.
const seat = (world: ContractWorld, calls: unknown[][], open = true, placed = 1) => {
  const { place } = world.ann
  if (place.kind === 'hostedServer' || place.kind === 'hostedDm') {
    const inServer = place.kind === 'hostedServer'
    const root = msg(5, {
      author: user('bob'),
      content: 'who brings the map',
      reply_count: 2,
      channel_id: inServer ? 1 : null,
      dm_id: inServer ? null : world.dmId,
    })
    const replies = Array.from({ length: placed }, (_, i) => msg(6 + i, { author: user('bob') }))
    const state = {
      panel: open ? { kind: 'thread', root } : null,
      messages: { t5: replies },
      older: { t5: { more: true, loading: false } },
      newer: {},
      stale: { t5: placed === 0 },
      pings: { t5: {} },
      loadOlderThread: async () => void calls.push(['older']),
      loadNewerThread: async () => void calls.push(['newer']),
      jumpToPresent: async (...a: unknown[]) => void calls.push(['present', ...a]),
      jumpTo: async (...a: unknown[]) => void calls.push(['jump', ...a]),
      seeThread: (id: number) => void calls.push(['read', id]),
      closePanel: () => void calls.push(['close']),
    } as unknown as Partial<RChatState>
    world.ann.account.store.setState(state)
    Object.assign(world.ann.account.store.getInitialState(), world.ann.account.store.getState())
  } else {
    const said = (id: string, replies?: number) =>
      ({ id, sender: 'B', ts: 5_000, body: 'who brings the map', att: [], replies }) as never
    const ch = place.kind === 'p2pRoom' ? 'c1' : null
    const open_ = {
      room: world.room,
      ch,
      root: 'e5',
      head: said('e5', 2) as P2pMessage,
      messages: Array.from({ length: placed }, (_, i) => said(`e${6 + i}`) as P2pMessage),
      more: true,
      loading: placed === 0,
    }
    const state = { thread: open ? open_ : null }
    place.app.useP2p.setState(state as never)
    Object.assign(place.app.useP2p.getInitialState(), state)
    Object.assign(place.app.p2pDm, {
      jumpTo: async (id: string) => void calls.push(['main', id]),
    })
    Object.assign(place.app.p2pThread, {
      loadOlder: async () => void calls.push(['older']),
      jumpTo: async (id: string) => void calls.push(['jump', id]),
      markRead: async () => void calls.push(['read']),
      close: () => void calls.push(['close']),
    })
  }
  const here = featureAt(thread, place)
  if (isUnsupported(here)) throw new Error(here.line)
  return here
}

placeContract(thread, (kind, world) => {
  const hosted = kind === 'hostedServer' || kind === 'hostedDm'
  const main = () => (kind === 'hostedServer' ? 'c1' : `d${world().dmId}`)

  test('no thread open is a closed state', () => {
    const state = seat(world(), [], false).state.get()
    expect(state.scope).toBeNull()
    expect(state.count).toBe(0)
    expect(state.waiting).toBe(false)
  })

  test('the open thread says its root, reply count and ends', () => {
    const here = seat(world(), [])
    const state = here.state.get()
    expect(here.state.get()).toBe(state)
    expect(state.scope).not.toBeNull()
    expect(state.root).toBe('shown')
    expect(state.count).toBe(2)
    expect(state.older.more).toBe(true)
    expect(state.newer.more).toBe(false)
    expect(state.pagesOnSight).toBe(hosted)
    expect(state.waiting).toBe(false)
  })

  test('replies on their way with none placed are waited for', () => {
    const state = seat(world(), [], true, 0).state.get()
    expect(state.stale).toBe(true)
    expect(state.waiting).toBe(true)
  })

  test('paging, jumping, reading and closing go to the side', () => {
    const calls: unknown[][] = []
    const here = seat(world(), calls)
    here.loadOlder()
    here.jump(hosted ? '6' : 'e6')
    here.jumpMain(hosted ? '5' : 'e5')
    here.markRead()
    here.close()
    expect(calls).toEqual(
      hosted
        ? [['older'], ['jump', 't5', 6], ['jump', main(), 5], ['read', 5], ['close']]
        : [['older'], ['jump', 'e6'], ['main', 'e5'], ['read'], ['close']]
    )
  })
})
