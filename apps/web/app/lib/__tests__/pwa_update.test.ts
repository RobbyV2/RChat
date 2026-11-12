import { expect, test } from 'bun:test'
import { trackUpdates, updateWatch } from '../pwa_update'

const STATES = ['installing', 'installed', 'activating', 'activated'] as const

test('the first worker of a first visit takes the page over without a reload', () => {
  const reloads = updateWatch()(false)
  expect(STATES.map(reloads)).toEqual([false, false, false, false])
})

test('an updated worker that replaces a controller reloads the page once it is active', () => {
  const reloads = updateWatch()(true)
  expect(STATES.map(reloads)).toEqual([false, false, false, true])
})

test('an update after a first visit reloads: the first worker controls the page by then', () => {
  const found = updateWatch()
  expect(STATES.map(found(false))).toEqual([false, false, false, false])
  expect(STATES.map(found(true))).toEqual([false, false, false, true])
})

test('the page reloads once, however many workers become active', () => {
  const found = updateWatch()
  const [first, second] = [found(true), found(true)]
  expect(first('activated')).toBe(true)
  expect(first('activated')).toBe(false)
  expect(second('activated')).toBe(false)
})

test('a worker that never becomes active reloads nothing', () => {
  const reloads = updateWatch()(true)
  expect((['installing', 'installed', 'redundant'] as const).map(reloads)).toEqual([
    false,
    false,
    false,
  ])
})

const worker = (state: ServiceWorkerState = 'installing') => {
  const listeners: (() => void)[] = []
  const w = {
    state,
    addEventListener: (_: 'statechange', f: () => void) => void listeners.push(f),
    reach: (next: ServiceWorkerState) => {
      w.state = next
      listeners.forEach(f => f())
    },
  }
  return w
}

type FakeWorker = ReturnType<typeof worker>

const registration = (installing: FakeWorker | null = null, waiting: FakeWorker | null = null) => {
  const listeners: (() => void)[] = []
  const reg = {
    installing,
    waiting,
    addEventListener: (_: 'updatefound', f: () => void) => void listeners.push(f),
    find: (next: FakeWorker) => {
      reg.installing = next
      listeners.forEach(f => f())
    },
  }
  return reg
}

const tracked = (reg: ReturnType<typeof registration>, controlled: boolean) => {
  const page = { controlled, reloads: 0 }
  trackUpdates(
    reg,
    () => page.controlled,
    () => {
      page.reloads += 1
    }
  )
  return page
}

test('a first visit registers with its worker installing and does not reload', () => {
  const first = worker()
  const reg = registration(first)
  const page = tracked(reg, false)
  reg.find(first)
  STATES.forEach(first.reach)
  page.controlled = true
  expect(page.reloads).toBe(0)
  const next = worker()
  reg.find(next)
  STATES.forEach(next.reach)
  expect(page.reloads).toBe(1)
})

test('an update another tab started before this page registered reloads it too', () => {
  for (const at of ['installing', 'installed'] as const) {
    const next = worker(at)
    const reg = at === 'installing' ? registration(next) : registration(null, next)
    const page = tracked(reg, true)
    next.reach('activating')
    expect(page.reloads).toBe(0)
    next.reach('activated')
    expect(page.reloads).toBe(1)
  }
})

test('a worker seen at registration and found again is watched once', () => {
  const next = worker()
  const reg = registration(next)
  const page = tracked(reg, true)
  reg.find(next)
  reg.find(next)
  next.reach('activated')
  next.reach('activated')
  expect(page.reloads).toBe(1)
})

test('a page with nothing on its way in waits for an update', () => {
  const reg = registration()
  const page = tracked(reg, true)
  expect(page.reloads).toBe(0)
  const next = worker()
  reg.find(next)
  next.reach('redundant')
  expect(page.reloads).toBe(0)
})
