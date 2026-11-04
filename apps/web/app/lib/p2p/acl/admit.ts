import { isKeyId } from '../keys'
import { deviceCertOk, genesisSrv } from './binding'
import { AclState } from './cache'
import { evidencePair, seenOf, type Header } from './equivocation'
import { emptyResult, fiOf, type EvalResult } from './facts'
import { AGREED, type Agreed } from '../limits'
import { EMPTY, type Ix } from './reach'
import {
  aclContentOk,
  admissible,
  canSend,
  classify,
  idOp,
  introduces,
  poster,
  relayed,
  MODBITS,
  ownersOf,
  perms,
  rank,
  RULES_VERSION,
  SERVER,
  TOP,
  type AclEv,
  type Cls,
  type Ctx,
  type Rank,
  type Rec,
} from './rules'

// Admission (spec §2): a pure function of an event and its causal past. `decide` is the port of
// the model's; `AclReplica.receive` is §2.1 without the wire checks (signatures, sizes) and the
// local hold, which the caller does.

// U: the server's genesis has a rules version this client doesn't know (§1.2): stored, no strike,
// shown read-only.
export type Verdict =
  | { s: 'A' }
  | { s: 'R'; why: string }
  | { s: 'P'; missing: string[] }
  | { s: 'M'; why: string }
  | { s: 'U'; rules: number }

// B(e) over an index: the closure of e's parents.
export interface Past {
  ix: Ix
  bits: Uint32Array
}
export const pastOf = (ix: Ix, ap: readonly string[]): Past => ({ ix, bits: ix.closure(ap).bits })
const inB = (B: Past, i: number) => i < B.ix.n && ((B.bits[i >>> 5] >>> (i & 31)) & 1) === 1
const inBId = (B: Past, id: string) => {
  const i = B.ix.at.get(id)
  return i !== undefined && inB(B, i)
}
const inPast = (B: Past, l: readonly number[] | undefined) => (l ?? EMPTY).filter(i => inB(B, i))

export interface AdmitOpts {
  // A1 device binding, a pure function of the event and its causal past (B(e), St(e); none for a
  // genesis): an event whose device isn't bound to its poster is refused. Default `certBinds`.
  binds: (e: AclEv, B?: Past, S?: EvalResult) => boolean
  // The limits the server agreed on (spec 4.1). Default `AGREED`.
  agreed?: Agreed
}

// The primary key of a's current epoch in B (§1.5 Primary): the `pcert` of the epoch's rotation
// when it names a key, else the identity key, which plays primary until Task 17 (§1.1).
function primaryOf(a: string, B: Past): string {
  const ix = B.ix
  const rots = inPast(B, ix.rotBy.get(a))
  const maxRot = rots.filter(r => !rots.some(r2 => r2 !== r && ix.has(r2, r)))
  const pc = maxRot.length === 1 ? ix.ev[maxRot[0]].c.pcert : undefined
  return isKeyId(pc) ? pc : a
}

// A1 for introductions (§1.1, §1.4): every genesis owner's bundle verifies to its identity over
// the digest of the genesis content (binding.ts), and the author's names the posting device; an
// introducing join's `idb` and a device_add's `dcert` certify the posting device for the author,
// signed by its primary over the server and the event's identity-chain position. A rotation's
// binding is its recovery signature (event.ts). Every other event's device must be live for its
// poster in St(e) (deviceOk).
export function certBinds(e: AclEv, B?: Past, S?: EvalResult): boolean {
  const c = e.c
  if (e.t === 'genesis') {
    const owners = c.owners ?? []
    let srv: string
    try {
      srv = genesisSrv(c)
    } catch {
      return false
    }
    return (
      owners.some(o => o.ik === e.a && o.dk === e.dev) &&
      owners.every(
        o => typeof o.dk === 'string' && deviceCertOk(o.ik, srv, o.ik, o.dk, '', o.dcert)
      )
    )
  }
  const intro = e.t === 'device_add' || (e.t === 'join' && S !== undefined && idOp(e, S.facts))
  if (!intro) return true
  if (!B || B.ix.genesis < 0 || !inB(B, B.ix.genesis)) return false
  const cert = e.t === 'join' ? (c.idb?.ik === e.a ? c.idb.dcert : undefined) : c.dcert
  const srv = B.ix.ids[B.ix.genesis]
  return deviceCertOk(primaryOf(e.a, B), srv, e.a, e.dev, e.iprev ?? '', cert)
}

