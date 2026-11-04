import type { EvalResult } from './acl/facts'
import { authority, EVERYONE, guards, introduces, type AclContent, type AclEv } from './acl/rules'
import { dict, overwritesOf, rolesOf, type RoleSum } from './acl/summary'
import type { RoomCtx } from './acl_room_ctx'
import type { Carried, Disowned, Reapply } from './acl_room'
import { AGREED } from './limits'

// A role_create's content is the carried summary `was`.
const sameRole = (c: AclContent, was: RoleSum) =>
  c.pos === was.pos && c.bits === was.bits && c.name === was.name && c.color === was.color

// Whether a deny's effect still holds in `F`: the member still out or banned, the role still not
// held, the bit still off, the role still deleted or where it was moved, the invite still gone.
const standing = (t: string, c: AclContent, F: EvalResult['facts']) => {
  const to = typeof c.to === 'string' ? c.to : ''
  const role = typeof c.role === 'string' ? c.role : ''
  switch (t) {
    case 'kick':
      return !F.mem.has(to)
    case 'ban':
      return F.ban.has(to)
    case 'uninvite':
      return !F.mem.has(to) && !F.invited.get(to)?.length
    case 'revoke':
      return ![...(F.holds.get(to) ?? [])].includes(role)
    case 'role_bits':
      return (
        (role === EVERYONE || F.roles.has(role)) &&
        ((F.bits.get(role) ?? 0) & (c.bit as number)) === 0
      )
    case 'role_del':
      return !F.roles.has(role)
    case 'role_move':
      return F.pos.get(role) === c.pos
    default:
      return true
  }
}

// The role a deny names, not @everyone, which every copy has.
const roleRef = (c: AclContent) =>
  typeof c.role === 'string' && c.role !== EVERYONE ? c.role : null

// Whether each event still counts: content that shows; an ACL event in force (a deny effective,
// anything else not void, cut or past a watermark).
export function counted(cx: RoomCtx, ids: readonly string[]): boolean[] {
  const v = cx.view()
  const S = cx.r.state()
  const ix = cx.r.acl.ix
  return ids.map(id => {
    const m = v.byIdOf(id)
    if (m) return !v.hidden(m)
    const i = ix.at.get(id)
    if (i === undefined || !cx.r.admitted(id)) return false
    if (ix.isD[i]) return S.eff.has(id)
    return !S.X.has(id) && !S.cut.has(id) && !S.tail.has(id)
  })
}

// Whether each event stopped counting because of a device's removal: content hidden past its
// device's fork point or a revocation's watermark (not redacted, wiped, removed or cut); an
// ACL event no longer in force.
export function stopped(cx: RoomCtx, ids: readonly string[]): boolean[] {
  const v = cx.view()
  const now = cx.counted(ids)
  return ids.map((id, n) => {
    const m = v.byIdOf(id)
    if (!m) return !now[n]
    const why = v.hidden(m)?.why
    return why === 'revoked' || why === 'fork'
  })
}

// Spec 3.8 step 4: project(Eval_S(B(u))) for the upgrade `up`: the members, bans, roles (and
// who holds them), channels and settings at its parents. Null when it isn't admitted here.
export function carried(cx: RoomCtx, up: string): Carried | null {
  const ix = cx.r.acl.ix
  const i = ix.at.get(up)
  if (i === undefined || !cx.r.admitted(up) || ix.ev[i].t !== 'upgrade') return null
  const F = cx.r.acl.stateOf(ix.ev[i].ap).facts
  const holds = dict<string[]>()
  for (const ik of F.mem) holds[ik] = [...(F.holds.get(ik) ?? [])]
  const roles = rolesOf(F, ix)
  const channels = dict<AclContent>()
  for (const [id, c] of F.channels) channels[id] = c
  return {
    members: [...F.mem],
    bans: [...F.ban],
    holds,
    roles,
    channels,
    overwrites: overwritesOf(F),
    settings: F.setting ?? null,
  }
}

