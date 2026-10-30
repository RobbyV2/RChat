import { check, citesAll, inviteOf, isLiveCode, type Candidate, type CheckCtx } from './auth'
import { PMap } from './pmap'
import {
  isPower,
  isPowerChain,
  isSelfRevoking,
  memberOf,
  membershipOf,
  rankOf,
  stateKey,
  type Membership,
  type StateEvent,
  type StateMap,
} from './state'

export { isPower } from './state'

// State resolution for P2P servers (note section 6), after Matrix's state resolution v2 with
// per-member chains on top. Every member holding the same state events ends with the same
// state, whatever order they came in, and incremental resolution (events added a few at a time)
// gives exactly what a replay of everything gives.
//
// Chains. Each state event names its sender's previous state event (`sprev`), so a member's
// state events form a chain, numbered from 0. Two of a member's events naming the same previous
// one are an equivocation: the branch holding the member's own self-revocation (handing
// ownership over, leaving, changing their own roles) wins, otherwise the one with the lowest id;
// the other branches are rejected, the member is flagged, and their power events past the fork
// (other than self-revocations) are ignored. Power events and leaving also name the member's
// latest accepted power event at their position (`pprev`).
//
// Position. A state event sits on the state heads its sender knew (`pstate`). The state at its
// position is the merge of those parents' states; the event is accepted there only if:
// - its position holds exactly its sender's previous accepted state event as their latest (so a
//   member can't fork themselves, or build on a state older than their own last act),
// - a power event's `pprev` is the sender's latest accepted power event at the position,
// - the rules allow it there (auth.ts) and its `auth` cites every key the rules read there.
// Rejected events stay stored and synced and are transparent: building on one means building on
// its accepted parents.
//
// Merging. Where branches meet, the branch whose position is deepest is the base. What the other
// branches hold that the base doesn't know (found through the chains, without walking the base)
// is the difference.
// - When its events only write their own keys (no power events, codes, invites signed for a code
//   or leaving), they are checked in order (effective time, depth, id) on top of the base's
//   state, at both their position and the merged state. A write loses to a concurrent later
//   write of the same key, and never replaces a value a concurrent power event put there.
//   Nothing else of the base changes.
// - Otherwise the full Matrix v2 algorithm runs: the conflicted set is every key
//   the branches disagree on plus every accepted event some branch doesn't know. Power events go
//   first, together with what they build on in that set, in reverse topological power order
//   (rank of the sender at the event's position, then effective time, then id); then the rest in
//   mainline order (the last of those power events among their ancestors, then effective time,
//   depth and id); each checked against the state resolved so far, falling back to the event's
//   position for keys not decided yet. Non-power events never undo a power event they didn't
//   know of. The keys all branches agree on are put back on top.
// One bound on taking back what a removed or demoted member did concurrently: an unprivileged
// event of theirs (an invite, a join or leave, a code) dated more than `skew` before the removal
// and at most `grace` state events past what the removal's author knew of their chain keeps
// standing on its own position. A stale kick doesn't take back weeks of history, and a removed
// member can't backdate their way past it (their chain gives them away).
export const RULES = 3

export const RESOLVE = {
  skew: 5 * 60_000,
  grace: 50,
  // Merges remembered (by their tips).
  cache: 1024,
}

// State types whose effect is privileged: no grace.
const PRIVILEGED = new Set([
  'create',
  'owner',
  'role',
  'roles',
  'channel',
  'name',
  'history',
  'system',
])

export interface Resolved {
  state: Map<string, StateEvent>
  // State events without state children.
  heads: string[]
  // Rejected where they sit.
  rejected: Set<string>
  // Accepted where they sit, but lost to a concurrent change in some merge of branches.
  lost: Set<string>
  // Accepted membership events and the membership their target had before.
  transitions: Map<string, Membership | null>
  // Where each joined member's current membership began.
  joins: Map<string, string>
  // State events taken into account.
  count: number
  // `pstate` parents and chain links not stored here (state still coming).
  gaps: number
  // Members who equivocated, and the chain number of their first fork.
  flagged: Map<string, number>
  // Each member's latest accepted power event (what their next one names as `pprev`).
  power: Map<string, string>
}

export const EMPTY_RESOLVED: Resolved = {
  state: new Map(),
  heads: [],
  rejected: new Set(),
  lost: new Set(),
  transitions: new Map(),
  joins: new Map(),
  count: 0,
  gaps: 0,
  flagged: new Map(),
  power: new Map(),
}

export const candidateOf = (e: StateEvent): Candidate => ({
  id: e.id,
  type: e.type,
  sender: e.sender,
  skey: e.skey,
  content: e.content,
  auth: e.auth,
})

