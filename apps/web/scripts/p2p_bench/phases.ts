// Where an evaluation's time goes: FastEval's phases (forkPoints, voidSet, tails, stratum, result,
// compute) wrapped with timers, then `--reps` R full evaluations, R subset evaluations St(e) (the
// last R events' parents, fresh merge cache each) and R summaries after a re-run, warm.
// Usage: bun apps/web/scripts/p2p_bench/phases.ts [--events N] [--members M] [--reps 10]
import { FastEval } from '../../app/lib/p2p/acl/eval'
import { AclRoom } from '../../app/lib/p2p/acl_room'
import { universe } from './gossip'
import { args, binds, emit, f1, LIM } from './world'

const a = args()
const u = universe(a)
const items = u.items
const R = Math.min(a.num('reps', 10), items.length)
const room = new AclRoom('g0', { binds, agreed: LIM })
room.restoreEvs(items)
room.r.state()
room.delta()
const acl = room.r.acl
const T: Record<string, number> = {}
const wrap = (proto: object, name: string) => {
  let p: object | null = proto
  while (p && !Object.prototype.hasOwnProperty.call(p, name)) p = Object.getPrototypeOf(p)
  if (!p) throw new Error(`no ${name}`)
  const f = (p as Record<string, (...x: unknown[]) => unknown>)[name]
  ;(p as Record<string, unknown>)[name] = function (this: unknown, ...x: unknown[]) {
    const t = performance.now()
    try {
      return f.apply(this, x)
    } finally {
      T[name] = (T[name] ?? 0) + performance.now() - t
    }
  }
}
for (const m of ['forkPoints', 'voidSet', 'tails', 'stratum', 'result', 'compute'])
  wrap(FastEval.prototype, m)

const run = (label: string, fn: () => void) => {
  for (const k of Object.keys(T)) delete T[k]
  const t = performance.now()
  fn()
  const total = performance.now() - t
  const out: Record<string, number> = { total_ms: f1(total / R) }
  for (const [k, v] of Object.entries(T)) out[k] = f1(v / R)
  const inner = (T.forkPoints ?? 0) + (T.voidSet ?? 0) + (T.tails ?? 0) + (T.stratum ?? 0)
  out.compute_other = f1(((T.compute ?? 0) - inner) / R)
  out.outside_compute = f1((total - (T.compute ?? 0) - (T.result ?? 0)) / R)
  emit('phases', {
    shape: u.shape,
    members: u.members,
    events: items.length,
    label,
    reps: R,
    ...out,
  })
}
run('full', () => {
  for (let i = 0; i < R; i++) {
    acl.invalidate()
    acl.state()
  }
})
run('subset', () => {
  for (let i = 0; i < R; i++) {
    acl.cache.clear()
    acl.stateOf(items[items.length - 1 - i].e.ap)
  }
})
run('summary_after_rerun', () => {
  for (let i = 0; i < R; i++) {
    acl.invalidate()
    room.delta()
  }
})
let sumOnly = 0
for (let i = 0; i < R; i++) {
  acl.invalidate()
  acl.state()
  const t = performance.now()
  room.delta()
  sumOnly += performance.now() - t
}
emit('phases', {
  shape: u.shape,
  members: u.members,
  events: items.length,
  label: 'summary_only',
  reps: R,
  total_ms: f1(sumOnly / R),
})
