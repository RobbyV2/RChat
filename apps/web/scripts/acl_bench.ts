// Benchmark of the production ACL evaluator (spec §5, §7.7): builds each worst-case shape of
// notes/acl-model/bench.ts (copied below) with the production admission and evaluator, and times,
// single-threaded: a full evaluation from scratch (index plus stratum loop), an honest event on the
// heads (admission, append, new state), and a backdated deny (admission, append, re-run), then the
// re-run alone. Production limits, with ts in minutes as in the model's benchmark.
// Usage: bun apps/web/scripts/acl_bench.ts <shape|all> [events=20000] [seed=1] [reps=3]
import { loadavg } from 'node:os'
import { AclReplica, identityHead, pastOf, type Verdict } from '../app/lib/p2p/acl/admit'
import { AclState } from '../app/lib/p2p/acl/cache'
import {
  BAN,
  idOp,
  INVITE,
  KICK,
  LIM,
  ROLES,
  setLimits,
  type AclContent,
  type AclEv,
} from '../app/lib/p2p/acl/rules'

type Obj = Record<string, unknown>
interface Opts {
  ap?: string[]
  keepOwn?: boolean
  seq?: number
  aprev?: string | null
  iprev?: string | null
  ts?: number
}
const devOwner = (dev: string) => dev.replace(/[0-9]+$/, '')

class Rng {
  constructor(public s: number) {
    if (!this.s) this.s = 1
  }
  next() {
    let x = this.s
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    this.s = x >>> 0
    return this.s / 4294967296
  }
  int(n: number) {
    return Math.floor(this.next() * n)
  }
  pick<T>(a: readonly T[]): T {
    return a[this.int(a.length)]
  }
  chance(p: number) {
    return this.next() < p
  }
  shuffle<T>(a: T[]): T[] {
    const b = [...a]
    for (let i = b.length - 1; i > 0; i--) {
      const j = this.int(i + 1)
      const t = b[i]
      b[i] = b[j]
      b[j] = t
    }
    return b
  }
}

// A scenario builder over the production replica (the model's fastworld.ts): heads and each
// device's latest event tracked incrementally; like an honest client, `build` fills the acting
// identity of revocations and the remover's watermark of kick, ban and revoke.
class BenchWorld {
  ref = new AclReplica({ binds: e => devOwner(e.dev) === e.a })
  n = 0
  private headSet = new Set<string>()
  private lastOwn = new Map<string, AclEv>()
  heads(): string[] {
    return [...this.headSet]
  }
  latestOwn(dev: string): AclEv | undefined {
    return this.lastOwn.get(dev)
  }
  private note(e: AclEv, v: Verdict) {
    if (v.s !== 'A') return
    for (const p of e.ap) this.headSet.delete(p)
    this.headSet.add(e.id)
    const l = this.lastOwn.get(e.dev)
    if (!l || e.seq > l.seq) this.lastOwn.set(e.dev, e)
  }
  genesis(dev: string, owners: string[], everyone = 0, ts = 0): AclEv {
    const e: AclEv = {
      id: `g${this.n++}`,
      t: 'genesis',
      a: devOwner(dev),
      dev,
      seq: 0,
      ap: [],
      ts,
      c: {
        rules: 2,
        nonce: 'n',
        owners: owners.map(ik => ({ ik })),
        everyone_bits: everyone,
        name: 'S',
      } as unknown as AclContent,
    }
    this.note(e, this.ref.receive(e))
    return e
  }
  build(dev: string, t: string, c: Obj = {}, o: Opts = {}): AclEv {
    const a = devOwner(dev)
    const ix = this.ref.acl.ix
    const inC = (ap: string[], id: string) => {
      const i = ix.at.get(id)!
      return ap.some(p => p === id || ix.has(ix.at.get(p)!, i))
    }
    let ap = o.ap ? [...o.ap] : this.heads()
    if (o.ap && (o.keepOwn ?? (o.seq === undefined && o.aprev === undefined))) {
      const own = this.latestOwn(dev)
      if (own && !inC(ap, own.id)) ap.push(own.id)
    }
    ap = [...new Set(ap)]
    const B = pastOf(ix, ap)
    const inB = (i: number) => ((B.bits[i >>> 5] >>> (i & 31)) & 1) === 1
    let last: AclEv | undefined
    for (const x of ix.byDev.get(dev) ?? []) {
      if (!inB(x)) continue
      if (!last || ix.ev[x].seq > last.seq) last = ix.ev[x]
    }
    const ts = o.ts ?? Math.max(0, ...ap.map(p => this.ref.ev(p).ts)) + 1
    const cc = { ...c }
    if ((t === 'device_revoke' || t === 'primary_rotate') && cc.ik === undefined) cc.ik = a
    if ((t === 'kick' || t === 'ban' || (t === 'revoke' && cc.to !== a)) && cc.seen === undefined) {
      const seen: Record<string, number> = {}
      for (const x of ix.byAuthor.get(cc.to as string) ?? [])
        if (inB(x)) seen[ix.ev[x].dev] = Math.max(seen[ix.ev[x].dev] ?? -1, ix.ev[x].seq)
      cc.seen = seen
    }
    const e: AclEv = {
      id: `${t}.${dev}.${this.n++}`,
      t,
      a,
      dev,
      seq: o.seq ?? (last ? last.seq + 1 : 1),
      ap,
      ts,
      c: cc as AclContent,
    }
    const aprev = o.aprev === undefined ? last?.id : (o.aprev ?? undefined)
    if (aprev) e.aprev = aprev
    if (idOp(e, this.ref.acl.stateOf(ap).facts)) {
      const ip =
        o.iprev === undefined
          ? identityHead(a, B, t === 'primary_rotate').iprev
          : (o.iprev ?? undefined)
      if (ip) e.iprev = ip
    }
    return e
  }
  act(dev: string, t: string, c: Obj = {}, o: Opts = {}): { e: AclEv; v: Verdict } {
    const e = this.build(dev, t, c, o)
    const v = this.ref.receive(e)
    this.note(e, v)
    return { e, v }
  }
  state() {
    return this.ref.state()
  }
}