// State heads: events of the set that no other event of the set names in `pstate`.
export const headsOf = (events: StateEvent[]) => {
  const ids = new Set(events.map(e => e.id))
  const parents = new Set<string>()
  for (const e of events) for (const p of e.pstate) if (ids.has(p) && p !== e.id) parents.add(p)
  return events
    .filter(e => !parents.has(e.id))
    .sort((a, b) => b.depth - a.depth || (a.id < b.id ? -1 : 1))
    .map(e => e.id)
}

// The state heads a new state event names (`pstate`, at most STATE_LIMITS.pstate): all of them,
// or past that the deepest half and the shallowest half, so stragglers get merged too.
export const parentsOf = (heads: string[], max = 10) =>
  heads.length <= max ? heads : [...heads.slice(0, max / 2), ...heads.slice(-max / 2)]

// ----- Resolved states -----

// Beside the state proper: each member's latest accepted state event (`c`) and power event (`p`),
// and counters the rules use (pending invites per member `i` and per code `k`, live codes `o`).
type Meta = StateEvent | number

interface RState {
  s: PMap<StateEvent>
  m: PMap<Meta>
}

const EMPTY: RState = { s: PMap.empty(), m: PMap.empty() }

// A persistent state as the rules read it (they only look keys up).
const sm = (p: PMap<StateEvent>) => p as unknown as StateMap

const CHAIN_K = (ik: string) => stateKey('#c', ik)
const POWER_K = (ik: string) => stateKey('#p', ik)
const INV_K = (ik: string) => stateKey('#i', ik)
const CINV_K = (code: string) => stateKey('#k', code)
const CODES_K = (ik: string) => stateKey('#o', ik)

const num = (m: PMap<Meta>, k: string) => (m.get(k) as number | undefined) ?? 0

const bump = (m: PMap<Meta>, k: string, d: number) => {
  const n = num(m, k) + d
  return n ? m.set(k, n) : m.delete(k)
}

const counted = (m: PMap<Meta>, e: StateEvent | undefined, d: number) => {
  if (!e) return m
  const inv = inviteOf(e)
  if (inv) return bump(m, 'by' in inv ? INV_K(inv.by) : CINV_K(inv.code), d)
  if (isLiveCode(e)) return bump(m, CODES_K(e.sender), d)
  return m
}

// Sets (or with undefined, removes) a key, keeping the counters right.
const put = (st: RState, k: string, e: StateEvent | undefined): RState => {
  const old = st.s.get(k)
  if (old === e) return st
  const m = counted(counted(st.m, old, -1), e, 1)
  return { s: e ? st.s.set(k, e) : st.s.delete(k), m }
}

const ctxOf = (st: RState, at: number): CheckCtx => ({
  at,
  invites: ik => num(st.m, INV_K(ik)),
  codeInvites: c => num(st.m, CINV_K(c)),
  codes: ik => num(st.m, CODES_K(ik)),
})

// The state a check in a merge sees: what is resolved so far, and for keys not decided yet the
// value at the event's own position (unless the merge rejected it). `own` keys always come from
// the position (the grace above).
const overlay = (
  top: PMap<StateEvent>,
  under: PMap<StateEvent>,
  failed: Set<string>,
  own?: ReadonlySet<string>
): StateMap => {
  const get = (k: string) => {
    if (own?.has(k)) return under.get(k)
    const v = top.get(k)
    if (v !== undefined) return v
    const u = under.get(k)
    return u && !failed.has(u.id) ? u : undefined
  }
  return { get, has: (k: string) => get(k) !== undefined } as unknown as StateMap
}

// A binary heap on a comparison.
class Heap<T> {
  private items: T[] = []

  constructor(private less: (a: T, b: T) => boolean) {}

  get size() {
    return this.items.length
  }

  push(x: T) {
    const a = this.items
    a.push(x)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!this.less(a[i], a[p])) break
      ;[a[i], a[p]] = [a[p], a[i]]
      i = p
    }
  }

  pop(): T | undefined {
    const a = this.items
    if (!a.length) return undefined
    const top = a[0]
    const last = a.pop() as T
    if (a.length) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < a.length && this.less(a[l], a[m])) m = l
        if (r < a.length && this.less(a[r], a[m])) m = r
        if (m === i) break
        ;[a[i], a[m]] = [a[m], a[i]]
        i = m
      }
    }
    return top
  }
}

interface Merged {
  st: RState
  // Events the merge rejected.
  failed: number[]
}

