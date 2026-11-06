// The gossip overlay of one server room (recon-p2p-scale §2.8) and real frame sizes. Frames: a
// full `heads`, a 120-character message pushed and served, a full `want` and a one-id `ack`, each
// through the session's own encoding (chunks, AES-GCM, data frames). Overlay: each of `--members`
// M dials gossip.outTarget random others, accepted while the callee has fewer than gossip.perRoom
// links.
// A new event spreads hop by hop: a member that stores it announces its heads on every link, and
// a neighbour without it pulls it once from every neighbour one hop closer (pulls on different
// links don't see each other). `--runs` events from random members.
// Usage: bun apps/web/scripts/p2p_bench/overlay.ts [--members M] [--runs 20] [--seed S]
import { buildEvent2 } from '../../app/lib/p2p/event_v2'
import {
  chunk,
  Cipher,
  dataPayload,
  encodeFrame,
  encodeMessage,
  FrameType,
  type Message,
} from '../../app/lib/p2p/frames'
import { newKeyPair } from '../../app/lib/p2p/keys'
import { LOCAL } from '../../app/lib/p2p/limits'
import { SYNC } from '../../app/lib/p2p/sync'
import { args, emit, Rng } from './world'

const a = args()
const author = { ik: newKeyPair(), dk: newKeyPair() }
const T0 = 1_700_000_000_000
const srv = buildEvent2(author, null, 'genesis', 'a', { rules: 2 }, { seq: 0 }, T0).id
const ids = Array.from(
  { length: 2 * SYNC.headsMax },
  (_, i) => buildEvent2(author, srv, 'mark', 'a', {}, { seq: i + 1 }, T0 + i).id
)
const msg = buildEvent2(
  author,
  srv,
  'msg',
  'c',
  { ch: 'Abc12345', body: 'x'.repeat(120) },
  { seq: 9, ap: ids.slice(0, 3), prev: ids.slice(3, 6), cprev: ids[6] },
  T0
).wire

const cipher = new Cipher(crypto.getRandomValues(new Uint8Array(32)))
const wireBytes = async (m: Message) => {
  let n = 0
  for (const part of chunk(encodeMessage(m))) {
    const { counter, ct } = await cipher.seal(part)
    n += encodeFrame(FrameType.Data, dataPayload(0, counter, ct)).length
  }
  return n
}
const headsMax = SYNC.headsMax
const frames = {
  heads_frame_bytes: await wireBytes({
    t: 'sheads',
    room: srv,
    heads: ids.slice(0, headsMax),
    state: ids.slice(headsMax, 2 * headsMax),
  }),
  push_frame_bytes: await wireBytes({ t: 'spush', room: srv, ev: msg }),
  events_frame_bytes: await wireBytes({ t: 'sevents', rid: 1, room: srv, evs: [msg], more: false }),
  event_bytes: JSON.stringify(msg).length,
  want_frame_bytes: await wireBytes({
    t: 'swant',
    rid: 1,
    room: srv,
    from: ids.slice(0, SYNC.fromMax),
    have: ids.slice(SYNC.fromMax, 2 * SYNC.fromMax),
    limit: SYNC.wantLimit,
  }),
  ack_frame_bytes: await wireBytes({ t: 'sack', room: srv, ids: [ids[0]] }),
}
emit('overlay', { kind: 'frames', heads_max: headsMax, ...frames })

const M = a.members
const runs = a.num('runs', 20)
const { perRoom, outTarget } = LOCAL.gossip
const rng = new Rng(M * a.seed)
const adj: number[][] = Array.from({ length: M }, () => [])
const out = new Int32Array(M)
for (let round = 0; round < 3; round++)
  for (let x = 0; x < M; x++) {
    let tries = 0
    while (out[x] < outTarget && adj[x].length < perRoom && tries++ < 50) {
      const y = rng.int(M)
      if (y === x || adj[x].includes(y) || adj[y].length >= perRoom) continue
      adj[x].push(y)
      adj[y].push(x)
      out[x]++
    }
  }
const links = adj.reduce((p, l) => p + l.length, 0) / M
let hopSum = 0
let hopMax = 0
let dup = 0
let unreached = 0
for (let r = 0; r < runs; r++) {
  const src = rng.int(M)
  const dist = new Int32Array(M).fill(-1)
  dist[src] = 0
  let q = [src]
  while (q.length) {
    const nq: number[] = []
    for (const x of q)
      for (const y of adj[x])
        if (dist[y] < 0) {
          dist[y] = dist[x] + 1
          nq.push(y)
        }
    q = nq
  }
  for (let v = 0; v < M; v++) {
    if (dist[v] < 0) {
      unreached++
      continue
    }
    hopSum += dist[v]
    hopMax = Math.max(hopMax, dist[v])
    if (v !== src) dup += adj[v].filter(y => dist[y] === dist[v] - 1).length
  }
}
const reached = runs * M - unreached
const copies = reached > runs ? dup / (reached - runs) : 0
emit('overlay', {
  kind: 'overlay',
  members: M,
  runs,
  per_room: perRoom,
  out_target: outTarget,
  links_mean: +links.toFixed(2),
  links_min: Math.min(...adj.map(l => l.length)),
  hops_mean: reached ? +(hopSum / reached).toFixed(2) : 0,
  hops_max: hopMax,
  unreached_share: +(unreached / (runs * M)).toFixed(4),
  event_copies_in_per_member: +copies.toFixed(2),
  heads_frames_out_per_member: +links.toFixed(2),
  heads_bytes_per_member_per_event: Math.round(links * frames.heads_frame_bytes),
  sent_bytes_per_member_per_event: Math.round(
    links * frames.heads_frame_bytes +
      copies * (frames.want_frame_bytes + frames.events_frame_bytes)
  ),
  heads_bytes_per_event_byte: +((links * frames.heads_frame_bytes) / frames.event_bytes).toFixed(1),
})