// The identity-chain position for a new identity op of `a` with causal past B (§2.2, §2.3).
export function identityHead(
  a: string,
  B: Past,
  rotation: boolean,
  FI?: ReadonlyMap<string, number>
): { iprev?: string; depth: number; epoch: string; refused?: string } {
  const ix = B.ix
  const mine = inPast(B, ix.byAuthor.get(a)).filter(i => ix.rec[i].depth >= 0)
  const depthOf = (i: number) => ix.rec[i].depth
  const deepest = (l: number[]) => {
    let li = -1
    for (const i of l)
      if (
        li < 0 ||
        depthOf(i) > depthOf(li) ||
        (depthOf(i) === depthOf(li) && ix.ids[i] < ix.ids[li])
      )
        li = i
    return li
  }
  if (rotation) {
    const li = deepest(mine)
    return li < 0
      ? { depth: 0, epoch: '' }
      : { iprev: ix.ids[li], depth: depthOf(li) + 1, epoch: '' }
  }
  const rots = mine.filter(i => ix.ev[i].t === 'primary_rotate')
  const maxRot = rots.filter(r => !rots.some(r2 => r2 !== r && ix.has(r2, r)))
  if (maxRot.length > 1) return { depth: -1, epoch: '', refused: 'identity-forked' }
  const epoch = maxRot.length ? ix.ids[maxRot[0]] : ''
  if (FI && fiOf(FI, a, epoch) < Infinity) return { depth: -1, epoch, refused: 'identity-forked' }
  const inEpoch = epoch ? mine.filter(i => i === maxRot[0] || ix.has(i, maxRot[0])) : mine
  const li = deepest(inEpoch)
  return li < 0 ? { depth: 0, epoch } : { iprev: ix.ids[li], depth: depthOf(li) + 1, epoch }
}

// T is known in B: B holds a join by T or an add naming T.
const known = (T: string, B: Past) =>
  inPast(B, B.ix.joinEv.get(T)).length > 0 || inPast(B, B.ix.addEv.get(T)).length > 0
// W3 charges the denies that remove nothing from a member or invitee (§4.1).
export const chargedDeny = (e: AclEv, B: Past) =>
  (e.t === 'ban' && !known(e.c.to, B)) || e.t === 'role_move'
const exemptOf = (e: AclEv, cls: Cls, B: Past) =>
  (cls === 'D' && !chargedDeny(e, B)) || e.t === 'upgrade'

// Events the W3(b) total counts: every ACL event except leave, device_revoke, primary_rotate,
// upgrade (and genesis); a relayed revocation counts on its relayer's device chain.
export const totCounted = (t: string) =>
  t !== 'leave' &&
  t !== 'device_revoke' &&
  t !== 'primary_rotate' &&
  t !== 'upgrade' &&
  t !== 'genesis'
const w3bCounted = (e: AclEv) => totCounted(e.t) || relayed(e)

// The primary certificate of a's current epoch in B, and whether the epoch is split or forked.
function epochState(a: string, B: Past, FI: ReadonlyMap<string, number>) {
  const ix = B.ix
  const rots = inPast(B, ix.rotBy.get(a))
  const maxRot = rots.filter(r => !rots.some(r2 => r2 !== r && ix.has(r2, r)))
  if (maxRot.length > 1) return { pcert: '', split: true }
  const ep = maxRot.length ? ix.ids[maxRot[0]] : ''
  return {
    pcert: maxRot.length ? String(ix.ev[maxRot[0]].c.pcert ?? '') : '',
    split: fiOf(FI, a, ep) < Infinity,
  }
}

