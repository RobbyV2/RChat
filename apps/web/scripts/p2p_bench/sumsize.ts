// The summary the evaluator posts to the page (the first delta is all of it): its stored size and
// build time after a cold restore, and the cost of listing every member as the server view does.
// Usage: bun apps/web/scripts/p2p_bench/sumsize.ts [--events N] [--members M] [--reps 20]
import { toStored } from '../../app/lib/p2p/acl/summary'
import { AclRoom } from '../../app/lib/p2p/acl_room'
import { membersOf } from '../../app/lib/p2p/state'
import { universe } from './gossip'
import { args, binds, emit, f1, LIM } from './world'

const a = args()
const u = universe(a)
const R = a.num('reps', 20)
const room = new AclRoom('g0', { binds, agreed: LIM })
room.restoreEvs(u.items)
room.r.state()
const t0 = performance.now()
const s = room.summary()
const sumMs = performance.now() - t0
const json = JSON.stringify(toStored(s))
const t1 = performance.now()
for (let r = 0; r < R; r++)
  membersOf(s)
    .filter(m => m.m === 'join')
    .map(m => ({ ik: m.ik, m: m.m, roles: [...(m.roles ?? [])].sort(), name: m.profile?.name }))
emit('sumsize', {
  shape: u.shape,
  members: u.members,
  events: u.items.length,
  summary_members: Object.keys(s.members).length,
  summary_kb: Math.round(json.length / 1024),
  summary_ms: f1(sumMs),
  member_list_ms: +((performance.now() - t1) / R).toFixed(2),
})
