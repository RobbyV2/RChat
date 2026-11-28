import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemberSearchSection } from '../../components/member_search_section'
import { P2pProvider } from '../client/p2p_react'
import { AccountProvider } from '../client/react'
import { NO_FILTERS } from '../member_filters'
import type { ServerView } from '../p2p/server'
import { P } from '../p2p/state'
import { featureAt, isUnsupported } from '../place/feature'
import { memberSearch, type SearchRow } from '../place/member_search'
import type { RChatState } from '../store_types'
import { serverDetail, user } from './fixtures'
import { placeContract, type ContractWorld } from './helpers/place_contract'

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

// Ann's side of a server or room with `count` members named m000.., and the queries asked.
const seat = (world: ContractWorld, asked: string[], count = 3) => {
  const { place, account } = world.ann
  const names = Array.from({ length: count }, (_, i) => `m${String(i).padStart(3, '0')}`)
  if (place.kind === 'hostedServer') {
    account.store.setState({
      servers: { [world.server]: serverDetail(world.server) },
      me: { ...user('ann'), servers: [{ name: world.server, is_admin: true }] },
      rememberMember: () => {},
    } as unknown as Partial<RChatState>)
    Object.assign(account.store.menu, { noteMemberTimeouts: () => {} })
    Object.assign(account.api, {
      searchMembers: async (_s: string, q: string, cursor: string | null) => {
        asked.push(q)
        const at = cursor === null ? 0 : Number(cursor)
        return {
          items: names.slice(at, at + 50).map(n => ({
            ...user(n),
            is_admin: false,
            is_creator: false,
            online: false,
            perms: 0n,
            role_ids: [],
            joined_at: 1_700_000_000,
            created_at: 1_600_000_000,
          })),
          next: at + 50 < names.length ? String(at + 50) : null,
        }
      },
      listPasswords: async () => ({ passwords: [] }),
    })
  } else if (place.kind === 'p2pRoom') {
    const view = {
      id: world.room,
      name: 'Harbor',
      me: 'join',
      perms: P.Kick,
      memberSearch: true,
      owners: [],
      roles: [],
      members: names.map(n => ({
        ik: n.toUpperCase(),
        name: n,
        m: 'join',
        roles: [],
        owner: false,
      })),
    } as unknown as ServerView
    const state = { servers: { [world.room]: view } }
    place.app.useP2p.setState(state as never)
    Object.assign(place.app.useP2p.getInitialState(), state)
  }
  Object.assign(account.store.getInitialState(), account.store.getState())
  return featureAt(memberSearch, place)
}

placeContract(memberSearch, (kind, world) => {
  if (kind === 'hostedDm' || kind === 'p2pDm') {
    test('a DM has no member search', () => {
      const here = seat(world(), [])
      expect(isUnsupported(here) && here.why).toBe('not_in_dms')
    })
    return
  }
  const hosted = kind === 'hostedServer'
  const open = (asked: string[] = [], count = 3) => {
    const here = seat(world(), asked, count)
    if (isUnsupported(here)) throw new Error(here.line)
    return here
  }

  test('the filters show where the search is open, and the members come as rows', async () => {
    const asked: string[] = []
    const here = open(asked)
    const choices = here.choices.get()
    expect(choices?.filters).toBe(true)
    expect(choices?.created).toBe(hosted)
    const found = here.search({ ...NO_FILTERS, q: 'm00' })
    const stop = found.subscribe(() => {})
    for (let i = 0; i < 40 && found.get().status !== 'ready'; i++) {
      await new Promise(r => setTimeout(r, 20))
      await flush()
    }
    const view = found.get()
    stop()
    expect(view.status).toBe('ready')
    let rows: SearchRow[] = []
    view.map(v => (rows = v.items))
    expect(rows.map(r => r.who)).toEqual(
      hosted ? ['m000', 'm001', 'm002'] : ['M000', 'M001', 'M002']
    )
    expect(rows[0].face.kind).toBe(hosted ? 'account' : 'key')
    if (hosted) expect(asked).toEqual(['q=m00'])
  })

  test('one section draws either side', () => {
    open()
    const { account, app, place } = world().ann
    const html = renderToStaticMarkup(
      <AccountProvider session={account}>
        <P2pProvider identity={app}>
          <MemberSearchSection place={place} />
        </P2pProvider>
      </AccountProvider>
    )
    expect(html).toContain('data-member-search')
  })
})