// I2: our own denies the current state doesn't count (cut, void by a fork, past a revocation's
// watermark) that we may still make at the heads: the same act, checked against the current
// state's authority and guards. One per act, newest first.
// Spec 3.8 step 7: our denies in this (old) copy that the upgrade `up` doesn't have in its past
// (made concurrently with the transfer, so not carried over), to re-apply in the new copy
// (`admissible` there decides). A role is named as the upgrade carried it over.
export function outside(
  cx: RoomCtx,
  me: string,
  up: string,
  exclude: readonly string[] = []
): Reapply[] {
  const ix = cx.r.acl.ix
  const u = ix.at.get(up)
  if (u === undefined || ix.genesis < 0) return []
  const fe = cx.r.acl.evaluation()
  const carried = rolesOf(cx.r.acl.stateOf(ix.ev[u].ap).facts, ix)
  const F = cx.r.state().facts
  const out: Reapply[] = []
  for (const i of ix.byAuthor.get(me) ?? []) {
    const e = ix.ev[i]
    if (!ix.isD[i] || ix.isSelfD[i]) continue
    if (e.relay || !fe.inS(i) || fe.X[i] || fe.tail[i] || exclude.includes(e.dev)) continue
    if (ix.has(u, i)) continue
    const { seen: _s, reason: _r, ...c } = e.c as AclContent & { seen?: unknown; reason?: unknown }
    // Still in force here: not cut, and nothing since gave back what it took.
    if (!fe.isEffI(i) || !standing(e.t, c as AclContent, F)) continue
    const role = roleRef(c as AclContent)
    const roleWas = role === null ? undefined : carried[role]
    if (role !== null && !roleWas) continue
    out.push({
      id: ix.ids[i],
      t: e.t,
      c: c as AclContent,
      ...(roleWas ? { roleWas } : {}),
    })
  }
  return out
}

// Those of `list` we may make here now (authority and guards in the current state). A role is
// the one the carry-over made from it: the owner's role_create with the carried summary, before
// its `done` chunk (later moves and edits don't change that). None, more than one, or deleted
// since: the act isn't offered.
export function admissible(cx: RoomCtx, me: string, list: readonly Reapply[]): Reapply[] {
  const F = cx.r.state().facts
  const ix = cx.r.acl.ix
  const owner = ix.genesis < 0 ? null : ix.ev[ix.genesis].a
  const done: number[] = []
  ix.ev.forEach((e, i) => {
    const chunk = e.t === 'migrate' && e.a === owner ? (e.c.chunk as AclContent) : null
    if (chunk?.kind === 'done') done.push(i)
  })
  const madeFrom = (was: RoleSum) => {
    const hits = [...ix.roleCreate].filter(([, i]) => {
      const e = ix.ev[i]
      return e.a === owner && sameRole(e.c, was) && !done.some(d => ix.has(i, d))
    })
    return hits.length === 1 && F.roles.has(hits[0][0]) ? hits[0][0] : undefined
  }
  const seen = new Set<string>()
  const out: Reapply[] = []
  for (const x of list) {
    const role = x.roleWas ? madeFrom(x.roleWas) : null
    if (role === undefined) continue
    const c = role === null ? x.c : ({ ...x.c, role } as AclContent)
    const key = `${x.t}\n${JSON.stringify(c)}`
    if (seen.has(key)) continue
    seen.add(key)
    const probe = { id: '', t: x.t, a: me, dev: '', seq: 0, ap: [], ts: 0, c } as AclEv
    if (authority(probe, F) && guards(probe, F, cx.r.lim)) out.push({ id: x.id, t: x.t, c })
  }
  return out
}

export function reapply(cx: RoomCtx, me: string, exclude: readonly string[] = []): Reapply[] {
  const ix = cx.r.acl.ix
  if (ix.genesis < 0 || cx.r.unknownRules !== undefined) return []
  const fe = cx.r.acl.evaluation()
  const F = cx.r.state().facts
  const out: Reapply[] = []
  const acts = new Set<string>()
  const own = [...(ix.byAuthor.get(me) ?? [])].sort((x, y) => y - x)
  for (const i of own) {
    const e = ix.ev[i]
    if (!ix.isD[i] || ix.isSelfD[i] || e.relay || !fe.inS(i) || fe.isEffI(i)) continue
    // Not a device we disowned as lost or stolen, or signed out: not ours to re-apply. Past a
    // revocation's or rotation's watermark (the evaluation's tail: devices it dropped, those
    // introduced concurrently with it too) the room itself says so, on every device of ours.
    if (exclude.includes(e.dev) || fe.tail[i]) continue
    const { seen: _s, ...c } = e.c as AclContent & { seen?: unknown }
    const { reason: _r, ...act } = c as AclContent & { reason?: unknown }
    const key = `${e.t}\n${JSON.stringify(act)}`
    if (acts.has(key)) continue
    acts.add(key)
    const probe = { id: '', t: e.t, a: me, dev: e.dev, seq: 0, ap: [], ts: 0, c } as AclEv
    if (authority(probe, F) && guards(probe, F, cx.r.lim)) out.push({ id: ix.ids[i], t: e.t, c })
  }
  return out
}