const seenAt = (e: AclEv, v: string): number | undefined => {
  const s = e.c.seen
  if (typeof s !== 'object' || s === null) return undefined
  const x = s[v]
  return typeof x === 'number' ? x : undefined
}

export function decide(
  e: AclEv,
  B: Past,
  S: EvalResult,
  opts: AdmitOpts = { binds: certBinds }
): { ok: true; rec: Rec } | { ok: false; why: string } {
  const ix = B.ix
  const L = ix.cx.lim
  const F = S.facts
  // §1.2: at most `ap` (10) ACL parents
  if (e.ap.length > L.ap) return { ok: false, why: 'ap' }
  if (!opts.binds(e, B, S)) return { ok: false, why: 'dev' }
  // A1 device, device chain, identity chain
  if ((S.F.get(e.dev) ?? Infinity) < Infinity) return { ok: false, why: 'forked' }
  const own = inPast(B, ix.byDev.get(e.dev)).sort((x, y) => ix.ev[x].seq - ix.ev[y].seq)
  const last = own.length ? own[own.length - 1] : -1
  if ((e.aprev ?? '') !== (last >= 0 ? ix.ids[last] : '')) return { ok: false, why: 'aprev' }
  if (last >= 0 && e.seq <= ix.ev[last].seq) return { ok: false, why: 'seq' }
  let depth = -1
  let epoch = ''
  if (idOp(e, F)) {
    const h = identityHead(e.a, B, e.t === 'primary_rotate', S.FI)
    if (h.refused) return { ok: false, why: h.refused }
    if ((e.iprev ?? '') !== (h.iprev ?? '')) return { ok: false, why: 'iprev' }
    depth = h.depth
    epoch = e.t === 'primary_rotate' ? e.id : h.epoch
  } else if (e.iprev) return { ok: false, why: 'iprev' }
  const maxSeqIn = (dev: string) => {
    let m = -1
    for (const i of inPast(B, ix.byDev.get(dev))) m = Math.max(m, ix.ev[i].seq)
    return m
  }
  if (e.t === 'device_revoke') {
    if (!(typeof e.c.seen === 'number' && e.c.seen >= maxSeqIn(e.c.dk)))
      return { ok: false, why: 'seen' }
  }
  if (e.t === 'primary_rotate') {
    const keep = new Set<string>(introduces(e))
    const dropped = new Set<string>()
    for (const x of inPast(B, ix.introBy.get(e.a)))
      for (const v of introduces(ix.ev[x])) if (!keep.has(v)) dropped.add(v)
    for (const v of dropped) if (!(seenOf(e, v) >= maxSeqIn(v))) return { ok: false, why: 'seen' }
  }
  // the remover's watermark covers the target's live devices (§1.4, §3.5)
  const seenTarget =
    e.t === 'kick' || e.t === 'ban' || (e.t === 'revoke' && e.c.to !== e.a)
      ? e.c.to
      : e.t === 'leave' || e.t === 'revoke'
        ? e.a
        : undefined
  if (seenTarget !== undefined) {
    const required = seenTarget !== e.a
    for (const v of F.devs.get(seenTarget) ?? []) {
      const s = seenAt(e, v)
      if (s === undefined ? required : s < maxSeqIn(v)) return { ok: false, why: 'seen' }
    }
  }
  if (e.t === 'proof' && !proofOk(e, B, S)) return { ok: false, why: 'proof' }
  // A2 timestamps: a causal lower bound only
  for (const p of e.ap) if (e.ts < ix.ev[ix.at.get(p)!].ts) return { ok: false, why: 'ts' }
  // A relayed revocation (§1.6) acts for its `ik` only in facts, k, self-deny and protection;
  // otherwise it is its relayer's event (device chain, W3, pool, acknowledgements) and never `ik`'s.
  // A relay of a record whose revocation B(e) already holds is a duplicate.
  const relay = relayed(e)
  if (
    relay &&
    inPast(B, ix.devRevEv.get(e.c.dk)).some(x => ix.ev[x].a === e.a && ix.ev[x].c.seen === e.c.seen)
  )
    return { ok: false, why: 'dup' }
  // A3 authority and guards
  if (!admissible(e, F, L)) return { ok: false, why: 'auth' }
  const { cls, self } = classify(e, F)
  const A = poster(e)
  const exempt = !relay && exemptOf(e, cls, B)
  const owner = F.owners.has(A)
  // W3(g) identity pool: U(e) = the events of e's poster in B(e) ∪ {e} that no event of another
  // poster in B(e) has in its past, computed from the parents' recorded pools.
  const ap = [...new Set(e.ap)]
  const poolFor = (X: string) => {
    const poolOf = new Map<string, Set<string>>()
    for (const p of ap) {
      const pi = ix.at.get(p)!
      if (poster(ix.ev[pi]) === X) poolOf.set(p, new Set(ix.rec[pi].pool ?? []))
    }
    const cand = new Set<string>()
    for (const P of poolOf.values()) for (const x of P) cand.add(x)
    return [...cand].filter(x =>
      ap.every(p => {
        const xi = ix.at.get(x)
        const pi = ix.at.get(p)!
        if (p !== x && !(xi !== undefined && ix.has(pi, xi))) return true
        const P = poolOf.get(p)
        return P !== undefined && P.has(x)
      })
    )
  }
  const pool = [...poolFor(A), e.id].sort()
  const unacked = new Set(pool.filter(x => x !== e.id))
  const unackedIdx = [...unacked].map(x => ix.at.get(x)!)
  // A4 deterministic windows (§4.1)
  if (!exempt) {
    const cap = perms(F, A) & MODBITS ? L.w3mod : L.w3
    let n = 0
    for (const x of own) if (!ix.rec[x].exempt && ix.ev[x].ts > e.ts - L.win) n++
    if (n + 1 > cap) return { ok: false, why: 'W3' }
  }
  if (w3bCounted(e)) {
    const mine = own.filter(x => w3bCounted(ix.ev[x]))
    if (mine.length + 1 > L.totU) {
      const un = mine.filter(x => unacked.has(ix.ids[x]))
      if (un.length + 1 > L.totU) return { ok: false, why: 'W3b' }
    }
  }
  // W3(e) vouched invites: a non-owner's join needs a live add for it that an owner posted, or
  // that an ACL event in B(e) of a third identity has in its past
  if (e.t === 'join' && !owner) {
    const inv = F.invited.get(e.a) ?? []
    const vouched = inv.some(g => F.owners.has(g.a) || thirdAck(ix.at.get(g.id)!, g.a, e.a, B))
    if (!vouched) return { ok: false, why: 'W3e' }
  }
  // W3(c) identity churn: device_adds of the identity within a day in any epoch, rotations within a day
  const inDay = (t: string) =>
    inPast(B, ix.byAuthor.get(e.a)).filter(i => ix.ev[i].t === t && ix.ev[i].ts > e.ts - L.day)
      .length
  if (e.t === 'device_add' && inDay('device_add') + 1 > L.idCap) return { ok: false, why: 'W3c' }
  if (e.t === 'primary_rotate' && inDay('primary_rotate') + 1 > L.rotCap)
    return { ok: false, why: 'W3c' }
  // W3(c) rotation total (non-owners): unacknowledged rotations
  if (e.t === 'primary_rotate' && !owner) {
    const n = unackedIdx.filter(i => ix.ev[i].a === e.a && ix.ev[i].t === 'primary_rotate').length
    if (n + 1 > L.rotTot) return { ok: false, why: 'W3c' }
  }
  // W3(d) fresh introductions (non-owners): unacknowledged device_adds
  if (e.t === 'device_add' && !owner) {
    const n = unackedIdx.filter(i => ix.ev[i].a === e.a && ix.ev[i].t === 'device_add').length
    if (n + 1 > L.freshCap) return { ok: false, why: 'W3d' }
  }
  // W3(f) no pinning (non-owners): no unacknowledged evidence pair of the poster's own (its relays
  // included) in B(e), outside the past of its rotations; a rotation may see one pair per key
  if (!owner) {
    const rotsB = inPast(B, ix.rotBy.get(A))
    const mineU = unackedIdx.filter(i => poster(ix.ev[i]) === A && !rotsB.some(r => ix.has(r, i)))
    const seenK = new Map<string, number>()
    const rotPrevU = new Set(
      mineU.filter(i => ix.ev[i].t === 'primary_rotate').map(i => ix.ev[i].iprev ?? '')
    )
    const lim = e.t === 'primary_rotate' ? 2 : 1
    for (const i of mineU) {
      const x = ix.ev[i]
      const r = ix.rec[i]
      const keys = [`${x.dev}|s${x.seq}`, `${x.dev}|a${x.aprev ?? ''}`]
      if (r.depth >= 0 && x.t !== 'genesis') {
        if (x.t === 'primary_rotate') keys.push(`rot|${x.a}`, `race|${x.iprev ?? ''}`)
        else {
          keys.push(`id|${r.epoch}|${x.iprev ?? ''}`)
          if (rotPrevU.has(x.iprev ?? '')) keys.push(`race|${x.iprev ?? ''}`)
        }
      }
      for (const k of keys) {
        const n = (seenK.get(k) ?? 0) + 1
        if (n > lim) return { ok: false, why: 'W3f' }
        seenK.set(k, n)
      }
    }
  }
  // W6 for primary_rotate: a rotation must change a fact
  if (e.t === 'primary_rotate') {
    const live = F.devs.get(e.a) ?? new Set<string>()
    const keepR = new Set<string>(introduces(e))
    const es = epochState(e.a, B, S.FI)
    const changes =
      [...live].some(v => !keepR.has(v)) ||
      !live.has(e.dev) ||
      String(e.c.pcert ?? '') !== es.pcert ||
      es.split
    if (!changes) return { ok: false, why: 'W6' }
  }
  // W5 live-state caps
  if (e.t === 'role_create' && F.roles.size + 1 > L.roles) return { ok: false, why: 'W5' }
  if (e.t === 'add') {
    let n = 0
    for (const ps of F.pending.values()) for (const p of ps) if (p.dev === e.dev) n++
    if (n + 1 > L.pendingPerDev) return { ok: false, why: 'W5' }
  }
  if (e.t === 'code') {
    let n = 0
    for (const cd of F.codes.values()) if (cd.dev === e.dev) n++
    if (n + 1 > (perms(F, e.a) & SERVER ? L.codesPerDevServer : L.codesPerDev))
      return { ok: false, why: 'W5' }
  }
  if (!owner && pool.length > L.poolU) return { ok: false, why: 'W3g' }
  return { ok: true, rec: { k: rank(F, e.a), cls, self, exempt, depth, epoch, local: S, pool } }
}