type W = BenchWorld
type Shape = (w: W, N: number, rng: Rng) => Record<string, number | string>

let clock = 1
const tick = (d = 1) => (clock += d)
let refusedRun = 0
const okF =
  (w: W) =>
  (dev: string, t: string, c: Obj = {}, o: Opts = {}) => {
    const r = w.act(dev, t, c, { ts: o.ts ?? tick(), ...o })
    if (r.v.s === 'A') {
      refusedRun = 0
      return r.e
    }
    // a shape that keeps proposing events the admission rules refuse would loop forever: fail loudly instead
    if (++refusedRun > 5000)
      throw new Error(
        `shape stalled: 5000 refusals in a row, last ${t} by ${dev}: ${JSON.stringify(r.v)}`
      )
    return undefined
  }

/**
 * Revision 4's universe (§7.7 history): an invite tree (everyone has Invite; each member invites up to two and posts a
 * chain of spaced events citing its own chain and its inviter's latest), members' forks, backlogs, 30 removals at
 * stratum 3 positioned before members' invite subtrees by six moderator devices, senior promotions of subtree members
 * citing random subsets of the removals (distinct protection views: many protection classes), removals at strata 7 and
 * ⊤, a moderator's leave, and honest activity to fill.
 */
const tree: Shape = (w, N, rng) => treeOf(w, N, rng, 0)
const treeOf = (w: W, N: number, rng: Rng, classes: number) => {
  const ok = okF(w)
  w.genesis('O1', ['O'], INVITE)
  ok('O2', 'device_add')
  ok('O3', 'device_add') // an idle owner device: the backdated deny's author
  const MOD = ok('O1', 'role_create', { pos: 3, bits: KICK | BAN })!.id
  const SEN = ok('O1', 'role_create', { pos: 7, bits: ROLES | KICK | BAN | INVITE })!.id
  ok('O1', 'role_create', { pos: 5, bits: 0 })
  const HIGH = w.ref.order[w.ref.order.length - 1]
  const HIGH2 = ok('O1', 'role_create', { pos: 6, bits: 0 })!.id
  for (const x of ['Q', 'R', 'S', 'T', 'U', 'V', 'W']) {
    ok('O1', 'add', { to: x }, { ts: tick(2) })
    ok(`${x}1`, 'join')
    ok(`${x}2`, 'device_add')
    ok('O1', 'assign', { to: x, role: 'QRS'.includes(x) ? MOD : SEN }, { ts: tick(2) })
  }
  const P0 = w.heads()
  interface Mem {
    id: string
    dev: string
    join: AclEv
    last: AclEv
    inviter?: Mem
    depth: number
  }
  const members: Mem[] = []
  const queue: { id: string; inviter?: Mem; add?: AclEv }[] = []
  let nextId = 0
  const fresh = () => `m${nextId++}x`
  for (let i = 0; i < 4; i++) {
    const id = fresh()
    queue.push({ id, add: ok('O1', 'add', { to: id }, { ts: tick(2) }) })
  }
  const budgetMembers = Math.ceil(N / 15)
  let backlogs = 0,
    forks = 0
  while (queue.length && w.ref.order.length < N * 0.86) {
    const q = queue.shift()!
    if (!q.add) continue
    const j = ok(`${q.id}1`, 'join', {}, { ap: [q.add.id], ts: q.add.ts + 1 })
    if (!j) continue
    const m: Mem = {
      id: q.id,
      dev: `${q.id}1`,
      join: j,
      last: j,
      inviter: q.inviter,
      depth: (q.inviter?.depth ?? 0) + 1,
    }
    members.push(m)
    let ts = j.ts
    const post = (t: string, c: Obj, ap?: string[]) => {
      ts += 20 + rng.int(10)
      const e = ok(m.dev, t, c, {
        ap: ap ?? [m.last.id, ...(m.inviter ? [m.inviter.last.id] : [])],
        ts: Math.max(ts, m.inviter?.last.ts ?? 0),
      })
      if (e) {
        m.last = e
        ts = e.ts
      }
      return e
    }
    const kids = members.length + queue.length < budgetMembers ? 1 + rng.int(2) : 0
    for (let k = 0; k < kids; k++) {
      const id = fresh()
      const a = post('add', { to: id })
      if (!a) continue
      // W3(e): a third identity acknowledges the add before the join (the inviter's inviter, or the owner's second device)
      const g = m.inviter
      const vo = g
        ? ok(g.dev, 'mark', {}, { ap: [g.last.id, a.id], ts: Math.max(g.last.ts, a.ts) + 1 })
        : ok('O2', 'mark', {}, { ap: [a.id], ts: Math.max(a.ts, w.latestOwn('O2')?.ts ?? 0) + 1 })
      if (!vo) continue
      if (g) g.last = vo
      queue.push({ id, inviter: m, add: vo })
    }
    for (let k = 0; k < 9; k++) post(rng.chance(0.5) ? 'mark' : 'profile', { name: k % 3 })
    if (members.length % 12 === 5) {
      forks++
      let bts = j.ts,
        prev: string | undefined = undefined
      for (let k = 0; k < 4; k++) {
        const e = w.act(
          m.dev,
          'mark',
          {},
          {
            ap: prev ? [prev] : [j.id],
            keepOwn: false,
            seq: j.seq + 1 + k,
            aprev: prev ?? j.id,
            ts: (bts += 3),
          }
        )
        if (e.v.s === 'A') prev = e.e.id
      }
    }
    // a backlog of 12 marks at once (W3(b): with the join and the 9 posts, within the 24 unacknowledged)
    if (members.length % 40 === 7 && m.inviter) {
      backlogs++
      for (let k = 0; k < 12; k++) post('mark', {}, [m.last.id, m.inviter.last.id])
    }
  }
  const modDevs = ['Q1', 'Q2', 'R1', 'R2', 'S1', 'S2']
  const under = (m: Mem, v: Mem) => {
    for (let p: Mem | undefined = m; p; p = p.inviter) if (p === v) return true
    return false
  }
  const victims: Mem[] = []
  for (const m of rng.shuffle(members.filter(x => x.depth >= 2 && x.depth <= 7))) {
    if (victims.length >= 30) break
    if (!victims.some(v => under(m, v) || under(v, m))) victims.push(m)
  }
  const causes: AclEv[] = []
  victims.forEach((v, i) => {
    const md = modDevs[i % modDevs.length]
    const e = ok(
      md,
      i % 3 ? 'kick' : 'ban',
      { to: v.id },
      { ap: [v.join.id, ...P0], ts: Math.max(v.join.ts, w.latestOwn(md)?.ts ?? 0) + 1 }
    )
    if (e) causes.push(e)
  })
  const promoters = ['O1', 'O2', 'T1', 'T2', 'U1', 'U2', 'V1', 'V2', 'W1', 'W2']
  const subtree = (v: Mem) =>
    members.filter(m => {
      for (let p = m.inviter; p; p = p.inviter) if (p === v) return true
      return false
    })
  let promos = 0
  // `classes`: every promotion cites one of `classes` nested subsets of the removals, so the stratum has exactly that
  // many protection classes (2^classes + 1 worlds in the exact branch at the cap; 5a's class-cap worst case)
  const subsets = Array.from({ length: classes }, (_, c) =>
    causes.slice(0, Math.round(((c + 1) * causes.length) / (classes + 1))).map(x => x.id)
  )
  victims.forEach((v, i) => {
    for (const k of rng.shuffle(subtree(v)).slice(0, 2)) {
      const sub = classes
        ? subsets[(i + promos) % classes].filter(c => w.ref.ev(c).c.to !== v.id)
        : causes.filter(c => c.c.to !== v.id && rng.chance(0.5)).map(c => c.id)
      const pr = promoters[(i + promos) % promoters.length]
      const e = ok(
        pr,
        'assign',
        { to: k.id, role: pr.startsWith('O') ? HIGH2 : HIGH },
        {
          ap: [k.last.id, ...sub],
          ts: Math.max(k.last.ts, ...sub.map(s => w.ref.ev(s).ts), w.latestOwn(pr)?.ts ?? 0) + 1,
        }
      )
      if (e) promos++
    }
  })
  let higher = 0
  const hBy = ['T1', 'U1', 'V1', 'W1', 'O1', 'O2', 'Q1', 'R1', 'T2', 'U2', 'V2', 'W2']
  // at most 22 per device (W3(b): nobody acknowledges these old-position removals)
  for (const [j, m] of rng
    .shuffle(members)
    .slice(0, Math.min(Math.round(N / 75), 22 * hBy.length))
    .entries()) {
    const by = hBy[j % hBy.length]
    const e = ok(
      by,
      rng.chance(0.5) ? 'kick' : 'ban',
      { to: m.id },
      { ap: [m.last.id], ts: Math.max(m.last.ts, w.latestOwn(by)?.ts ?? 0) + 1 }
    )
    if (e) higher++
  }
  ok('S2', 'leave', {}, { ap: P0, ts: tick() })
  // fill: chatter, each mark citing the author's chain and another member's latest (members acknowledge each other)
  while (w.ref.order.length < N - 1) {
    const m = rng.pick(members),
      o = rng.pick(members)
    const e = ok(
      m.dev,
      'mark',
      {},
      {
        ap: o === m ? [m.last.id] : [m.last.id, o.last.id],
        ts: Math.max(m.last.ts, o.last.ts) + 30,
      }
    )
    if (e) m.last = e
  }
  const tgt = rng.pick(members.filter(m => m.depth <= 3))
  probe = { dev: 'O3', to: tgt.id, ap: [tgt.join.id] }
  return {
    members: members.length,
    sameStratumCauses: causes.length,
    promotions: promos,
    higherRemovals: higher,
    forks,
    backlogs,
  }
}

