/* eslint-disable */
// @ts-nocheck
// Part of the P2P ACL reference model, used only by tests.
// Random adversarial scenario generator (2-4 identities, 1-2 devices each, outsiders, ranked roles, scripted templates for
// the known attack shapes, then up to ~12 adversarial events). Uses only the World API.
import { World } from './world'
import { Client } from './client'
import {
  BAN,
  BITS,
  EVERYONE,
  INVITE,
  KICK,
  LIM,
  LIM_RANGE,
  ROLES,
  SERVER,
  type T,
  devOwner,
  perms,
  limitsOf,
  withLim,
  crDigest,
  recDigest,
  droppedBy,
  projectMembers,
} from './model'

export class Rng {
  constructor(public s: number) {
    if (!this.s) this.s = 1
  }
  next() {
    // xorshift32
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
      ;[b[i], b[j]] = [b[j], b[i]]
    }
    return b
  }
}

/**
 * The roles of a recovery-key template, for the O15 properties. `x` the protected (or legacy) identity,
 * `r` its recovery in this server and the devices it drops, the thief's admitted events, the devices it introduced and
 * the keys it holds, and the digests of the user's own chain records (once one is in the set, no thief key may hold).
 */
export interface RkMeta {
  kind: string
  x: string
  V1?: string
  V2?: string
  r?: string
  rDrops?: string[]
  thief: string[]
  thiefDevs?: string[]
  thiefKeys?: string[]
  leaked?: boolean
  legacy?: boolean
  userRecs?: string[]
  /** the user's revocation signed by the recovery key at an old position (the disowning flow) */
  disown?: string
  /** the thief holds a later chain record's primary: the recovery properties don't apply */
  laterPrimary?: boolean
  /** events the identity's honest client posted after its replica held a rival reset (its client
   * posts nothing there, so these exist only under mutant `frozen-acts`) */
  afterVoid?: string[]
  /** the template models the client's posting obligation (an upgraded S, a server the
   * identity left): O15-thief checks that nothing the thief posted counts at the end, its upgrades included */
  e2e?: boolean
  /** the identity left this server or was removed from it; it must not be a member at the end */
  leftOut?: boolean
  /** the user's honest joins that must be admitted (a successor server's carry-over add) */
  mustAdmit?: string[]
  /** the two siblings of a third identity's unacknowledged fork that a rival
   * carrier was placed on: both stay in X at the end of the template (`launderAt` events; the random phase after it may
   * cite anything, as an accomplice member can) */
  launder?: string[]
  launderAt?: number
  /** the postings the client model made or tried in this server (client.ts):
   * each must have had a link that carried it */
  postings?: {
    id?: string
    dev: string
    t: string
    bullet: string
    link: string
    delivered: boolean
    verdict?: string
    by?: string
    flaw?: string
  }[]
  /** the leave or removal the client recorded here, and the devices its posting dropped: no act of a dropped device after
   * the recorded event counts */
  leftAt?: string
  leftDrops?: string[]
  /** the upgrades the user signed that counted before its client's postings: they still count, outside the leaked-phrase
   * cost */
  keepUp?: string[]
  /** an introduction of the identity that the thief made and the user's older-epoch posting adopts (e2e skips it) */
  adopted?: string[]
  /** the number of events at the end of the template: O15-keepup reads the upgrades the user signed there
   * (the random phase after it may void or freeze another owner whose signature the upgrade carries: found by the first
   * official forced range, seed 82,005,714, where the random phase signed the other owner's rotation with `ik`) */
  keepUpAt?: number
  /** events the user's records had cut (in `Tail`) before a stolen later primary's carrier killed
   * them; after the client's repair they are cut again */
  stillCut?: string[]
  /** the user's client joined or rejoined here: the identity is a member (unless frozen) once
   * the template's first `memberAt` events are in */
  memberAt?: number
}
export interface Case {
  w: World
  equivocation: boolean
  seed: number
  adversarial: string[]
  template?: string
  limits?: Record<string, number>
  rkCase?: RkMeta
}

const ACTS: T[] = [
  'add',
  'add',
  'join',
  'join',
  'leave',
  'kick',
  'kick',
  'ban',
  'ban',
  'unban',
  'role_create',
  'role_move',
  'role_move',
  'role_bits',
  'role_del',
  'assign',
  'assign',
  'revoke',
  'revoke',
  'device_add',
  'device_revoke',
  'device_revoke',
  'mark',
  'upgrade',
  'uninvite',
  'uninvite',
  'code',
  'code',
  'code_revoke',
  'code_revoke',
  'profile',
  'settings',
  'x_future',
  'primary_rotate',
]

/** Templates for known attack shapes; each is a short scripted race, tolerant of rejections. */
export const TEMPLATES = [
  'c1-pair',
  'c1-chain',
  'c1-world',
  'c1-classes',
  'c2-withdraw',
  'c3-thief',
  'c4-upgrade',
  'i1-grab',
  'i2-burst',
  'i2-breadth',
  'i3-flood',
  'i4-cap',
  'nm-target',
  'nm-pending',
  'nm-rejoin',
  'nm-pos',
  'big-stratum',
  'i5-rejoin',
  'g-intro',
  'g-tree',
  'g-pool',
  'g-sib',
  'rk-thief',
  'rk-newsrv',
  'rk-leak',
  'rk-legacy',
  'rk-rejoin',
  'rk-upgrade',
  'rk-left',
  'h2-gossip',
] as const

/**
 * The per-server limits a case's genesis fixes. A quarter of the cases are rules 3 with one to three
 * limits at the edges of their ranges (or inside), drawn from their own stream so the rest of the case is unchanged.
 */
export function drawLimits(seed: number, p = 0.25): Record<string, number> | undefined {
  const r = new Rng(seed * 40503 + 7)
  if (!r.chance(p)) return undefined
  const keys = Object.keys(LIM_RANGE)
  const L: Record<string, number> = {}
  for (let i = 0, n = 1 + r.int(3); i < n; i++) {
    const k = r.pick(keys),
      [lo, hi] = LIM_RANGE[k]
    const u = r.next()
    L[k] = u < 0.4 ? lo : u < 0.8 ? hi : lo + r.int(hi - lo + 1)
  }
  const lim: any = { ...LIM, ...L }
  if (lim.w3 > lim.w3mod) L.w3mod = Math.max(lim.w3, LIM_RANGE.w3mod[0])
  if (lim.codesPerDev > lim.codesPerDevServer)
    L.codesPerDevServer = Math.max(lim.codesPerDev, LIM_RANGE.codesPerDevServer[0])
  // poolU ≥ devCap × totU: raise the pool, or lower the device budget when the pool can't hold it
  const dc = L.devCap ?? lim.devCap
  let tu = L.totU ?? lim.totU,
    pu = L.poolU ?? lim.poolU
  if (pu < dc * tu) {
    if (dc * tu <= LIM_RANGE.poolU[1] && L.poolU === undefined) pu = dc * tu
    else tu = Math.max(LIM_RANGE.totU[0], Math.floor(pu / dc))
    if (pu < dc * tu) pu = Math.min(LIM_RANGE.poolU[1], dc * tu)
    if (pu < dc * tu) tu = Math.floor(pu / dc)
    if (pu !== lim.poolU || L.poolU !== undefined) L.poolU = pu
    if (tu !== lim.totU || L.totU !== undefined) L.totU = tu
  }
  return L
}

export function genCase(
  seed: number,
  o: {
    maxAdv?: number
    equivocation?: boolean
    template?: string
    limits?: Record<string, number> | null
    rules?: number
  } = {}
): Case {
  const L = o.limits === null ? undefined : (o.limits ?? drawLimits(seed))
  // rules 3 for every case with limits, and for half of the others (recovery keys exist only under rules 3)
  const rr = new Rng(seed * 69069 + 3)
  const rules = o.rules ?? (L ? 3 : rr.chance(0.5) ? 3 : 2)
  // some genesis contents the rules refuse or leave unread: a rules-2 genesis with a
  // `limits` field (read as the defaults), and a rules-3 genesis with an unknown key or a value outside its range
  // (refused: nothing of the server is admitted)
  const u = o.rules === undefined && o.limits === undefined ? rr.next() : 1
  if (u < 0.03 && !L) {
    const D = drawLimits(seed, 1)!
    return genCase0(seed, o, D, 2, D)
  }
  // unknown keys include names of Object.prototype members, built with JSON.parse (an own
  // key, as on the wire), and a `limits` of null
  if (u < 0.045 && L) {
    const k = rr.pick([
      'unknown_future',
      'toString',
      'constructor',
      '__proto__',
      'hasOwnProperty',
      'valueOf',
    ])
    const D = rr.chance(0.15)
      ? null
      : {
          ...L,
          ...(rr.chance(0.6) ? JSON.parse(`{"${k}": 7}`) : { roles: LIM_RANGE.roles[1] + 1 }),
        }
    return genCase0(seed, o, D as any, 3, D as any)
  }
  const lim = L ? limitsOf({ rules: 3, limits: L }).lim : undefined
  return withLim(lim, () => genCase0(seed, o, L, rules))
}

