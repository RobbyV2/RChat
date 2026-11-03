/* eslint-disable */
// @ts-nocheck
// Copy of notes/acl-model/model.ts (the executable reference model of the P2P ACL spec), used only by the differential tests.
// Executable reference model of the RChat P2P ACL spec (p2p-acl-spec.md, rules v2, revision 4).
// Direct and unoptimised: every check recomputes from sets. No crypto; ids are strings.
// Section references (§) point at the revised spec. Where prose and this file disagree, this file is normative.

export const MODEL_REV = 5
/** dispatch 5b of revision 5 (growth totals, [H17] rotation evidence and drops, class projection) */
export const MODEL_5B = true
/** revision 7c: protection classes on Γ⁺ for the whole stratum (r7 re-review C1; vectors.test.ts reads it) */
export const MODEL_7C = true

export type Rank = readonly [number, string]
export const TOP: Rank = [Infinity, ''] // owners
export const BOT: Rank = [-1, ''] // members without a role
export const NEG: Rank = [-Infinity, ''] // non-members
export const cmp = (a: Rank, b: Rank) =>
  a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0
export const gt = (a: Rank, b: Rank) => cmp(a, b) > 0
export const minR = (a: Rank, b: Rank) => (cmp(a, b) <= 0 ? a : b)
export const rkey = (r: Rank) => `${r[0]}/${r[1]}`

/** Seeded mutations for harness self-checks (ACL_MUT env); empty in normal runs. See §7.7. */
export const MUT = (typeof process !== 'undefined' && process.env.ACL_MUT) || ''
export const KICK = 1,
  BAN = 2,
  ROLES = 4,
  INVITE = 8,
  SERVER = 16,
  ALL = 31
export const BITS = [KICK, BAN, ROLES, INVITE, SERVER]
export const EVERYONE = '@e'

// Limits (model scale; the spec's production values are in §4.1).
// Production: DEV 8, W3 60 per hour (600 for moderators and owners) and 4 × that per day for events no other identity
// acknowledged within the hour, device_adds 8 per identity per day per epoch, primary_rotates 4 per identity per day,
// protection classes per stratum for the exact cascade 3 (revision 7, controller ruling on r6.2; 6 before; §3.1 step 4),
// pending invites 20 per device, live codes 20 per device (100 with ManageServer), roles 250.
// Revision 5 ([R4V I2]): the unacknowledged day budget is `dayU` per device for every author (no moderator multiplier;
// production 24 per day, one per hour on average), a device introduced by a device_add or a primary_rotate that no other
// identity acknowledged posts at most `freshU` non-exempt events in total (W3(d); production 24; owners exempt), and
// device_adds are counted per identity per day across epochs (a rotation resets nothing).
// Revision 5, dispatch 5b (controller ruling on growth; [H17]): the unacknowledged budget is a total, independent of
// time: `totU` ACL events per device that no other identity acknowledged, every kind except leave, device_revoke,
// primary_rotate and upgrade (production 24; model 12; it subsumes dispatch 5a's fresh-device budget `freshU`, no
// longer used), a non-owner has at most `rotTot` unacknowledged rotations in B(e) (production 4; model 3), and a
// non-owner's join needs a third identity's acknowledgement of its add (W3(e), [H18]).
// Revision 5, dispatch 5b-ii (controller ruling on growth: the bound must not grow with device churn; [H20]): the
// identity pool W3(g). U(e) = the ACL events of e's identity in B(e) ∪ {e} that no event of another identity in B(e)
// has in its past; a non-owner's event is refused when |U(e)| > poolU, and a non-owner's event x other than a rotation
// is a candidate (§2.3) when the union of U(x) and of U(y) over the events y of its identity concurrent with x has more
// than poolU events (production 384; model 30). Every device chain of the identity, revoked or not, draws on that pool,
// and a removed identity alone keeps at most poolU unacknowledged events (§4.1).
// Revision 6 (r5 review M2, C1): at most `ap` ACL parents per event (§1.2; production 10, model 10). `work`: the ruled
// work bound of r5 review I3 (b), not adopted (it lets a junior switch a senior stratum, §10.16; revision 7 lowers the
// production class cap to 3 instead, §10.17); mutant `work-bound`.
export const LIM = {
  devCap: 2,
  w3: 4,
  w3mod: 8,
  win: 10,
  day: 240,
  dayMul: 4,
  dayU: 24,
  freshU: 24,
  freshCap: 2,
  idCap: 3,
  rotCap: 4,
  classes: 2,
  pendingPerDev: 2,
  codesPerDev: 2,
  codesPerDevServer: 4,
  roles: 6,
  totU: 12,
  rotTot: 3,
  poolU: 30,
  ap: 10,
  work: 30,
}
/** "Moderator" for W3 (§4.1): any moderation bit. Owners hold every bit. */
export const MODBITS = KICK | BAN | ROLES | SERVER

export type T =
  | 'genesis'
  | 'add'
  | 'uninvite'
  | 'join'
  | 'leave'
  | 'kick'
  | 'ban'
  | 'unban'
  | 'role_create'
  | 'role_move'
  | 'role_bits'
  | 'role_del'
  | 'assign'
  | 'revoke'
  | 'code'
  | 'code_revoke'
  | 'profile'
  | 'settings'
  | 'device_add'
  | 'device_revoke'
  | 'primary_rotate'
  | 'mark'
  | 'upgrade'
  | 'x_future'

export interface Ev {
  id: string
  t: T
  a: string // author identity
  dev: string // signing device; owner identity = devOwner(dev)
  seq: number
  ap: string[] // ACL parents
  aprev?: string // device's previous ACL event
  iprev?: string // identity ops only: identity's previous identity op
  ts: number
  c: any
}

export const devOwner = (dev: string) => dev.replace(/[0-9]+$/, '')
/**
 * Identity ops sit on the identity chain (iprev): genesis, device_add, primary_rotate, and a join that introduces a
 * device. A device_revoke is not on the chain (revision 3, [R2V C3]): it removes a device and must stay admissible while
 * the chain is forked.
 */
export const idOp = (e: Ev, F: { devs: Map<string, Set<string>> } | undefined) =>
  e.t === 'genesis' ||
  e.t === 'device_add' ||
  e.t === 'primary_rotate' ||
  (MUT === 'revoke-on-chain' && e.t === 'device_revoke') ||
  (e.t === 'join' && !(F?.devs.get(e.a)?.has(e.dev) ?? false))
/** Devices an event introduces: its own device (genesis, join, device_add, primary_rotate) and a rotation's keep list. */
export function introduces(e: Ev): string[] {
  if (e.t === 'genesis' || e.t === 'join' || e.t === 'device_add') return [e.dev]
  if (e.t === 'primary_rotate') return [e.dev, ...((e.c?.keep ?? []) as string[])]
  return []
}
const fixedT = (t: T) => t === 'genesis' || t === 'device_revoke' || t === 'primary_rotate'
const isWithdrawal = (e: Ev) => e.t === 'uninvite' || e.t === 'code_revoke'
const isRevocation = (e: Ev) => e.t === 'device_revoke' || e.t === 'primary_rotate'

export type Cls = 'G' | 'D' | 'R' | 'A'
export interface Rec {
  k: Rank // stratum: author's rank in St(e) = Eval(B(e))
  cls: Cls
  self: boolean // S-class: leave, own revoke, device_revoke, primary_rotate
  exempt: boolean // exempt from W3: D and S classes, upgrade
  depth: number // identity-chain depth (identity ops), else -1
  epoch: string // identity ops: the rotation that starts their epoch ("" = genesis epoch; a rotation: its own id)
  local: EvalResult // St(e)
  pool?: string[] // W3(g) (revision 5, dispatch 5b-ii, [H20]): U(e) (undefined for genesis); cap and candidacy apply to non-owners
}

export interface Ctx {
  ev(id: string): Ev
  anc(id: string): Set<string> // B(e): strict causal past
  rec(id: string): Rec
}

// ---------------------------------------------------------------- facts (§1.5, §3.2)

export interface Pend {
  id: string
  a: string
  dev: string
  k: Rank
  code?: string
}
export interface Facts {
  owners: Set<string>
  upgraded: string[]
  mem: Set<string>
  ban: Set<string>
  effBanK: Map<string, Rank[]>
  invited: Map<string, Pend[]> // invitee -> live, unconsumed, unrevoked adds (join authority)
  pending: Map<string, Pend[]> // invited and not a member and not banned
  roles: Set<string>
  pos: Map<string, number>
  bits: Map<string, number>
  holds: Map<string, Set<string>>
  devs: Map<string, Set<string>>
  revoked: Set<string> // revoked or dropped devices (absorbing)
  codes: Map<string, { id: string; a: string; dev: string; k: Rank }> // code event id -> live code
  codeIssuer: Map<string, string> // code event id -> issuer, for every code event in the set
  profile: Map<string, number>
  setting: number | undefined
  // Revision 5 (§3.1 "Monotone authority"): the parts of Inv and Code that the authority split reads separately.
  addsTo: Map<string, Pend[]> // invitee -> live adds not removed by an effective uninvite they did not see (no code or consumption test)
  consumed: Set<string> // adds consumed by a live join that has them in its past
  codeOk: Set<string> // live code events, not revoked, issuer a member with Invite (the resource part of Code)
  codeDead: Set<string> // code events with sticky-death evidence (the obstacle part of Code)
}

/** Maximal live writes of one register: those not in the causal past of another write in the set. */
function maximal<W extends { id: string }>(ws: W[], before: (x: string, y: string) => boolean) {
  return ws.filter(w => !ws.some(w2 => w2 !== w && before(w.id, w2.id)))
}

/**
 * Devices an in-force primary_rotate r drops (§3.9): every device of r's identity that some event of E introduces, that r
 * neither keeps nor is posted by, and whose introduction is not after r. Introductions after r (the new epoch) are kept.
 */
export function droppedBy(r: Ev, E: string[], cx: Ctx): string[] {
  const keep = new Set<string>([r.dev, ...((r.c?.keep ?? []) as string[])])
  const out = new Set<string>()
  for (const id of E) {
    if (id === r.id) continue
    const x = cx.ev(id)
    if (x.a !== r.a || cx.anc(id).has(r.id)) continue
    for (const v of introduces(x)) if (!keep.has(v)) out.add(v)
  }
  return [...out].sort()
}