/** 5a's class-cap worst case: the tree with exactly CLASSES (production 6) protection classes at the removals' stratum */
const classes: Shape = (w, N, rng) => treeOf(w, N, rng, LIM.classes)

/**
 * [R4V I1] role-move storm, which is also 5a's position-hull worst case: six moderators (pos 10) move a role R (pos 1,
 * Kick | Ban) held by 300 members thousands of times, interleaved with the holders' rank-reading ops (bans of strangers,
 * which read the author's rank); a senior (pos 20) then kicks three of the moderators from a position before the storm,
 * so their moves are cut and the register is read through the position hull for every holder op.
 */
const storm: Shape = (w, N, rng) => stormOf(w, N, rng, false)
/**
 * 5a's position-hull worst case with the longest hull: as `storm`, but the three moderators that are kicked later post
 * every move of the last 60% alone, so every holder op after them reads the register through a hull over all of those
 * removable writes (|L*| ≈ 0.6 × moves).
 */
const hull: Shape = (w, N, rng) => stormOf(w, N, rng, true)
/**
 * The same storm with bit toggles instead of moves: the moderators (Roles | Invite) toggle Invite on R, which the
 * holders' bans don't use; every clear is a deny at the moderators' stratum whose readers are all holder ops.
 */
const bitstorm: Shape = (w, N, rng) => stormOf(w, N, rng, false, true)
const stormOf = (w: W, N: number, rng: Rng, top: boolean, bitsMode = false) => {
  const ok = okF(w)
  w.genesis('O1', ['O'], 0)
  ok('O2', 'device_add')
  const R = ok('O1', 'role_create', { pos: 1, bits: KICK | BAN | (bitsMode ? INVITE : 0) })!.id
  const MV = ok('O1', 'role_create', { pos: 10, bits: bitsMode ? ROLES | INVITE : ROLES })!.id
  const QV = ok('O1', 'role_create', { pos: 20, bits: KICK | BAN })!.id
  const mods = ['Ma', 'Mb', 'Mc', 'Md', 'Me', 'Mf']
  for (const x of [...mods, 'Q']) {
    ok('O1', 'add', { to: x }, { ts: tick(2) })
    ok(`${x}1`, 'join')
    ok('O1', 'assign', { to: x, role: x === 'Q' ? QV : MV }, { ts: tick(2) })
  }
  const P0 = w.heads()
  const holders: string[] = []
  for (let i = 0; i < 300; i++) {
    const id = `h${i}x`
    ok('O1', 'add', { to: id }, { ts: tick(2) })
    if (ok(`${id}1`, 'join') && ok('O1', 'assign', { to: id, role: R }, { ts: tick(2) }))
      holders.push(id)
  }
  let moves = 0,
    ops = 0,
    k = 0,
    inv = true
  while (w.ref.order.length < N - 10) {
    const late = top && w.ref.order.length > N * 0.4
    if (k++ % 6 === 0) {
      const md = `${mods[late ? moves % 3 : moves % 6]}1`
      if (bitsMode) {
        if (ok(md, 'role_bits', { role: R, bit: INVITE, on: !inv })) {
          inv = !inv
          moves++
        }
      } else if (ok(md, 'role_move', { role: R, pos: 2 + rng.int(8) })) moves++
    } else if (ok(`${rng.pick(holders)}1`, 'ban', { to: `s${rng.int(1e9)}` })) ops++
  }
  for (const m of ['Ma', 'Mb', 'Mc']) ok('Q1', 'kick', { to: m }, { ap: P0, ts: tick() })
  probe = { dev: 'Q1', to: 'Md', ap: P0 }
  return { holders: holders.length, roleMoves: moves, holderOps: ops }
}

