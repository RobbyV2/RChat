import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import MemberSidebar from '../../components/member_sidebar'
import { AccountProvider } from '../client/react'
import { P2pProvider } from '../client/p2p_react'
import { P } from '../p2p/state'
import type { MemberView, ServerView } from '../p2p/server'
import { featureAt, isUnsupported } from '../place/feature'
import { members, type MemberEntry, type MemberItem } from '../place/members'
import { PlaceProvider } from '../place/react'
import type { RChatState } from '../store_types'
import type { ServerSummary } from '../types'
import { member, paged, serverDetail } from './fixtures'
import { placeContract, type ContractWorld } from './helpers/place_contract'

const peerMember = (ik: string, name: string, over: Partial<MemberView> = {}) =>
  ({
    ik,
    name,
    m: 'join',
    owner: false,
    online: false,
    contact: false,
    roles: [],
    ...over,
  }) as MemberView

interface Seeded {
  calls: unknown[][]
  bobTimeout?: number
  extra?: number
  perms?: number
}

// Ann's side of the place with Ann online and Bob offline in it.
const seat = (world: ContractWorld, o: Seeded) => {
  const { ann } = world
  const { place } = ann
  if (place.kind === 'hostedServer') {
    const sent =
      (name: string) =>
      async (...a: unknown[]) =>
        void o.calls.push([name, ...a])
    const state = {
      dms: [],
      me: {
        ...ann.account.store.getState().me!,
        servers: [{ name: world.server } as ServerSummary],
      },
      servers: { [world.server]: serverDetail(world.server, { member_count: 2, online_count: 1 }) },
      members: {
        [world.server]: {
          ...paged([member('ann', { online: true, is_creator: true }), member('bob')]),
          hasMore: true,
        },
      },
      timeouts:
        o.bobTimeout === undefined
          ? {}
          : { [world.server]: { bob: { ends: o.bobTimeout, reason: null } } },
      loadMembers: sent('loadMembers'),
      loadInteracted: sent('loadInteracted'),
      loadMissingOnline: sent('loadMissingOnline'),
      loadGroup: sent('loadGroup'),
      clearGroups: (...a: unknown[]) => void o.calls.push(['clearGroups', ...a]),
    } as unknown as Partial<RChatState>
    ann.account.store.setState(state)
    Object.assign(ann.account.store.getInitialState(), ann.account.store.getState())
  } else if (place.kind === 'p2pRoom') {
    const rest = Array.from({ length: o.extra ?? 0 }, (_, i) =>
      peerMember(`X${i}`, `Extra ${String(i).padStart(2, '0')}`)
    )
    const view = {
      id: world.room,
      me: 'join',
      perms: o.perms ?? 0,
      owner: 'A',
      owners: ['A'],
      roles: [],
      channels: [],
      members: [
        peerMember('A', 'Ann', { owner: true }),
        peerMember(
          'B',
          'Bob',
          o.bobTimeout === undefined ? {} : { timeoutUntil: o.bobTimeout, timeoutReason: 'spam' }
        ),
        ...rest,
      ],
    } as unknown as ServerView
    const state = { servers: { [world.room]: view }, server: { room: world.room, ch: null } }
    place.app.useP2p.setState(state)
    Object.assign(place.app.useP2p.getInitialState(), state, { me: 'A' })
  }
  const here = featureAt(members, place)
  if (isUnsupported(here)) throw new Error(here.line)
  return here
}

const rows = (items: MemberItem[]) => items.flatMap(i => (i.kind === 'member' ? [i.entry] : []))
const row = (items: MemberItem[], who: string) =>
  rows(items).find(e => e.who === who) as MemberEntry