export function facts(
  E: string[],
  voidS: Set<string>,
  eff: Set<string>,
  cx: Ctx,
  X?: Set<string>
): Facts {
  stats.factsCalls++
  stats.factsScanned += E.length
  const before = (x: string, y: string) => cx.anc(y).has(x)
  const k = (id: string) => cx.rec(id).k
  let gen: Ev | undefined
  const live: Ev[] = []
  const effs: Ev[] = []
  const upgraded: string[] = []
  for (const id of E) {
    const e = cx.ev(id)
    if (e.t === 'genesis') gen = e
    if (e.t === 'upgrade') upgraded.push(id) // immune to every cut (§3.8)
    if (!voidS.has(id)) live.push(e)
    if (eff.has(id)) effs.push(e)
  }
  if (!gen) throw new Error('set without genesis')
  const owners = new Set<string>(gen.c.owners)

  // Ban: ban-wins; each effective ban is lifted only by a live unban that follows it and is at least as senior (M1).
  const ban = new Set<string>()
  const effBanK = new Map<string, Rank[]>()
  const unbans = live.filter(e => e.t === 'unban')
  for (const b of effs) {
    if (b.t !== 'ban') continue
    const T = b.c.to
    if (!effBanK.has(T)) effBanK.set(T, [])
    effBanK.get(T)!.push(k(b.id))
    const lifted = unbans.some(
      u => u.c.to === T && before(b.id, u.id) && cmp(k(u.id), k(b.id)) >= 0
    )
    if (!lifted) ban.add(T)
  }

  // Mem: remove-wins, and not banned. (Indexed by principal; the same rule as filtering every effective deny.)
  const remBy = new Map<string, Ev[]>()
  const pushM = <V>(m: Map<string, V[]>, key: string, v: V) => {
    const a = m.get(key)
    if (a) a.push(v)
    else m.set(key, [v])
  }
  for (const r of effs) {
    if (r.t === 'kick' || r.t === 'ban') pushM(remBy, r.c.to, r)
    else if (r.t === 'leave') pushM(remBy, r.a, r)
  }
  const memRem = (T: string) => remBy.get(T) ?? []
  const mem = new Set<string>()
  for (const g of live) {
    if (!(g.t === 'join' || g.t === 'genesis')) continue
    const T = g.a
    if (ban.has(T)) continue
    if (memRem(T).every(r => before(r.id, g.id))) mem.add(T)
  }

  // Roles: deletion is an absorbing tombstone (M2).
  const deleted = new Set(effs.filter(e => e.t === 'role_del').map(e => e.c.role))
  const roles = new Set<string>()
  for (const e of live) if (e.t === 'role_create' && !deleted.has(e.id)) roles.add(e.id)

  // Bits: per bit, clear-wins.
  const bits = new Map<string, number>()
  const sets: { role: string; mask: number; id: string }[] = []
  sets.push({ role: EVERYONE, mask: gen.c.everyone ?? 0, id: gen.id })
  for (const e of live) {
    if (e.t === 'role_create') sets.push({ role: e.id, mask: e.c.bits, id: e.id })
    if (e.t === 'role_bits' && e.c.on) sets.push({ role: e.c.role, mask: e.c.bit, id: e.id })
  }
  const clears = effs.filter(e => e.t === 'role_bits' && !e.c.on)
  for (const R of [EVERYONE, ...roles]) {
    let m = 0
    for (const b of BITS) {
      const ok = sets.some(
        s =>
          s.role === R &&
          s.mask & b &&
          clears.every(c => c.c.role !== R || c.c.bit !== b || before(c.id, s.id))
      )
      if (ok) m |= b
    }
    bits.set(R, m)
  }

  // Pos: stratified register (§1.5): among maximal writes the most senior writer wins, then lowest pos, then lowest id.
  const pos = new Map<string, number>()
  const writes = new Map<string, { id: string; pos: number }[]>()
  const addW = (R: string, id: string, p: number) => {
    if (!writes.has(R)) writes.set(R, [])
    writes.get(R)!.push({ id, pos: p })
  }
  for (const e of live) {
    if (e.t === 'role_create') addW(e.id, e.id, e.c.pos)
    if (e.t === 'role_move' && cx.rec(e.id).cls === 'G') addW(e.c.role, e.id, e.c.pos)
  }
  for (const e of effs) if (e.t === 'role_move') addW(e.c.role, e.id, e.c.pos)
  for (const [R, ws] of writes) {
    let best: { id: string; pos: number } | undefined
    for (const w of maximal(ws, before)) {
      if (!best) {
        best = w
        continue
      }
      const c = MUT === 'unstrat-pos' ? 0 : cmp(k(w.id), k(best.id))
      if (c > 0 || (c === 0 && (w.pos < best.pos || (w.pos === best.pos && w.id < best.id))))
        best = w
    }
    if (best) pos.set(R, best.pos)
  }

  // Holds: remove-wins; needs Mem and Role.
  const holds = new Map<string, Set<string>>()
  const revBy = new Map<string, Ev[]>()
  for (const r of effs) if (r.t === 'revoke') pushM(revBy, `${r.c.to}|${r.c.role}`, r)
  for (const g of live) {
    if (g.t !== 'assign') continue
    const T = g.c.to,
      R = g.c.role
    if (!mem.has(T) || !roles.has(R)) continue
    const rem = [...(revBy.get(`${T}|${R}`) ?? []), ...memRem(T)]
    if (rem.every(r => before(r.id, g.id))) {
      if (!holds.has(T)) holds.set(T, new Set())
      holds.get(T)!.add(R)
    }
  }
  const permsOf = (P: string) => {
    if (owners.has(P)) return ALL
    let m = bits.get(EVERYONE) ?? 0
    for (const R of holds.get(P) ?? []) m |= bits.get(R) ?? 0
    return m
  }

  // Codes (§1.5 Code, revision 3 [R2V I1]): a code is the code event itself, keyed by its id. A code_revoke names one code
  // event; holding or copying its hash grants nothing. A code lives while it is live, never revoked (absorbing), its
  // issuer is a member with Invite here, and it is not dead: dead once any live event e with the code in B(e) saw its
  // issuer without Mem or Invite (sticky, M7).
  const codeIssuer = new Map<string, string>()
  for (const id of E) {
    const e = cx.ev(id)
    if (e.t === 'code') codeIssuer.set(id, e.a)
  }
  const revokedC = new Set<string>()
  for (const r of effs) {
    if (r.t !== 'code_revoke') continue
    if (MUT === 'hash-codes') {
      // revision-2 behaviour: a revocation kills every code with the same hash
      const h = cx.ev(r.c.code)?.c?.h
      for (const id of E) if (cx.ev(id).t === 'code' && cx.ev(id).c.h === h) revokedC.add(id)
    } else revokedC.add(r.c.code)
  }
  const codes = new Map<string, { id: string; a: string; dev: string; k: Rank }>()
  const codeOk = new Set<string>()
  const codeDead = new Set<string>()
  for (const c of live) {
    if (c.t !== 'code') continue
    const dead =
      MUT !== 'code-revival' &&
      live.some(xe => {
        const x = xe.id
        if (!cx.anc(x).has(c.id)) return false
        const lf = cx.rec(x).local.facts
        return !lf.mem.has(c.a) || !(perms(lf, c.a) & INVITE)
      })
    if (dead) codeDead.add(c.id)
    if (revokedC.has(c.id)) continue
    if (!mem.has(c.a) || !(permsOf(c.a) & INVITE)) continue
    codeOk.add(c.id)
    if (dead) continue
    codes.set(c.id, { id: c.id, a: c.a, dev: c.dev, k: k(c.id) })
  }

  // Invites: a live add, not consumed by a live join that saw it, not removed by an effective uninvite it did not see,
  // and for code invites: the named code is still live and was not revoked (§1.5 Inv).
  const uninvBy = new Map<string, Ev[]>()
  for (const u of effs) if (u.t === 'uninvite') pushM(uninvBy, u.c.to, u)
  const joinsBy = new Map<string, Ev[]>()
  for (const j of live) if (j.t === 'join') pushM(joinsBy, j.a, j)
  const invited = new Map<string, Pend[]>()
  const pending = new Map<string, Pend[]>()
  const addsTo = new Map<string, Pend[]>()
  const consumed = new Set<string>()
  for (const g of live) {
    if (g.t !== 'add') continue
    const T = g.c.to
    if (!(uninvBy.get(T) ?? []).every(u => before(u.id, g.id))) continue
    const p: Pend = { id: g.id, a: g.a, dev: g.dev, k: k(g.id), code: g.c.code }
    pushM(addsTo, T, p)
    if ((joinsBy.get(T) ?? []).some(j => before(g.id, j.id))) {
      consumed.add(g.id)
      continue
    }
    if (g.c.code !== undefined && (revokedC.has(g.c.code) || !codes.has(g.c.code))) continue
    if (!invited.has(T)) invited.set(T, [])
    invited.get(T)!.push(p)
    if (mem.has(T) || ban.has(T)) continue
    if (!pending.has(T)) pending.set(T, [])
    pending.get(T)!.push(p)
  }

  // Devices (§1.5 Dev): introduced by genesis, an introducing join, a device_add, or a primary_rotate (its posting device
  // and the devices it keeps). A device never returns once an in-force device_revoke names it or an in-force
  // primary_rotate drops it (absorbing, M2).
  const revoked = new Set<string>(effs.filter(e => e.t === 'device_revoke').map(e => e.c.dev))
  // revision 5 ([H17]): a rotation drops only devices that a non-X event introduces (X: the equivocation void set of
  // the state this view belongs to)
  const Enx = X && X.size && MUT !== 'drops-all' ? E.filter(id => !X.has(id)) : E
  for (const r of effs)
    if (r.t === 'primary_rotate') for (const v of droppedBy(r, Enx, cx)) revoked.add(v)
  const devs = new Map<string, Set<string>>()
  for (const e of live) {
    for (const v of introduces(e)) {
      if (revoked.has(v)) continue
      if (!devs.has(e.a)) devs.set(e.a, new Set())
      devs.get(e.a)!.add(v)
    }
  }

  // Cosmetic registers (§1.5): among maximal live writes, the most senior k(w) wins, then the lowest id.
  const pickReg = (ws: Ev[]) => {
    let best: Ev | undefined
    for (const w of maximal(ws, before)) {
      if (!best) {
        best = w
        continue
      }
      const c = cmp(k(w.id), k(best.id))
      if (c > 0 || (c === 0 && w.id < best.id)) best = w
    }
    return best
  }
  const profile = new Map<string, number>()
  const byAuthor = new Map<string, Ev[]>()
  for (const e of live)
    if (e.t === 'profile') {
      if (!byAuthor.has(e.a)) byAuthor.set(e.a, [])
      byAuthor.get(e.a)!.push(e)
    }
  for (const [T, ws] of byAuthor) profile.set(T, pickReg(ws)!.c.name)
  const sw = pickReg(live.filter(e => e.t === 'settings'))
  return {
    owners,
    upgraded,
    mem,
    ban,
    effBanK,
    invited,
    pending,
    roles,
    pos,
    bits,
    holds,
    devs,
    revoked,
    codes,
    codeIssuer,
    profile,
    setting: sw?.c.name,
    addsTo,
    consumed,
    codeOk,
    codeDead,
  }
}

export function rankOf(F: Facts, R: string): Rank {
  if (R === EVERYONE) return BOT
  return [F.pos.get(R) ?? -1, R]
}
export function rank(F: Facts, P: string): Rank {
  if (F.owners.has(P)) return TOP
  if (!F.mem.has(P)) return NEG
  let r: Rank = BOT
  for (const R of F.holds.get(P) ?? []) if (gt(rankOf(F, R), r)) r = rankOf(F, R)
  return r
}
export function perms(F: Facts, P: string): number {
  if (F.owners.has(P)) return ALL
  let m = F.bits.get(EVERYONE) ?? 0
  for (const R of F.holds.get(P) ?? []) m |= F.bits.get(R) ?? 0
  return m
}

// ---------------------------------------------------------------- authorization (§1.4)

/**
 * Authority (§1.4): what an event relies on. A concurrent deny that takes part of it away cuts the event (`uses`), and a
 * cut grant that it relied on breaks it (`broken`). Target-state and no-op checks are guards (`guards`), admission only.
 */
/**
 * Monotone authority (revision 5, §3.1 "Monotone authority", [R4V C1]). Every authority check is split in two parts.
 * Resources are what the author holds: its Mem, bits, rank (`me`), the invite and code it uses, ¬Ban of itself or its
 * invitee, its device. They are read in `Fr`. Obstacles are what the author acts against: a target member's rank
 * (`rankT`), a role's position (`rankOf`), the foreign pending adds of an uninvite, invite consumption and code death.
 * They are read in `Fo`. Inside a stratum, `Fr` has this world's grant cuts applied and `Fo` does not, so more cuts never
 * lower an obstacle and never restore a resource: `broken` is monotone in the cut set by construction (O5-mono). In the
 * admission state both are St(e) and the check is the Authority column of §1.4.
 */
export interface AuthCtx {
  Fr: Facts
  Fo: Facts
  me: Rank
  rankOf: (R: string) => Rank
  rankT: (T: string) => Rank
}
export const simpleCtx = (F: Facts, a: string): AuthCtx => ({
  Fr: F,
  Fo: F,
  me: rank(F, a),
  rankOf: R => rankOf(F, R),
  rankT: T => rank(F, T),
})

export function authCore(e: Ev, x: AuthCtx): boolean {
  const a = e.a,
    c = e.c,
    Fr = x.Fr,
    Fo = x.Fo
  const isMem = Fr.mem.has(a)
  const has = (b: number) => (perms(Fr, a) & b) !== 0
  const outranks = (r: Rank) => gt(x.me, r)
  // a code is usable if its resource part holds in Fr (live, not revoked, issuer a member with Invite) and no
  // sticky-death evidence is in Fo
  const codeLive = (cid: string) => Fr.codeOk.has(cid) && !Fo.codeDead.has(cid)
  switch (e.t) {
    case 'genesis':
      return false
    case 'add':
      return isMem && has(INVITE) && !Fr.ban.has(c.to) && (c.code === undefined || codeLive(c.code))
    case 'uninvite': {
      // the foreign pending adds are obstacles: Inv(to) in Fo (equal to pending(to) at admission, where to is no member)
      const ps = Fo.invited.get(c.to) ?? []
      return isMem && ps.every(p => p.a === a || (has(KICK) && outranks(p.k)))
    }
    case 'join':
      return (
        !Fr.ban.has(a) &&
        (Fr.owners.has(a) ||
          (Fr.addsTo.get(a) ?? []).some(
            g => !Fo.consumed.has(g.id) && (g.code === undefined || codeLive(g.code))
          ))
      )
    case 'leave':
    case 'mark':
    case 'device_revoke':
    case 'primary_rotate':
    case 'profile':
    case 'x_future':
      return isMem
    case 'kick':
      return isMem && has(KICK) && !Fr.owners.has(c.to) && outranks(x.rankT(c.to))
    case 'ban':
      return isMem && has(BAN) && !Fr.owners.has(c.to) && outranks(x.rankT(c.to))
    case 'unban':
      return isMem && has(BAN) && (Fr.effBanK.get(c.to) ?? []).every(kb => cmp(x.me, kb) >= 0)
    case 'role_create':
      return isMem && has(ROLES) && outranks([c.pos, e.id]) && (c.bits & ~perms(Fr, a)) === 0
    case 'role_move':
      return (
        isMem &&
        has(ROLES) &&
        Fr.roles.has(c.role) &&
        outranks(x.rankOf(c.role)) &&
        outranks([c.pos, c.role])
      )
    case 'role_bits':
      return (
        isMem &&
        has(ROLES) &&
        (c.role === EVERYONE || Fr.roles.has(c.role)) &&
        outranks(x.rankOf(c.role)) &&
        (!c.on || has(c.bit))
      )
    case 'role_del':
      return isMem && has(ROLES) && Fr.roles.has(c.role) && outranks(x.rankOf(c.role))
    case 'assign':
      return (
        isMem &&
        has(ROLES) &&
        Fr.roles.has(c.role) &&
        outranks(x.rankOf(c.role)) &&
        !Fr.owners.has(c.to) &&
        outranks(x.rankT(c.to))
      )
    case 'revoke':
      return (
        isMem &&
        (c.to === a || (has(ROLES) && outranks(x.rankOf(c.role)) && outranks(x.rankT(c.to))))
      )
    case 'code':
      return isMem && has(INVITE)
    case 'code_revoke': {
      // [R2V I1]: only the issuer of the named code event, or ManageServer and a rank strictly above the issuer's
      const iss = Fr.codeIssuer.get(c.code)
      return isMem && iss !== undefined && (iss === a || (has(SERVER) && outranks(x.rankT(iss))))
    }
    case 'settings':
      return isMem && has(SERVER)
    case 'device_add':
      return isMem && !Fr.revoked.has(e.dev)
    case 'upgrade':
      return isMem && Fr.owners.has(a)
  }
  return false
}
/** The Authority column of §1.4 in one state (admission: St(e)). */
export const authority = (e: Ev, F: Facts): boolean => authCore(e, simpleCtx(F, e.a))

/** Guards: target-state and no-op checks (W5 caps, W6), enforced at admission only; never a reason to cut. */
export function guards(e: Ev, F: Facts): boolean {
  if (F.upgraded.length && e.t !== 'leave') return false
  const a = e.a,
    c = e.c
  const holds = (T: string, R: string) => F.holds.get(T)?.has(R) ?? false
  switch (e.t) {
    case 'add':
      return c.to !== a && !F.mem.has(c.to) && !F.pending.has(c.to)
    case 'uninvite':
      return F.pending.has(c.to)
    case 'join':
      return !F.mem.has(a)
    case 'kick':
      return c.to !== a && F.mem.has(c.to)
    case 'ban':
      return c.to !== a && !F.ban.has(c.to)
    case 'unban':
      return F.ban.has(c.to)
    case 'role_create':
      return c.pos >= 0
    case 'role_move':
      return c.pos >= 0 && c.pos !== F.pos.get(c.role)
    case 'role_bits': {
      const cur = ((F.bits.get(c.role) ?? 0) & c.bit) !== 0
      return c.on ? !cur : cur
    }
    case 'role_del':
      return c.role !== EVERYONE
    case 'assign':
      return c.to !== a && F.mem.has(c.to) && !holds(c.to, c.role)
    case 'revoke':
      return holds(c.to, c.role)
    case 'code':
      return typeof c.h === 'string'
    case 'code_revoke':
      return F.codes.has(c.code)
    case 'profile':
      return F.profile.get(a) !== c.name
    case 'settings':
      return F.setting !== c.name
    case 'device_add': {
      const d = F.devs.get(a) ?? new Set()
      return !d.has(e.dev) && d.size < LIM.devCap
    }
    case 'device_revoke':
      return (F.devs.get(a)?.has(c.dev) ?? false) && c.dev !== e.dev
    case 'primary_rotate': {
      // keeps only live devices of the identity; the posting device plus the kept ones fit the device cap
      const d = F.devs.get(a) ?? new Set()
      const keep: unknown = c.keep ?? []
      return (
        Array.isArray(keep) &&
        keep.every(v => typeof v === 'string' && d.has(v) && v !== e.dev) &&
        new Set([...keep, e.dev]).size <= LIM.devCap
      )
    }
    case 'upgrade': {
      // [R2V C4]: every genesis owner other than the author countersigned G'; membership plays no part
      const sigs: unknown = c.sigs ?? []
      if (!Array.isArray(sigs)) return false
      const need = [...F.owners].filter(o => o !== a && (MUT !== 'member-sigs' || F.mem.has(o)))
      return need.every(o => sigs.includes(o))
    }
    default:
      return true
  }
}

