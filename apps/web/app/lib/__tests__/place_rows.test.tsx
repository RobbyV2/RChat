import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ListedRow } from '../../components/listed_row'
import { AccountProvider } from '../client/react'
import { P2pProvider } from '../client/p2p_react'
import type { P2pMessage } from '../p2p/dm'
import type { ComposerList } from '../place/composer'
import { featureAt, isUnsupported } from '../place/feature'
import { P2pDm, P2pRoom } from '../place/place'
import { PlaceProvider } from '../place/react'
import { rows } from '../place/rows'
import { shownOf } from '../place/shown'
import type { RChatState } from '../store_types'
import type { Message } from '../types'
import type { View } from '../view'
import { msg, user } from './fixtures'
import { NO_HANDLERS } from './helpers/peer_row'
import { placeContract, type ContractWorld } from './helpers/place_contract'

const said = (id: string, sender: string, over: Partial<P2pMessage> = {}) =>
  ({
    id,
    sender,
    ts: 5_000,
    sentTs: 5_000,
    body: 'who brings the map',
    att: [],
    reactions: [],
    mentions: [],
    edited: null,
    ...over,
  }) as P2pMessage

// Ann's side as a member who may write, with her own message and one of Bob's that mentions her
// in the conversation, and a thread open on Bob's with one reply of hers. Gives the rows of
// `list` and the two messages as the list shows them.
const seat = (world: ContractWorld, list: ComposerList) => {
  const { place, account } = world.ann
  let own: Message
  let theirs: Message
  if (place.kind === 'hostedServer' || place.kind === 'hostedDm') {
    const inServer = place.kind === 'hostedServer'
    const view: View = inServer
      ? { kind: 'channel', server: world.server, channelId: 1 }
      : { kind: 'dm', dmId: world.dmId }
    const at = { channel_id: inServer ? 1 : null, dm_id: inServer ? null : world.dmId }
    theirs = msg(5, { author: user('bob'), content: '@ann who brings the map', ...at })
    own = msg(list === 'main' ? 6 : 7, { author: user('ann'), ...at })
    const state = {
      view,
      guest: false,
      me: { ...user('ann'), servers: [{ name: world.server }] },
      servers: {
        [world.server]: {
          channels: [{ id: 1, name: 'deck', my_perms: 2n ** 40n - 1n }],
          roles: [],
        },
      },
      panel: { kind: 'thread', root: theirs },
    } as unknown as Partial<RChatState>
    account.store.setState(state)
    Object.assign(account.store.getInitialState(), account.store.getState())
  } else {
    const ch = place.kind === 'p2pRoom' ? 'c1' : null
    const head = said('e5', 'B', { mentions: ['A'], replies: 1 })
    const mine = said(list === 'main' ? 'e6' : 'e7', 'A')
    const state = {
      me: 'A',
      reader: false,
      elsewhere: false,
      status: 'ready',
      movedAt: null,
      movingAt: null,
      contacts: [{ ik: 'B', name: 'Bob', state: 'mutual' }],
      rooms: { [world.room]: { peer: 'B', full: false } },
      chat: {
        room: world.room,
        ch,
        peer: place.kind === 'p2pDm' ? 'B' : '',
        messages: [head, said('e6', 'A')],
        more: false,
        loading: false,
        readSeq: 0,
        missed: [],
      },
      thread: {
        room: world.room,
        ch,
        root: 'e5',
        head,
        messages: [said('e7', 'A')],
        more: false,
        loading: false,
      },
      ...(place.kind === 'p2pRoom'
        ? {
            servers: {
              [world.room]: {
                id: world.room,
                me: 'join',
                members: [
                  { ik: 'A', name: 'Ann', m: 'join' },
                  { ik: 'B', name: 'Bob', m: 'join' },
                ],
                memberList: { hide: false, roles: null, channels: [] },
                channels: [{ id: 'c1', name: 'deck', kind: 'text', perms: 2n ** 31n - 1n }],
                owners: [],
                owner: null,
              },
            },
          }
        : {}),
    }
    place.app.useP2p.setState(state as never)
    Object.assign(place.app.useP2p.getInitialState(), place.app.useP2p.getState())
    const here =
      place.kind === 'p2pRoom'
        ? P2pRoom.open(place.app, world.room, list)
        : P2pDm.open(place.app, world.room, list)
    const shown = shownOf(here).get()
    const row = (id: string) => {
      const found = shown.rows.find(r => r.p.id === id)
      if (!found) throw new Error(`no row ${id}`)
      return found.m
    }
    theirs = row('e5')
    own = row(mine.id)
  }
  const here = featureAt(rows, place)
  if (isUnsupported(here)) throw new Error(here.line)
  return { rows: here.at(list), own, theirs }
}

