// Gossip-shaped ACL universes built with the production admission (the r5 review's syncbench):
// `--members` M join, then each step a random member posts a mark (3/4) or a profile (1/4) citing
// its own latest event and the latest of 2 random members, until `--events` N. `--chan` adds a
// channel with @everyone View and Send, so content is admitted. Each event is admitted in its own
// St(e), as a joiner does, so the build time is the joiner's evaluator time (an upper bound: plus
// the builder's pastOf). Universes (events with their packed records) are kept in `--out`, one
// file per shape, M, N and seed; `--rebuild` builds again.
// Usage: bun apps/web/scripts/p2p_bench/gossip.ts [--events N] [--members M] [--seed S] [--chan]
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { INVITE, SEND, VIEW, type AclEv, type Rec } from '../../app/lib/p2p/acl/rules'
import { AclRoom, type PackedRec } from '../../app/lib/p2p/acl_room'
import {
  args,
  BenchWorld,
  binds,
  emit,
  f1,
  LIM,
  load,
  progress,
  Rng,
  rssMb,
  type Args,
  type Obj,
  type Opts,
} from './world'

export interface Item {
  e: AclEv
  rec: PackedRec
}

export interface Universe {
  v: 1
  shape: string
  members: number
  events: number
  seed: number
  build: Obj
  items: Item[]
}

export const shapeOf = (a: Args) => (a.chan ? 'gossip-chan' : 'gossip')

export const universePath = (a: Args) =>
  join(a.out, `${shapeOf(a)}-m${a.members}-n${a.events}-s${a.seed}.json`)

export function buildGossip(a: Args): Universe {
  const N = a.events
  const M = a.members
  const rng = new Rng(a.seed * 11)
  const w = new BenchWorld()
  let clock = 1
  const ok = (dev: string, t: string, c: Obj = {}, o: Opts = {}) => {
    const r = w.act(dev, t, c, { ts: o.ts ?? (clock += 1), ...o })
    return r.v.s === 'A' ? r.e : undefined
  }
  const t0 = performance.now()
  w.genesis('O1', ['O'], a.chan ? INVITE | SEND | VIEW : INVITE)
  if (a.chan) ok('O1', 'channel', { id: 'c0', name: 'general', kind: 'text', pos: 0 })
  const mem: string[] = []
  for (let i = 0; i < M; i++) {
    const x = `m${i}x`
    ok('O1', 'add', { to: x })
    if (ok(`${x}1`, 'join')) mem.push(x)
  }
  const joinS = (performance.now() - t0) / 1000
  let posted = 0
  let refused = 0
  let lastAt = performance.now()
  while (w.ref.order.length < N && refused < 5000 && mem.length) {
    const m = rng.pick(mem)
    const own = w.latestOwn(`${m}1`)!.id
    const others = [rng.pick(mem), rng.pick(mem)].map(x => w.latestOwn(`${x}1`)!.id)
    const ap = [...new Set([own, ...others])]
    const e =
      rng.int(4) === 0
        ? ok(`${m}1`, 'profile', { name: String(rng.int(1e6)) }, { ap })
        : ok(`${m}1`, 'mark', {}, { ap })
    if (e) posted++
    else refused++
    const n = w.ref.order.length
    if (n % 1000 === 0 && e) {
      const now = performance.now()
      progress('gossip', {
        n,
        s: f1((now - t0) / 1000),
        last1000_ms_per_ev: +((now - lastAt) / 1000).toFixed(2),
        heads: w.headSet.size,
      })
      lastAt = now
    }
  }
  const buildS = (performance.now() - t0) / 1000
  const room = new AclRoom('g0', { binds, agreed: LIM })
  room.r = w.ref
  const pack = (room as unknown as { pack: (e: AclEv, r: Rec) => PackedRec }).pack.bind(room)
  const tP = performance.now()
  const items = w.ref.order.map(id => ({ e: w.ref.ev(id), rec: pack(w.ref.ev(id), w.ref.rec(id)) }))
  const packMs = performance.now() - tP
  const tF = performance.now()
  w.ref.acl.invalidate()
  w.ref.state()
  const fullMs = performance.now() - tF
  return {
    v: 1,
    shape: shapeOf(a),
    members: M,
    events: N,
    seed: a.seed,
    build: {
      built: items.length,
      posted,
      refused,
      join_phase_s: f1(joinS),
      build_s: f1(buildS),
      build_ms_per_event: +((buildS * 1000) / items.length).toFixed(2),
      heads: w.headSet.size,
      stats: { ...w.ref.acl.stats },
      pack_ms: Math.round(packMs),
      full_eval_ms: Math.round(fullMs),
      rss_mb: rssMb(),
      build_load: load(),
    },
    items,
  }
}

// The universe of these arguments, from `--out` when it was built before.
export function universe(a: Args, rebuild = false): Universe & { cached: boolean } {
  const file = universePath(a)
  if (!rebuild && existsSync(file))
    return { ...(JSON.parse(readFileSync(file, 'utf8')) as Universe), cached: true }
  const u = buildGossip(a)
  mkdirSync(a.out, { recursive: true })
  writeFileSync(`${file}.${process.pid}`, JSON.stringify(u))
  renameSync(`${file}.${process.pid}`, file)
  return { ...u, cached: false }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = args()
  const u = universe(a, a.flag('rebuild'))
  emit('gossip', {
    shape: u.shape,
    members: u.members,
    events: u.items.length,
    seed: u.seed,
    cached: u.cached,
    file: universePath(a),
    ...u.build,
  })
}