/** The signing device is live for its identity (`Dev`); join, device_add and primary_rotate establish their own device. */
export function deviceOk(e: Ev, F: Facts): boolean {
  if (e.t === 'join' || e.t === 'device_add' || e.t === 'primary_rotate')
    return !F.revoked.has(e.dev)
  return F.devs.get(e.a)?.has(e.dev) ?? false
}
/** Authority including the device (what cuts and cascades test). */
export const authorizeFull = (e: Ev, F: Facts) => deviceOk(e, F) && authority(e, F)
/** Admission check: device + authority + guards. */
export const admissible = (e: Ev, F: Facts) => authorizeFull(e, F) && guards(e, F)

export function classify(e: Ev, F: Facts): { cls: Cls; self: boolean } {
  switch (e.t) {
    case 'kick':
    case 'ban':
    case 'role_del':
    case 'uninvite':
    case 'code_revoke':
      return { cls: 'D', self: false }
    case 'leave':
    case 'device_revoke':
    case 'primary_rotate':
      return { cls: 'D', self: true }
    case 'revoke':
      return { cls: 'D', self: e.c.to === e.a }
    case 'role_move':
      return { cls: e.c.pos < (F.pos.get(e.c.role) ?? -1) ? 'D' : 'G', self: false }
    case 'role_bits':
      return { cls: e.c.on ? 'G' : 'D', self: false }
    case 'profile':
    case 'settings':
      return { cls: 'R', self: false }
    case 'mark':
    case 'upgrade':
    case 'x_future':
      return { cls: 'A', self: false }
    default:
      return { cls: 'G', self: false }
  }
}

/** What a deny acts on, for protection (§3.1). `who` is the principal whose rank protects the target. */
export function target(
  e: Ev,
  F: Facts
): { kind: 'member' | 'role' | 'self' | 'none'; who: string } {
  switch (e.t) {
    case 'kick':
    case 'ban':
    case 'uninvite':
      return { kind: 'member', who: e.c.to }
    case 'revoke':
      return e.c.to === e.a ? { kind: 'self', who: e.a } : { kind: 'member', who: e.c.to }
    case 'role_move':
    case 'role_bits':
    case 'role_del':
      return { kind: 'role', who: e.c.role }
    case 'code_revoke': {
      const iss = F.codeIssuer.get(e.c.code)
      return !iss || iss === e.a ? { kind: 'none', who: '' } : { kind: 'member', who: iss }
    }
    default:
      return { kind: 'self', who: e.a }
  }
}

// ---------------------------------------------------------------- equivocation (§2.3)

export interface EvalResult {
  facts: Facts
  X: Set<string>
  tail: Set<string> // ops of revoked or dropped devices past the watermark
  cut: Map<string, Rank>
  eff: Set<string>
  F: Map<string, number>
  FI: Map<string, number> // key `${identity}|${epoch}`: identity fork depth within one epoch (§2.3)
  RF?: Set<string> // contested identity ops (revision 5, [H17]): rotations with a sibling over the same iprev, and what builds on them
  PC?: Set<string> // pool candidates (revision 5, dispatch 5b-ii, W3(g), [H20])
  void: Set<string>
}

/** FI of identity `a` in epoch `epoch` ("" = genesis epoch). */
export const fiOf = (FI: Map<string, number>, a: string, epoch: string) =>
  FI.get(`${a}|${epoch}`) ?? Infinity

/**
 * Fork points (§2.3). `ghosts`: events a replica dropped by the orphan rule; their headers (device, seq, aprev) still
 * count as device evidence (revision 5, dispatch 5b, [H17]): a replica keeps them so that F never depends on what it
 * dropped. Rotation evidence RF: two rotations of one identity that are concurrent (neither in the other's past; two
 * recovery-signed records that don't see each other; a thief holding a device or the primary key can't sign one).
 * Revision 5, dispatch 5b ([H19]): any two concurrent rotations, not only two with the same iprev (mutant
 * `rot-same-iprev`), and a non-rotation identity op with the same iprev as a rotation of its identity is identity
 * evidence for its own epoch at its depth (it lost a race to the recovery key; the rotation is not affected; mutant
 * `no-race`). Without both, a removed member grew its identity chain into a tree (at each position one rotation child
 * and one device_add child, and rotation branches at different positions), each node a fresh device with a full budget.
 */
export function forkPoints(ids: string[], cx: Ctx, ghosts: string[] = []) {
  const F = new Map<string, number>()
  const FI = new Map<string, number>()
  const RF = new Set<string>()
  const byDev = new Map<string, Ev[]>()
  const byIdn = new Map<string, Ev[]>()
  const byRot = new Map<string, Ev[]>()
  // revision 5, dispatch 5b-ii ([H20]): the header of a dropped event (device, seq, aprev, iprev, ap and its recorded
  // depth, epoch and pool) counts as every kind of evidence, not only device evidence, so F, FI, RF and the pool
  // candidates never depend on what a replica dropped, and the orphan rule needs no condition on them. Mutant
  // `ghost-dev` (headers count as device evidence only; the dispatch-5b-i orphan conditions then keep the events that
  // define FI and RF, with their ancestors)
  const all = MUT === 'ghost-dev' ? ids : [...ids, ...ghosts]
  if (MUT === 'ghost-dev')
    for (const id of ghosts) {
      const e = cx.ev(id)
      if (!byDev.has(e.dev)) byDev.set(e.dev, [])
      byDev.get(e.dev)!.push(e)
    }
  for (const id of all) {
    const e0 = cx.ev(id)
    if (e0.t === 'primary_rotate' && MUT !== 'no-rot-evidence') {
      const key = MUT === 'rot-same-iprev' ? `${e0.a}|${e0.iprev ?? ''}` : e0.a
      if (!byRot.has(key)) byRot.set(key, [])
      byRot.get(key)!.push(e0)
    }
  }
  for (const rs of byRot.values())
    for (let i = 0; i < rs.length; i++)
      for (let j = i + 1; j < rs.length; j++)
        if (!cx.anc(rs[i].id).has(rs[j].id) && !cx.anc(rs[j].id).has(rs[i].id)) {
          RF.add(rs[i].id)
          RF.add(rs[j].id)
        }
  // Contested identity ops ([H17]): a rotation with rotation evidence; a rotation whose iprev is contested while a
  // contested rotation of its identity is concurrent with it (a rotation that sees every contested rotation is the
  // recovery that resolves them, §3.9); a non-rotation identity op whose epoch's rotation is contested. Only the
  // recovery key creates rotation evidence, so a thief can't contest anything; contestedness spreads only along the
  // identity chain and only grows with the set, so it is stable as evidence arrives.
  if (RF.size) {
    const sib = [...RF]
    for (const id of [...all].sort((x, y) => cx.anc(x).size - cx.anc(y).size)) {
      const e = cx.ev(id),
        r = cx.rec(id)
      if (r.depth < 0 || RF.has(id)) continue
      if (e.t === 'primary_rotate') {
        if (
          e.iprev !== undefined &&
          RF.has(e.iprev) &&
          sib.some(q => cx.ev(q).a === e.a && !cx.anc(id).has(q) && !cx.anc(q).has(id))
        )
          RF.add(id)
      } else if (r.epoch !== '' && RF.has(r.epoch)) RF.add(id)
    }
  }
  for (const id of all) {
    const e = cx.ev(id)
    if (!byDev.has(e.dev)) byDev.set(e.dev, [])
    byDev.get(e.dev)!.push(e)
    const r = cx.rec(id)
    // identity evidence: two identity ops of one identity in the same epoch with the same iprev. A primary_rotate starts
    // its own epoch and never pairs; concurrent rotations are refused further identity ops instead (§2.2).
    if (r.depth >= 0 && e.t !== 'primary_rotate') {
      const key = `${e.a}|${r.epoch}`
      if (!byIdn.has(key)) byIdn.set(key, [])
      byIdn.get(key)!.push(e)
    }
  }
  for (const [dev, es] of byDev)
    for (let i = 0; i < es.length; i++)
      for (let j = i + 1; j < es.length; j++) {
        const x = es[i],
          y = es[j]
        if (x.seq === y.seq || (x.aprev ?? '') === (y.aprev ?? '')) {
          const m = Math.min(x.seq, y.seq)
          if (m < (F.get(dev) ?? Infinity)) F.set(dev, m)
        }
      }
  for (const [key, es] of byIdn)
    for (let i = 0; i < es.length; i++)
      for (let j = i + 1; j < es.length; j++) {
        const x = es[i],
          y = es[j]
        if ((x.iprev ?? '') === (y.iprev ?? '')) {
          const d = cx.rec(x.id).depth
          if (d < (FI.get(key) ?? Infinity)) FI.set(key, d)
        }
      }
  // race evidence ([H19]): a non-rotation identity op with the same iprev as a rotation of its identity
  if (MUT !== 'no-race' && MUT !== 'no-rot-evidence') {
    const rotPrev = new Set<string>()
    for (const id of all) {
      const e = cx.ev(id)
      if (e.t === 'primary_rotate') rotPrev.add(`${e.a}|${e.iprev ?? ''}`)
    }
    if (rotPrev.size)
      for (const es of byIdn.values())
        for (const x of es) {
          if (!rotPrev.has(`${x.a}|${x.iprev ?? ''}`)) continue
          const key = `${x.a}|${cx.rec(x.id).epoch}`,
            d = cx.rec(x.id).depth
          if (d < (FI.get(key) ?? Infinity)) FI.set(key, d)
        }
  }
  return { F, FI, RF, PC: poolCands(ids, cx, ghosts, F) }
}

/**
 * Pool evidence (§2.3, W3(g); revision 5, dispatch 5b-ii, [H20]): a non-owner's event x other than a rotation is a pool
 * candidate when P(x) = U(x) ∪ ⋃ { U(y) : y of x's identity, concurrent with x } has more than poolU events, U the
 * pools recorded at admission. U is fixed per event. Dropped events (ghosts) keep their headers and recorded pools,
 * except events past their device's fork point (revision 7: they count in no P, and only their ids stay in the recorded
 * pools), so a replica's drops never change P. Every event lies in its own U, so P(x) holds every event of the identity
 * concurrent with x before its device's fork point; for x maximal among the non-candidate unacknowledged events of an
 * identity (all before their fork points), P(x) holds all of them and their unacknowledged ancestors.
 * Rotations are never pool candidates (recovery; a thief can't void one). Mutant `pool-off`. Revision 6 (r5 review C1
 * (c)): a device_revoke is never one either (a thief's sibling flood must not void the revocation of the stolen device;
 * mutant `revoke-pool`). Revision 7 (controller ruling on r6.1, C1 option 2): only concurrent events before their
 * device's fork point count (y.seq < F(y.dev)); events past it are candidates anyway and make no other event one. This is
 * not monotone (an event stops counting when its device forks below it), so the orphan rule never drops an event that
 * is a candidate only by pool evidence (props.ts orphanDrops). Mutant `pool-all`: revision 6's rule (every concurrent event).
 */
export function poolCands(
  ids: string[],
  cx: Ctx,
  ghosts: string[] = [],
  Fd?: Map<string, number>
): Set<string> {
  const PC = new Set<string>()
  if (MUT === 'pool-off') return PC
  const g = ids.find(id => cx.ev(id).t === 'genesis')
  const owners = new Set<string>(g ? (cx.ev(g).c?.owners ?? []) : [])
  const byA = new Map<string, string[]>()
  for (const id of [...ids, ...ghosts]) {
    if (!cx.rec(id).pool) continue
    const a = cx.ev(id).a
    if (owners.has(a)) continue // owners are never pool candidates (they can't be removed)
    if (!byA.has(a)) byA.set(a, [])
    byA.get(a)!.push(id)
  }
  for (const es of byA.values()) {
    if (es.length <= 1) continue
    for (const x of es) {
      if (
        cx.ev(x).t === 'primary_rotate' ||
        (cx.ev(x).t === 'device_revoke' && MUT !== 'revoke-pool')
      )
        continue
      const P = new Set(cx.rec(x).pool!)
      for (const y of es) {
        if (y === x || cx.anc(x).has(y) || cx.anc(y).has(x)) continue
        if (MUT !== 'pool-all' && Fd && cx.ev(y).seq >= (Fd.get(cx.ev(y).dev) ?? Infinity)) continue
        for (const z of cx.rec(y).pool!) P.add(z)
      }
      if (P.size > LIM.poolU) PC.add(x)
    }
  }
  return PC
}

/** Identity ops of `dev`'s introduction in B(id): events in the causal past that introduce the device. */
const introsOf = (id: string, cx: Ctx) => {
  const e = cx.ev(id)
  return [...cx.anc(id)].filter(x => cx.rec(x).depth >= 0 && introduces(cx.ev(x)).includes(e.dev))
}

/** A clean introduction: a rotation without rotation evidence, or an identity op before its epoch's fork point. */
const cleanIntro = (
  x: string,
  cx: Ctx,
  FI: Map<string, number>,
  RF?: Set<string>,
  PC?: Set<string>
) =>
  !(RF?.has(x) ?? false) &&
  !(PC?.has(x) ?? false) &&
  (cx.ev(x).t === 'primary_rotate' || cx.rec(x).depth < fiOf(FI, cx.ev(x).a, cx.rec(x).epoch))

/**
 * cand_V(x) (§2.3): x is at or past a device or identity fork point in a view with fork points F, FI, rotation
 * evidence RF and void set X. Revision 5, dispatch 5b ([H17]): a rotation is a candidate iff it has rotation evidence
 * (a sibling rotation over the same iprev); before, a rotation was never a candidate, so any number of concurrent
 * rotations stayed in force and stored. Only the recovery key signs a rotation, so a thief still can't void one.
 */
export function candidate(
  id: string,
  cx: Ctx,
  F: Map<string, number>,
  FI: Map<string, number>,
  X: Set<string>,
  RF?: Set<string>,
  PC?: Set<string>
) {
  const e = cx.ev(id),
    r = cx.rec(id)
  if (e.t === 'genesis') return false
  if (e.t === 'primary_rotate') return RF?.has(id) ?? false
  if (e.seq >= (F.get(e.dev) ?? Infinity)) return true
  if (PC?.has(id)) return true // pool evidence (W3(g), [H20])
  if (r.depth >= 0) return r.depth >= fiOf(FI, e.a, r.epoch) || (RF?.has(id) ?? false)
  const intros = introsOf(id, cx)
  // revision 5, dispatch 5b ([H17]): an event is a candidate when every identity op that introduced its device is a
  // candidate (before: is in X). Candidacy of an identity op is structural (F, FI, rotation evidence only fall or
  // grow), so a fresh device's events on a void branch stay void once nothing is built on them and can be dropped
  // (§2.3); with "in X", a later good-faith citation of the introduction alone could revive them. Mutant `intro-x`.
  return (
    intros.length > 0 &&
    intros.every(x => (MUT === 'intro-x' ? X.has(x) : candidate(x, cx, F, FI, X, RF, PC)))
  )
}

