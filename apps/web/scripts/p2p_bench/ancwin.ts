// The index's memory: bytes held by the ancestor bitsets (Ix.anc), and for each event the lowest
// index not among its ancestors (lo), so what a "prefix plus window" encoding keeping only [lo, i)
// as bits would hold (D2 item 6). Also the cold replica's heap after a restore.
// Usage: bun apps/web/scripts/p2p_bench/ancwin.ts [--events N] [--members M]
import { AclRoom } from '../../app/lib/p2p/acl_room'
import { universe } from './gossip'
import { args, binds, emit, gc, heapMb, LIM } from './world'

const a = args()
const u = universe(a)
gc()
const h0 = heapMb()
const room = new AclRoom('g0', { binds, agreed: LIM })
room.restoreEvs(u.items)
room.r.state()
gc()
const heapCold = heapMb() - h0
const ix = room.r.acl.ix
let bytes = 0
let winBytes = 0
let compBytes = 0
const wins: number[] = []
const nons: number[] = []
for (let i = 0; i < ix.n; i++) {
  bytes += ix.anc[i].byteLength
  let lo = 0
  while (lo < i && ix.has(i, lo)) lo++
  const w = i - lo
  wins.push(w)
  let pc = 0
  for (let x = lo; x < i; x++) if (ix.has(i, x)) pc++
  const non = w - pc
  nons.push(non)
  compBytes += Math.min(non * 4, Math.ceil(w / 32) * 4) + 8
  winBytes += Math.ceil(w / 32) * 4 + 8
}
wins.sort((p, q) => p - q)
nons.sort((p, q) => p - q)
const mb = (b: number) => +(b / 2 ** 20).toFixed(2)
emit('ancwin', {
  shape: u.shape,
  members: u.members,
  n: ix.n,
  anc_mb: mb(bytes),
  window_encoding_mb: mb(winBytes),
  window_median: wins[wins.length >> 1],
  window_p99: wins[Math.floor(wins.length * 0.99)],
  window_max: wins[wins.length - 1],
  min_of_window_or_complement_mb: mb(compBytes),
  nonanc_median: nons[nons.length >> 1],
  nonanc_max: nons[nons.length - 1],
  heap_cold_mb: heapCold,
})
