// Content on a gossip universe with a channel (always the `--chan` shape): `--contents` C events
// by random member devices, each at its device's latest ACL event plus one of `--positions` P later
// positions; one in ten targets an earlier message (edit, reaction, redaction or pin). Timed:
// admission (decideContent in St(m) through the content cache), the ContentView build, the first
// render of 50-message windows (hidden, redactedBy, editOf, reactions, pinned), and the heap.
// Usage: bun apps/web/scripts/p2p_bench/content.ts [--events N] [--members M] [--contents 100000]
//   [--positions 16] [--cache 64]
import { decideContent, pastOf } from '../../app/lib/p2p/acl/admit'
import { ContentView, type ContentEv } from '../../app/lib/p2p/acl/visibility'
import { AclRoom } from '../../app/lib/p2p/acl_room'
import { universe } from './gossip'
import { args, binds, emit, f1, gc, heapMb, LIM, med, Rng, rssMb } from './world'

const a = { ...args(), chan: true }
const u = universe(a)
const C = a.num('contents', 100_000)
const P = a.num('positions', 16)
const room = new AclRoom('g0', { binds, agreed: LIM })
room.restoreEvs(u.items)
room.r.state()
const acl = room.r.acl
acl.contentBytes = a.num('cache', 64) * 2 ** 20
gc()
const h0 = heapMb()
const ix = acl.ix
const rng = new Rng(a.seed * 77)
const byDev = new Map<string, number[]>()
for (let i = 0; i < ix.n; i++) {
  const d = ix.ev[i].dev
  if (!byDev.has(d)) byDev.set(d, [])
  byDev.get(d)!.push(i)
}
const devList = [...byDev.keys()].filter(d => d !== 'O1')
const snaps = Array.from({ length: P }, (_, k) => Math.floor(((k + 1) * (ix.n - 1)) / P))
const seqOf = new Map<string, number>()
const prevOf = new Map<string, string>()
const out: ContentEv[] = []
const tG = performance.now()
for (let i = 0; i < C; i++) {
  const dev = rng.pick(devList)
  const snap = rng.pick(snaps)
  const evs = byDev.get(dev)!
  const last = evs[evs.length - 1]
  const ap = snap > last ? [ix.ids[last], ix.ids[snap]] : [ix.ids[last]]
  const seq = Math.max(seqOf.get(dev) ?? 0, ix.ev[last].seq) + 1
  seqOf.set(dev, seq)
  const tgt = out.length && rng.int(10) === 0 ? rng.pick(out) : undefined
  const t = tgt ? rng.pick(['edit', 'react', 'redact', 'pin']) : 'msg'
  const c: Record<string, unknown> = { ch: 'c0', body: `m${i}` }
  if (tgt) {
    c.target = tgt.id
    if (t === 'react') Object.assign(c, { key: 'k', on: true })
    if (t === 'pin') c.on = true
  }
  const m: ContentEv = {
    id: `c${i}`,
    t,
    a: ix.ev[last].a,
    dev,
    seq,
    ap,
    ts: Math.max(...ap.map(p => ix.ev[ix.at.get(p)!].ts)) + 1,
    c,
  }
  const pv = prevOf.get(dev)
  if (pv) m.cprev = pv
  prevOf.set(dev, m.id)
  out.push(m)
}
const genMs = performance.now() - tG
const why = new Map<string, number>()
const positions = new Set<string>()
let admitted = 0
const sub0 = acl.stats.subsets
const tA = performance.now()
for (const m of out) {
  positions.add([...new Set(m.ap)].sort().join(','))
  const v = decideContent(m, pastOf(ix, m.ap), acl.contentStateOf(m.ap))
  if (v.ok) admitted++
  else why.set(v.why, (why.get(v.why) ?? 0) + 1)
}
const admitMs = performance.now() - tA
const subsets = acl.stats.subsets - sub0
const t1 = performance.now()
const view = new ContentView(acl, out)
const viewMs = performance.now() - t1
gc()
const heapAfter = heapMb() - h0
const msgs = out.filter(m => m.t === 'msg')
const windows = Math.min(2000, Math.floor(msgs.length / 50))
const per: number[] = []
let hidden = 0
const hw = new Map<string, number>()
const t2 = performance.now()
for (let k = 0; k < windows; k++) {
  const at = rng.int(Math.floor(msgs.length / 50)) * 50
  const s0 = performance.now()
  for (let j = at; j < at + 50; j++) {
    const hh = view.hidden(msgs[j])
    if (hh) {
      hidden++
      hw.set(hh.why, (hw.get(hh.why) ?? 0) + 1)
    }
    view.redactedBy(msgs[j])
    view.editOf(msgs[j])
    view.reactions(msgs[j])
    view.pinned(msgs[j])
  }
  per.push((performance.now() - s0) / 50)
}
const firstMs = performance.now() - t2
const sorted = [...per].sort((p, q) => p - q)
emit('content', {
  shape: u.shape,
  members: u.members,
  acl: ix.n,
  contents: C,
  snapshots: P,
  positions: positions.size,
  subset_evals: subsets,
  gen_ms: Math.round(genMs),
  admit_s: f1(admitMs / 1000),
  admitted,
  admit_ms_per_admitted: +(admitMs / Math.max(1, admitted)).toFixed(3),
  admit_ms_per_position: f1(admitMs / Math.max(1, subsets)),
  refused: Object.fromEntries(why),
  view_build_ms: Math.round(viewMs),
  heap_content_mb: heapAfter,
  rendered: windows * 50,
  hidden,
  hiddenBy: Object.fromEntries(hw),
  per_msg_ms: windows ? +(firstMs / (windows * 50)).toFixed(4) : null,
  window_median_ms_per_msg: windows ? +med(per).toFixed(4) : null,
  window_p99_ms_per_msg: windows ? +sorted[Math.floor(sorted.length * 0.99)].toFixed(4) : null,
  rss_mb: rssMb(),
})
