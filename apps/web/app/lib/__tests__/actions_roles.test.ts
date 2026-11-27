import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { ctxFor } from '../actions/ctx'
import { registerAppActions } from '../actions/index'
import { menuItems } from '../actions/menu'
import type { Target } from '../actions/types'
import { resetSessionCaches, useStore } from '../store'
import { drain, me, memoryStorage, role, serverDetail } from './fixtures'

const initial = useStore.getState()

beforeAll(registerAppActions)

afterEach(() => {
  useStore.setState(initial, true)
  memoryStorage.clear()
})

afterAll(resetSessionCaches)

const roles = [1, 2, 3, 4].map(id => ({ ...role(id, '#123456', 0), position: 5 - id }))
const order = roles.map(r => r.id)

const at = (
  id: number,
  movable: number[],
  after?: () => void,
  display = order,
  follows = true
): Target => ({
  kind: 'role',
  server: 's',
  role: roles[id - 1],
  order,
  display,
  follows,
  movable,
  version: 7,
  after,
})

const state = (list = roles) =>
  useStore.setState({
    token: 'tok',
    me: me('alice'),
    servers: { s: serverDetail('s', { roles: list, roles_version: 7 }) },
  })

const items = (t: Target) => menuItems(ctxFor(useStore.getState(), t, 'menu'))
const labels = (t: Target) => items(t).map(i => i.label)
const MOVES = ['Move Up', 'Move Down']
const SHOWN = ['Show Higher', 'Show Lower']

test('a role row moves the role among those you may move', () => {
  state()
  expect(labels(at(3, [2, 3, 4]))).toEqual([...MOVES, ...SHOWN])
  expect(labels(at(2, [2, 3, 4]))).toEqual(['Move Down', 'Show Lower'])
  expect(labels(at(4, [2, 3, 4]))).toEqual(['Move Up', 'Show Higher'])
  expect(labels(at(1, [2, 3, 4]))).toEqual([])
  expect(labels(at(3, [3]))).toEqual([])
})

test('the display order moves on its own and goes back to the role order', async () => {
  state()
  const display = [1, 3, 2, 4]
  expect(labels(at(3, [2, 3, 4], undefined, display, false))).toEqual([
    ...MOVES,
    'Show Lower',
    'Show in Role Order',
  ])
  expect(labels(at(2, [2, 3, 4], undefined, display, false))).toEqual([
    'Move Down',
    ...SHOWN,
    'Show in Role Order',
  ])
  // Back to the role order would move role 1, which you may not move.
  expect(labels(at(3, [2, 3, 4], undefined, [3, 1, 2, 4], false))).toEqual([...MOVES, 'Show Lower'])
  // Back to the role order would move role 3, which you may not move.
  expect(labels(at(2, [2, 4], undefined, display, false))).toEqual(['Move Down', 'Show Lower'])
  const calls: unknown[][] = []
  let after = 0
  useStore.setState({
    setRoleDisplay: (...a: unknown[]) => {
      calls.push(a)
      return Promise.resolve()
    },
  })
  for (const label of ['Show Lower', 'Show in Role Order'])
    items(at(2, [2, 3, 4], () => after++, display, false))
      .find(i => i.label === label)
      ?.action?.()
  await drain()
  expect(calls).toEqual([
    ['s', [1, 3, 4, 2], 7],
    ['s', null, 7],
  ])
  expect(after).toBe(2)
})

test('a move saves the new order with the version it was made from', async () => {
  state()
  const calls: unknown[][] = []
  let after = 0
  useStore.setState({
    setRoleOrder: (...a: unknown[]) => {
      calls.push(a)
      return Promise.resolve()
    },
  })
  for (const [label, id] of [
    ['Move Up', 4],
    ['Move Down', 2],
  ] as const) {
    items(at(id, [2, 4], () => after++))
      .find(i => i.label === label)
      ?.action?.()
    await drain()
  }
  expect(calls).toEqual([
    ['s', [1, 4, 3, 2], 7],
    ['s', [1, 4, 3, 2], 7],
  ])
  expect(after).toBe(2)
})

test('a role deleted while its menu is open does not move', async () => {
  state()
  const calls: unknown[][] = []
  useStore.setState({
    setRoleOrder: (...a: unknown[]) => {
      calls.push(a)
      return Promise.resolve()
    },
  })
  const up = items(at(4, [2, 3, 4])).find(i => i.label === 'Move Up')
  expect(typeof up?.action).toBe('function')
  state(roles.slice(0, 3))
  up?.action?.()
  await drain()
  expect(calls).toEqual([])
})
