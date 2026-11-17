/* eslint-disable */
// @ts-nocheck
// The executable reference model of the P2P ACL (rules 2 and 3), used only by tests.
// Direct and unoptimised: every check recomputes from sets. No crypto; ids are strings.
// This file is normative.

/** the model has growth totals, rotation evidence and drops, and class projection */
export const MODEL_TOTALS = true
/** protection classes on Γ⁺ for the whole stratum (vectors.test.ts reads it) */
export const MODEL_SENIOR_CLASSES = true

export type Rank = readonly [number, string]
export const TOP: Rank = [Infinity, ''] // owners
export const BOT: Rank = [-1, ''] // members without a role
export const NEG: Rank = [-Infinity, ''] // non-members
export const cmp = (a: Rank, b: Rank) =>
  a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0
export const gt = (a: Rank, b: Rank) => cmp(a, b) > 0
export const minR = (a: Rank, b: Rank) => (cmp(a, b) <= 0 ? a : b)
export const rkey = (r: Rank) => `${r[0]}/${r[1]}`

/** Seeded mutations for harness self-checks (ACL_MUT env); empty in normal runs. */
export const MUT = (typeof process !== 'undefined' && process.env.ACL_MUT) || ''
export const KICK = 1,
  BAN = 2,
  ROLES = 4,
  INVITE = 8,
  SERVER = 16,
  ALL = 31
export const BITS = [KICK, BAN, ROLES, INVITE, SERVER]
export const EVERYONE = '@e'

// Limits (model scale).
// Production: DEV 8, W3 60 per hour (600 for moderators and owners), device_adds 8 per identity per day across
// epochs (a rotation resets nothing), primary_rotates 4 per identity per day, protection classes per stratum for
// the exact cascade 3, pending invites 20 per device, live codes 20 per device (100 with ManageServer), roles 250.
// The unacknowledged budget is a total, independent of time: `totU` ACL events per device that no other identity
// acknowledged, every kind except leave, device_revoke, primary_rotate and upgrade (production 24; model 12), a
// non-owner has at most `rotTot` unacknowledged rotations in B(e) (production 4; model 3) and `freshCap`
// unacknowledged device_adds (W3(d)), and a non-owner's join needs a third identity's acknowledgement of its add
// (W3(e)).
// The identity pool W3(g), whose bound does not grow with device churn: U(e) = the ACL events of e's identity in
// B(e) ∪ {e} that no event of another identity in B(e)
// has in its past; a non-owner's event is refused when |U(e)| > poolU, and a non-owner's event x other than a rotation
// is a candidate when the union of U(x) and of U(y) over the events y of its identity concurrent with x has more
// than poolU events (production 384; model 30). Every device chain of the identity, revoked or not, draws on that pool,
// and a removed identity alone keeps at most poolU unacknowledged events.
// At most `ap` ACL parents per event (production 10, model 10).
// `dayMul`, `dayU` and `work` are read only by mutants (`day-mul`, `day-window`, `work-bound`: a work bound on the
// flat closure lets a junior switch a senior stratum, so the class cap bounds the work), `freshU` only by the vectors.
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
/**
 * Per-server limits: a server's must-agree limits are fixed in its genesis.
 * `rules: 2` (or absent in the model) means the defaults; `rules: 3` carries a `limits` object whose known keys override
 * the defaults, each within its range (a value outside its range, or an unknown key, refuses the genesis).
 * `win` and `day` are fixed. The model's ranges are at model scale. `LIM` is the
 * limits of the server being evaluated: every Replica runs its work under its genesis's limits (`withLim`), so one
 * process evaluates servers with different limits. `LIM_BASE` holds the defaults (bench.ts sets production values).
 */
export const LIM_BASE: typeof LIM = { ...LIM }
export const LIM_RANGE: Record<string, readonly [number, number]> = {
  // `classes` and `ap` never go below their defaults (a lower `classes` weakens G5, a
  // lower `ap` refuses honest members on wide DAGs)
  devCap: [1, 4],
  w3: [2, 8],
  w3mod: [4, 16],
  freshCap: [1, 4],
  idCap: [1, 6],
  rotCap: [1, 8],
  classes: [2, 4],
  pendingPerDev: [1, 4],
  codesPerDev: [1, 4],
  codesPerDevServer: [2, 8],
  roles: [2, 12],
  totU: [4, 12],
  rotTot: [1, 6],
  poolU: [10, 60],
  ap: [10, 16],
}
export const RULES_KNOWN = [2, 3]
/** the limits a genesis fixes, or a reason to refuse it; undefined: the defaults (rules 2) */
export function limitsOf(c: any): { lim?: typeof LIM; bad?: string } {
  const rules = c?.rules ?? 2
  // rules 2: a `limits` field is unread (an older client ignores it; reading it would split the state silently). Mutant
  // `v2-limits` reads it
  if (rules === 2)
    return MUT === 'v2-limits' && c?.limits && typeof c.limits === 'object'
      ? { lim: mergeLim(c.limits) }
      : {}
  if (rules !== 3) return {}
  // a present `limits` must be a JSON object (`null` refuses the genesis)
  const L = c?.limits === undefined ? {} : c.limits
  if (typeof L !== 'object' || L === null || Array.isArray(L)) return { bad: 'limits' }
  // the key set of rules 3 is closed; a new agreed limit is a new rules version. Own keys only, so names like
  // `toString` or `__proto__` are unknown keys (mutant `lim-proto`: `in`)
  if (
    MUT !== 'lim-open' &&
    Object.keys(L).some(k => !(MUT === 'lim-proto' ? k in LIM_RANGE : Object.hasOwn(LIM_RANGE, k)))
  )
    return { bad: 'limits' }
  for (const [k, r] of Object.entries(LIM_RANGE)) {
    if (L[k] === undefined) continue
    if (!Number.isSafeInteger(L[k]) || (MUT !== 'lim-unranged' && (L[k] < r[0] || L[k] > r[1])))
      return { bad: `limits.${k}` }
  }
  const lim = mergeLim(L)
  // the pool holds every live device's full unacknowledged budget, so honest concurrency never makes a pool candidate
  if (
    lim.w3 > lim.w3mod ||
    lim.codesPerDev > lim.codesPerDevServer ||
    (lim.poolU < lim.devCap * lim.totU && MUT !== 'lim-unranged')
  )
    return { bad: 'limits' }
  return { lim }
}
const mergeLim = (L: any): typeof LIM => {
  const out = { ...LIM_BASE }
  for (const k of Object.keys(LIM_RANGE)) if (Number.isSafeInteger(L?.[k])) (out as any)[k] = L[k]
  return out
}
/** run `f` with the limits `lim` in force (undefined: as they are) */
export function withLim<R>(lim: typeof LIM | undefined, f: () => R): R {
  if (!lim) return f()
  const save = { ...LIM }
  Object.assign(LIM, lim)
  try {
    return f()
  } finally {
    Object.assign(LIM, save)
  }
}
/** "Moderator" for W3: any moderation bit. Owners hold every bit. */
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
  | 'migrate'

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
 * device. A device_revoke is not on the chain: it removes a device and must stay admissible while
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
  pool?: string[] // W3(g): U(e) (undefined for genesis); cap and candidacy apply to non-owners
  by?: string // the key that signed a recovery-level record (a primary_rotate), checked against St(e)
  // a protected identity's rotation (not signed by ik): the single chain head its position has
  // after its own records, when there is one and it is a chain record (n ≥ 1): its digest and the devices it keeps
  head1?: { d: string; keep: string[] }
  // an upgrade on rules 3: the key each genesis owner's signature of G' names (the author's own
  // included), as admission checked it at the upgrade's position
  sigBy?: Record<string, string>
}

export interface Ctx {
  ev(id: string): Ev
  anc(id: string): Set<string> // B(e): strict causal past
  rec(id: string): Rec
}

// ---------------------------------------------------------------- facts

export interface Pend {
  id: string
  a: string
  dev: string
  k: Rank
  code?: string
}
export interface Facts {
  owners: Set<string>
  /** the genesis names the server it succeeds (`from`): `migrate` is admitted only there */
  from: boolean
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
  // The parts of Inv and Code that the authority split reads separately.
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
 * Devices an in-force primary_rotate r drops: every device of r's identity that some event of E introduces, that r
 * neither keeps nor is posted by, and whose introduction is not after r. Introductions after r (the new epoch) are kept.
 */
export function droppedBy(r: Ev, E: string[], cx: Ctx): string[] {
  const keep = new Set<string>([r.dev, ...((r.c?.keep ?? []) as string[])])
  // a rotation in keep doesn't drop a device that a concurrent sibling (a rotation in keep for
  // the same chain head, in E) introduces or keeps; every such device is in the head's keep (mutant `rk-sh-drop`)
  if (MUT !== 'rk-sh-drop' && cx.rec(r.id)?.head1)
    for (const id of E) {
      const y = cx.ev(id)
      if (y.t === 'primary_rotate' && sameHead(r, y, cx)) for (const v of introduces(y)) keep.add(v)
    }
  const out = new Set<string>()
  for (const id of E) {
    if (id === r.id) continue
    const x = cx.ev(id)
    if (x.a !== r.a || cx.anc(id).has(r.id)) continue
    for (const v of introduces(x)) if (!keep.has(v)) out.add(v)
  }
  return [...out].sort()
}

/**
 * What the protection rules decide about a set beyond its X, eff and void sets, read by its facts: the
 * identities frozen by rival resets (no member, no live device) and the upgrades a dead signature makes inert
 * (no Upgraded). Evaluate records them with the state (`fx`); a state's views and a checkpoint's restored
 * states read them from there.
 */
export interface FactsOver {
  frozen?: Set<string>
  deadUp?: Set<string>
}
export function facts(
  E: string[],
  voidS: Set<string>,
  eff: Set<string>,
  cx: Ctx,
  X?: Set<string>,
  ov?: FactsOver
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
    if (e.t === 'upgrade') upgraded.push(id) // immune to every cut
    if (!voidS.has(id)) live.push(e)
    if (eff.has(id)) effs.push(e)
  }
  if (!gen) throw new Error('set without genesis')
  const owners = new Set<string>(gen.c.owners)

  // Ban: ban-wins; each effective ban is lifted only by a live unban that follows it and is at least as senior.
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
  // `migrate` sets no membership; mutant `rk-migrate-mem` reads it
  if (MUT === 'rk-migrate-mem')
    for (const g of live)
      if (g.t === 'migrate')
        for (const m of g.c?.chunk?.list ?? [])
          if (typeof m?.ik === 'string' && !ban.has(m.ik)) mem.add(m.ik)
  for (const g of live) {
    if (!(g.t === 'join' || g.t === 'genesis')) continue
    const T = g.a
    if (ban.has(T)) continue
    if (memRem(T).every(r => before(r.id, g.id))) mem.add(T)
  }
  // from the void on, a frozen identity is no member (mutant `rk-void-member`)
  if (ov?.frozen && MUT !== 'rk-void-member') for (const a of ov.frozen) mem.delete(a)

  // Roles: deletion is an absorbing tombstone.
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

  // Pos: stratified register: among maximal writes the most senior writer wins, then lowest pos, then lowest id.
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