// Some event in B of an identity other than `a1` and `a2` has g in its past.
function thirdAck(g: number, a1: string, a2: string, B: Past) {
  const ix = B.ix
  const seen = new Set<number>()
  const st = [g]
  while (st.length) {
    const y = st.pop()!
    for (const z of ix.kids[y]) {
      if (seen.has(z) || !inB(B, z)) continue
      seen.add(z)
      const zp = poster(ix.ev[z])
      if (zp !== a1 && zp !== a2) return true
      st.push(z)
    }
  }
  return false
}

// A proof's headers: an evidence pair against one device (§2.3) that lowers F(v) below an
// admitted ACL event of v in B(e). E3 (an ACL event and a later content event that does not
// have it in its position) needs the content header's parents in B(e). The headers are trusted
// here: the wire layer verified both signatures and computed them (event.ts validate2, aclEvOf).
export interface ProofHeader extends Header {
  id: string
  L: 'a' | 'c'
  ap?: string[]
  cprev?: string
}
function proofOk(e: AclEv, B: Past, S: EvalResult): boolean {
  const { x, y } = e.c as unknown as { x: ProofHeader; y: ProofHeader }
  const ix = B.ix
  if (
    typeof x.dev !== 'string' ||
    x.dev !== y.dev ||
    !Number.isSafeInteger(x.seq) ||
    !Number.isSafeInteger(y.seq) ||
    typeof x.id !== 'string' ||
    typeof y.id !== 'string' ||
    x.id === y.id
  )
    return false
  let pair = false
  if (x.L === 'a' && y.L === 'a') pair = evidencePair(x, y)
  else if (x.L === 'c' && y.L === 'c') pair = x.seq === y.seq || (x.cprev ?? '') === (y.cprev ?? '')
  else {
    const [a, c] = x.L === 'a' ? [x, y] : [y, x]
    if (c.seq === a.seq) pair = true
    else if (c.seq > a.seq && Array.isArray(c.ap) && c.ap.every(p => inBId(B, p))) {
      const ai = ix.at.get(a.id)
      pair = ai === undefined || !(c.ap.includes(a.id) || c.ap.some(p => ix.has(ix.at.get(p)!, ai)))
    }
  }
  if (!pair) return false
  const f = Math.min(x.seq, y.seq)
  if (!(f < (S.F.get(x.dev) ?? Infinity))) return false
  return inPast(B, ix.byDev.get(x.dev)).some(i => ix.ev[i].seq >= f)
}

