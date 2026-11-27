import { expect, test } from 'bun:test'
import { chat, accountChat, type Chat } from '../place/chat'
import { featureAt, isUnsupported } from '../place/feature'
import type { P2pMessage } from '../p2p/dm'
import type { P2pList } from '../place/place'
import type { Message } from '../types'
import { member, msg, paged, serverDetail, textChannel, user } from './fixtures'
import { placeContract, type ContractWorld, type Seat } from './helpers/place_contract'

const KEYS: Record<string, string> = { ann: 'A', bob: 'B' }

interface Calls {
  reacted: unknown[]
  picked: Message[]
}

// The chat of one party, with what its side needs to answer: the members a hosted server
// lists, or the list a P2P place is shown through.
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
  const stored = { id: 'e1', reactions: [{ key: '👍', by: ['B'] }] } as unknown as P2pMessage
  const list: P2pList = {
    me: seat.name,
    idOf: num => (num === 1 ? 'e1' : null),
    message: id => (id === 'e1' ? stored : undefined),
    user: ik => user(ik, { display_name: ik === 'A' ? 'Ann' : 'Bob' }),
    name: ik => ik,
    names: new Map(Object.entries(KEYS)),
    people: q => (q === 'b' ? [user('B')] : []),
    openPicker: m => void calls.picked.push(m),
  }
  place.app.p2pDm.react = async (id, emoji, on) => {
    calls.reacted.push([id, emoji, on])
    return null
  }
  const here = featureAt(chat, place.shownBy(list))
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
    expect(calls.picked).toEqual([m])
    const reactors = await ann.loadReactors(1, '👍')
    expect(reactors.map(u => u.username)).toEqual([hosted ? 'bob' : 'B'])
  })

  test('only a hosted place loads from the instance and searches its members there', () => {
    const ann = seated(world(), world().ann, { reacted: [], picked: [] })
    expect(ann.fetches).toBe(hosted)
    if (hosted) expect(ann.people).toBeNull()
    else expect(ann.people?.('b').map(u => u.username)).toEqual(['B'])
  })

  test('a P2P place outside its list has no chat of its own', () => {
    const here = featureAt(chat, world().ann.place)
    expect(isUnsupported(here)).toBe(!hosted)
    const own = accountChat(world().ann.account)
    expect(own).toBe(accountChat(world().ann.account))
    expect(own.fetches).toBe(true)
  })
})
