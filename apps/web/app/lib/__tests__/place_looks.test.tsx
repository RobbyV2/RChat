import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AuthorRow } from '../../components/message_row'
import { AccountProvider } from '../client/react'
import { P2pProvider } from '../client/p2p_react'
import { nameText } from '../names'
import type { P2pMessage } from '../p2p/dm'
import type { ServerView } from '../p2p/server'
import { featureAt, isUnsupported } from '../place/feature'
import { accountLooks, looks, type Looks } from '../place/looks'
import { HostedServer } from '../place/place'
import { PlaceProvider } from '../place/react'
import { useAuthor, useServerLooks } from '../place/use_looks'
import type { Message } from '../types'
import { member, msg, paged, serverDetail, user } from './fixtures'
import { placeContract, type ContractWorld } from './helpers/place_contract'
import { testAccount } from './test_account'

// Ann's side with a message from Bob, who holds a colored role where the place has roles.
const seat = (world: ContractWorld) => {
  const { place } = world.ann
  let m: Message
  let event: string | undefined
  if (place.kind === 'hostedServer' || place.kind === 'hostedDm') {
    const role = {
      id: 4,
      name: 'Mods',
      color: '#ff0000',
      position: 1,
      hoist: false,
      permissions: 0,
    }
    world.ann.account.store.setState({
      servers: { [world.server]: serverDetail(world.server, { roles: [role] as never }) },
      members: { [world.server]: paged([member('ann'), { ...member('bob'), role_ids: [4] }]) },
    })
    m = msg(5, { author: user('bob') })
  } else {
    const p = { id: 'e5', sender: 'B', ts: 5_000, body: 'hi', att: [], reactions: [] }
    const view = {
      id: world.room,
      owner: 'A',
      owners: [],
      members: [{ ik: 'B', name: 'Bob', roles: ['r4'] }],
      roles: [
        { id: 'r4', name: 'Mods', color: 0xff0000, pos: 1, icon: null, tint: true, dpos: null },
      ],
      memberList: { hide: false, roles: null, channels: [] },
    } as unknown as ServerView
    const state = {
      me: 'A',
      servers: place.kind === 'p2pRoom' ? { [world.room]: view } : {},
      chat: {
        room: world.room,
        ch: place.kind === 'p2pRoom' ? 'c1' : null,
        peer: place.kind === 'p2pDm' ? 'B' : '',
        messages: [p as unknown as P2pMessage],
        more: false,
        loading: false,
        readSeq: 0,
        missed: [],
      },
    }
    place.app.useP2p.setState(state as never)
    Object.assign(place.app.useP2p.getInitialState(), state)
    m = msg(5, { author: { ...user('Bob'), display_name: 'Bob' } })
    event = 'e5'
  }
  const here = featureAt(looks, place)
  if (isUnsupported(here)) throw new Error(here.line)
  return { here, m, event }
}

function Row({ m, event }: { m: Message; event?: string }) {
  return (
    <AuthorRow face={useAuthor(m, event)} size={36} meta={null}>
      hi
    </AuthorRow>
  )
}

placeContract(looks, (kind, world) => {
  const hosted = kind === 'hostedServer' || kind === 'hostedDm'

  test('an author is an account on a hosted side and a key on a P2P one', () => {
    const { here, m, event } = seat(world())
    const face = here.author(m, event)
    const now = face.get()
    expect(face.get()).toBe(now)
    expect(now.who.kind).toBe(hosted ? 'account' : 'key')
    expect(now.who.person.username).toBe(hosted ? 'bob' : 'B')
    expect(nameText(now.name).toLowerCase()).toContain('bob')
  })

  test('roles color a name only where the place has roles', () => {
    const { here, m, event } = seat(world())
    const colored = kind === 'hostedServer' || kind === 'p2pRoom'
    expect(here.author(m, event).get().color !== undefined).toBe(colored)
    if (kind === 'hostedServer') expect(here.color(user('bob')).get()).not.toBeUndefined()
    expect(here.color(user('nobody')).get()).toBeUndefined()
  })

  test('the people a list shows are loaded where the place keeps members, and again once dropped', () => {
    seat(world())
    const { ann, server } = world()
    const asked: unknown[][] = []
    ann.account.store.setState({
      ensureMembers: async (...a: unknown[]) => void asked.push(a),
    } as never)
    const here = featureAt(looks, ann.place)
    if (isUnsupported(here)) throw new Error(here.line)
    const stop = here.load(['bob', 'cy'])
    expect(asked).toEqual(kind === 'hostedServer' ? [[server, ['bob', 'cy']]] : [])
    ann.account.store.setState(s => ({ memberInfoTrim: { ...s.memberInfoTrim, [server]: 1 } }))
    expect(asked).toHaveLength(kind === 'hostedServer' ? 2 : 0)
    stop()
    ann.account.store.setState(s => ({ memberInfoTrim: { ...s.memberInfoTrim, [server]: 2 } }))
    expect(asked).toHaveLength(kind === 'hostedServer' ? 2 : 0)
    expect(typeof here.load([])).toBe('function')
  })

  test('one row draws either author, and only an account opens a profile', () => {
    const { m, event } = seat(world())
    const { ann } = world()
    const html = renderToStaticMarkup(
      <AccountProvider session={ann.account}>
        <P2pProvider identity={ann.app}>
          <PlaceProvider place={ann.place}>
            <Row m={m} event={event} />
          </PlaceProvider>
        </P2pProvider>
      </AccountProvider>
    )
    expect(html.toLowerCase()).toContain('bob')
    expect(html.includes('View profile')).toBe(hosted)
  })
})

test('a server named outside the place around loads through that server, none through the account', () => {
  const account = testAccount('ann')
  const seen: Looks[] = []
  function Probe({ server }: { server: string | null }) {
    seen.push(useServerLooks(server))
    return null
  }
  for (const server of ['harbor', null])
    renderToStaticMarkup(
      <AccountProvider session={account}>
        <Probe server={server} />
      </AccountProvider>
    )
  expect(seen[0]).toBe(featureAt(looks, HostedServer.open(account, 'harbor')) as Looks)
  expect(seen[1]).toBe(accountLooks(account))
})

test('a server profile picture shows on a face, and the look reads through the feature', () => {
  const account = testAccount('ann')
  const profile = {
    name: 'Annie',
    avatar_kind: 'image',
    avatar_color: null,
    avatar_image: 'pic.webp',
  }
  const settings = account.store.getState().settings
  account.store.setState({
    settings: { ...settings, server_profiles: true, display_names: true },
    servers: { harbor: serverDetail('harbor') },
    memberInfo: { harbor: { bob: member('bob', { profile } as never) } },
  } as never)
  const here = featureAt(looks, HostedServer.open(account, 'harbor')) as Looks
  const face = here.of(user('bob')).get()
  expect(face.who.person.avatar_image).toBe('pic.webp')
  expect(nameText(face.name)).toContain('Annie')
  expect(here.look('bob').get()?.avatar_image).toBe('pic.webp')
  expect(here.look('bob').get()).toEqual(here.look('bob').get())
  expect(accountLooks(account).look('bob').get()).toBeNull()
})