// A content event's header (L = "c"), as far as admission reads it.
export interface ContentHead {
  id: string
  t: string
  a: string
  dev: string
  seq: number
  ap: string[]
  ts: number
  c: Record<string, unknown> | null
}

// Content admission (§2.2, §3.5): the same decide with B = C(m.ap) (content never introduces a
// device, so its binding is Dev in St(m)): the device's chain (seq past
// its last ACL event in B, at most W4 events past it), the causal ts bound, and the content
// authority in St(m): Mem, Dev, the server not upgraded, and for the known kinds with content a
// channel `ch` that exists and lets it send.
export function decideContent(
  m: ContentHead,
  B: Past,
  S: EvalResult
): { ok: true; k: Rank } | { ok: false; why: string } {
  const ix = B.ix
  const F = S.facts
  if (!m.ap.length) return { ok: false, why: 'no-parents' }
  if ((S.F.get(m.dev) ?? Infinity) < Infinity) return { ok: false, why: 'forked' }
  let last = -1
  for (const i of inPast(B, ix.byDev.get(m.dev))) last = Math.max(last, ix.ev[i].seq)
  if (m.seq <= last) return { ok: false, why: 'seq' }
  if (m.seq - last > ix.cx.lim.w4) return { ok: false, why: 'W4' }
  for (const p of m.ap) if (m.ts < ix.ev[ix.at.get(p)!].ts) return { ok: false, why: 'ts' }
  if (F.upgraded.length) return { ok: false, why: 'auth' }
  if (!F.mem.has(m.a) || !(F.devs.get(m.a)?.has(m.dev) ?? false)) return { ok: false, why: 'auth' }
  // A content event held without its content (redacted where it came from) shows nothing and its
  // channel can't be read: its author must be able to send in some live channel.
  if (CHANNEL_CONTENT.includes(m.t) && m.c === null) {
    for (const [id, c] of F.channels) if (c.gone !== true && canSend(F, m.a, id)) return ok(m, F)
    return { ok: false, why: 'send' }
  }
  if (CHANNEL_CONTENT.includes(m.t)) {
    const ch = m.c?.ch
    if (typeof ch !== 'string') return { ok: false, why: 'channel' }
    const c = F.channels.get(ch)
    if (!c || c.gone === true) return { ok: false, why: 'channel' }
    if (!canSend(F, m.a, ch)) return { ok: false, why: 'send' }
  }
  return ok(m, F)
}

