import { expect, test } from 'bun:test'
import { createStore } from 'zustand/vanilla'
import './p2p_net'
import { own } from './helpers/fixture'
import { P2pStore } from '../p2p/db'
import { createScheduledPart } from '../p2p/app/scheduled'
import type { DeviceSchedule } from '../p2p/scheduled'

type Parts = Parameters<typeof createScheduledPart>[0]
type Scope = Parameters<typeof createScheduledPart>[1]

const target = () => {
  const heard = new Map<string, Set<unknown>>()
  return {
    heard,
    visibilityState: 'visible',
    addEventListener: (type: string, fn: unknown) =>
      void heard.set(type, (heard.get(type) ?? new Set()).add(fn)),
    removeEventListener: (type: string, fn: unknown) => void heard.get(type)?.delete(fn),
  }
}

const g = globalThis as { window?: unknown; document?: unknown }
const page = (window: unknown, document: unknown) => {
  const was = { window: g.window, document: g.document }
  own(was, () => Object.assign(g, was))
  Object.assign(g, { window, document })
}

const part = () => {
  let scheduled: DeviceSchedule | null = null
  const useP2p = createStore(() => ({ servers: {}, rooms: {}, contacts: {}, scheduled: [] }))
  const store = {
    useP2p,
    put: { scheduled: (x: DeviceSchedule | null) => void (scheduled = x) },
    p2pHost: { toast: () => {} },
    get scheduled() {
      return scheduled
    },
  }
  return createScheduledPart(
    { store, dms: {} } as unknown as Parts,
    { current: () => true } as unknown as Scope
  )
}

test('stopping takes its listeners off the page it started on, whatever the page is by then', async () => {
  const db = own(await P2pStore.create('scheduled-part-test'), s => s.close())
  const window = target()
  const document = target()
  page(window, document)
  const { startScheduled, stopScheduled } = part()
  await startScheduled(db, 'me', () => true)
  expect([window.heard.get('online')?.size, document.heard.get('visibilitychange')?.size]).toEqual([
    1, 1,
  ])
  page({}, undefined)
  await stopScheduled()
  expect([window.heard.get('online')?.size, document.heard.get('visibilitychange')?.size]).toEqual([
    0, 0,
  ])
})
