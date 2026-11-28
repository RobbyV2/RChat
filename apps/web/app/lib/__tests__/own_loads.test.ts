import { describe, expect, test } from 'bun:test'
import { ApiError } from '../api'
import { ownLoad, ownLoadsInitial, type RefusedLoads } from '../own_loads'

const holder = () => {
  let state = ownLoadsInitial()
  const set = (change: (s: { refusedLoads: RefusedLoads }) => Partial<typeof state>) => {
    state = { ...state, ...change(state) }
  }
  return { set, read: () => state.refusedLoads }
}

describe("a load of the store's own", () => {
  test('a refusal is kept by what was loading, until the load answers', () => {
    const { set, read } = holder()
    const jobs = ownLoad(set, 'bulk_jobs')
    jobs.refused(new ApiError('Busy', 503, undefined, 30))
    expect(read().bulk_jobs?.kind).toBe('unavailable')
    expect(read().bulk_jobs?.retryAfter).toBe(30)
    ownLoad(set, 'scheduled:c4').refused(new TypeError('Failed to fetch'))
    expect(read()['scheduled:c4']?.kind).toBe('offline')
    jobs.came()
    expect(read()).toEqual({ 'scheduled:c4': read()['scheduled:c4'] })
  })

  test('an answer with nothing kept changes nothing', () => {
    const { set, read } = holder()
    const before = read()
    ownLoad(set, 'friend_summary').came()
    expect(read()).toBe(before)
  })

  test('an instance without the thing leaves nothing to show', () => {
    const { set, read } = holder()
    const counts = ownLoad(set, 'scheduled_counts')
    counts.refused(new ApiError('No', 500))
    counts.refused(new ApiError('Not found', 404))
    expect(read()).toEqual({})
  })
})