/**
 * [R4V I1] many-strata ladder: the owner steps role H (held by Hd, Kick) down one position at a time, and Hd kicks one
 * member after each step, so every kick is its own stratum; filler members post marks. The backdated deny is the
 * owner's second device kicking Hd from before the ladder (every stratum's kick falls).
 */
const ladder: Shape = (w, N, rng) => {
  const ok = okF(w)
  w.genesis('O1', ['O'], 0)
  ok('O2', 'device_add')
  const steps = Math.min(1500, Math.floor(N / 8))
  const H = ok('O1', 'role_create', { pos: steps + 10, bits: KICK | BAN })!.id
  ok('O1', 'add', { to: 'Hd' }, { ts: tick(2) })
  ok('Hd1', 'join')
  ok('O1', 'assign', { to: 'Hd', role: H }, { ts: tick(2) })
  const P0 = w.heads()
  const mems: string[] = [],
    fill: string[] = []
  for (let i = 0; i < steps + 200; i++) {
    const id = `v${i}x`
    ok('O1', 'add', { to: id }, { ts: tick(2) })
    if (ok(`${id}1`, 'join')) (i < steps ? mems : fill).push(id)
  }
  let kicks = 0
  for (let i = 0; i < mems.length; i++) {
    ok('O1', 'role_move', { role: H, pos: steps + 9 - i }, { ts: tick(2) })
    if (ok('Hd1', 'kick', { to: mems[i] }, { ts: tick(2) })) kicks++
  }
  while (w.ref.order.length < N - 2) ok(`${rng.pick(fill)}1`, 'mark')
  probe = { dev: 'O2', to: 'Hd', ap: P0 }
  return { strataKicks: kicks }
}

/**
 * Members' maximum forks: every member forks its device at its join into 4 branches of 8 events each (no branch sees
 * another), and for half of them another member's mark witnesses one branch in good faith (N14's deceived witness);
 * moderators then remove 30 members from before their forks.
 */
