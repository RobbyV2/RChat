import { expect, test } from 'bun:test'
import { chat, accountChat, type Chat } from '../place/chat'
import { featureAt, isUnsupported } from '../place/feature'
import type { P2pMessage } from '../p2p/dm'
import type { Contact } from '../p2p/contacts'
import { isHosted } from '../place/place'
import { reactPickOf } from '../place/shown'
import type { Message } from '../types'
import { member, msg, paged, serverDetail, textChannel, user } from './fixtures'
import { placeContract, type ContractWorld, type Seat } from './helpers/place_contract'
import { testClock } from './helpers/test_clock'
import { flush } from '../clock'
import { SUGGEST_DEBOUNCE } from '../mention_suggest'

interface Calls {
  reacted: unknown[]
  picked: Message[]
}

// The chat of one party, with what its side needs to answer: the members a hosted server
// lists, or the conversation a P2P place has open.
const seated = (world: ContractWorld, seat: Seat, calls: Calls): Chat => {
  const { place } = seat
  if (place.kind === 'hostedServer' || place.kind === 'hostedDm') {
    seat.account.store.setState({
      servers: { [world.server]: serverDetail(world.server, { channels: [textChannel(1)] }) },
      members: { [world.server]: paged([member('ann'), member('bob')]) },
      toggleReaction: (m, emoji, note) => void calls.reacted.push([m.id, emoji, note]),
      loadReactors: async () => [user('bob')],
      openReactPicker: m => void calls.picked.push(m),
    })
    const here = featureAt(chat, place)
    if (isUnsupported(here)) throw new Error(here.line)
    return here
  }
  const { app } = place
  const row = (id: string, ts: number, by: string[]): P2pMessage =>
    ({
      id,
      sender: 'B',
      ts,
      body: id,
      reply: null,
      fwd: null,
      att: [],
      edited: null,
      pinned: null,
      reactions: by.length ? [{ key: '👍', count: by.length, me: false, first: ts, by }] : [],
    }) as unknown as P2pMessage
  const messages = [row('e1', 0, ['B'])]
  const contact = (ik: string, name: string) =>
    ({ ik, name, petname: null, state: 'mutual' }) as unknown as Contact
  const other = seat.name === 'A' ? contact('B', 'Bob') : contact('A', 'Ann')
  app.useP2p.setState({
    me: seat.name,
    name: seat.name === 'A' ? 'Ann' : 'Bob',
    contacts: [other],
    chat: {
      room: place.room,
      peer: place.kind === 'p2pDm' ? other.ik : '',
      ...(place.kind === 'p2pRoom' ? { ch: 'c1' } : {}),
      messages,
      more: false,
      loading: false,
      readSeq: 0,
      missed: [],
    },
  })
  if (place.kind === 'p2pRoom') {
    const member = (ik: string, name: string) => ({ ik, name, m: 'join' })
    app.useP2p.setState(s => ({
      servers: {
        ...s.servers,
        [place.room]: {
          ...s.servers[place.room],
          id: place.room,
          members: [member('A', 'Ann'), member('B', 'Bob')],
        } as unknown as (typeof s.servers)[string],
      },
    }))
  }
  place.app.p2pDm.react = async (id, emoji, on) => {
    calls.reacted.push([id, emoji, on])
    return null
  }
  const here = featureAt(chat, place)
  if (isUnsupported(here)) throw new Error(here.line)
  return here
}

