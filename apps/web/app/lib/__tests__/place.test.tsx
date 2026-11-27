import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createStore } from 'zustand/vanilla'
import { AccountProvider } from '../client/react'
import { defineFeature, featureAt, isUnsupported, notInDms, unsupported } from '../place/feature'
import { constant, derived, fromStore } from '../place/live'
import { HostedDm, HostedServer, inDm, isHosted, P2pRoom } from '../place/place'
import { PlaceProvider, useFeature, useLive, usePlace } from '../place/react'
import { contractWorld, placeContract, PLACE_KINDS } from './helpers/place_contract'
import type { View } from '../view'
import { testAccount } from './test_account'

const where = defineFeature<{ side: string; key: string }>('where', {
  hostedServer: p => ({ side: 'hosted', key: p.server }),
  p2pRoom: p => ({ side: 'p2p', key: p.room }),
  hostedDm: () => notInDms(),
  p2pDm: () => unsupported('Not on this device'),
})

placeContract(where, (kind, world) => {
  test('the side of the place answers', () => {
    const { ann, bob, server, room } = world()
    const mine = featureAt(where, ann.place)
    expect(ann.place.kind).toBe(kind)
    expect(bob.place.kind).toBe(kind)
    expect(ann.place).not.toBe(bob.place)
    if (kind === 'hostedServer') expect(mine).toEqual({ side: 'hosted', key: server })
    else if (kind === 'p2pRoom') expect(mine).toEqual({ side: 'p2p', key: room })
    else if (kind === 'hostedDm')
      expect(isUnsupported(mine) && mine.why === 'not_in_dms' && mine.line).toBe(
        'Not available in direct messages'
      )
    else expect(isUnsupported(mine) && mine.line).toBe('Not on this device')
  })

  test('a feature is built once for a place', () => {
    const { ann } = world()
    expect(featureAt(where, ann.place)).toBe(featureAt(where, ann.place))
  })
})

test('a place opens to one handle per account and id', () => {
  const account = testAccount('ann')
  const other = testAccount('bob')
  const a = HostedServer.open(account, 'harbor')
  expect(HostedServer.open(account, 'harbor')).toBe(a)
  expect(HostedServer.open(account, 'pier')).not.toBe(a)
  expect(HostedServer.open(other, 'harbor')).not.toBe(a)
  expect(a.id).toBe(HostedServer.open(other, 'harbor').id)
  expect(HostedDm.open(account, 3).id).not.toBe(HostedDm.open(account, 4).id)
  expect(isHosted(a) && !inDm(a)).toBe(true)
  expect(inDm(HostedDm.open(account, 3))).toBe(true)
})

test('the kinds of a place tell rooms and DMs apart', () => {
  for (const kind of PLACE_KINDS) {
    const world = contractWorld(kind)
    expect(inDm(world.ann.place)).toBe(kind === 'hostedDm' || kind === 'p2pDm')
    expect(isHosted(world.ann.place)).toBe(kind === 'hostedServer' || kind === 'hostedDm')
    expect(world.ann.place.account).toBe(world.ann.account)
  }
})

test('no place has no feature', () => {
  const none = featureAt(where, null)
  expect(isUnsupported(none) && none.why).toBe('no_place')
})

function Shown() {
  const place = usePlace()
  const here = useFeature(where)
  return <p>{`${place?.id ?? 'none'} ${isUnsupported(here) ? here.why : here.key}`}</p>
}

test('components use the open hosted place unless a provider gives one', () => {
  const account = testAccount('ann')
  const render = () =>
    renderToStaticMarkup(
      <AccountProvider session={account}>
        <Shown />
      </AccountProvider>
    )
  const open = (view: View) => {
    account.store.setState({ view })
    Object.assign(account.store.getInitialState(), { view })
  }
  expect(render()).toBe('<p>none no_place</p>')
  open({ kind: 'channel', server: 'harbor', channelId: 1 })
  expect(render()).toBe('<p>hostedServer:harbor harbor</p>')
  open({ kind: 'dm', dmId: 9 })
  expect(render()).toBe('<p>hostedDm:9 not_in_dms</p>')
  const world = contractWorld('p2pRoom')
  expect(
    renderToStaticMarkup(
      <AccountProvider session={account}>
        <PlaceProvider place={world.ann.place}>
          <Shown />
        </PlaceProvider>
      </AccountProvider>
    )
  ).toBe('<p>p2pRoom:room room</p>')
  expect(world.ann.place).toBe(P2pRoom.open(world.ann.app!, world.room))
})

test('a live value keeps its identity until what it reads changes', () => {
  const store = createStore<{ n: number; other: number }>(() => ({ n: 1, other: 0 }))
  const pair = fromStore(
    store,
    s => ({ n: s.n }),
    (a, b) => a.n === b.n
  )
  const doubled = derived(pair, p => ({ twice: p.n * 2 }))
  const first = doubled.get()
  let calls = 0
  const stop = doubled.subscribe(() => {
    calls += 1
  })
  store.setState({ other: 1 })
  expect(calls).toBe(1)
  expect(doubled.get()).toBe(first)
  store.setState({ n: 2 })
  expect(doubled.get()).toEqual({ twice: 4 })
  stop()
  store.setState({ n: 3 })
  expect(calls).toBe(2)
  expect(constant(5).get()).toBe(5)
})

test('a server render reads the state a store starts from', () => {
  const store = createStore<{ n: number }>(() => ({ n: 1 }))
  store.setState({ n: 2 })
  const twice = derived(
    fromStore(store, s => s.n),
    n => n * 2
  )
  expect(twice.get()).toBe(4)
  expect(twice.initial?.()).toBe(2)
  expect(constant(1).initial).toBeUndefined()
})

function Count({ of }: { of: ReturnType<typeof constant<number>> }) {
  return <b>{useLive(of)}</b>
}

test('a component reads a live value', () => {
  expect(renderToStaticMarkup(<Count of={constant(4)} />)).toBe('<b>4</b>')
})
