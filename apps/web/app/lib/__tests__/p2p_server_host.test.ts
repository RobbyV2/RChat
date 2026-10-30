import { describe, expect, test } from 'bun:test'
import { resolveState, type Resolved } from '../p2p/resolve'
import { LocalHost, WorkerHost, type WorkerLike } from '../p2p/resolve_host'
import { membershipOf } from '../p2p/state'
import { base, ik } from './p2p_server_world'

// Resolution off the page's thread (rulings: resolution runs in a Web Worker with incremental
// caching, and the UI thread is never blocked by it). The same events give the same result in
// the worker, here, and in a replay; a failing worker hands its rooms back to this thread.

const A = ik()
const B = ik()
const C = ik()

const fp = (r: Resolved) =>
  JSON.stringify({
    state: [...r.state].map(([k, e]) => [k, e.id]).sort(),
    rejected: [...r.rejected].sort(),
    lost: [...r.lost].sort(),
    heads: r.heads,
    transitions: [...r.transitions].sort(),
    joins: [...r.joins].sort(),
    flagged: [...r.flagged].sort(),
    power: [...r.power].sort(),
  })

const worker = () =>
  new Worker(new URL('../p2p/p2p.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike

describe('resolution host', () => {
  test('the worker, this thread and a replay agree, event by event', async () => {
    const w = base(A, B)
    w.add(A, 'member', C, { m: 'invite' })
    w.add(C, 'member', C, { m: 'join' })
    const fork = w.res
    w.add(A, 'member', C, { m: 'ban' })
    w.hear(w.from(fork, C, 'member', ik(), { m: 'invite' }, w.now + 1))
    const host = new WorkerHost(worker)
    const local = new LocalHost()
    const room = 'R'
    const half = w.events.length >> 1
    let got = await host.load(room, w.events.slice(0, half))
    let mine = await local.load(room, w.events.slice(0, half))
    expect(fp(got)).toBe(fp(mine))
    for (const e of w.events.slice(half)) {
      got = await host.add(room, [e])
      mine = await local.add(room, [e])
      expect(fp(got)).toBe(fp(mine))
    }
    expect(fp(got)).toBe(fp(resolveState(w.events)))
    expect(membershipOf(got.state, C)).toBe('ban')
    // Results come back as the very events the page holds.
    expect(got.state.get(`member\n${C}`)).toBe(
      w.events.find(e => e.id === got.state.get(`member\n${C}`)?.id)
    )
    host.stop()
  })

  test('a worker that fails hands its rooms back to this thread', async () => {
    const w = base(A, B)
    let make: WorkerLike | null = null
    const host = new WorkerHost(() => {
      make = worker()
      return make
    })
    await host.load('R', w.events.slice(0, 3))
    ;(make as unknown as WorkerLike).onerror?.(new Error('boom'))
    const res = await host.add('R', w.events.slice(3))
    expect(fp(res)).toBe(fp(resolveState(w.events)))
    host.stop()
  })
})