function genCase0(
  seed: number,
  o: { maxAdv?: number; equivocation?: boolean; template?: string },
  L: Record<string, number> | undefined,
  rules: number,
  rawLimits?: Record<string, unknown>
): Case {
  const rules3 = rules === 3
  const rng = new Rng(seed * 2654435761)
  let w = new World() // rk-upgrade's successor kind makes the case's world S'
  const others = ['A', 'B', 'C'].slice(0, 1 + rng.int(3))
  const idents = ['O', ...others]
  const devsOf = new Map<string, string[]>()
  for (const i of idents) devsOf.set(i, rng.chance(0.5) ? [`${i}1`, `${i}2`] : [`${i}1`])
  for (const x of ['N', 'M', 'V', 'Z']) devsOf.set(x, [`${x}1`]) // outsiders who may be invited
  let owners = rng.chance(0.15) ? ['O', others[0]] : ['O']
  // on rules 3 some identities are protected from creation (owners through the
  // genesis bundle, members through their first join, the add naming the key half the time), from their own random
  // stream so the rest of the case is unchanged; random rotations then sign with those keys or wrong ones
  const pr = new Rng(seed * 7717 + 3)
  const crOf = new Map<string, string>()
  if (rules === 3)
    for (const i of [...owners, ...others])
      if (pr.chance(0.2)) crOf.set(i, pr.pick(['rkA', 'rkB', 'rkC']))
  // the upgrade template needs a protected genesis owner (its own stream, so other cases are unchanged).
  // Its kinds: a stolen owner device; a leaked old phrase of a single owner,
  // of a co-owner, of a co-owner that left before signing, or with the reset carried in a co-owner's signature; and
  // a successor server built from projectMembers (the case's world is then S'). The co-owner kinds have two genesis
  // owners, both protected
  const ur = new Rng(seed * 8191 + 7)
  const upT =
    rules === 3 &&
    (o.template === 'rk-upgrade' ||
      (o.template === undefined && owners.length === 1 && ur.chance(0.05)))
  // `later` (a stolen device of a later epoch, single owner or co-owner) and
  // `leftstolen` (a co-owner that left, signed, recovered, with a stolen device)
  const upKind = upT
    ? ur.pick([
        'stolen',
        'stolen',
        'single',
        'coowner',
        'left',
        'sigchain',
        'succ',
        'succ',
        'later',
        'later',
        'leftstolen',
        'leftstolen',
      ] as const)
    : undefined
  const laterCo = upKind === 'later' && ur.chance(0.4)
  // rk-left, a server the identity left or was removed from (its own stream too); the owner kind
  // has a protected single owner, the member kind a protected member P the template lets in
  const lr = new Rng(seed * 4099 + 11)
  const leftT =
    rules === 3 &&
    !upT &&
    (o.template === 'rk-left' ||
      (o.template === undefined && owners.length === 1 && lr.chance(0.04)))
  const leftKind = leftT ? lr.pick(['owner', 'member', 'member'] as const) : undefined
  if (upT)
    owners =
      upKind === 'coowner' ||
      upKind === 'left' ||
      upKind === 'sigchain' ||
      upKind === 'leftstolen' ||
      laterCo
        ? ['O', others[0]]
        : ['O']
  if (leftT) owners = ['O']
  if (upT || leftKind === 'owner') crOf.set('O', 'rkO')
  if (upT && owners.length === 2) crOf.set(owners[1], 'rkQ')
  const rks = Object.fromEntries(
    owners
      .filter(o => crOf.has(o))
      .map(o => [
        o,
        o === 'O' && (upT || leftKind === 'owner') ? { rk: 'rkO', pk: 'pO0' } : crOf.get(o)!,
      ])
  )
  w.genesis(
    'O1',
    owners,
    rng.chance(0.4) ? INVITE : 0,
    0,
    rules === 3
      ? {
          rules: 3,
          ...(L !== undefined ? { limits: L } : {}),
          ...(Object.keys(rks).length ? { rks } : {}),
        }
      : rawLimits
        ? { rules: 2, limits: rawLimits }
        : {}
  )
  if (w.ref.status.get(w.all[0].id)?.s !== 'A')
    return { w, equivocation: false, seed, adversarial: [], limits: L }
  // W3(e): a join through a non-owner's add needs a third identity's good-faith
  // acknowledgement of the add. Before most joins, a bystander Vb (let in by the owner right after genesis, posting only
  // these marks) acknowledges every non-owner add for the joiner in the join's past, and the join cites that mark; the
  // other joins test the refusal.
  const vouchOp = (dev: string, op: any) => {
    const who = devOwner(dev)
    const B = op.ap ? w.closure(op.ap) : new Set(w.ref.order)
    const adds = [...B].filter(id => {
      const x = w.ref.ev(id)
      return x.t === 'add' && x.c?.to === who && !owners.includes(x.a)
    })
    if (!adds.length || !w.latestOwn('Vb1')) return op
    const m = w.act('Vb1', 'mark', {}, { ap: adds })
    if (m.v.s !== 'A' || !op.ap) return op
    return { ...op, ap: [...op.ap, m.e.id] }
  }
  const act = (dev: string, t: T, c: any = {}, op: any = {}) =>
    w.act(dev, t, c, t === 'join' && rng.chance(0.85) ? vouchOp(dev, op) : op)
  const tryAct = (dev: string, t: T, c: any = {}, op: any = {}) => act(dev, t, c, op).v.s === 'A'
  const okId = (r: { e: { id: string }; v: { s: string } }) => (r.v.s === 'A' ? r.e.id : undefined)
  const isAdm = (id: string | undefined) => !!id && w.ref.status.get(id)?.s === 'A'
  // the owner's setup events are spread over time like a real setup (2 time units apart, W3)
  let clock = 0
  const setup = (dev: string, t: T, c: any = {}, op: any = {}) => {
    const B = op.ap ? w.closure(op.ap) : new Set(w.ref.order)
    let mx = 0
    for (const id of B) mx = Math.max(mx, w.ref.ev(id).ts)
    clock = Math.max(clock + 2, mx + 1)
    return act(dev, t, c, { ts: clock, ...op })
  }

  // setup
  setup('O1', 'add', { to: 'Vb' })
  setup('Vb1', 'join')
  if (devsOf.get('O')!.length > 1) setup('O2', 'device_add')
  const nroles = 1 + rng.int(3)
  for (let r = 0; r < nroles; r++) {
    let bits = 0
    for (const b of BITS) if (rng.chance(0.5)) bits |= b
    setup('O1', 'role_create', { pos: 1 + rng.int(9), bits })
  }
  const joins = new Map<string, string>()
  for (const i of others) {
    const cr = owners.includes(i) ? undefined : crOf.get(i)
    if (!owners.includes(i))
      setup('O1', 'add', cr && pr.chance(0.5) ? { to: i, head: crDigest(i, cr, 'p0') } : { to: i })
    const j = setup(`${i}1`, 'join', cr ? { rk: cr } : {})
    if (j.v.s === 'A') joins.set(i, j.e.id)
    if (devsOf.get(i)!.length > 1) setup(`${i}2`, 'device_add')
  }
  const roles = () => w.ref.order.filter(id => w.ref.ev(id).t === 'role_create')
  const codes = () => w.ref.order.filter(id => w.ref.ev(id).t === 'code')
  for (const i of others)
    if (rng.chance(0.7) && roles().length) setup('O1', 'assign', { to: i, role: rng.pick(roles()) })
  if (rng.chance(0.3)) setup('O1', 'code', { h: 'h0' })
  if (others.length > 1 && rng.chance(0.4) && roles().length)
    setup('O1', 'assign', { to: rng.pick(others), role: rng.pick(roles()) })
  const members = () => others.filter(i => w.state().facts.mem.has(i) && !owners.includes(i))

  // race template: a senior demotes promoter A while A promotes C and B removes C; C then acts
  // having seen the promotion and the removal (exercises k* and the frontier for operations after a deny).
  if (others.length === 3 && !owners.includes('A') && rng.chance(0.3)) {
    const mr = setup('O1', 'role_create', { pos: 7, bits: ROLES | (rng.chance(0.5) ? INVITE : 0) })
      .e.id
    const rr = setup('O1', 'role_create', {
      pos: 4 + rng.int(2),
      bits: rng.chance(0.5) ? INVITE : 0,
    }).e.id
    const kr = setup('O1', 'role_create', { pos: 2 + rng.int(2), bits: KICK | BAN }).e.id
    setup('O1', 'assign', { to: 'A', role: mr })
    setup('O1', 'assign', { to: 'B', role: kr })
    const P = w.heads()
    if (rng.chance(0.5)) setup('O1', 'revoke', { to: 'A', role: mr })
    else setup('O1', 'role_move', { role: mr, pos: 1 })
    const asg = act('A1', 'assign', { to: 'C', role: rr }, { ap: P })
    const den = act('B1', rng.chance(0.5) ? 'kick' : 'ban', { to: 'C' }, { ap: P })
    if (asg.v.s === 'A' && den.v.s === 'A') {
      const t = rng.pick(['add', 'mark', 'profile', 'code', 'assign'] as T[])
      const c =
        t === 'add'
          ? { to: 'N' }
          : t === 'profile'
            ? { name: 1 }
            : t === 'code'
              ? { h: 'h2' }
              : t === 'assign'
                ? { to: 'N', role: rr }
                : {}
      act('C1', t, c, { ap: [asg.e.id, den.e.id] })
    }
  }

  // attack templates: each case runs at most one, so every shape is reached in a few percent of cases
  let template: string | undefined = o.template
  if (template === undefined && rng.chance(0.5))
    template = rng.pick([
      'c1-pair',
      'c1-pair',
      'c1-chain',
      'c1-chain',
      'c1-chain',
      'c1-world',
      'c1-world',
      'c1-classes',
      'c1-classes',
      'c2-withdraw',
      'c2-withdraw',
      'c3-thief',
      'c3-thief',
      'c4-upgrade',
      'i1-grab',
      'i2-burst',
      'i2-burst',
      'i2-breadth',
      'i3-flood',
      'i4-cap',
      // the non-monotone corners and large strata
      'nm-target',
      'nm-target',
      'nm-target',
      'nm-pending',
      'nm-pending',
      'nm-rejoin',
      'nm-pos',
      'nm-pos',
      'big-stratum',
      // a rejoin after a cascade cut a membership that held a role
      'i5-rejoin',
      'i5-rejoin',
      // the growth shapes
      'g-intro',
      'g-intro',
      'g-tree',
      'g-tree',
      'g-pool',
      'g-pool',
      'g-pool',
      // same-seq sibling floods past poolU, from a removed member and from a stolen device
      'g-sib',
      'g-sib',
      'g-sib',
      // the recovery key (in-server recovery, new servers, a leaked phrase, a legacy
      // identity) and concurrent non-causes (the second head-path case)
      'rk-thief',
      'rk-thief',
      'rk-newsrv',
      'rk-newsrv',
      'rk-leak',
      'rk-leak',
      'rk-legacy',
      'rk-rejoin',
      'rk-rejoin',
      'h2-gossip',
      'h2-gossip',
      'h2-gossip',
    ])
  if (upT) template = 'rk-upgrade'
  if (leftT) template = 'rk-left'
  const mem = members()
  let replayed = false // the thief template's identity-chain replay is deliberate equivocation
  let rkMeta: RkMeta | undefined // the roles of the rk-thief template, for the O15 properties
  switch (template) {
    case 'c1-pair': {
      // two moderators share one role (same stratum); V's invite chain; the owner promotes V's invitee N above
      // the pair; one moderator's unrelated deny precedes the promotion; the other kicks V from before V's invite.
      if (mem.length < 2) break
      const [q, p] = rng.shuffle(mem).slice(0, 2)
      const qr = okId(
        setup('O1', 'role_create', {
          pos: 2 + rng.int(2),
          bits: KICK | BAN | (rng.chance(0.3) ? INVITE : 0),
        })
      )
      const hr = okId(
        setup('O1', 'role_create', { pos: 5 + rng.int(3), bits: rng.chance(0.5) ? INVITE : 0 })
      )
      const vr = okId(setup('O1', 'role_create', { pos: 1, bits: INVITE }))
      if (!qr || !hr || !vr) break
      setup('O1', 'assign', { to: q, role: qr })
      setup('O1', 'assign', { to: p, role: qr })
      setup('O1', 'add', { to: 'V' })
      const jv = okId(act('V1', 'join'))
      setup('O1', 'assign', { to: 'V', role: vr })
      if (rng.chance(0.5)) {
        setup('O1', 'add', { to: 'Z' })
        act('Z1', 'join')
      }
      const u = rng.next()
      if (u < 0.4) act(`${p}1`, 'kick', { to: 'Z' })
      else if (u < 0.7) act(`${p}1`, 'leave')
      else act(`${p}1`, 'ban', { to: 'K' })
      act('V1', 'add', { to: 'N' })
      act('N1', 'join')
      const promote = rng.chance(0.8)
      if (promote) setup('O1', 'assign', { to: 'N', role: hr })
      if (rng.chance(0.7)) {
        act('N1', 'add', { to: 'M' })
        act('M1', 'join')
      }
      if (rng.chance(0.5)) act('N1', rng.pick(['mark', 'profile'] as T[]), { name: 2 })
      if (jv) act(`${q}1`, rng.chance(0.7) ? 'kick' : 'ban', { to: 'V' }, { ap: [jv] })
      break
    }
    case 'c1-chain': {
      // 2–3 moderators share one role (same stratum); unrelated sibling cuts (a kick or
      // ban of a member who posted an ACL event, or a moderator's leave) positioned before that member's event; a
      // 2–3-level member invite chain built after them; senior promotions of chain members at several ranks (by the
      // owner or by a senior moderator), placed before or after the sibling cuts; the deciding backdated removal of the
      // chain root (sometimes two overlapping removals); sometimes a second, overlapping cut of a chain member.
      if (mem.length < 2) break
      const mods = rng.shuffle(mem).slice(0, mem.length > 2 && rng.chance(0.5) ? 3 : 2)
      const sp = 2 + rng.int(2)
      const qr = okId(
        setup('O1', 'role_create', { pos: sp, bits: KICK | BAN | (rng.chance(0.3) ? INVITE : 0) })
      )
      const vr = okId(setup('O1', 'role_create', { pos: 1, bits: INVITE }))
      if (!qr || !vr) break
      const highs: string[] = []
      for (let i = 0, nh = 1 + rng.int(2); i < nh; i++) {
        const p = rng.chance(0.75) ? sp + 1 + rng.int(5) : sp - rng.int(2) // mostly above the stratum, sometimes at or below
        const h = okId(setup('O1', 'role_create', { pos: p, bits: rng.chance(0.5) ? INVITE : 0 }))
        if (h) highs.push(h)
      }
      for (const m of mods) setup('O1', 'assign', { to: m, role: qr })
      // an optional senior moderator (ranked above the stratum, with ManageRoles) who promotes instead of the owner
      let senior = 'O1'
      const others2 = mem.filter(m => !mods.includes(m))
      if (others2.length && rng.chance(0.4)) {
        const sr = okId(setup('O1', 'role_create', { pos: sp + 6, bits: ROLES | INVITE }))
        if (sr && isAdm(okId(setup('O1', 'assign', { to: others2[0], role: sr }))))
          senior = `${others2[0]}1`
      }
      const outsider = (x: string) => {
        setup('O1', 'add', { to: x })
        return okId(act(`${x}1`, 'join'))
      }
      const sib = ['Z', 'Y'].slice(0, rng.chance(0.4) ? 2 : 1)
      for (const s of sib) outsider(s)
      const ju = outsider('U')
      if (!ju) break
      setup('O1', 'assign', { to: 'U', role: vr })
      const promote = (x: string) => {
        const h = highs.length ? rng.pick(highs) : undefined
        if (h) act(senior, 'assign', { to: x, role: h })
      }
      if (rng.chance(0.2)) promote(rng.pick(['U', ...sib]))
      // unrelated sibling cuts: each sibling posts an ACL event; a moderator removes it from a position before that
      const siblingCuts = () => {
        sib.forEach((s, i) => {
          const before = w.heads()
          act(`${s}1`, rng.pick(['profile', 'mark', 'code'] as T[]), { name: 3 + i, h: `h${i}` })
          const m = mods[(i + 1) % mods.length]
          const u = rng.next()
          if (u < 0.55) act(`${m}1`, 'kick', { to: s }, { ap: before })
          else if (u < 0.8) act(`${m}1`, 'ban', { to: s }, { ap: before })
          else act(`${m}1`, 'leave', {}, { ap: before })
        })
      }
      const early = rng.chance(0.8)
      if (early) siblingCuts()
      const P0 = w.heads()
      // the chain U → V → N (→ M), each inviter holding the invite role
      const chain = ['V', 'N', 'M'].slice(0, rng.chance(0.5) ? 3 : 2)
      let prev = 'U'
      const joinsC: string[] = []
      for (const x of chain) {
        const add = okId(act(`${prev}1`, 'add', { to: x }))
        if (!add) break
        const j = okId(act(`${x}1`, 'join'))
        if (!j) break
        joinsC.push(j)
        setup('O1', 'assign', { to: x, role: vr })
        if (rng.chance(x === 'V' ? 0.3 : 0.65)) promote(x)
        prev = x
      }
      if (!early) siblingCuts()
      if (rng.chance(0.5))
        act(`${prev}1`, rng.pick(['mark', 'profile', 'add'] as T[]), { name: 2, to: 'K' })
      if (rng.chance(0.5)) act('O1', 'mark')
      // the deciding removal of the chain root from before its invite; sometimes a second moderator removes it too, or
      // removes a chain member from before its own invite
      act(`${mods[0]}1`, rng.chance(0.7) ? 'kick' : 'ban', { to: 'U' }, { ap: P0 })
      if (rng.chance(0.25)) act(`${mods[1]}1`, 'kick', { to: 'U' }, { ap: P0 })
      if (rng.chance(0.25) && joinsC.length > 1)
        act(`${rng.pick(mods)}1`, 'kick', { to: chain[0] }, { ap: [joinsC[0]] })
      break
    }
    case 'c1-world': {
      // depth: two grantors give X ManageRoles roles (an OR-support), X gives P an Invite role, P invites N.
      // 2–4 same-stratum removals of the grantors (by one or several moderators) race all of it; the owner's two devices
      // promote X and P concurrently with random subsets of the removals, so X and P have different exposure sets and
      // the cascade must intersect them along the path.
      if (!mem.length) break
      const mods = rng.shuffle(mem).slice(0, 1 + rng.int(Math.min(3, mem.length)))
      if (!w.ref.order.some(id => w.ref.ev(id).dev === 'O2')) setup('O2', 'device_add')
      for (const r of [...w.state().facts.roles]) setup('O1', 'role_del', { role: r }) // room under the role cap (W5)
      const sp = 3
      const qr = okId(setup('O1', 'role_create', { pos: sp, bits: KICK | BAN }))
      const ar = okId(setup('O1', 'role_create', { pos: 2, bits: ROLES }))
      const r1 = okId(setup('O1', 'role_create', { pos: 1, bits: ROLES }))
      const r2 = rng.chance(0.3) ? okId(setup('O1', 'role_create', { pos: 1, bits: ROLES })) : r1 // same role twice: still an OR
      const r3 = okId(setup('O1', 'role_create', { pos: 0, bits: INVITE }))
      const hr = okId(setup('O1', 'role_create', { pos: sp + 1 + rng.int(4), bits: 0 }))
      if (!qr || !ar || !r1 || !r2 || !r3 || !hr) break
      for (const m of mods) setup('O1', 'assign', { to: m, role: qr })
      for (const x of ['G', 'H', 'X', 'P']) {
        setup('O1', 'add', { to: x })
        act(`${x}1`, 'join')
      }
      setup('O1', 'assign', { to: 'G', role: ar })
      setup('O1', 'assign', { to: 'H', role: ar })
      const P0 = w.heads()
      const y1 = okId(act('G1', 'assign', { to: 'X', role: r1 }, { ap: P0 }))
      const y2 = rng.chance(0.85)
        ? okId(act('H1', 'assign', { to: 'X', role: r2 }, { ap: P0 }))
        : undefined
      const ys = [y1, y2].filter((y): y is string => !!y)
      if (!ys.length) break
      const x = okId(act('X1', 'assign', { to: 'P', role: r3 }, { ap: ys }))
      if (!x) break
      const p = okId(act('P1', 'add', { to: 'N' }, { ap: [x] }))
      // removals: two of G by different moderator devices (an OR at X's support), one of H, sometimes more
      const modDevs = mods.flatMap(m => devsOf.get(m)!)
      const canon = modDevs.length >= 2 && rng.chance(0.5)
      const causes: string[] = []
      const ga = canon ? okId(act(modDevs[0], 'kick', { to: 'G' }, { ap: P0 })) : undefined
      const gb = canon
        ? okId(act(modDevs[1], rng.chance(0.7) ? 'kick' : 'ban', { to: 'G' }, { ap: P0 }))
        : undefined
      for (const c of [ga, gb]) if (c) causes.push(c)
      if (canon) {
        const c = okId(act(rng.pick(modDevs), 'kick', { to: 'H' }, { ap: P0 }))
        if (c) causes.push(c)
      }
      for (let i = 0, nc = canon ? rng.int(2) : 2 + rng.int(3); i < nc; i++) {
        const c = okId(
          act(
            rng.pick(modDevs),
            rng.chance(0.8) ? 'kick' : 'ban',
            { to: rng.pick(['G', 'H']) },
            { ap: P0 }
          )
        )
        if (c) causes.push(c)
      }
      const sub = () => causes.filter(() => rng.chance(0.5))
      // canonical: X is promoted concurrently with one removal of G only, P concurrently with the other only
      const subX = canon && ga && gb ? causes.filter(c => c !== ga) : sub()
      const subP = canon && ga && gb ? causes.filter(c => c !== gb) : sub()
      if (rng.chance(0.85)) act('O1', 'assign', { to: 'X', role: hr }, { ap: [x, ...subX] })
      if (p && rng.chance(0.85)) act('O2', 'assign', { to: 'P', role: hr }, { ap: [p, ...subP] })
      if (p && rng.chance(0.4)) act('N1', 'join', {}, { ap: [p] })
      break
    }
    case 'c1-classes': {
      // at scale: an invite tree under U, 3–6 same-stratum removals (of U, of tree members, of unrelated
      // siblings) by several moderator devices at old positions, and 3–6 senior promotions of tree members, each citing
      // a random subset of the removals: many protection classes, so both the exact rule and its fallback are reached.
      if (!mem.length) break
      const mods = rng.shuffle(mem).slice(0, 1 + rng.int(Math.min(3, mem.length)))
      const modDevs = mods.flatMap(m => devsOf.get(m)!)
      if (!w.ref.order.some(id => w.ref.ev(id).dev === 'O2')) setup('O2', 'device_add')
      for (const r of [...w.state().facts.roles]) setup('O1', 'role_del', { role: r })
      const qr = okId(setup('O1', 'role_create', { pos: 3, bits: KICK | BAN }))
      const hr = okId(setup('O1', 'role_create', { pos: 4 + rng.int(4), bits: 0 }))
      if (!qr || !hr) break
      if (!((w.state().facts.bits.get(EVERYONE) ?? 0) & INVITE))
        setup('O1', 'role_bits', { role: EVERYONE, bit: INVITE, on: true })
      for (const m of mods) setup('O1', 'assign', { to: m, role: qr })
      for (const x of ['U', 'Z']) {
        setup('O1', 'add', { to: x })
        act(`${x}1`, 'join')
      }
      const Z0 = w.heads()
      act('Z1', 'mark')
      const P0 = w.heads()
      const tree: string[] = []
      const parentOf = new Map<string, string>()
      const grow = (parent: string, depth: number) => {
        for (let i = 0, n = 1 + rng.int(2); i < n && tree.length < 7; i++) {
          const x = `t${tree.length}x`
          if (!okId(act(`${parent}1`, 'add', { to: x }))) continue
          if (!okId(act(`${x}1`, 'join'))) continue
          tree.push(x)
          parentOf.set(x, parent)
          if (depth < 3 && rng.chance(0.7)) grow(x, depth + 1)
        }
      }
      grow('U', 1)
      // a device chain is linear, so one device's removals are made in the causal order of their positions: the first
      // device removes Z (before Z's mark) and then U (before U's invites); the others remove tree members
      const causes: string[] = []
      const rm = (dev: string, to: string, ap: string[]) => {
        const c = okId(act(dev, rng.chance(0.75) ? 'kick' : 'ban', { to }, { ap }))
        if (c) causes.push(c)
      }
      const [d0, ...rest] = rng.shuffle(modDevs)
      rm(d0, 'Z', Z0)
      rm(d0, 'U', P0)
      for (const d of rest) {
        if (!tree.length) break
        const v = rng.pick(tree)
        const jv = w.ref.order.find(id => w.ref.ev(id).t === 'join' && w.ref.ev(id).a === v)
        if (jv) rm(d, v, [jv])
      }
      const proms = rng.shuffle(tree).slice(0, 3 + rng.int(4))
      proms.forEach((x, i) => {
        const last = w.latestOwn(`${x}1`)
        if (!last) return
        const anc = new Set<string>()
        for (let p: string | undefined = x; p; p = parentOf.get(p)) anc.add(p)
        anc.add('U')
        const sub = causes.filter(c => !anc.has(w.ref.ev(c).c.to) && rng.chance(0.6))
        act(i % 2 ? 'O2' : 'O1', 'assign', { to: x, role: hr }, { ap: [last.id, ...sub] })
      })
      for (const x of rng.shuffle(tree).slice(0, 3))
        act(`${x}1`, rng.pick(['mark', 'profile'] as T[]), { name: 1 })
      break
    }
    case 'nm-target': {
      // two seniors raise the actor's role and the target's role; a member
      // holding the raised actor role acts on a target whose rank the second raise lifted (assign, kick, ban, revoke), or
      // the target invites; the raisers are removed concurrently (a leave from a second device, or a moderator's kick);
      // the owner promotes the actor and/or the target after one removal and concurrently with the other; optional
      // unrelated promotions add protection classes (the class-cap fallback).
      if (!w.ref.order.some(id => w.ref.ev(id).dev === 'O2')) setup('O2', 'device_add')
      for (const r of [...w.state().facts.roles]) setup('O1', 'role_del', { role: r })
      const kmod = rng.chance(0.5)
      const L = (pos: number, bits: number) => okId(setup('O1', 'role_create', { pos, bits }))
      const sr = L(18, ROLES),
        ar = L(3, KICK | BAN | ROLES),
        tr = L(4, rng.chance(0.5) ? INVITE : 0),
        hr = L(25, 0)
      const ir = L(2, INVITE),
        mr = kmod ? L(20, KICK | BAN) : undefined
      if (!sr || !ar || !tr || !hr || !ir || (kmod && !mr)) break
      const names = [
        'Sa',
        'Sb',
        'Pp',
        'Yy',
        'Tt',
        ...(kmod ? ['Qa', 'Qb'] : []),
        ...(rng.chance(0.4) ? ['Kk', 'Zz'] : []),
      ]
      for (const x of names) {
        setup('O1', 'add', { to: x })
        act(`${x}1`, 'join')
      }
      if (!kmod) {
        act('Sa2', 'device_add')
        act('Sb2', 'device_add')
      }
      for (const [x, r] of [
        ['Sa', sr],
        ['Sb', sr],
        ['Pp', ar],
        ['Yy', ar],
        ...(kmod
          ? [
              ['Qa', mr!],
              ['Qb', mr!],
            ]
          : []),
      ] as [string, string][])
        setup('O1', 'assign', { to: x, role: r })
      if (rng.chance(0.4))
        setup('O1', 'assign', {
          to: 'Yy',
          role: okId(setup('O1', 'role_create', { pos: 5, bits: 0 })) ?? ar,
        })
      const H0 = w.heads()
      const z = okId(act('Sa1', 'role_move', { role: ar, pos: 13 + rng.int(4) }, { ap: H0 }))
      const z2 = rng.chance(0.8)
        ? okId(act('Sb1', 'role_move', { role: tr, pos: 6 + rng.int(3) }, { ap: H0 }))
        : undefined
      if (!z) break
      const y = okId(act('Yy1', 'assign', { to: 'Tt', role: tr }, { ap: [z, ...(z2 ? [z2] : [])] }))
      if (!y) break
      const kind = rng.pick(['assign', 'assign', 'kick', 'ban', 'revoke', 'none'] as const)
      let last: string | undefined
      if (kind === 'assign') last = okId(act('Pp1', 'assign', { to: 'Tt', role: ir }, { ap: [y] }))
      else if (kind === 'kick' || kind === 'ban')
        last = okId(act('Pp1', kind, { to: 'Tt' }, { ap: [y] }))
      else if (kind === 'revoke')
        last = okId(act('Pp1', 'revoke', { to: 'Tt', role: tr }, { ap: [y] }))
      let tip = last ?? y
      if (kind !== 'kick' && kind !== 'ban') {
        const add = okId(act('Tt1', 'add', { to: 'N' }, { ap: [tip] }))
        const jn = add ? okId(act('N1', 'join', {}, { ap: [add] })) : undefined
        if (jn) tip = jn
      }
      let zm: string | undefined
      if (names.includes('Zz')) zm = okId(act('Zz1', 'mark', {}, { ap: H0 }))
      const km = zm ? okId(act('Kk1', 'mark', {}, { ap: [zm] })) : undefined
      const rm = (who: 'a' | 'b') =>
        kmod
          ? okId(
              act(
                who === 'a' ? 'Qa1' : 'Qb1',
                'kick',
                { to: who === 'a' ? 'Sa' : 'Sb' },
                { ap: H0 }
              )
            )
          : okId(act(who === 'a' ? 'Sa2' : 'Sb2', 'leave', {}, { ap: H0 }))
      const first = rng.chance(0.5) ? 'a' : 'b'
      const r1 = rm(first)
      const prom = rng.pick(['Pp', 'Tt', 'both'] as const)
      if (r1) {
        if (prom !== 'Tt') act('O1', 'assign', { to: 'Pp', role: hr }, { ap: [tip, r1] })
        if (prom !== 'Pp') act('O2', 'assign', { to: 'Tt', role: hr }, { ap: [tip, r1] })
      }
      const r2 = rm(first === 'a' ? 'b' : 'a')
      if (km && kmod && r2) {
        const zk = okId(act('Qb1', 'kick', { to: 'Zz' }, { ap: H0 }))
        if (zk) act('O2', 'assign', { to: 'Kk', role: hr }, { ap: [km, zk] })
      }
      act('O1', 'mark')
      break
    }
    case 'nm-pending': {
      // the foreign pending adds of an uninvite: A, holding Kick through G's grant, withdraws N's invites while
      // B's concurrent add of N is pending; a senior removes G and B at one stratum. B's cut add stays in
      // the foreign set, so A's withdrawal doesn't survive the loss of its Kick.
      if (!w.ref.order.some(id => w.ref.ev(id).dev === 'O2')) setup('O2', 'device_add')
      for (const r of [...w.state().facts.roles]) setup('O1', 'role_del', { role: r })
      const kr = okId(setup('O1', 'role_create', { pos: 3, bits: KICK | INVITE }))
      const gr = okId(setup('O1', 'role_create', { pos: 6, bits: ROLES | INVITE }))
      const sr = okId(setup('O1', 'role_create', { pos: 9, bits: KICK | BAN }))
      const br = okId(setup('O1', 'role_create', { pos: 1 + rng.int(3), bits: INVITE }))
      if (!kr || !gr || !sr || !br) break
      for (const x of ['Aa', 'Bb', 'Gg', 'Ss']) {
        setup('O1', 'add', { to: x })
        act(`${x}1`, 'join')
      }
      setup('O1', 'assign', { to: 'Gg', role: gr })
      setup('O1', 'assign', { to: 'Ss', role: sr })
      setup('O1', 'assign', { to: 'Bb', role: br })
      const H0 = w.heads()
      const g = okId(act('Gg1', 'assign', { to: 'Aa', role: kr }, { ap: H0 }))
      if (!g) break
      const fa = okId(act('Aa1', 'add', { to: 'N' }, { ap: [g] }))
      const fb = okId(act('Bb1', 'add', { to: 'N' }, { ap: H0 }))
      if (!fa || !fb) break
      const u = okId(act('Aa1', 'uninvite', { to: 'N' }, { ap: [fa, fb] }))
      if (rng.chance(0.5)) act('N1', 'join', {}, { ap: [rng.chance(0.5) ? fa : fb] })
      if (u && rng.chance(0.5))
        act(
          'O1',
          'assign',
          { to: 'Aa', role: okId(setup('O1', 'role_create', { pos: 12, bits: 0 })) ?? sr },
          { ap: [u] }
        )
      act('Ss1', rng.chance(0.7) ? 'kick' : 'ban', { to: 'Gg' }, { ap: H0 })
      act('Ss1', rng.chance(0.7) ? 'kick' : 'ban', { to: 'Bb' }, { ap: H0 })
      act('O1', 'mark')
      break
    }
    case 'i5-rejoin': {
      // (seed 91,025,433) a member N let in by a junior
      // inviter U holds a role the owner gave it; a senior moderator A kicks U from before U's invite, so the cascade
      // cuts N's join though nobody removed N. N is invited again; a moderator B (mostly ranked below N's old role, or A)
      // bans or uninvites N while it is pending, and N's rejoin races it (seen or not). Sometimes N had an earlier
      // membership through the owner's add that it left (two joins: the first stays live); sometimes the role is given
      // only concurrently with the rejoin (in the old membership), or again after it. A role is held only through the
      // membership it was given in (Holds), so the rejoin is judged at ⊥ (G5, G6; O5-senior, O6-lift, O4-holds)
      if (mem.length < 2) break
      const [ma, mb] = rng.shuffle(mem).slice(0, 2)
      const ra = okId(
        setup('O1', 'role_create', { pos: 8 + rng.int(2), bits: KICK | BAN | INVITE })
      )
      const rb = okId(
        setup('O1', 'role_create', {
          pos: 2 + rng.int(2),
          bits: KICK | BAN | (rng.chance(0.3) ? INVITE : 0),
        })
      )
      const ru = okId(setup('O1', 'role_create', { pos: 1, bits: INVITE }))
      const rn = okId(
        setup('O1', 'role_create', {
          pos: rng.chance(0.75) ? 5 + rng.int(2) : 1 + rng.int(3),
          bits: rng.chance(0.3) ? KICK : 0,
        })
      )
      if (!ra || !rb || !ru || !rn) break
      setup('O1', 'assign', { to: ma, role: ra })
      setup('O1', 'assign', { to: mb, role: rb })
      setup('O1', 'add', { to: 'U' })
      if (!okId(setup('U1', 'join'))) break
      setup('O1', 'assign', { to: 'U', role: ru })
      // an earlier membership of N through the owner's add, which N left
      if (rng.chance(0.4)) {
        setup('O1', 'add', { to: 'N' })
        if (okId(setup('N1', 'join'))) setup('N1', 'leave')
      }
      const P5 = w.heads().slice(0, LIM.ap)
      const ad = okId(setup('U1', 'add', { to: 'N' }, { ap: P5 }))
      if (!ad) break
      const j1 = okId(setup('N1', 'join', {}, { ap: [ad] }))
      if (!j1) break
      const early = rng.chance(0.7)
      if (early) setup('O1', 'assign', { to: 'N', role: rn }, { ap: [j1] })
      if (rng.chance(0.3)) setup('N1', 'mark', {}, { ap: [j1] })
      if (!okId(setup(`${ma}1`, 'kick', { to: 'U' }, { ap: P5 }))) break
      if (!okId(setup(rng.chance(0.5) ? `${ma}1` : 'O1', 'add', { to: 'N' }))) break
      const at5 = w.heads().slice(0, LIM.ap)
      // the role given in the old membership, concurrently with the re-invite, the deny and the rejoin
      if (!early && rng.chance(0.6)) setup('O1', 'assign', { to: 'N', role: rn }, { ap: [j1] })
      const banner = rng.chance(0.75) ? `${mb}1` : `${ma}1`
      const deny = () =>
        setup(banner, rng.chance(0.75) ? 'ban' : 'uninvite', { to: 'N' }, { ap: at5 })
      const u5 = rng.next()
      let j5: string | undefined
      if (u5 < 0.45) {
        if (rng.chance(0.85)) deny()
        j5 = okId(setup('N1', 'join', {}, { ap: at5 }))
      } else if (u5 < 0.8) {
        j5 = okId(setup('N1', 'join', {}, { ap: at5 }))
        deny()
      } else {
        j5 = okId(setup('N1', 'join', {}, { ap: at5 }))
        if (rng.chance(0.5)) setup(banner, 'ban', { to: 'N' })
      }
      // the owner gives the role again after the rejoin (concurrent with the deny: a senior's promotion protects)
      if (j5 && rng.chance(0.3)) setup('O1', 'assign', { to: 'N', role: rn }, { ap: [j5] })
      if (j5 && rng.chance(0.3)) setup('N1', 'mark', {}, { ap: [j5] })
      break
    }
    case 'nm-rejoin': {
      // invite consumption: N joins through B's invite, leaves, and joins again through C's invite (citing both);
      // a senior removes B and/or C, or N, at one stratum; cutting N's first join frees the invite it consumed.
      for (const r of [...w.state().facts.roles]) setup('O1', 'role_del', { role: r })
      const sr = okId(setup('O1', 'role_create', { pos: 6, bits: KICK | BAN }))
      const ir = okId(
        setup('O1', 'role_create', {
          pos: 1 + rng.int(3),
          bits: INVITE | (rng.chance(0.3) ? KICK : 0),
        })
      )
      if (!sr || !ir) break
      for (const x of ['Bb', 'Cc', 'Ss']) {
        setup('O1', 'add', { to: x })
        act(`${x}1`, 'join')
      }
      setup('O1', 'assign', { to: 'Ss', role: sr })
      setup('O1', 'assign', { to: 'Bb', role: ir })
      setup('O1', 'assign', { to: 'Cc', role: ir })
      const H0 = w.heads()
      const g1 = okId(act('Bb1', 'add', { to: 'N' }))
      const j1 = g1 ? okId(act('N1', 'join')) : undefined
      if (!j1) break
      const H1 = w.heads()
      act('N1', 'leave')
      const g2 = okId(act('Cc1', 'add', { to: 'N' }))
      const j2 = g2 ? okId(act('N1', 'join')) : undefined
      if (j2 && rng.chance(0.6)) {
        act('N1', 'add', { to: 'M' })
        act('M1', 'join')
      }
      const tgts = rng.shuffle(['Bb', 'Cc', 'N']).slice(0, 1 + rng.int(3))
      for (const x of tgts)
        act('Ss1', rng.chance(0.6) ? 'kick' : 'ban', { to: x }, { ap: x === 'N' ? H1 : H0 })
      if (rng.chance(0.4)) act('Bb1', 'uninvite', { to: 'N' }, { ap: [g1!] })
      act('O1', 'mark')
      break
    }
    case 'nm-pos': {
      // the stratified Pos register's tie-break: two equal movers raise a held role concurrently (the lower
      // position wins the tie), a senior raises it further after one of them; the holder acts with that rank; a top
      // moderator removes some of the movers at one stratum, so cutting more writes can raise the role again.
      for (const r of [...w.state().facts.roles]) setup('O1', 'role_del', { role: r })
      const R = okId(setup('O1', 'role_create', { pos: 2, bits: ROLES | KICK }))
      const mv = okId(setup('O1', 'role_create', { pos: 10, bits: ROLES }))
      const sv = okId(setup('O1', 'role_create', { pos: 15, bits: ROLES }))
      const qv = okId(setup('O1', 'role_create', { pos: 20, bits: KICK | BAN }))
      const tg = okId(setup('O1', 'role_create', { pos: 3, bits: 0 }))
      if (!R || !mv || !sv || !qv || !tg) break
      for (const x of ['Ma', 'Mb', 'Sv', 'Qv', 'Hh', 'Tt']) {
        setup('O1', 'add', { to: x })
        act(`${x}1`, 'join')
      }
      for (const [x, r] of [
        ['Ma', mv],
        ['Mb', mv],
        ['Sv', sv],
        ['Qv', qv],
        ['Hh', R],
        ['Tt', tg],
      ] as [string, string][])
        setup('O1', 'assign', { to: x, role: r })
      const H0 = w.heads()
      const w1 = okId(act('Ma1', 'role_move', { role: R, pos: 4 + rng.int(2) }, { ap: H0 }))
      const w2 = okId(act('Mb1', 'role_move', { role: R, pos: 3 + rng.int(2) }, { ap: H0 }))
      const w4 =
        w1 && rng.chance(0.7)
          ? okId(act('Sv1', 'role_move', { role: R, pos: 7 + rng.int(3) }, { ap: [w1] }))
          : undefined
      const tip = [w1, w2, w4].filter((x): x is string => !!x)
      if (!tip.length) break
      const t = rng.pick(['kick', 'assign', 'revoke', 'role_bits'] as const)
      if (t === 'kick') act('Hh1', 'kick', { to: 'Tt' }, { ap: tip })
      else if (t === 'assign')
        act(
          'Hh1',
          'assign',
          { to: 'Tt', role: okId(setup('O1', 'role_create', { pos: 3, bits: 0 })) ?? tg },
          { ap: tip }
        )
      else if (t === 'revoke') act('Hh1', 'revoke', { to: 'Tt', role: tg }, { ap: tip })
      else act('Hh1', 'role_bits', { role: tg, bit: KICK, on: true }, { ap: tip })
      for (const x of rng.shuffle(['Ma', 'Mb', 'Sv']).slice(0, 1 + rng.int(3)))
        act('Qv1', 'kick', { to: x }, { ap: H0 })
      act('O1', 'mark')
      break
    }
    case 'big-stratum': {
      // many same-stratum causes (strata above the oracle's enumeration bound are checked lazily): 6–14 moderators
      // sharing one role each remove a member who posted an ACL event, plus a senior stepping a held role down several
      // times with the holder acting after each step (one stratum per step), and promotions concurrent with some removals.
      for (const r of [...w.state().facts.roles]) setup('O1', 'role_del', { role: r })
      const qr = okId(setup('O1', 'role_create', { pos: 4, bits: KICK | BAN }))
      const hr = okId(setup('O1', 'role_create', { pos: 8, bits: 0 }))
      const ladder = rng.chance(0.5)
        ? okId(setup('O1', 'role_create', { pos: 7, bits: ROLES | KICK }))
        : undefined
      const sv = ladder ? okId(setup('O1', 'role_create', { pos: 9, bits: ROLES })) : undefined
      if (!qr || !hr) break
      // half the cases have 13-16 moderators, so the stratum has more than 12 causes (the
      // owner's assignments are acknowledged every few, else W3(b) stops them at 12 and no stratum passed 12 causes)
      const nm = rng.chance(0.5) ? 13 + rng.int(4) : 6 + rng.int(9)
      const mods = Array.from({ length: nm }, (_, i) => `q${i}x`)
      const vic = Array.from({ length: nm }, (_, i) => `v${i}x`)
      for (const x of [...mods, ...vic]) {
        setup('O1', 'add', { to: x })
        act(`${x}1`, 'join')
      }
      mods.forEach((m, i) => {
        setup('O1', 'assign', { to: m, role: qr })
        if (i % 4 === 3) setup('Vb1', 'mark')
      })
      if (ladder && sv) {
        setup('O1', 'add', { to: 'Ll' })
        act('Ll1', 'join')
        setup('O1', 'assign', { to: 'Ll', role: ladder })
        setup('O1', 'add', { to: 'Ss' })
        act('Ss1', 'join')
        setup('O1', 'assign', { to: 'Ss', role: sv })
      }
      const H0 = w.heads()
      const ops = vic.map(v =>
        okId(
          act(
            `${v}1`,
            rng.pick(['mark', 'profile', 'add'] as T[]),
            { name: 1, to: `${v}n` },
            { ap: H0 }
          )
        )
      )
      const causes: string[] = []
      mods.forEach((m, i) => {
        const c = okId(act(`${m}1`, rng.chance(0.8) ? 'kick' : 'ban', { to: vic[i] }, { ap: H0 }))
        if (c) causes.push(c)
      })
      for (let i = 0; i < 3; i++) {
        const v = rng.pick(vic),
          o2 = ops[vic.indexOf(v)]
        const sub = causes.filter(() => rng.chance(0.5))
        if (o2)
          act(i % 2 ? 'O1' : 'O2', 'assign', { to: rng.pick(vic), role: hr }, { ap: [o2, ...sub] })
      }
      if (ladder && sv)
        for (let s = 0, pos = 6; s < 2 + rng.int(4) && pos > 0; s++, pos--) {
          if (!okId(act('Ss1', 'role_move', { role: ladder, pos }))) break
          act('Ll1', 'kick', { to: rng.pick(vic) })
        }
      break
    }
    case 'c2-withdraw': {
      // an inviter (plain, ranked, with or without Kick) undoes a settled join by a backdated withdrawal, a
      // backdated leave from a second device, or a ban of the invitee positioned before its join.
      if (!mem.length) break
      const x = rng.pick(mem)
      if (rng.chance(0.5)) {
        const r = okId(
          setup('O1', 'role_create', {
            pos: 1 + rng.int(4),
            bits: INVITE | (rng.chance(0.5) ? KICK : 0) | (rng.chance(0.3) ? BAN : 0),
          })
        )
        if (r) setup('O1', 'assign', { to: x, role: r })
      }
      const P0 = w.heads()
      const viaCode = rng.chance(0.3)
      let cid: string | undefined, add: string | undefined
      if (viaCode) {
        cid = okId(act(`${x}1`, 'code', { h: `h${rng.int(3)}` }))
        add = cid ? okId(act(rng.pick(['O1', `${x}1`]), 'add', { to: 'N', code: cid })) : undefined
      } else add = okId(act(`${x}1`, 'add', { to: 'N' }))
      if (!add) break
      const jn = okId(act('N1', 'join', {}, { ap: [add] }))
      if (rng.chance(0.6)) {
        act('N1', 'add', { to: 'M' })
        act('M1', 'join')
      }
      if (rng.chance(0.5)) act('O1', 'mark')
      const u = rng.next()
      if (u < 0.4) act(`${x}1`, 'uninvite', { to: 'N' }, { ap: [add] })
      else if (u < 0.55 && cid)
        act(`${x}1`, 'code_revoke', { code: cid, h: w.ref.ev(cid).c.h }, { ap: [add] })
      else if (u < 0.75 && devsOf.get(x)!.length > 1) act(`${x}2`, 'leave', {}, { ap: P0 })
      else if (jn) {
        const y = rng.pick(mem.filter(i => i !== x).concat(['O']))
        act(`${y}1`, 'ban', { to: 'N' }, { ap: w.ref.ev(jn).ap })
      }
      break
    }
    case 'c3-thief': {
      // a stolen second device plants a backdated op where its identity ranked higher, the thief forks the
      // identity chain by replaying the device's introduction, and the identity recovers (revoke or rotation).
      const x = mem.find(i => devsOf.get(i)!.length > 1)
      if (!x) break
      const intro = w.ref.order.find(
        id => w.ref.ev(id).t === 'device_add' && w.ref.ev(id).dev === `${x}2`
      )
      const jx = joins.get(x)
      if (!intro || !jx) break
      const hr = okId(
        setup('O1', 'role_create', { pos: 6 + rng.int(3), bits: rng.chance(0.5) ? INVITE : 0 })
      )
      if (hr) setup('O1', 'assign', { to: x, role: hr })
      const P = w.heads()
      if (hr && rng.chance(0.6)) setup('O1', 'revoke', { to: x, role: hr })
      const Q = w.heads()
      const legit = w.latestOwn(`${x}2`)!.seq
      const t = rng.pick(['add', 'add', 'ban', 'assign', 'mark'] as T[])
      const c =
        t === 'add'
          ? { to: 'N' }
          : t === 'ban'
            ? { to: rng.pick(['Z', ...mem.filter(i => i !== x)]) }
            : t === 'assign'
              ? {
                  to: rng.pick(mem.filter(i => i !== x).concat(['N'])),
                  role: hr ?? rng.pick(roles()),
                }
              : {}
      const planted = okId(act(`${x}2`, t, c, { ap: P }))
      if (planted && t === 'add') act('N1', 'join', {}, { ap: [planted] })
      if (rng.chance(0.7)) {
        act(`${x}2`, 'device_add', {}, { ap: [jx], seq: 40 + rng.int(20), aprev: null, iprev: jx })
        replayed = true
      }
      if (rng.chance(0.5)) act('O1', 'mark')
      const rot = rng.chance(0.5)
      const onHeads = rng.chance(0.3)
      const seenTo = onHeads ? (w.latestOwn(`${x}2`)?.seq ?? legit) : legit
      const keep: string[] = []
      if (rot)
        act(
          `${x}1`,
          'primary_rotate',
          { keep, seen: { [`${x}2`]: seenTo }, pcert: 'rec' },
          onHeads ? {} : { ap: Q }
        )
      else act(`${x}1`, 'device_revoke', { dev: `${x}2`, seen: seenTo }, onHeads ? {} : { ap: Q })
      if (rng.chance(0.5)) act(`${x}2`, 'mark', {}, { ap: P }) // the thief keeps going from the old position
      break
    }
    case 'c4-upgrade': {
      // an owner's second device posts an upgrade from a position before the co-owner joined.
      if (owners.length < 2 || devsOf.get('O')!.length < 2) break
      const o2 = w.ref.order.find(id => w.ref.ev(id).dev === 'O2')
      if (!o2) break
      const sigs = rng.chance(0.5) ? [] : owners.filter(x => x !== 'O')
      act(
        'O2',
        'upgrade',
        {
          g: `G${rng.int(3)}`,
          sigs: rules3 ? Object.fromEntries([...sigs, 'O'].map(o => [o, {}])) : sigs,
        },
        { ap: [o2] }
      )
      break
    }
    case 'i1-grab': {
      // a member copies a published code hash into its own code at an older position and revokes that copy.
      if (!mem.length) break
      const x = rng.pick(mem)
      const P0 = w.heads()
      const issuer = rng.pick(['O1', ...mem.filter(i => i !== x).map(i => `${i}1`)])
      const h = `h${rng.int(3)}`
      const vc = okId(act(issuer, 'code', { h }))
      if (!vc) break
      const add = okId(act(rng.pick(['O1', issuer]), 'add', { to: 'N', code: vc }))
      if (add) act('N1', 'join', {}, { ap: [add] })
      const ac = okId(act(`${x}1`, 'code', { h }, { ap: P0 }))
      if (ac) act(`${x}1`, 'code_revoke', { code: rng.chance(0.8) ? ac : vc, h }, { ap: [ac] })
      break
    }
    case 'i2-burst': {
      // others keep the server busy for several windows; an idle member then replays the
      // elapsed ts range, citing a fixed old position or the newest honest event at or before each ts (anchor-shopping);
      // or, on a quiet server, the owner or a member posts spaced events with no other author.
      if (!mem.length) break
      const x = rng.pick(mem)
      const jx = joins.get(x)
      if (!jx) break
      const mode = rng.pick(['fixed', 'shop', 'shop', 'quiet'] as const)
      if (mode === 'quiet') {
        const d = rng.chance(0.5) ? 'O1' : `${x}1`
        let t = Math.max(...w.ref.order.map(id => w.ref.ev(id).ts))
        for (let i = 0; i < 14; i++)
          act(
            d,
            rng.chance(0.5) ? 'mark' : 'profile',
            { name: i % 3 },
            { ts: (t += 10 + rng.int(20)) }
          )
        break
      }
      const busy = ['O1', ...others.filter(i => i !== x).map(i => `${i}1`)]
      let t0 = Math.max(...w.ref.order.map(id => w.ref.ev(id).ts))
      const honest: { id: string; ts: number }[] = []
      for (let i = 0; i < 8; i++)
        for (const d of busy) {
          const r = act(d, 'profile', { name: i % 3 }, { ts: (t0 += 6) })
          if (r.v.s === 'A') honest.push({ id: r.e.id, ts: r.e.ts })
        }
      let ts = w.ref.ev(jx).ts + 2
      for (let i = 0; i < 16; i++, ts += 3) {
        const anchor = mode === 'shop' ? [...honest].reverse().find(h => h.ts <= ts)?.id : undefined
        act(`${x}1`, rng.chance(0.5) ? 'mark' : 'x_future', {}, { ap: [anchor ?? jx], ts })
      }
      break
    }
    case 'i2-breadth': {
      // a moderator bans principals nobody has seen and members at one ts; an identity rotates and churns
      // devices (no-op rotations are refused, W6; rotations and device_adds are capped per identity, W3(c)).
      const ts = Math.max(...w.ref.order.map(id => w.ref.ev(id).ts)) + 1
      const modDev = rng.pick([
        'O1',
        ...mem.filter(i => perms(w.state().facts, i) & BAN).map(i => `${i}1`),
      ])
      for (let i = 0; i < 6; i++)
        act(
          modDev,
          'ban',
          { to: rng.chance(0.6) ? `s${rng.int(9)}` : rng.pick([...mem, 'N']) },
          { ts }
        )
      if (mem.length) {
        const x = rng.pick(mem)
        for (let i = 0; i < 5; i++) {
          const ds = devsOf.get(x)!
          const keep = ds.filter(d => d !== `${x}1` && rng.chance(0.6))
          act(`${x}1`, 'primary_rotate', {
            keep,
            seen: {},
            ...(rng.chance(0.5) ? { pcert: `p${i}` } : {}),
          })
        }
        for (let i = 3; i < 7; i++) {
          const r = act(`${x}${i}`, 'device_add')
          if (r.v.s === 'A' && rng.chance(0.8))
            act(`${x}1`, 'device_revoke', { dev: `${x}${i}`, seen: r.e.seq })
        }
      }
      break
    }
    case 'g-intro': {
      replayed = true // deliberate evidence: identity forks, contested rotations, pool overflow
      // a member (removed or not) posts concurrent fresh-device introductions at one position (device_adds,
      // rotations, or joins through its consumed add), each with a few marks; then it may try to pin two of them by
      // citing both (W3(f)), and a deceived member may witness one in good faith.
      if (!mem.length) break
      const x = rng.pick(mem)
      const P = w.heads()
      if (rng.chance(0.6)) setup('O1', 'kick', { to: x })
      const kind = rng.pick(['device_add', 'primary_rotate', 'join'] as const)
      const addX = w.ref.order.find(id => w.ref.ev(id).t === 'add' && w.ref.ev(id).c?.to === x)
      if (kind === 'join' && !addX) break
      let ts = Math.max(...w.ref.order.map(id => w.ref.ev(id).ts)) + 1
      const intros: string[] = []
      for (let i = 0; i < 2 + rng.int(4); i++) {
        const dev = `${x}${10 + i}`
        const seen: Record<string, number> = {}
        for (const id of w.closure(P)) {
          const y = w.ref.ev(id)
          if (y.a === x) seen[y.dev] = Math.max(seen[y.dev] ?? -1, y.seq)
        }
        const r =
          kind === 'device_add'
            ? act(dev, 'device_add', {}, { ap: P, ts: (ts += 11) })
            : kind === 'primary_rotate'
              ? act(
                  dev,
                  'primary_rotate',
                  { keep: [], seen, pcert: `g${i}` },
                  { ap: P, seq: 0, ts: (ts += 11) }
                )
              : act(dev, 'join', {}, { ap: [addX!], ts: (ts += 11) })
        if (r.v.s !== 'A') continue
        intros.push(dev)
        for (let m = 0; m < 1 + rng.int(4); m++)
          act(dev, 'mark', {}, { ap: [w.latestOwn(dev)!.id], ts: (ts += 11) })
      }
      if (intros.length >= 2 && rng.chance(0.5))
        act(
          `${x}1`,
          'mark',
          {},
          { ap: [w.latestOwn(intros[0])!.id, w.latestOwn(intros[1])!.id], ts: (ts += 11) }
        )
      const wit = mem.filter(i => i !== x)
      if (intros.length && wit.length && rng.chance(0.4))
        act(
          `${rng.pick(wit)}1`,
          'mark',
          {},
          { ap: [w.latestOwn(rng.pick(intros))!.id], ts: (ts += 11) }
        )
      break
    }
    case 'g-tree': {
      replayed = true // deliberate evidence: identity forks, contested rotations, pool overflow
      // at each position of its identity chain a member posts a rotation child and a device_add child (a race:
      // one iprev), each from a fresh device with 0–2 marks, down to the per-view caps; removed or not.
      if (!mem.length) break
      const x = rng.pick(mem)
      if (rng.chance(0.6)) setup('O1', 'kick', { to: x })
      let n = 30,
        ts = Math.max(...w.ref.order.map(id => w.ref.ev(id).ts)) + 1,
        budget = 10
      const grow = (tip: string[], adds: number, rots: number) => {
        for (const kind of rng.shuffle(['rot', 'add'] as const)) {
          if (
            budget <= 0 ||
            (kind === 'rot' ? rots >= LIM.rotTot : adds >= LIM.freshCap) ||
            rng.chance(0.25)
          )
            continue
          const dev = `${x}${n++}`
          const seen: Record<string, number> = {}
          for (const id of w.closure(tip)) {
            const y = w.ref.ev(id)
            if (y.a === x) seen[y.dev] = Math.max(seen[y.dev] ?? -1, y.seq)
          }
          const r =
            kind === 'add'
              ? act(dev, 'device_add', {}, { ap: tip, ts: (ts += 11) })
              : act(
                  dev,
                  'primary_rotate',
                  { keep: [], seen, pcert: `t${dev}` },
                  { ap: tip, seq: 0, ts: (ts += 11) }
                )
          if (r.v.s !== 'A') continue
          budget--
          for (let i = 0; i < rng.int(3); i++)
            act(dev, 'mark', {}, { ap: [w.latestOwn(dev)!.id], ts: (ts += 11) })
          grow(
            [w.latestOwn(dev)!.id],
            adds + (kind === 'add' ? 1 : 0),
            rots + (kind === 'rot' ? 1 : 0)
          )
        }
      }
      const tip0 = w.latestOwn(`${x}1`)
      if (tip0) grow([tip0.id], 0, 0)
      break
    }
    case 'g-pool': {
      replayed = true // deliberate evidence: identity forks, contested rotations, pool overflow
      // the identity pool. A member's devices revoked while it was a member post from their old tips (citing the
      // owner's acknowledgement of the tip or not), round-robin, past the pool; it may be removed first; it may try to
      // merge the chains in one view (W3(g) refuses above poolU), and a deceived member may acknowledge one chain. Or the
      // honest cost: a device offline at an old position while its sibling posts many acknowledged events.
      if (!mem.length) break
      const x = rng.pick(mem)
      if (rng.chance(0.35) && devsOf.get(x)!.length > 1 && w.latestOwn(`${x}2`)) {
        const P = w.heads()
        let ts = Math.max(...w.ref.order.map(id => w.ref.ev(id).ts)) + 1
        for (let k = 0; k < LIM.poolU - 6 + rng.int(12); k++) {
          act(`${x}1`, 'mark', {}, { ts: (ts += 11) })
          if (k % 4 === 3) act('O1', 'mark', {}, { ts: (ts += 1) })
        }
        for (let k = 0; k < 1 + rng.int(3); k++)
          act(
            `${x}2`,
            rng.chance(0.5) ? 'mark' : 'profile',
            { name: k % 3 },
            { ap: k ? [w.latestOwn(`${x}2`)!.id] : P, ts: (ts += 11) }
          )
        break
      }
      const olds: { dev: string; ack?: string }[] = []
      if (devsOf.get(x)!.length > 1 && w.latestOwn(`${x}2`)) {
        const ack = okId(setup('O1', 'mark'))
        if (
          setup(`${x}1`, 'device_revoke', { dev: `${x}2`, seen: w.latestOwn(`${x}2`)!.seq }).v.s ===
          'A'
        )
          olds.push({ dev: `${x}2`, ack })
      }
      for (let i = 0; i < 1 + rng.int(4); i++) {
        const dev = `${x}${5 + i}`
        clock += LIM.day // W3(c): a few device_adds per identity per day; old devices accumulate over days
        if (setup(dev, 'device_add').v.s !== 'A') break
        setup(dev, 'mark')
        const ack = okId(setup('O1', 'mark'))
        if (setup(`${x}1`, 'device_revoke', { dev, seen: w.latestOwn(dev)!.seq }).v.s === 'A')
          olds.push({ dev, ack })
        setup('O1', 'mark')
      }
      if (!olds.length) break
      if (rng.chance(0.6)) setup('O1', 'kick', { to: x })
      let ts = Math.max(...w.ref.order.map(id => w.ref.ev(id).ts)) + 1
      const per = rng.chance(0.5) ? LIM.totU : 2 + rng.int(LIM.totU)
      const cite = rng.chance(0.7)
      for (let k = 0; k < per; k++)
        for (const o of olds) {
          const tip = w.latestOwn(o.dev)!.id
          act(
            o.dev,
            rng.chance(0.8) ? 'mark' : 'profile',
            { name: k % 3 },
            { ap: cite && o.ack ? [tip, o.ack] : [tip], ts: (ts += 11) }
          )
        }
      if (olds.length > 1 && rng.chance(0.4))
        act(`${x}1`, 'mark', {}, { ap: olds.map(o => w.latestOwn(o.dev)!.id), ts: (ts += 11) })
      const wit = mem.filter(i => i !== x)
      if (wit.length && rng.chance(0.3))
        act(
          `${rng.pick(wit)}1`,
          'mark',
          {},
          { ap: [w.latestOwn(rng.pick(olds).dev)!.id], ts: (ts += 11) }
        )
      break
    }
    case 'h2-gossip': {
      // the second head-path case: members post non-causes (marks, profiles, adds, assigns, codes)
      // from partial views of each other's recent events, so most arrivals have concurrent events; now and then a deny or
      // a promotion lands among them (a concurrent cause, or a concurrent grant that changes a decision in an arrival's
      // past, which the agreement test must catch)
      const posters = ['O', ...mem]
      let ts = Math.max(...w.ref.order.map(id => w.ref.ev(id).ts)) + 1
      for (let i = 0, n = 6 + rng.int(10); i < n; i++) {
        const who = rng.pick(posters),
          dev = `${who}${rng.chance(0.8) || devsOf.get(who)!.length < 2 ? 1 : 2}`
        if (!w.latestOwn(dev)) continue
        const recent = w.ref.order.slice(-8)
        const ap = rng.chance(0.3) ? undefined : rng.shuffle(recent).slice(0, 1 + rng.int(3))
        const u = rng.next(),
          rs = roles()
        let t: T = 'mark',
          c: any = {}
        if (u < 0.35) t = 'mark'
        else if (u < 0.55) {
          t = 'profile'
          c = { name: rng.int(3) }
        } else if (u < 0.65 && rs.length) {
          t = 'assign'
          c = { to: rng.pick(posters), role: rng.pick(rs) }
        } else if (u < 0.72) {
          t = 'add'
          c = { to: rng.pick(['N', 'M', 'Z']) }
        } else if (u < 0.78) {
          t = 'code'
          c = { h: `h${rng.int(3)}` }
        } else if (u < 0.86) {
          t = rng.pick(['kick', 'ban'] as T[])
          c = { to: rng.pick(posters) }
        } else if (u < 0.92 && rs.length) {
          t = 'role_move'
          c = { role: rng.pick(rs), pos: rng.int(10) }
        } else if (rs.length) {
          t = 'revoke'
          c = { to: rng.pick(posters), role: rng.pick(rs) }
        }
        act(dev, t, c, ap ? { ap, ts: (ts += 1) } : { ts: (ts += 1) })
      }
      break
    }
    case 'rk-thief':
    case 'rk-newsrv':
    case 'rk-leak':
    case 'rk-legacy':
    case 'rk-rejoin':
    case 'rk-upgrade':
    case 'rk-left': {
      // a protected member P (creation record rkV, epoch-0 primary p0; `ik`
      // never stored). The thief holds what a stolen device holds: its device key and the primary of its epoch, never
      // `ik` (rk-thief, rk-newsrv, rk-rejoin, rk-upgrade), or a leaked old phrase (rk-leak); a legacy identity's thief
      // holds its `ik` (rk-legacy). Every posting of the user's chain records goes
      // through the client model (client.ts: position, poster, keep, signer, link), never through World.act; the thief's
      // events are delivered directly (an accomplice member syncs anything in)
      if (!rules3) break
      let ts = Math.max(...w.ref.order.map(id => w.ref.ev(id).ts)) + 1
      const thief: string[] = []
      const th = (dev: string, t: T, c: any, ap?: string[]) => {
        const r = act(dev, t, c, { ...(ap ? { ap } : {}), ts: (ts += 2) })
        if (r.v.s === 'A') thief.push(r.e.id)
        return okId(r)
      }
      const seenAt = (ap: string[], dev: string) => {
        let m = -1
        for (const id of w.closure(ap)) {
          const e = w.ref.ev(id)
          if (e.dev === dev) m = Math.max(m, e.seq)
        }
        return m
      }
      // watermarks covering every device of identity `a` in the past of `ap` but `skip` (a thief's rotation drops them all)
      const seenAll = (ap: string[] | undefined, a: string, skip: string) => {
        const s: Record<string, number> = {}
        for (const id of w.closure(ap ?? w.heads())) {
          const e = w.ref.ev(id)
          if (e.a === a && e.dev !== skip) s[e.dev] = Math.max(s[e.dev] ?? -1, e.seq)
        }
        return s
      }
      const crD = crDigest('P', 'rkV', 'p0')
      const dropsOf = (r: string | undefined) =>
        r
          ? droppedBy(
              w.ref.ev(r),
              w.ref.order.filter(x => w.ref.anc(r).has(x)),
              w.ref
            )
          : []
      const bystander = () =>
        act(rng.pick(['O1', ...mem.map(m => `${m}1`)]), 'mark', {}, { ts: (ts += 2) })
      // the user's client: its acts are recorded in its log, its postings go through client.ts
      const client = (ik: string, cr: { rk: string; pk: string }, devs: string[]) => {
        const c = new Client(ik, cr, devs)
        c.vouch = (_w, dev, op) => (rng.chance(0.85) ? vouchOp(dev, op) : op)
        c.clock = () => (ts += 2)
        c.wait = n => {
          ts += n
        }
        return c
      }
      // the flow's posting in this server (client.ts `flow`, while the phrase is at hand; mutant `cl-flow-order`), or, once
      // the phrase left memory, the sweep's state-triggered posting
      const posted = (cl: Client, o: any = {}) => (cl.phrase ? cl.flow([w], o) : cl.post(w, o))
      // the rkCase metadata the client adds: its postings in this server (each must have had a link), the recorded leave and the
      // devices its posting dropped there, the upgrades it signed that counted before its postings, and its admitted
      // postings (each must be admitted: O15-join's mustAdmit)
      const cmeta = (cl: Client, extra: string[] = []) => {
        const m = cl.meta(w)
        const adm = m.postings
          .filter(
            p =>
              p.delivered &&
              p.id &&
              !p.bullet.endsWith('-try') &&
              !/^R:W3[ac]$/.test(p.verdict ?? '')
          )
          .map(p => p.id!)
        return {
          postings: m.postings,
          ...(m.leftAt ? { leftAt: m.leftAt, leftDrops: m.leftDrops } : {}),
          keepUp: m.keepUp,
          keepUpAt: w.ref.order.length,
          mustAdmit: [...extra, ...adm],
        }
      }
      if (template === 'rk-legacy') {
        // a legacy member L (no creation record; its ik is hot) whose ik the thief holds: the thief joins at L's add
        // with a creation record it made (rkZ, pZ) or with none, and rotates with its own key; L's ik-signed records void
        // the made-up record, so the thief's rkZ never holds (the void rule). No chain record of the user's: its only
        // posting is its identity-key rotation (through the client's delivery, below)
        const legacy = mem.filter(m => !crOf.has(m))
        if (!legacy.length) break
        const L = rng.pick(legacy)
        const addL = w.ref.order.find(id => w.ref.ev(id).t === 'add' && w.ref.ev(id).c?.to === L)
        if (!addL) break
        const minted = rng.chance(0.7)
        const jz = th(`${L}9`, 'join', minted ? { rk: 'rkZ', pk: 'pZ', by: 'pZ' } : { by: 'ik' }, [
          addL,
        ])
        if (jz && rng.chance(0.6))
          th(
            `${L}9`,
            'primary_rotate',
            minted
              ? { by: 'rkZ', keep: [], seen: {} }
              : { by: 'ik', pcert: 'pT', keep: [], seen: {} },
            [jz]
          )
        if (jz && rng.chance(0.5)) th(`${L}9`, 'mark', {}, [jz])
        if (rng.chance(0.5))
          act(
            rng.pick(['O1', ...mem.filter(m => m !== L).map(m => `${m}1`)]),
            'mark',
            {},
            { ts: (ts += 2) }
          )
        // L's own identity-key rotation from a fresh device, on the heads: valid (L is unprotected; rules-2 signers). No
        // user posting is inserted directly in a template: it is delivered
        // over the link the device's session gets, an ACL-only link (a member's new device certified by `ik`), and
        // O15-link reads it
        const lcl = new Client(L, { rk: '', pk: 'ik' }, [])
        lcl.certs.set(`${L}5`, ['ik'])
        // (as production's `recover` does, only where L is a member: the setup may have banned it, and a banned legacy
        // identity has neither a link nor a chain to push)
        if (rng.chance(0.6) && w.state().facts.mem.has(L))
          lcl.deliver(
            w,
            `${L}5`,
            'primary_rotate',
            {
              by: 'ik',
              pcert: 'pL',
              keep: [],
              seen: Object.fromEntries(
                [`${L}9`]
                  .map(d => [d, seenAt(w.heads().slice(0, LIM.ap), d)])
                  .filter(([, s]) => (s as number) >= 0)
              ),
            },
            { ts: (ts += 2) },
            'legacy'
          )
        rkMeta = {
          kind: template,
          x: L,
          thief,
          thiefDevs: [`${L}9`],
          thiefKeys: ['rkZ', 'pZ'],
          legacy: true,
          postings: lcl.meta(w).postings,
        }
        break
      }
      if (template === 'rk-thief') {
        // the user's recovery inside this server: P joins (P1), adds P2; the thief holds P2 and p0. Before and after the
        // recovery the thief posts p0-signed revocations and certificates, marks from P2, and rotation attempts (it has no
        // recovery key and no new record, so they are refused). The recovery carries chain record 1 (pV1, keep the
        // recovering device); the client posts it on the trusted heads (the heads of the events whose past
        // holds no record of P it didn't make), signed by rkV in the flow or, later, as an extension by pV1; sometimes the
        // user also revokes P2 with the phrase at an old position (the disowning flow), and later resets or removes the key
        // (chain record 2). Sometimes a second device of the user (P6, in the record's keep) posts
        // the same record concurrently, unwitnessed (two carriers); or two recoveries with the same n race (the client that
        // sees both reconciles them with record 2 at their merge, or not yet); or a fresh device certified under pV1 (P7,
        // not in the record's keep) posts it too. After a reset, a thief holding a device certified under pV1 re-posts the
        // records signed by it (refused: the reset installs a new primary; mutant `rk-reset-pk`), or one holding the reset's
        // primary posts it at an old position.
        const cl = client('P', { rk: 'rkV', pk: 'p0' }, ['P1', 'P2'])
        const named = rng.chance(0.5)
        const addId = okId(
          act('O1', 'add', named ? { to: 'P', head: crD } : { to: 'P' }, { ts: (ts += 2) })
        )
        if (!isAdm(addId)) break
        const join = okId(cl.act(w, 'P1', 'join', { rk: 'rkV' }, { ts: (ts += 2) }))
        if (!isAdm(join)) break
        if (rng.chance(0.75)) act('O1', 'mark', {}, { ts: (ts += 2) })
        if (!isAdm(okId(cl.act(w, 'P2', 'device_add', {}, { ts: (ts += 2) })))) break
        if (rng.chance(0.75)) act('O1', 'mark', {}, { ts: (ts += 2) })
        if (rng.chance(0.5)) cl.act(w, 'P1', 'mark', {}, { ts: (ts += 2) })
        const P0 = w.heads().slice(0, LIM.ap)
        cl.lose('P2')
        let tip = P0
        const thP2 = (t: T, c: any) => {
          const id = th('P2', t, c, tip)
          if (id) tip = [id]
          return id
        }
        if (rng.chance(0.4)) thP2('device_revoke', { by: 'p0', dev: 'P1', seen: seenAt(tip, 'P1') })
        if (rng.chance(0.4)) th('P3', 'device_add', { by: 'p0' }, tip)
        if (rng.chance(0.3))
          thP2('primary_rotate', { by: 'p0', keep: [], seen: { P1: seenAt(tip, 'P1') } })
        if (rng.chance(0.5)) thP2(rng.pick(['mark', 'profile'] as T[]), { name: 1 })
        if (rng.chance(0.5)) bystander()
        const rdev = w.state().facts.revoked.has('P1') ? 'P5' : 'P1'
        const mode = rng.next()
        const sib = mode < 0.25 && LIM.devCap >= 2,
          sameN = !sib && mode >= 0.25 && mode < 0.37,
          outKeep = !sib && !sameN && mode >= 0.37 && mode < 0.44
        const ext = rng.chance(0.4)
        let r: string | undefined,
          userRecs: string[] = [],
          dropRecs: any[] = []
        if (!sameN) {
          const rec1 = cl.recover({
            maker: rdev,
            keep: sib ? [rdev, 'P6'] : [rdev],
            pk: 'pV1',
            worlds: [w],
          })
          userRecs = [recDigest(rec1)]
          dropRecs = [rec1]
          if (ext) cl.endFlow() // a later sweep, without the phrase: an extension signed by pV1
          // a second carrier of the same record, from the other device its keep names, at the same position: unwitnessed
          // and concurrent, a sibling; or one from a fresh device certified under pV1 (not in keep: contested,
          // and it contests neither of the user's)
          const res = posted(cl, { race: sib ? 'P6' : outKeep ? cl.certify('P7') : undefined })
          r =
            res.find(x => x.e?.dev === rdev && x.v?.s === 'A')?.e.id ??
            res.find(x => x.v?.s === 'A')?.e.id
          if (sib && res.length > 1 && res[1].v?.s === 'A' && rng.chance(0.6))
            cl.act(w, 'P6', 'mark', {}, { ap: [res[1].e.id], ts: (ts += 2) }) // the user's second device acts
        } else {
          // two recoveries with the same n (two of the user's devices recovered at once, each its own client): both
          // rk-signed, posted by each client at one position
          const cl2 = client('P', { rk: 'rkV', pk: 'p0' }, ['P1', 'P2'])
          for (const id of cl.srv(w).own) cl2.srv(w).own.add(id)
          cl2.lose('P2')
          cl.recover({ maker: rdev, keep: [rdev], pk: 'pVa', worlds: [w] })
          cl2.recover({ maker: 'P6', keep: ['P6'], pk: 'pVb', worlds: [w] })
          const ap = cl.trustedAp(w)
          const xa = cl.post(w, { at: ap })[0],
            xb = cl2.post(w, { at: ap })[0]
          if (xa?.v?.s === 'A' && xb?.v?.s === 'A' && rng.chance(0.7)) {
            // the client that sees both reconciles them: record 2 cites its own, keeps both devices, posted at their merge
            // by the recovery key (the phrase), dropping what neither kept
            cl.srv(w).own.add(xb.e.id)
            cl.certs.set('P6', ['pVb'])
            const r2 = cl.recover({ maker: rdev, keep: [rdev, 'P6'], pk: 'pV2r', worlds: [w] })
            const res = cl.post(w, { at: [xa.e.id, xb.e.id] })
            r = res.find(x => x.v?.s === 'A')?.e.id
            if (r) {
              userRecs = [recDigest(r2)]
              dropRecs = [r2]
            }
          }
        }
        cl.endFlow()
        if (r && rng.chance(0.7)) bystander()
        // the disowning flow with the phrase: an rk-signed revocation of P2 positioned at P0 (the user's
        // own choice in "Lost or stolen device", not a posting of a chain record)
        let disown: string | undefined
        if (r && !sameN && rng.chance(0.25))
          disown = okId(
            cl.act(
              w,
              'P1',
              'device_revoke',
              { by: 'rkV', dev: 'P2', seen: seenAt(P0, 'P2') },
              { ap: P0, ts: (ts += 2) }
            )
          )
        // after the recovery: the thief keeps going from P0 (backdated) and from P2's tip
        if (rng.chance(0.6)) thP2('device_revoke', { by: 'p0', dev: rdev, seen: seenAt(tip, rdev) })
        if (rng.chance(0.4)) th('P4', 'device_add', { by: 'p0' }, P0)
        if (rng.chance(0.5)) thP2('mark', {})
        if (rng.chance(0.3) && r) thP2('primary_rotate', { by: 'p0', keep: [], seen: {} })
        if (rng.chance(0.3) && r) th('P2', 'mark', {}, [r])
        let oldPhrase = false,
          laterPrimary = false
        let stillCut: string[] | undefined
        const thiefKeys = ['p0']
        if (r && !sameN && rng.chance(0.35)) {
          const k = rng.chance(0.6),
            d1 = userRecs[0]
          // a device certified under pV1 after the recovery (the user's; the thief may steal it later)
          const p8 =
            rng.chance(0.5) && LIM.devCap >= 2
              ? okId(cl.act(w, 'P8', 'device_add', { by: 'pV1' }, { ts: (ts += 2) }))
              : undefined
          if (p8) {
            cl.certs.set('P8', ['pV1'])
            bystander()
          }
          // every chain record installs a new primary and names the devices it keeps (a reset too); the client posts it
          const rec2 = cl.recover(
            k
              ? { maker: rdev, keep: [rdev], pk: 'pV2', rk: 'rkV2', worlds: [w] }
              : { maker: rdev, keep: [rdev], pk: 'pV3', rk: '', worlds: [w] }
          )
          void d1
          if (rng.chance(0.5)) cl.endFlow()
          const kc = posted(cl).find(x => x.v?.s === 'A')?.e.id
          cl.endFlow()
          if (kc) userRecs = [...userRecs, recDigest(rec2)]
          // resetting on one device. Another device of the user (P8, certified under pV1), whose
          // app still holds record 1 as the head, starts a reset of its own without fetching the identity's head: the
          // client refuses it ("Reset only on one device."; mutant `cl-reset-unfetched`: it makes a rival reset, and the
          // user's own two resets freeze the identity, which O15-void sees: no phrase leaked)
          if (kc && k && p8 && new Rng(seed * 6007 + 37).chance(0.5)) {
            const cl2 = client('P', { rk: 'rkV', pk: 'p0' }, ['P1', 'P2', 'P8'])
            for (const id of cl.srv(w).own) cl2.srv(w).own.add(id)
            cl2.lose('P2')
            cl2.recs = [dropRecs[0]]
            cl2.maker = 'P8'
            cl2.certs.set('P8', ['pV1'])
            try {
              cl2.recover({
                maker: 'P8',
                keep: ['P8'],
                pk: 'pV9',
                rk: 'rkV9',
                fetched: false,
                worlds: [w],
              })
              for (const x of cl2.flow([w])) if (x.v?.s === 'A') cl.srv(w).own.add(x.e.id)
            } catch {
              /* refused: "Reset only on one device." */
            }
          }
          // the old phrase leaked (why the user reset or removed it): once the key change is held, the thief's records
          // signed with the old phrase, backdated to P0, are inert by key death and contest nothing
          const u2 = rng.next()
          const rec1 = dropRecs[0]
          if (kc && u2 < 0.4) {
            oldPhrase = true
            th(
              'P9',
              'primary_rotate',
              { by: 'rkV', keep: [], seen: { P1: seenAt(P0, 'P1'), P2: seenAt(P0, 'P2') } },
              P0
            )
            th('P2', 'device_revoke', { by: 'rkV', dev: 'P1', seen: seenAt(tip, 'P1') }, tip)
          } else if (kc && p8 && u2 < 0.7) {
            // the thief stole P8 (certified under pV1) and re-posts the records at P0 signed by it: refused, since the
            // head after the reset has its own primary (mutant `rk-reset-pk`: a reset keeps the old primary)
            thiefKeys.push('pV1')
            th(
              'P9',
              'primary_rotate',
              {
                by: 'pV1',
                chain: [rec1, rec2],
                keep: [],
                seen: { P1: seenAt(P0, 'P1'), P2: seenAt(P0, 'P2') },
              },
              P0
            )
          } else if (kc && u2 < 0.85 && LIM.devCap >= 2) {
            // a device certified under the reset's primary is stolen; the thief posts the records at P0 as an
            // extension signed by it, killing the user's earlier records signed by the replaced key (a stated limit until
            // the user notices). Half the time the client sees its own record inert by key death through a
            // carrier it didn't post and repairs it with the phrase (client.ts repairKeyDeath: a new record positioned at
            // the dead record, with its watermarks; mutant `cl-repair-heads`)
            const pk2 = k ? 'pV2' : 'pV3'
            if (isAdm(okId(cl.act(w, 'P7', 'device_add', { by: pk2 }, { ts: (ts += 2) })))) {
              thiefKeys.push(pk2)
              cl.lose('P7')
              const fx = new Rng(seed * 8737 + 31)
              // the stolen P2 acts once more past the watermark of the user's recovery, and a member cites it (the repair
              // must not cover it: mutant `cl-repair-heads`)
              if (fx.chance(0.6)) {
                thP2('mark', {})
                bystander()
              }
              // what the user's records had cut before the thief's carrier (the repair must cut it again: `stillCut`)
              const S0 = w.state()
              const cutBefore = w.ref.order.filter(id => w.ref.ev(id).a === 'P' && S0.tail.has(id))
              th(
                'P9',
                'primary_rotate',
                { by: pk2, chain: [rec1, rec2], keep: [], seen: { P1: seenAt(P0, 'P1'), P2: 1e9 } },
                P0
              )
              // members go on posting before the user notices: they cite what the thief's carrier revived
              if (fx.chance(0.6)) bystander()
              // (after a removal the thief holds the key in force itself: nothing to repair; only after a reset)
              const rp =
                k && fx.chance(0.5)
                  ? cl.repairKeyDeath(w, 'pV4').find(x => x.v?.s === 'A')
                  : undefined
              if (rp) {
                userRecs = cl.recs.map(x => recDigest(x))
                r = rp.e.id
                dropRecs = [cl.head()]
                stillCut = cutBefore
              } else laterPrimary = true
            }
          }
        }
        if (oldPhrase) thiefKeys.push('rkV')
        const rRec = dropRecs[0] ?? { keep: [] }
        rkMeta = {
          kind: template,
          x: 'P',
          V1: rdev,
          V2: 'P2',
          r,
          rDrops: r ? dropsOf(r).filter(d => d !== rdev && !(rRec.keep ?? []).includes(d)) : [],
          thief,
          thiefDevs: ['P3', 'P4', 'P9'],
          thiefKeys,
          userRecs,
          ...(disown ? { disown } : {}),
          ...(laterPrimary ? { laterPrimary } : {}),
          ...(stillCut ? { stillCut } : {}),
          ...cmeta(cl),
        }
        break
      }
      if (template === 'rk-newsrv') {
        // a new server after P recovered elsewhere (chain record 1: pV1, keep its device), or after a phrase-only restore
        // (P5, which never held p0). The thief holds p0 and joins first, or after; the add names P's head (record 1),
        // a stale head (the creation record), or none (a code join, or an inviter without P's card). The client:
        // a pending invite gives a join carrying the chain (at the add, or on the heads of the events without an add
        // naming a head its chain doesn't reach); where the thief's join introduced P first (an older epoch), a rotation
        // positioned at that introduction, signed by rkV or as an extension, and where that is refused, a join beside it at
        // the same add. Sometimes a second device of the user (P6, in the record's keep) posts too (two
        // carriers); sometimes a member's add names a head no chain reaches.
        const restore = rng.chance(0.3)
        const udev = restore ? 'P5' : 'P1'
        const two = rng.chance(0.2) && LIM.devCap >= 2
        const cl = client('P', { rk: 'rkV', pk: 'p0' }, ['P1', 'P2'])
        cl.lose('P2')
        const rec1 = cl.recover({ maker: udev, keep: two ? [udev, 'P6'] : [udev], pk: 'pV1' })
        const d1 = recDigest(rec1)
        const u = rng.next()
        const code = rng.chance(0.3)
          ? okId(act('O1', 'code', { h: 'hP' }, { ts: (ts += 2) }))
          : undefined
        const thiefFirst = rng.chance(0.7)
        // a code redemption: the admitter names the head the redeemer presents (the first redeemer's)
        const head = code ? (thiefFirst ? crD : d1) : u < 0.4 ? d1 : u < 0.6 ? crD : undefined
        const preAdd = w.heads().slice(0, LIM.ap)
        const addId = okId(
          act(
            'O1',
            'add',
            { to: 'P', ...(code ? { code } : {}), ...(head ? { head } : {}) },
            { ts: (ts += 2) }
          )
        )
        if (!isAdm(addId)) break
        // a member's add naming a head no chain reaches, beside the owner's (concurrent with it)
        let bogus = false
        if (!code && mem.length && rng.chance(0.2)) {
          bogus = isAdm(
            okId(
              act(
                `${rng.pick(mem)}1`,
                'add',
                { to: 'P', head: 'kBOGUS' },
                { ap: preAdd, ts: (ts += 2) }
              )
            )
          )
          if (bogus && rng.chance(0.5)) bystander()
        }
        const tdev = rng.chance(0.5) ? 'P2' : 'P8'
        let tj: string | undefined
        const thiefJoin = () => {
          tj = th(tdev, 'join', { rk: 'rkV', by: 'p0' }, [addId!])
        }
        if (thiefFirst) thiefJoin()
        if (tj && rng.chance(0.6)) th(tdev, 'mark', {}, [tj])
        if (tj && rng.chance(0.4)) th('P7', 'device_add', { by: 'p0' }, [tj])
        // the owner takes the thief's join for the user and gives it a role, and the thief kicks a member
        // with it before the user's posting arrives: the posting at the introduction cuts that (mutant `cl-older-heads`)
        const nr = new Rng(seed * 7919 + 29)
        const vic = mem.find(m => w.state().facts.mem.has(m))
        if (tj && vic && nr.chance(0.4)) {
          const Rk = okId(act('O1', 'role_create', { pos: 8, bits: KICK }, { ts: (ts += 2) }))
          if (Rk && isAdm(okId(act('O1', 'assign', { to: 'P', role: Rk }, { ts: (ts += 2) }))))
            th(tdev, 'kick', { to: vic, seen: { [`${vic}1`]: seenAt(w.heads(), `${vic}1`) } })
        }
        if (rng.chance(0.5)) bystander()
        if (rng.chance(0.4)) cl.endFlow()
        const atAdd = !bogus && rng.chance(0.4)
        const adopted = cl.foreignIntro(w)
        const res = posted(cl, {
          join: atAdd ? { ap: [addId!] } : {},
          race: two ? 'P6' : undefined,
        })
        if (!thiefFirst && rng.chance(0.6)) thiefJoin()
        cl.endFlow()
        const r = res.find(x => x.e?.t === 'primary_rotate' && x.v?.s === 'A')?.e.id
        const uj = res.find(x => x.e?.t === 'join' && x.v?.s === 'A')?.e.id
        if (tj && rng.chance(0.5)) th(tdev, 'mark', {}, [tj])
        if (tj && rng.chance(0.3)) th('P6', 'device_add', { by: 'p0' }, [tj])
        if (rng.chance(0.5)) bystander()
        rkMeta = {
          kind: template,
          x: 'P',
          V1: udev,
          r,
          rDrops: r ? dropsOf(r).filter(d => d !== udev && !rec1.keep!.includes(d)) : [],
          thief,
          thiefDevs: uj || r ? [tdev, 'P7', ...(two ? [] : ['P6'])] : [],
          thiefKeys: ['p0'],
          userRecs: [d1],
          ...(uj || r ? { e2e: true } : {}),
          ...(adopted ? { adopted: [adopted] } : {}),
          ...cmeta(cl),
        }
        break
      }
      if (template === 'rk-rejoin') {
        // P was a member (P1, its creation record) with P2 certified by p0. P leaves or
        // an owner kicks it; P2 is stolen; P recovers elsewhere (record 1 keeps P1, or P5 after a phrase-only restore).
        // An owner invites P again (the add names record 1, or nothing). The client recorded its leave or the
        // removal, so its posting goes at that event's parents first (P2 dropped through the
        // leave, the thief's rejoin in Tail); then the user accepts the invite and rejoins, its revocations at the join
        // covering whatever the head doesn't keep. Where its list lost the entry (`lost`: a restore without the
        // list), the rejoin with the revocations at it is the only posting, and where the thief
        // rejoined first with P2 (still a live device of P, through an add that names no head) the client rotates at that
        // join (the older-epoch bullet). ACL_GEN_NOREVOKE turns the revocations off.
        const cl = client('P', { rk: 'rkV', pk: 'p0' }, ['P1', 'P2'])
        const addP = okId(act('O1', 'add', { to: 'P' }, { ts: (ts += 2) }))
        if (!isAdm(addP)) break
        if (!isAdm(okId(cl.act(w, 'P1', 'join', { rk: 'rkV' }, { ts: (ts += 2) })))) break
        act('O1', 'mark', {}, { ts: (ts += 2) })
        if (!isAdm(okId(cl.act(w, 'P2', 'device_add', {}, { ts: (ts += 2) })))) break
        act('O1', 'mark', {}, { ts: (ts += 2) })
        if (rng.chance(0.5)) cl.act(w, 'P1', 'mark', {}, { ts: (ts += 2) })
        const hs = w.heads().slice(0, LIM.ap)
        const leaveIt = rng.chance(0.5)
        const out = leaveIt
          ? cl.leave(w, 'P1', { ts: (ts += 2) })
          : act(
              'O1',
              'kick',
              { to: 'P', seen: { P1: seenAt(hs, 'P1'), P2: seenAt(hs, 'P2') } },
              { ts: (ts += 2) }
            )
        if (out.v.s !== 'A') break
        act('O1', 'mark', {}, { ts: (ts += 2) })
        cl.sync(w)
        cl.lose('P2')
        const restore = rng.chance(0.3)
        const udev = restore ? 'P5' : 'P1'
        const lost = rng.chance(0.35)
        if (lost) cl.srv(w).left = undefined
        const rec1 = cl.recover({ maker: udev, keep: [udev], pk: 'pV1', worlds: [w] })
        const d1 = recDigest(rec1)
        const named = rng.chance(0.5)
        const add2 = okId(
          act('O1', 'add', { to: 'P', ...(named ? { head: d1 } : {}) }, { ts: (ts += 2) })
        )
        if (!isAdm(add2)) break
        let r: string | undefined,
          rDrops: string[] = []
        const thiefFirst = !named && rng.chance(0.4)
        // the thief tries a creation record of its own from a fresh device where P's is known: refused (mutant `rk-two-cr`)
        if (rng.chance(0.3)) th('P8', 'join', { rk: 'rkZ', pk: 'p0', by: 'p0' }, [add2!])
        if (thiefFirst) {
          const tj = th('P2', 'join', {}, [add2!])
          if (tj && rng.chance(0.6)) th('P2', 'mark', {}, [tj])
          if (rng.chance(0.5)) bystander()
        }
        if (rng.chance(0.4)) cl.endFlow()
        // sometimes the client crashes between its join and the revocations at it: the start-up sweep repeats them
        const fr = new Rng(seed * 6967 + 19)
        const crash = fr.chance(0.3)
        cl.crash = crash
        // the client's posting: at the recorded leave or removal; where the list lost it, the rejoin (or, where the thief's
        // rejoin made P a member, a rotation at that join)
        const res = cl.post(w, { join: { ap: [add2!] } })
        cl.crash = false
        if (crash) {
          if (fr.chance(0.5)) th('P2', 'mark', {})
          cl.sweep(w)
        }
        r = res.find(x => x.e?.t === 'primary_rotate' && x.v?.s === 'A')?.e.id
        if (r) rDrops = dropsOf(r).filter(d => d !== udev)
        // with the list: the user accepts the invite and rejoins (its own join; the entry leaves the list)
        if (!lost && r && rng.chance(0.6) && w.state().facts.pending.has('P'))
          cl.join(w, { ap: w.capHeads(udev) })
        cl.endFlow()
        if (rng.chance(0.6)) bystander()
        // the thief from P2 on the heads, after the user's posting
        if (rng.chance(0.6)) th('P2', rng.pick(['mark', 'profile'] as T[]), { name: 3 })
        if (rng.chance(0.3)) th('P2', 'device_add', { by: 'p0' })
        if (rng.chance(0.5)) bystander()
        rkMeta = {
          kind: template,
          x: 'P',
          V1: udev,
          V2: 'P2',
          r,
          rDrops,
          thief,
          thiefDevs: [],
          thiefKeys: ['p0'],
          userRecs: [d1],
          ...cmeta(cl),
        }
        break
      }
      if (template === 'rk-upgrade') {
        if (!crOf.has('O')) break
        const g0 = w.ref.ev(w.ref.order[0]).c?.rks?.O
        const crO =
          typeof g0 === 'string'
            ? { rk: g0, pk: 'p0' }
            : { rk: g0.rk as string, pk: (g0.pk ?? 'p0') as string }
        const cO = crDigest('O', crO.rk, crO.pk)
        if (
          upKind === 'single' ||
          upKind === 'coowner' ||
          upKind === 'left' ||
          upKind === 'sigchain'
        ) {
          // a leaked old phrase after a transfer. The identity X (the single
          // owner O, or the co-owner) resets its phrase (record 1: rkX -> rkX2, a new primary, keeps X1) and the old phrase
          // leaks. The honest transfer u counts (every genesis owner signs G'); X's client then posts the reset in the
          // archived S (on the trusted heads, never before u; `left`: X left S before the transfer, so at the
          // frontier of its recorded leave's parents and u), unless ACL_GEN_NOUPGROT; with `sigchain` X reset before
          // signing and its signature carries the reset (it joins S's chain). The thief holds the old phrase and no device:
          // a rival reset from a fresh device positioned before u (`left`: before X's leave), then acts as X at the rival and
          // on the heads (a role, a kick, its own transfer of a single-owner S, a rejoin). Sometimes
          // the thief's records come first (`first`), on the heads after u or only before u, with a flood of
          // more records on its branch; the client's posting then avoids them (the trusted heads) and comes from a device
          // they don't drop (a fresh one certified under the new primary where the maker is dropped). The stated cost: S
          // revives with X frozen; nothing the thief posts counts (O15-thief, e2e)
          const X = upKind === 'single' ? 'O' : owners[1]
          if (!X || !owners.includes(X)) break
          const crX = X === 'O' ? crO : { rk: crOf.get(X)!, pk: 'p0' }
          const cX = crDigest(X, crX.rk, crX.pk)
          if (X !== 'O' && !w.state().facts.mem.has(X)) break // the co-owner joined in the setup
          const cl = client(X, crX, [`${X}1`])
          for (const id of w.ref.order) if (w.ref.ev(id).a === X) cl.srv(w).own.add(id)
          bystander()
          const P0 = w.heads().slice(0, LIM.ap)
          if (upKind === 'left') {
            if (!isAdm(okId(cl.leave(w, `${X}1`, { ts: (ts += 2) })))) break
            bystander()
          }
          const reset = {
            n: 1,
            prev: cX,
            by: crX.rk,
            rk: `${crX.rk}2`,
            pk: `p${X}2`,
            keep: [`${X}1`],
          }
          const sigs: Record<string, any> = {}
          for (const ow of owners)
            sigs[ow] =
              ow === X && upKind === 'sigchain'
                ? { by: reset.pk, chain: [reset] }
                : { by: ow === 'O' ? crO.pk : 'p0' }
          const G = `G${rng.int(3)}`
          cl.signG(w, G)
          const u = okId(act('O1', 'upgrade', { g: G, sigs }, { ts: (ts += 2) }))
          if (!u) break
          if (X === 'O') cl.srv(w).own.add(u)
          // members leave S as they follow S' (leave is still admitted)
          const lm = mem.filter(m => m !== X)
          if (lm.length && rng.chance(0.4)) act(`${rng.pick(lm)}1`, 'leave', {}, { ts: (ts += 2) })
          const rival = { n: 1, prev: cX, by: crX.rk, rk: 'rkT', pk: 'pT', keep: [`${X}9`] }
          const tseen: Record<string, number> = {}
          for (const v of [`${X}1`, `${X}2`]) {
            const m = seenAt(P0, v)
            if (m >= 0) tseen[v] = m
          }
          // the thief first, on the heads after u (a rotation carrying its rival there is admitted: X is protected and
          // the record is fresh) or only before u, sometimes with more records on its branch
          const first = upKind !== 'sigchain' && rng.chance(0.35)
          let tr: string | undefined
          if (first) {
            const onHeads = rng.chance(0.6)
            tr = th(
              `${X}9`,
              'primary_rotate',
              {
                by: rng.chance(0.5) ? 'rkT' : 'pT',
                chain: [rival],
                keep: [],
                seen: onHeads ? seenAll(undefined, X, `${X}9`) : tseen,
              },
              onHeads ? undefined : P0
            )
            if (tr && onHeads && rng.chance(0.4)) {
              let prev: any = rival,
                key = 'rkT'
              for (let n = 2; n <= 2 + rng.int(3); n++) {
                const rec = {
                  n,
                  prev: recDigest(prev),
                  by: key,
                  rk: `rkT${n}`,
                  pk: `pT${n}`,
                  keep: [`${X}9`],
                }
                if (
                  !th(`${X}9`, 'primary_rotate', {
                    by: `rkT${n}`,
                    chain: [rec],
                    keep: [],
                    seen: seenAll(undefined, X, `${X}9`),
                  })
                )
                  break
                prev = rec
                key = `rkT${n}`
              }
            }
            if (rng.chance(0.5)) bystander()
          }
          const mustAdmit: string[] = []
          if (
            upKind !== 'sigchain' &&
            !(typeof process !== 'undefined' && process.env.ACL_GEN_NOUPGROT)
          ) {
            // the client's posting in the archived S (the reset keeps X1)
            cl.lose(`${X}2`)
            cl.adopt(reset as any, `${X}1`)
            if (rng.chance(0.4)) cl.endFlow()
            for (const x of posted(cl)) if (x.v?.s === 'A') mustAdmit.push(x.e.id)
            cl.endFlow()
            if (rng.chance(0.5)) bystander()
          }
          // the thief: a rival reset of the old phrase from a fresh device, before u (left: before X's leave)
          if (!first)
            tr = th(
              `${X}9`,
              'primary_rotate',
              { by: rng.chance(0.5) ? 'rkT' : 'pT', chain: [rival], keep: [], seen: tseen },
              P0
            )
          if (tr && rng.chance(0.5)) th(`${X}9`, 'role_create', { pos: 6, bits: KICK }, [tr])
          if (rng.chance(0.5)) bystander()
          const victim = lm.find(m => w.state().facts.mem.has(m))
          if (victim && rng.chance(0.7))
            th(`${X}9`, 'kick', {
              to: victim,
              seen: { [`${victim}1`]: seenAt(w.heads(), `${victim}1`) },
            })
          if (rng.chance(0.5)) th(`${X}9`, 'role_create', { pos: 5, bits: KICK })
          if (upKind === 'single') th(`${X}9`, 'upgrade', { g: 'Gt', sigs: { O: { by: 'pT' } } })
          if (upKind === 'left') th(`${X}9`, 'join', {})
          if (rng.chance(0.5)) bystander()
          const cm = cmeta(cl)
          rkMeta = {
            kind: template,
            x: X,
            thief,
            thiefDevs: [`${X}9`],
            thiefKeys: [crX.rk, 'rkT', 'pT', 'rkT2', 'pT2', 'rkT3', 'pT3', 'rkT4', 'pT4'],
            leaked: true,
            userRecs: [recDigest(reset)],
            e2e: true,
            ...(upKind === 'left' ? { leftOut: true } : {}),
            ...cm,
            mustAdmit: [...mustAdmit],
          }
          break
        }
        if (upKind === 'later') {
          // X (the single owner O, or the co-owner Q) signs
          // the transfer u with its epoch-0 primary, then recovers (record 1, a new primary, keeps X1 and X3), as an owner
          // does when it loses a device; its client posts record 1 in the archived S, signed by the recovery key (X is a
          // genesis owner there). A thief steals X3, which holds the current primary and no phrase: it posts an extension
          // carrying record 1 before u (or before the device_add of u's author device), acts as X there (a role, a kick)
          // and, for a single owner, posts its own transfer (before u: disputed with u, the stated residual). Under the
          // rule (model.ts: an upgrade dies only through rk-signed carriers) u keeps counting. The user then sees the
          // records it didn't make and recovers again (record 2, keeping X1 and X4): its client posts record 2 on the
          // trusted heads, concurrent with the thief's extension and transfer, which die by epoch death. Mutants
          // `rk-upg-any-carrier`, `rk-upg-intro-any`
          const X = laterCo ? owners[1] : 'O'
          if (!X || !owners.includes(X)) break
          const crX = X === 'O' ? crO : { rk: crOf.get(X)!, pk: 'p0' }
          if (X !== 'O' && !w.state().facts.mem.has(X)) break
          const cl = client(X, crX, [`${X}1`])
          for (const id of w.ref.order) if (w.ref.ev(id).a === X) cl.srv(w).own.add(id)
          const pX0 = crX.pk
          // u's author device: O1, or O2 (introduced by a device_add signed by pO0)
          const viaAdd = X === 'O' && rng.chance(0.4)
          let da: string | undefined
          const Pg = w.heads().slice(0, LIM.ap)
          if (viaAdd) {
            da = okId(cl.act(w, 'O2', 'device_add', { by: pX0 }, { ts: (ts += 2) }))
            if (!da) break
            bystander()
          }
          const P0 = w.heads().slice(0, LIM.ap)
          const G = `G${rng.int(3)}`
          cl.signG(w, G)
          const sigs: Record<string, any> = {}
          for (const ow of owners) sigs[ow] = { by: ow === 'O' ? crO.pk : 'p0' }
          const u = okId(
            cl.act(w, viaAdd ? 'O2' : 'O1', 'upgrade', { g: G, sigs }, { ts: (ts += 2) })
          )
          if (!u) break
          const lm = mem.filter(m => m !== X)
          if (lm.length && rng.chance(0.4)) act(`${rng.pick(lm)}1`, 'leave', {}, { ts: (ts += 2) })
          // record 1 (a recovery or a reset), keeping X1 and X3; the client posts it
          const resetIt = rng.chance(0.4)
          if (viaAdd && rng.chance(0.5)) cl.lose('O2')
          const rec1 = cl.recover({
            maker: `${X}1`,
            keep: [`${X}1`, `${X}3`, ...(viaAdd && !cl.lost.has('O2') ? ['O2'] : [])],
            pk: `p${X}1`,
            ...(resetIt ? { rk: `${crX.rk}2` } : {}),
            worlds: [w],
          })
          if (rng.chance(0.4)) cl.endFlow()
          const mustAdmit: string[] = []
          for (const x of posted(cl)) if (x.v?.s === 'A') mustAdmit.push(x.e.id)
          cl.endFlow()
          if (rng.chance(0.5)) bystander()
          // the thief steals X3 (pX1, no phrase): an extension carrying record 1 before u or before the device_add
          cl.lose(`${X}3`)
          const pos = viaAdd && rng.chance(0.6) ? Pg : P0
          const ext = th(
            `${X}3`,
            'primary_rotate',
            {
              by: `p${X}1`,
              chain: [rec1],
              keep: [`${X}1`].filter(d =>
                w.ref
                  .evalSet(w.ref.order.filter(id => w.closure(pos).has(id)))
                  .facts.devs.get(X)
                  ?.has(d)
              ),
              seen: Object.fromEntries((viaAdd ? ['O2'] : []).map(d => [d, seenAt(pos, d)])),
            },
            pos
          )
          const tap = ext ? [ext] : undefined
          if (ext && rng.chance(0.7)) th(`${X}3`, 'role_create', { pos: 5, bits: KICK }, tap)
          const victim = lm.find(m => w.state().facts.mem.has(m))
          if (ext && victim && rng.chance(0.7))
            th(
              `${X}3`,
              'kick',
              { to: victim, seen: { [`${victim}1`]: seenAt(tap!, `${victim}1`) } },
              tap
            )
          if (ext && X === 'O' && rng.chance(0.7))
            th(`${X}3`, 'upgrade', { g: 'Gt', sigs: { O: { by: `p${X}1` } } }, tap)
          if (rng.chance(0.3)) th(`${X}3`, 'kick', { to: victim ?? 'B', seen: {} }) // on the heads: refused (S is archived)
          if (rng.chance(0.5)) bystander()
          // the user sees records it didn't make and recovers again (record 2, keeps X1 and X4)
          cl.recover({ maker: `${X}1`, keep: [`${X}1`, `${X}4`], pk: `p${X}2r`, worlds: [w] })
          if (rng.chance(0.4)) cl.endFlow()
          for (const x of posted(cl)) if (x.v?.s === 'A') mustAdmit.push(x.e.id)
          cl.endFlow()
          if (rng.chance(0.5)) bystander()
          const cm = cmeta(cl)
          rkMeta = {
            kind: template,
            x: X,
            thief,
            thiefDevs: [`${X}3`],
            thiefKeys: [`p${X}1`],
            userRecs: cl.recs.map(r => recDigest(r)),
            e2e: true,
            ...cm,
            mustAdmit,
          }
          break
        }
        if (upKind === 'leftstolen') {
          // a co-owner X leaves S (from
          // X1 or X2), before the transfer (in B(u)), concurrently with it, or after it; X signs G' with its epoch-0 primary
          // and O posts u (it counts). X later recovers or resets elsewhere (record 1 keeps X1 and X5, or X5), dropping X2,
          // which is stolen with p0: the thief rejoins as X (an owner needs no invite) and kicks a member, concurrent with u,
          // before or after the client's posting. The client posts at the recorded leave's parents, and where they don't
          // hold u (the upgrade X signed and recorded), at the frontier of those parents and u: u keeps counting (keepUp),
          // X is no member, and nothing the thief posts concurrently with u counts. What the thief placed in B(u) is the
          // stated residual: it is not drawn here
          const X = owners[1]
          if (!X || !w.state().facts.mem.has(X)) break
          const crX = { rk: crOf.get(X)!, pk: 'p0' }
          const cl = client(X, crX, [`${X}1`])
          for (const id of w.ref.order) if (w.ref.ev(id).a === X) cl.srv(w).own.add(id)
          if (
            !w.ref.order.some(id => w.ref.ev(id).dev === `${X}2` && w.ref.admitted(id)) &&
            !isAdm(okId(cl.act(w, `${X}2`, 'device_add', { by: crX.pk }, { ts: (ts += 2) })))
          )
            break
          cl.certs.set(`${X}2`, ['p0'])
          bystander()
          const lvAt = rng.pick(['inbu', 'inbu', 'conc', 'after'] as const)
          const lvDev = rng.chance(0.3) ? `${X}2` : `${X}1`
          const G = `G${rng.int(3)}`
          cl.signG(w, G)
          const sigs: Record<string, any> = { O: { by: crO.pk }, [X]: { by: crX.pk } }
          let Pu: string[], u: string | undefined
          if (lvAt === 'inbu') {
            if (cl.leave(w, lvDev, { ap: w.heads().slice(0, LIM.ap), ts: (ts += 2) }).v.s !== 'A')
              break
            if (rng.chance(0.6)) bystander()
            Pu = w.heads().slice(0, LIM.ap)
            u = okId(act('O1', 'upgrade', { g: G, sigs }, { ap: Pu, ts: (ts += 2) }))
          } else if (lvAt === 'conc') {
            Pu = w.heads().slice(0, LIM.ap)
            u = okId(act('O1', 'upgrade', { g: G, sigs }, { ap: Pu, ts: (ts += 2) }))
            if (cl.leave(w, lvDev, { ap: Pu, ts: (ts += 2) }).v.s !== 'A') break
          } else {
            Pu = w.heads().slice(0, LIM.ap)
            u = okId(act('O1', 'upgrade', { g: G, sigs }, { ap: Pu, ts: (ts += 2) }))
            if (!u) break
            if (cl.leave(w, lvDev, { ap: [u], ts: (ts += 2) }).v.s !== 'A') break
          }
          if (!u || !w.state().facts.upgraded.includes(u)) break
          const lm = mem.filter(m => m !== X)
          if (lm.length && rng.chance(0.4)) act(`${rng.pick(lm)}1`, 'leave', {}, { ts: (ts += 2) })
          const victim = lm.find(
            m =>
              w.state().facts.mem.has(m) ||
              w.ref.evalSet(w.ref.order.filter(id => w.closure(Pu).has(id))).facts.mem.has(m)
          )
          const thiefActs = () => {
            const qMem = w.ref
              .evalSet(w.ref.order.filter(id => w.closure(Pu).has(id)))
              .facts.mem.has(X)
            let at: string[] | undefined = Pu
            if (!qMem) {
              const tj = th(`${X}2`, 'join', { by: crX.pk }, Pu)
              at = tj ? [tj] : undefined
            }
            if (at && victim)
              th(
                `${X}2`,
                'kick',
                { to: victim, seen: { [`${victim}1`]: seenAt(at, `${victim}1`) } },
                at
              )
            if (at && rng.chance(0.5)) th(`${X}2`, 'role_create', { pos: 6, bits: KICK }, at)
          }
          const thiefLate = rng.chance(0.4)
          cl.lose(`${X}2`)
          if (!thiefLate) thiefActs()
          if (rng.chance(0.5)) bystander()
          const reset = rng.chance(0.5)
          cl.recover({
            maker: `${X}5`,
            keep: rng.chance(0.4) ? [`${X}5`] : [`${X}1`, `${X}5`],
            pk: `p${X}r`,
            ...(reset ? { rk: `${crX.rk}2` } : {}),
            worlds: [w],
          })
          if (rng.chance(0.5)) cl.endFlow()
          const res = posted(cl)
          cl.endFlow()
          if (thiefLate) thiefActs()
          if (rng.chance(0.5)) bystander()
          const r = res.find(x => x.v?.s === 'A')?.e.id
          const cm = cmeta(cl)
          rkMeta = {
            kind: template,
            x: X,
            V1: `${X}5`,
            V2: `${X}2`,
            r,
            rDrops: [...(cm.leftDrops ?? [])],
            thief,
            thiefDevs: [`${X}2`],
            thiefKeys: [crX.pk],
            userRecs: cl.recs.map(x => recDigest(x)),
            e2e: true,
            leftOut: true,
            ...cm,
          }
          break
        }
        if (upKind === 'succ') {
          // a successor server. P (protected: rkV, p0) is a member of S
          // with P1, and P2 (certified by p0) is stolen with p0. P recovers in S (record 1 keeps its device) or elsewhere
          // (B(u) lacks it: a stale head). O upgrades S. From here the case's world is S', built from
          // projectMembers(St(u)): the migrate chunk, the carry-over's adds naming each member's heads in B(u), the
          // members' own joins, the user's join with its chain through its carry-over add (the client; it must be admitted:
          // no lockout; where the thief's join introduced P first, the client's rotation at it), and the thief's join
          // holding p0 through P's add, first or after (refused where the add names record 1; where it names the creation
          // record, inert once the user's posting is beside it). Mutant `rk-migrate-mem` (migrate sets membership)
          const cl = client('P', { rk: 'rkV', pk: 'p0' }, ['P1', 'P2'])
          const addP = okId(
            act('O1', 'add', rng.chance(0.5) ? { to: 'P', head: crD } : { to: 'P' }, {
              ts: (ts += 2),
            })
          )
          if (
            !isAdm(addP) ||
            !isAdm(okId(cl.act(w, 'P1', 'join', { rk: 'rkV' }, { ts: (ts += 2) })))
          )
            break
          bystander()
          if (!isAdm(okId(cl.act(w, 'P2', 'device_add', {}, { ts: (ts += 2) })))) break
          bystander()
          cl.lose('P2')
          const udev = rng.chance(0.3) ? 'P5' : 'P1'
          const inS = rng.chance(0.6)
          const rec1 = cl.recover({ maker: udev, keep: [udev], pk: 'pV1' })
          if (inS) {
            if (rng.chance(0.5)) cl.endFlow()
            if (!posted(cl).some(x => x.v?.s === 'A')) break
            cl.endFlow()
            bystander()
          }
          const u = okId(
            act('O1', 'upgrade', { g: 'Gs', sigs: { O: { by: crO.pk } } }, { ts: (ts += 2) })
          )
          if (!u) break
          const entries = projectMembers(w.ref.rec(u).local)
          w = new World()
          ts = 1
          w.genesis('O1', ['O'], 0, 0, {
            rules: 3,
            from: 'S',
            ...(L !== undefined ? { limits: L } : {}),
            rks: { O: { rk: crO.rk, pk: crO.pk } },
          })
          act('O1', 'migrate', { chunk: { kind: 'members', list: entries } }, { ts: (ts += 2) })
          // the carry-over: an add naming each member's heads in B(u), P's first; each member joins before the next add
          // (W5 bounds an owner device's pending invites)
          const addOf = new Map<string, string>()
          const carry = (x: (typeof entries)[number]) => {
            const a2 = okId(
              act(
                'O1',
                'add',
                { to: x.ik, ...(x.heads.length ? { head: x.heads[0] } : {}) },
                { ts: (ts += 2) }
              )
            )
            if (a2) addOf.set(x.ik, a2)
          }
          const pe = entries.find(x => x.ik === 'P')
          if (pe) carry(pe)
          const aP = addOf.get('P')
          const at = aP ? [aP] : undefined
          const thiefFirst = rng.chance(0.5)
          const tdev = rng.chance(0.5) ? 'P2' : 'P8'
          const tj = () => {
            const j = th(tdev, 'join', { rk: 'rkV', by: 'p0' }, at)
            if (j && rng.chance(0.6)) th(tdev, 'mark', {}, [j])
          }
          if (thiefFirst) tj()
          if (rng.chance(0.4)) cl.endFlow()
          const res = posted(cl, { join: at ? { ap: at } : {} })
          cl.endFlow()
          if (!thiefFirst) tj()
          for (const x of entries) {
            if (x.ik === 'P') continue
            carry(x)
            if (addOf.has(x.ik))
              act(
                `${x.ik}1`,
                'join',
                x.cr
                  ? {
                      rk: x.cr.split('|')[0],
                      pk: x.cr.split('|')[1],
                      ...(x.chain.length ? { chain: x.chain } : {}),
                    }
                  : {},
                { ts: (ts += 2) }
              )
          }
          if (rng.chance(0.7)) act('O1', 'mark', {}, { ts: (ts += 2) })
          const cm = cmeta(cl)
          // no lockout: the client's posting in S' must be admitted (the join, or the rotation at the thief's join)
          const must = res.length ? [res[0].e.id] : []
          rkMeta = {
            kind: template,
            x: 'P',
            V1: udev,
            V2: 'P2',
            thief,
            thiefDevs: ['P2', 'P8'],
            thiefKeys: ['p0'],
            userRecs: [recDigest(rec1)],
            ...cm,
            mustAdmit: [
              ...must,
              ...res
                .slice(1)
                .filter(x => x.v?.s === 'A')
                .map(x => x.e.id),
            ],
          }
          break
        }
        // the `stolen` kind: the genesis owner O is protected (rkO, epoch-0 primary pO0);
        // the thief steals O2 (certified by pO0). O recovers (record 1: pO1, keep the recovering device); its
        // client posts it signed by rkO (O is a genesis owner: always the recovery key), dropping O2. The thief posts an
        // upgrade signed by pO0 at a position before the recovery: inert by epoch death through the rk-signed carrier, so it
        // never freezes S, and the owner's own upgrade after the recovery is admitted. Sometimes the owner upgrades first
        // and the thief then posts backdated revocations of O1 (by pO0, or by rkO when the phrase leaked): the honest upgrade
        // keeps S frozen. Single-owner servers only (a thief can't get a co-owner's signature).
        if (owners.length !== 1) break
        const cl = client('O', crO, ['O1'])
        for (const id of w.ref.order) if (w.ref.ev(id).a === 'O') cl.srv(w).own.add(id)
        if (
          !w.ref.order.some(id => w.ref.ev(id).dev === 'O2') &&
          !isAdm(okId(cl.act(w, 'O2', 'device_add', {}, { ts: (ts += 2) })))
        )
          break
        cl.certs.set('O2', [crO.pk])
        act(rng.pick(mem.length ? mem.map(m => `${m}1`) : ['O1']), 'mark', {}, { ts: (ts += 2) })
        const P0 = w.heads().slice(0, LIM.ap)
        const p0 = crO.pk
        const restore = rng.chance(0.3)
        const odev = restore ? 'O3' : 'O1'
        const honestFirst = rng.chance(0.3)
        let r: string | undefined, rec1: any
        const G = `G${rng.int(3)}`
        if (!honestFirst) {
          cl.lose('O2')
          rec1 = cl.recover({ maker: odev, keep: [odev], pk: 'pO1', worlds: [w] })
          if (rng.chance(0.4)) cl.endFlow() // the sweep: in an owned server it still signs with the recovery key
          // sometimes the user declines the phrase there (an extension: the stated residual), and the next
          // start-up sweep asks again and posts a carrier signed by the recovery key
          const dr = new Rng(seed * 7477 + 23)
          const declined = dr.chance(0.25)
          if (declined) {
            cl.endFlow()
            cl.declined = true
          }
          // sometimes the recovery's posting hadn't reached S when the owner transfers it, so
          // its signature carries record 1 (signed by the new primary: no carrier signed by the recovery key); on its next
          // sync the client posts a new record signed by the recovery key (client.ts `ownedRk`; mutant `cl-owned-join`: the
          // stolen O2's backdated transfer below then counts beside the owner's)
          const sigFirst = !declined && odev === 'O1' && dr.chance(0.2)
          if (sigFirst) {
            cl.endFlow()
            cl.signG(w, G)
            if (
              !okId(
                cl.act(
                  w,
                  'O1',
                  'upgrade',
                  { g: G, sigs: { O: { by: 'pO1', chain: [rec1] } } },
                  { ts: (ts += 2) }
                )
              )
            )
              break
            if (rng.chance(0.5)) bystander()
          }
          r = posted(cl).find(x => x.v?.s === 'A')?.e.id
          cl.endFlow()
          if (rng.chance(0.6)) bystander()
          // the thief's backdated upgrade, signed by pO0 (and the device's own event at P0)
          th('O2', 'upgrade', { g: 'Gt', sigs: { O: { by: p0 } } }, P0)
          if (rng.chance(0.5)) bystander()
          if (declined) {
            cl.declined = false
            cl.sweep(w)
            cl.endFlow()
          }
          // the owner's own upgrade on the heads after the recovery
          if (r && !sigFirst && rng.chance(0.6)) {
            cl.signG(w, G)
            cl.act(w, odev, 'upgrade', { g: G, sigs: { O: { by: 'pO1' } } }, { ts: (ts += 2) })
          }
        } else {
          // the owner upgrades first (on the heads, signed by pO0, before any recovery); the thief then disowns O1
          // from O2 at P0: revocations never undo an upgrade
          cl.signG(w, G)
          cl.act(w, 'O1', 'upgrade', { g: G, sigs: { O: { by: p0 } } }, { ts: (ts += 2) })
          if (rng.chance(0.5)) bystander()
          th('O2', 'device_revoke', { by: p0, dev: 'O1', seen: seenAt(P0, 'O1') }, P0)
          rec1 = { n: 1, prev: cO, by: crO.rk, pk: 'pO1', keep: [odev] }
        }
        rkMeta = {
          kind: template,
          x: 'O',
          V1: odev,
          V2: 'O2',
          r,
          rDrops: r ? dropsOf(r).filter(d => d !== odev) : [],
          thief,
          thiefDevs: [],
          thiefKeys: [p0],
          userRecs: cl.recs.length ? cl.recs.map(x => recDigest(x)) : [recDigest(rec1)],
          ...cmeta(cl),
        }
        break
      }
      if (template === 'rk-left') {
        // a server the identity X left or was removed from, after which X
        // recovers or resets elsewhere. X is the protected single owner O (`owner` kind) or a protected member P with a
        // Kick role (`member`); X2, certified by X's epoch-0 primary, is later stolen with that primary, or the old phrase
        // leaks after the reset. The client recorded the leave in its
        // signing transaction (or the removal when it learned it), and posts at that event's parents whatever the server
        // shows later; the recovering device is X5 (never in S), or X1 (kept and live in S, when X2 made the leave: its
        // keep then leaves itself out), or, when X1 made the leave and the record keeps only it,
        // the fresh posting device the record keeps; sometimes two of the user's devices post
        // (siblings). The thief, concurrent with that posting, after it, or first (before the
        // posting, and then leaves again, stays with its transfer, or is removed again): a rejoin from X2 or from a device
        // certified by the stolen primary (an owner needs no invite; a member through an owner's add that names no head),
        // a kick, and for a single owner its own transfer; with the old phrase, a reset before the leave and the same acts.
        // The leave stays in force (X is no member at the end), and nothing the thief posts counts (O15-recovery,
        // O15-thief); no act of a dropped device after the recorded leave counts.
        const owner = leftKind === 'owner'
        const X = owner ? 'O' : 'P'
        const crX = owner ? { rk: 'rkO', pk: 'pO0' } : { rk: 'rkV', pk: 'p0' }
        const cl = client(X, crX, [`${X}1`])
        let Rk: string | undefined
        if (owner) {
          if (!crOf.has('O')) break
          for (const id of w.ref.order) if (w.ref.ev(id).a === 'O') cl.srv(w).own.add(id)
          if (
            !w.ref.order.some(id => w.ref.ev(id).dev === 'O2') &&
            !isAdm(okId(cl.act(w, 'O2', 'device_add', { by: 'pO0' }, { ts: (ts += 2) })))
          )
            break
        } else {
          if (
            !isAdm(okId(act('O1', 'add', { to: 'P' }, { ts: (ts += 2) }))) ||
            !isAdm(okId(cl.act(w, 'P1', 'join', { rk: 'rkV' }, { ts: (ts += 2) })))
          )
            break
          bystander()
          if (!isAdm(okId(cl.act(w, 'P2', 'device_add', {}, { ts: (ts += 2) })))) break
          Rk = okId(act('O1', 'role_create', { pos: 3, bits: KICK }, { ts: (ts += 2) }))
          if (Rk) act('O1', 'assign', { to: 'P', role: Rk }, { ts: (ts += 2) })
        }
        cl.certs.set(`${X}2`, [crX.pk])
        const cX = crDigest(X, crX.rk, crX.pk)
        bystander()
        if (rng.chance(0.5)) cl.act(w, `${X}1`, 'mark', {}, { ts: (ts += 2) })
        const Pb = w.heads().slice(0, LIM.ap)
        if (rng.chance(0.5)) cl.act(w, `${X}2`, 'mark', {}, { ts: (ts += 2) })
        const lvPar = w.heads().slice(0, LIM.ap)
        const kicked = !owner && rng.chance(0.3)
        const leaveDev = rng.chance(0.3) ? `${X}2` : `${X}1`
        // the removal is a ban in a third of the removed cases: the posting at a ban's parents goes
        // over the push link, which a banned identity's device gets too (mutant `link-push-ban`)
        const banned = kicked && new Rng(seed * 4513 + 41).chance(0.35)
        const out = kicked
          ? act(
              'O1',
              banned ? 'ban' : 'kick',
              {
                to: X,
                seen: { [`${X}1`]: seenAt(lvPar, `${X}1`), [`${X}2`]: seenAt(lvPar, `${X}2`) },
              },
              { ap: lvPar, ts: (ts += 2) }
            )
          : cl.leave(w, leaveDev, { ap: lvPar, ts: (ts += 2) })
        if (out.v.s !== 'A') break
        bystander()
        cl.sync(w)
        const phrase = rng.chance(0.5)
        // its own stream for these draws, so the rest of the template's draws keep their order
        const fr = new Rng(seed * 6151 + 13)
        const first = !phrase && fr.chance(0.4)
        const after = first ? fr.pick(['leaves', 'stays', 'removed'] as const) : undefined
        let thiefLater = !first && rng.chance(0.5)
        // a member thief needs an add: an owner's re-invite that names no head, before or after the posting
        let addX: string | undefined
        if (!owner && !phrase && !thiefLater)
          addX = okId(act('O1', 'add', { to: X }, { ts: (ts += 2) }))
        const before = w.heads().slice(0, LIM.ap)
        cl.lose(`${X}2`)
        // X recovers or resets elsewhere: the recovering device (the maker) is X5, or X1 (kept, live here)
        const k1 = fr.next()
        const maker = k1 < 0.25 && leaveDev === `${X}2` && !kicked ? `${X}1` : `${X}5`
        let keep = maker === `${X}1` ? [`${X}1`] : k1 < 0.4 ? [`${X}5`] : [`${X}1`, `${X}5`]
        // X1 made the leave and recovers on its own (the record keeps only X1): the client's record keeps a
        // fresh posting device too
        let maker2 = maker
        if (k1 >= 0.85 && leaveDev === `${X}1` && !kicked) {
          maker2 = `${X}1`
          keep = [`${X}1`]
        }
        // two of the user's clients post: siblings only where the record's keep fits devCap (else only its maker)
        const two = rng.chance(0.25) && keep.length + 1 <= LIM.devCap && maker2 !== `${X}1`
        if (two) keep.push(`${X}7`)
        const victim = mem.find(m => m !== X && w.state().facts.mem.has(m))
        let tdev = `${X}2`
        let tj: string | undefined
        const thiefActs = () => {
          const tap = (ap?: string[]) => (thiefLater || first ? ap : (ap ?? before))
          if (phrase) {
            // the old phrase: a reset of its own from a fresh device, before the leave
            tdev = `${X}9`
            const rival = { n: 1, prev: cX, by: crX.rk, rk: 'rkT', pk: 'pT', keep: [tdev] }
            const tseen: Record<string, number> = {}
            for (const v of [`${X}1`, `${X}2`]) {
              const m = seenAt(Pb, v)
              if (m >= 0) tseen[v] = m
            }
            tj = th(
              tdev,
              'primary_rotate',
              { by: rng.chance(0.5) ? 'rkT' : 'pT', chain: [rival], keep: [], seen: tseen },
              Pb
            )
            if (tj && victim && rng.chance(0.5))
              th(
                tdev,
                'kick',
                { to: victim, seen: { [`${victim}1`]: seenAt([tj], `${victim}1`) } },
                [tj]
              )
            if (owner && tj && rng.chance(0.5))
              th(tdev, 'upgrade', { g: 'Gt', sigs: { O: { by: 'pT' } } }, [tj])
            // an owner's rejoin as X, carrying the rival (no invite needed)
            if (owner)
              tj =
                th(tdev, 'join', { rk: crX.rk, pk: crX.pk, chain: [rival], by: 'pT' }, tap()) ?? tj
          } else {
            // a stolen X2 with the epoch-0 primary: a rejoin from X2, or from a device it certified (X8)
            if (rng.chance(0.4)) tdev = `${X}8`
            if (owner || addX)
              tj = th(tdev, 'join', { by: crX.pk }, tap(addX && !thiefLater ? [addX] : undefined))
          }
          // first: the owner takes the rejoined member for the user and gives its role back
          if (first && tj && !owner && Rk)
            act('O1', 'assign', { to: X, role: Rk }, { ts: (ts += 2) })
          const kap = thiefLater || first ? undefined : tj ? [tj] : undefined
          if (tj && victim)
            th(
              tdev,
              'kick',
              { to: victim, seen: { [`${victim}1`]: seenAt(kap ?? w.heads(), `${victim}1`) } },
              kap
            )
          if (tj && owner && !phrase)
            th(tdev, 'upgrade', { g: 'Gt', sigs: { O: { by: crX.pk } } }, kap)
          if (first && tj && after === 'leaves') th(tdev, 'leave', {}, undefined)
          if (first && tj && after === 'removed' && !owner) {
            const hs2 = w.heads().slice(0, LIM.ap)
            act(
              'O1',
              'kick',
              {
                to: X,
                seen: Object.fromEntries(
                  [`${X}1`, `${X}2`, `${X}8`]
                    .map(d => [d, seenAt(hs2, d)])
                    .filter(([, m]) => (m as number) >= 0)
                ),
              },
              { ap: hs2, ts: (ts += 2) }
            )
          }
        }
        if (first) {
          thiefActs()
          if (rng.chance(0.5)) bystander()
        }
        // the server shows X as a member again (the thief stayed), and the user's own X1 leaves it
        // once more: the recorded leave or removal doesn't move (mutant `cl-left-moves`)
        const fr2 = new Rng(seed * 5347 + 23)
        if (
          first &&
          after === 'stays' &&
          fr2.chance(0.5) &&
          w.state().facts.mem.has(X) &&
          (w.state().facts.devs.get(X)?.has(`${X}1`) ?? false)
        )
          cl.leave(w, `${X}1`, { ts: (ts += 2) })
        // the user comes back once a member's new add made it pending (an owner's join needs no add to be admitted, but
        // an owner that left has no link of its own): the rotation at the recorded event, then its own join, and
        // the entry leaves the list (mutant `cl-rejoin-first`)
        const rejoinNow0 = !phrase && !banned && fr2.chance(0.25)
        // on a stream of their own:
        // - `lostEntry`: the owner's list lost the entry (a restore without the list), so no posting at the leave;
        //   the user comes back through a member's invite, and its join is its only carrier of the new record. In a server
        //   it owns a carrier signed by the recovery key follows at once (client.ts `ownedRk`; mutant `cl-owned-join`: a
        //   stolen old primary's fresh device then rejoins and transfers, positioned before that join, and it counts);
        // - `inviteFirst`: after the thief left again or was removed again, a member's invite is waiting before the
        //   user's flow, which then posts at the recorded event and joins in one go (mutant `cl-rejoin-first`);
        // - `again`: a later recovery after the user's own rejoin goes on the trusted heads, which hold that join
        //   (mutant `cl-trust-nojoin`)
        const fr3 = new Rng(seed * 7919 + 31)
        const lostEntry = owner && !phrase && !first && fr3.chance(0.2)
        const inviteFirst = first && fr3.chance(0.5)
        const again = fr3.chance(0.4)
        const rejoinNow = rejoinNow0 || lostEntry
        let rejoined = false
        let r: string | undefined
        if (lostEntry) cl.srv(w).left = undefined
        const rec = cl.recover({
          maker: maker2,
          keep,
          pk: `p${X}r`,
          ...(phrase ? { rk: `${crX.rk}2` } : {}),
          worlds: [w],
        })
        if (!(typeof process !== 'undefined' && process.env.ACL_GEN_NOLEFT)) {
          if (rng.chance(0.5)) cl.endFlow() // the sweep without the phrase: an extension (an owner's still signs with rk)
          const isOut = () => !w.state().facts.mem.has(X) && !w.state().facts.pending.has(X)
          // someone who may invite adds X once more
          const invite = () => {
            for (const inv of owner ? mem.map(m => `${m}1`) : ['O1']) {
              const a2 = okId(act(inv, 'add', { to: X }, { ts: (ts += 2) }))
              if (a2) {
                addX = a2
                break
              }
            }
          }
          if (rejoinNow && inviteFirst && isOut()) invite()
          let res: any[]
          if (rejoinNow && w.state().facts.pending.has(X))
            res = cl.rejoin(w) // an invite is waiting: both in one go
          else {
            res = posted(cl, { race: two ? `${X}7` : undefined })
            // out again (the posting cut what the thief's rejoin gave): the invite, then the user's rejoin
            if (rejoinNow && isOut()) {
              invite()
              if (w.state().facts.pending.has(X)) res = [...res, ...cl.rejoin(w)]
            }
          }
          r = res.find(x => x.e?.t === 'primary_rotate' && x.v?.s === 'A')?.e.id
          rejoined = res.some(x => x.e?.t === 'join' && x.v?.s === 'A')
          if (rejoined && again) {
            cl.recover({
              maker: cl.maker!,
              keep: cl.keepOf().filter(d => cl.held(d)),
              pk: `p${X}q`,
              worlds: [w],
            })
            posted(cl)
          }
          cl.endFlow()
          if (rng.chance(0.7)) bystander()
        }
        if (!owner && !phrase && thiefLater)
          addX = okId(act('O1', 'add', { to: X }, { ts: (ts += 2) }))
        // (with a lost entry the user never came back to, the posting never reaches that server, so no thief there)
        if (!first && !(lostEntry && !rejoined)) thiefActs()
        if (rng.chance(0.6)) bystander()
        const cm = cmeta(cl)
        const rDrops = r ? dropsOf(r).filter(d => !(rec.keep ?? []).includes(d)) : []
        // leftOut: only after X's own leave (a removal can be undone by the server's own rules, e.g. the remover's
        // concurrent leave cuts its kick, and then X is a member again with its own devices)
        // (a lost entry the user never came back to: the user's record never reached this server; nothing to claim)
        const unreached = lostEntry && !rejoined
        rkMeta = {
          kind: template,
          x: X,
          V1: cl.maker,
          V2: `${X}2`,
          r,
          rDrops,
          thief,
          thiefDevs: unreached ? [] : phrase ? [`${X}9`] : [`${X}2`, `${X}8`],
          thiefKeys: phrase ? [crX.rk, 'rkT', 'pT'] : [crX.pk],
          ...(phrase ? { leaked: true } : {}),
          userRecs: cl.recs.map(x => recDigest(x)),
          ...(unreached ? {} : { e2e: true }),
          ...(kicked || rejoined ? {} : { leftOut: true }),
          ...(rejoined ? { memberAt: w.ref.order.length } : {}),
          ...cm,
        }
        break
      }
      // rk-leak: P reset its phrase (chain record 1: rkV -> rkV2); the thief holds the old phrase rkV and no device.
      // In a new server the thief joins first with a branch of its own: a recovery signed by rkV (killed by P's reset
      // wherever both are known) or a rival reset rkV -> rkZ with a recovery under rkZ (rival resets freeze P wherever
      // both are known: no grant of either branch counts, P is no member and has no live device there). The client: P's
      // join at the add or, where the thief introduced P first, a rotation at the thief's join (the older-epoch bullet).
      // In a server P is already in, the thief also holds P2
      // (dropped by P's reset): P2's events from before the reset stay cut by the reset's watermark when the rival freezes
      // P. Sometimes the old phrase acts there first, with plain rotations by the old
      // key before its reset and by its branch key after it, and a kick; the client's reset then goes on the trusted heads
      // (the events whose past holds none of those), from a device they don't drop.
      {
        const reset1 = { n: 1, prev: crD, by: 'rkV', rk: 'rkV2', pk: 'pV2', keep: ['P1'] }
        const d1 = recDigest(reset1)
        const rival = rng.chance(0.5)
        const t1 = rival
          ? { n: 1, prev: crD, by: 'rkV', rk: 'rkZ', pk: 'pZ', keep: ['P9'] }
          : { n: 1, prev: crD, by: 'rkV', pk: 'pZ', keep: ['P9'] }
        const tchain =
          rival && rng.chance(0.5)
            ? [t1, { n: 2, prev: recDigest(t1), by: 'rkZ', pk: 'pZ2', keep: ['P9'] }]
            : [t1]
        const cl = client('P', { rk: 'rkV', pk: 'p0' }, ['P1', 'P2'])
        if (rng.chance(0.5)) {
          // P is a member here: P1 (its creation record), P2 certified by p0
          const addP = okId(act('O1', 'add', { to: 'P' }, { ts: (ts += 2) }))
          if (
            !isAdm(addP) ||
            !isAdm(okId(cl.act(w, 'P1', 'join', { rk: 'rkV' }, { ts: (ts += 2) })))
          )
            break
          act('O1', 'mark', {}, { ts: (ts += 2) })
          if (!isAdm(okId(cl.act(w, 'P2', 'device_add', {}, { ts: (ts += 2) })))) break
          act('O1', 'mark', {}, { ts: (ts += 2) })
          const P0 = w.heads().slice(0, LIM.ap)
          cl.lose('P2')
          // the old phrase first, here: plain rotations by the old key, its rival reset on the heads, plain rotations
          // by its branch key, and a kick; then the client's reset on the trusted heads
          const lr2 = new Rng(seed * 3571 + 17)
          const first = lr2.chance(0.3)
          if (first) {
            if (lr2.chance(0.4))
              th('P7', 'primary_rotate', {
                by: 'rkV',
                keep: [],
                seen: seenAll(undefined, 'P', 'P7'),
              })
            const trf = th('P9', 'primary_rotate', {
              by: 'pZ',
              chain: [t1],
              keep: [],
              seen: seenAll(undefined, 'P', 'P9'),
            })
            if (trf && lr2.chance(0.4))
              for (let i = 0; i < 1 + lr2.int(3); i++)
                th(`P${26 + i}`, 'primary_rotate', {
                  by: rival ? 'rkZ' : 'rkV',
                  keep: [],
                  seen: seenAll(undefined, 'P', `P${26 + i}`),
                })
            const vic = mem.find(m => m !== 'P' && w.state().facts.mem.has(m))
            if (trf && vic && lr2.chance(0.6))
              th('P9', 'kick', { to: vic, seen: { [`${vic}1`]: seenAt(w.heads(), `${vic}1`) } })
            if (lr2.chance(0.5)) bystander()
            cl.adopt(reset1 as any, 'P1')
            const rr = posted(cl)
            const r = rr.find(x => x.v?.s === 'A')?.e.id
            cl.endFlow()
            if (rng.chance(0.5)) bystander()
            rkMeta = {
              kind: template,
              x: 'P',
              V1: cl.postings[0]?.dev ?? 'P1',
              r,
              rDrops: [],
              thief,
              thiefDevs: ['P7', 'P9', 'P26', 'P27', 'P28'],
              thiefKeys: ['pZ', 'pZ2', 'rkZ', 'rkV', 'p0'],
              leaked: true,
              userRecs: [d1],
              e2e: true,
              ...cmeta(cl),
            }
            break
          }
          // the user's reset (its client posts it on the trusted heads, here the heads); the thief, from P2 at P0 beside it,
          // posts before and after: past the reset's watermark, so in Tail, frozen or not
          cl.adopt(reset1 as any, 'P1')
          if (rng.chance(0.5)) cl.endFlow()
          const r = posted(cl, { at: P0 }).find(x => x.v?.s === 'A')?.e.id
          cl.endFlow()
          if (!r) break
          if (rng.chance(0.7)) th('P2', rng.pick(['mark', 'profile'] as T[]), { name: 4 }, P0)
          // sometimes a third identity's device forks at P0 (x and y with one
          // seq, neither cited) and the thief places its rival on one sibling or on both; honest members never cite the
          // rival, so both stay in X (`launder`; mutant `cite-rival` makes one count)
          let fork: string[] | undefined
          const third = mem.find(m => m !== 'P' && w.latestOwn(`${m}1`))
          if (third && rng.chance(0.4)) {
            const xr = act(`${third}1`, 'mark', {}, { ap: P0, ts: (ts += 2) })
            if (xr.v.s === 'A') {
              const yr = act(
                `${third}1`,
                'profile',
                { name: 9 },
                { ap: xr.e.ap, seq: xr.e.seq, aprev: xr.e.aprev ?? null, ts: (ts += 2) }
              )
              if (yr.v.s === 'A') fork = [xr.e.id, yr.e.id]
            }
          }
          if (rng.chance(0.7)) bystander()
          // the thief's rival reset from a fresh device, at P0 (or on a fork sibling) or on the heads
          const atP0 = rng.chance(0.6) || !!fork
          const rap = fork ? rng.pick([[fork[0]], [fork[1]], fork]) : P0
          const tr = th(
            'P9',
            'primary_rotate',
            {
              by: tchain.length > 1 ? 'pZ2' : 'pZ',
              chain: tchain,
              keep: [],
              seen: atP0
                ? { P1: seenAt(rap, 'P1'), P2: seenAt(rap, 'P2') }
                : { P1: seenAt(w.heads(), 'P1'), P2: seenAt(w.heads(), 'P2') },
            },
            atP0 ? rap : undefined
          )
          // sometimes a flood of further rival resets from fresh devices at old positions, each naming
          // its own next key (honest members cite none of them)
          if (tr && rng.chance(0.3))
            for (let i = 0, n = 2 + rng.int(4); i < n; i++) {
              const fr2 = {
                n: 1,
                prev: crD,
                by: 'rkV',
                rk: `rkF${i}`,
                pk: `pF${i}`,
                keep: [`P${20 + i}`],
              }
              th(
                `P${20 + i}`,
                'primary_rotate',
                {
                  by: `pF${i}`,
                  chain: [fr2],
                  keep: [],
                  seen: { P1: seenAt(P0, 'P1'), P2: seenAt(P0, 'P2') },
                },
                P0
              )
            }
          const afterVoid: string[] = []
          if (tr && rng.chance(0.7)) {
            // honest members don't cite the rival (it is in X); P's own client, whose
            // replica holds both resets, posts nothing here (mutant `frozen-acts` posts anyway: O15-void sees it admitted)
            bystander()
            if (rng.chance(0.7) && !w.frozenIn('P'))
              afterVoid.push(cl.act(w, 'P1', 'mark', {}, { ts: (ts += 2) }).e.id)
          }
          rkMeta = {
            kind: template,
            x: 'P',
            V1: 'P1',
            r,
            rDrops: ['P2'],
            thief,
            thiefDevs: ['P9'],
            thiefKeys: ['pZ', 'pZ2', 'rkZ', 'rkV', 'p0'],
            leaked: true,
            userRecs: [d1],
            afterVoid,
            ...(fork ? { launder: fork, launderAt: w.ref.order.length } : {}),
            ...cmeta(cl),
          }
          break
        }
        const u = rng.next()
        const head = u < 0.4 ? d1 : u < 0.6 ? crD : undefined
        const addId = okId(
          act('O1', 'add', { to: 'P', ...(head ? { head } : {}) }, { ts: (ts += 2) })
        )
        if (!isAdm(addId)) break
        const tj = th(
          'P9',
          'join',
          { rk: 'rkV', chain: tchain, by: tchain.length > 1 ? 'pZ2' : 'pZ' },
          [addId!]
        )
        if (tj && rng.chance(0.6)) th('P9', 'mark', {}, [tj])
        if (rng.chance(0.5)) bystander()
        cl.lose('P2')
        cl.adopt(reset1 as any, 'P1')
        const atAdd = rng.chance(0.5)
        const res = posted(cl, { join: atAdd ? { ap: [addId!] } : {} })
        cl.endFlow()
        const r = res.find(x => x.e?.t === 'primary_rotate' && x.v?.s === 'A')?.e.id
        if (tj && rng.chance(0.5)) th('P9', rng.pick(['mark', 'profile'] as T[]), { name: 2 }, [tj])
        // without rival resets the user ends a member here: where its reset at the thief's
        // introduction killed that join (a stale recovery of the old phrase), its client joins again through the add
        // (mutant `cl-older-nojoin`)
        rkMeta = {
          kind: template,
          x: 'P',
          V1: 'P1',
          r,
          thief,
          thiefDevs: ['P9'],
          thiefKeys: ['pZ', 'pZ2', 'rkZ', 'rkV'],
          leaked: true,
          userRecs: [d1],
          ...(rival ? {} : { memberAt: w.ref.order.length }),
          ...cmeta(cl),
        }
      }
      break
    }
    case 'g-sib': {
      replayed = true // deliberate evidence: same-seq siblings
      // one device posts more than poolU siblings (same seq, same aprev) at one position.
      // Either a member kicked after its position (the removed member's flood: admitted, void, orphans), or a member's
      // second device stolen (the thief floods at the device's tip; the victim then acts from heads without the
      // siblings: a moderation act, a device_revoke of the stolen device, a leave). Honest members cite up to 10 heads,
      // so some siblings may be absorbed; the victim's events may be pool candidates.
      if (!mem.length) break
      const x = rng.pick(mem)
      let ts = Math.max(...w.ref.order.map(id => w.ref.ev(id).ts)) + 1
      const flood = (dev: string, ap: string[], n: number) => {
        const last = w.latestOwn(dev)
        if (!last) return [] as string[]
        const out: string[] = []
        for (let i = 0; i < n; i++) {
          const t: T = rng.chance(0.7) ? 'mark' : 'profile'
          const r = act(
            dev,
            t,
            { name: i % 3 },
            { ap, seq: last.seq + 1, aprev: last.id, ts: (ts += 1) }
          )
          if (r.v.s === 'A') out.push(r.e.id)
        }
        return out
      }
      const n = LIM.poolU + 1 + rng.int(6)
      if (rng.chance(0.5) || devsOf.get(x)!.length < 2 || !w.latestOwn(`${x}2`)) {
        const P = w.heads()
        setup('O1', 'kick', { to: x })
        setup('O1', 'mark')
        const sibs = flood(`${x}1`, P, n)
        const wit = mem.filter(i => i !== x)
        if (sibs.length && wit.length && rng.chance(0.4))
          act(
            `${rng.pick(wit)}1`,
            'mark',
            {},
            { ap: rng.shuffle(sibs).slice(0, 1 + rng.int(3)), ts: (ts += 11) }
          )
        break
      }
      const m0 = okId(setup('O1', 'mark'))
      if (!m0) break
      const stolen = `${x}2`
      const sibs = flood(stolen, [m0], n)
      const noSib = () => w.heads(w.ref.order.filter(id => !sibs.includes(id))).slice(0, LIM.ap)
      const tg = mem.filter(i => i !== x)
      if (tg.length && rng.chance(0.6))
        act(
          `${x}1`,
          rng.pick(['kick', 'ban'] as T[]),
          { to: rng.pick(tg) },
          { ap: noSib(), ts: (ts += 11) }
        )
      if (rng.chance(0.6)) {
        const ap = noSib()
        let seen = -1
        for (const id of w.closure(ap)) {
          const e = w.ref.ev(id)
          if (e.dev === stolen) seen = Math.max(seen, e.seq)
        }
        act(`${x}1`, 'device_revoke', { dev: stolen, seen }, { ap, ts: (ts += 11) })
      }
      if (tg.length && rng.chance(0.5)) act(`${rng.pick(tg)}1`, 'mark', {}, { ts: (ts += 11) })
      if (rng.chance(0.3)) act(`${x}1`, 'leave', {}, { ap: noSib(), ts: (ts += 11) })
      act('O1', 'mark', {}, { ts: (ts += 11) })
      break
    }
    case 'i3-flood': {
      // an owner device posts many inert events at one ts.
      const d = rng.pick(devsOf.get('O')!)
      const ts = Math.max(...w.ref.order.map(id => w.ref.ev(id).ts)) + 1
      for (let i = 0; i < 12; i++) act(d, rng.chance(0.5) ? 'mark' : 'x_future', {}, { ts })
      break
    }
    case 'i4-cap': {
      // a member with ManageRoles builds a chain of role_creates from before the owner's latest ones.
      if (!mem.length) break
      const x = rng.pick(mem)
      const mr = okId(setup('O1', 'role_create', { pos: 9, bits: ROLES }))
      if (!mr) break
      setup('O1', 'assign', { to: x, role: mr })
      const P = w.heads()
      for (let i = 0; i < 2 + rng.int(3); i++) setup('O1', 'role_create', { pos: 1, bits: 0 })
      let ts = Math.max(...[...w.closure(P)].map(id => w.ref.ev(id).ts)) + 1
      for (let i = 0; i < 6; i++, ts += 2)
        act(`${x}1`, 'role_create', { pos: 2, bits: 0 }, { ap: P, ts })
      break
    }
  }

  // adversarial phase
  const maxAdv = o.maxAdv ?? (template ? 8 : 12)
  const allowEq = o.equivocation ?? rng.chance(0.5)
  let used = false
  const adversarial: string[] = []
  // the rk-thief victim's devices and identity stay out of the random phase (its properties assume only the
  // template's records act on them)
  const allDevs = [...devsOf.values()].flat().filter(d => !rkMeta || devOwner(d) !== rkMeta.x)
  const targets = [...idents, 'N', 'M'].filter(i => !rkMeta || i !== rkMeta.x)
  for (let tries = 0; tries < 60 && adversarial.length < maxAdv; tries++) {
    const dev = rng.pick(allDevs)
    const a = devOwner(dev)
    const t = rng.pick(ACTS)
    if (t === 'upgrade' && !rng.chance(0.15)) continue
    if (t === 'primary_rotate' && !rng.chance(0.4)) continue
    const rs = [...roles(), EVERYONE]
    let c: any = {}
    switch (t) {
      case 'add': {
        const cs = codes()
        c =
          rng.chance(0.35) && cs.length
            ? { to: rng.pick(targets), code: rng.pick(cs) }
            : { to: rng.pick(targets) }
        break
      }
      case 'kick':
      case 'ban':
      case 'unban':
      case 'uninvite':
        c = { to: rng.pick(targets) }
        break
      case 'code':
        c = { h: `h${rng.int(3)}` }
        break
      case 'code_revoke': {
        const cs = codes()
        const id = cs.length ? rng.pick(cs) : 'none'
        c = { code: id, h: cs.length ? w.ref.ev(id).c.h : 'h0' }
        break
      }
      case 'profile':
      case 'settings':
        c = { name: rng.int(3) }
        break
      case 'role_create': {
        let bits = 0
        for (const b of BITS) if (rng.chance(0.4)) bits |= b
        c = { pos: rng.int(10), bits }
        break
      }
      case 'role_move':
        c = { role: rng.pick(rs), pos: rng.int(10) }
        break
      case 'role_bits':
        c = { role: rng.pick(rs), bit: rng.pick(BITS), on: rng.chance(0.5) }
        break
      case 'role_del':
        c = { role: rng.pick(rs) }
        break
      case 'assign':
      case 'revoke':
        c = { to: rng.pick(rng.chance(0.2) ? [a] : targets), role: rng.pick(rs) }
        break
      case 'device_revoke': {
        const d = rng.pick(devsOf.get(a) ?? [dev])
        c = { dev: d, seen: w.latestOwn(d)?.seq ?? -1 }
        break
      }
      case 'primary_rotate': {
        const mine = (devsOf.get(a) ?? []).filter(d => d !== dev)
        c = {
          keep: mine.filter(() => rng.chance(0.5)),
          seen: {},
          ...(rng.chance(0.6) ? { pcert: `p${rng.int(4)}` } : {}),
        }
        // some rotations carry a chain record (a recovery, a reset or a removal signed by the
        // identity's creation key, or a wrong key) and name a signer (often a wrong one); a reset by a rotation's own
        // `rk` field is refused
        if (rng.chance(0.3)) {
          const rk = crOf.get(a) ?? rng.pick(['rkA', 'rkB', 'rkC'])
          const signer = rng.chance(0.8) ? rk : rng.pick(['rkA', 'rkB', 'rkC', 'ik'])
          const u = rng.next()
          if (u < 0.05)
            c.chain = [
              {
                n: 1,
                prev: crDigest(a, rk, 'p0'),
                by: signer,
                pk: `pR${rng.int(2)}`,
                keep: c.keep,
                note: 1,
              },
            ]
          else if (u < 0.5)
            c.chain = [
              {
                n: 1,
                prev: crDigest(a, rk, 'p0'),
                by: signer,
                pk: `pR${rng.int(2)}`,
                keep: c.keep,
              },
            ]
          else if (u < 0.65)
            c.chain = [
              { n: 1, prev: crDigest(a, rk, 'p0'), by: signer, rk: 'rkN', pk: 'pRn', keep: c.keep },
            ]
          else if (u < 0.75)
            c.chain = [
              { n: 1, prev: crDigest(a, rk, 'p0'), by: signer, rk: '', pk: 'pRm', keep: c.keep },
            ]
          else if (u < 0.82) c.rk = rng.pick(['rkA', 'rkB'])
          if (c.chain) delete c.pcert
          if (rng.chance(0.7))
            c.by = rng.pick(['ik', rk, 'rkN', 'p0', 'p1', c.chain?.[0]?.pk ?? 'pR0'])
        }
        break
      }
      case 'upgrade': {
        const signers = rng.chance(0.8) ? owners.filter(x => x !== a) : []
        // on rules 3 every owner's signature, the author's own included, names its key (absent:
        // the model's shorthand, the right key of the position), sometimes a wrong one
        // the rkCase identity's signature never takes the model's shorthand (which reads a frozen or void owner's
        // absent `by` as ik, a key a protected identity no longer has): it names a key the thief holds, or a wrong one
        c = {
          g: `G${rng.int(3)}`,
          sigs: rules3
            ? Object.fromEntries(
                [...signers, ...(rng.chance(0.85) ? [a] : [])].map(o => [
                  o,
                  rkMeta && o === rkMeta.x && !rkMeta.legacy
                    ? { by: rng.pick([...(rkMeta.thiefKeys ?? []), 'pR0']) }
                    : rng.chance(0.15)
                      ? { by: rng.pick(['ik', 'p0', 'rkA', 'pR0']) }
                      : {},
                ])
              )
            : signers,
        }
        break
      }
    }
    const op: any = {}
    const r = rng.next()
    const adm = w.ref.order
    const randomPos = () => {
      const k = 1 + rng.int(3)
      return Array.from({ length: k }, () => adm[rng.int(adm.length)])
    }
    const denies = adm.filter(id => w.ref.rec(id).cls === 'D')
    const raises = adm.filter(id => {
      const x = w.ref.ev(id)
      return x.a !== a && (x.t === 'assign' || (x.t === 'role_move' && w.ref.rec(id).cls === 'G'))
    })
    if (r < 0.35) {
      // honest on current heads
    } else if (r < 0.45 && denies.length) {
      op.ap = [rng.pick(denies), ...randomPos().slice(0, rng.int(2))] // right after a deny, from a partial view
    } else if (r < 0.55 && raises.length) {
      op.ap = [rng.pick(raises), ...randomPos().slice(0, rng.int(2))] // right after someone's grant, from a partial view (k* races)
    } else if (r < 0.85 || !allowEq) {
      op.ap = randomPos() // stale or backdated position; device keeps its own chain
    } else {
      op.ap = randomPos() // equivocation: the device's own latest event may be missing
      op.keepOwn = false
    }
    if (
      op.ap &&
      op.keepOwn !== false &&
      (t === 'device_add' || t === 'device_revoke' || t === 'join' || t === 'primary_rotate')
    ) {
      // identity ops are certified by the primary key, which serializes them: cite the identity's latest one
      let li: string | undefined
      for (const id of adm)
        if (
          w.ref.ev(id).a === a &&
          w.ref.rec(id).depth >= 0 &&
          (!li || w.ref.rec(id).depth > w.ref.rec(li).depth)
        )
          li = id
      if (li) op.ap.push(li)
    }
    if ((t === 'device_revoke' && op.ap !== undefined) || t === 'primary_rotate') {
      // the watermarks must cover what the revoker's position holds
      const B = op.ap ? w.closure(op.ap) : new Set(adm)
      const mx = (d: string) => {
        let m = -1
        for (const id of B) {
          const e = w.ref.ev(id)
          if (e.dev === d) m = Math.max(m, e.seq)
        }
        return m
      }
      if (t === 'device_revoke')
        c.seen = Math.max(mx(c.dev), rng.chance(0.5) ? mx(c.dev) : (w.latestOwn(c.dev)?.seq ?? -1))
      else
        for (const d of devsOf.get(a) ?? [])
          if (d !== dev && !c.keep.includes(d) && mx(d) >= 0) c.seen[d] = mx(d)
    }
    if (rng.chance(0.1)) op.ts = rng.chance(0.5) ? 0 : 1000 + rng.int(50) // clock games
    const op2 = t === 'join' && rng.chance(0.85) ? vouchOp(dev, op) : op
    const before = w.ref.order.length
    const { e, v } = w.act(dev, t, c, op2)
    if (v.s === 'A') {
      adversarial.push(e.id)
      if (w.ref.order.length !== before + 1) throw new Error('admission side effect')
      if (op.keepOwn === false) used = true
    }
  }
  // a record that names its signer, or a rotation that carries recovery-key content, may be made inert by
  // the protection rules: deliberate evidence. A join that only carries its creation record
  // is honest, so O7-honest runs on it
  const bound = w.ref.order.some(id => {
    const e = w.ref.ev(id)
    return (
      ((e.t === 'primary_rotate' ||
        e.t === 'device_add' ||
        e.t === 'device_revoke' ||
        e.t === 'join') &&
        (e.c?.by !== undefined ||
          (e.t === 'primary_rotate' && (e.c?.rk !== undefined || e.c?.chain !== undefined)))) ||
      // an upgrade whose signatures name their keys may be made inert by the protection rules
      (e.t === 'upgrade' &&
        !!e.c?.sigs &&
        !Array.isArray(e.c.sigs) &&
        Object.values(e.c.sigs).some(
          (x: any) => !!x && typeof x === 'object' && x.by !== undefined
        ))
    )
  })
  return {
    w,
    equivocation: used || replayed || bound,
    seed,
    adversarial,
    template,
    limits: L,
    rkCase: rkMeta,
  }
}