  // Holds: remove-wins; needs Mem and Role. And the
  // membership the role was given in must still count: one of its target's latest joins in the assign's past (the joins
  // of the target there that no other join of it there follows; for the genesis author also the genesis) is live. A
  // member whose join a cascade cut (or that is in X or Tail) doesn't hold that membership's roles again when it rejoins,
  // so a rejoin counts at ⊥ (G5) and never lifts its author above a concurrent deny made while it was pending (G6). The
  // test reads the DAG and the void set only, never a removal's effect: a view above a leave's stratum doesn't hold that
  // leave as effective yet. Mutants `holds-dormant`: a rejoin revives them (seed 91,025,433: a stratum-2 ban of a
  // pending identity made ineffective by its rejoin); `holds-any-join`: any live join of the target in the assign's past
  // counts, one of an earlier membership included (an earlier membership's join
  // revives the roles of a later membership that a cascade cut)
  const holds = new Map<string, Set<string>>()
  const revBy = new Map<string, Ev[]>()
  for (const r of effs) if (r.t === 'revoke') pushM(revBy, `${r.c.to}|${r.c.role}`, r)
  const joinsOf = new Map<string, Ev[]>()
  for (const id of E) {
    const j = cx.ev(id)
    if (j.t === 'join' || j.t === 'genesis') pushM(joinsOf, j.a, j)
  }
  // the membership an assign was given in still counts
  const given = (T: string, g: Ev) => {
    const js = (joinsOf.get(T) ?? []).filter(j => before(j.id, g.id))
    if (MUT === 'holds-any-join') return js.some(j => !voidS.has(j.id))
    return js.some(j => !voidS.has(j.id) && !js.some(j2 => j2 !== j && before(j.id, j2.id)))
  }
  for (const g of live) {
    if (g.t !== 'assign') continue
    const T = g.c.to,
      R = g.c.role
    if (!mem.has(T) || !roles.has(R)) continue
    if (MUT !== 'holds-dormant' && !given(T, g)) continue
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

  // Codes: a code is the code event itself, keyed by its id. A code_revoke names one code
  // event; holding or copying its hash grants nothing. A code lives while it is live, never revoked (absorbing), its
  // issuer is a member with Invite here, and it is not dead: dead once any live event e with the code in B(e) saw its
  // issuer without Mem or Invite (sticky).
  const codeIssuer = new Map<string, string>()
  for (const id of E) {
    const e = cx.ev(id)
    if (e.t === 'code') codeIssuer.set(id, e.a)
  }
  const revokedC = new Set<string>()
  for (const r of effs) {
    if (r.t !== 'code_revoke') continue
    if (MUT === 'hash-codes') {
      // a revocation kills every code with the same hash
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
  // and for code invites: the named code is still live and was not revoked.
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

  // Devices: introduced by genesis, an introducing join, a device_add, or a primary_rotate (its posting device
  // and the devices it keeps). A device never returns once an in-force device_revoke names it or an in-force
  // primary_rotate drops it (absorbing).
  const revoked = new Set<string>(effs.filter(e => e.t === 'device_revoke').map(e => e.c.dev))
  // a rotation drops only devices that a non-X event introduces (X: the equivocation void set of
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
  // and has no live device
  if (ov?.frozen && MUT !== 'rk-void-member') for (const a of ov.frozen) devs.delete(a)

  // Cosmetic registers: among maximal live writes, the most senior k(w) wins, then the lowest id.
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
    from: gen.c?.from !== undefined,
    upgraded: ov?.deadUp?.size ? upgraded.filter(u => !ov.deadUp!.has(u)) : upgraded,
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

// ---------------------------------------------------------------- authorization

/**
 * Authority: what an event relies on. A concurrent deny that takes part of it away cuts the event (`uses`), and a
 * cut grant that it relied on breaks it (`broken`). Target-state and no-op checks are guards (`guards`), admission only.
 */
/**
 * Monotone authority. Every authority check is split in two parts.
 * Resources are what the author holds: its Mem, bits, rank (`me`), the invite and code it uses, ¬Ban of itself or its
 * invitee, its device. They are read in `Fr`. Obstacles are what the author acts against: a target member's rank
 * (`rankT`), a role's position (`rankOf`), the foreign pending adds of an uninvite, invite consumption and code death.
 * They are read in `Fo`. Inside a stratum, `Fr` has this world's grant cuts applied and `Fo` does not, so more cuts never
 * lower an obstacle and never restore a resource: `broken` is monotone in the cut set by construction (O5-mono). In the
 * admission state both are St(e) and the check is the Authority column.
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
    case 'primary_rotate':
      // in an upgraded S an identity whose creation record S holds posts the
      // chain records S lacks whether or not it is a member (a genesis owner that left or never joined); decide admits only
      // such a rotation there. Mutant `rk-upg-rot-mem`: members only
      return isMem || (Fr.upgraded.length > 0 && MUT !== 'rk-upg-rot-mem')
    case 'leave':
    case 'mark':
    case 'device_revoke':
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
      // only the issuer of the named code event, or ManageServer and a rank strictly above the issuer's
      const iss = Fr.codeIssuer.get(c.code)
      return isMem && iss !== undefined && (iss === a || (has(SERVER) && outranks(x.rankT(iss))))
    }
    case 'settings':
      return isMem && has(SERVER)
    case 'device_add':
      return isMem && !Fr.revoked.has(e.dev)
    case 'upgrade':
    case 'migrate':
      return isMem && Fr.owners.has(a)
  }
  return false
}
/** The Authority column in one state (admission: St(e)). */
export const authority = (e: Ev, F: Facts): boolean => authCore(e, simpleCtx(F, e.a))

/** Guards: target-state and no-op checks (W5 caps, W6), enforced at admission only; never a reason to cut. */
export function guards(e: Ev, F: Facts): boolean {
  // after a counting upgrade only `leave`, and a rotation that carries chain records its position
  // lacks (decide checks that part; mutant `rk-upg-rot-off`: S refuses the user's reset for good)
  if (
    F.upgraded.length &&
    e.t !== 'leave' &&
    (e.t !== 'primary_rotate' || MUT === 'rk-upg-rot-off')
  )
    return false
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
      // every genesis owner other than the author countersigned G'; membership plays no part.
      // An object `{[owner]: {by, chain?} | string}` names each signature's key; on rules 3 admission also
      // needs the author's own entry and checks every signer at the upgrade's position (decide); the model's array is
      // the rules-2 form (each listed owner signed with ik)
      const sigs: unknown = c.sigs ?? []
      const need = [...F.owners].filter(o => o !== a && (MUT !== 'member-sigs' || F.mem.has(o)))
      if (Array.isArray(sigs)) return need.every(o => sigs.includes(o))
      if (!sigs || typeof sigs !== 'object') return false
      return need.every(o => Object.hasOwn(sigs, o))
    }
    case 'migrate':
      return F.from // only in a successor server; it sets no Mem or Dev
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

/** What a deny acts on, for protection. `who` is the principal whose rank protects the target. */
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

// ---------------------------------------------------------------- equivocation

export interface EvalResult {
  facts: Facts
  X: Set<string>
  tail: Set<string> // ops of revoked or dropped devices past the watermark
  cut: Map<string, Rank>
  eff: Set<string>
  F: Map<string, number>
  FI: Map<string, number> // key `${identity}|${epoch}`: identity fork depth within one epoch
  RF?: Set<string> // contested identity ops: rotations with a sibling over the same iprev, and what builds on them
  PC?: Set<string> // pool candidates (W3(g))
  void: Set<string>
  BD?: Map<string, Protection> // protection state per protected identity
  rivals?: Set<string> // the carriers of rival resets (in X, never cited by honest clients)
  fx?: FactsOver // frozen identities and inert upgrades, read by this state's facts and its views
}

/** FI of identity `a` in epoch `epoch` ("" = genesis epoch). */
export const fiOf = (FI: Map<string, number>, a: string, epoch: string) =>
  FI.get(`${a}|${epoch}`) ?? Infinity

/**
 * Fork points. `ghosts`: events a replica dropped by the orphan rule; their headers (device, seq, aprev) still
 * count as device evidence: a replica keeps them so that F never depends on what it
 * dropped. Rotation evidence RF: two rotations of one identity that are concurrent (neither in the other's past; two
 * recovery-signed records that don't see each other; a thief holding a device or the primary key can't sign one).
 * Any two concurrent rotations, not only two with the same iprev (mutant
 * `rot-same-iprev`), and a non-rotation identity op with the same iprev as a rotation of its identity is identity
 * evidence for its own epoch at its depth (it lost a race to the recovery key; the rotation is not affected; mutant
 * `no-race`). Without both, a removed member grew its identity chain into a tree (at each position one rotation child
 * and one device_add child, and rotation branches at different positions), each node a fresh device with a full budget.
 */
/** device fork points F: two events of one device with the same seq or the same aprev */
function devForks(byDev: Map<string, Ev[]>, F: Map<string, number>) {
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
  return F
}
export function deviceForks(all: string[], cx: Ctx) {
  const byDev = new Map<string, Ev[]>()
  for (const id of all) {
    const e = cx.ev(id)
    if (!byDev.has(e.dev)) byDev.set(e.dev, [])
    byDev.get(e.dev)!.push(e)
  }
  return devForks(byDev, new Map())
}
export function forkPoints(
  ids: string[],
  cx: Ctx,
  ghosts: string[] = [],
  inert: Set<string> = new Set(),
  lineage: Set<string> = new Set()
) {
  const F = new Map<string, number>()
  const FI = new Map<string, number>()
  const RF = new Set<string>()
  const byDev = new Map<string, Ev[]>()
  const byIdn = new Map<string, Ev[]>()
  const byRot = new Map<string, Ev[]>()
  // the header of a dropped event (device, seq, aprev, iprev, ap and its recorded
  // depth, epoch and pool) counts as every kind of evidence, not only device evidence, so F, FI, RF and the pool
  // candidates never depend on what a replica dropped, and the orphan rule needs no condition on them. Mutant
  // `ghost-dev` (headers count as device evidence only; the orphan conditions then keep the events that
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
          // an inert rotation contests no valid rotation of a protected identity (those postdate its
          // creation record, so evidence only grows as records arrive); against every other rotation it stays rotation
          // evidence (mutant `rk-inert-noevidence`: inert rotations are no evidence at all)
          const shield = (x: Ev, y: Ev) =>
            inert.has(x.id) && (lineage.has(y.id) || MUT === 'rk-inert-noevidence')
          if (shield(rs[i], rs[j]) || shield(rs[j], rs[i])) continue
          // two valid carriers in keep for one chain head are no evidence against each other; a
          // valid carrier of that head that isn't in keep is contested but contests no carrier in keep
          if (lineage.has(rs[i].id) && lineage.has(rs[j].id)) {
            if (sameHead(rs[i], rs[j], cx)) continue
            if (outOfKeep(rs[i], rs[j], cx)) {
              RF.add(rs[i].id)
              continue
            }
            if (outOfKeep(rs[j], rs[i], cx)) {
              RF.add(rs[j].id)
              continue
            }
          }
          RF.add(rs[i].id)
          RF.add(rs[j].id)
        }
  // an inert rotation is contested (a candidate, never a clean introduction or record), so what its
  // epoch built is contested too
  for (const id of inert) if (cx.ev(id)?.t === 'primary_rotate' && all.includes(id)) RF.add(id)
  // Contested identity ops: a rotation with rotation evidence; a rotation whose iprev is contested while a
  // contested rotation of its identity is concurrent with it (a rotation that sees every contested rotation is the
  // recovery that resolves them); a non-rotation identity op whose epoch's rotation is contested. Only the
  // recovery key creates rotation evidence, so a thief can't contest anything; contestedness spreads only along the
  // identity chain and only grows with the set, so it is stable as evidence arrives.
  if (RF.size) {
    const sib = [...RF]
    for (const id of [...all].sort((x, y) => cx.anc(x).size - cx.anc(y).size)) {
      const e = cx.ev(id),
        r = cx.rec(id)
      if (r.depth < 0 || RF.has(id) || inert.has(id)) continue
      if (e.t === 'primary_rotate') {
        if (
          e.iprev !== undefined &&
          RF.has(e.iprev) &&
          sib.some(
            q =>
              cx.ev(q).a === e.a &&
              !cx.anc(id).has(q) &&
              !cx.anc(q).has(id) &&
              !(inert.has(q) && (lineage.has(id) || MUT === 'rk-inert-noevidence')) &&
              !(
                lineage.has(id) &&
                lineage.has(q) &&
                (sameHead(e, cx.ev(q), cx) || outOfKeep(cx.ev(q), e, cx))
              )
          )
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
    if (inert.has(id)) continue
    // identity evidence: two identity ops of one identity in the same epoch with the same iprev. A primary_rotate starts
    // its own epoch and never pairs; concurrent rotations are refused further identity ops instead.
    if (r.depth >= 0 && e.t !== 'primary_rotate') {
      const key = `${e.a}|${r.epoch}`
      if (!byIdn.has(key)) byIdn.set(key, [])
      byIdn.get(key)!.push(e)
    }
  }
  devForks(byDev, F)
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
  // race evidence: a non-rotation identity op with the same iprev as a rotation of its identity
  if (MUT !== 'no-race' && MUT !== 'no-rot-evidence') {
    const rotPrev = new Set<string>()
    for (const id of all) {
      const e = cx.ev(id)
      if (e.t === 'primary_rotate' && !(MUT === 'rk-inert-noevidence' && inert.has(id)))
        rotPrev.add(`${e.a}|${e.iprev ?? ''}`)
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
 * Pool evidence (W3(g)): a non-owner's event x other than a rotation is a pool
 * candidate when P(x) = U(x) ∪ ⋃ { U(y) : y of x's identity, concurrent with x } has more than poolU events, U the
 * pools recorded at admission. U is fixed per event. Dropped events (ghosts) keep their headers and recorded pools,
 * except events past their device's fork point (they count in no P, and only their ids stay in the recorded
 * pools), so a replica's drops never change P. Every event lies in its own U, so P(x) holds every event of the identity
 * concurrent with x before its device's fork point; for x maximal among the non-candidate unacknowledged events of an
 * identity (all before their fork points), P(x) holds all of them and their unacknowledged ancestors.
 * Rotations are never pool candidates (recovery; a thief can't void one). Mutant `pool-off`.
 * A device_revoke is never one either (a thief's sibling flood must not void the revocation of the stolen device;
 * mutant `revoke-pool`). Only concurrent events before their
 * device's fork point count (y.seq < F(y.dev)); events past it are candidates anyway and make no other event one. This is
 * not monotone (an event stops counting when its device forks below it), so the orphan rule never drops an event that
 * is a candidate only by pool evidence (props.ts orphanDrops). Mutant `pool-all`: every concurrent event counts.
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
 * cand_V(x): x is at or past a device or identity fork point in a view with fork points F, FI, rotation
 * evidence RF and void set X. A rotation is a candidate iff it has rotation evidence
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
  if (PC?.has(id)) return true // pool evidence (W3(g))
  if (r.depth >= 0) return r.depth >= fiOf(FI, e.a, r.epoch) || (RF?.has(id) ?? false)
  const intros = introsOf(id, cx)
  // an event is a candidate when every identity op that introduced its device is a
  // candidate. Candidacy of an identity op is structural (F, FI, rotation evidence only fall or
  // grow), so a fresh device's events on a void branch stay void once nothing is built on them and can be dropped;
  // with "in X" in its place, a later good-faith citation of the introduction alone could revive them. Mutant `intro-x`.
  return (
    intros.length > 0 &&
    intros.every(x => (MUT === 'intro-x' ? X.has(x) : candidate(x, cx, F, FI, X, RF, PC)))
  )
}

/**
 * Equivocation void set X: candidates that no clean witness acknowledged in good faith. A witness w of x is an
 * admitted ACL event by another identity with x in B(w) that is clean (not past its own fork points, on a device introduced
 * cleanly) and that acted in good faith (x was not a candidate in St(w)). No recursion through X.
 */
export function equivocationCut(
  ids: string[],
  cx: Ctx,
  F: Map<string, number>,
  FI: Map<string, number>,
  RF: Set<string> = new Set(),
  PC: Set<string> = new Set(),
  inert: Set<string> = new Set()
) {
  const clean = new Map<string, boolean>()
  // an event past the watermark of an admitted revocation record of its own device (a
  // device_revoke naming it, or a primary_rotate that drops it) is never a clean witness. The test reads the admitted
  // records, not whether they are in force, so X has no recursion through Tail; it makes every Tail event inert for X.
  // Only structurally clean records count (a primary_rotate, which is never void, or a device_revoke before its own
  // device's fork point on a device introduced cleanly; decided from F and FI alone, so still no recursion through X).
  // Such a record is never in X, so a void record has no effect (O7-absent); counting every admitted record (mutant
  // `revoke-any`) lets a void device_revoke un-clean witnesses, and dropping it as an orphan
  // changes X (seeds 9228, 14268).
  // W3(g): a pool candidate is never clean (as a record, an introduction or a witness), so no X event is clean
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
  // a rotation lowers watermarks only if it is clean (no rotation evidence), and only for devices that a
  // non-candidate event introduces: a device introduced only by candidates has no clean witness anyway, and its
  // candidate introductions may be dropped as orphans, so they must not decide anything here
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
      if (inert.has(id)) continue // an inert record lowers no watermark
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
        !inert.has(w) &&
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

// ---------------------------------------------------------------- Eval

/**
 * V_o(K, +d): o's own admission state with the non-deny events of K in B(o) voided and, optionally, deny d made
 * effective. Equivocation voids (X) of the global set are deliberately not applied: X never cascades.
 */
export function view(o: string, cx: Ctx, K: Set<string>, extra?: string | string[]): Facts {
  const lo = cx.rec(o).local
  const Bo = [...cx.anc(o)]
  const voidV = new Set(lo.void)
  for (const x of Bo) if (K.has(x) && cx.rec(x).cls !== 'D') voidV.add(x)
  const effV = new Set(lo.eff)
  const ex = extra === undefined ? [] : typeof extra === 'string' ? [extra] : extra
  for (const d of ex) effV.add(d)
  return facts(ex.length ? [...Bo, ...ex] : Bo, voidV, effV, cx, lo.X, lo.fx)
}
/** The position writes of role R in a view (Pos): live creates, live G moves, effective moves. */
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
 * Position hull: the lowest ("min") or highest ("max") value the register of the writes L can take when any
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
 * The views of a monotone authority check of `o`: K = the cuts of the strata above, N = cuts of this
 * stratum counted in the world being judged, `extra` = denies made effective (`uses`, `k*`).
 * - Resources (Fr, me): V_o(K ∪ N, +extra), i.e. o's admission state with the grants cut above or in this world voided.
 *   The author's rank `me` is the highest rank, over the roles it holds in Fr, of the lowest position any subset of N's
 *   position writes could leave that role at (the clamp: more cuts never raise it, whatever the register's tie-break).
 * - Obstacles (Fo, rankOf, rankT): o's admission state with the grants cut above voided (this stratum's grant cuts never
 *   lower an obstacle) and the denies o saw that are cut above or in this world removed (an operation that
 *   relied on a deny loses it when a senior cuts that deny). A role's obstacle position is the highest any subset of
 *   N's removed position denies could leave it at.
 * Every part is monotone in N: Fr only loses facts, Fo only gains them. Mutants: `nonmono` (one view
 * V_o(K ∪ N) for both parts), `cutdeny-stays` (cut denies keep their effect on obstacles), `clamp-min` (me clamped to
 * min(rank in V_o(K), rank in V_o(K ∪ N)) only, which is not monotone with three writes).
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
  const Fr = facts(E_R, voidR, effR, cx, lo.X, lo.fx)
  if (MUT === 'nonmono') return simpleCtx(Fr, a)
  const voidO = new Set(lo.void)
  for (const x of KG) voidO.add(x)
  const effO = new Set(lo.eff)
  if (MUT !== 'cutdeny-stays') {
    for (const d of KD) effO.delete(d)
    for (const d of ND) effO.delete(d)
  }
  const Fo =
    !KD.length && !ND.length && !NG.length && !ex.length
      ? Fr
      : facts(Bo, voidO, effO, cx, lo.X, lo.fx)
  // the author's rank as a resource
  let me: Rank
  if (Fr.owners.has(a)) me = TOP
  else if (!Fr.mem.has(a)) me = NEG
  else {
    me = BOT
    const baseVoid =
      MUT === 'clamp-min'
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
        if (MUT === 'clamp-min') {
          const vK = new Set(lo.void)
          for (const x of KG) vK.add(x)
          p = Math.min(p, facts(E_R, vK, effR, cx, lo.X, lo.fx).pos.get(R) ?? -1)
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
 * Effective stratum k*(o) under the decisions above the stratum being processed: denies keep k(o); any other op
 * drops to its author's rank in V_o(K) with the effective higher denies `high` that o did not see as effective applied
 * (a senior's concurrent demotion of the author lowers it, as a senior's cut of the promoting grant does).
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
 * Whether a deny's target is protected at stratum kk in V_d. A member target is protected if V_d ranks it
 * strictly above kk (equals duel). A target that was not a member in St(d) (a ban of a non-member, an uninvite) and joined
 * concurrently is protected already at equal rank: removing a membership needs strictly higher rank.
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
 * exposed(p, γ): p's author is not protected against cause γ at stratum kk, read in V_γ (the facts of S \ fut(γ)
 * under the decisions above kk). Owners are never exposed. Revocation causes (device_revoke, primary_rotate tails) and
 * non-join operations: exposed unless V_γ ranks the author strictly above kk. A join (it creates a membership) is
 * exposed to a deny only if V_γ ranks the joiner strictly below kk, and to a withdrawal (uninvite, code_revoke) only if
 * also the withdrawer held Kick in St(γ).
 */
export function exposedTo(p: Ev, g: Ev, gRec: Rec, V: Facts, kk: Rank, duel = false): boolean {
  const P = p.a
  if (V.owners.has(P)) return false
  const r = rank(V, P)
  if (isRevocation(g)) return !gt(r, kk)
  if (p.t === 'join' && MUT !== 'equal-join') {
    if (isWithdrawal(g) && MUT !== 'kickless-withdraw' && !(perms(gRec.local.facts, g.a) & KICK))
      return false
    // Mutant `duel-join`: the racing join of a deny's own target that was a member in St(d) is
    // exposed at the threshold that let the deny take effect (a duel, rank <= kk); it changes what users see after a
    // later unban (the add the join consumed, the device it introduced)
    if (duel && MUT === 'duel-join') return !gt(r, kk)
    return cmp(r, kk) < 0
  }
  return !gt(r, kk)
}

/** Work counters of the last evaluate() call (bench.ts): worlds and broken() tests in step 4. */
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
  // the most distinct worlds one op is tested in, projected onto G(q) (what its cut depends on); strata of
  // the exact branch where some op exceeds 2^classes + 1, and those among them whose flat closure holds no X op (the
  // bound's argument covers exactly these; property O5-worlds)
  maxOpWorlds: 0,
  worldsOver: 0,
  worldsOverClean: 0,
}

/** Topological order of a set (anc sizes grow along causality; ids break ties). */
const topoOrder = (ids: string[], cx: Ctx) =>
  [...ids].sort((x, y) => cx.anc(x).size - cx.anc(y).size || (x < y ? -1 : x > y ? 1 : 0))

/**
 * Step 4, the exact per-cause cascade. Worlds are sets of causes (bit masks over the sorted causes).
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
  // fast.ts tests only Fl
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
  // Protection classes: the distinct exposure sets, other than ∅ and Γ, of the ops that are
  // direct cuts or have one in their causal past. Only senior decisions (promotions, demotions) make them differ. Up to
  // LIM.classes classes the rule above is exact (at most 2^classes worlds). Beyond, the stratum uses the sound
  // polynomial fallback: an earlier cut x counts in q's world only if a cause in that world cut x directly, or x was
  // cut in its own world and that world lies inside q's (then x is cut in the intersection). The fallback never cuts
  // what the exact rule keeps; it may keep an op of an author protected against some cause of the stratum.
  const order = topoOrder(ids, cx).filter(alive)
  const directs = [...Dc.keys()]
  const region = order.filter(q => Dc.has(q) || directs.some(x => cx.anc(q).has(x)))
  const ALLm = (1n << BigInt(causes.length)) - 1n
  // Classes are counted among the ops the causes could cut if no author were
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
  // An op's cut in a world W depends only on W ∩ G(q), G(q) = the
  // causes with a direct cut in C(q) = {q} ∪ B(q). Classes are counted over flat ops that are not X (on
  // Γ⁺, below), and the fallback's subset test is projected onto G(q). So an X event without descendants (an orphan the
  // storage rule may drop) and a cause whose only direct cuts are such events can't switch the branch or the
  // fallback's result: dropping them leaves Eval unchanged. Mutant `class-proj-off`: such an orphan's exposure set is a
  // class of its own, and such a cause's bit splits other ops' classes.
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
  // Classes are distinct U(q) ∩ Γ⁺,
  // Γ⁺ = the causes with a direct cut on an event outside X. Γ⁺ is one set for the whole stratum, so what q cites can't
  // split q's exposure into several classes (mutant `class-proj-g` projects onto G(q), which q's author chooses with its
  // parents: vectors "pclass", "jclass"). An orphan (an X event without descendants) is
  // not counted and adds no cause to Γ⁺, so dropping it leaves the count unchanged.
  let Gp = 0n
  for (const [x, m] of Dc) if (!Xs.has(x)) Gp |= m
  const projG = MUT === 'class-proj-g'
  const classes = new Set(
    counted
      .map(q => (projOff ? U(q) : projG ? U(q) & G(q) : U(q) & Gp))
      .filter((m, i) => m !== 0n && m !== (projOff ? ALLm : projG ? G(counted[i]) : Gp))
  ).size
  st.maxClasses = Math.max(st.maxClasses, classes)
  // Mutant `work-bound`: above (2^classes + 1) worlds × the ops
  // of Fl outside X and Tail the stratum takes the fallback. Fl holds junior ops, so a junior's backdated ops
  // switch a senior stratum and revive an op it had cut (O3-revive, G5).
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

/** Mutant `attrib-union`: an attribution cascade whose labels are unions. */
function cascadeUnion(
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
 * A conservative pre-filter for uses(o, d) in step 3: false only if making the deny d
 * effective in o's view can take away nothing o's authority reads. A kick or ban of T touches T's operations, the
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

// ---------------------------------------------------------------- recovery keys

/**
 * Key names (the model has no cryptography): "ik" is the identity key; a recovery key is a string starting with "rk"; any
 * other string is a primary key. An identity record (a `primary_rotate`, a `device_add`, an introducing `join`, a
 * `device_revoke`) names its signer in `c.by`; absent, it is signed by the right key of its position (an honest signer).
 * Admission records the signer (`Rec.by`). This shorthand exists only
 * in the model. On the wire, an absent `by` on rules 3 means `ik`, so the differential harness writes each
 * record's admitted signer (`Rec.by`) into every rules-3 record before it signs it.
 *
 * `ik` signs only its creation record (and, outside
 * servers, the creating device's legacy contact certificate) and is never stored. The creation record `{ik, rk, pcert}`
 * names a fresh primary (`pk`, default "p0"). Every later recovery-key record is a **chain record**: a recovery
 * `{n, prev, by, pk, keep}`, a reset `{n, prev, by, rk: next, pk, keep}` or a removal `{n, prev, by, rk: "", pk, keep}`,
 * signed by the recovery key in force after `prev`. Every chain record installs a new primary and names the devices it
 * keeps, so a reset also ends the old primary's epoch. Introductions carry the creation record plus the chain (a `join`'s `rk`, `pk`,
 * `chain`; a genesis owner bundle's `rks[owner]`), and a `primary_rotate` carries the records its position doesn't know.
 * Record ids stand for digests: `crDigest`, `recDigest`.
 */
export const isRk = (k: unknown): k is string => typeof k === 'string' && k.startsWith('rk')
/** a primary key name: not the identity key, not a recovery key */
export const isPrim = (k: unknown): k is string =>
  typeof k === 'string' && k !== '' && k !== 'ik' && !isRk(k)
/** the creation record's primary when an introduction doesn't name one (a fresh key, never `ik`) */
export const DEFAULT_PK = 'p0'
/** at most this many chain records after the creation record */
export const CHAIN_MAX = 8
export interface ChainRec {
  n: number
  prev: string
  by: string
  pk?: string
  keep?: string[]
  rk?: string
}
const hash32 = (s: string, h: number) => {
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}
const dg = (s: string) => hash32(s, 2166136261) + hash32(s, 0x9747b28c)
/** the digest of an identity's creation record */
export const crDigest = (a: string, rk: string, pk: string) => 'c' + dg(JSON.stringify([a, rk, pk]))
const recMemo = new WeakMap<object, string>()
/** the digest of a chain record (it covers `prev`, so it names the record's place in the chain) */
export const recDigest = (r: ChainRec) => {
  let d = recMemo.get(r)
  if (!d) {
    d = 'k' + dg(JSON.stringify([r.n, r.prev, r.by, r.pk ?? null, r.keep ?? null, r.rk ?? null]))
    recMemo.set(r, d)
  }
  return d
}
/** a well-formed chain record: a new primary and the devices it keeps, and for a reset the next recovery key (`rk`), for
 * a removal `rk: ""` */
export const chainRecOk = (r: any): r is ChainRec =>
  !!r &&
  typeof r === 'object' &&
  !Array.isArray(r) &&
  Number.isSafeInteger(r.n) &&
  r.n >= 1 &&
  r.n <= CHAIN_MAX &&
  typeof r.prev === 'string' &&
  typeof r.by === 'string' &&
  r.by !== '' &&
  isPrim(r.pk) &&
  Array.isArray(r.keep) &&
  r.keep.every((k: unknown) => typeof k === 'string') &&
  (r.rk === undefined || r.rk === '' || isRk(r.rk)) &&
  // a chain record is a closed format: an unknown field refuses it, so a record's
  // identity (its digest over the signed fields) can't be copied under another encoding (mutant `rk-rec-fields`)
  (MUT === 'rk-rec-fields' || Object.keys(r).every(k => CHAIN_FIELDS.has(k)))
const CHAIN_FIELDS = new Set(['n', 'prev', 'by', 'pk', 'keep', 'rk'])
/**
 * Two carriers of one recovery. Admission records,
 * for a protected identity's rotation not signed by ik, the single chain head its position has after its own records
 * (`Rec.head1`), when it is a chain record. The rotation is **in keep** when its posting device and every device it
 * keeps are in that record's keep, and the keep names at most `devCap` devices. Two concurrent valid rotations in keep
 * for one head are **siblings**: they are no rotation or race evidence against each other (`forkPoints`), count as one
 * maximal rotation (`identityHead`, `epochState`) and as one pair for W3(f), and neither drops a device the other
 * introduces or keeps (`droppedBy`). A valid rotation with the same head that isn't in keep stays contested but contests
 * no rotation in keep (`outOfKeep`). Mutants `rk-sh-off` (no exemption), `rk-sh-any` (no in-keep bound), `rk-sh-drop`
 * (siblings drop each other's devices).
 */
export const inKeep = (e: Ev, r: Rec | undefined) => {
  const h = r?.head1
  if (!h || e.t !== 'primary_rotate' || h.keep.length > LIM.devCap) return false
  return (
    h.keep.includes(e.dev) &&
    ((Array.isArray(e.c?.keep) ? e.c.keep : []) as string[]).every(v => h.keep.includes(v))
  )
}
const sameHeadD = (x: Ev, y: Ev, cx: Ctx) => {
  if (x.id === y.id || x.a !== y.a || x.t !== 'primary_rotate' || y.t !== 'primary_rotate')
    return false
  const hx = cx.rec(x.id)?.head1,
    hy = cx.rec(y.id)?.head1
  return !!hx && !!hy && hx.d === hy.d && !cx.anc(x.id).has(y.id) && !cx.anc(y.id).has(x.id)
}
/** x and y are sibling carriers (concurrent, in keep for one head); callers check that both count (valid, or not in X) */
export const sameHead = (x: Ev, y: Ev, cx: Ctx) =>
  MUT !== 'rk-sh-off' &&
  sameHeadD(x, y, cx) &&
  (MUT === 'rk-sh-any' || (inKeep(x, cx.rec(x.id)) && inKeep(y, cx.rec(y.id))))
/** x carries y's head from outside its keep (concurrent): x is contested, y isn't by x */
export const outOfKeep = (x: Ev, y: Ev, cx: Ctx) =>
  MUT !== 'rk-sh-off' &&
  MUT !== 'rk-sh-any' &&
  sameHeadD(x, y, cx) &&
  !inKeep(x, cx.rec(x.id)) &&
  inKeep(y, cx.rec(y.id))
export interface Creation {
  rk: string
  pk: string
  chain: ChainRec[]
}
/** the creation record (with its chain) an introduction carries for identity `a`, rules 3 */
export function creationOf(e: Ev, a: string = e.a): Creation | undefined {
  if (e.t === 'join') {
    if (e.a !== a || !isRk(e.c?.rk)) return undefined
    return {
      rk: e.c.rk,
      pk: e.c?.pk === undefined ? DEFAULT_PK : e.c.pk,
      chain: Array.isArray(e.c?.chain) ? e.c.chain : [],
    }
  }
  if (e.t === 'genesis') {
    const r = e.c?.rks?.[a]
    if (isRk(r)) return { rk: r, pk: DEFAULT_PK, chain: [] }
    if (r && typeof r === 'object' && isRk(r.rk))
      return {
        rk: r.rk,
        pk: r.pk === undefined ? DEFAULT_PK : r.pk,
        chain: Array.isArray(r.chain) ? r.chain : [],
      }
  }
  return undefined
}
/** the chain records an event carries for identity `a`: an introduction's, or a rotation's `chain` */
export function carriedOf(e: Ev, a: string = e.a): ChainRec[] {
  if (e.t === 'primary_rotate') return e.a === a && Array.isArray(e.c?.chain) ? e.c.chain : []
  return creationOf(e, a)?.chain ?? []
}
/** any recovery-key content an event carries (a creation record, chain records): its identity is kept by the orphan rule */
export function recoveryKeyOf(e: Ev, a: string = e.a): string | undefined {
  const c = creationOf(e, a)
  if (c) return c.rk
  return carriedOf(e, a).length ? 'chain' : undefined
}

export interface ChainNode {
  d: string
  n: number
  parent?: ChainNode
  r?: ChainRec
  key: string
  prim: string
  keep?: string[]
  kc: boolean
}
export interface ChainTree {
  root: ChainNode
  nodes: Map<string, ChainNode>
  valid: Set<string>
  equiv: boolean
  heads: ChainNode[]
}
/** x is an ancestor of y, or y itself */
export const chainAnc = (x: ChainNode, y: ChainNode) => {
  for (let z: ChainNode | undefined = y; z; z = z.parent) if (z.d === x.d) return true
  return false
}
/**
 * The chain of identity `a` from its creation record and a set of chain records (any order, duplicates ignored):
 * a record attaches below `prev` when its `n` follows and it is signed by the recovery key in force after `prev` (the
 * creation record's `rk`; after a reset its next key; after a removal its `pk`). **Chain key death:** a key change (reset
 * or removal) signed by key K kills every other record signed by K that is neither its ancestor nor its descendant (a
 * leaked old phrase is dead after a reset, wherever its records sit); two key changes signed by K that are neither
 * ancestor nor descendant of each other are rival resets, which only a holder of a leaked phrase can make: the chain is
 * **equivocated**. Two recoveries signed by one key (no key change) are both valid: the next record may cite either
 * (they reconcile). The heads are the deepest valid records.
 */
export function chainTree(
  a: string,
  cr: { rk: string; pk: string },
  recs: Iterable<ChainRec>
): ChainTree {
  const root: ChainNode = { d: crDigest(a, cr.rk, cr.pk), n: 0, key: cr.rk, prim: cr.pk, kc: false }
  const nodes = new Map<string, ChainNode>([[root.d, root]])
  const pend = new Map<string, ChainRec>()
  for (const r of recs) if (chainRecOk(r)) pend.set(recDigest(r), r)
  for (let grew = true; grew;) {
    grew = false
    for (const [d, r] of pend) {
      const p = nodes.get(r.prev)
      if (!p || r.n !== p.n + 1 || r.by !== p.key) continue
      const kc = r.rk !== undefined
      // every chain record installs its own primary (mutant `rk-reset-pk`: a reset keeps the old primary, so
      // a thief holding it posts the reset elsewhere and key death kills the user's records signed by the replaced key)
      nodes.set(d, {
        d,
        n: r.n,
        parent: p,
        r,
        kc,
        key: r.rk === undefined ? p.key : r.rk === '' ? r.pk! : r.rk,
        prim: MUT === 'rk-reset-pk' && isRk(r.rk) ? p.prim : r.pk!,
        keep: r.keep,
      })
      pend.delete(d)
      grew = true
    }
  }
  const killed = new Set<ChainNode>()
  let equiv = false
  const kcs = [...nodes.values()].filter(x => x.kc)
  for (const m of kcs) {
    for (const m2 of kcs)
      if (m2 !== m && m2.r!.by === m.r!.by && !chainAnc(m, m2) && !chainAnc(m2, m)) equiv = true
    if (MUT === 'rk-key-alive') continue
    for (const x of nodes.values())
      if (x !== m && x.r?.by === m.r!.by && !chainAnc(x, m) && !chainAnc(m, x)) killed.add(x)
  }
  // mutant `rk-rival-ok`: rival resets kill each other (the chain falls back to the key both replaced)
  if (MUT === 'rk-rival-ok') equiv = false
  const valid = new Set<string>()
  for (const x of nodes.values()) {
    let ok = true
    for (let z: ChainNode | undefined = x; z; z = z.parent)
      if (killed.has(z)) {
        ok = false
        break
      }
    if (ok) valid.add(x.d)
  }
  let maxN = 0
  for (const d of valid) maxN = Math.max(maxN, nodes.get(d)!.n)
  const heads = [...valid]
    .map(d => nodes.get(d)!)
    .filter(x => x.n === maxN)
    .sort((x, y) => (x.d < y.d ? -1 : 1))
  return { root, nodes, valid, equiv, heads }
}
/**
 * The chain of `a` after attaching `extra` to `recs` (T0: the tree of `recs`), or undefined when a record of `extra`
 * doesn't attach. Records that bring rival resets are read on their own branch (what they carry and its ancestors), as
 * admission checks a carrier of rival resets (only a leaked phrase makes them).
 */
export function chainOf(
  T0: ChainTree,
  a: string,
  cr: { rk: string; pk: string },
  recs: ChainRec[],
  extra: ChainRec[]
): ChainTree | undefined {
  if (!extra.length) return T0
  let T1 = chainTree(a, cr, [...recs, ...extra])
  if (extra.some(r => !T1.nodes.has(recDigest(r)))) return undefined
  if (T1.equiv && extra.some(r => !T0.nodes.has(recDigest(r)))) {
    const own = new Set<string>()
    for (const r of extra)
      for (let x: ChainNode | undefined = T1.nodes.get(recDigest(r)); x?.r; x = x.parent)
        own.add(x.d)
    T1 = chainTree(
      a,
      cr,
      [...recs, ...extra].filter(r => own.has(recDigest(r)))
    )
  }
  return T1
}
/** the keys in force at the heads: recovery keys and primaries */
export const headKeys = (T: ChainTree) => ({
  rec: [...new Set(T.heads.map(h => h.key))].sort(),
  prim: [...new Set(T.heads.map(h => h.prim))].sort(),
})

export interface Protection {
  st: 'protected' | 'unprotected'
  /** the recovery keys a rotation positioned on this set may be signed by */
  rec: string[]
  /** the primary keys a device certificate or revocation positioned on this set may be signed by */
  prim: string[]
  /** the creation record's value `rk|pk` (protected) */
  won?: string
  /** protected: the creation record and every chain record the set carries (admission extends them with what an event carries) */
  cr?: { rk: string; pk: string }
  chain?: ChainRec[]
  /** protected: the digests of the chain heads */
  heads?: string[]
  /** the creation record values the set carries for the identity (one, or several when void) */
  crs?: string[]
  /** void (unprotected): why the creation record is void: "cr" two creation records, "ik" an ik-signed record, "chain" rival resets */
  void?: 'cr' | 'ik' | 'chain'
}
const RECORD_T = new Set(['primary_rotate', 'device_add', 'device_revoke', 'join'])
const RECORD_SIGNED = RECORD_T
export const signerOf = (id: string, e: Ev, cx: Ctx) =>
  cx.rec(id)?.by ?? (typeof e.c?.by === 'string' ? e.c.by : 'ik')
/** the value of a creation record: `rk|pk` */
export const crValue = (c: { rk: string; pk: string } | undefined) => (c ? `${c.rk}|${c.pk}` : '')
/** an introducing join: one whose device its admission state didn't hold (its record's depth is set: an identity op) */
const idOpAt = (id: string, cx: Ctx) => (cx.rec(id)?.depth ?? -1) >= 0
/** a record that a key of the identity signs: a rotation, a device certificate (device_add, introducing join), a revocation */
const isRecord = (id: string, e: Ev, cx: Ctx) =>
  RECORD_T.has(e.t) && (e.t !== 'join' || idOpAt(id, cx))

/**
 * The protection state of every identity with a creation record in the set, a pure function of the set read from
 * the causal order, the records' signers and the chain records it carries (never X, so X has no recursion through it),
 * for rules-3 servers.
 *
 * **Void rule.** An identity's creation record is void when the set holds another creation record for it, a record of
 * it signed by `ik`, or rival resets in its chain. Void leaves it unprotected there under the rules-2 signer rules:
 * every identity record must be signed by `ik`, others are inert. A real protected identity's `ik` signs nothing in a
 * server, so only a legacy identity (whose `ik` is hot) or a leaked phrase can void one.
 *
 * **Protected**: the keys of a position are those of the chain heads its past carries. Each identity record is checked
 * against its own position (what admission checked; a carrier against the head after its own records): a rotation by
 * the recovery key in force there, or (carrying a new record) by the new head's primary; a certificate by the head's
 * primary; a revocation by either. Then, in the set:
 * - a record made under a chain record that is dead in the set (chain key death) is inert;
 * - **key death**: a record signed by a recovery key, concurrent with an event carrying a valid key change of that key,
 *   is inert (rotations and revocations; a leaked old phrase is dead after a reset);
 * - **epoch death**: a record signed by a primary (a revocation, a device certificate, an extension), concurrent with an
 *   event carrying a later valid record that installs a new primary, is inert (a stolen primary's backdated records
 *   never count once the recovery is known). A revocation signed by a recovery key is not touched by it;
 * - an event of the identity whose device's every introduction in its past is inert is inert.
 * Inert records are in X, never witnesses or clean records, contested (so what their epoch built is contested), and
 * inert rotations are still rotation and race evidence except against the valid rotations of a protected identity
 * (`lineage`), which postdate its creation record, so evidence only grows as records arrive.
 */
export function resolveProtection(
  ids: string[],
  cx: Ctx,
  ghosts: string[] = []
): {
  BD: Map<string, Protection>
  inert: Set<string>
  lineage: Set<string>
  frozen: Set<string>
  rivalCarriers: Set<string>
} {
  const BD = new Map<string, Protection>(),
    inert = new Set<string>(),
    lineage = new Set<string>(),
    frozen = new Set<string>(),
    rivalCarriers = new Set<string>()
  const all = ghosts.length ? [...ids, ...ghosts] : ids
  const g = all.map(id => cx.ev(id)).find(e => e.t === 'genesis')
  // the version rule: recovery keys exist only in rules-3 servers; under rules 2 `rk`, `rks`, `pk`, `chain` and
  // `by` are unread fields (an older client ignores them, and every client must evaluate a rules-2 server alike). Mutant
  // `rk-v2`
  if (MUT === 'rk-off' || ((g?.c?.rules ?? 2) !== 3 && MUT !== 'rk-v2'))
    return { BD, inert, lineage, frozen, rivalCarriers }
  const owners = new Set<string>(g?.c?.owners ?? [])
  const crs = new Map<string, Map<string, { rk: string; pk: string }>>()
  const addCr = (a: string, c: Creation) => {
    if (!crs.has(a)) crs.set(a, new Map())
    crs.get(a)!.set(crValue(c), { rk: c.rk, pk: c.pk })
  }
  if (g)
    for (const o of owners) {
      const c = creationOf(g, o)
      if (c) addCr(o, c)
    }
  for (const id of all) {
    const e = cx.ev(id)
    if (e.t === 'join') {
      const c = creationOf(e)
      if (c) addCr(e.a, c)
    }
  }
  if (!crs.size) return { BD, inert, lineage, frozen, rivalCarriers }
  const inPast = (x: string, y: string) => cx.anc(y).has(x) // x ∈ B(y)
  const conc = (x: string, y: string) => x !== y && !inPast(x, y) && !inPast(y, x)
  // an upgrade's signatures of G' (the author's own and each co-owner's) are records of their
  // owners on rules 3, made at the upgrade's position under the head whose key signed them (`Rec.sigBy`); a signature
  // that dies makes the upgrade inert, so it never sets Upgraded (mutant `rk-upgrade-alive`)
  const upgrades =
    MUT === 'rk-upgrade-alive'
      ? []
      : all.filter(id => cx.ev(id).t === 'upgrade' && cx.rec(id)?.sigBy)
  for (const [a, vals] of crs) {
    const mineAll = all.filter(id => cx.ev(id).a === a)
    const records = mineAll.filter(id => isRecord(id, cx.ev(id), cx))
    const sigRecs = upgrades.filter(u => Object.hasOwn(cx.rec(u).sigBy!, a))
    const sigOf = (u: string) => cx.rec(u).sigBy![a]
    const sigChain = (u: string): ChainRec[] => {
      const s = cx.ev(u).c?.sigs?.[a]
      return s && typeof s === 'object' && Array.isArray(s.chain) ? s.chain.filter(chainRecOk) : []
    }
    // the events that carry chain records of a (its introductions and rotations; the genesis for an owner)
    const carriers: { id: string; recs: ChainRec[] }[] = []
    for (const id of all) {
      const e = cx.ev(id)
      if (e.t !== 'genesis' && e.a !== a) continue
      if (e.t === 'genesis' && !owners.has(a)) continue
      const recs = MUT === 'rk-chain-off' ? [] : carriedOf(e, a).filter(chainRecOk)
      if (recs.length) carriers.push({ id, recs })
    }
    // an upgrade signature's carried chain records join the set's
    // chain, with the upgrade as their carrier: they are the owner's own records under its own keys, so a reset carried
    // in a signature makes the old key dead here too (mutant `rk-sigchain-off`: checked and never added)
    if (MUT !== 'rk-sigchain-off')
      for (const u of sigRecs) {
        const sc = sigChain(u)
        if (sc.length) carriers.push({ id: u, recs: sc })
      }
    const cr = [...vals.values()][0]
    const T = chainTree(
      a,
      cr,
      carriers.flatMap(c => c.recs)
    )
    const ikRec =
      MUT !== 'rk-void-off' &&
      (records.some(id => signerOf(id, cx.ev(id), cx) === 'ik') ||
        sigRecs.some(u => sigOf(u) === 'ik'))
    const why =
      vals.size > 1 && MUT !== 'rk-void-off' ? 'cr' : ikRec ? 'ik' : T.equiv ? 'chain' : undefined
    // rival resets freeze the identity instead (a void never revives); mutant `rk-void-revives`
    // makes the void global, under which the user's own removals lose their cuts
    const isFrozen = why === 'chain' && MUT !== 'rk-void-revives'
    if (why && !isFrozen) {
      for (const id of records) if (signerOf(id, cx.ev(id), cx) !== 'ik') inert.add(id)
      for (const u of sigRecs) if (sigOf(u) !== 'ik') inert.add(u)
      BD.set(a, {
        st: 'unprotected',
        rec: ['ik'],
        prim: ['ik'],
        crs: [...vals.keys()].sort(),
        void: why,
      })
      continue
    }
    const chainAll = carriers.flatMap(c => c.recs)
    const carriersOf = new Map<string, string[]>()
    for (const c of carriers)
      for (const r of c.recs) {
        const d = recDigest(r)
        if (!carriersOf.has(d)) carriersOf.set(d, [])
        carriersOf.get(d)!.push(c.id)
      }
    const knownAt = (x: string, self: boolean) =>
      carriers.filter(c => (self && c.id === x) || inPast(c.id, x)).flatMap(c => c.recs)
    // rival resets (frozen): the key changes signed by one key with neither the other's ancestor, and the records below
    // them. Their carriers are in X and honest clients never cite them (world.ts); the frozen identity's own
    // client posts nothing once its replica holds both (World.frozenIn).
    const rivals: ChainNode[] = []
    if (isFrozen) {
      const kcs = [...T.nodes.values()].filter(x => x.kc)
      for (const m of kcs)
        if (
          kcs.some(m2 => m2 !== m && m2.r!.by === m.r!.by && !chainAnc(m, m2) && !chainAnc(m2, m))
        )
          rivals.push(m)
      for (const m of rivals) for (const c of carriersOf.get(m.d) ?? []) rivalCarriers.add(c)
      frozen.add(a)
    }
    const underRival = (x: ChainNode) => rivals.some(m => chainAnc(m, x))
    // the records that count for the deaths: the valid ones; on a frozen identity also those of either rival branch, so
    // a grant one branch would kill stays dead (no grant under either branch counts, and none of what they kill revives)
    const deathValid = (x: ChainNode) =>
      T.valid.has(x.d) || (isFrozen && underRival(x) && MUT !== 'rk-void-grants')
    // a record of a made under `node` (signed by its recovery key `rkSigned`, else its primary), positioned at `pos`
    // (with `self`: pos carries its own records): does it die in the set? Tree `Tn` holds the node (the set's tree, or for
    // an upgrade signature the set's tree with the signature's chain)
    // for an upgrade, key death and
    // epoch death read only carriers that are rotations signed by a recovery key, for its signatures (`upg`) and for its
    // author device's introductions (`inertRk`, below). A device thief holds no recovery key, so a stolen device of a
    // later epoch can't undo a transfer with an extension or a join concurrent with it; the user's own carrier is signed
    // by `rk` in a server where its identity is a genesis owner (the client rule, client.ts). Mutant `rk-upg-any-carrier`:
    // every carrier kills an upgrade signature
    const rkKeys = new Set<string>([...T.nodes.values()].map(x => x.key))
    const rkCarrier = (c: string) => {
      const ce = cx.ev(c)
      return ce.t === 'primary_rotate' && rkKeys.has(signerOf(c, ce, cx))
    }
    const dies = (
      node: ChainNode,
      Tn: ChainTree,
      rkSigned: boolean,
      by: string,
      pos: string,
      revocation: boolean,
      upg = false
    ): boolean => {
      // the record's chain branch died in the set (chain key death; mutant `rk-branch-alive`). On a frozen identity this
      // is also every record under either rival branch (both are killed)
      if (
        !Tn.valid.has(node.d) &&
        MUT !== 'rk-branch-alive' &&
        !(isFrozen && MUT === 'rk-void-grants' && underRival(node))
      )
        return true
      const killer = (c: string) =>
        conc(c, pos) && (!upg || MUT === 'rk-upg-any-carrier' || rkCarrier(c))
      // key death: signed by a recovery key K, concurrent with a carrier of a valid key change signed by K
      if (rkSigned && MUT !== 'rk-key-alive')
        for (const m of T.nodes.values()) {
          if (!m.kc || m.r!.by !== by || !deathValid(m) || !chainAnc(node, m)) continue
          if ((carriersOf.get(m.d) ?? []).some(killer)) return true
        }
      // epoch death: signed by a primary P, concurrent with a carrier of a later valid record (every chain record installs
      // a new primary). Revocations signed by a recovery key are not touched by it (mutant `rk-epoch-rk`)
      const primSigned = !rkSigned || (revocation && MUT === 'rk-epoch-rk')
      const epochOff = revocation ? MUT === 'rk-epoch-alive' : MUT === 'rk-cert-alive'
      if (primSigned && !epochOff)
        for (const m of T.nodes.values()) {
          if (!m.r || m.n <= node.n || !deathValid(m)) continue
          if ((carriersOf.get(m.d) ?? []).some(killer)) return true
        }
      return false
    }
    // the records that die when only rk-signed carriers kill (the reading an upgrade's author-device check uses)
    const inertRk = new Set<string>()
    for (const id of records) {
      const e = cx.ev(id),
        by = signerOf(id, e, cx)
      const carries =
        e.t === 'primary_rotate' || e.t === 'join' ? carriedOf(e, a).filter(chainRecOk) : []
      const T0 = chainTree(a, cr, knownAt(id, false))
      let T1 = carries.length ? chainTree(a, cr, knownAt(id, true)) : T0
      // a carrier that brings rival resets is checked on its own branch (its records and their ancestors), as admission did
      if (T1.equiv && carries.length) {
        const own = new Set<string>()
        for (const r of carries)
          for (let x: ChainNode | undefined = T1.nodes.get(recDigest(r)); x?.r; x = x.parent)
            own.add(x.d)
        T1 = chainTree(
          a,
          cr,
          knownAt(id, true).filter(r => own.has(recDigest(r)))
        )
      }
      const H = T1.heads
      const fresh = carries.some(r => !T0.nodes.has(recDigest(r)))
      // the node a record is made under: the head whose key (rotations, revocations) or primary (certificates,
      // revocations, extensions) signed it
      let node: ChainNode | undefined,
        rkSigned = false
      if (e.t === 'primary_rotate') {
        node = H.find(h => h.key === by)
        rkSigned = !!node
        if (!node && fresh && MUT !== 'rk-ext-any') node = H.find(h => h.prim === by)
      } else if (e.t === 'device_revoke') {
        node = T0.heads.find(h => h.key === by)
        rkSigned = !!node
        if (!node) node = T0.heads.find(h => h.prim === by)
      } else node = H.find(h => h.prim === by)
      // a frozen identity's removals keep their cuts whatever the deaths: a revocation is never inert here, and a
      // rotation's drops count even when its grant part is inert (evaluate)
      if (isFrozen && e.t === 'device_revoke') continue
      if (!node && MUT !== 'rk-dev-signer') {
        inert.add(id)
        inertRk.add(id)
        continue
      }
      if (!node) continue
      if (dies(node, T, rkSigned, by, id, e.t === 'device_revoke', true)) inertRk.add(id)
      if (dies(node, T, rkSigned, by, id, e.t === 'device_revoke')) inert.add(id)
      else if (e.t === 'primary_rotate') lineage.add(id)
    }
    // the upgrade signatures this identity made: dead with the same deaths, read at the upgrade's position
    for (const u of sigRecs) {
      const by = sigOf(u),
        sc = sigChain(u)
      const T0 = chainTree(a, cr, knownAt(u, false))
      let T1 = sc.length ? chainTree(a, cr, [...knownAt(u, false), ...sc]) : T0
      if (T1.equiv && sc.length) {
        const own = new Set<string>()
        for (const r of sc)
          for (let x: ChainNode | undefined = T1.nodes.get(recDigest(r)); x?.r; x = x.parent)
            own.add(x.d)
        T1 = chainTree(
          a,
          cr,
          [...knownAt(u, false), ...sc].filter(r => own.has(recDigest(r)))
        )
      }
      let node = T1.heads.find(h => h.prim === by),
        rkSigned = false
      if (!node) {
        node = T1.heads.find(h => h.key === by)
        rkSigned = !!node
      }
      if (!node) {
        inert.add(u)
        continue
      }
      const Tn = sc.length ? chainTree(a, cr, [...chainAll, ...sc]) : T
      if (dies(node, Tn, rkSigned, by, u, false, true)) inert.add(u)
    }
    // an event whose device's every introduction (identity op of a introducing it, in its past or itself) is inert.
    // An upgrade reads its author device's introductions with the rk-only deaths (`inertRk`), so a
    // stolen later-epoch device's extension concurrent with the `device_add` of the upgrade's author device doesn't undo
    // the transfer either; everything else reads the full deaths. Mutant `rk-upg-intro-any`: the author's introductions
    // read every carrier
    const upgSet = new Set(sigRecs)
    for (const id of mineAll) {
      const e = cx.ev(id)
      const isUpg = upgSet.has(id)
      // the rk-only reading matters for introductions (identity ops) and upgrades only
      const needRk = !inertRk.has(id) && (isUpg || (cx.rec(id)?.depth ?? -1) >= 0)
      if (inert.has(id) && !needRk) continue
      const intros = [id, ...cx.anc(id)].filter(x => {
        const xe = cx.ev(x)
        return xe.a === a && (cx.rec(x)?.depth ?? -1) >= 0 && introduces(xe).includes(e.dev)
      })
      if (
        needRk &&
        ((isUpg && inert.has(id)) || (intros.length && intros.every(x => inertRk.has(x))))
      )
        inertRk.add(id)
      if (inert.has(id)) continue
      if (isUpg && MUT !== 'rk-upg-intro-any') {
        if (inertRk.has(id)) inert.add(id)
        continue
      }
      if (intros.length && intros.every(x => inert.has(x))) inert.add(id)
    }
    if (isFrozen) {
      BD.set(a, {
        st: 'unprotected',
        rec: [],
        prim: [],
        crs: [crValue(cr)],
        void: 'chain',
        cr,
        chain: chainAll,
      })
      continue
    }
    const hk = headKeys(T)
    BD.set(a, {
      st: 'protected',
      rec: hk.rec,
      prim: hk.prim,
      won: crValue(cr),
      crs: [crValue(cr)],
      cr,
      chain: chainAll,
      heads: T.heads.map(h => h.d),
    })
  }
  return { BD, inert, lineage, frozen, rivalCarriers }
}
/**
 * A **void device** of identity `a` in the final state: some event introduces
 * it and every introduction is in X (inert, or a candidate nobody witnessed). `visible(m)` hides content of a void
 * device (`Hidden { why: 'void' }`); its headers stay, because voidness isn't monotone (a late witness, or a key death
 * that kills the record that made it void, can end it). The model has no content: this is the fact that rule reads.
 */
export function voidDevice(S: EvalResult, cx: Ctx, ids: string[], a: string, dev: string): boolean {
  const intros = ids.filter(id => {
    const e = cx.ev(id)
    return e.a === a && (cx.rec(id)?.depth ?? -1) >= 0 && introduces(e).includes(dev)
  })
  return intros.length > 0 && intros.every(id => S.X.has(id))
}
/**
 * The link a member's client gives a session of identity `ik` on device `dk`
 * in a room, read from the room's final state (`may(room, ik, dk)`). Server-local: no cross-server head.
 * - **full** (content, presence, typing): `ik` a member and `dk` live for it.
 * - **acl** (ACL-only): `ik` pending, whatever its device (a device that S introduced before rejoins over
 *   it, one whose introductions a cascade cut included; a fresh device key always gets this link, so the device adds
 *   nothing to test; mutant `link-pending-fresh`: only a device this state never introduced); or `ik` a member
 *   whose `dk` this state never introduced, certified (the session's certificate, signed by `certBy`) under the
 *   identity's chain head here, so a new or imported device pushes its join or `device_add`. A genesis owner that left
 *   has no link of its own (its join needs no add to be admitted, but it needs a way in: a member's new add or a code
 *   makes it pending; no identity-level path, which only a stolen primary could use).
 * - **push** (transport only): the session presents (the hello's `keys`, here `presented`) chain records of `ik` that
 *   this state
 *   lacks, that attach to its chain here and are valid there (`chainOf`: a carrier of rival resets is read on its own
 *   branch), and a new head among them trusts `dk` (in its keep, or `certBy` is its primary); `dk` isn't
 *   revoked or dropped here; `ik`'s creation record is held here and is neither void nor frozen; member or not, banned or
 *   not. Over it the member serves the ACL layer only (events and state, never content) and accepts only `ik`'s rotations
 *   and joins that carry those records (`pushOk`), plus their missing ancestors, then re-gates. A device certified under a
 *   replaced primary presents nothing new, so it gets nothing. Mutants `link-push-off` (no push link), `link-push-trust`
 *   (any device of the identity gets it), `link-push-ban` (a banned identity gets none).
 * - **none**: `dk` revoked or dropped (absorbing), introduced only by void events, `ik` frozen (tested first,
 *   mutant `rk-link-frozen`), banned (outside push) or unknown.
 */
export function linkOf(
  S: EvalResult,
  cx: Ctx,
  ids: string[],
  ik: string,
  dk: string,
  certBy?: string,
  presented?: ChainRec[]
): 'full' | 'acl' | 'push' | 'none' {
  const F = S.facts
  if (F.revoked.has(dk)) return 'none'
  // a frozen identity gets no link, tested before the pending branch, so an owner's
  // new invite doesn't give a fresh device of it an ACL-only link (mutant `rk-link-frozen`)
  const bd = S.BD?.get(ik)
  if (bd?.void === 'chain' && MUT !== 'rk-link-frozen') return 'none'
  const banned = F.ban.has(ik)
  if (!banned) {
    if (F.mem.has(ik) && (F.devs.get(ik)?.has(dk) ?? false)) return 'full'
    const introduced = ids.some(id => {
      const e = cx.ev(id)
      return e.a === ik && (cx.rec(id)?.depth ?? -1) >= 0 && introduces(e).includes(dk)
    })
    const certOk =
      certBy !== undefined &&
      (bd?.st === 'protected'
        ? bd.prim.includes(certBy)
        : bd?.void === 'chain'
          ? false
          : certBy === 'ik')
    if (F.mem.has(ik) && !introduced && certOk) return 'acl'
    if (F.pending.has(ik) && (!introduced || MUT !== 'link-pending-fresh')) return 'acl'
  }
  if (MUT === 'link-push-off' || (banned && MUT === 'link-push-ban')) return 'none'
  if (bd?.st === 'protected' && bd.cr && presented?.length) {
    const recs = bd.chain ?? []
    const T0 = chainTree(ik, bd.cr, recs)
    const T1 = chainOf(T0, ik, bd.cr, recs, presented.filter(chainRecOk))
    if (T1 && presented.every(chainRecOk)) {
      const fresh = presented
        .map(r => T1.nodes.get(recDigest(r)))
        .filter((x): x is ChainNode => !!x && !T0.nodes.has(x.d) && T1.valid.has(x.d))
      const tips = fresh.filter(x => !fresh.some(y => y !== x && chainAnc(x, y)))
      if (
        tips.some(
          h => MUT === 'link-push-trust' || (h.keep ?? []).includes(dk) || certBy === h.prim
        )
      )
        return 'push'
    }
  }
  return 'none'
}
/**
 * What a push link accepts from the session of `ik` that presented `presented`: `ik`'s own
 * `primary_rotate` or `join`, carrying at least one record the state lacks, and only records it holds or the session
 * presented (their missing ancestors come with them). A kick, a plain join or a rotation that carries nothing new is
 * refused; after it the member re-gates. Mutant `push-accept-any`: any event of the identity.
 */
export function pushOk(S: EvalResult, e: Ev, ik: string, presented: ChainRec[] = []): boolean {
  if (e.a !== ik) return false
  if (MUT === 'push-accept-any') return true
  if (e.t !== 'primary_rotate' && e.t !== 'join') return false
  const bd = S.BD?.get(ik)
  if (bd?.st !== 'protected' || !bd.cr) return false
  const have = new Set((bd.chain ?? []).map(r => recDigest(r)))
  const shown = new Set(presented.map(r => recDigest(r)))
  const car = carriedOf(e, ik)
  return (
    car.some(r => !have.has(recDigest(r))) &&
    car.every(r => have.has(recDigest(r)) || shown.has(recDigest(r)))
  )
}
/**
 * The member entries a rules-3 upgrade's `migrate` carries, `project(Eval_S(B(u)))`
 * for keys: per member its creation record (`rk|pk`), every chain record B(u) carries for it, and the digests of its
 * chain heads there. In a rules-3 `S'` they are data for the follow rule and the carry-over (whose `add` names the
 * heads); `migrate` itself sets no `Mem` and no `Dev`: each member joins `S'` with its own join. A member whose creation
 * record is void in B(u) (by `ik` or by a second creation record) has no `cr` or heads (carried unprotected).
 * An identity frozen in B(u) is no member there, so it has no entry and the
 * carry-over posts no add for it; it moves. Mutant `rk-migrate-frozen`: every
 * identity frozen in B(u) carried unprotected.
 */
export function projectMembers(
  St: EvalResult
): { ik: string; cr?: string; chain: ChainRec[]; heads: string[] }[] {
  const ms = new Set(St.facts.mem)
  if (MUT === 'rk-migrate-frozen')
    for (const [ik, bd] of St.BD ?? []) if (bd.void === 'chain' && !St.facts.ban.has(ik)) ms.add(ik)
  return [...ms]
    .filter(m => !St.facts.owners.has(m))
    .sort()
    .map(ik => {
      const bd = St.BD?.get(ik)
      if (bd?.st !== 'protected') return { ik, chain: [], heads: [] }
      return { ik, cr: crValue(bd.cr), chain: [...(bd.chain ?? [])], heads: [...(bd.heads ?? [])] }
    })
}
/** the recovery keys and the epoch primaries for a record of `a` positioned with admission state S (rules 3) */
export const recKeys = (a: string, S: EvalResult | undefined) => S?.BD?.get(a)?.rec ?? ['ik']
export const primKeys = (a: string, S: EvalResult | undefined) => S?.BD?.get(a)?.prim ?? ['ik']

export function evaluate(
  ids: string[],
  cx: Ctx,
  opts: { prune?: boolean; ghosts?: string[] } = {}
): EvalResult {
  const prune = opts.prune ?? true
  const tA = performance.now()
  const PS = resolveProtection(ids, cx, opts.ghosts)
  const { F, FI, RF, PC } = forkPoints(ids, cx, opts.ghosts, PS.inert, PS.lineage)
  const X = equivocationCut(ids, cx, F, FI, RF, PC, PS.inert)
  for (const id of ids) if (PS.inert.has(id)) X.add(id)
  stats.msForks += performance.now() - tA
  const k = (id: string) => cx.rec(id).k
  const isD = (id: string) => cx.rec(id).cls === 'D'
  const isSelfD = (id: string) => isD(id) && cx.rec(id).self
  const fixed = (id: string) => fixedT(cx.ev(id).t) // never cut
  const conc = (x: string, y: string) => x !== y && !cx.anc(x).has(y) && !cx.anc(y).has(x)

  // Revocations in force: a device_revoke or a primary_rotate not in X (a rotation with rotation
  // evidence can be in X). Absorbing, never cut. Their tails (events of the revoked or dropped device past the
  // watermark) are cut at each tail op's own stratum. A rotation drops only devices that a non-X event introduces
  // (an X introduction may be dropped as an orphan, so it must not decide anything; its device has only X events).
  // A frozen identity's removals (rival resets in its chain) keep their cuts: every admitted
  // device_revoke and every admitted rotation's drops, with their watermarks, whatever their own effect (a rotation
  // whose grant part is inert is in X but still drops), unless the record is past its own device's fork point.
  const revs = ids.filter(
    id =>
      (cx.ev(id).t === 'device_revoke' || cx.ev(id).t === 'primary_rotate') &&
      (!X.has(id) ||
        (PS.frozen.has(cx.ev(id).a) && cx.ev(id).seq < (F.get(cx.ev(id).dev) ?? Infinity)))
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
    // with the world's cuts N, k* uses the monotone resource rank
    const below = (o: string, N?: string[]) =>
      cmp(k(o), kk) < 0 || (!isD(o) && cmp(N ? kstar(o, cx, Kf, effHigh, N) : ks(o), kk) < 0)
    const atOrBelow = (o: string) => cmp(k(o), kk) <= 0 || (!isD(o) && cmp(ks(o), kk) <= 0)
    const liveDeny = (id: string) => alive(id) && !X.has(id) && !tail.has(id) && isD(id)
    // V_γ: facts of S \ fut(γ) under the decisions above kk (no landmines); one view per cause.
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
    // author never exposes what it did before (seed 5263).
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

    // 4. Cascade with exact per-cause protection. The causes Γ of the stratum are its effective
    //    self-denies and denies and the revocations with direct cuts here. U(p) is the set of causes p's author is
    //    exposed to. An op is cut at kk iff it is a direct cut, or it is newly broken by the cuts in its causal past
    //    that the causes in U(p) would make on their own ("world" U(p)); inside a world W, an earlier op x counts only
    //    if it is cut (in the result) and would be cut in the world W ∩ U(x) (recursively), so every op on the path
    //    is judged only by causes its own author is exposed to. Attributing each cut to the union of the
    //    causes of everything in its past would let an unrelated same-stratum cause launder a protected author's
    //    exposure (mutant `attrib-union`).
    // a cause without direct cuts contributes nothing to any world and is left out, so
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
      ? MUT === 'attrib-union'
        ? cascadeUnion(ids, cx, direct, Uof, alive, Kf, below)
        : cascadeExact(ids, cx, causes, direct, Uof, alive, Kf, below, stats, X, tail)
      : new Set<string>()
    for (const o of newCuts) cut.set(o, kk)
    for (const d of [...selves, ...effNS]) eff.add(d)
    stats.msStep4 += performance.now() - t4
  }
  const voidS = new Set([...X, ...cut.keys(), ...tail])
  const tF = performance.now()
  // a frozen identity is no member and has no live device from the void on (its events placed before the
  // void keep their effect), and an upgrade one of whose signatures is dead (key or epoch death), or whose device's
  // introduction is inert, sets no Upgraded (equivocation still never undoes one)
  const deadUp = new Set([...PS.inert].filter(u => cx.ev(u).t === 'upgrade'))
  const fx: FactsOver | undefined =
    PS.frozen.size || deadUp.size ? { frozen: PS.frozen, deadUp } : undefined
  const fin = facts(ids, voidS, eff, cx, X, fx)
  stats.msFacts += performance.now() - tF
  return {
    facts: fin,
    X,
    tail,
    cut,
    eff,
    F,
    FI,
    RF,
    PC,
    void: voidS,
    ...(PS.BD.size ? { BD: PS.BD } : {}),
    ...(PS.rivalCarriers.size ? { rivals: PS.rivalCarriers } : {}),
    ...(fx ? { fx } : {}),
  }
}

// ---------------------------------------------------------------- admission

export type Verdict =
  { s: 'A' } | { s: 'R'; why: string } | { s: 'P'; missing: string[] } | { s: 'U'; rules: number }

/**
 * The identity chain position for a new identity op of `a` with causal past B. Rotations in B start epochs:
 * the current epoch is the one started by the single maximal rotation of `a` in B (or the genesis epoch). A non-rotation
 * identity op continues the current epoch: its iprev is the epoch's last identity op, and it is refused while the epoch is
 * forked or while two rotations are both maximal. A primary_rotate (recovery-signed) is admitted whatever the forks; its
 * iprev is the deepest identity op of `a` in B (lowest id on ties), and it starts its own epoch.
 */
/**
 * Maximal rotations that are siblings (carriers in keep for one chain head, none in X of the
 * position's state) count as one epoch, the lowest id's.
 */
export function mergeSiblings(maxRot: string[], cx: Ctx, X?: Set<string>): string[] {
  if (maxRot.length < 2 || !X) return maxRot
  const es = maxRot.map(id => cx.ev(id))
  if (es.every((x, i) => !X.has(x.id) && es.every((y, j) => i === j || sameHead(x, y, cx))))
    return [maxRot[0]]
  return maxRot
}
export function identityHead(
  a: string,
  B: string[],
  cx: Ctx,
  rotation: boolean,
  FI?: Map<string, number>,
  X?: Set<string>
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
  const maxRot = mergeSiblings(
    rots.filter(r => !rots.some(r2 => r2 !== r && cx.anc(r2).has(r))).sort(),
    cx,
    X
  )
  if (maxRot.length > 1) return { depth: -1, epoch: '', refused: 'identity-forked' }
  const epoch = maxRot[0] ?? ''
  if (FI && fiOf(FI, a, epoch) < Infinity) return { depth: -1, epoch, refused: 'identity-forked' }
  const inEpoch = epoch ? mine.filter(id => id === epoch || cx.anc(id).has(epoch)) : mine
  let li: string | undefined
  for (const id of inEpoch)
    if (!li || depthOf(id) > depthOf(li) || (depthOf(id) === depthOf(li) && id < li)) li = id
  return { iprev: li, depth: li ? depthOf(li) + 1 : 0, epoch }
}

// W3 exemptions: denies (D and S classes) and upgrade. Charged all the same: the denies that remove nothing
// from a member or invitee: a ban of a principal that B(e) has never seen join or be invited, and every role_move (a
// move is a reorder with unbounded positions; demoting a member stays possible, exempt, by revoke or kick). Owners are
// not exempt.
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
function epochState(a: string, B: string[], cx: Ctx, FI: Map<string, number>, X?: Set<string>) {
  const rots = B.filter(id => cx.ev(id).a === a && cx.ev(id).t === 'primary_rotate')
  const maxRot = mergeSiblings(
    rots.filter(r => !rots.some(r2 => r2 !== r && cx.anc(r2).has(r))).sort(),
    cx,
    X
  )
  if (maxRot.length > 1) return { pcert: '', split: true }
  const ep = maxRot[0] ?? ''
  return { pcert: ep ? String(cx.ev(ep).c?.pcert ?? '') : '', split: fiOf(FI, a, ep) < Infinity }
}

/** Events the W3(b) total counts: every ACL event except leave, device_revoke, primary_rotate and upgrade. */
export const totCounted = (x: Ev) =>
  x.t !== 'leave' &&
  x.t !== 'device_revoke' &&
  x.t !== 'primary_rotate' &&
  x.t !== 'upgrade' &&
  x.t !== 'genesis'
/** x (an event of identity a) is acknowledged in B: some event of another identity in B has x in its past. */
export const acked = (x: string, a: string, B: string[], cx: Ctx) =>
  B.some(f => cx.ev(f).a !== a && cx.anc(f).has(x))

export function decide(
  e: Ev,
  B: string[],
  cx: Ctx,
  S: EvalResult
): { ok: true; rec: Rec } | { ok: false; why: string } {
  const F = S.facts
  // `ap` lists 1..10 parents (enforced here; mutant `ap-uncapped`)
  if (e.ap.length > LIM.ap && MUT !== 'ap-uncapped') return { ok: false, why: 'ap' }
  if (devOwner(e.dev) !== e.a) return { ok: false, why: 'dev' }
  // rival resets freeze the identity where both are known: an event of it whose past holds
  // carriers of both is refused, unless it is an identity record signed by ik (only a legacy identity's hot ik makes
  // one, and it voids the creation record: the identity is then unprotected). Mutant `rk-void-admit`
  if (
    S.BD?.get(e.a)?.void === 'chain' &&
    MUT !== 'rk-void-admit' &&
    MUT !== 'rk-void-revives' &&
    !(RECORD_SIGNED.has(e.t) && (e.c?.by === undefined || e.c.by === 'ik'))
  )
    return { ok: false, why: 'void' }
  // A1 device, device chain, identity chain
  if ((S.F.get(e.dev) ?? Infinity) < Infinity) return { ok: false, why: 'forked' }
  // mutant `fork-parent`: refuse an event one of whose
  // parents is a device-fork candidate in St(e). It refuses honest clients citing an upgrade or a rotation past its
  // device's fork point, and a tree over distinct devices still layers siblings
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
    const h = identityHead(e.a, B, cx, e.t === 'primary_rotate', S.FI, S.X)
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
  // On rules 3 the signer of an identity record is checked against its
  // position. For an identity protected in St(e), against the chain head its position knows (for an event that carries
  // chain records, the head after them): a rotation by the recovery key in force, or (carrying a new record: an
  // extension) by the new head's primary; a device certificate by the head's primary; a revocation by either. `ik` is
  // always admitted: its signature makes any creation record of the identity void, and for an identity without
  // one it is the only signer, as in rules 2. A join whose creation record differs from the one B(e) knows, or that
  // claims protection for an identity B(e) knows without one, is refused (identity equivocation); a join through adds
  // that name the invitee's chain head must carry a chain that reaches every head they name. Resets and removals are
  // chain records: a rotation's own `rk` field is refused. Mutant `rk-any-signer` (no signer check).
  let by: string | undefined
  let freshChain = false
  const g0 = B.length ? cx.ev(B[0]) : undefined
  const gen0 = g0?.t === 'genesis' ? g0 : B.map(id => cx.ev(id)).find(x => x.t === 'genesis')
  const rules3 = MUT === 'rk-v2' || (gen0?.c?.rules ?? 2) === 3
  let head1: { d: string; keep: string[] } | undefined, sigBy: Record<string, string> | undefined
  if (rules3 && RECORD_SIGNED.has(e.t)) {
    const bd = S.BD?.get(e.a)
    const prot = bd?.st === 'protected'
    const intro = e.t === 'device_add' || (e.t === 'join' && idOp(e, F))
    const cJ = e.t === 'join' ? creationOf(e) : undefined
    if (
      e.t === 'join' &&
      !cJ &&
      (e.c?.rk !== undefined || e.c?.pk !== undefined || e.c?.chain !== undefined)
    )
      return { ok: false, why: 'rk' }
    if (cJ && (!isPrim(cJ.pk) || (e.c?.chain !== undefined && !Array.isArray(e.c.chain))))
      return { ok: false, why: 'rk' }
    if (
      e.t === 'primary_rotate' &&
      (e.c?.rk !== undefined || (e.c?.chain !== undefined && !Array.isArray(e.c.chain)))
    )
      return { ok: false, why: 'rk' }
    const carried: ChainRec[] = e.t === 'primary_rotate' ? (e.c?.chain ?? []) : (cJ?.chain ?? [])
    if (carried.length > CHAIN_MAX + 1 || !carried.every(chainRecOk))
      return { ok: false, why: 'rk' }
    if (cJ) {
      // the creation records B(e) knows: an owner's is its genesis bundle's (or none); a member's those its earlier
      // introductions carry, or none once a plain introduction is in B(e) (no protection in place)
      let knownVals: string[] | undefined
      if (F.owners.has(e.a)) {
        const oc = gen0 ? creationOf(gen0, e.a) : undefined
        knownVals = [oc ? crValue(oc) : '']
      } else if (bd?.crs) knownVals = bd.crs
      else if (B.some(x => cx.ev(x).t === 'join' && cx.ev(x).a === e.a)) knownVals = ['']
      if (knownVals && !knownVals.includes(crValue(cJ)) && MUT !== 'rk-two-cr')
        return { ok: false, why: 'rk' }
    }
    // the chain the record is checked against: the identity's in St(e), or the creation record this join brings
    const base = prot
      ? { cr: bd!.cr!, recs: bd!.chain ?? [] }
      : cJ && bd === undefined
        ? { cr: { rk: cJ.rk, pk: cJ.pk }, recs: [] as ChainRec[] }
        : undefined
    if (!base && carried.length) return { ok: false, why: 'rk' } // a chain for an identity unprotected here
    let heads: ChainNode[] = [],
      heads0: ChainNode[] = [],
      T1: ChainTree | undefined,
      keepAt: string[] | undefined
    if (base) {
      const T0 = chainTree(e.a, base.cr, MUT === 'rk-chain-off' ? [] : base.recs)
      T1 = carried.length
        ? chainTree(e.a, base.cr, MUT === 'rk-chain-off' ? [] : [...base.recs, ...carried])
        : T0
      if (MUT !== 'rk-chain-off' && carried.some(r => !T1!.nodes.has(recDigest(r))))
        return { ok: false, why: 'rk' } // a record that doesn't attach
      freshChain = carried.some(r => !T0.nodes.has(recDigest(r)))
      // a carrier that brings rival resets (only a leaked phrase makes them) is checked on its own branch; the set then
      // holds an equivocated chain, which voids the creation record
      if (T1.equiv && freshChain) {
        const own = new Set<string>()
        for (const r of carried)
          for (let x: ChainNode | undefined = T1.nodes.get(recDigest(r)); x?.r; x = x.parent)
            own.add(x.d)
        T1 = chainTree(
          e.a,
          base.cr,
          [...base.recs, ...carried].filter(r => own.has(recDigest(r)))
        )
      }
      heads = T1.heads
      heads0 = T0.heads
      keepAt = heads.length === 1 ? heads[0].keep : undefined
    }
    if (e.t === 'primary_rotate') {
      const R = base ? [...new Set(heads.map(h => h.key))] : ['ik']
      const P =
        base && freshChain && MUT !== 'rk-ext-any' ? [...new Set(heads.map(h => h.prim))] : []
      by = typeof e.c?.by === 'string' ? e.c.by : R.length === 1 ? R[0] : undefined
      if (
        by === undefined ||
        (by !== 'ik' &&
          !R.includes(by) &&
          !P.includes(by) &&
          !(MUT === 'rk-ext-any' && base && isPrim(by)) &&
          MUT !== 'rk-any-signer')
      )
        return { ok: false, why: 'sig' }
      if (base) {
        // the rotation's primary is the head's; an extension (signed by the new head's primary) keeps only devices the
        // head's latest recovery kept
        if (e.c?.pcert !== undefined && by !== 'ik' && !heads.some(h => h.prim === e.c.pcert))
          return { ok: false, why: 'rk' }
        // the devices an extension keeps are those of the record whose primary signs it,
        // also when two records with the same n are heads (mutant `rk-ext-keep`: only with a single head)
        const own = MUT === 'rk-ext-keep' ? keepAt : heads.find(h => h.prim === by)?.keep
        if (
          !R.includes(by) &&
          by !== 'ik' &&
          own &&
          (e.c?.keep ?? []).some((v: string) => !own.includes(v)) &&
          MUT !== 'rk-ext-any'
        )
          return { ok: false, why: 'rk' }
        // the single chain head this rotation's position has after its own records
        if (by !== 'ik' && heads.length === 1 && heads[0].r)
          head1 = { d: heads[0].d, keep: [...(heads[0].keep ?? [])] }
      }
    } else if (intro || e.t === 'device_revoke') {
      const ok = !base
        ? ['ik']
        : e.t === 'device_revoke'
          ? [...new Set([...heads0.map(h => h.prim), ...heads0.map(h => h.key)])]
          : [...new Set(heads.map(h => h.prim))]
      by = typeof e.c?.by === 'string' ? e.c.by : (ok[0] ?? 'ik')
      if (by !== 'ik' && !ok.includes(by) && MUT !== 'rk-any-signer')
        return { ok: false, why: 'sig' }
    }
    if (e.t === 'join') {
      // the inviters' view of the invitee's chain head: a join through adds that name a head must carry (or its
      // position must know) a chain that reaches every head they name. A named record
      // is reached when it is valid in the join's chain, also when it is the other one of two same-n records the user
      // reconciled (its chain descends from the first); mutant `rk-reach-desc`: only an ancestor of a head
      const named = [
        ...new Set(
          (F.invited.get(e.a) ?? [])
            .map(g => cx.ev(g.id).c?.head)
            .filter((h): h is string => typeof h === 'string')
        ),
      ]
      if (named.length && MUT !== 'rk-add-head') {
        const reach = (d: string) => {
          const x = T1?.nodes.get(d)
          return (
            !!x && T1!.valid.has(d) && (MUT !== 'rk-reach-desc' || heads.some(h => chainAnc(x, h)))
          )
        }
        if (!named.every(reach)) return { ok: false, why: 'rk' }
      }
    }
  }
  // on rules 3 an upgrade carries a signature of G' by every
  // genesis owner, its author included: `sigs[ik] = {by, chain?}` (a string is the rules-2 form, signed by ik). Each is
  // checked at the upgrade's position like an identity record: an owner protected there signs with the primary or the
  // recovery key of its head after the chain the signature carries (which must attach; evaluation then adds
  // it to the set's chain, with the upgrade as its carrier), any other owner with ik; ik is always admitted (it voids a
  // protected owner's creation record).
  // Evaluation then makes an upgrade inert when a signature is dead (resolveProtection)
  if (rules3 && e.t === 'upgrade') {
    const sigs = e.c?.sigs
    if (!sigs || typeof sigs !== 'object' || Array.isArray(sigs)) return { ok: false, why: 'sig' }
    sigBy = {}
    for (const o of [...F.owners].sort()) {
      if (!Object.hasOwn(sigs, o)) return { ok: false, why: 'sig' }
      const s0 = sigs[o]
      if (typeof s0 !== 'string' && (!s0 || typeof s0 !== 'object' || Array.isArray(s0)))
        return { ok: false, why: 'sig' }
      const sc: unknown = typeof s0 === 'string' ? undefined : s0.chain
      if (
        sc !== undefined &&
        (!Array.isArray(sc) || sc.length > CHAIN_MAX || !sc.every(chainRecOk))
      )
        return { ok: false, why: 'rk' }
      const chainO = (sc ?? []) as ChainRec[]
      const bdO = S.BD?.get(o)
      const named = typeof s0 === 'string' ? 'ik' : typeof s0.by === 'string' ? s0.by : undefined
      if (bdO?.st !== 'protected') {
        if (chainO.length) return { ok: false, why: 'rk' }
        if ((named ?? 'ik') !== 'ik' && MUT !== 'rk-any-signer') return { ok: false, why: 'sig' }
        sigBy[o] = named ?? 'ik'
        continue
      }
      const T0 = chainTree(o, bdO.cr!, bdO.chain ?? [])
      const T2 = chainOf(T0, o, bdO.cr!, bdO.chain ?? [], chainO)
      if (!T2) return { ok: false, why: 'rk' }
      const H = T2.heads
      const okKeys = [...new Set([...H.map(h => h.prim), ...H.map(h => h.key)])]
      const b = named ?? H[0]?.prim ?? 'ik' // the model's shorthand: an absent `by` is the head's primary
      if (b !== 'ik' && !okKeys.includes(b) && MUT !== 'rk-any-signer')
        return { ok: false, why: 'sig' }
      sigBy[o] = b
    }
  }
  // in a rules-3 S where an upgrade counts, a rotation is admitted only when
  // it carries chain records its position lacks, by an identity whose creation record S holds and that is neither void nor
  // frozen there, member or not (authCore); it sits after the upgrade, so it never kills it. So the user's reset reaches
  // an upgraded S, and a leaked old phrase positioned before the upgrade is a rival there (the freeze), never a takeover
  if (
    F.upgraded.length &&
    e.t === 'primary_rotate' &&
    !(rules3 && S.BD?.get(e.a)?.st === 'protected' && freshChain)
  )
    return { ok: false, why: 'auth' }
  // A2 timestamps: a causal lower bound only (no clock).
  for (const p of e.ap) if (e.ts < cx.ev(p).ts) return { ok: false, why: 'ts' }
  // A3 authority and guards
  if (!admissible(e, F)) return { ok: false, why: 'auth' }
  const { cls, self } = classify(e, F)
  const exempt = exemptOf(e, F, cls, B, cx)
  // W3(g) identity pool (non-owners): U(e) = the events
  // of e's identity in B(e) ∪ {e} that no event of another identity in B(e) has in its past, every kind except genesis,
  // and |U(e)| ≤ poolU. W3(b) bounds each device chain; this bounds what one view of the identity holds unacknowledged
  // across all its devices, and U(e) is recorded: evaluation makes an event a candidate when the pool of its concurrent
  // events overflows (forkPoints). Mutant `pool-off` (neither part).
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
  // A4 deterministic windows: W3 per device over its own chain in B(e); W3(c) per identity; W5 live-state caps.
  if (!exempt) {
    const cap = perms(F, e.a) & MODBITS ? LIM.w3mod : LIM.w3
    const mine = own.filter(x => !cx.rec(x.id).exempt)
    // W3(a) window: the device's non-exempt events dated within one window
    const n = mine.filter(x => x.ts > e.ts - LIM.win).length
    if (n + 1 > cap) return { ok: false, why: 'W3' }
    if (MUT === 'anchor-newest') {
      // a backlog bound anchored at the newest event of another identity
      let anchor = -Infinity
      for (const id of B) {
        const x = cx.ev(id)
        if (x.a !== e.a || x.t === 'genesis') anchor = Math.max(anchor, x.ts)
      }
      const lim = anchor + LIM.win
      if (e.ts > lim && mine.filter(x => x.ts > lim).length + 1 > cap)
        return { ok: false, why: 'W3b' }
    } else if (MUT === 'day-window') {
      // W3(b) unacknowledged day: the device's non-exempt events dated within one day that no event
      // of another identity in B(e) acknowledged within one window of their ts. An event can only acknowledge events
      // made before it, so citing old events never acknowledges a backlog made later: the budget is the same whatever
      // the backlog cites. A device whose events others see in time is bound by (a) alone; a lone device is never
      // blocked while it stays within the day budget.
      // The same budget for every author, dayU; mutant `day-mul` uses 4 × the hourly cap (so 10× more for
      // moderators and owners)
      const dayCap = MUT === 'day-mul' ? LIM.dayMul * cap : LIM.dayU
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
    MUT !== 'anchor-newest' &&
    (MUT === 'w3b-mod' ? !exempt : totCounted(e))
  ) {
    // W3(b) unacknowledged total: the device's counted events in
    // B(e) that no event of another identity in B(e) has in its past, plus e, ≤ totU, whatever their ts. An event
    // acknowledges only events made before it, by another identity, so citing old events acknowledges nothing; there is
    // no window, so a removed member's unacknowledged backlog is bounded in total, not per idle day. A lone device is
    // blocked after totU such events until another member posts an ACL event that has them in its past. Counted: every
    // ACL event except leave, device_revoke, primary_rotate and upgrade, so moderation too (a removed moderator's
    // exempt removals would otherwise be bounded only by the members it could remove, per device chain); moderation stays exempt
    // from the hourly cap W3(a). Mutants: `day-window` uses a day window in its place (24 per day, acknowledged within
    // the hour); `w3b-mod` counts only non-exempt events (moderation uncounted).
    const mine = own.filter(x => (MUT === 'w3b-mod' ? !cx.rec(x.id).exempt : totCounted(x)))
    if (mine.length + 1 > LIM.totU) {
      const unacked = mine.filter(x => isUnacked(x.id))
      if (unacked.length + 1 > LIM.totU) return { ok: false, why: 'W3b' }
    }
  }
  // W3(e) vouched invites: a join of a non-owner needs a live add for it that an owner
  // posted, or that an ACL event f in B(e) of an identity other than the add's author and the joiner has in its past.
  // Good faith needs no separate test: a live add is not in X of St(e), so it is either no candidate in St(e), and then
  // no structural candidate in any St(f) for f in B(e) (structural candidacy only grows with the set; a pool
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
  // W3(c) identity churn: device_adds of the identity in its current epoch dated within one day, and its
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
    // device_adds are counted across epochs (mutant `epoch-churn` counts the current epoch only, so each
    // rotation opens a fresh allowance)
    if (
      e.t === 'device_add' &&
      inDay('device_add', MUT === 'epoch-churn' ? epoch : undefined) + 1 > LIM.idCap
    )
      return { ok: false, why: 'W3c' }
    if (e.t === 'primary_rotate' && inDay('primary_rotate') + 1 > LIM.rotCap)
      return { ok: false, why: 'W3c' }
  }
  // W3(c) rotation total (non-owners): the identity's rotations in B(e) that no event of
  // another identity in B(e) has in its past, plus e, ≤ rotTot, whatever their ts. Rotations are the one kind of
  // introduction W3(d) never refuses (recovery); with concurrent ones void unless witnessed (rotation evidence)
  // and sequential ones capped here, the uncontested continuation of a removed member's identity chain introduces at
  // most freshCap + rotTot devices, so the inert events it can leave are bounded in total. Acknowledged rotations don't count: a member that recovers with
  // others online is never limited. Mutant `id-totals-off` (no total; the day cap of W3(c) alone).
  if (e.t === 'primary_rotate' && !F.owners.has(e.a) && MUT !== 'id-totals-off') {
    const unackedRot = (unackedB ? [...unackedB] : B).filter(
      id => cx.ev(id).a === e.a && cx.ev(id).t === 'primary_rotate' && isUnacked(id)
    )
    if (unackedRot.length + 1 > LIM.rotTot) return { ok: false, why: 'W3c' }
  }
  // W3(d) fresh introductions: a device_add of a non-owner is refused while B(e) holds freshCap
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
  // W3(f) no pinning: a non-owner's event is refused while B(e) holds evidence (device:
  // one device, same seq or same aprev; identity: one epoch, same iprev; rotation: any two concurrent ones; race: a
  // rotation and a non-rotation op over one iprev) between two events of its
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
    // rotation evidence is any two concurrent rotations (two rotations in mineU are always concurrent: neither is
    // in the past of a rotation in B(e)), and a rotation pairs with a non-rotation op over the same iprev (race)
    const rotPrevU = new Set(mineU.filter(x => x.t === 'primary_rotate').map(x => x.iprev ?? ''))
    // sibling carriers of one chain head (none in X of St(e)) are one rotation here: a later
    // event that cites both isn't pinning a fork
    const sibSkip = new Set<string>()
    const rotsU = mineU.filter(x => x.t === 'primary_rotate').sort((x, y) => (x.id < y.id ? -1 : 1))
    for (let i = 1; i < rotsU.length; i++)
      if (
        !S.X.has(rotsU[i].id) &&
        rotsU
          .slice(0, i)
          .some(y => !sibSkip.has(y.id) && !S.X.has(y.id) && sameHead(rotsU[i], y, cx))
      )
        sibSkip.add(rotsU[i].id)
    for (const x of mineU) {
      const kd = [`${x.dev}|s${x.seq}`, `${x.dev}|a${x.aprev ?? ''}`]
      const r = cx.rec(x.id)
      const ki =
        r.depth >= 0 && x.t !== 'genesis' && !sibSkip.has(x.id)
          ? x.t === 'primary_rotate'
            ? [`rot|${x.a}`, `race|${x.iprev ?? ''}`]
            : [
                `id|${r.epoch}|${x.iprev ?? ''}`,
                ...(rotPrevU.has(x.iprev ?? '') ? [`race|${x.iprev ?? ''}`] : []),
              ]
          : []
      for (const k of [...kd, ...ki]) {
        // a rotation may see one pair per key: it is the recovery that resolves a two-way race or fork
        const n = (seenDev.get(k)?.size ?? 0) + 1
        if (n > (e.t === 'primary_rotate' ? 2 : 1)) return { ok: false, why: 'W3f' }
        if (!seenDev.has(k)) seenDev.set(k, new Set())
        seenDev.get(k)!.add(x.id)
      }
    }
  }
  // W6 for primary_rotate: a rotation must change a fact: drop a live device, introduce its posting device,
  // install a new primary certificate, or recover an identity whose current epoch is forked or split.
  if (e.t === 'primary_rotate' && MUT !== 'rot-noop') {
    const live = F.devs.get(e.a) ?? new Set<string>()
    const keepR = new Set<string>([
      e.dev,
      ...((Array.isArray(e.c?.keep) ? e.c.keep : []) as string[]),
    ])
    const es = epochState(e.a, B, cx, S.FI, S.X)
    // a protected identity's primary is its chain head's, so a rotation installs a primary or
    // changes the recovery key exactly when it carries a new chain record
    const protR = rules3 && S.BD?.get(e.a)?.st === 'protected'
    const changes =
      [...live].some(v => !keepR.has(v)) ||
      !live.has(e.dev) ||
      (protR ? freshChain : String(e.c?.pcert ?? '') !== es.pcert) ||
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
  return {
    ok: true,
    rec: {
      k: rank(F, e.a),
      cls,
      self,
      exempt,
      depth,
      epoch,
      local: S,
      pool,
      ...(by !== undefined ? { by } : {}),
      ...(head1 ? { head1 } : {}),
      ...(sigBy ? { sigBy } : {}),
    },
  }
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
  /** the server's limits from its genesis (rules 3), undefined for the defaults */
  lim?: typeof LIM
  /** the rules versions this replica evaluates; an older client knows only 2 */
  known: number[]
  /** the rules version of a genesis this replica doesn't know: every event is stored unchecked (`U`), read-only */
  unknownRules?: number
  constructor(o: { rules?: number[] } = {}) {
    this.known = o.rules ?? RULES_KNOWN
  }

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
      r = withLim(this.lim, () => evaluate(ids, this))
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
    if (this.unknownRules !== undefined)
      return void this.status.set(e.id, { s: 'U', rules: this.unknownRules })
    withLim(this.lim, () => this.try1(e))
    for (let progress = true; progress;) {
      progress = false
      const w = this.waiting
      this.waiting = []
      for (const x of w) {
        withLim(this.lim, () => this.try1(x))
        if (this.status.get(x.id)!.s !== 'P') progress = true
      }
    }
  }

  private try1(e: Ev) {
    if (this.unknownRules !== undefined)
      return this.status.set(e.id, { s: 'U', rules: this.unknownRules })
    if (e.t === 'genesis') {
      const ok =
        e.seq === 0 &&
        e.ap.length === 0 &&
        (e.c.owners ?? []).includes(e.a) &&
        devOwner(e.dev) === e.a &&
        !e.aprev &&
        !e.iprev
      if (!ok) return this.status.set(e.id, { s: 'R', why: 'genesis' })
      // a rules version this replica doesn't evaluate makes the server read-only: the genesis and
      // every later event are stored unchecked (no strike, no state); an older client never shows a wrong state
      const rules = e.c?.rules ?? 2
      if (!Number.isSafeInteger(rules)) return this.status.set(e.id, { s: 'R', why: 'genesis' })
      if (!this.known.includes(rules)) {
        this.unknownRules = rules
        for (const x of this.waiting) this.status.set(x.id, { s: 'U', rules })
        this.waiting = []
        return this.status.set(e.id, { s: 'U', rules })
      }
      const L = limitsOf(e.c)
      if (L.bad) return this.status.set(e.id, { s: 'R', why: 'genesis' })
      if (L.lim) this.lim = L.lim
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