/**
 * Equivocation void set X (§2.3): candidates that no clean witness acknowledged in good faith. A witness w of x is an
 * admitted ACL event by another identity with x in B(w) that is clean (not past its own fork points, on a device introduced
 * cleanly) and that acted in good faith (x was not a candidate in St(w)). No recursion through X.
 */
export function equivocationCut(
  ids: string[],
  cx: Ctx,
  F: Map<string, number>,
  FI: Map<string, number>,
  RF: Set<string> = new Set(),
  PC: Set<string> = new Set()
) {
  const clean = new Map<string, boolean>()
  // revision 5 ([R4V C2]): an event past the watermark of an admitted revocation record of its own device (a
  // device_revoke naming it, or a primary_rotate that drops it) is never a clean witness. The test reads the admitted
  // records, not whether they are in force, so X has no recursion through Tail; it makes every Tail event inert for X.
  // Only structurally clean records count (a primary_rotate, which is never void, or a device_revoke before its own
  // device's fork point on a device introduced cleanly; decided from F and FI alone, so still no recursion through X).
  // Such a record is never in X, so a void record has no effect (O7-absent); counting every admitted record (mutant
  // `revoke-any`, the first revision-5 draft) let a void device_revoke un-clean witnesses, and dropping it as an orphan
  // changed X (seeds 9228, 14268 of the revision-5 fuzz).
  // W3(g) ([H20]): a pool candidate is never clean (as a record, an introduction or a witness), so no X event is clean
  const recClean = (r: Ev) =>
    r.seq < (F.get(r.dev) ?? Infinity) &&
    !PC.has(r.id) &&
    [r.id, ...cx.anc(r.id)].some(
      x =>
        cx.rec(x).depth >= 0 &&
        introduces(cx.ev(x)).includes(r.dev) &&
        cx.ev(x).a === r.a &&
        cleanIntro(x, cx, FI, RF, PC)
    )
  // [H17]: a rotation lowers watermarks only if it is clean (no rotation evidence), and only for devices that a
  // non-candidate event introduces: a device introduced only by candidates has no clean witness anyway, and its
  // candidate introductions may be dropped as orphans (§2.3), so they must not decide anything here
  const nonCand = ids.filter(
    x =>
      !(
        cx.rec(x).depth >= 0 &&
        (RF.has(x) ||
          PC.has(x) ||
          (cx.ev(x).t !== 'primary_rotate' &&
            cx.rec(x).depth >= fiOf(FI, cx.ev(x).a, cx.rec(x).epoch)))
      )
  )
  const wm = new Map<string, number>() // device -> lowest watermark of a clean admitted revocation record of it
  if (MUT !== 'tail-witness')
    for (const id of ids) {
      const e = cx.ev(id)
      const lower = (v: string, s: number) => {
        if (s < (wm.get(v) ?? Infinity)) wm.set(v, s)
      }
      if (
        e.t === 'device_revoke' &&
        typeof e.c?.dev === 'string' &&
        (MUT === 'revoke-any' || recClean(e))
      )
        lower(e.c.dev, typeof e.c.seen === 'number' ? e.c.seen : -1)
      if (e.t === 'primary_rotate' && (MUT === 'drops-all' || !RF.has(id)))
        for (const v of droppedBy(e, MUT === 'drops-all' ? ids : nonCand, cx))
          lower(v, (e.c.seen?.[v] ?? -1) as number)
    }
  const isClean = (w: string) => {
    let v = clean.get(w)
    if (v === undefined) {
      const we = cx.ev(w),
        r = cx.rec(w)
      v =
        we.seq < (F.get(we.dev) ?? Infinity) &&
        !(we.seq > (wm.get(we.dev) ?? Infinity)) &&
        !(r.depth >= 0 && we.t !== 'primary_rotate' && r.depth >= fiOf(FI, we.a, r.epoch)) &&
        !(r.depth >= 0 && RF.has(w)) &&
        !PC.has(w) &&
        [w, ...cx.anc(w)].some(
          x =>
            cx.rec(x).depth >= 0 &&
            introduces(cx.ev(x)).includes(we.dev) &&
            cx.ev(x).a === we.a &&
            cleanIntro(x, cx, FI, RF, PC)
        )
      if (MUT === 'any-witness') v = true
      clean.set(w, v)
    }
    return v
  }
  const goodFaith = (w: string, x: string) => {
    if (MUT === 'no-goodfaith') return true
    const lo = cx.rec(w).local
    return !candidate(x, cx, lo.F, lo.FI, lo.X, lo.RF, lo.PC)
  }
  const witnessed = (e: Ev) =>
    MUT !== 'no-witness' &&
    ids.some(w => cx.ev(w).a !== e.a && cx.anc(w).has(e.id) && isClean(w) && goodFaith(w, e.id))
  const topo = [...ids].sort((x, y) => cx.anc(x).size - cx.anc(y).size)
  const X = new Set<string>()
  for (const id of topo) if (candidate(id, cx, F, FI, X, RF, PC) && !witnessed(cx.ev(id))) X.add(id)
  return X
}

// ---------------------------------------------------------------- Eval (§3.1)

/**
 * V_o(K, +d) (§3.1): o's own admission state with the non-deny events of K in B(o) voided and, optionally, deny d made
 * effective. Equivocation voids (X) of the global set are deliberately not applied: X never cascades (§2.3).
 */
export function view(o: string, cx: Ctx, K: Set<string>, extra?: string | string[]): Facts {
  const lo = cx.rec(o).local
  const Bo = [...cx.anc(o)]
  const voidV = new Set(lo.void)
  for (const x of Bo) if (K.has(x) && cx.rec(x).cls !== 'D') voidV.add(x)
  const effV = new Set(lo.eff)
  const ex = extra === undefined ? [] : typeof extra === 'string' ? [extra] : extra
  for (const d of ex) effV.add(d)
  return facts(ex.length ? [...Bo, ...ex] : Bo, voidV, effV, cx, lo.X)
}
/** The position writes of role R in a view (§3.2 Pos): live creates, live G moves, effective moves. */
export interface PosWrite {
  id: string
  pos: number
  k: Rank
}
export function roleWrites(
  E: string[],
  voidS: Set<string>,
  eff: Set<string>,
  cx: Ctx,
  R: string
): PosWrite[] {
  const ws: PosWrite[] = []
  for (const id of E) {
    const e = cx.ev(id)
    if (e.t === 'role_create' && id === R && !voidS.has(id))
      ws.push({ id, pos: e.c.pos, k: cx.rec(id).k })
    else if (e.t === 'role_move' && e.c.role === R) {
      if (eff.has(id) || (!voidS.has(id) && cx.rec(id).cls === 'G'))
        ws.push({ id, pos: e.c.pos, k: cx.rec(id).k })
    }
  }
  return ws
}
/** w beats w2 in the stratified register: the higher k, then the lower pos, then the lower id. */
const beats = (w: PosWrite, w2: PosWrite) => {
  const c = cmp(w.k, w2.k)
  return c > 0 || (c === 0 && (w.pos < w2.pos || (w.pos === w2.pos && w.id < w2.id)))
}
/** The register value of the writes P (the best maximal write), or undefined if P is empty. */
export function posWinner(P: PosWrite[], cx: Ctx): number | undefined {
  let best: PosWrite | undefined
  for (const w of P) {
    if (P.some(w2 => w2 !== w && cx.anc(w2.id).has(w.id))) continue
    if (!best || beats(w, best)) best = w
  }
  return best?.pos
}
/**
 * Position hull (revision 5): the lowest ("min") or highest ("max") value the register of the writes L can take when any
 * subset of the removable writes V is removed. The definition is the minimum or maximum over all subsets
 * (`posHullBrute`); `posHull` computes it in polynomial time: a write w can be the value only if every write after w is
 * removable, and then the largest set where it wins is found by repeatedly removing a maximal write that beats w (if
 * such a write is not removable, w can't win). Both are checked equal by property O5-hull.
 */
export function posHull(
  L: PosWrite[],
  V: Set<string>,
  dir: 'min' | 'max',
  cx: Ctx
): number | undefined {
  const before = (x: string, y: string) => cx.anc(y).has(x)
  let best: number | undefined
  for (const w of L) {
    const succ = L.filter(x => x !== w && before(w.id, x.id))
    if (succ.some(x => !V.has(x.id))) continue
    let P: PosWrite[] | undefined = L.filter(x => !succ.includes(x))
    for (;;) {
      const bad = P.find(
        m => m !== w && beats(m, w) && !P!.some(y => y !== m && before(m.id, y.id))
      )
      if (!bad) break
      if (!V.has(bad.id)) {
        P = undefined
        break
      }
      P = P.filter(x => x !== bad)
    }
    if (P && (best === undefined || (dir === 'min' ? w.pos < best : w.pos > best))) best = w.pos
  }
  return best
}
export function posHullBrute(
  L: PosWrite[],
  V: Set<string>,
  dir: 'min' | 'max',
  cx: Ctx
): number | undefined {
  const vs = L.filter(w => V.has(w.id))
  let best: number | undefined
  for (let m = 0; m < 1 << vs.length; m++) {
    const P = L.filter(w => {
      const i = vs.indexOf(w)
      return i < 0 || !(m & (1 << i))
    })
    const v = posWinner(P, cx)
    if (v !== undefined && (best === undefined || (dir === 'min' ? v < best : v > best))) best = v
  }
  return best
}
/** Hull instances seen while HULL_CHECK is set (props.ts compares posHull with posHullBrute on each, O5-hull). */
export const hullLog: {
  L: PosWrite[]
  V: Set<string>
  dir: 'min' | 'max'
  got: number | undefined
  cx: Ctx
}[] = []
export const hullCheck = { on: false }
const hull = (L: PosWrite[], V: Set<string>, dir: 'min' | 'max', cx: Ctx) => {
  const got = posHull(L, V, dir, cx)
  if (hullCheck.on && V.size <= 10 && hullLog.length < 2000) hullLog.push({ L, V, dir, got, cx })
  return got
}

/**
 * The views of a monotone authority check of `o` (revision 5, §3.1): K = the cuts of the strata above, N = cuts of this
 * stratum counted in the world being judged, `extra` = denies made effective (`uses`, `k*`).
 * - Resources (Fr, me): V_o(K ∪ N, +extra), i.e. o's admission state with the grants cut above or in this world voided.
 *   The author's rank `me` is the highest rank, over the roles it holds in Fr, of the lowest position any subset of N's
 *   position writes could leave that role at (the clamp: more cuts never raise it, whatever the register's tie-break).
 * - Obstacles (Fo, rankOf, rankT): o's admission state with the grants cut above voided (this stratum's grant cuts never
 *   lower an obstacle) and the denies o saw that are cut above or in this world removed ([R4V M2]: an operation that
 *   relied on a deny loses it when a senior cuts that deny). A role's obstacle position is the highest any subset of
 *   N's removed position denies could leave it at.
 * Every part is monotone in N: Fr only loses facts, Fo only gains them. Mutants: `nonmono` (revision 4: one view
 * V_o(K ∪ N) for both parts), `cutdeny-stays` (cut denies keep their effect on obstacles), `clamp-r4` (me clamped to
 * min(rank in V_o(K), rank in V_o(K ∪ N)) only, the review's proposal, which is not monotone with three writes).
 */
export function monoCtx(
  o: string,
  cx: Ctx,
  K: Set<string>,
  N: Iterable<string> = [],
  extra?: string | string[]
): AuthCtx {
  const lo = cx.rec(o).local
  const A = cx.anc(o)
  const Bo = [...A]
  const a = cx.ev(o).a
  const ex = extra === undefined ? [] : typeof extra === 'string' ? [extra] : extra
  const isDn = (x: string) => cx.rec(x).cls === 'D'
  const KG: string[] = [],
    KD: string[] = [],
    NG: string[] = [],
    ND: string[] = []
  for (const x of Bo) if (K.has(x)) (isDn(x) ? KD : KG).push(x)
  for (const x of N) if (A.has(x) && !K.has(x)) (isDn(x) ? ND : NG).push(x)
  const E_R = ex.length ? [...Bo, ...ex] : Bo
  const voidR = new Set(lo.void)
  for (const x of KG) voidR.add(x)
  for (const x of NG) voidR.add(x)
  const effR = new Set(lo.eff)
  for (const d of ex) effR.add(d)
  const Fr = facts(E_R, voidR, effR, cx, lo.X)
  if (MUT === 'nonmono') return simpleCtx(Fr, a)
  const voidO = new Set(lo.void)
  for (const x of KG) voidO.add(x)
  const effO = new Set(lo.eff)
  if (MUT !== 'cutdeny-stays') {
    for (const d of KD) effO.delete(d)
    for (const d of ND) effO.delete(d)
  }
  const Fo =
    !KD.length && !ND.length && !NG.length && !ex.length ? Fr : facts(Bo, voidO, effO, cx, lo.X)
  // the author's rank as a resource
  let me: Rank
  if (Fr.owners.has(a)) me = TOP
  else if (!Fr.mem.has(a)) me = NEG
  else {
    me = BOT
    const baseVoid =
      MUT === 'clamp-r4'
        ? undefined
        : (() => {
            const v = new Set(lo.void)
            for (const x of KG) v.add(x)
            return v
          })()
    for (const R of Fr.holds.get(a) ?? []) {
      const VR = NG.filter(x => {
        const e = cx.ev(x)
        return e.t === 'role_move' && e.c.role === R
      })
      let p = Fr.pos.get(R) ?? -1
      if (VR.length) {
        if (MUT === 'clamp-r4') {
          const vK = new Set(lo.void)
          for (const x of KG) vK.add(x)
          p = Math.min(p, facts(E_R, vK, effR, cx, lo.X).pos.get(R) ?? -1)
        } else p = hull(roleWrites(E_R, baseVoid!, effR, cx, R), new Set(VR), 'min', cx) ?? p
      }
      if (gt([p, R], me)) me = [p, R]
    }
  }
  // obstacles: a role's position with the removable cut position denies of N
  const memoR = new Map<string, Rank>()
  const obsRankOf = (R: string): Rank => {
    if (R === EVERYONE) return BOT
    let r = memoR.get(R)
    if (r) return r
    const VR = ND.filter(x => {
      const e = cx.ev(x)
      return e.t === 'role_move' && e.c.role === R
    })
    let p = Fo.pos.get(R) ?? -1
    if (VR.length && MUT !== 'cutdeny-stays') {
      const effB = new Set(effO)
      for (const d of VR) effB.add(d)
      p = hull(roleWrites(Bo, voidO, effB, cx, R), new Set(VR), 'max', cx) ?? p
    }
    memoR.set(R, (r = [p, R]))
    return r
  }
  const rankT = (T: string): Rank => {
    if (Fo.owners.has(T)) return TOP
    if (!Fo.mem.has(T)) return NEG
    let r: Rank = BOT
    for (const R of Fo.holds.get(T) ?? []) {
      const q = obsRankOf(R)
      if (gt(q, r)) r = q
    }
    return r
  }
  return { Fr, Fo, me, rankOf: obsRankOf, rankT }
}
/** o is authorized (device and Authority column) with the cuts K above, the world's cuts N and the denies `extra`. */
export function authorizedIn(
  o: string,
  cx: Ctx,
  K: Set<string>,
  N: Iterable<string> = [],
  extra?: string | string[]
): boolean {
  const x = monoCtx(o, cx, K, N, extra)
  const e = cx.ev(o)
  return deviceOk(e, x.Fr) && authCore(e, x)
}
/** uses(o, d): o is authorized under K but not with d made effective: d takes away something o relied on. */
export const uses = (o: string, d: string, cx: Ctx, K: Set<string>) =>
  !authorizedIn(o, cx, K, [], d) && (MUT === 'uses-stale' || authorizedIn(o, cx, K))