const forks: Shape = (w, N, rng) => {
  const ok = okF(w)
  w.genesis('O1', ['O'], INVITE)
  ok('O2', 'device_add')
  const MOD = ok('O1', 'role_create', { pos: 3, bits: KICK | BAN })!.id
  ok('O1', 'add', { to: 'Q' }, { ts: tick(2) })
  ok('Q1', 'join')
  ok('Q2', 'device_add')
  ok('O1', 'assign', { to: 'Q', role: MOD }, { ts: tick(2) })
  const mems: { id: string; join: AclEv; tips: string[] }[] = []
  let branches = 0,
    witnessed = 0
  const chat: string[] = []
  for (let i = 0; i < 30; i++) {
    const id = `c${i}x`
    ok('O1', 'add', { to: id }, { ts: tick(2) })
    if (ok(`${id}1`, 'join')) chat.push(id)
  }
  let last = w.ref.order[w.ref.order.length - 1]
  while (w.ref.order.length < N - 200) {
    const id = `f${mems.length}x`
    ok('O1', 'add', { to: id }, { ap: [last], ts: tick(2) })
    const j = ok(`${id}1`, 'join', {}, { ap: [w.ref.order[w.ref.order.length - 1]], ts: tick() })
    if (!j) continue
    last = j.id
    const m = { id, join: j, tips: [] as string[] }
    for (let b = 0; b < 4; b++) {
      let prev = j.id
      for (let k = 0; k < 8; k++) {
        const r = w.act(
          `${id}1`,
          'mark',
          {},
          { ap: [prev], keepOwn: false, seq: j.seq + 1 + k, aprev: prev, ts: tick() }
        )
        if (r.v.s === 'A') prev = r.e.id
      }
      m.tips.push(prev)
      branches++
    }
    // N14's deceived witness, in good faith: another member's mark cites one branch tip and its own chain only
    if (mems.length && rng.chance(0.5)) {
      if (ok(`${rng.pick(mems).id}1`, 'mark', {}, { ap: [m.tips[rng.int(4)]], ts: tick() }))
        witnessed++
    }
    // the others chat at the heads (they acknowledge each other; W3(b))
    for (let k = 0; k < 2; k++) ok(`${rng.pick(chat)}1`, 'mark', {}, { ap: [last], ts: tick() })
    last = w.ref.order[w.ref.order.length - 1]
    mems.push(m)
  }
  // 30 removals from before the forks, by two moderator devices (W3(b): at most 24 unacknowledged per device)
  for (const [j, m] of rng.shuffle(mems).slice(0, 30).entries())
    ok(j % 2 ? 'Q2' : 'Q1', 'kick', { to: m.id }, { ap: [m.join.id], ts: tick() })
  // honest chatters fill at the heads (they cite every branch tip: a client cites its heads)
  while (w.ref.order.length < N - 2) ok(`${rng.pick(chat)}1`, 'mark', {}, { ts: tick() })
  const t = rng.pick(mems)
  probe = { dev: 'O2', to: t.id, ap: [t.join.id] }
  return { members: mems.length, branches, witnessed }
}

/**
 * The maximum stored growth W3(g) allows ([H20], spec §4.1): 40 removed members, each with 8 devices revoked while it
 * was a member and 8 live ones; after its removal each of the 16 chains posts its W3(b) budget of 24 marks from its old
 * tip, citing the owner's acknowledgement of the tip, round-robin: 384 = poolU unacknowledged events per member, the
 * most the bound allows (those whose concurrent pool overflows are pool candidates). Honest members fill the rest.
 */
const growth: Shape = (w, N, rng) => {
  const ok = okF(w)
  w.genesis('O1', ['O'], 0)
  ok('O2', 'device_add')
  const nR = Math.max(1, Math.floor((N * 0.85) / 440))
  const rem = Array.from({ length: nR }, (_, i) => `g${i}x`)
  const honest: string[] = []
  for (let i = 0; i < 30; i++) {
    const id = `n${i}x`
    ok('O1', 'add', { to: id }, { ts: tick(2) })
    if (ok(`${id}1`, 'join')) honest.push(id)
  }
  for (const x of rem) {
    ok('O1', 'add', { to: x }, { ts: tick(2) })
    ok(`${x}1`, 'join')
  }
  const chains = new Map<string, { dev: string; anchor: string }[]>(rem.map(x => [x, []]))
  // revoked devices 2..9 (W3(c): at most 8 device_adds per identity per day; rounds are spread over days)
  for (let k = 2; k <= 9; k++)
    for (const x of rem) {
      const dev = `${x}${k}`
      if (!ok(dev, 'device_add', {}, { ts: tick(3) })) continue
      const m = ok(dev, 'mark', {}, { ts: tick(3) })!
      const ack = ok('O1', 'mark', {}, { ts: tick(3) })!
      ok(`${x}1`, 'device_revoke', { dk: dev, seen: m.seq }, { ts: tick(3) })
      chains.get(x)!.push({ dev, anchor: ack.id })
    }
  // live devices 10..16
  for (let k = 10; k <= 16; k++)
    for (const x of rem)
      if (ok(`${x}${k}`, 'device_add', {}, { ts: tick(3) }))
        ok(`${x}${k}`, 'mark', {}, { ts: tick(3) })
  const ack = ok('O1', 'mark', {}, { ts: tick(3) })!
  for (const x of rem)
    for (const k of [1, 10, 11, 12, 13, 14, 15, 16])
      chains.get(x)!.push({ dev: `${x}${k}`, anchor: ack.id })
  for (const x of rem) ok('O1', 'kick', { to: x }, { ts: tick(3) })
  let post = 0
  for (let r = 0; r < LIM.totU; r++)
    for (const x of rem)
      for (const c of chains.get(x)!) {
        const tip = w.latestOwn(c.dev)?.id
        if (!tip) continue // a device_add W3(c) refused (small sizes: rounds closer than a day)
        if (
          w.act(c.dev, 'mark', {}, { ap: tip === c.anchor ? [tip] : [tip, c.anchor], ts: tick() }).v
            .s === 'A'
        )
          post++
      }
  while (w.ref.order.length < N - 2) ok(`${rng.pick(honest)}1`, 'mark')
  const t = rng.pick(honest)
  probe = { dev: 'O2', to: t, ap: [ack.id] }
  return {
    removed: nR,
    chainsPerRemoved: chains.get(rem[0])!.length,
    postRemoval: post,
    postPerRemoved: Math.round(post / nR),
  }
}