placeContract(rows, (kind, world) => {
  const hosted = kind === 'hostedServer' || kind === 'hostedDm'
  const free = { timedOut: false }

  test('your own row can be edited and deleted, someone else’s answered and reacted to', () => {
    const { rows, own, theirs } = seat(world(), 'main')
    const state = rows.get()
    expect(rows.get()).toBe(state)
    expect(state.acts).toBe(true)
    expect(state.until).toBeNull()
    expect(state.of(own, free)).toMatchObject({
      canEdit: true,
      canDelete: true,
      canReact: true,
      mentioned: false,
      server: kind === 'hostedServer' ? world().server : null,
    })
    expect(state.of(theirs, free)).toMatchObject({
      canEdit: false,
      canReply: true,
      canReact: true,
      mentioned: true,
    })
    expect(state.of(own, free).local === true).toBe(!hosted)
    expect(state.of(own, free).sent).toBe(hosted ? undefined : 'delivered')
  })

  test('a row of the conversation can start a thread, a row of a thread cannot', () => {
    const main = seat(world(), 'main')
    expect(main.rows.get().of(main.theirs, free).thread).not.toBeNull()
    expect(main.rows.get().of(main.theirs, free).chip).toBe(true)
    const thread = seat(world(), 'thread')
    const flags = thread.rows.get()
    expect(flags.of(thread.own, free).thread).toBeNull()
    expect(flags.of(thread.own, free).canDelete).toBe(true)
    expect(flags.of(thread.theirs, { timedOut: false, root: true }).canDelete).toBe(false)
  })

  test('the conversation takes pins from who may pin there, a thread from nobody', () => {
    const main = seat(world(), 'main')
    expect(main.rows.get().pins).toBe(true)
    expect(main.rows.get().of(main.theirs, free).canPin).toBe(true)
    if (kind === 'hostedServer' || kind === 'p2pRoom')
      expect(main.rows.get().of(main.theirs, { timedOut: true }).canPin).toBe(false)
    const thread = seat(world(), 'thread')
    expect(thread.rows.get().pins).toBe(false)
    expect(thread.rows.get().of(thread.own, free).canPin).toBe(false)
  })

  test('a timeout leaves your own row its delete and nothing else', () => {
    const { rows, own, theirs } = seat(world(), 'main')
    const timed = { timedOut: true }
    const flags = rows.get().of(own, timed)
    if (kind === 'hostedServer' || kind === 'p2pRoom') {
      expect(flags).toMatchObject({ canEdit: false, canReact: false, canDelete: true })
      expect(rows.get().of(theirs, timed).canReply).toBe(false)
    } else expect(rows.get().until).toBeNull()
  })

  test('one row draws the flags of either side', () => {
    const { rows, own } = seat(world(), 'main')
    const { account, app, place } = world().ann
    const html = renderToStaticMarkup(
      <AccountProvider session={account}>
        <P2pProvider identity={app}>
          <PlaceProvider place={place}>
            <ListedRow
              m={own}
              first
              last
              divider={false}
              flash={false}
              editing={false}
              {...rows.get().of(own, free)}
              on={NO_HANDLERS}
            />
          </PlaceProvider>
        </P2pProvider>
      </AccountProvider>
    )
    expect(html).toContain('aria-label="Edit"')
    expect(html).toContain('aria-label="Reply"')
  })
})