/** broken(p, K, N): p is not authorized with the cuts K above and the world's cuts N (monotone in N). */
export const broken = (p: string, cx: Ctx, K: Set<string>, N: Iterable<string> = []) =>
  !authorizedIn(p, cx, K, N)
/** frontier(o, d): o did not see d as effective (o ∉ C(d), and d ∉ eff(St(o))). */
export const frontier = (o: string, d: string, cx: Ctx) =>
  o !== d &&
  !cx.anc(d).has(o) &&
  !(cx.anc(o).has(d) && (MUT === 'concurrent-frontier' || cx.rec(o).local.eff.has(d)))
/**
 * Effective stratum k*(o) (§1.6) under the decisions above the stratum being processed: denies keep k(o); any other op
 * drops to its author's rank in V_o(K) with the effective higher denies `high` that o did not see as effective applied
 * (a senior's concurrent demotion of the author lowers it, as a senior's cut of the promoting grant does; [H9]).
 */
export function kstar(
  o: string,
  cx: Ctx,
  K: Set<string>,
  high?: Set<string>,
  N?: Iterable<string>
): Rank {
  const r = cx.rec(o)
  if (r.cls === 'D' || MUT === 'no-kstar') return r.k
  const extra =
    high && MUT !== 'kstar-cuts-only' ? [...high].filter(d => frontier(o, d, cx)).sort() : []
  // with this stratum's world cuts N, the author's rank is the resource rank of the monotone check (never raised by cuts)
  if (N !== undefined) return minR(r.k, monoCtx(o, cx, K, N, extra).me)
  return minR(r.k, rank(view(o, cx, K, extra), cx.ev(o).a))
}

export function protectedP(F: Facts, P: string, k: Rank) {
  return F.owners.has(P) || gt(rank(F, P), k)
}
/**
 * Whether a deny's target is protected at stratum kk in V_d (§3.1 step 2). A member target is protected if V_d ranks it
 * strictly above kk (equals duel). A target that was not a member in St(d) (a ban of a non-member, an uninvite) and joined
 * concurrently is protected already at equal rank: removing a membership needs strictly higher rank ([R2V C2]).
 */
export function protectedTarget(e: Ev, St: Facts, V: Facts, kk: Rank) {
  const tg = target(e, St)
  if (tg.kind === 'member') {
    if (V.owners.has(tg.who)) return true
    if (!St.mem.has(tg.who) && MUT !== 'equal-join') return cmp(rank(V, tg.who), kk) >= 0
    return gt(rank(V, tg.who), kk)
  }
  if (tg.kind === 'role') return gt(rankOf(V, tg.who), kk)
  return false
}

/**
 * exposed(p, γ) (§3.1): p's author is not protected against cause γ at stratum kk, read in V_γ (the facts of S \ fut(γ)
 * under the decisions above kk). Owners are never exposed. Revocation causes (device_revoke, primary_rotate tails) and
 * non-join operations: exposed unless V_γ ranks the author strictly above kk. A join (it creates a membership) is
 * exposed to a deny only if V_γ ranks the joiner strictly below kk, and to a withdrawal (uninvite, code_revoke) only if
 * also the withdrawer held Kick in St(γ) ([R2V C2]).
 */
export function exposedTo(p: Ev, g: Ev, gRec: Rec, V: Facts, kk: Rank, duel = false): boolean {
  const P = p.a
  if (V.owners.has(P)) return false
  const r = rank(V, P)
  if (isRevocation(g)) return !gt(r, kk)
  if (p.t === 'join' && MUT !== 'equal-join') {
    if (isWithdrawal(g) && MUT !== 'kickless-withdraw' && !(perms(gRec.local.facts, g.a) & KICK))
      return false
    // r7b, not adopted (mutant `duel-join`): the racing join of a deny's own target that was a member in St(d) is
    // exposed at the threshold that let the deny take effect (a duel, rank <= kk); it changes what users see after a
    // later unban (the add the join consumed, the device it introduced), §10.17
    if (duel && MUT === 'duel-join') return !gt(r, kk)
    return cmp(r, kk) < 0
  }
  return !gt(r, kk)
}

/** Work counters of the last evaluate() call (bench.ts, §7.7): worlds and broken() tests in step 4. */
export const stats = {
  worlds: 0,
  maxWorlds: 0,
  brokenTests: 0,
  causes: 0,
  maxCauses: 0,
  maxClasses: 0,
  fallbacks: 0,
  workFallbacks: 0,
  maxWork: 0,
  factsCalls: 0,
  factsScanned: 0,
  msForks: 0,
  msSteps03: 0,
  msStep4: 0,
  msFacts: 0,
  // revision 7c: the most distinct worlds one op is tested in, projected onto G(q) (what its cut depends on); strata of
  // the exact branch where some op exceeds 2^classes + 1, and those among them whose flat closure holds no X op (the
  // bound's argument covers exactly these, §3.1.1; property O5-worlds)
  maxOpWorlds: 0,
  worldsOver: 0,
  worldsOverClean: 0,
}

/** Topological order of a set (anc sizes grow along causality; ids break ties). */
const topoOrder = (ids: string[], cx: Ctx) =>
  [...ids].sort((x, y) => cx.anc(x).size - cx.anc(y).size || (x < y ? -1 : x > y ? 1 : 0))

/**
 * Step 4, revision 4 (§3.1): the exact per-cause cascade. Worlds are sets of causes (bit masks over the sorted causes).
 * inW(x, W): x is cut at this stratum and would be cut by the causes W alone: a direct cut of a cause in W, or newly
 * broken by the cuts y in B(x) with inW(y, W ∩ U(x)). An op p is cut iff inW(p, Γ), i.e. it is a direct cut or newly
 * broken in the world U(p). Decided in causal order, so every op in B(p) is decided before p.
 */
function cascadeExact(
  ids: string[],
  cx: Ctx,
  causes: string[],
  direct: Map<string, Set<string>>,
  Uof: (p: string) => string[],
  alive: (id: string) => boolean,
  Kf: Set<string>,
  below: (o: string, N?: string[]) => boolean,
  st: typeof stats,
  Xs: Set<string> = new Set(),
  Ts: Set<string> = new Set()
): Set<string> {
  const idx = new Map(causes.map((g, i) => [g, i]))
  const bit = (g: string) => 1n << BigInt(idx.get(g)!)
  const Dc = new Map<string, bigint>()
  for (const [g, os] of direct) for (const o of os) Dc.set(o, (Dc.get(o) ?? 0n) | bit(g))
  const Um = new Map<string, bigint>()
  const U = (p: string) => {
    let m = Um.get(p)
    if (m === undefined) {
      m = 0n
      for (const g of Uof(p)) m |= bit(g)
      Um.set(p, m)
    }
    return m
  }
  const top = new Set<string>() // the cuts of this stratum, decided so far
  const topList: string[] = []
  const brokenK = new Map<string, boolean>()
  const casc = new Map<string, boolean>() // `${q}|${world}` → q newly broken in that world (world ⊆ U(q))
  const worlds = new Set<bigint>()
  const brokenAt = new Map<string, boolean>()
  // worlds are recorded under top-level tests of flat ops only: a region op outside Fl is never cut (lemma), and
  // fast.ts tests only Fl (§5.2 step 4)
  const opWorlds = new Map<string, Set<bigint>>()
  let topFlat = false
  const cascadeIn = (q: string, Wq: bigint): boolean => {
    const key = `${q}|${Wq}`
    let v = casc.get(key)
    if (v !== undefined) return v
    worlds.add(Wq)
    if (topFlat) {
      let ow = opWorlds.get(q)
      if (!ow) opWorlds.set(q, (ow = new Set()))
      ow.add(Wq & G(q))
    }
    v = false
    let bk = brokenK.get(q)
    if (bk === undefined) brokenK.set(q, (bk = broken(q, cx, Kf)))
    if (!bk) {
      const A = cx.anc(q)
      const N = topList.filter(x => A.has(x) && inW(x, Wq))
      if (N.length) {
        const nk = `${q}|${N.join(',')}`
        let b = brokenAt.get(nk)
        if (b === undefined) {
          st.brokenTests++
          b = below(q, MUT === 'growing-k' ? undefined : N) && broken(q, cx, Kf, N)
          brokenAt.set(nk, b)
        }
        v = b
      }
    }
    casc.set(key, v)
    return v
  }
  const inW = (x: string, W: bigint): boolean => {
    if ((Dc.get(x) ?? 0n) & W) return true
    const Wx = MUT === 'world-flat' ? W : W & U(x)
    return Wx !== 0n && cascadeIn(x, Wx)
  }
  // Protection classes (§3.1 step 4, revision 4): the distinct exposure sets, other than ∅ and Γ, of the ops that are
  // direct cuts or have one in their causal past. Only senior decisions (promotions, demotions) make them differ. Up to
  // LIM.classes classes the rule above is exact (at most 2^classes worlds). Beyond, the stratum uses the sound
  // polynomial fallback: an earlier cut x counts in q's world only if a cause in that world cut x directly, or x was
  // cut in its own world and that world lies inside q's (then x is cut in the intersection). The fallback never cuts
  // what the exact rule keeps; it may keep an op of an author protected against some cause of the stratum.
  const order = topoOrder(ids, cx).filter(alive)
  const directs = [...Dc.keys()]
  const region = order.filter(q => Dc.has(q) || directs.some(x => cx.anc(q).has(x)))
  const ALLm = (1n << BigInt(causes.length)) - 1n
  // Revision 5 (dispatch 5b, [H16]): classes are counted among the ops the causes could cut if no author were
  // protected (the flat closure; by the monotonicity lemma it holds every cut of either branch), not over the whole
  // region. An op that can never be cut, such as an event on the heads, has no say in which branch runs: counted over
  // the region, a later event on the heads with a new exposure set switched the stratum to the fallback and un-cut
  // earlier operations (vector "Class cap: an event on the heads"; mutant `class-region`).
  const flat = new Set<string>()
  const flatList: string[] = []
  if (MUT !== 'class-region')
    for (const q of region) {
      let f = Dc.has(q)
      if (!f) {
        let bk = brokenK.get(q)
        if (bk === undefined) brokenK.set(q, (bk = broken(q, cx, Kf)))
        if (!bk) {
          const A = cx.anc(q)
          const N = flatList.filter(x => A.has(x))
          if (N.length) {
            st.brokenTests++
            f = below(q, N) && broken(q, cx, Kf, N)
          }
        }
      }
      if (f) {
        flat.add(q)
        flatList.push(q)
      }
    }
  // Revision 5, dispatch 5b ([H17] latent defect (c)): an op's cut in a world W depends only on W ∩ G(q), G(q) = the
  // causes with a direct cut in C(q) = {q} ∪ B(q). Classes are counted over flat ops that are not X (revision 7c: on
  // Γ⁺, below), and the fallback's subset test is projected onto G(q). So an X event without descendants (an orphan the
  // storage rule may drop, §2.3) and a cause whose only direct cuts are such events can't switch the branch or the
  // fallback's result: dropping them leaves Eval unchanged. Before, such an orphan's exposure set was a class of its
  // own, and such a cause's bit split other ops' classes. Mutant `class-proj-off`.
  const projOff = MUT === 'class-proj-off' || MUT === 'class-region'
  const Gm = new Map<string, bigint>()
  if (!projOff)
    for (const q of topoOrder(ids, cx)) {
      let g = Dc.get(q) ?? 0n
      for (const p of cx.ev(q).ap) g |= Gm.get(p) ?? 0n
      if (g) Gm.set(q, g)
    }
  const G = (q: string): bigint => Gm.get(q) ?? 0n
  const counted =
    MUT === 'class-region' ? region : region.filter(q => flat.has(q) && (projOff || !Xs.has(q)))
  // Revision 7c (r7 re-review C1, controller ruling "cap, final spec revision r7c"): classes are distinct U(q) ∩ Γ⁺,
  // Γ⁺ = the causes with a direct cut on an event outside X. Γ⁺ is one set for the whole stratum, so what q cites can't
  // split q's exposure into several classes (revisions 5–7 projected onto G(q), which q's author chooses with its
  // parents: vectors "r7c pclass", "r7c jclass"; mutant `class-proj-g`). An orphan (an X event without descendants) is
  // not counted and adds no cause to Γ⁺, so dropping it leaves the count unchanged ([H17]).
  let Gp = 0n
  for (const [x, m] of Dc) if (!Xs.has(x)) Gp |= m
  const projG = MUT === 'class-proj-g'
  const classes = new Set(
    counted
      .map(q => (projOff ? U(q) : projG ? U(q) & G(q) : U(q) & Gp))
      .filter((m, i) => m !== 0n && m !== (projOff ? ALLm : projG ? G(counted[i]) : Gp))
  ).size
  st.maxClasses = Math.max(st.maxClasses, classes)
  // The ruled work bound of r5 review I3 (b), not adopted (mutant `work-bound`): above (2^classes + 1) worlds × the ops
  // of Fl outside X and Tail the stratum would take the fallback. Fl holds junior ops, so a junior's backdated ops
  // switch a senior stratum and revive an op it had cut (vector "I3 (b): ...", O3-revive, G5; §10.16).
  const flatN =
    MUT === 'class-region' ? 0 : region.filter(q => flat.has(q) && !Xs.has(q) && !Ts.has(q)).length
  const work = (2 ** classes + 1) * flatN
  st.maxWork = Math.max(st.maxWork, work)
  const overWork = work > LIM.work && MUT === 'work-bound'
  if ((classes > LIM.classes || overWork) && MUT !== 'no-cap') {
    st.fallbacks++
    if (classes <= LIM.classes) st.workFallbacks++
    const cascTop = new Map<string, boolean>()
    for (const q of region) {
      const Wq = U(q)
      let ct = false
      if (Wq !== 0n && topList.some(x => cx.anc(q).has(x))) {
        let bk = brokenK.get(q)
        if (bk === undefined) brokenK.set(q, (bk = broken(q, cx, Kf)))
        if (!bk) {
          const A = cx.anc(q)
          const N = topList.filter(
            x =>
              A.has(x) &&
              (((Dc.get(x) ?? 0n) & Wq) !== 0n ||
                (cascTop.get(x) === true &&
                  (MUT === 'fallback-flat' || ((projOff ? U(x) : U(x) & G(x)) & ~Wq) === 0n)))
          )
          if (N.length) {
            st.brokenTests++
            ct = below(q, N) && broken(q, cx, Kf, N)
          }
        }
      }
      cascTop.set(q, ct)
      if (Dc.has(q) || ct) {
        top.add(q)
        topList.push(q)
      }
    }
    return top
  }
  for (const q of region) {
    let isCut = Dc.has(q)
    if (!isCut && topList.some(x => cx.anc(q).has(x))) {
      const Wq = U(q)
      topFlat = flat.has(q)
      isCut = Wq !== 0n && cascadeIn(q, Wq)
    }
    if (isCut) {
      top.add(q)
      topList.push(q)
    }
  }
  st.worlds += worlds.size
  st.maxWorlds = Math.max(st.maxWorlds, worlds.size)
  if (!projOff) {
    let mx = 0
    for (const ow of opWorlds.values()) mx = Math.max(mx, ow.size)
    st.maxOpWorlds = Math.max(st.maxOpWorlds, mx)
    if (mx > 2 ** classes + 1) {
      st.worldsOver++
      if (![...flat].some(q => Xs.has(q))) st.worldsOverClean++
    }
  }
  return top
}