const chainKey = (e: StateEvent) => `${e.sender}\n${e.sprev ?? ''}`

// Events whose effect reaches past their own key into what concurrent events of others may do:
// power events, codes (their revocation and expiry end the invites signed for them), invites
// signed for a code (counted per code), and leaving (a code dies with its issuer). A difference
// holding one of them is resolved in full; any other only writes its own key.
const reaches = (e: StateEvent) =>
  isPower(e) ||
  isSelfRevoking(e) ||
  e.type === 'code' ||
  (e.type === 'member' && typeof e.content.code === 'string')

// ----- The resolver -----

// Resolves a room's state events. `add` takes events in any order; events that only extend what
// is known are worked out incrementally (with every position kept as a persistent map, so even
// a stale position costs only what differs), anything that changes the past (a missing parent
// arriving, a fork in someone's chain) replays everything.
export class Resolver {
  private events: StateEvent[] = []
  private index = new Map<string, number>()
  private chainKids = new Map<string, number[]>()
  // Ids processed events refer to that aren't here (yet).
  private missing = new Map<string, number>()

  private parents: number[][] = []
  private deps: number[][] = []
  private sprevOf: number[] = []
  private sidx: number[] = []
  // Off the member's chain: a link missing or broken, or a losing branch of an equivocation.
  private broken: boolean[] = []
  // Rejected whatever the state: broken, or a power event past its sender's fork.
  private forced: boolean[] = []
  private flagged = new Map<string, number>()
  private done: boolean[] = []
  private ok: boolean[] = []
  private effTs: number[] = []
  private adepth: number[] = []
  private rank: number[] = []
  private eparents: number[][] = []
  private pos: RState[] = []
  private after: (RState | null)[] = []
  private prevM: (Membership | null)[] = []
  private prevMember: (string | null)[] = []
  private prevOwn: (string | undefined)[] = []
  private tseq: number[] = []
  private lastOk: number[] = []
  private children: number[] = []
  private headSet = new Set<number>()
  private lostAt = new Set<number>()
  private cache = new Map<string, Merged>()
  private final: Merged | null = null
  private gaps = 0
  // Statistics, for tests.
  stats = { replays: 0, merges: 0, full: 0 }

  get count() {
    return this.events.length
  }

  has(id: string) {
    return this.index.has(id)
  }

  // Adds events (already known ones are skipped) and resolves.
  add(evs: Iterable<StateEvent>) {
    const fresh: number[] = []
    let replay = this.events.length === 0
    for (const e of evs) {
      if (this.index.has(e.id)) continue
      const i = this.events.length
      this.events.push(e)
      this.index.set(e.id, i)
      fresh.push(i)
      // Something already worked out refers to it, or it forks a chain.
      if (this.missing.has(e.id)) replay = true
      const ck = chainKey(e)
      const sib = this.chainKids.get(ck)
      if (sib) {
        sib.push(i)
        replay = true
      } else this.chainKids.set(ck, [i])
      // A self-revocation of an equivocator may change which of their branches wins.
      if (this.flagged.has(e.sender) && isSelfRevoking(e)) replay = true
    }
    if (!fresh.length) return
    if (replay || fresh.length > 64) return this.replay()
    for (const i of fresh) this.link(i)
    for (const i of fresh) this.prepare(i)
    for (const i of this.order(fresh)) this.process(i)
    this.final = null
  }

  // ----- Full replay -----

  private replay() {
    this.stats.replays += 1
    const n = this.events.length
    this.missing.clear()
    this.gaps = 0
    this.parents = new Array(n)
    this.deps = new Array(n)
    this.sprevOf = new Array<number>(n).fill(-1)
    this.sidx = new Array<number>(n).fill(-1)
    this.broken = new Array<boolean>(n).fill(false)
    this.forced = new Array<boolean>(n).fill(false)
    this.flagged = new Map()
    this.done = new Array<boolean>(n).fill(false)
    this.ok = new Array<boolean>(n).fill(false)
    this.effTs = new Array<number>(n).fill(0)
    this.adepth = new Array<number>(n).fill(0)
    this.rank = new Array<number>(n).fill(0)
    this.eparents = Array.from({ length: n }, () => [])
    this.pos = new Array<RState>(n).fill(EMPTY)
    this.after = new Array<RState | null>(n).fill(null)
    this.prevM = new Array<Membership | null>(n).fill(null)
    this.prevMember = new Array<string | null>(n).fill(null)
    this.prevOwn = new Array<string | undefined>(n).fill(undefined)
    this.tseq = new Array<number>(n).fill(-1)
    this.lastOk = new Array<number>(n).fill(-1)
    this.children = new Array<number>(n).fill(0)
    this.headSet = new Set()
    this.lostAt = new Set()
    this.cache = new Map()
    this.final = null
    const all = this.events.map((_, i) => i)
    for (const i of all) this.link(i)
    this.chains()
    for (const i of this.order(all)) this.process(i)
  }