const ok = (m: ContentHead, F: EvalResult['facts']) => ({ ok: true as const, k: rank(F, m.a) })

// The known content kinds, all posted in a channel (§1.4); other kinds are opaque.
export const CHANNEL_CONTENT: readonly string[] = [
  'msg',
  'edit',
  'redact',
  'react',
  'pin',
  'call',
  'move',
]

// A genesis: seq 0, no parents, the author among the owners, rules version 2.
export const genesisOk = (e: AclEv) =>
  e.seq === 0 &&
  e.ap.length === 0 &&
  e.c.rules === RULES_VERSION &&
  ownersOf(e.c).includes(e.a) &&
  !e.aprev &&
  !e.iprev

// A replica of one server's ACL events: §2.1 receipt outcomes over the incremental state.
export class AclReplica implements Ctx {
  evs = new Map<string, AclEv>()
  status = new Map<string, Verdict>()
  recs = new Map<string, Rec>()
  order: string[] = []
  acl: AclState
  private waiting = new Map<string, AclEv[]>()
  opts: AdmitOpts
  readonly lim: Agreed
  constructor(opts: Partial<AdmitOpts> = {}) {
    this.opts = { binds: opts.binds ?? certBinds }
    this.lim = opts.agreed ?? AGREED
    this.acl = new AclState(this)
  }
  ev(id: string) {
    return this.evs.get(id)!
  }
  rec(id: string) {
    return this.recs.get(id)!
  }
  admitted(id: string) {
    return this.status.get(id)?.s === 'A'
  }
  // The current state Eval(S) of every admitted event.
  state(): EvalResult {
    return this.acl.state()
  }

