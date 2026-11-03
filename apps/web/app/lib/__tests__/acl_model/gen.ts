/* eslint-disable */
// @ts-nocheck
// Copy of notes/acl-model/gen.ts (the executable reference model of the P2P ACL spec), used only by the differential tests.
// Random adversarial scenario generator (2-4 identities, 1-2 devices each, outsiders, ranked roles, scripted templates for
// the review shapes, then up to ~12 adversarial events). Uses only the World API, so it also drives the revision-2 model.
import { World } from './world'
import {
  BAN,
  BITS,
  EVERYONE,
  INVITE,
  KICK,
  LIM,
  ROLES,
  SERVER,
  type T,
  devOwner,
  perms,
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

export interface Case {
  w: World
  equivocation: boolean
  seed: number
  adversarial: string[]
  template?: string
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

/** Templates for the shapes of the revision-2 review (§7.4); each is a short scripted race, tolerant of rejections. */
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
  'g-intro',
  'g-tree',
  'g-pool',
  'g-sib',
] as const

export function genCase(
  seed: number,
  o: { maxAdv?: number; equivocation?: boolean; template?: string } = {}
): Case {
  const rng = new Rng(seed * 2654435761)
  const w = new World()
  const others = ['A', 'B', 'C'].slice(0, 1 + rng.int(3))
  const idents = ['O', ...others]
  const devsOf = new Map<string, string[]>()
  for (const i of idents) devsOf.set(i, rng.chance(0.5) ? [`${i}1`, `${i}2`] : [`${i}1`])
  for (const x of ['N', 'M', 'V', 'Z']) devsOf.set(x, [`${x}1`]) // outsiders who may be invited
  const owners = rng.chance(0.15) ? ['O', others[0]] : ['O']
  w.genesis('O1', owners, rng.chance(0.4) ? INVITE : 0)
  // [H18] W3(e) (revision 5, dispatch 5b): a join through a non-owner's add needs a third identity's good-faith
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
  // the owner's setup events are spread over time like a real setup (2 time units apart, §4.1 W3)
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
    if (!owners.includes(i)) setup('O1', 'add', { to: i })
    const j = setup(`${i}1`, 'join')
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

  // race template (§3.4 outcome 8): a senior demotes promoter A while A promotes C and B removes C; C then acts
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

  // review templates (§7.4): each case runs at most one, so every shape is reached in a few percent of cases
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
      // revision 5 (M1 of the r4 review): the non-monotone corners and large strata
      'nm-target',
      'nm-target',
      'nm-target',
      'nm-pending',
      'nm-pending',
      'nm-rejoin',
      'nm-pos',
      'nm-pos',
      'big-stratum',
      // revision 5, dispatch 5b-ii: the growth shapes ([H17], [H19], [H20])
      'g-intro',
      'g-intro',
      'g-tree',
      'g-tree',
      'g-pool',
      'g-pool',
      'g-pool',
      // revision 6 (r5 review C1, M2): same-seq sibling floods past poolU, from a removed member and from a stolen device
      'g-sib',
      'g-sib',
      'g-sib',
    ])
  const mem = members()
  let replayed = false // the thief template's identity-chain replay is deliberate equivocation
  switch (template) {
    case 'c1-pair': {
      // [RV C1]: two moderators share one role (same stratum); V's invite chain; the owner promotes V's invitee N above
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
      // [R3V C1] and generalizations: 2–3 moderators share one role (same stratum); unrelated sibling cuts (a kick or
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
      // [R3V C1], depth: two grantors give X ManageRoles roles (an OR-support), X gives P an Invite role, P invites N.
      // 2–4 same-stratum removals of the grantors (by one or several moderators) race all of it; the owner's two devices
      // promote X and P concurrently with random subsets of the removals, so X and P have different exposure sets and
      // the cascade must intersect them along the path (§3.1 step 4).
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
      // [R3V C1] at scale: an invite tree under U, 3–6 same-stratum removals (of U, of tree members, of unrelated
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
      // [R4V C1] NM1–NM5 and generalizations (M1): two seniors raise the actor's role and the target's role; a member
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
      // [R4V C1] the foreign pending adds of an uninvite: A, holding Kick through G's grant, withdraws N's invites while
      // B's concurrent add of N is pending; a senior removes G and B at one stratum. Revision 4 dropped B's cut add from
      // the foreign set, so A's withdrawal survived the loss of its Kick.
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
    case 'nm-rejoin': {
      // [R4V C1] invite consumption: N joins through B's invite, leaves, and joins again through C's invite (citing both);
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
      // [R4V C1] the stratified Pos register's tie-break: two equal movers raise a held role concurrently (the lower
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
      // M1: many same-stratum causes (strata above the oracle's enumeration bound are checked lazily): 6–14 moderators
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
      // revision 6 (r5 review M2): half the cases have 13-16 moderators, so the stratum has more than 12 causes (the
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
      // [RV C2]: an inviter (plain, ranked, with or without Kick) undoes a settled join by a backdated withdrawal, a
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
      // [RV C3]: a stolen second device plants a backdated op where its identity ranked higher, the thief forks the
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
      // [RV C4]: an owner's second device posts an upgrade from a position before the co-owner joined.
      if (owners.length < 2 || devsOf.get('O')!.length < 2) break
      const o2 = w.ref.order.find(id => w.ref.ev(id).dev === 'O2')
      if (!o2) break
      const sigs = rng.chance(0.5) ? [] : owners.filter(x => x !== 'O')
      act('O2', 'upgrade', { g: `G${rng.int(3)}`, sigs }, { ap: [o2] })
      break
    }
    case 'i1-grab': {
      // [RV I1]: a member copies a published code hash into its own code at an older position and revokes that copy.
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
      // [R2V I2], [R3V I1], [R3V I3]: others keep the server busy for several windows; an idle member then replays the
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
      // [R3V I2]: a moderator bans principals nobody has seen and members at one ts; an identity rotates and churns
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
      // [H17]: a member (removed or not) posts concurrent fresh-device introductions at one position (device_adds,
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
      // [H19]: at each position of its identity chain a member posts a rotation child and a device_add child (a race:
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
      // [H20]: the identity pool. A member's devices revoked while it was a member post from their old tips (citing the
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
    case 'g-sib': {
      replayed = true // deliberate evidence: same-seq siblings
      // revision 6 (r5 review C1, M2): one device posts more than poolU siblings (same seq, same aprev) at one position.
      // Either a member kicked after its position (the removed member's flood: admitted, void, orphans), or a member's
      // second device stolen (the thief floods at the device's tip; the victim then acts from heads without the
      // siblings: a moderation act, a device_revoke of the stolen device, a leave). Honest members cite up to 10 heads,
      // so some siblings may be absorbed; the victim's events may be pool candidates (revision 5's pool, §10.16).
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
      // [RV I3]: an owner device posts many inert events at one ts.
      const d = rng.pick(devsOf.get('O')!)
      const ts = Math.max(...w.ref.order.map(id => w.ref.ev(id).ts)) + 1
      for (let i = 0; i < 12; i++) act(d, rng.chance(0.5) ? 'mark' : 'x_future', {}, { ts })
      break
    }
    case 'i4-cap': {
      // [RV I4]: a member with ManageRoles builds a chain of role_creates from before the owner's latest ones.
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
  const allDevs = [...devsOf.values()].flat()
  const targets = [...idents, 'N', 'M']
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
        break
      }
      case 'upgrade':
        c = { g: `G${rng.int(3)}`, sigs: rng.chance(0.8) ? owners.filter(x => x !== a) : [] }
        break
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
  return { w, equivocation: used || replayed, seed, adversarial, template }
}
