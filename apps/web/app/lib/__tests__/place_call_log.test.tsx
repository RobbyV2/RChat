import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ListedRow } from '../../components/listed_row'
import { AccountProvider } from '../client/react'
import { P2pProvider } from '../client/p2p_react'
import { nameText } from '../names'
import { asMessage } from '../p2p/shown_message'
import type { P2pMessage } from '../p2p/dm'
import { callLog } from '../place/call_log'
import { featureAt, isUnsupported } from '../place/feature'
import { PlaceProvider } from '../place/react'
import type { RChatState } from '../store_types'
import type { CallLog, Message } from '../types'
import { msg, user } from './fixtures'
import { NO_HANDLERS } from './helpers/peer_row'
import { placeContract, type ContractWorld } from './helpers/place_contract'

// A call from Bob in the conversation Ann has open, as her side stores it, and what the side is
// asked recorded.
const seat = (world: ContractWorld, calls: unknown[][], over: Partial<CallLog> = {}) => {
  const { place } = world.ann
  let m: Message
  if (place.kind === 'hostedServer' || place.kind === 'hostedDm') {
    const call: CallLog = {
      from: 'bob',
      answered_at: 10,
      ended_at: 70,
      outcome: 'completed',
      p2p: true,
      video: false,
      ...over,
    }
    m = msg(5, { author: user('bob'), kind: 'call', call, dm_id: world.dmId, channel_id: null })
    const state = {
      me: user('ann'),
      openDm: async (id: number) => void calls.push(['open', id]),
      acceptCall: async () => void calls.push(['accept']),
      declineCall: () => void calls.push(['decline']),
    } as unknown as Partial<RChatState>
    world.ann.account.store.setState(state)
    Object.assign(world.ann.account.store.getInitialState(), world.ann.account.store.getState())
  } else {
    const p = {
      id: 'e5',
      sender: 'B',
      ts: 70_000,
      body: '',
      att: [],
      reactions: [],
      edited: null,
      pinned: null,
      call: { outcome: 'ended', dur: 60, video: false },
    } as unknown as P2pMessage
    m = asMessage(p, 5, 0, ik => user(ik === 'B' ? 'Bob' : 'Ann'), 'A')
    const state = { rooms: { [world.room]: { peer: 'B' } } }
    place.app.useP2p.setState(state as never)
    Object.assign(place.app.useP2p.getInitialState(), state, { me: 'A' })
    Object.assign(place.app.p2pCall, {
      accept: async () => void calls.push(['accept']),
      decline: () => void calls.push(['decline']),
    })
  }
  return { here: featureAt(callLog, place), m }
}

placeContract(callLog, (kind, world) => {
  const hosted = kind === 'hostedDm'
  if (kind === 'hostedServer' || kind === 'p2pRoom') {
    test('a server has no call rows', () => {
      const { here } = seat(world(), [])
      expect(isUnsupported(here) && here.why).toBe('unsupported')
    })
    return
  }
  const open = (calls: unknown[][] = [], over: Partial<CallLog> = {}) => {
    const { here, m } = seat(world(), calls, over)
    if (isUnsupported(here)) throw new Error(here.line)
    return { here, m, call: m.call as CallLog }
  }

  test('a stored call says who it is from and how it was connected', () => {
    const { here, m, call } = open()
    expect(m.kind).toBe('call')
    expect(call.outcome).toBe('completed')
    expect(call.answered_at).toBe(10)
    expect(here.self.get()).toBe(hosted ? 'ann' : 'A')
    expect(here.self.get()).not.toBe(call.from)
    expect(here.mark(call)).toBe(hosted ? 'direct' : 'peer')
    const caller = here.caller(call)
    expect(caller).not.toBeNull()
    if (hosted) expect(caller && nameText(caller).toLowerCase()).toContain('bob')
  })

  test('answering and declining go to the side', () => {
    const calls: unknown[][] = []
    const { here, m } = open(calls)
    here.accept(m)
    here.decline()
    expect(calls).toEqual(
      hosted ? [['open', world().dmId], ['accept'], ['decline']] : [['accept'], ['decline']]
    )
  })

  test('one row draws the call on either side', () => {
    const { m } = open()
    const { ann } = world()
    const html = renderToStaticMarkup(
      <AccountProvider session={ann.account}>
        <P2pProvider identity={ann.app}>
          <PlaceProvider place={ann.place}>
            <ListedRow
              m={m}
              first
              last
              mentioned={false}
              divider
              flash={false}
              server={null}
              canEdit={false}
              canReply={false}
              canForward={false}
              thread={null}
              canDelete={false}
              canReact={false}
              canUnreact={false}
              editing={false}
              on={NO_HANDLERS}
            />
          </PlaceProvider>
        </P2pProvider>
      </AccountProvider>
    )
    expect(html).toContain('data-call="ended"')
    expect(html).toContain('data-call-row')
    expect(html).toContain('Voice call')
    expect(html).toContain('aria-label="Incoming voice call"')
    expect(html).toContain('1m 00s')
  })
})