/**
 * [R4V I1] role-move storm at one rank, its worst form under 5b's rules: two colluding members acknowledge each other
 * (W3(b) then binds neither; W3(a) is the only limit), and the mover M (role MV, pos 5000, ROLES) steps role R
 * (pos 2100, ROLES | KICK) down one position per move from a position P0 before every holder op, so every move is a
 * deny at M's one stratum and concurrent with every holder op. The holders' ops are rank-reading: toggles of a bit of
 * role L (pos 1000), authorized only while R is above L. Moves below 1000 cut every holder op, so each holder op is
 * directly cut by about half of the moves. The burst is admitted after the main line (a backdated dump, dated across an
 * idle range). `moves` is the number of moves (default: a fifth of the events).
 */
const movestorm: Shape = (w, N, rng) => {
  const ok = okF(w)
  w.genesis('O1', ['O'], 0)
  ok('O2', 'device_add')
  const R = ok('O1', 'role_create', { pos: 2100, bits: ROLES | KICK })!.id
  const L = ok('O1', 'role_create', { pos: 1000, bits: 0 })!.id
  const MV = ok('O1', 'role_create', { pos: 5000, bits: ROLES })!.id
  for (const x of ['M', 'A']) {
    ok('O1', 'add', { to: x }, { ts: tick(2) })
    ok(`${x}1`, 'join')
  }
  ok('O1', 'assign', { to: 'M', role: MV }, { ts: tick(2) })
  const holders: string[] = []
  for (let i = 0; i < 200; i++) {
    const id = `h${i}x`
    ok('O1', 'add', { to: id }, { ts: tick(2) })
    if (ok(`${id}1`, 'join') && ok('O1', 'assign', { to: id, role: R }, { ts: tick(2) }))
      holders.push(id)
  }
  const P0 = w.heads()
  const nMoves = Math.min(1900, Math.round(N / 5))
  let on = false,
    ops = 0
  while (w.ref.order.length < N - 2 * nMoves - 4) {
    if (ok(`${rng.pick(holders)}1`, 'role_bits', { role: L, bit: KICK, on: !on }, { ts: tick() })) {
      on = !on
      ops++
    }
  }
  const main = w.heads()
  // the colluders' burst from P0: M's move, A's acknowledgement of it, M's next move citing it, ...
  let ack: string | undefined,
    moves = 0
  let ts = Math.max(...P0.map(p => w.ref.ev(p).ts)) + 1
  for (let k = 0; k < nMoves; k++) {
    const m = ok(
      'M1',
      'role_move',
      { role: R, pos: 2099 - Math.floor((k * 2000) / nMoves) },
      { ap: ack ? [ack] : P0, ts: (ts += 1) }
    )
    if (!m) break
    moves++
    ack = ok('A1', 'mark', {}, { ap: [m.id], ts: (ts += 1) })?.id
    if (!ack) break
  }
  probe = { dev: 'O2', to: 'M', ap: P0 }
  return { holders: holders.length, holderOps: ops, colluderMoves: moves, mainHeads: main.length }
}

/**
 * Colluders' backlog (N12, the bound W3(a) leaves): two members kicked from P0 acknowledge each other's marks from
 * their old position, as fast as W3(a) allows (60 per hour per device, dated across the idle range), every event cut
 * by the kicks; honest members fill the rest.
 */
const collude: Shape = (w, N, rng) => {
  const ok = okF(w)
  w.genesis('O1', ['O'], 0)
  ok('O2', 'device_add')
  const honest: string[] = []
  for (const x of ['Ca', 'Cb']) {
    ok('O1', 'add', { to: x }, { ts: tick(2) })
    ok(`${x}1`, 'join')
  }
  for (let i = 0; i < 100; i++) {
    const id = `n${i}x`
    ok('O1', 'add', { to: id }, { ts: tick(2) })
    if (ok(`${id}1`, 'join')) honest.push(id)
  }
  const P0 = w.heads()
  for (const x of ['Ca', 'Cb']) ok('O1', 'kick', { to: x }, { ts: tick() })
  const nC = Math.round(N * 0.45)
  while (w.ref.order.length < N - nC - 2) ok(`${rng.pick(honest)}1`, 'mark', {}, { ts: tick() })
  let prev: string[] = P0,
    ts = Math.max(...P0.map(p => w.ref.ev(p).ts)) + 1,
    posted = 0
  for (let k = 0; k < nC; k++) {
    const e = ok(k % 2 ? 'Cb1' : 'Ca1', 'mark', {}, { ap: prev, ts: (ts += 1) })
    if (!e) break
    prev = [e.id]
    posted++
  }
  const t = rng.pick(honest)
  probe = { dev: 'O2', to: t, ap: P0 }
  return { colluderEvents: posted }
}

