import { afterAll, expect, test } from 'bun:test'
import { resetSessionCaches, useStore } from '../store'
import type { SealJob, WsEvent } from '../types'
import { me } from './fixtures'

afterAll(resetSessionCaches)

const job = (over: Partial<SealJob> = {}): SealJob => ({
  id: 3,
  place: 's:den',
  direction: 'seal',
  upto: 10,
  done: 4,
  state: 'running',
  created_at: 1,
  finished_at: null,
  ...over,
})

test("a job's progress is kept by place for the person who started it", () => {
  useStore.setState({ me: me('alice'), sealJobs: {} })
  const dispatch = (ev: WsEvent) => useStore.getState().applyWsEvent(ev)
  dispatch({ type: 'seal_job_progress', username: 'alice', job: job() })
  expect(useStore.getState().sealJobs['s:den']?.done).toBe(4)
  dispatch({ type: 'seal_job_progress', username: 'alice', job: job({ done: 10, state: 'done' }) })
  expect(useStore.getState().sealJobs['s:den']?.state).toBe('done')
  dispatch({ type: 'seal_job_progress', username: 'bob', job: job({ place: 'd:4' }) })
  expect(Object.keys(useStore.getState().sealJobs)).toEqual(['s:den'])
})