  // The rules version of an unknown-rules genesis received (§1.2).
  unknownRules?: number

  receive(e: AclEv): Verdict {
    const known = this.status.get(e.id)
    if (known && known.s !== 'P') return known
    if (this.unknownRules !== undefined) {
      this.evs.set(e.id, e)
      return this.set(e.id, { s: 'U', rules: this.unknownRules })
    }
    if (!aclContentOk(e.t, e.c)) return { s: 'M', why: 'content' }
    if (e.t === 'genesis' && e.c.rules !== RULES_VERSION && !this.order.length) {
      this.unknownRules = e.c.rules
      this.evs.set(e.id, e)
      return this.set(e.id, { s: 'U', rules: e.c.rules as number })
    }
    this.evs.set(e.id, e)
    const v = this.try1(e)
    if (v.s !== 'P') this.settle(e.id)
    return v
  }

  // The verdict e would get now, without admitting it (an event to hold, §2.1): its parents are
  // admitted; a rejection is recorded, since it never changes.
  judge(e: AclEv): Verdict {
    const known = this.status.get(e.id)
    if (known && known.s !== 'P') return known
    if (this.unknownRules !== undefined) return { s: 'U', rules: this.unknownRules }
    if (!aclContentOk(e.t, e.c)) return { s: 'M', why: 'content' }
    if (e.t === 'genesis' || !e.ap.length) return this.receive(e)
    for (const p of e.ap) {
      const st = this.status.get(p)
      if (st?.s === 'R') return this.set(e.id, { s: 'R', why: 'parent' })
      if (!this.indexed(p)) return { s: 'P', missing: e.ap.filter(x => !this.indexed(x)) }
    }
    const d = decide(e, pastOf(this.acl.ix, e.ap), this.acl.stateOf(e.ap), this.opts)
    return d.ok ? { s: 'A' } : this.set(e.id, { s: 'R', why: d.why })
  }

  // An event admitted before, with its admission record (a cold start from storage).
  restore(e: AclEv, rec: Rec) {
    if (this.status.has(e.id)) return
    this.evs.set(e.id, e)
    this.recs.set(e.id, rec)
    this.admit(e)
  }

  // A dropped event's header from storage (spec 2.3): admitted before, evidence only, outside the
  // index until the whole event is fetched again.
  restoreHeader(e: AclEv, rec: Rec) {
    if (this.status.has(e.id)) return
    this.evs.set(e.id, e)
    this.recs.set(e.id, rec)
    this.status.set(e.id, { s: 'A' })
    this.acl.addHeader(e.id)
  }
  // Held in the index (a header is admitted, but nothing can build on it until it is fetched).
  indexed(id: string) {
    return this.admitted(id) && !this.acl.isHeader(id)
  }