  // Parents and dependencies of an event among those here.
  private link(i: number) {
    const e = this.events[i]
    const ps: number[] = []
    const ds = new Set<number>()
    const ref = (id: string | undefined, parent: boolean) => {
      if (id === undefined) return
      const j = this.index.get(id)
      if (j === undefined) {
        this.missing.set(id, (this.missing.get(id) ?? 0) + 1)
        if (parent) this.gaps += 1
        return
      }
      if (j === i) return
      ds.add(j)
      if (parent && !ps.includes(j)) {
        ps.push(j)
        this.children[j] = (this.children[j] ?? 0) + 1
        this.headSet.delete(j)
      }
    }
    for (const p of e.pstate) ref(p, true)
    for (const a of e.auth) ref(a, false)
    ref(e.sprev, false)
    ref(e.pprev, false)
    this.parents[i] = ps
    this.deps[i] = [...ds]
    if (e.sprev !== undefined && !this.index.has(e.sprev)) this.gaps += 1
    this.children[i] = this.children[i] ?? 0
    if (!this.children[i]) this.headSet.add(i)
  }

  // Chain number and validity of a new event (incremental: no fork, sender not flagged).
  private prepare(i: number) {
    const e = this.events[i]
    const sp = e.sprev === undefined ? -1 : (this.index.get(e.sprev) ?? -2)
    this.sprevOf[i] = sp
    if (sp === -1) this.sidx[i] = 0
    else if (sp >= 0 && this.events[sp].sender === e.sender && !this.broken[sp])
      this.sidx[i] = this.sidx[sp] + 1
    else this.sidx[i] = -1
    this.broken[i] = this.sidx[i] < 0
    this.forced[i] = this.broken[i]
    // Past an equivocator's fork, their power events are ignored (giving power up still counts).
    const f = this.flagged.get(e.sender)
    if (f !== undefined && this.sidx[i] > f && isPowerChain(e) && !isSelfRevoking(e))
      this.forced[i] = true
    this.done[i] = false
    this.ok[i] = false
    this.after[i] = null
    this.eparents[i] = []
    this.pos[i] = EMPTY
    this.tseq[i] = -1
    this.lastOk[i] = -1
  }