/** Revision 3's attribution cascade, kept as the mutant `attrib-r3` (the [R3V C1] defect): labels are unions. */
function cascadeR3(
  ids: string[],
  cx: Ctx,
  direct: Map<string, Set<string>>,
  Uof: (p: string) => string[],
  alive: (id: string) => boolean,
  Kf: Set<string>,
  below: (o: string, N?: string[]) => boolean
): Set<string> {
  const L = new Map<string, Set<string>>()
  for (const [g, os] of direct)
    for (const o of os) {
      if (!L.has(o)) L.set(o, new Set())
      L.get(o)!.add(g)
    }
  for (;;) {
    const add: [string, Set<string>][] = []
    for (const p of ids) {
      if (!alive(p) || L.has(p)) continue
      const Up = new Set(Uof(p))
      if (!Up.size) continue
      const Np: string[] = []
      const lab = new Set<string>()
      for (const [x, lx] of L) {
        if (!cx.anc(p).has(x)) continue
        let hit = false
        for (const g of lx)
          if (Up.has(g)) {
            hit = true
            lab.add(g)
          }
        if (hit) Np.push(x)
      }
      if (!Np.length || broken(p, cx, Kf)) continue
      if (below(p, Np) && broken(p, cx, Kf, Np)) add.push([p, lab])
    }
    if (!add.length) break
    for (const [p, lab] of add) L.set(p, lab)
  }
  return new Set(L.keys())
}

/**
 * A conservative pre-filter for uses(o, d) in step 3 (revision 4, for the §5 benchmark): false only if making the deny d
 * effective in o's view can take away nothing o's authority reads (§1.4). A kick or ban of T touches T's operations, the
 * uninvites and unbans of T and the adds to T; a revoke touches its target's operations; an uninvite touches joins; a
 * role deny touches the operations of the role's holders (all members for `everyone`) and those naming the role. Every
 * add through a code is always touched, and so is a join whose causal past holds an add of its author through a code,
 * or that a code revocation or an uninvite of its author could reach (code liveness reads every live event, d
 * included). The fuzz checks on every case that evaluate() with and without the filter agree (property O9-prune).
 */
export function touches(o: Ev, d: Ev, Sto: Facts, viaCode: (o: Ev) => boolean): boolean {
  if (o.t === 'add' && o.c?.code !== undefined) return true
  if (
    o.t === 'join' &&
    (viaCode(o) || d.t === 'code_revoke' || (d.t === 'uninvite' && d.c.to === o.a))
  )
    return true
  switch (d.t) {
    case 'kick':
    case 'ban': {
      const T = d.c.to
      return (
        o.a === T || ((o.t === 'uninvite' || o.t === 'unban' || o.t === 'add') && o.c?.to === T)
      )
    }
    case 'revoke':
      return o.a === d.c.to
    case 'uninvite':
    case 'code_revoke':
      return false
    case 'role_move':
    case 'role_bits':
    case 'role_del': {
      const R = d.c.role
      return R === EVERYONE || (Sto.holds.get(o.a)?.has(R) ?? false) || o.c?.role === R
    }
    default:
      return true
  }
}

export function evaluate(
  ids: string[],
  cx: Ctx,
  opts: { prune?: boolean; ghosts?: string[] } = {}
): EvalResult {
  const prune = opts.prune ?? true
  const tA = performance.now()
  const { F, FI, RF, PC } = forkPoints(ids, cx, opts.ghosts)
  const X = equivocationCut(ids, cx, F, FI, RF, PC)
  stats.msForks += performance.now() - tA
  const k = (id: string) => cx.rec(id).k
  const isD = (id: string) => cx.rec(id).cls === 'D'
  const isSelfD = (id: string) => isD(id) && cx.rec(id).self
  const fixed = (id: string) => fixedT(cx.ev(id).t) // never cut
  const conc = (x: string, y: string) => x !== y && !cx.anc(x).has(y) && !cx.anc(y).has(x)

  // Revocations in force: a device_revoke or a primary_rotate not in X (revision 5, [H17]: a rotation with rotation
  // evidence can be in X). Absorbing, never cut. Their tails (events of the revoked or dropped device past the
  // watermark) are cut at each tail op's own stratum. A rotation drops only devices that a non-X event introduces
  // ([H17]: an X introduction may be dropped as an orphan, so it must not decide anything; its device has only X events).
  const revs = ids.filter(
    id => (cx.ev(id).t === 'device_revoke' || cx.ev(id).t === 'primary_rotate') && !X.has(id)
  )
  const idsNoX = MUT === 'drops-all' ? ids : ids.filter(id => !X.has(id))
  const tailBy = new Map<string, string[]>()
  for (const r of revs) {
    const re = cx.ev(r)
    const covered =
      re.t === 'device_revoke'
        ? [{ dev: re.c.dev as string, seen: re.c.seen as number }]
        : droppedBy(re, idsNoX, cx).map(v => ({ dev: v, seen: (re.c.seen?.[v] ?? -1) as number }))
    for (const { dev, seen } of covered) {
      for (const o of ids) {
        const oe = cx.ev(o)
        if (oe.dev !== dev || oe.seq <= seen || fixed(o)) continue
        if (MUT === 'rev-stratum' && cmp(k(o), k(r)) > 0) continue
        if (!tailBy.has(o)) tailBy.set(o, [])
        if (!tailBy.get(o)!.includes(r)) tailBy.get(o)!.push(r)
      }
    }
  }
  const tail = new Set(tailBy.keys())

  const cut = new Map<string, Rank>()
  const eff = new Set<string>(revs)
  const strataMap = new Map<string, Rank>()
  for (const id of ids) {
    if (tail.has(id)) strataMap.set(rkey(k(id)), k(id))
    else if (!X.has(id) && isD(id) && !fixed(id)) strataMap.set(rkey(k(id)), k(id))
  }
  const strata = [...strataMap.values()].sort((a, b) => cmp(b, a))
  const shieldX = MUT === 'x-shield'

  const everHeld = new Map<string, Set<string>>()
  for (const id of ids) {
    const e = cx.ev(id)
    if (e.t === 'assign') {
      if (!everHeld.has(e.c.to)) everHeld.set(e.c.to, new Set())
      everHeld.get(e.c.to)!.add(e.c.role)
    }
  }
  const heldEver = (P: string) => everHeld.get(P) ?? new Set<string>()
  const codeAdds = ids.filter(id => cx.ev(id).t === 'add' && cx.ev(id).c?.code !== undefined)
  const viaCode = (o: Ev) => codeAdds.some(g => cx.ev(g).c.to === o.a && cx.anc(o.id).has(g))
  for (const kk of strata) {
    const tS = performance.now()
    const Kf = new Set(cut.keys())
    const voidK = new Set([...X, ...Kf, ...tail])
    const effHigh = new Set(eff)
    const alive = (id: string) => !cut.has(id) && !fixed(id) && !(shieldX && X.has(id))
    const atK = (id: string) => cmp(k(id), kk) === 0
    const ksMemo = new Map<string, Rank>()
    const ks = (id: string) => {
      let v = ksMemo.get(id)
      if (!v) ksMemo.set(id, (v = kstar(id, cx, Kf, effHigh)))
      return v
    }
    // k*(o) < kk and k*(o) <= kk, computing k* only when the admission stratum doesn't decide it (k* <= k).
    // with the world's cuts N, k* uses the monotone resource rank (revision 5)
    const below = (o: string, N?: string[]) =>
      cmp(k(o), kk) < 0 || (!isD(o) && cmp(N ? kstar(o, cx, Kf, effHigh, N) : ks(o), kk) < 0)
    const atOrBelow = (o: string) => cmp(k(o), kk) <= 0 || (!isD(o) && cmp(ks(o), kk) <= 0)
    const liveDeny = (id: string) => alive(id) && !X.has(id) && !tail.has(id) && isD(id)
    // V_γ: facts of S \ fut(γ) under the decisions above kk (no landmines, [RV I3]); one view per cause ([R2V C1]).
    const Vmemo = new Map<string, Facts>()
    const Vof = (g: string) => {
      let V = Vmemo.get(g)
      if (!V) {
        const Sg = MUT === 'no-future-excl' ? ids : ids.filter(x => !cx.anc(x).has(g))
        Vmemo.set(g, (V = facts(Sg, voidK, effHigh, cx, X)))
      }
      return V
    }
    // V_γ^p: V_γ without the decisions above kk that were made after p (in fut(p)): a later removal or demotion of p's
    // author never exposes what it did before ([H8], seed 5263 in §7.7).
    // Exposure reads only the author's rank, so only later decisions about the author or a role it was ever assigned
    // can change it; the others are left in, which keeps one view per relevant set (the oracles use the full set).
    const Vpmemo = new Map<string, Facts>()
    const relevant = (d: string, P: string) => {
      const de = cx.ev(d)
      if (de.t === 'kick' || de.t === 'ban' || de.t === 'revoke') return de.c.to === P
      if (de.t === 'leave') return de.a === P
      if (de.t === 'role_move' || de.t === 'role_bits' || de.t === 'role_del')
        return heldEver(P).has(de.c.role)
      return false
    }
    const Vfor = (g: string, p: string) => {
      if (MUT === 'late-exposure') return Vof(g)
      const P = cx.ev(p).a
      const later = [...effHigh].filter(d => cx.anc(d).has(p) && relevant(d, P)).sort()
      if (!later.length) return Vof(g)
      const key = `${g}|${later.join(',')}`
      let V = Vpmemo.get(key)
      if (!V) {
        const Sg = MUT === 'no-future-excl' ? ids : ids.filter(x => !cx.anc(x).has(g))
        const hi = new Set(effHigh)
        for (const d of later) hi.delete(d)
        Vpmemo.set(key, (V = facts(Sg, voidK, hi, cx, X)))
      }
      return V
    }
    const direct = new Map<string, Set<string>>() // cause -> its direct cuts at kk
    const addD = (g: string, o: string) => {
      if (!direct.has(g)) direct.set(g, new Set())
      direct.get(g)!.add(o)
    }

    // 0. Revocation cuts: tail ops at this stratum (unconditional), attributed to every revocation whose tail holds them.
    for (const o of ids)
      if (tail.has(o) && alive(o) && atK(o)) for (const r of tailBy.get(o)!) addD(r, o)

    // 1. Self-denies at this stratum are effective; they cut their author's ops that did not see them, at or below kk.
    const selves = ids.filter(s => liveDeny(s) && isSelfD(s) && atK(s))
    const selfCuts = new Set<string>()
    for (const s of selves) {
      const se = cx.ev(s)
      for (const o of ids) {
        if (!alive(o) || o === s || cx.ev(o).a !== se.a || isSelfD(o)) continue
        if (!atOrBelow(o)) continue
        if (!frontier(o, s, cx)) continue
        if (uses(o, s, cx, Kf)) {
          selfCuts.add(o)
          addD(s, o)
        }
      }
    }

    // 2. Non-self denies: effective iff the target is not protected in V_d (decisions above kk, d's causal future excluded).
    const nonSelf = ids.filter(
      d => liveDeny(d) && !isSelfD(d) && atK(d) && (MUT === 'self-late' || !selfCuts.has(d))
    )
    const effNS = nonSelf.filter(d => !protectedTarget(cx.ev(d), cx.rec(d).local.facts, Vof(d), kk))

    // 3. Frontier cut: ops that did not see an effective deny, below its stratum (or the target's own non-deny ops at it),
    //    whose author is exposed to it, and that relied on what the deny removes.
    for (const d of effNS) {
      const V = Vof(d)
      const de = cx.ev(d),
        dr = cx.rec(d)
      const tg = target(de, dr.local.facts)
      for (const o of ids) {
        if (!alive(o)) continue
        if (MUT === 'concurrent-frontier' ? !conc(o, d) : !frontier(o, d, cx)) continue
        const oe = cx.ev(o)
        if (prune && !touches(oe, de, cx.rec(o).local.facts, viaCode)) continue
        const sameTarget =
          MUT !== 'no-same-target' && !isD(o) && tg.kind === 'member' && oe.a === tg.who
        if (!(sameTarget ? atOrBelow(o) : below(o))) continue
        // the deny's own target is judged in V_d, the view that decided the deny's effectiveness (G6); others in V_d^o
        if (
          !exposedTo(
            oe,
            de,
            dr,
            sameTarget ? V : Vfor(d, o),
            kk,
            sameTarget && dr.local.facts.mem.has(oe.a)
          )
        )
          continue
        if (uses(o, d, cx, Kf)) addD(d, o)
      }
    }

    // 4. Cascade with exact per-cause protection (revision 4, [R3V C1]). The causes Γ of the stratum are its effective
    //    self-denies and denies and the revocations with direct cuts here. U(p) is the set of causes p's author is
    //    exposed to. An op is cut at kk iff it is a direct cut, or it is newly broken by the cuts in its causal past
    //    that the causes in U(p) would make on their own ("world" U(p)); inside a world W, an earlier op x counts only
    //    if it is cut (in the result) and would be cut in the world W ∩ U(x) (recursively), so every op on the path
    //    is judged only by causes its own author is exposed to. Revision 3 attributed each cut to the union of the
    //    causes of everything in its past, which let an unrelated same-stratum cause launder a protected author's
    //    exposure (mutant `attrib-r3`).
    // revision 5 (dispatch 5b, [H16]): a cause without direct cuts contributes nothing to any world and is left out, so
    // a deny on the heads (it cuts nothing) can't change the protection classes of its stratum
    const causes = [
      ...new Set([...selves, ...effNS, ...[...direct.keys()].filter(g => isRevocation(cx.ev(g)))]),
    ]
      .filter(g => MUT === 'class-region' || direct.has(g))
      .sort()
    const Vshared =
      MUT === 'shared-vc'
        ? facts(
            ids.filter(x => !causes.some(g => cx.anc(x).has(g))),
            voidK,
            effHigh,
            cx,
            X
          )
        : undefined
    const Uof = (p: string) => {
      const pe = cx.ev(p)
      return Vshared
        ? protectedP(Vshared, pe.a, kk)
          ? []
          : causes
        : causes.filter(g => exposedTo(pe, cx.ev(g), cx.rec(g), Vfor(g, p), kk))
    }
    const t4 = performance.now()
    stats.msSteps03 += t4 - tS
    stats.causes += causes.length
    stats.maxCauses = Math.max(stats.maxCauses, causes.length)
    const newCuts = causes.length
      ? MUT === 'attrib-r3'
        ? cascadeR3(ids, cx, direct, Uof, alive, Kf, below)
        : cascadeExact(ids, cx, causes, direct, Uof, alive, Kf, below, stats, X, tail)
      : new Set<string>()
    for (const o of newCuts) cut.set(o, kk)
    for (const d of [...selves, ...effNS]) eff.add(d)
    stats.msStep4 += performance.now() - t4
  }
  const voidS = new Set([...X, ...cut.keys(), ...tail])
  const tF = performance.now()
  const fin = facts(ids, voidS, eff, cx, X)
  stats.msFacts += performance.now() - tF
  return { facts: fin, X, tail, cut, eff, F, FI, RF, PC, void: voidS }
}

