// A new member's join on the production path (recon-p2p-scale §2.2): at sampled sizes k, a
// replica restored from the first k stored records (a cold start: restore, first evaluation, first
// summary), then the next `--arrivals` events each through AclRoom.receiveAcl and delta(), as the
// host's `acl` op does for every arriving ACL event. The join's worker time integrates the cost per
// arrival over k (trapezoids from 0). Last, the cold reload of the whole universe.
// Usage: bun apps/web/scripts/p2p_bench/join.ts [--events N] [--members M] [--arrivals 30]
//   [--samples 10 | --at k1,k2,...]
import { AclRoom } from '../../app/lib/p2p/acl_room'
import { universe, type Item } from './gossip'
import { args, binds, emit, f1, gc, heapMb, LIM, mean, med, wireOf } from './world'

const a = args()
const u = universe(a)
const items = u.items
const n = items.length
const S = Math.min(a.num('arrivals', 30), n - 1)
const samples = a.num('samples', 10)
const ks = (
  a.list('at') ??
  Array.from({ length: samples }, (_, i) => Math.round(((i + 1) * (n - S)) / samples))
).filter(k => k >= 1 && k + S <= n)

const cold = (upTo: readonly Item[]) => {
  gc()
  const h0 = heapMb()
  const room = new AclRoom('g0', { binds, agreed: LIM })
  const t0 = performance.now()
  const r0 = room.restoreEvs(upTo)
  const restoreMs = performance.now() - t0
  const t1 = performance.now()
  room.r.state()
  const evalMs = performance.now() - t1
  const t2 = performance.now()
  room.delta()
  const sumMs = performance.now() - t2
  gc()
  return {
    room,
    out: {
      mismatch: r0.mismatch,
      restore_ms: f1(restoreMs),
      first_eval_ms: f1(evalMs),
      first_summary_ms: f1(sumMs),
      reload_ms: f1(restoreMs + evalMs + sumMs),
      heap_cold_mb: heapMb() - h0,
    },
  }
}

const points: [number, number][] = [[0, 0]]
for (const k of ks) {
  const { room, out } = cold(items.slice(0, k))
  const recv: number[] = []
  const dlt: number[] = []
  const st0 = { ...room.r.acl.stats }
  let notA = 0
  for (let j = k; j < k + S; j++) {
    const e = items[j].e
    const t0 = performance.now()
    const v = room.receiveAcl(e.id, wireOf(e), Infinity)
    const t1 = performance.now()
    room.delta()
    recv.push(t1 - t0)
    dlt.push(performance.now() - t1)
    if (v.s !== 'A') notA++
  }
  room.r.acl.invalidate()
  const t3 = performance.now()
  room.r.state()
  const rerun = performance.now() - t3
  const st = room.r.acl.stats
  const per = mean(recv) + mean(dlt)
  points.push([k, per])
  emit('join', {
    kind: 'probe',
    shape: u.shape,
    members: u.members,
    events: n,
    k,
    ...out,
    arrivals: S,
    not_admitted: notA,
    receive_ms_med: f1(med(recv)),
    receive_ms_mean: f1(mean(recv)),
    delta_ms_med: f1(med(dlt)),
    delta_ms_mean: f1(mean(dlt)),
    per_arrival_ms: f1(per),
    full_rerun_ms: f1(rerun),
    subsets: st.subsets - st0.subsets,
    head_path: st.head - st0.head,
  })
}

let ms = 0
for (let i = 1; i < points.length; i++)
  ms += ((points[i][0] - points[i - 1][0]) * (points[i][1] + points[i - 1][1])) / 2
const last = points[points.length - 1]
ms += (n - last[0]) * last[1]
const { out } = cold(items)
emit('join', {
  kind: 'join',
  shape: u.shape,
  members: u.members,
  events: n,
  samples: ks.length,
  arrivals: S,
  join_cpu_s: f1(ms / 1000),
  reload: out,
})
