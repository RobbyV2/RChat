import { describe, expect, test } from 'bun:test'
import { P } from '../p2p/acl/rules'
import { applySummary, emptySummary, type Summary } from '../p2p/acl_room'
import { LocalHost, WorkerHost, type AclHost, type WorkerLike } from '../p2p/resolve_host'
import { ServerWorld } from './p2p_server_world'

// The evaluator off the page's thread (spec 5.7: in a worker): the same events give the same
// verdicts, records and state in the worker, in this thread and after a cold start from the
// records; replies are deltas the page applies to its copy; a failing worker loses its rooms and
// the page loads them again into this thread.

const worker = () =>
  new Worker(new URL('../p2p/p2p.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike

const universe = () => {
  const w = ServerWorld.create('O')
  const ch = w.channel('O')
  for (const n of ['B', 'C', 'D']) w.join('O', n)
  w.ok('O', 'role_create', { pos: 3, bits: P.Kick })
  w.ok('O', 'assign', { to: w.who('B').a, role: w.acl.at(-1)!.id })
  w.ok('C', 'msg', { body: 'c', ch })
  w.ok('B', 'kick', p => ({ to: w.who('C').a, seen: p.seen ?? {} }), { to: w.who('C').a })
  w.ok('D', 'msg', { body: 'd', ch })
  w.ok('D', 'leave', p => ({ seen: p.seen ?? {} }))
  return w
}

// Feeds a host the world's events in order; the page's copy follows the deltas.
const feed = async (host: AclHost, w: ServerWorld, from: number) => {
  const room = w.srv
  let copy: Summary = emptySummary()
  const outs: unknown[] = []
  const all = [...w.wires]
  const loaded = await host.load(room, [], [])
  copy = applySummary(copy, loaded.delta)
  for (const [id, wire] of all.slice(from)) {
    if (wire.ev.L === 'a') {
      const d = await host.acl(room, id, wire, w.now)
      outs.push(d.out)
      copy = applySummary(copy, d.delta)
    } else outs.push(await host.content(room, id, wire, w.now))
  }
  return { outs, copy }
}

describe('evaluator host', () => {
  test('the worker, this thread and a cold start agree, event by event', async () => {
    const w = universe()
    const host = new WorkerHost(worker)
    const local = new LocalHost()
    const a = await feed(host, w, 0)
    const b = await feed(local, w, 0)
    expect(a.outs).toEqual(b.outs)
    expect(a.copy).toEqual(b.copy)
    expect(a.copy).toEqual(w.sum)
    expect(a.copy.members[w.who('C').a].m).toBe('leave')
    // A cold start from the stored records gives the same state and decides nothing again.
    const cold = await host.load(w.srv, w.acl, w.contents)
    expect(cold.fresh).toEqual([])
    expect(applySummary(emptySummary(), cold.delta)).toEqual(w.sum)
    const ids = w.contents.map(m => m.id)
    expect(await host.display(w.srv, ids)).toEqual(await local.display(w.srv, ids))
    expect(await host.diff(w.srv, w.sum.heads, [], 1000)).toEqual(w.acl.map(x => x.id))
    host.stop()
  })

  test('a worker that fails loses its rooms; they are loaded again into this thread', async () => {
    const w = universe()
    let made: WorkerLike | null = null
    const host = new WorkerHost(() => {
      made = worker()
      return made
    })
    let lost = 0
    host.onLost = () => void (lost += 1)
    await host.load(w.srv, w.acl.slice(0, 3), [])
    ;(made as unknown as WorkerLike).onerror?.(new Error('boom'))
    expect(lost).toBe(1)
    const again = await host.load(w.srv, w.acl, w.contents)
    expect(applySummary(emptySummary(), again.delta)).toEqual(w.sum)
    host.stop()
  })
})