placeContract(members, (kind, world) => {
  if (kind === 'hostedDm' || kind === 'p2pDm') {
    test('a DM has no member list', () => {
      const here = featureAt(members, world().ann.place)
      expect(isUnsupported(here) && here.why).toBe('not_in_dms')
    })
    return
  }
  const hosted = kind === 'hostedServer'
  const ANN = hosted ? 'ann' : 'A'
  const BOB = hosted ? 'bob' : 'B'

  test('both parties are listed under Online and Offline, each row with its menu', () => {
    const list = seat(world(), { calls: [] }).list
    const { state, items } = list.get()
    expect(state).toBe('ready')
    expect(items.flatMap(i => (i.kind === 'head' ? [i.label + (i.count ?? '')] : []))).toEqual(
      hosted ? ['Online (1)', 'Offline (1)'] : ['Online1', 'Offline1']
    )
    expect(rows(items).map(e => [e.who, e.online])).toEqual([
      [ANN, true],
      [BOB, false],
    ])
    expect(row(items, BOB).menu?.kind).toBe(hosted ? 'member' : 'p2p_member')
    expect(row(items, BOB).opens.kind).toBe(hosted ? 'profile' : 'card')
    expect(row(items, ANN).tags).toEqual([hosted ? 'creator' : 'owner'])
    expect(list.get()).toBe(list.get())
  })

  test('a timeout shows to those who may see it', () => {
    const until = Date.now() + 60_000
    const seen = seat(world(), { calls: [], bobTimeout: until, perms: P.TimeoutMembers })
    expect(row(seen.list.get().items, BOB).timeout?.ends).toBe(until)
    if (!hosted) {
      const unseen = seat(world(), { calls: [], bobTimeout: until, perms: 0 })
      expect(row(unseen.list.get().items, BOB).timeout).toBeNull()
    }
  })

  test('more rows load 50 at a time when the end shows', () => {
    const calls: unknown[][] = []
    const here = seat(world(), { calls, extra: 60 })
    const more = () => here.list.get().items.find(i => i.kind === 'more')
    expect(more()?.kind).toBe('more')
    if (hosted) {
      const end = more()
      if (end?.kind === 'more') end.load()
      expect(calls).toEqual([['loadMembers', world().server]])
      return
    }
    expect(rows(here.list.get().items)).toHaveLength(50)
    let changes = 0
    const stop = here.list.subscribe(() => (changes += 1))
    const end = more()
    if (end?.kind === 'more') end.load()
    stop()
    expect(changes).toBe(1)
    expect(rows(here.list.get().items)).toHaveLength(62)
    expect(more()).toBeUndefined()
    here.watch()()
    expect(rows(here.list.get().items)).toHaveLength(50)
  })

  test('watching loads what the list needs once', () => {
    const calls: unknown[][] = []
    const here = seat(world(), { calls })
    const stop = here.watch()
    world().ann.account.store.setState({ toast: null })
    stop()
    expect(calls).toEqual(
      hosted
        ? [
            ['loadMembers', world().server, true],
            ['loadInteracted', world().server, true],
            ['clearGroups', world().server],
          ]
        : []
    )
  })

  test('the list shows loading until the place has its members', () => {
    const here = seat(world(), { calls: [] })
    const { ann } = world()
    if (ann.place.kind === 'hostedServer') ann.account.store.setState({ members: {} })
    if (ann.place.kind === 'p2pRoom')
      ann.place.app.useP2p.setState({ servers: {}, enabled: true, loading: true })
    expect(here.list.get().state).toBe('loading')
    expect(here.list.get().items).toEqual([])
  })

  test('a server that keeps its members to members says so to a visitor', () => {
    const here = seat(world(), { calls: [] })
    const { ann } = world()
    if (ann.place.kind !== 'hostedServer') return
    const s = ann.account.store.getState()
    ann.account.store.setState({
      me: { ...s.me!, servers: [] },
      servers: { [world().server]: serverDetail(world().server, { members_visible: false }) },
    })
    expect(here.list.get().state).toBe('hidden')
  })

  test('one list component draws either side', () => {
    seat(world(), { calls: [], bobTimeout: Date.now() + 60_000, perms: P.TimeoutMembers })
    const { ann } = world()
    const html = renderToStaticMarkup(
      <AccountProvider session={ann.account}>
        <P2pProvider identity={ann.app}>
          <PlaceProvider place={ann.place}>
            <MemberSidebar />
          </PlaceProvider>
        </P2pProvider>
      </AccountProvider>
    )
    expect(html).toContain('data-members')
    expect(html).toContain(`data-member="${ANN}"`)
    expect(html).toContain(`data-member="${BOB}"`)
    expect(html).toContain('Online')
    expect(html).toContain('Timed out, ')
    expect(html).toContain(hosted ? '>Creator<' : 'aria-label="Owner"')
  })
})