  // The whole event of a header, fetched again (the same id, so the same core): indexed as it was
  // admitted. Not while a parent is still only a header (false): that parent comes first, whole.
  refill(e: AclEv): boolean {
    if (!this.acl.isHeader(e.id)) return true
    if (e.ap.some(p => this.acl.isHeader(p))) return false
    this.evs.set(e.id, e)
    this.acl.dropHeader(e.id)
    this.admit(e)
    this.settle(e.id)
    return true
  }
  // A header indexed from what it holds (content cites it, for that content's position), after any
  // header among its parents.
  indexHeader(id: string) {
    if (!this.acl.isHeader(id)) return
    for (const p of this.ev(id).ap) this.indexHeader(p)
    this.acl.dropHeader(id)
    this.admit(this.ev(id))
  }
  // The whole event of one indexed from its header: the same id and core, its content back.
  replace(e: AclEv) {
    const i = this.acl.ix.at.get(e.id)
    if (i === undefined || !this.admitted(e.id)) return
    this.evs.set(e.id, e)
    this.acl.ix.ev[i] = e
    this.acl.invalidate()
  }

  // Forgets an event that is not admitted (a rejection, kept as its verdict unless `all`; a pending
  // event the caller holds).
  forget(id: string, keepVerdict = false) {
    if (this.status.get(id)?.s === 'A') return
    this.evs.delete(id)
    if (!keepVerdict) this.status.delete(id)
    for (const [p, l] of this.waiting) {
      const k = l.filter(w => w.id !== id)
      if (k.length) this.waiting.set(p, k)
      else this.waiting.delete(p)
    }
  }

  // A stored event of a server whose rules version this client doesn't know.
  restoreUnknown(e: AclEv, rules: number) {
    this.unknownRules ??= rules
    this.evs.set(e.id, e)
    this.set(e.id, { s: 'U', rules: this.unknownRules })
  }

  private settle(id: string) {
    const q = [id]
    while (q.length) {
      const p = q.pop()!
      const ws = this.waiting.get(p)
      if (!ws) continue
      this.waiting.delete(p)
      for (const w of ws) {
        if (this.status.get(w.id)?.s !== 'P') continue
        if (this.try1(w).s !== 'P') q.push(w.id)
      }
    }
  }

  private set(id: string, v: Verdict): Verdict {
    this.status.set(id, v)
    return v
  }

  private try1(e: AclEv): Verdict {
    if (e.t === 'genesis') {
      if (this.order.length || !genesisOk(e) || !this.opts.binds(e))
        return this.set(e.id, { s: 'R', why: 'genesis' })
      this.recs.set(e.id, {
        k: TOP,
        cls: 'G',
        self: false,
        exempt: true,
        depth: 0,
        epoch: '',
        local: emptyResult(),
      })
      return this.admit(e)
    }
    if (!e.ap.length) return this.set(e.id, { s: 'R', why: 'no-parents' })
    const missing: string[] = []
    for (const p of e.ap) {
      const st = this.status.get(p)
      if (st?.s === 'R') return this.set(e.id, { s: 'R', why: 'parent' })
      if (!this.indexed(p)) missing.push(p)
    }
    if (missing.length) {
      for (const p of new Set(missing)) {
        const l = this.waiting.get(p)
        if (l) {
          if (!l.includes(e)) l.push(e)
        } else this.waiting.set(p, [e])
      }
      return this.set(e.id, { s: 'P', missing })
    }
    const ix = this.acl.ix
    const S = this.acl.stateOf(e.ap)
    const d = decide(e, pastOf(ix, e.ap), S, this.opts)
    if (!d.ok) return this.set(e.id, { s: 'R', why: d.why })
    this.recs.set(e.id, d.rec)
    return this.admit(e)
  }

  private admit(e: AclEv): Verdict {
    this.order.push(e.id)
    this.acl.append(e.id)
    return this.set(e.id, { s: 'A' })
  }
}