  // Chain numbers, forks and their picks, for everything.
  private chains() {
    const n = this.events.length
    for (let i = 0; i < n; i += 1) {
      const e = this.events[i]
      this.sprevOf[i] = e.sprev === undefined ? -1 : (this.index.get(e.sprev) ?? -2)
    }
    // Numbers along each chain (a broken link breaks what follows).
    const memo = (i: number) => {
      const stack: number[] = []
      let at = i
      while (this.sidx[at] === -1 && !this.broken[at]) {
        const sp = this.sprevOf[at]
        if (sp === -1) {
          this.sidx[at] = 0
          break
        }
        if (sp === -2 || this.events[sp].sender !== this.events[at].sender) {
          this.broken[at] = true
          break
        }
        stack.push(at)
        // Guard against a link loop (ids hash their links, so only a forgery could make one).
        if (stack.length > n) {
          for (const x of stack) this.broken[x] = true
          return
        }
        at = sp
      }
      for (let k = stack.length - 1; k >= 0; k -= 1) {
        const x = stack[k]
        const sp = this.sprevOf[x]
        if (this.broken[sp] || this.sidx[sp] < 0) this.broken[x] = true
        else this.sidx[x] = this.sidx[sp] + 1
      }
    }
    for (let i = 0; i < n; i += 1) if (this.sidx[i] === -1 && !this.broken[i]) memo(i)
    // Forks: a member's events naming the same previous one.
    const kids = new Map<number, number[]>()
    const roots = new Map<string, number[]>()
    for (let i = 0; i < n; i += 1) {
      if (this.broken[i]) continue
      const sp = this.sprevOf[i]
      if (sp === -1) {
        const s = this.events[i].sender
        const r = roots.get(s)
        if (r) r.push(i)
        else roots.set(s, [i])
      } else {
        const k = kids.get(sp)
        if (k) k.push(i)
        else kids.set(sp, [i])
      }
    }
    const forkedSenders = new Set<string>()
    for (const [s, r] of roots) if (r.length > 1) forkedSenders.add(s)
    for (const [p, k] of kids) if (k.length > 1) forkedSenders.add(this.events[p].sender)
    if (!forkedSenders.size) {
      for (let i = 0; i < n; i += 1) this.forced[i] = this.broken[i]
      return
    }
    // Whether a branch holds a self-revocation of its member.
    const revokes = new Map<number, boolean>()
    const holds = (i: number): boolean => {
      const hit = revokes.get(i)
      if (hit !== undefined) return hit
      // Iteratively, deepest first.
      const stack = [i]
      const order: number[] = []
      while (stack.length) {
        const x = stack.pop() as number
        if (revokes.has(x)) continue
        order.push(x)
        for (const c of kids.get(x) ?? []) if (!revokes.has(c)) stack.push(c)
      }
      for (let k = order.length - 1; k >= 0; k -= 1) {
        const x = order[k]
        revokes.set(
          x,
          isSelfRevoking(this.events[x]) || (kids.get(x) ?? []).some(c => revokes.get(c) === true)
        )
      }
      return revokes.get(i) as boolean
    }
    const pick = (cands: number[]) => {
      const withRev = cands.filter(holds)
      const pool = withRev.length ? withRev : cands
      return pool.reduce((a, b) => (this.events[a].id < this.events[b].id ? a : b))
    }
    const reject = (i: number) => {
      const stack = [i]
      while (stack.length) {
        const x = stack.pop() as number
        this.broken[x] = true
        stack.push(...(kids.get(x) ?? []))
      }
    }
    for (const s of forkedSenders) {
      let f = Infinity
      let cands = roots.get(s) ?? []
      let at = -1
      while (cands.length) {
        let w = cands[0]
        if (cands.length > 1) {
          f = Math.min(f, at < 0 ? -1 : this.sidx[at])
          w = pick(cands)
          for (const c of cands) if (c !== w) reject(c)
        }
        at = w
        cands = kids.get(w) ?? []
      }
      // A root fork (two first events) counts from -1.
      if (f !== Infinity) this.flagged.set(s, f)
    }
    // Power events past a member's fork are ignored (giving power up still counts).
    for (let i = 0; i < n; i += 1) {
      const e = this.events[i]
      this.forced[i] = this.broken[i]
      const f = this.flagged.get(e.sender)
      if (f === undefined || this.broken[i]) continue
      if (this.sidx[i] > f && isPowerChain(e) && !isSelfRevoking(e)) this.forced[i] = true
    }
  }

  // A topological order of `set` (its dependencies among the rest are processed already).
  private order(set: number[]) {
    const inSet = new Set(set)
    const left = new Map<number, number>()
    const users = new Map<number, number[]>()
    for (const i of set) {
      let k = 0
      for (const d of this.deps[i])
        if (inSet.has(d)) {
          k += 1
          const u = users.get(d)
          if (u) u.push(i)
          else users.set(d, [i])
        }
      left.set(i, k)
    }
    const out: number[] = []
    for (const i of set) if (left.get(i) === 0) out.push(i)
    for (let k = 0; k < out.length; k += 1)
      for (const u of users.get(out[k]) ?? []) {
        const r = (left.get(u) as number) - 1
        left.set(u, r)
        if (r === 0) out.push(u)
      }
    // Events stuck in a cycle (nobody can make one: ids hash their links) stay unprocessed and
    // count as rejected.
    return out
  }

  // ----- Positions -----

  private sidxOf(e: Meta | undefined) {
    if (!e || typeof e === 'number') return -1
    const i = this.index.get(e.id)
    return i === undefined ? -1 : this.sidx[i]
  }

  // Whether a state knows accepted event `x` (holds it among its ancestors): its chain says
  // so, as accepted events of a member are linear and each one's position holds the previous.
  private knows(st: RState, x: number) {
    return this.sidxOf(st.m.get(CHAIN_K(this.events[x].sender))) >= this.sidx[x]
  }

  // Accepted events a set of parents stands for (rejected ones by their own).
  private accepted(ps: number[]) {
    const out = new Set<number>()
    for (const p of ps) {
      if (!this.done[p]) continue
      if (this.ok[p]) out.add(p)
      else for (const q of this.eparents[p]) out.add(q)
    }
    return [...out]
  }

