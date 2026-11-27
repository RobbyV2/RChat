import { afterEach, beforeEach, describe } from 'bun:test'
import type { AccountSession } from '../../client/session'
import type { P2pApp } from '../../p2p/app/runtime'
import type { Feature } from '../../place/feature'
import {
  HostedDm,
  HostedServer,
  P2pDm,
  P2pRoom,
  type Place,
  type PlaceKind,
} from '../../place/place'
import { serverDetail, user } from '../fixtures'
import { createPeerFixture } from '../peer_fixture'
import { testAccount } from '../test_account'

export const PLACE_KINDS: PlaceKind[] = ['hostedServer', 'p2pRoom', 'hostedDm', 'p2pDm']

// One party of a contract world: who they are in the place, and the place as they hold it.
export interface Seat {
  // The name the place knows them by: a username on the hosted side, an identity key on P2P.
  name: string
  account: AccountSession
  app: P2pApp | null
  place: Place
}

// The same place seen by two parties. `server` and `dmId` name it on the hosted side, `room` on
// the P2P side.
export interface ContractWorld {
  kind: PlaceKind
  ann: Seat
  bob: Seat
  server: string
  dmId: number
  room: string
}

const SERVER = 'harbor'
const DM = 7
const ROOM = 'room'

const hostedSeat = (kind: 'hostedServer' | 'hostedDm', name: string, other: string): Seat => {
  const account = testAccount(name)
  account.store.setState({
    servers: { [SERVER]: serverDetail(SERVER) },
    dms: [{ id: DM, other: user(other), last_message_at: null }] as never,
  })
  const place =
    kind === 'hostedServer' ? HostedServer.open(account, SERVER) : HostedDm.open(account, DM)
  return { name, account, app: null, place }
}

const peerSeat = (kind: 'p2pRoom' | 'p2pDm', username: string, ik: string): Seat => {
  const account = testAccount(username)
  const app = createPeerFixture(account, username)
  app.useP2p.setState({ me: ik })
  const place = kind === 'p2pRoom' ? P2pRoom.open(app, ROOM) : P2pDm.open(app, ROOM)
  return { name: ik, account, app, place }
}

export const contractWorld = (kind: PlaceKind): ContractWorld => {
  const [ann, bob] =
    kind === 'hostedServer' || kind === 'hostedDm'
      ? [hostedSeat(kind, 'ann', 'bob'), hostedSeat(kind, 'bob', 'ann')]
      : [peerSeat(kind, 'ann', 'A'), peerSeat(kind, 'bob', 'B')]
  return { kind, ann, bob, server: SERVER, dmId: DM, room: ROOM }
}

export const disposeWorld = (world: ContractWorld) => {
  world.ann.account.store.dispose()
  world.bob.account.store.dispose()
}

// Runs one suite against every side of `feature`: a hosted server, a P2P room, a hosted DM and a
// P2P DM, each with two parties. The suite reads the world of the running test from `world()`.
export function placeContract<F>(
  feature: Feature<F>,
  suite: (kind: PlaceKind, world: () => ContractWorld) => void
) {
  for (const kind of PLACE_KINDS)
    describe(`${feature.name} in ${kind}`, () => {
      let world: ContractWorld | null = null
      beforeEach(() => {
        world = contractWorld(kind)
      })
      afterEach(() => {
        if (world) disposeWorld(world)
        world = null
      })
      suite(kind, () => world as ContractWorld)
    })
}
