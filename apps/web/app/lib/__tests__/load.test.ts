import { describe, expect, test } from 'bun:test'
import { ApiError } from '../api'
import { ManualTime } from '../clock'
import {
  LOAD_DEADLINE_MS,
  fromLive,
  fromRequest,
  fromStore,
  overdueIn,
  retryIn,
  type Load,
} from '../load'

const settle = () => new Promise<void>(done => queueMicrotask(() => queueMicrotask(done)))

const gate = <T>() => {
  let pass!: (value: T) => void
  let fail!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    pass = yes
    fail = no
  })
  return { promise, pass, fail }
}

describe('a request', () => {
  test('starts when first watched and holds the value it got', async () => {
    const clock = new ManualTime()
    let asked = 0
    const g = gate<number[]>()
    const source = fromRequest(clock, () => {
      asked++
      return g.promise
    })
    expect(asked).toBe(0)
    expect(source.get().status).toBe('loading')
    const seen: string[] = []
    const stop = source.subscribe(() => seen.push(source.get().status))
    expect(asked).toBe(1)
    g.pass([1, 2])
    await settle()
    expect(source.get().status).toBe('ready')
    expect(seen).toEqual(['ready'])
    stop()
    source.subscribe(() => {})
    expect(asked).toBe(1)
  })

  test('an answer with nothing to show is empty', async () => {
    const clock = new ManualTime()
    const source = fromRequest(clock, () => Promise.resolve([] as number[]), {
      empty: list => list.length === 0,
    })
    source.subscribe(() => {})
    await settle()
    expect(source.get().status).toBe('empty')
  })

  test('a refusal is a failed load, and retry asks again', async () => {
    const clock = new ManualTime()
    let asked = 0
    const source = fromRequest(clock, () => {
      asked++
      return asked === 1 ? Promise.reject(new ApiError('No', 500)) : Promise.resolve('ok')
    })
    source.subscribe(() => {})
    await settle()
    expect(source.get().status).toBe('failed')
    expect(source.get().retry).toBe(source.retry)
    source.retry()
    expect(source.get().status).toBe('loading')
    await settle()
    expect(source.get().status).toBe('ready')
    expect(asked).toBe(2)
  })

  test('retry waits out the time the refusal asked for', async () => {
    const clock = new ManualTime()
    let asked = 0
    const source = fromRequest(clock, () => {
      asked++
      return Promise.reject(new ApiError('Busy', 503, undefined, 30))
    })
    source.subscribe(() => {})
    await settle()
    expect(source.get().status).toBe('failed')
    source.retry()
    expect(asked).toBe(1)
    clock.advance(29_000)
    expect(asked).toBe(1)
    clock.advance(1_000)
    expect(asked).toBe(2)
  })

  test('nobody watching stops it, and an answer that comes late is dropped', async () => {
    const clock = new ManualTime()
    const signals: AbortSignal[] = []
    const g = gate<string>()
    const source = fromRequest(clock, signal => {
      signals.push(signal)
      return g.promise
    })
    const stop = source.subscribe(() => {})
    stop()
    expect(signals[0].aborted).toBe(true)
    g.pass('late')
    await settle()
    expect(source.get().status).toBe('loading')
    source.subscribe(() => {})
    expect(signals).toHaveLength(2)
  })

  test('a mapped load keeps its state and its retry', async () => {
    const clock = new ManualTime()
    const source = fromRequest(clock, () => Promise.resolve([1, 2, 3]))
    expect(source.get().map(list => list.length).status).toBe('loading')
    source.subscribe(() => {})
    await settle()
    const mapped: Load<number> = source.get().map(list => list.length)
    expect(mapped.status).toBe('ready')
    expect(mapped.retry).toBe(source.retry)
  })
})

describe('a value a store holds', () => {
  type S = { list: number[] | null; error: string | null; online: boolean }
  const store = (first: S) => {
    let state = first
    const listeners = new Set<() => void>()
    return {
      getState: () => state,
      getInitialState: () => first,
      subscribe: (l: () => void) => {
        listeners.add(l)
        return () => listeners.delete(l)
      },
      set: (next: Partial<S>) => {
        state = { ...state, ...next }
        for (const l of listeners) l()
      },
    }
  }

  test('follows the store through every state', () => {
    const clock = new ManualTime()
    const s = store({ list: null, error: null, online: true })
    const live = fromStore<S, number[]>(clock, s, (state, make) => {
      if (!state.online) return make.waiting('offline')
      if (state.error) return make.failed(state.error)
      if (!state.list) return make.loading()
      return state.list.length ? make.ready(state.list) : make.empty()
    })
    expect(live.get().status).toBe('loading')
    expect(live.get()).toBe(live.get())
    s.set({ list: [] })
    expect(live.get().status).toBe('empty')
    s.set({ list: [1] })
    const ready = live.get()
    expect(ready.status).toBe('ready')
    s.set({ online: true })
    expect(live.get()).toBe(ready)
    s.set({ error: 'no' })
    expect(live.get().status).toBe('failed')
    s.set({ online: false })
    expect(live.get().status).toBe('waiting')
    expect(live.initial?.().status).toBe('loading')
  })

  test('its retry is the one given', () => {
    const clock = new ManualTime()
    const s = store({ list: null, error: null, online: true })
    const again = () => {}
    const live = fromStore<S, number[]>(clock, s, (_state, make) => make.loading(), again)
    expect(live.get().retry).toBe(again)
    expect(
      fromStore<S, number[]>(clock, s, (_state, make) => make.loading()).get().retry
    ).toBeNull()
  })
})

describe('a live value', () => {
  test('is a load that follows it, with the retry given', () => {
    const clock = new ManualTime()
    let list: number[] | null = null
    const listeners = new Set<() => void>()
    const live = {
      get: () => list,
      subscribe: (l: () => void) => {
        listeners.add(l)
        return () => listeners.delete(l)
      },
    }
    const again = () => {}
    const load = fromLive<number[] | null, number[]>(
      clock,
      live,
      (value, make) => (value === null ? make.loading() : make.ready(value)),
      again
    )
    expect(load.get().status).toBe('loading')
    expect(load.get().retry).toBe(again)
    let told = 0
    load.subscribe(() => told++)
    list = [1]
    for (const l of listeners) l()
    expect(told).toBe(1)
    expect(load.get().status).toBe('ready')
  })
})

describe('deadlines', () => {
  test('a load is overdue once its deadline passed', () => {
    expect(overdueIn(LOAD_DEADLINE_MS, 0)).toBe(LOAD_DEADLINE_MS)
    expect(overdueIn(LOAD_DEADLINE_MS, LOAD_DEADLINE_MS)).toBe(0)
    expect(overdueIn(LOAD_DEADLINE_MS, LOAD_DEADLINE_MS + 5)).toBe(0)
  })

  test('the wait before a retry counts down in whole seconds', () => {
    expect(retryIn(null, 0)).toBe(0)
    expect(retryIn(30_000, 0)).toBe(30)
    expect(retryIn(30_000, 29_100)).toBe(1)
    expect(retryIn(30_000, 30_000)).toBe(0)
  })
})