// Spec 3.9, 8.2 lost or stolen device: what device `dk` of `ik` did after its last trusted event
// (its ACL events with a higher seq, and how much content; `witnesses`: the ACL events received
// here by the cut-off; `own`: the highest seq this browser itself signed with it by then), who
// joined
// through its invites from then on and goes with them, and where a rotation that disowns them
// can sit: the newest admitted events that have none of them in their past (null: none, its
// first changes can't be undone). There, `devs` are ik's live devices and `seen` the watermark
// of each device of ik its past introduces: `dk` up to its last trusted seq, the others up to
// their last event that has none of them in its past.
export function disown(
  cx: RoomCtx,
  ik: string,
  dk: string,
  witnesses: readonly string[],
  own = -1
): Disowned {
  const ix = cx.r.acl.ix
  const none: Disowned = {
    seq: -1,
    acts: [],
    content: 0,
    lose: [],
    ap: null,
    live: false,
    devs: [],
    seen: {},
  }
  if (ix.genesis < 0 || cx.r.unknownRules !== undefined) return none
  const fe = cx.r.acl.evaluation()
  const F = cx.r.state().facts
  // Its last trusted event: the newest of its ACL events that an ACL event of someone else, or of
  // another device of ours, received here by the cut-off has in its past. Its own dates are not
  // evidence: a thief can backdate them.
  const known = witnesses.filter(id => cx.r.admitted(id) && ix.ev[ix.at.get(id)!].dev !== dk)
  const { bits: wb } = ix.closure(known)
  let seq = own
  for (const i of ix.byDev.get(dk) ?? [])
    if ((wb[i >>> 5] >>> (i & 31)) & 1) seq = Math.max(seq, ix.ev[i].seq)
  // Below its fork point known here: what forks we already saw is undone too.
  seq = Math.min(seq, (cx.r.state().F.get(dk) ?? Infinity) - 1)
  const held = [...cx.contents.values()].filter(m => m.dev === dk)
  const D = (ix.byDev.get(dk) ?? []).filter(i => ix.ev[i].seq > seq)
  const Dset = new Set(D)
  const Db = new Uint32Array((ix.n + 31) >>> 5)
  for (const i of D) Db[i >>> 5] |= 1 << (i & 31)
  const tainted = (i: number) => {
    if (Dset.has(i)) return true
    const a = ix.anc[i]
    for (let w = 0; w < a.length; w++) if (a[w] & Db[w]) return true
    return false
  }
  const ok = (i: number) => {
    if (!fe.inS(i) || tainted(i) || fe.X[i] || fe.tail[i]) return false
    const e = ix.ev[i]
    return F.mem.has(e.a) || i === ix.genesis || (e.t === 'leave' && fe.isEffI(i))
  }
  const heads = cx.heads(ok).slice(0, AGREED.ap)
  const ap = heads.length ? heads : null
  const at = ap ?? cx.heads(i => fe.inS(i)).slice(0, AGREED.ap)
  const St = cx.r.acl.stateOf(at).facts
  const live = St.devs.get(ik)?.has(dk) ?? false
  const seen: Record<string, number> = {}
  if (ap) {
    const { bits } = ix.closure(ap)
    const inC = (i: number) => ((bits[i >>> 5] >>> (i & 31)) & 1) === 1
    for (const x of ix.introBy.get(ik) ?? [])
      if (inC(x))
        for (const v of introduces(ix.ev[x])) {
          let m = -1
          for (const i of ix.byDev.get(v) ?? []) if (inC(i)) m = Math.max(m, ix.ev[i].seq)
          for (const c of cx.contents.values())
            if (c.dev === v && c.ap.every(p => !tainted(ix.at.get(p) ?? 0))) m = Math.max(m, c.seq)
          seen[v] = v === dk ? Math.max(seq, m) : m
        }
    seen[dk] = seq
  }
  const lose: string[] = []
  for (const X of F.mem) {
    let j = -1
    for (const g of ix.memEv.get(X) ?? []) if (fe.inS(g) && !fe.isVoidI(g) && g > j) j = g
    if (j < 0 || ix.ev[j].t !== 'join') continue
    const inv = cx.inviteOf(X, j)
    if (inv && (Dset.has(inv.add) || (inv.code !== undefined && Dset.has(inv.code)))) lose.push(X)
  }
  return {
    seq,
    acts: D.map(i => {
      const e = ix.ev[i]
      const to = typeof e.c.to === 'string' ? e.c.to : undefined
      return { id: ix.ids[i], t: e.t, ts: e.ts, ...(to ? { to } : {}) }
    }),
    content: held.filter(m => m.seq > seq).length,
    lose,
    ap,
    live,
    devs: [...(St.devs.get(ik) ?? [])],
    seen,
  }
}
