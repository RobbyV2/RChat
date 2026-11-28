import { describe, expect, test } from 'bun:test'
import { ApiError } from '../api'
import { ManualTime } from '../clock'
import {
  SESSION_LEFT_OPEN,
  ownLoadsInitial,
  ownWork,
  persistently,
  revokeOnLeaving,
  type RefusedLoads,
} from '../own_loads'
import { READ_TROUBLE_AFTER, createReadQueue } from '../reads'

const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

// Moves the clock a step at a time, letting what each timer started run before the next.
const pass = async (clock: ManualTime, ms: number, step = 500) => {
  for (let at = 0; at < ms; at += step) {
    clock.advance(step)
    await settle()
  }
}

const failing = (times: number, error: unknown = new ApiError('Busy', 503)) => {
  let asked = 0
  const run = () => {
    asked += 1
    return asked <= times ? Promise.reject(error) : Promise.resolve(asked)
  }
  return { run, asked: () => asked }
}

describe('work tried again quietly', () => {
  test('a failure that passes is tried again, further apart each time', async () => {
    const clock = new ManualTime(0)
    const work = failing(2)
    const done = persistently(clock, work.run)
    await settle()
    expect(work.asked()).toBe(1)
    await pass(clock, 2000)
    expect(work.asked()).toBe(2)
    await pass(clock, 3500)
    expect(work.asked()).toBe(2)
    await pass(clock, 500)
    expect(await done).toBe(3)
  })

  test('the last failure is the one handed on', async () => {
    const clock = new ManualTime(0)
    const work = failing(9)
    const done = persistently(clock, work.run, { tries: 3 }).catch((error: unknown) => error)
    await pass(clock, 10_000)
    expect((await done) instanceof ApiError).toBe(true)
    expect(work.asked()).toBe(3)
  })

  test('a refusal that asking again cannot change is handed on at once', async () => {
    const clock = new ManualTime(0)
    const work = failing(9, new ApiError('No', 403))
    const done = persistently(clock, work.run).catch(() => 'refused')
    expect(await done).toBe('refused')
    expect(work.asked()).toBe(1)
    expect(clock.pending).toBe(0)
  })

  test('work that no longer matters is not tried again', async () => {
    const clock = new ManualTime(0)
    const work = failing(9)
    let live = true
    const done = persistently(clock, work.run, { live: () => live }).catch(() => 'refused')
    await settle()
    live = false
    await pass(clock, 10_000)
    expect(await done).toBe('refused')
    expect(work.asked()).toBe(1)
  })
})

const holder = () => {
  let state = ownLoadsInitial()
  const set = (change: (s: { refusedLoads: RefusedLoads }) => Partial<typeof state>) => {
    state = { ...state, ...change(state) }
  }
  return { set, read: () => state.refusedLoads }
}

describe("the record of the store's own work", () => {
  test('keeps a refusal, and leaves a request with no answer to the connection state', () => {
    const { set, read } = holder()
    const marks = ownWork(set, 'read_marks')
    marks.refused(new TypeError('Failed to fetch'))
    expect(read()).toEqual({})
    marks.refused(new ApiError('Busy', 503))
    expect(read().read_marks?.kind).toBe('unavailable')
    marks.came()
    expect(read()).toEqual({})
  })
})

describe('ending a session on the way out', () => {
  const leave = (clock: ManualTime, run: () => Promise<unknown>) => {
    const told: string[] = []
    const first = revokeOnLeaving(clock, run, line => told.push(line))
    return { told, first }
  }

  test('an instance that ends it says nothing more', async () => {
    const clock = new ManualTime(0)
    const { told, first } = leave(clock, () => Promise.resolve({ ok: true }))
    expect(await first).toEqual({ ok: true })
    expect(clock.pending).toBe(0)
    expect(told).toEqual([])
  })

  test('a failed try settles at once and is tried again quietly', async () => {
    const clock = new ManualTime(0)
    const work = failing(1)
    const { told, first } = leave(clock, work.run)
    expect(await first).toBe(undefined)
    await pass(clock, 2000)
    expect(work.asked()).toBe(2)
    expect(told).toEqual([])
  })

  test('a session that stays open is said, with what to do', async () => {
    const clock = new ManualTime(0)
    const work = failing(9)
    const { told } = leave(clock, work.run)
    await pass(clock, 10_000)
    expect(work.asked()).toBe(3)
    expect(told).toEqual([SESSION_LEFT_OPEN])
  })

  test('a session the instance no longer knows is ended', async () => {
    const clock = new ManualTime(0)
    const work = failing(9, new ApiError('Unauthorized', 401))
    const { told } = leave(clock, work.run)
    await pass(clock, 10_000)
    expect(work.asked()).toBe(1)
    expect(told).toEqual([])
  })
})

describe('read marks that keep failing', () => {
  const setup = () => {
    const clock = new ManualTime(0)
    let down = true
    const heard: unknown[] = []
    const q = createReadQueue({
      send: () => (down ? Promise.reject(new ApiError('Busy', 503)) : Promise.resolve()),
      delay: 1_000,
      maxWait: 2_000,
      time: clock,
      retryDelay: () => 1_000,
      trouble: error => heard.push(error),
    })
    return { clock, q, heard, up: () => (down = false) }
  }

  test('the person is told after the third failure, once', async () => {
    const { clock, q, heard } = setup()
    q.mark('c1', 5)
    await pass(clock, 1_000 * (READ_TROUBLE_AFTER - 1) + 500)
    expect(heard).toEqual([])
    await pass(clock, 6_000)
    expect(heard.length).toBe(1)
    expect(heard[0] instanceof ApiError).toBe(true)
  })

  test('and told it passed once the mark is saved', async () => {
    const { clock, q, heard, up } = setup()
    q.mark('c1', 5)
    await pass(clock, 6_000)
    up()
    await pass(clock, 3_000)
    expect(heard.length).toBe(2)
    expect(heard[1]).toBe(null)
  })
})
