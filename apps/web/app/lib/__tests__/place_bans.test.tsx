import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { BanList } from '../../components/ban_list'
import { P2pProvider } from '../client/p2p_react'
import { AccountProvider } from '../client/react'
import type { ServerView } from '../p2p/server'
import { P } from '../p2p/state'
import { bans } from '../place/bans'
import { featureAt, isUnsupported } from '../place/feature'
import type { RChatState } from '../store_types'
import { user } from './fixtures'
import { placeContract, type ContractWorld } from './helpers/place_contract'

// Ann's side of a server or room where she may ban, with `count` people banned (the first for a
// time, with a reason), and what the side is asked recorded.
const seat = (world: ContractWorld, calls: unknown[][], count = 2) => {
  const { place } = world.ann
  const ends = Date.now() + 3_600_000
  const names = Array.from({ length: count }, (_, i) => `ban${String(i).padStart(3, '0')}`)
  if (place.kind === 'hostedServer') {
    const list = names.map((n, i) => ({
      ...user(n),
      banned_at: 1_700_000_000,
      expires_at: i === 0 ? ends / 1000 : null,
      reason: i === 0 ? 'spam' : null,
    }))
    const state = {
      bans: { [world.server]: { list, hasMore: false, loading: false } },
      loadBans: async (...a: unknown[]) => void calls.push(['load', ...a]),
      unbanMember: async (...a: unknown[]) => void calls.push(['unban', ...a]),
    } as unknown as Partial<RChatState>
    world.ann.account.store.setState(state)
    Object.assign(world.ann.account.store.getInitialState(), world.ann.account.store.getState())
  } else if (place.kind === 'p2pRoom') {
    const members = names.map((n, i) => ({
      ik: n.toUpperCase(),
      name: n,
      m: 'ban',
      owner: false,
      roles: [],
      unban: true,
      ...(i === 0 ? { banUntil: ends, banReason: 'spam' } : {}),
    }))
    const view = {
      id: world.room,
      name: 'Harbor',
      me: 'join',
      perms: P.Ban,
      roles: [],
      members: [{ ik: 'A', name: 'Ann', m: 'join', roles: [] }, ...members],
    } as unknown as ServerView
    const state = { servers: { [world.room]: view } }
    place.app.useP2p.setState(state as never)
    Object.assign(place.app.useP2p.getInitialState(), state)
    Object.assign(place.app.p2pServer, {
      unban: async (...a: unknown[]) => void calls.push(['unban', ...a]),
    })
  }
  return featureAt(bans, place)
}

placeContract(bans, (kind, world) => {
  if (kind === 'hostedDm' || kind === 'p2pDm') {
    test('a DM has no bans', () => {
      const here = seat(world(), [])
      expect(isUnsupported(here) && here.why).toBe('not_in_dms')
    })
    return
  }
  const hosted = kind === 'hostedServer'
  const open = (calls: unknown[][] = [], count = 2) => {
    const here = seat(world(), calls, count)
    if (isUnsupported(here)) throw new Error(here.line)
    return here
  }

  test('the banned are listed with when their ban ends and why, and can be unbanned', () => {
    const calls: unknown[][] = []
    const here = open(calls)
    const state = here.state.get()
    expect(here.state.get()).toBe(state)
    expect(state.ready).toBe(true)
    expect(state.entries.map(e => e.reason)).toEqual(['spam', null])
    expect(state.entries[0].ends).not.toBeNull()
    expect(state.entries[1].ends).toBeNull()
    expect(state.timed).toBe(true)
    expect(state.note === null).toBe(hosted)
    const who = state.entries[0].who
    here.unban(who)
    expect(calls.at(-1)).toEqual(
      hosted ? ['unban', world().server, who] : ['unban', world().room, who]
    )
  })

  test('the list comes 50 at a time', () => {
    const calls: unknown[][] = []
    const here = open(calls, hosted ? 2 : 60)
    if (hosted) {
      here.watch()
      here.more()
      expect(calls).toEqual([
        ['load', world().server, true],
        ['load', world().server],
      ])
      return
    }
    expect(here.state.get().entries).toHaveLength(50)
    expect(here.state.get().more).toBe(true)
    here.more()
    expect(here.state.get().entries).toHaveLength(60)
    expect(here.state.get().more).toBe(false)
  })

  test('one list draws the bans of either side', () => {
    open()
    const { account, app, place } = world().ann
    const html = renderToStaticMarkup(
      <AccountProvider session={account}>
        <P2pProvider identity={app}>
          <BanList place={place} />
        </P2pProvider>
      </AccountProvider>
    )
    expect(html).toContain('data-bans')
    expect(html).toContain('ban000')
    expect(html).toContain('Ban ends')
    expect(html).toContain('spam')
    expect(html.match(/>Unban</g)).toHaveLength(2)
  })
})