/**
 * Step 4's exact branch at its cap: exactly CLASSES (6) protection classes at one stratum, each op in up to 2^6 worlds.
 * A moderator Q (pos 20) kicks members V1..V7 from P0: seven causes at Q's stratum. After P0, V1..V6 each post a mark
 * and V7 (role GV, pos 19, Roles) assigns roles. A lattice (its 14 members join through the owner's invites): V7 assigns
 * R0 (pos 18) to a root Z; Z, whose first assignment also cites V1..V6's marks (so every lattice op has all seven causes
 * in its past), assigns R1 to A1 and B1; for c = 2..6 both A(c-1) and B(c-1) assign Rc (pos 18 - c, Roles) to both Ac
 * and Bc, and Ac's first assignment cites both of its own; A6 and B6 assign R7 to a top member. An op of Ac needs Roles
 * from Rc, so it is broken in a world iff both of Ac's assignments are. The owner later promotes each Ac (HIGH, pos 30)
 * citing every kick but Vc's: Ac's ops are exposed to every cause but γc (class ALL minus γc); Bc and Z are exposed to
 * all (no class). A path from the top down through A or B at each layer reaches Z's assignments in each of the 2^6
 * worlds ALL minus C, C ⊆ {γ1..γ6}. Lattices fill 85% of the events; two filler members acknowledge the promotions.
 */
const exact6: Shape = (w, N) => {
  const ok = okF(w)
  w.genesis('O1', ['O'], 0)
  ok('O2', 'device_add')
  ok('O3', 'device_add') // idle: the backdated deny's author
  const PR = ['O1', 'O2', 'O4', 'O5', 'O6', 'O7'] // class c's promoter device
  for (const d of PR.slice(2)) ok(d, 'device_add')
  const MOD = ok('O1', 'role_create', { pos: 20, bits: KICK | BAN })!.id
  const HIGH = ok('O1', 'role_create', { pos: 30, bits: 0 })!.id
  const GV = ok('O1', 'role_create', { pos: 19, bits: ROLES })!.id
  const Rs = Array.from(
    { length: 8 },
    (_, c) => ok('O1', 'role_create', { pos: 18 - c, bits: ROLES })!.id
  )
  const member = (x: string) => {
    ok('O1', 'add', { to: x }, { ts: tick() })
    return ok(`${x}1`, 'join', {}, { ts: tick() })!.id
  }
  member('Q')
  ok('O1', 'assign', { to: 'Q', role: MOD }, { ts: tick() })
  // one device per kick (no kick cites another), each acknowledged by the owner (W3(d))
  for (let k = 2; k <= 7; k++) {
    ok(`Q${k}`, 'device_add', {}, { ts: tick() })
    ok('O1', 'mark', {}, { ts: tick() })
  }
  const V = ['v1x', 'v2x', 'v3x', 'v4x', 'v5x', 'v6x', 'v7x']
  const FL = PR.map((_, c) => `f${c + 1}x`) // class c's acknowledging member
  for (const x of [...V, ...FL, 'Hx']) member(x)
  ok('O1', 'assign', { to: 'v7x', role: GV }, { ts: tick() })
  // every lattice member joins first, on the heads (one evaluation for all their recorded states); everything after P0
  // cites chosen parents
  const per = 59,
    lattices = Math.max(1, Math.floor((N * 0.85) / per))
  const joinsOf: Map<string, string>[] = []
  for (let L = 0; L < lattices; L++) {
    const joins = new Map<string, string>()
    for (const x of [
      `z${L}x`,
      ...[1, 2, 3, 4, 5, 6].flatMap(c => [`a${L}c${c}x`, `b${L}c${c}x`]),
      `y${L}x`,
    ])
      joins.set(x, member(x))
    joinsOf.push(joins)
  }
  const P0 = w.heads()
  const dummy = V.slice(0, 6).map(v => ok(`${v}1`, 'mark', {}, { ap: P0, ts: tick() })!.id)
  const promos: { who: string; join: string; c: number }[] = []
  let made = 0,
    zAck: string[] = []
  for (let L = 0; L < lattices; L++) {
    const nm = (c: number, s: string) => `${s}${L}c${c}x`
    const z = `z${L}x`
    const joins = joinsOf[L]
    // got: member -> the assignments it holds its role through; last: its own latest event. V7's assignment cites the
    // previous root's first assignment, which acknowledges V7's previous one (W3(b))
    const got = new Map<string, string[]>([
      [
        z,
        [
          ok(
            'v7x1',
            'assign',
            { to: z, role: Rs[0] },
            { ap: [joins.get(z)!, ...zAck], ts: tick() }
          )!.id,
        ],
      ],
    ])
    const last = new Map<string, string>()
    let layer = [z]
    for (let c = 1; c <= 7; c++) {
      const next = c <= 6 ? [nm(c, 'a'), nm(c, 'b')] : [`y${L}x`]
      for (const m of layer)
        for (const T of next) {
          const ap = last.has(m)
            ? [last.get(m)!]
            : [...got.get(m)!, joins.get(m)!, ...(m === z ? dummy : [])]
          const g = ok(
            `${m}1`,
            'assign',
            { to: T, role: Rs[c] },
            { ap: [...ap, joins.get(T)!], ts: tick() }
          )!.id
          if (m === z && !last.has(m)) zAck = [g]
          last.set(m, g)
          if (!got.has(T)) got.set(T, [])
          got.get(T)!.push(g)
        }
      if (c <= 6) promos.push({ who: nm(c, 'a'), join: joins.get(nm(c, 'a'))!, c })
      layer = next
    }
    made++
  }
  // the kicks from P0 (Q's stratum), then the promotions citing every kick but Vc's: class c's promotions are one
  // owner device's chain, acknowledged by one member that cites nothing else (so no promotion has γc in its past)
  const kicks = V.map((v, i) => ok(`Q${i + 1}`, 'kick', { to: v }, { ap: P0, ts: tick() })!.id)
  const nP = new Array(6).fill(0)
  let fill = 0
  const fm = (c: number) => {
    const f = w.latestOwn(`${FL[c - 1]}1`)!.id,
      o = w.latestOwn(PR[c - 1])!.id
    if (ok(`${FL[c - 1]}1`, 'mark', {}, { ap: [f, o], ts: tick() })) fill++
  }
  for (const p of promos) {
    const d = PR[p.c - 1],
      f = w.latestOwn(`${FL[p.c - 1]}1`)!.id
    ok(
      d,
      'assign',
      { to: p.who, role: HIGH },
      { ap: [p.join, f, ...kicks.filter((_, i) => i !== p.c - 1)], ts: tick() }
    )
    if (++nP[p.c - 1] % 16 === 0) fm(p.c)
  }
  // fill: two of them acknowledge each other (after every promotion, so no class changes)
  for (let k = 0; w.ref.order.length < N - 2; k++) {
    const d = `${FL[k % 2]}1`,
      o = w.latestOwn(`${FL[(k + 1) % 2]}1`)!.id
    if (ok(d, 'mark', {}, { ap: [w.latestOwn(d)!.id, o], ts: tick() })) fill++
  }
  probe = { dev: 'O3', to: 'Hx', ap: P0 }
  return { lattices: made, promotions: promos.length, fillerMarks: fill }
}