  private process(i: number) {
    const e = this.events[i]
    let ts = e.ts
    for (const p of this.parents[i]) ts = Math.max(ts, this.effTs[p])
    const sp = this.sprevOf[i]
    if (sp >= 0) ts = Math.max(ts, this.effTs[sp])
    this.effTs[i] = ts
    const eps = this.accepted(this.parents[i])
    this.eparents[i] = eps
    let depth = 0
    for (const p of eps) depth = Math.max(depth, this.adepth[p] + 1)
    this.adepth[i] = depth
    const merged = this.merge(eps)
    for (const f of merged.failed) this.lostAt.add(f)
    const before = merged.st
    this.pos[i] = before
    this.lastOk[i] = sp >= 0 ? (this.ok[sp] ? sp : this.lastOk[sp]) : -1
    const key = stateKey(e.type, e.skey)
    this.rank[i] = rankOf(sm(before.s), e.sender)
    this.prevOwn[i] = before.s.get(key)?.id
    if (e.type === 'member') {
      this.prevM[i] = membershipOf(sm(before.s), e.skey)
      this.prevMember[i] = memberOf(sm(before.s), e.skey)?.id ?? null
    }
    if ((e.type === 'member' || e.type === 'roles') && e.skey !== e.sender)
      this.tseq[i] = this.sidxOf(before.m.get(CHAIN_K(e.skey)))
    const last = this.lastOk[i] >= 0 ? this.events[this.lastOk[i]] : undefined
    const cand = candidateOf(e)
    const ok =
      !this.forced[i] &&
      before.m.get(CHAIN_K(e.sender)) === last &&
      (!isPowerChain(e) ||
        (before.m.get(POWER_K(e.sender)) as StateEvent | undefined)?.id === e.pprev) &&
      check(cand, sm(before.s), ctxOf(before, ts)) === null &&
      citesAll(
        sm(before.s),
        cand,
        id => {
          const j = this.index.get(id)
          return j === undefined ? undefined : this.events[j]
        },
        // Rejected citations don't count, except an equivocator's losing branch: whoever cited
        // it couldn't know (the rules still run against the position).
        id => {
          const j = this.index.get(id)
          return j === undefined || !this.done[j] || (!this.ok[j] && !this.forced[j])
        }
      )
    this.ok[i] = ok
    this.done[i] = true
    if (ok) this.after[i] = this.accept(before, i)
  }

  private accept(st: RState, i: number): RState {
    const e = this.events[i]
    const next = put(st, stateKey(e.type, e.skey), e)
    let m = next.m.set(CHAIN_K(e.sender), e)
    if (isPowerChain(e)) m = m.set(POWER_K(e.sender), e)
    return { s: next.s, m }
  }

  // A member's latest chain or power entry: the later one.
  private later(m: PMap<Meta>, k: string, e: StateEvent) {
    return this.sidxOf(m.get(k)) >= this.sidxOf(e) ? m : m.set(k, e)
  }

  private entries(st: RState, x: number): RState {
    const e = this.events[x]
    let m = this.later(st.m, CHAIN_K(e.sender), e)
    if (isPowerChain(e)) m = this.later(m, POWER_K(e.sender), e)
    return m === st.m ? st : { s: st.s, m }
  }

  // Events reachable from `starts` (over accepted parents) that `unknown` says aren't known,
  // without walking past known ones.
  private collect(starts: number[], unknown: (x: number) => boolean) {
    const out: number[] = []
    const seen = new Set<number>()
    const stack = [...starts]
    while (stack.length) {
      const x = stack.pop() as number
      if (seen.has(x)) continue
      seen.add(x)
      if (!unknown(x)) continue
      out.push(x)
      for (const p of this.eparents[x]) if (!seen.has(p)) stack.push(p)
    }
    return out
  }

  private ordered = (a: number, b: number) =>
    this.effTs[a] - this.effTs[b] ||
    this.adepth[a] - this.adepth[b] ||
    (this.events[a].id < this.events[b].id ? -1 : 1)

  // The state after the states of accepted events `eps` meet.
  private merge(eps: number[]): Merged {
    if (!eps.length) return { st: EMPTY, failed: [] }
    if (eps.length === 1) return { st: this.after[eps[0]] as RState, failed: [] }
    let tips = [...new Set(eps)]
    tips = tips.filter(t => !tips.some(u => u !== t && this.knows(this.after[u] as RState, t)))
    if (tips.length === 1) return { st: this.after[tips[0]] as RState, failed: [] }
    const key = tips
      .map(t => this.events[t].id)
      .sort()
      .join(',')
    const hit = this.cache.get(key)
    if (hit) return hit
    this.stats.merges += 1
    let base = tips[0]
    for (const t of tips)
      if (
        this.adepth[t] > this.adepth[base] ||
        (this.adepth[t] === this.adepth[base] && this.events[t].id < this.events[base].id)
      )
        base = t
    const top = this.after[base] as RState
    const others = tips.filter(t => t !== base)
    const diff = this.collect(others, x => !this.knows(top, x))
    const out = diff.some(x => reaches(this.events[x]))
      ? this.full(tips, base)
      : this.light(base, diff)
    this.cache.set(key, out)
    if (this.cache.size > RESOLVE.cache) this.cache.delete(this.cache.keys().next().value as string)
    return out
  }

