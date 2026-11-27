import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AccountProvider } from '../client/react'
import { CAN_ALL } from '../channel_perms'
import { maskOr } from '../perms'
import type { ServerView } from '../p2p/server'
import { featureAt, isUnsupported } from '../place/feature'
import { channelCanIn, rights, type ChannelKey } from '../place/rights'
import { useChannelCan } from '../place/use_rights'
import { ChannelPermBit, type ServerSummary } from '../types'
import { serverDetail, textChannel } from './fixtures'
import { placeContract, type ContractWorld, type Seat } from './helpers/place_contract'

const mask = (...bits: number[]) => bits.reduce((all, bit) => maskOr(all, bit), 0)
const READ = mask(ChannelPermBit.ViewChannels, ChannelPermBit.ReadHistory)
const WRITE = mask(READ, ChannelPermBit.SendMessages)
const TALK = mask(WRITE, ChannelPermBit.AddReactions, ChannelPermBit.StartThreads)

// Gives a party `held` in the channel of their place, and answers the key of that channel.
const hold = (world: ContractWorld, seat: Seat, held: number, joined = true): ChannelKey => {
  const { place } = seat
  if (place.kind === 'hostedServer') {
    const me = seat.account.store.getState().me!
    const servers = joined ? [{ name: world.server } as ServerSummary] : []
    const state = {
      me: { ...me, servers },
      servers: {
        [world.server]: serverDetail(world.server, {
          channels: [{ ...textChannel(1), my_perms: held }],
        }),
      },
    }
    seat.account.store.setState(state)
    Object.assign(seat.account.store.getInitialState(), state)
    return 1
  }
  if (place.kind === 'p2pRoom') {
    const view = {
      id: world.room,
      me: joined ? 'join' : 'leave',
      members: [],
      channels: [{ id: 'c1', perms: held }],
    }
    const state = { servers: { [world.room]: view as unknown as ServerView } }
    place.app.useP2p.setState(state)
    Object.assign(place.app.useP2p.getInitialState(), state)
    return 'c1'
  }
  return place.kind === 'hostedDm' ? 1 : 'c1'
}

const rightsOf = (seat: Seat) => {
  const here = featureAt(rights, seat.place)
  if (isUnsupported(here)) throw new Error(here.line)
  return here
}

placeContract(rights, (kind, world) => {
  if (kind === 'hostedDm' || kind === 'p2pDm') {
    test('a DM holds nothing back', () => {
      const { ann } = world()
      expect(
        rightsOf(ann)
          .can(hold(world(), ann, 0))
          .get()
      ).toBe(CAN_ALL)
    })
    return
  }

  test('each party holds what the place gives them in the channel', () => {
    const { ann, bob } = world()
    const mine = rightsOf(ann)
      .can(hold(world(), ann, TALK))
      .get()
    const theirs = rightsOf(bob)
      .can(hold(world(), bob, READ))
      .get()
    expect([mine.send, mine.react, mine.threads, mine.pin, mine.attach]).toEqual([
      true,
      true,
      true,
      false,
      false,
    ])
    expect([theirs.send, theirs.react, theirs.threads]).toEqual([false, false, false])
  })

  test('without View nothing is held, whatever else is set', () => {
    const { ann } = world()
    const channel = hold(world(), ann, ChannelPermBit.SendMessages)
    expect(rightsOf(ann).can(channel).get().send).toBe(false)
  })

  test('the answer follows the place and keeps its identity in between', () => {
    const { ann } = world()
    const live = rightsOf(ann).can(hold(world(), ann, READ))
    const before = live.get()
    expect(before.send).toBe(false)
    expect(live.get()).toBe(before)
    let changes = 0
    const stop = live.subscribe(() => (changes += 1))
    hold(world(), ann, WRITE)
    stop()
    expect(changes).toBeGreaterThan(0)
    expect(live.get().send).toBe(true)
  })

  test('a room you are not in holds everything back; a hosted server reads its marks', () => {
    const { ann } = world()
    const channel = hold(world(), ann, TALK, false)
    const held = rightsOf(ann).can(channel).get()
    if (kind === 'p2pRoom')
      expect([held.send, held.react, held.connect]).toEqual([false, false, false])
    else expect(held.send).toBe(true)
  })

  test('a channel that is not loaded holds nothing back in a room', () => {
    const { ann } = world()
    hold(world(), ann, READ)
    const other = rightsOf(ann)
      .can(kind === 'p2pRoom' ? 'missing' : 99)
      .get()
    if (kind === 'p2pRoom') expect(other).toBe(CAN_ALL)
    else expect(other.send).toBe(true)
  })

  test('a component reads what you hold, and everything without a place or a channel', () => {
    const { ann } = world()
    const channel = hold(world(), ann, READ)
    function Held({ channel }: { channel: ChannelKey | null }) {
      const can = useChannelCan(channel === null ? null : ann.place, channel)
      return <b>{String(can.send)}</b>
    }
    const render = (ch: ChannelKey | null) =>
      renderToStaticMarkup(
        <AccountProvider session={ann.account}>
          <Held channel={ch} />
        </AccountProvider>
      )
    expect(render(channel)).toBe('<b>false</b>')
    expect(render(null)).toBe('<b>true</b>')
    expect(channelCanIn(ann.place, null).get()).toBe(CAN_ALL)
    expect(channelCanIn(null, channel).get()).toBe(CAN_ALL)
  })
})