// ---------------------------------------------------------------- admission (§2.2)

export type Verdict = { s: 'A' } | { s: 'R'; why: string } | { s: 'P'; missing: string[] }

/**
 * The identity chain position for a new identity op of `a` with causal past B (§2.2, §2.3). Rotations in B start epochs:
 * the current epoch is the one started by the single maximal rotation of `a` in B (or the genesis epoch). A non-rotation
 * identity op continues the current epoch: its iprev is the epoch's last identity op, and it is refused while the epoch is
 * forked or while two rotations are both maximal. A primary_rotate (recovery-signed) is admitted whatever the forks; its
 * iprev is the deepest identity op of `a` in B (lowest id on ties), and it starts its own epoch.
 */
export function identityHead(
  a: string,
  B: string[],
  cx: Ctx,
  rotation: boolean,
  FI?: Map<string, number>
): { iprev?: string; depth: number; epoch: string; refused?: string } {
  const mine = B.filter(id => cx.ev(id).a === a && cx.rec(id).depth >= 0)
  const depthOf = (id: string) => cx.rec(id).depth
  if (rotation && MUT !== 'revoke-on-chain') {
    let li: string | undefined
    for (const id of mine)
      if (!li || depthOf(id) > depthOf(li) || (depthOf(id) === depthOf(li) && id < li)) li = id
    return { iprev: li, depth: li ? depthOf(li) + 1 : 0, epoch: '' }
  }
  const rots = mine.filter(id => cx.ev(id).t === 'primary_rotate')
  const maxRot = rots.filter(r => !rots.some(r2 => r2 !== r && cx.anc(r2).has(r))).sort()
  if (maxRot.length > 1) return { depth: -1, epoch: '', refused: 'identity-forked' }
  const epoch = maxRot[0] ?? ''
  if (FI && fiOf(FI, a, epoch) < Infinity) return { depth: -1, epoch, refused: 'identity-forked' }
  const inEpoch = epoch ? mine.filter(id => id === epoch || cx.anc(id).has(epoch)) : mine
  let li: string | undefined
  for (const id of inEpoch)
    if (!li || depthOf(id) > depthOf(li) || (depthOf(id) === depthOf(li) && id < li)) li = id
  return { iprev: li, depth: li ? depthOf(li) + 1 : 0, epoch }
}

// W3 exemptions (§4.1): denies (D and S classes) and upgrade. Revision 4 ([R3V I2]) charges the denies that remove nothing
// from a member or invitee: a ban of a principal that B(e) has never seen join or be invited, and every role_move (a
// move is a reorder with unbounded positions; demoting a member stays possible, exempt, by revoke or kick). Owners are
// not exempt (revision 3, [R2V I3]).
/** T is known in B: B holds a join by T or an add naming T (a member, an invitee, or a former one). */
const known = (T: string, B: string[], cx: Ctx) =>
  B.some(id => {
    const x = cx.ev(id)
    return (x.t === 'join' && x.a === T) || (x.t === 'add' && x.c?.to === T)
  })
export const chargedDeny = (e: Ev, B: string[], cx: Ctx) =>
  MUT !== 'deny-breadth' && ((e.t === 'ban' && !known(e.c?.to, B, cx)) || e.t === 'role_move')
const exemptOf = (e: Ev, F: Facts, cls: Cls, B: string[], cx: Ctx) =>
  (cls === 'D' && !chargedDeny(e, B, cx)) ||
  e.t === 'upgrade' ||
  (MUT === 'owner-exempt' && F.owners.has(e.a))

/** The primary certificate of a's current epoch in B ("" for the genesis epoch), and whether the epoch is split or forked. */
function epochState(a: string, B: string[], cx: Ctx, FI: Map<string, number>) {
  const rots = B.filter(id => cx.ev(id).a === a && cx.ev(id).t === 'primary_rotate')
  const maxRot = rots.filter(r => !rots.some(r2 => r2 !== r && cx.anc(r2).has(r)))
  if (maxRot.length > 1) return { pcert: '', split: true }
  const ep = maxRot[0] ?? ''
  return { pcert: ep ? String(cx.ev(ep).c?.pcert ?? '') : '', split: fiOf(FI, a, ep) < Infinity }
}

/** Events the W3(b) total counts (§4.1): every ACL event except leave, device_revoke, primary_rotate and upgrade. */
export const totCounted = (x: Ev) =>
  x.t !== 'leave' &&
  x.t !== 'device_revoke' &&
  x.t !== 'primary_rotate' &&
  x.t !== 'upgrade' &&
  x.t !== 'genesis'
/** x (an event of identity a) is acknowledged in B: some event of another identity in B has x in its past (§4.1). */
export const acked = (x: string, a: string, B: string[], cx: Ctx) =>
  B.some(f => cx.ev(f).a !== a && cx.anc(f).has(x))

