import { expect, test } from 'bun:test'
import { createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MessageList } from '../../components/message_list'
import { AccountProvider } from '../client/react'
import { featureAt, isUnsupported } from '../place/feature'
import { messages } from '../place/messages'
import type { RChatState } from '../store_types'
import type { View } from '../view'
import { placeContract, type ContractWorld } from './helpers/place_contract'

// Ann's side with the conversation on screen opened in older history (more before and after
// what is loaded), and what the side is asked recorded.
const seat = (world: ContractWorld, calls: unknown[][], shown = true) => {
  const { place } = world.ann
  if (place.kind === 'hostedServer' || place.kind === 'hostedDm') {
    const view: View =
      place.kind === 'hostedServer'
        ? { kind: 'channel', server: world.server, channelId: 1 }
        : { kind: 'dm', dmId: world.dmId }
    const key = place.kind === 'hostedServer' ? 'c1' : `d${world.dmId}`
    const state = {
      view: shown ? view : null,
      older: { [key]: { more: true, loading: true } },
      newer: { [key]: { more: true, loading: false } },
      loadOlder: async () => void calls.push(['older']),
      loadNewer: async () => void calls.push(['newer']),
      jumpTo: async (...a: unknown[]) => void calls.push(['jump', ...a]),
      jumpToPresent: async (...a: unknown[]) => void calls.push(['present', ...a]),
      jumpToUnread: async () => void calls.push(['unread']),
      markRead: (...a: unknown[]) => void calls.push(['read', ...a]),
      dismissUnread: (...a: unknown[]) => void calls.push(['dismiss', ...a]),
    } as unknown as Partial<RChatState>
    world.ann.account.store.setState(state)
    Object.assign(world.ann.account.store.getInitialState(), world.ann.account.store.getState())
  } else {
    const chat = {
      room: world.room,
      ch: place.kind === 'p2pRoom' ? 'c1' : null,
      more: true,
      newer: true,
      loading: false,
    }
    const state = { chat: shown ? chat : null }
    place.app.useP2p.setState(state as never)
    Object.assign(place.app.useP2p.getInitialState(), state)
    Object.assign(place.app.p2pDm, {
      loadOlderPage: async () => void calls.push(['older']),
      loadNewerPage: async () => void calls.push(['newer']),
      jumpTo: async (id: string) => void calls.push(['jump', id]),
      toPresent: async () => void calls.push(['present']),
      firstUnread: async () => {
        calls.push(['unread'])
        return null
      },
      markRead: (key: string) => void calls.push(['read', key]),
      dismissUnread: (key: string) => void calls.push(['dismiss', key]),
    })
  }
  const here = featureAt(messages, place)
  if (isUnsupported(here)) throw new Error(here.line)
  return here
}

placeContract(messages, (kind, world) => {
  const hosted = kind === 'hostedServer' || kind === 'hostedDm'
  const hostedKey = () => (kind === 'hostedServer' ? 'c1' : `d${world().dmId}`)
  const peerKey = () => (kind === 'p2pRoom' ? `${world().room}/c1` : world().room)

  test('the list says where it is in its history', () => {
    const here = seat(world(), [])
    const state = here.state.get()
    expect(here.state.get()).toBe(state)
    expect(state.scope).toBe(hosted ? hostedKey() : `p2p:${peerKey()}`)
    expect(state.older).toEqual({ more: true, loading: hosted })
    expect(state.newer).toEqual({ more: true, loading: false })
    expect(state.pagesOnSight).toBe(hosted)
  })

  test('with no conversation on screen there is no list', () => {
    expect(seat(world(), [], false).state.get().scope).toBeNull()
  })

  test('pages, jumps and read marks run on the side of the place', () => {
    const calls: unknown[][] = []
    const here = seat(world(), calls)
    const key = hosted ? '5' : 'e5'
    here.loadOlder()
    here.loadNewer()
    here.jump(key)
    here.toPresent()
    here.toUnread()
    here.dismissUnread()
    here.markRead(key)
    expect(calls).toEqual(
      hosted
        ? [
            ['older'],
            ['newer'],
            ['jump', hostedKey(), 5],
            ['present', hostedKey()],
            ['unread'],
            ['dismiss', hostedKey()],
            ['read', hostedKey(), 5],
          ]
        : [['older'], ['newer'], ['jump', 'e5'], ['present'], ['unread'], ['dismiss', peerKey()]]
    )
  })

  test('one list draws either side, with its way to other pages', () => {
    const here = seat(world(), [])
    const html = renderToStaticMarkup(
      <AccountProvider session={world().ann.account}>
        <MessageList
          list={here}
          state={here.state.get()}
          listRef={createRef()}
          contentRef={createRef()}
          onScroll={() => {}}
          loading={false}
          positioned
          ends={{ first: 1, last: 2 }}
          banner={null}
          fresh={3}
          toBottom={() => {}}
          lightbox={{ rows: () => ({ ids: [], places: [] }), forward: () => null }}
        >
          <p>rows</p>
        </MessageList>
      </AccountProvider>
    )
    expect(html).toContain('<p>rows</p>')
    expect(html.includes('Loading older messages')).toBe(hosted)
    expect(html.includes('Show older messages')).toBe(!hosted)
    expect(html.includes('Show newer')).toBe(!hosted)
    expect(html.includes('3 new messages')).toBe(!hosted)
    expect(html).toContain('Jump to present')
  })
})