placeContract(chat, (kind, world) => {
  const hosted = kind === 'hostedServer' || kind === 'hostedDm'
  const message = () =>
    kind === 'hostedDm' ? msg(1, { channel_id: null, dm_id: world().dmId }) : msg(1)

  test('each party is itself and sees the other as someone else', () => {
    const calls = { reacted: [], picked: [] }
    const ann = seated(world(), world().ann, calls)
    const bob = seated(world(), world().bob, calls)
    expect(ann.self.get()).toBe(world().ann.name)
    expect(bob.self.get()).toBe(world().bob.name)
    expect(ann.mention('ann').get().mine).toBe(true)
    expect(ann.mention('bob').get().mine).toBe(false)
    expect(bob.mention('bob').get().mine).toBe(true)
    expect(ann.mention('bob').get().user.username).toBe(hosted ? 'bob' : 'B')
    const pill = ann.mention('bob')
    expect(pill.get()).toBe(pill.get())
  })

  test('the people of the place are the mentions it knows', () => {
    const ann = seated(world(), world().ann, { reacted: [], picked: [] })
    expect(ann.known(message(), ['ann', 'bob', 'nobody']).get()).toBe('ann\nbob')
    expect(ann.known(message(), []).get()).toBe('')
  })

  test('a pill opens a member card only where the place has them', () => {
    const ann = seated(world(), world().ann, { reacted: [], picked: [] })
    const { card, label } = ann.mention('bob').get()
    if (kind === 'hostedServer') expect(card).toEqual({ server: world().server })
    else if (kind === 'hostedDm') expect(card).toEqual({ server: null })
    else expect(card).toBeNull()
    expect(label).toBe(hosted ? 'bob' : 'Bob')
  })

  test('reactions go to the side of the place', async () => {
    const calls: Calls = { reacted: [], picked: [] }
    const ann = seated(world(), world().ann, calls)
    const m = message()
    ann.toggleReaction(m, '👍', false)
    expect(calls.reacted).toEqual([hosted ? [1, '👍', false] : ['e1', '👍', true]])
    ann.openReactPicker(m, null)
    const { place } = world().ann
    const picked = isHosted(place) ? calls.picked : [reactPickOf(place).get()?.m]
    expect(picked).toEqual([m])
    const reactors = await ann.loadReactors(1, '👍')
    expect(reactors.map(u => u.username)).toEqual([hosted ? 'bob' : 'B'])
  })

  test('only a hosted place loads what its messages show from the instance', () => {
    const ann = seated(world(), world().ann, { reacted: [], picked: [] })
    expect(ann.fetches).toBe(hosted)
  })

  test('a mention finds the people of the place, in one list at a time', () => {
    const ann = seated(world(), world().ann, { reacted: [], picked: [] })
    const people = ann.people('main')
    expect(ann.people('main')).toBe(people)
    const find = people.find.get()
    expect(people.find.get()).toBe(find)
    expect(find('b').map(u => u.username)).toEqual([hosted ? 'bob' : 'Bob'])
    expect(people.groups.get()('every')).toEqual([])
  })

  test('typing asks a hosted server for members it does not hold, after a pause', async () => {
    const clock = testClock()
    const { ann: seat, server } = world()
    const asked: unknown[][] = []
    Object.assign(seat.account.api, {
      suggestMembers: async (...a: unknown[]) => {
        asked.push(a)
        return [user('bobbin')]
      },
    })
    const people = seated(world(), seat, { reacted: [], picked: [] }).people('main')
    let changes = 0
    const off = people.find.subscribe(() => void (changes += 1))
    const before = people.find.get()
    people.ask('bo')
    people.ask('bob')
    clock.advance(SUGGEST_DEBOUNCE)
    await flush()
    off()
    people.ask(null)
    if (world().kind !== 'hostedServer') {
      expect(asked).toEqual([])
      expect(people.find.get()).toBe(before)
      return
    }
    expect(asked).toEqual([[server, 'bob']])
    expect(changes).toBeGreaterThan(0)
    const found = people.find.get()('bob')
    expect(found.map(u => u.username)).toEqual(['bobbin', 'bob'])
  })

  test('outside any place the account has its own hosted chat', () => {
    const own = accountChat(world().ann.account)
    expect(own).toBe(accountChat(world().ann.account))
    expect(own.fetches).toBe(true)
  })
})