export function decide(
  e: Ev,
  B: string[],
  cx: Ctx,
  S: EvalResult
): { ok: true; rec: Rec } | { ok: false; why: string } {
  const F = S.facts
  // §1.2: `ap` lists 1..10 parents (revision 6, r5 review M2: enforced here; mutant `ap-uncapped`)
  if (e.ap.length > LIM.ap && MUT !== 'ap-uncapped') return { ok: false, why: 'ap' }
  if (devOwner(e.dev) !== e.a) return { ok: false, why: 'dev' }
  // A1 device, device chain, identity chain
  if ((S.F.get(e.dev) ?? Infinity) < Infinity) return { ok: false, why: 'forked' }
  // revision 7 (r7.6, controller's proposal from the production re-review, not adopted): refuse an event one of whose
  // parents is a device-fork candidate in St(e). It refuses honest clients citing an upgrade or a rotation past its
  // device's fork point, and a tree over distinct devices still layers siblings (vector "r7.6"); mutant `fork-parent`
  if (MUT === 'fork-parent')
    for (const p of e.ap) {
      const pe = cx.ev(p)
      if (pe.seq >= (S.F.get(pe.dev) ?? Infinity)) return { ok: false, why: 'fork-parent' }
    }
  const own = B.map(id => cx.ev(id))
    .filter(x => x.dev === e.dev)
    .sort((x, y) => x.seq - y.seq)
  const last = own[own.length - 1]
  if ((e.aprev ?? '') !== (last?.id ?? '')) return { ok: false, why: 'aprev' }
  if (last && e.seq <= last.seq) return { ok: false, why: 'seq' }
  let depth = -1,
    epoch = ''
  if (idOp(e, F)) {
    const h = identityHead(e.a, B, cx, e.t === 'primary_rotate', S.FI)
    if (h.refused) return { ok: false, why: h.refused }
    if ((e.iprev ?? '') !== (h.iprev ?? '')) return { ok: false, why: 'iprev' }
    depth = h.depth
    epoch = e.t === 'primary_rotate' && MUT !== 'revoke-on-chain' ? e.id : h.epoch
  } else if (e.iprev) return { ok: false, why: 'iprev' }
  // revocation watermarks cover every event of each revoked or dropped live device in B(e)
  const maxSeqIn = (dev: string) =>
    Math.max(
      -1,
      ...B.map(id => cx.ev(id))
        .filter(x => x.dev === dev)
        .map(x => x.seq)
    )
  if (e.t === 'device_revoke') {
    if (!(typeof e.c.seen === 'number' && e.c.seen >= maxSeqIn(e.c.dev)))
      return { ok: false, why: 'seen' }
  }
  if (e.t === 'primary_rotate') {
    // every device the rotation drops (live or not) needs a watermark covering its events in B(e); absent means −1
    const keepR = new Set<string>([
      e.dev,
      ...((Array.isArray(e.c.keep) ? e.c.keep : []) as string[]),
    ])
    const checked =
      MUT === 'rot-watermark'
        ? [...(F.devs.get(e.a) ?? [])].filter(v => !keepR.has(v))
        : droppedBy(e, B, cx)
    for (const v of checked) {
      const s = e.c.seen?.[v] ?? -1
      if (!(typeof s === 'number' && s >= maxSeqIn(v))) return { ok: false, why: 'seen' }
    }
  }
  // A2 timestamps: a causal lower bound only (no clock).
  for (const p of e.ap) if (e.ts < cx.ev(p).ts) return { ok: false, why: 'ts' }
  // A3 authority and guards
  if (!admissible(e, F)) return { ok: false, why: 'auth' }
  const { cls, self } = classify(e, F)
  const exempt = exemptOf(e, F, cls, B, cx)
  // W3(g) identity pool (revision 5, dispatch 5b-ii, controller ruling on growth, [H20]; non-owners): U(e) = the events
  // of e's identity in B(e) ∪ {e} that no event of another identity in B(e) has in its past, every kind except genesis,
  // and |U(e)| ≤ poolU. W3(b) bounds each device chain; this bounds what one view of the identity holds unacknowledged
  // across all its devices, and U(e) is recorded: evaluation makes an event a candidate when the pool of its concurrent
  // events overflows (forkPoints, §2.3). Mutant `pool-off` (neither part: the 5b-i rule).
  // recorded for every author (owners too: W3(b) reads it), applied to non-owners only (cap and pool candidacy)
  let pool: string[] | undefined
  if (MUT !== 'pool-off') {
    // computed from the parents' recorded pools (equal to the definition; props O11-pool checks it independently): a
    // foreign parent acknowledges everything in its closure, and x in the pool of one parent of e's identity is
    // acknowledged in B(e) iff some parent's closure holds x outside that parent's pool
    const ap = [...new Set(e.ap)]
    const poolOf = new Map<string, Set<string>>()
    for (const p of ap) if (cx.ev(p).a === e.a) poolOf.set(p, new Set(cx.rec(p).pool ?? []))
    const cand = new Set<string>()
    for (const P of poolOf.values()) for (const x of P) cand.add(x)
    pool = [
      ...[...cand].filter(x =>
        ap.every(p => {
          if (p !== x && !cx.anc(p).has(x)) return true
          const P = poolOf.get(p)
          return P !== undefined && P.has(x)
        })
      ),
      e.id,
    ].sort()
  }
  // the identity's events in B(e) that no event of another identity in B(e) has in its past (U(e) without e); the
  // W3(b), W3(c), W3(d) and W3(f) tests below read it instead of testing each event against B(e)
  const unackedB = pool ? new Set(pool.filter(x => x !== e.id)) : undefined
  const isUnacked = (x: string) => (unackedB ? unackedB.has(x) : !acked(x, e.a, B, cx))
  // A4 deterministic windows (§4.1): W3 per device over its own chain in B(e); W3(c) per identity; W5 live-state caps.
  if (!exempt) {
    const cap = perms(F, e.a) & MODBITS ? LIM.w3mod : LIM.w3
    const mine = own.filter(x => !cx.rec(x.id).exempt)
    // W3(a) window: the device's non-exempt events dated within one window
    const n = mine.filter(x => x.ts > e.ts - LIM.win).length
    if (n + 1 > cap) return { ok: false, why: 'W3' }
    if (MUT === 'anchor-r3') {
      // revision 3's backlog bound (the [R3V I1]/[R3V I3] defect): anchored at the newest event of another identity
      let anchor = -Infinity
      for (const id of B) {
        const x = cx.ev(id)
        if (x.a !== e.a || x.t === 'genesis') anchor = Math.max(anchor, x.ts)
      }
      const lim = anchor + LIM.win
      if (e.ts > lim && mine.filter(x => x.ts > lim).length + 1 > cap)
        return { ok: false, why: 'W3b' }
    } else if (MUT === 'day-window') {
      // W3(b) unacknowledged day ([R3V I1], [R3V I3]): the device's non-exempt events dated within one day that no event
      // of another identity in B(e) acknowledged within one window of their ts. An event can only acknowledge events
      // made before it, so citing old events never acknowledges a backlog made later: the budget is the same whatever
      // the backlog cites. A device whose events others see in time is bound by (a) alone; a lone device is never
      // blocked while it stays within the day budget.
      // revision 5 ([R4V I2]): the same budget for every author, dayU (revision 4: 4 × the hourly cap, so 10× more for
      // moderators and owners); mutant `day-r4` restores revision 4's budget
      const dayCap = MUT === 'day-r4' ? LIM.dayMul * cap : LIM.dayU
      const recent = mine.filter(x => x.ts > e.ts - LIM.day)
      if (recent.length + 1 > dayCap) {
        const foreign = B.filter(id => cx.ev(id).a !== e.a)
        const unacked = recent.filter(
          x => !foreign.some(f => cx.anc(f).has(x.id) && cx.ev(f).ts <= x.ts + LIM.win)
        )
        if (unacked.length + 1 > dayCap) return { ok: false, why: 'W3b' }
      }
    }
  }
  if (
    MUT !== 'no-day' &&
    MUT !== 'day-window' &&
    MUT !== 'anchor-r3' &&
    (MUT === 'w3b-mod' ? !exempt : totCounted(e))
  ) {
    // W3(b) unacknowledged total (revision 5, dispatch 5b, controller ruling on growth): the device's counted events in
    // B(e) that no event of another identity in B(e) has in its past, plus e, ≤ totU, whatever their ts. An event
    // acknowledges only events made before it, by another identity, so citing old events acknowledges nothing; there is
    // no window, so a removed member's unacknowledged backlog is bounded in total, not per idle day. A lone device is
    // blocked after totU such events until another member posts an ACL event that has them in its past. Counted: every
    // ACL event except leave, device_revoke, primary_rotate and upgrade, so moderation too ([H18]: a removed moderator's
    // exempt removals were bounded only by the members it could remove, per device chain); moderation stays exempt
    // from the hourly cap W3(a). Mutants: `day-window` restores dispatch 5a's day window (24 per day, acknowledged within
    // the hour); `w3b-mod` counts only non-exempt events (moderation uncounted).
    const mine = own.filter(x => (MUT === 'w3b-mod' ? !cx.rec(x.id).exempt : totCounted(x)))
    if (mine.length + 1 > LIM.totU) {
      const unacked = mine.filter(x => isUnacked(x.id))
      if (unacked.length + 1 > LIM.totU) return { ok: false, why: 'W3b' }
    }
  }
  // W3(e) vouched invites (revision 5, dispatch 5b, [H18]): a join of a non-owner needs a live add for it that an owner
  // posted, or that an ACL event f in B(e) of an identity other than the add's author and the joiner has in its past.
  // Good faith needs no separate test: a live add is not in X of St(e), so it is either no candidate in St(e), and then
  // no structural candidate in any St(f) for f in B(e) (structural candidacy only grows with the set; revision 7: a pool
  // candidacy can end, and is no fork evidence, so an acknowledgement in a view where the add was one vouches), or a candidate witnessed in good
  // faith by a clean event of a third identity in B(e), which then vouches (an explicit good-faith test was an
  // equivalent mutant). Without it a member that holds Invite in St(e) (a removed one at its old position, or a live
  // one) invites sybils on each branch of a fork of its own device: each sybil's join witnesses its branch, so every branch keeps its own budgets and its sybils, and the sybils acknowledge the inviter's
  // events, so W3(b) never binds; one identity alone then adds unboundedly many events (and members) at once. Every
  // identity that can post is now an owner or was let in by an identity other than its inviter, so acknowledgements and
  // witnesses always involve an identity the author did not create. Mutant `sybil-join`.
  if (e.t === 'join' && !F.owners.has(e.a) && MUT !== 'sybil-join') {
    const inv = F.invited.get(e.a) ?? []
    const vouched = inv.some(
      g =>
        F.owners.has(g.a) ||
        B.some(f => {
          const fa = cx.ev(f).a
          return fa !== g.a && fa !== e.a && cx.anc(f).has(g.id)
        })
    )
    if (!vouched) return { ok: false, why: 'W3e' }
  }
  // W3(d)(1) of dispatch 5a (a fresh device posts at most 24 non-exempt events until acknowledged) is subsumed by the
  // W3(b) total above (every device, fresh or not, has at most totU unacknowledged non-exempt events) and is removed.
  // W3(c) identity churn ([R3V I2] class): device_adds of the identity in its current epoch dated within one day, and its
  // primary_rotates dated within one day, each within a small cap. Every new device has an empty chain, so per-device
  // windows can't bound churn through fresh devices.
  if (MUT !== 'id-churn') {
    const inDay = (t: T, ep?: string) =>
      B.filter(id => {
        const x = cx.ev(id)
        return (
          x.a === e.a &&
          x.t === t &&
          x.ts > e.ts - LIM.day &&
          (ep === undefined || cx.rec(id).epoch === ep)
        )
      }).length
    // revision 5 ([R4V I2]): device_adds are counted across epochs (revision 4 counted the current epoch only, so each
    // rotation opened a fresh allowance); mutant `epoch-churn` restores that
    if (
      e.t === 'device_add' &&
      inDay('device_add', MUT === 'epoch-churn' ? epoch : undefined) + 1 > LIM.idCap
    )
      return { ok: false, why: 'W3c' }
    if (e.t === 'primary_rotate' && inDay('primary_rotate') + 1 > LIM.rotCap)
      return { ok: false, why: 'W3c' }
  }
  // W3(c) rotation total (revision 5, dispatch 5b, [H17]; non-owners): the identity's rotations in B(e) that no event of
  // another identity in B(e) has in its past, plus e, ≤ rotTot, whatever their ts. Rotations are the one kind of
  // introduction W3(d) never refuses (recovery); with concurrent ones void unless witnessed (rotation evidence, §2.3)
  // and sequential ones capped here, the uncontested continuation of a removed member's identity chain introduces at
  // most freshCap + rotTot devices, so the inert events it can leave are bounded in total (§4.1, [H19]). Acknowledged rotations don't count: a member that recovers with
  // others online is never limited. Mutant `id-totals-off` (no total; the day cap of W3(c) alone).
  if (e.t === 'primary_rotate' && !F.owners.has(e.a) && MUT !== 'id-totals-off') {
    const unackedRot = (unackedB ? [...unackedB] : B).filter(
      id => cx.ev(id).a === e.a && cx.ev(id).t === 'primary_rotate' && isUnacked(id)
    )
    if (unackedRot.length + 1 > LIM.rotTot) return { ok: false, why: 'W3c' }
  }
  // W3(d) fresh introductions (revision 5, [R4V I2]): a device_add of a non-owner is refused while B(e) holds freshCap
  // device_adds of the identity that no event of another identity in B(e) has in its past. The identity chain is linear,
  // so every earlier device_add is in B(e): a removed member can mint at most freshCap fresh devices that way in total,
  // not 8 per day of its idle range. Rotations (recovery) are never refused and don't count; W3(c) caps them per day.
  if (e.t === 'device_add' && MUT !== 'no-fresh' && !F.owners.has(e.a)) {
    const unackedIntro = (unackedB ? [...unackedB] : B).filter(id => {
      const x = cx.ev(id)
      return x.a === e.a && x.t === 'device_add' && isUnacked(id)
    }).length
    if (unackedIntro + 1 > LIM.freshCap) return { ok: false, why: 'W3d' }
  }
  // W3(f) no pinning (revision 5, dispatch 5b, [H18]): a non-owner's event is refused while B(e) holds evidence (device:
  // one device, same seq or same aprev; identity: one epoch, same iprev; rotation: any two concurrent ones; race: a
  // rotation and a non-rotation op over one iprev, [H19]) between two events of its
  // own identity that no event of another identity in B(e) has in its past. Each side of such a pair is a candidate that
  // nobody witnessed, so the orphan rule could drop it with its device's events, unless a non-void descendant pins it;
  // without this rule the identity pinned any number of concurrent introductions or fork branches (each with a full
  // budget) by citing them all from a later rotation. Honest devices never fork, and recovery needs no such citation.
  // Mutant `pin-ok`.
  if (!F.owners.has(e.a) && MUT !== 'pin-ok') {
    // events in the past of one of the identity's rotations in B(e) were checked by that rotation (which may see one
    // pair per key: the recovery it is), so a resolved race or fork never blocks the identity afterwards
    const rotsB = B.filter(id => cx.ev(id).a === e.a && cx.ev(id).t === 'primary_rotate')
    const mineU = (unackedB ? [...unackedB] : B)
      .filter(id => cx.ev(id).a === e.a && isUnacked(id) && !rotsB.some(r => cx.anc(r).has(id)))
      .map(id => cx.ev(id))
    const seenDev = new Map<string, Set<string>>()
    // [H19]: rotation evidence is any two concurrent rotations (two rotations in mineU are always concurrent: neither is
    // in the past of a rotation in B(e)), and a rotation pairs with a non-rotation op over the same iprev (race)
    const rotPrevU = new Set(mineU.filter(x => x.t === 'primary_rotate').map(x => x.iprev ?? ''))
    for (const x of mineU) {
      const kd = [`${x.dev}|s${x.seq}`, `${x.dev}|a${x.aprev ?? ''}`]
      const r = cx.rec(x.id)
      const ki =
        r.depth >= 0 && x.t !== 'genesis'
          ? x.t === 'primary_rotate'
            ? [`rot|${x.a}`, `race|${x.iprev ?? ''}`]
            : [
                `id|${r.epoch}|${x.iprev ?? ''}`,
                ...(rotPrevU.has(x.iprev ?? '') ? [`race|${x.iprev ?? ''}`] : []),
              ]
          : []
      for (const k of [...kd, ...ki]) {
        // a rotation may see one pair per key: it is the recovery that resolves a two-way race or fork (§3.9)
        const n = (seenDev.get(k)?.size ?? 0) + 1
        if (n > (e.t === 'primary_rotate' ? 2 : 1)) return { ok: false, why: 'W3f' }
        if (!seenDev.has(k)) seenDev.set(k, new Set())
        seenDev.get(k)!.add(x.id)
      }
    }
  }
  // W6 for primary_rotate ([R3V M2]): a rotation must change a fact: drop a live device, introduce its posting device,
  // install a new primary certificate, or recover an identity whose current epoch is forked or split.
  if (e.t === 'primary_rotate' && MUT !== 'rot-noop') {
    const live = F.devs.get(e.a) ?? new Set<string>()
    const keepR = new Set<string>([
      e.dev,
      ...((Array.isArray(e.c?.keep) ? e.c.keep : []) as string[]),
    ])
    const es = epochState(e.a, B, cx, S.FI)
    const changes =
      [...live].some(v => !keepR.has(v)) ||
      !live.has(e.dev) ||
      String(e.c?.pcert ?? '') !== es.pcert ||
      es.split
    if (!changes) return { ok: false, why: 'W6' }
  }
  if (e.t === 'role_create' && F.roles.size + 1 > LIM.roles) return { ok: false, why: 'W5' }
  if (e.t === 'add') {
    let n = 0
    for (const ps of F.pending.values()) for (const p of ps) if (p.dev === e.dev) n++
    if (n + 1 > LIM.pendingPerDev) return { ok: false, why: 'W5' }
  }
  if (e.t === 'code') {
    let n = 0
    for (const cd of F.codes.values()) if (cd.dev === e.dev) n++
    if (n + 1 > (perms(F, e.a) & SERVER ? LIM.codesPerDevServer : LIM.codesPerDev))
      return { ok: false, why: 'W5' }
  }
  if (pool && !F.owners.has(e.a) && pool.length > LIM.poolU && MUT !== 'pool-cap-off')
    return { ok: false, why: 'W3g' }
  return { ok: true, rec: { k: rank(F, e.a), cls, self, exempt, depth, epoch, local: S, pool } }
}

// ---------------------------------------------------------------- replica

export class Replica implements Ctx {
  evs = new Map<string, Ev>()
  status = new Map<string, Verdict>()
  recs = new Map<string, Rec>()
  ancs = new Map<string, Set<string>>()
  order: string[] = [] // admitted, in arrival order
  waiting: Ev[] = []
  memo = new Map<string, EvalResult>()

  ev(id: string) {
    return this.evs.get(id)!
  }
  anc(id: string) {
    return this.ancs.get(id)!
  }
  rec(id: string) {
    return this.recs.get(id)!
  }

  evalSet(ids: string[]): EvalResult {
    const key = [...ids].sort().join(',')
    let r = this.memo.get(key)
    if (!r) {
      r = evaluate(ids, this)
      this.memo.set(key, r)
    }
    return r
  }
  admitted(id: string) {
    return this.status.get(id)?.s === 'A'
  }
  state(): EvalResult {
    return this.evalSet(this.order)
  }

  receive(e: Ev) {
    if (this.status.has(e.id)) return // duplicates (including re-delivery of a pending event) are ignored
    this.evs.set(e.id, e)
    this.try1(e)
    for (let progress = true; progress;) {
      progress = false
      const w = this.waiting
      this.waiting = []
      for (const x of w) {
        this.try1(x)
        if (this.status.get(x.id)!.s !== 'P') progress = true
      }
    }
  }

  private try1(e: Ev) {
    if (e.t === 'genesis') {
      const ok =
        e.seq === 0 &&
        e.ap.length === 0 &&
        (e.c.owners ?? []).includes(e.a) &&
        devOwner(e.dev) === e.a &&
        !e.aprev &&
        !e.iprev
      if (!ok) return this.status.set(e.id, { s: 'R', why: 'genesis' })
      this.ancs.set(e.id, new Set())
      const emptyF = {
        facts: undefined as any,
        X: new Set<string>(),
        tail: new Set<string>(),
        cut: new Map(),
        eff: new Set<string>(),
        F: new Map(),
        FI: new Map(),
        void: new Set<string>(),
      }
      this.recs.set(e.id, {
        k: TOP,
        cls: 'G',
        self: false,
        exempt: true,
        depth: 0,
        epoch: '',
        local: emptyF,
      })
      this.status.set(e.id, { s: 'A' })
      this.order.push(e.id)
      return
    }
    if (!e.ap.length) return this.status.set(e.id, { s: 'R', why: 'no-parents' })
    const missing: string[] = []
    for (const p of e.ap) {
      const st = this.status.get(p)
      if (st?.s === 'R') return this.status.set(e.id, { s: 'R', why: 'parent' })
      if (st?.s !== 'A') missing.push(p)
    }
    if (missing.length) {
      this.status.set(e.id, { s: 'P', missing })
      this.waiting.push(e)
      return
    }
    const B = new Set<string>()
    for (const p of e.ap) {
      B.add(p)
      for (const x of this.anc(p)) B.add(x)
    }
    const Bl = this.order.filter(x => B.has(x)) // replica-local iteration order
    this.ancs.set(e.id, B)
    const S = this.evalSet(Bl)
    const d = decide(e, Bl, this, S)
    if (!d.ok) {
      this.ancs.delete(e.id)
      return this.status.set(e.id, { s: 'R', why: d.why })
    }
    this.recs.set(e.id, d.rec)
    this.status.set(e.id, { s: 'A' })
    this.order.push(e.id)
  }
}

// ---------------------------------------------------------------- canonical summaries

export function factsSummary(F: Facts) {
  const sortSet = (s: Iterable<string>) => [...s].sort()
  const mapSets = (m: Map<string, Set<string>>) =>
    [...m.entries()]
      .filter(([, v]) => v.size)
      .map(([k, v]) => [k, sortSet(v)] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
  return JSON.stringify({
    mem: sortSet(F.mem),
    ban: sortSet(F.ban),
    invited: sortSet(F.invited.keys()),
    pending: sortSet(F.pending.keys()),
    roles: sortSet(F.roles),
    pos: [...F.pos.entries()].sort(),
    bits: [...F.bits.entries()].sort(),
    holds: mapSets(F.holds),
    devs: mapSets(F.devs),
    revoked: sortSet(F.revoked),
    codes: sortSet(F.codes.keys()),
    profile: [...F.profile.entries()].sort(),
    setting: F.setting ?? null,
    upgraded: sortSet(F.upgraded),
  })
}
export function evalSummary(r: EvalResult) {
  return JSON.stringify({
    facts: factsSummary(r.facts),
    X: [...r.X].sort(),
    tail: [...r.tail].sort(),
    cut: [...r.cut.entries()].map(([k, v]) => [k, rkey(v)]).sort(),
    eff: [...r.eff].sort(),
  })
}