const SHAPES: Record<string, Shape> = {
  tree,
  classes,
  storm,
  hull,
  bitstorm,
  ladder,
  forks,
  growth,
  movestorm,
  collude,
  exact6,
}

/** each shape names its adversarial arrival: a deny by `dev` (an idle senior device) positioned at `ap` */
let probe: { dev: string; to: string; ap: string[]; t?: string } | undefined

const probeOf = () => probe

const med = (xs: number[]) => {
  const v = [...xs].sort((p, q) => p - q)
  return v[Math.floor(v.length / 2)]
}
const f1 = (x: number) => +x.toFixed(1)

const args = process.argv.slice(2)
const shapeArg = args[0] ?? 'all'
const N = Number(args[1] ?? 20000)
const seed = Number(args[2] ?? 1)
const reps = Number(args[3] ?? 3)
setLimits({ win: 60, day: 1440 })
for (const name of shapeArg === 'all' ? Object.keys(SHAPES) : shapeArg.split(',')) {
  clock = 1
  probe = undefined
  const rng = new Rng(seed * 7919)
  const w = new BenchWorld()
  const tB = performance.now()
  const info = SHAPES[name](w, N, rng)
  const buildS = (performance.now() - tB) / 1000
  const ids = [...w.ref.order]
  const full: number[] = []
  let S = w.state()
  let fe = w.ref.acl.evaluation()
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now()
    const st = new AclState(w.ref)
    for (const id of ids) st.ix.add(id)
    S = st.state()
    full.push(performance.now() - t0)
    fe = st.evaluation()
  }
  const heads: number[] = []
  w.state()
  const bdDev = probeOf()?.dev
  const maxTs = () => Math.max(...w.ref.order.map(x => w.ref.ev(x).ts))
  for (let r = 0; r < reps; r++) {
    const h0 = performance.now()
    let h: { e: AclEv; v: Verdict } | undefined
    for (const dv of ['O1', 'O2', 'O3'].filter(x => x !== bdDev && w.latestOwn(x))) {
      h = w.act(dv, 'mark', {}, { ts: maxTs() + 1 })
      if (h.v.s === 'A') break
    }
    w.state()
    heads.push(performance.now() - h0)
    if (!h || h.v.s !== 'A') throw new Error(`head event not admitted: ${JSON.stringify(h?.v)}`)
  }
  const bd = probeOf()
  let denyMs = NaN
  let denyCuts = 0
  const rerun: number[] = []
  if (bd) {
    const before = w.state().cut.size
    const d0 = performance.now()
    const r = w.act(
      bd.dev,
      bd.t ?? 'kick',
      { to: bd.to },
      {
        ap: bd.ap,
        ts: Math.max(...bd.ap.map(p => w.ref.ev(p).ts), w.latestOwn(bd.dev)?.ts ?? 0) + 1,
      }
    )
    const after = w.state()
    denyMs = performance.now() - d0
    if (r.v.s !== 'A') throw new Error(`backdated deny not admitted: ${JSON.stringify(r.v)}`)
    denyCuts = after.cut.size - before
    for (let k = 0; k < reps; k++) {
      w.ref.acl.invalidate()
      const q0 = performance.now()
      w.state()
      rerun.push(performance.now() - q0)
    }
  }
  const st = fe.stats
  console.log(
    JSON.stringify({
      shape: name,
      events: ids.length,
      denies: ids.filter(x => w.ref.rec(x).cls === 'D').length,
      cut: S.cut.size,
      X: S.X.size,
      tail: S.tail.size,
      ...info,
      strata: st.strata,
      maxCauses: st.maxCauses,
      maxRegion: st.maxRegion,
      maxFlat: st.maxFlat,
      maxClasses: st.maxClasses,
      fallbacks: st.fallbacks,
      worlds: st.worlds,
      brokenTests: st.brokenTests,
      build_s: f1(buildS),
      full_ms: f1(med(full)),
      full_all: full.map(f1),
      head_ms: f1(med(heads)),
      head_all: heads.map(f1),
      deny_ms: f1(denyMs),
      rerun_ms: rerun.length ? f1(med(rerun)) : NaN,
      rerun_all: rerun.map(f1),
      denyCuts,
      rss_mb: Math.round(process.memoryUsage().rss / 2 ** 20),
      load1: f1(loadavg()[0]),
    })
  )
}
