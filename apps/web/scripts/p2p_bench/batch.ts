// The same arrivals with one delta() per arrival (today's host) and with one per batch (D2 item 1):
// a replica restored from the first k records, then `--arrivals` S events through
// AclRoom.receiveAcl. `--reps` alternates the two modes, each on a fresh replica.
// Usage: bun apps/web/scripts/p2p_bench/batch.ts [--events N] [--members M] [--arrivals 30]
//   [--at k] [--reps 1]
import { AclRoom } from '../../app/lib/p2p/acl_room'
import { universe } from './gossip'
import { args, binds, emit, f1, LIM, mean, wireOf } from './world'

const a = args()
const u = universe(a)
const items = u.items
const S = Math.min(a.num('arrivals', 30), items.length - 1)
const k = Math.min(a.num('at', items.length - S), items.length - S)
const reps = a.num('reps', 1)

const run = (mode: 'each' | 'batch') => {
  const room = new AclRoom('g0', { binds, agreed: LIM })
  room.restoreEvs(items.slice(0, k))
  room.r.state()
  room.delta()
  const t = performance.now()
  for (let j = k; j < k + S; j++) {
    const e = items[j].e
    room.receiveAcl(e.id, wireOf(e), Infinity)
    if (mode === 'each') room.delta()
  }
  if (mode === 'batch') room.delta()
  return (performance.now() - t) / S
}

const per = { each: [] as number[], batch: [] as number[] }
for (let r = 0; r < reps; r++)
  for (const mode of r % 2 ? (['batch', 'each'] as const) : (['each', 'batch'] as const)) {
    const ms = run(mode)
    per[mode].push(ms)
    emit('batch', {
      shape: u.shape,
      members: u.members,
      k,
      arrivals: S,
      mode,
      per_arrival_ms: f1(ms),
    })
  }
emit('batch', {
  kind: 'summary',
  shape: u.shape,
  members: u.members,
  k,
  arrivals: S,
  reps,
  each_ms: f1(mean(per.each)),
  batch_ms: f1(mean(per.batch)),
  speedup: +(mean(per.each) / mean(per.batch)).toFixed(2),
})