  // No power events in the difference: its events on top of the base.
  private light(base: number, diff: number[]): Merged {
    let top = this.after[base] as RState
    const failed: number[] = []
    const failedIds = new Set<string>()
    diff.sort(this.ordered)
    for (const x of diff) {
      top = this.iterate(x, top, failed, failedIds, true)
      top = this.entries(top, x)
    }
    return { st: top, failed }
  }

  // Matrix state resolution v2 over the whole conflicted set.
  private full(tips: number[], base: number): Merged {
    this.stats.full += 1
    const states = tips.map(t => this.after[t] as RState)
    const known = (x: number) => states.every(st => this.knows(st, x))
    const diff = this.collect(tips, x => !known(x))
    const baseSt = this.after[base] as RState
    const conflicted = new Set<string>()
    for (const st of states) if (st !== baseSt) PMap.diff(baseSt.s, st.s, k => conflicted.add(k))
    const set = new Set(diff)
    for (const k of conflicted)
      for (const st of states) {
        const v = st.s.get(k)
        if (v) {
          const j = this.index.get(v.id)
          if (j !== undefined) set.add(j)
        }
      }
    let top = baseSt
    for (const k of conflicted) top = put(top, k, undefined)
    const failed: number[] = []
    const touched = new Set<string>()
    const step = (x: number) => {
      const n0 = failed.length
      top = this.iterate(x, top, failed, failedIds, false)
      top = this.entries(top, x)
      const passed = failed.length === n0
      if (passed) touched.add(stateKey(this.events[x].type, this.events[x].skey))
      return passed
    }
    const failedIds = new Set<string>()
    // Power events, with what they build on in the set.
    const powerSet = new Set<number>()
    const stack = [...set].filter(x => isPower(this.events[x]))
    while (stack.length) {
      const x = stack.pop() as number
      if (powerSet.has(x)) continue
      powerSet.add(x)
      for (const d of this.deps[x]) if (set.has(d) && !powerSet.has(d)) stack.push(d)
      for (const p of this.eparents[x]) if (set.has(p) && !powerSet.has(p)) stack.push(p)
    }
    const left = new Map<number, number>()
    const users = new Map<number, number[]>()
    for (const x of powerSet) {
      const ds = new Set([...this.deps[x], ...this.eparents[x]].filter(d => powerSet.has(d)))
      left.set(x, ds.size)
      for (const d of ds) {
        const u = users.get(d)
        if (u) u.push(x)
        else users.set(d, [x])
      }
    }
    const heap = new Heap<number>((a, b) =>
      this.rank[a] !== this.rank[b]
        ? this.rank[a] > this.rank[b]
        : this.effTs[a] !== this.effTs[b]
          ? this.effTs[a] < this.effTs[b]
          : this.events[a].id < this.events[b].id
    )
    for (const x of powerSet) if (left.get(x) === 0) heap.push(x)
    const applied = new Map<number, number>()
    const firstPass = new Set<number>()
    while (heap.size) {
      const x = heap.pop() as number
      firstPass.add(x)
      if (step(x) && isPower(this.events[x])) applied.set(x, applied.size + 1)
      for (const u of users.get(x) ?? []) {
        const r = (left.get(u) as number) - 1
        left.set(u, r)
        if (r === 0) heap.push(u)
      }
    }
    // Mainline: the last applied power event among an event's ancestors in the set.
    const all = [...set].sort((a, b) => this.adepth[a] - this.adepth[b])
    const mainline = new Map<number, number>()
    for (const x of all) {
      let m = applied.get(x) ?? 0
      for (const p of this.eparents[x]) m = Math.max(m, mainline.get(p) ?? 0)
      for (const d of this.deps[x]) m = Math.max(m, mainline.get(d) ?? 0)
      mainline.set(x, m)
    }
    const rest = all.filter(x => !firstPass.has(x))
    rest.sort(
      (a, b) => (mainline.get(a) as number) - (mainline.get(b) as number) || this.ordered(a, b)
    )
    for (const x of rest) step(x)
    // The keys every branch agrees on go back on top.
    for (const k of touched) if (!conflicted.has(k)) top = put(top, k, baseSt.s.get(k))
    return { st: top, failed }
  }

  // Checks event `x` of a merge against the state resolved so far.
  private iterate(
    x: number,
    top: RState,
    failed: number[],
    failedIds: Set<string>,
    light: boolean
  ): RState {
    const e = this.events[x]
    const key = stateKey(e.type, e.skey)
    const under = this.pos[x]
    const fail = () => {
      failed.push(x)
      failedIds.add(e.id)
      return top
    }
    if (!this.ok[x] || this.forced[x]) return fail()
    // A write that didn't know the current value: it never undoes a power event, and in a light
    // merge loses to a later concurrent write.
    const cur = top.s.get(key)
    if (cur && cur.id !== this.prevOwn[x]) {
      const ci = this.index.get(cur.id) as number
      if (!this.knows(under, ci)) {
        if (!isPower(e) && isPower(cur)) return fail()
        if (light && this.ordered(ci, x) > 0) return fail()
      }
    }
    const cand = candidateOf(e)
    const ctx = ctxOf(top, this.effTs[x])
    let pass = check(cand, overlay(top.s, under.s, failedIds), ctx) === null
    if (!pass && !isPower(e) && !PRIVILEGED.has(e.type)) {
      const own = [stateKey('member', e.sender), stateKey('roles', e.sender)]
      const changed = own.filter(k => top.s.get(k) !== under.s.get(k))
      const graced = (k: string) => {
        const by = top.s.get(k)
        if (!by || !isPower(by)) return false
        const r = this.index.get(by.id) as number
        if (this.knows(under, r)) return false
        return (
          this.effTs[r] - RESOLVE.skew > this.effTs[x] &&
          this.sidx[x] <= this.tseq[r] + RESOLVE.grace
        )
      }
      if (!own.includes(key) && changed.length && changed.every(graced))
        pass = check(cand, overlay(top.s, under.s, failedIds, new Set(own)), ctx) === null
    }
    if (!pass) return fail()
    return put(top, key, e)
  }

  // ----- Results -----

  private current(): Merged {
    if (this.final) return this.final
    const heads = this.headIdx()
    const merged = this.merge(this.accepted(heads))
    this.final = merged
    return merged
  }

  private headIdx() {
    return [...this.headSet]
  }

  // The current state without building a result: for members building their next event.
  view() {
    const st = this.current().st
    return {
      state: sm(st.s),
      heads: this.headIdx()
        .map(i => this.events[i])
        .sort((a, b) => b.depth - a.depth || (a.id < b.id ? -1 : 1))
        .map(e => e.id),
      power: (ik: string) => (st.m.get(POWER_K(ik)) as StateEvent | undefined)?.id,
    }
  }

  resolved(): Resolved {
    const merged = this.current()
    const n = this.events.length
    const rejected = new Set<string>()
    for (let i = 0; i < n; i += 1) if (!this.done[i] || !this.ok[i]) rejected.add(this.events[i].id)
    const lost = new Set<string>()
    for (const x of this.lostAt) lost.add(this.events[x].id)
    for (const x of merged.failed) lost.add(this.events[x].id)
    const transitions = new Map<string, Membership | null>()
    for (let i = 0; i < n; i += 1) {
      const e = this.events[i]
      if (e.type === 'member' && this.done[i] && this.ok[i] && !lost.has(e.id))
        transitions.set(e.id, this.prevM[i])
    }
    const state = new Map(merged.st.s.entries())
    const joins = new Map<string, string>()
    for (const e of state.values()) {
      if (e.type !== 'member' || e.content.m !== 'join') continue
      let at = this.index.get(e.id) as number
      for (
        let guard = 0;
        guard < n && this.prevM[at] === 'join' && this.prevMember[at];
        guard += 1
      ) {
        const j = this.index.get(this.prevMember[at] as string)
        if (j === undefined) break
        at = j
      }
      joins.set(e.skey, this.events[at].id)
    }
    const heads = this.headIdx()
      .map(i => this.events[i])
      .sort((a, b) => b.depth - a.depth || (a.id < b.id ? -1 : 1))
      .map(e => e.id)
    const power = new Map<string, string>()
    for (const [k, v] of merged.st.m)
      if (k.startsWith('#p\n') && typeof v !== 'number') power.set(k.slice(3), v.id)
    return {
      state,
      heads,
      rejected,
      lost,
      transitions,
      joins,
      count: n,
      gaps: this.gaps,
      flagged: new Map(this.flagged),
      power,
    }
  }
}

// Resolves a set of state events from scratch.
export const resolveState = (all: StateEvent[]): Resolved => {
  const r = new Resolver()
  r.add(all)
  return r.resolved()
}
