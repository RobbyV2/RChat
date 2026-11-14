/* eslint-disable */
// @ts-nocheck
// Copy of notes/acl-model-r8f/client.ts (the executable reference model of the P2P ACL spec r8f), used only by tests.
// Fix round 5 (the controller's ruling 1 on the r8e reviews): the client rules of §1.7 "After a recovery" and §3.7's
// links as executable model code. A `Client` is one protected identity's app across its devices (an app that runs
// several identities runs one `Client` for each: the lists, the log, the flow and its phrase belong to one identity,
// and one phrase protects at most one identity): its own chain records,
// the devices it holds, its log of the events its devices made in each server, the leave or removal it recorded there,
// the upgrades it signed, and whether the phrase is at hand. After a recovery, a reset or a restore it decides, for each
// server whose state holds the identity, the position, the poster, the keep, the signer and the link of the posting, and
// delivers it only over a link an up-to-date member gives the poster's session (`deliver`: no `World.act` shortcut).
// Where §1.7's prose and this module differ, this module is normative, as model.ts is for servers.
//
// The bullets, in their order of precedence (`post`):
// 1. **frozen**: a client whose replica holds its identity frozen posts nothing there (World.frozenIn).
// 2. **left**: a server on its list (it left, or was removed): at the parents of the recorded leave or removal, whatever
//    the server shows later; where a counting upgrade the client itself signed is not in those parents, at the frontier
//    of the parents and that upgrade (I1). Watermarks through the recorded event. It replaces the member, older-epoch
//    and upgraded bullets.
// 3. **archived**: a server with a counting upgrade: on the trusted heads (the heads of the events whose past holds no
//    record of the identity the client didn't make), never before an upgrade the client signed (I2, C1).
// 4. **older epoch**: a member through an introduction the client didn't make. Where the records that introduction
//    carried are on the client's chain: a rotation at it. Where they aren't (a leaked old phrase's branch, which the
//    client's records kill): a join beside it, at the same add (a genesis owner at that introduction's parents), so the
//    identity stays a member. Each falls back to the other where it is refused.
// 5. **member**: on the trusted heads.
// 6. **join**: a pending invite or a successor's carry-over add: a join carrying the chain, then the revocations at the
//    join in the same signing transaction (the devices live in B(join) the head neither keeps nor certified).
// Poster (`poster`): the record's maker, else another device the record keeps, else the fresh device the record keeps
// for posting (planned by `recover` for a server where no kept device can post), else a fresh device certified under the
// new primary; never one revoked or dropped there (at the position or in the member's state), never one whose own
// latest event there holds the recorded leave or a record the client didn't make. Keep: the record's devices live at the
// position, other than the poster, within devCap. Signer: in a server where the identity is a genesis owner always the
// recovery key (the recovery flow signs them all; the sweep asks for the phrase), elsewhere the recovery key in the flow
// and otherwise an extension signed by the new head's primary. A join can't be signed by the recovery key, so where a
// join of its own carried the head into a server it owns, a new record follows at once in a rotation signed by the
// recovery key (`ownedRk`). Link: model.ts `linkOf` and `pushOk`.
//
// Mutants (one per client-rule bullet; `mutants.ts`): `cl-left-latest`, `cl-left-moves`, `cl-left-heads`,
// `cl-upg-atleave`, `cl-upg-heads`, `cl-member-heads`, `cl-older-heads`, `cl-keep-poster`, `cl-owned-ext`,
// `cl-wm-noleave`, `cl-no-revoke`, `cl-poster-dropped`, `cl-fresh-unkept`, `cl-no-sweep`, `cl-join-heads`,
// `cl-join-nochain`, `cl-n26f-heads`, `cl-reset-unfetched`, `cl-flow-order`, `cl-rejoin-first`, `cl-older-nojoin`,
// `cl-trust-nojoin`, `cl-owned-join`.
import { World, type Opts } from './world'
import {
  type Ev,
  type T,
  type ChainRec,
  LIM,
  MUT,
  CHAIN_MAX,
  crDigest,
  recDigest,
  linkOf,
  pushOk,
  droppedBy,
  withLim,
  carriedOf,
} from './model'

export type Link = 'full' | 'acl' | 'push' | 'none'
/** the member's state a session is gated against */
export interface Gate {
  S: any
  ids: string[]
}
/** a posting the client made or tried: the bullet that placed it, the link that carried it (none: never delivered) */
export interface Posting {
  srv: string
  id?: string
  dev: string
  t: T
  bullet: string
  link: Link
  delivered: boolean
  verdict?: string
  by?: string
  /** what the links did that §3.7 forbids, at this posting (read by O15-link) */
  flaw?: string
}
interface Srv {
  name: string
  /** the events its devices made there (the client's log, synced between its devices and kept in the backup) */
  own: Set<string>
  /** the recorded leave or removal: stored in the leave's signing transaction (or when the removal is learned); it never
   * moves, and the entry leaves the list only when its own client rejoins */
  left?: string
  /** the transfers (`G'`) it signed there, recorded when signed */
  signedG: Set<string>
  /** a genesis owner of the server */
  owner: boolean
  /** it rejoined after the recorded event (its own join) */
  rejoined?: string
  /** upgrades it signed that counted before its postings (they must still count: the keepUp property) */
  keepUp: Set<string>
  /** the posting's dropped devices and the recorded event, for the properties */
  drops: Set<string>
}

const env = (k: string) => typeof process !== 'undefined' && !!process.env[k]

export class Client {
  recs: ChainRec[] = []
  /** the phrase is at hand: the recovery, reset or restore flow, or the user entered it when the sweep asked */
  phrase = false
  /** the user declines the phrase when the sweep asks (the stated residual of an owned server, §1.7) */
  declined = false
  /** the devices it holds, each with the primaries that certified it (its session certificates) */
  certs = new Map<string, string[]>()
  /** devices the user lost (stolen): the client holds them no longer */
  lost = new Set<string>()
  maker?: string
  /** fresh posting devices the latest record keeps (planned by recover) */
  freshKept: string[] = []
  srvs = new Map<World, Srv>()
  postings: Posting[] = []
  /** the template's W3(e) helper for joins and its clock */
  vouch?: (w: World, dev: string, o: Opts) => Opts
  clock: () => number = () => 0
  /** the template's clock moves on by `n` (the client waits out a rate limit of its own) */
  wait?: (n: number) => void
  constructor(
    public ik: string,
    public cr: { rk: string; pk: string },
    devices: string[] = []
  ) {
    for (const d of devices) this.certs.set(d, [cr.pk])
  }

  // ------------------------------------------------------------ the chain the client holds
  crD() {
    return crDigest(this.ik, this.cr.rk, this.cr.pk)
  }
  head(): ChainRec | undefined {
    return this.recs[this.recs.length - 1]
  }
  headD() {
    const h = this.head()
    return h ? recDigest(h) : this.crD()
  }
  /** the recovery key in force after the head */
  rkNow() {
    let k = this.cr.rk
    for (const r of this.recs) k = r.rk === undefined ? k : r.rk === '' ? r.pk! : r.rk
    return k
  }
  /** the primary after the head */
  prim() {
    return this.head()?.pk ?? this.cr.pk
  }
  keepOf(): string[] {
    return this.head()?.keep ?? [...this.certs.keys()]
  }
  held(dev: string) {
    return this.certs.has(dev) && !this.lost.has(dev)
  }

  srv(w: World): Srv {
    let s = this.srvs.get(w)
    if (!s) {
      const g = w.ref.order.length ? w.ref.ev(w.ref.order[0]) : undefined
      s = {
        name: `S${this.srvs.size}`,
        own: new Set(),
        signedG: new Set(),
        owner: ((g?.c?.owners ?? []) as string[]).includes(this.ik),
        keepUp: new Set(),
        drops: new Set(),
      }
      this.srvs.set(w, s)
    }
    return s
  }

  // ------------------------------------------------------------ ordinary acts (not postings), recorded in the log
  act(w: World, dev: string, t: T, c: any = {}, o: Opts = {}) {
    const r = w.act(dev, t, c, o)
    if (r.v.s === 'A') this.srv(w).own.add(r.e.id)
    return r
  }
  /** a leave: recorded in its signing transaction. The recorded event never moves: while the server is on the list (no
   * rejoin of its own since), a later leave one of its devices signs there (the server showed the identity as a member
   * again, through a rejoin it didn't make) is logged but not recorded. Mutant `cl-left-moves`: the record moves to it */
  leave(w: World, dev: string, o: Opts = {}) {
    const r = this.act(w, dev, 'leave', {}, o)
    if (r.v.s === 'A') {
      const s = this.srv(w)
      if (!s.left || s.rejoined || MUT === 'cl-left-moves') {
        s.left = r.e.id
        s.rejoined = undefined
      }
    }
    return r
  }
  /** syncing a server: a removal of its identity is recorded when learned (the first after its own last event there;
   * of several, the earliest in the DAG) */
  sync(w: World) {
    const s = this.srv(w)
    if (s.left && !s.rejoined) return
    const S = w.state()
    if (S.facts.mem.has(this.ik) || S.facts.pending.has(this.ik)) return
    const lastOwn = [...s.own].filter(id => w.ref.admitted(id))
    const after = (id: string) => !lastOwn.some(o => o === id || w.ref.anc(o).has(id))
    const rem = w.ref.order.filter(id => {
      const e = w.ref.ev(id)
      return (e.t === 'kick' || e.t === 'ban') && e.c?.to === this.ik && S.eff.has(id) && after(id)
    })
    if (!rem.length) return
    const earliest = rem.filter(x => !rem.some(y => y !== x && w.ref.anc(x).has(y))).sort()[0]
    s.left = earliest
    s.rejoined = undefined
  }
  /** a co-owner signs `G'` (recorded when signed); the upgrade carrying it is its own */
  signG(w: World, g: string) {
    this.srv(w).signedG.add(g)
  }
  ownUpgrade(w: World, id: string) {
    const e = w.ref.ev(id),
      s = this.srv(w)
    return e.t === 'upgrade' && (s.own.has(id) || s.signedG.has(e.c?.g))
  }
  lose(dev: string) {
    this.lost.add(dev)
  }

  // ------------------------------------------------------------ records
  /**
   * The recovery, reset or restore flow makes record n+1 (the phrase is at hand until `endFlow`). The keep is the devices
   * it keeps; for every server on its list where no device it keeps can post (its own chain there holds the recorded
   * leave), the record also keeps a fresh posting device (r8e completeness review M1: a fallback device is one the
   * record names; mutant `cl-fresh-unkept`).
   */
  recover(o: {
    maker: string
    keep: string[]
    pk: string
    rk?: string
    worlds?: World[]
    fetched?: boolean
  }): ChainRec {
    // resetting on one device (§1.7; r8d attack review M2, r8e completeness review M7): a reset is refused unless the flow
    // fetched the identity's head (from a server, its other devices, or a contact's `yours` echo), or the head's keep and
    // certificates name only this device (a lone device); "Reset only on one device." (mutant `cl-reset-unfetched`)
    if (o.rk !== undefined && o.fetched === false && MUT !== 'cl-reset-unfetched') {
      const lone =
        this.keepOf().every(d => d === o.maker) &&
        [...this.certs.keys()].filter(d => this.held(d)).every(d => d === o.maker)
      if (!lone) throw new Error('Reset only on one device.')
    }
    const n = this.recs.length + 1
    const keep = [...o.keep]
    if (!keep.includes(o.maker)) keep.unshift(o.maker)
    const fresh: string[] = []
    if (MUT !== 'cl-fresh-unkept')
      for (const w of o.worlds ?? []) {
        const s = this.srvs.get(w)
        if (!s?.left || s.rejoined) continue
        const E = w.ref.ev(s.left)
        const can = keep.some(d => !this.lost.has(d) && this.chainOk(w, d, new Set([s.left!])))
        if (!can && E) {
          const f = `${this.ik}1${1 + fresh.length}`
          if (!keep.includes(f)) {
            keep.push(f)
            fresh.push(f)
          }
        }
      }
    const rec: ChainRec =
      o.rk !== undefined
        ? { n, prev: this.headD(), by: this.rkNow(), rk: o.rk, pk: o.pk, keep }
        : { n, prev: this.headD(), by: this.rkNow(), pk: o.pk, keep }
    this.adopt(rec, o.maker)
    this.freshKept = fresh
    for (const f of fresh) this.certs.set(f, [o.pk])
    return rec
  }
  /** adopt a record made elsewhere by the user (the template's own), in the flow */
  adopt(rec: ChainRec, maker: string) {
    this.recs.push(rec)
    this.maker = maker
    this.phrase = true
    this.freshKept = []
    for (const d of rec.keep ?? []) {
      const c = this.certs.get(d) ?? []
      this.certs.set(d, [rec.pk!, ...c.filter(x => x !== rec.pk)])
    }
    if (!this.certs.has(maker)) this.certs.set(maker, [rec.pk!])
    for (const d of [...this.certs.keys()]) if (!(rec.keep ?? []).includes(d)) this.lost.add(d)
  }
  endFlow() {
    this.phrase = false
  }
  /** a fresh device certified (v2) under the head's primary */
  certify(dev: string) {
    this.certs.set(dev, [this.prim()])
    this.lost.delete(dev)
    return dev
  }

  // ------------------------------------------------------------ reading a server
  /** the records of its identity in `w` the client didn't make: rotations, certificates, revocations, introductions,
   * and upgrades carrying its signature that it didn't sign. Not those in the past of a join of its own: its join
   * settled them (the revocations at the join dropped every device live there that the head neither keeps nor
   * certified), so a later posting sits after that join, where it is a member (mutant `cl-trust-nojoin`: they stay
   * untrusted, and after its own rejoin the client posts before it, where it is no member) */
  foreign(w: World): Set<string> {
    const s = this.srv(w),
      out = new Set<string>()
    const settled = new Set<string>()
    if (MUT !== 'cl-trust-nojoin')
      for (const j of s.own)
        if (w.ref.admitted(j) && w.ref.ev(j).t === 'join')
          for (const x of w.ref.anc(j)) settled.add(x)
    for (const id of w.ref.order) {
      if (settled.has(id)) continue
      const e = w.ref.ev(id)
      if (e.t === 'upgrade') {
        const sg = e.c?.sigs
        if (sg && typeof sg === 'object' && Object.hasOwn(sg, this.ik) && !this.ownUpgrade(w, id))
          out.add(id)
        continue
      }
      if (e.a !== this.ik || s.own.has(id)) continue
      // a join it didn't make is the thief's (a rejoin from a live device too)
      if (
        e.t === 'primary_rotate' ||
        e.t === 'device_add' ||
        e.t === 'device_revoke' ||
        e.t === 'join'
      )
        out.add(id)
    }
    return out
  }
  /** the device's own latest event in `w` holds none of `bad` (and isn't one) */
  chainOk(w: World, dev: string, bad: Set<string>): boolean {
    const own = w.latestOwn(dev)
    if (!own || !w.ref.admitted(own.id)) return true
    if (bad.has(own.id)) return false
    for (const b of bad) if (w.ref.anc(own.id).has(b)) return false
    return true
  }
  /** the chain records `w` holds for the identity, by digest */
  heldIn(w: World): Set<string> {
    const bd = w.state().BD?.get(this.ik)
    return new Set((bd?.chain ?? []).map(r => recDigest(r)))
  }
  missingIn(w: World): ChainRec[] {
    const h = this.heldIn(w)
    return this.recs.filter(r => !h.has(recDigest(r)))
  }
  /** the heads of the events an honest client may cite whose past holds none of `bad`; LIM.ap at most */
  headsWithout(w: World, bad: Set<string>): string[] {
    const ex = w.excluded()
    const ok = w.ref.order.filter(
      id =>
        w.ref.admitted(id) &&
        !ex.has(id) &&
        !bad.has(id) &&
        ![...bad].some(b => w.ref.anc(id).has(b))
    )
    return this.cap(w, w.heads(ok))
  }
  cap(w: World, hs: string[]) {
    if (hs.length <= LIM.ap) return hs
    const at = new Map(w.ref.order.map((id, i) => [id, i]))
    return [...hs].sort((x, y) => at.get(y)! - at.get(x)!).slice(0, LIM.ap)
  }
  frontier(w: World, ids: string[]) {
    return w.heads([...w.closure(ids)])
  }
  /** the counting upgrades the client signed */
  ownCounting(w: World) {
    return w.state().facts.upgraded.filter(u => this.ownUpgrade(w, u))
  }

  // ------------------------------------------------------------ links and delivery
  /** the link an up-to-date member gives `dev`'s session for event `e`: the best over its certificates. `gate`: the
   * member's state the session meets (a second client that didn't see the first carrier reaches a member that didn't
   * either; by default the member holds everything) */
  linkFor(w: World, dev: string, e?: Ev, gate?: Gate): Link {
    const S = gate?.S ?? w.state(),
      ids = gate?.ids ?? w.ref.order
    let best: Link = 'none'
    for (const cert of this.certs.get(dev) ?? [this.prim()]) {
      const L = linkOf(S, w.ref, ids, this.ik, dev, cert, this.recs) as Link
      if (e && accepts(S, L, e, this.ik, this.recs)) return L
      if (rankL(L) > rankL(best)) best = L
    }
    return e ? 'none' : best
  }
  /** build the event and deliver it over the link the poster's session gets; refused delivery is recorded too */
  deliver(w: World, dev: string, t: T, c: any, o: Opts, bullet: string, gate?: Gate) {
    const e = withLim(w.ref.lim, () => w.build(dev, t, c, o))
    const L = this.linkFor(w, dev, e, gate)
    const s = this.srv(w)
    const p: Posting = { srv: s.name, dev, t, bullet, link: L, delivered: false, by: c?.by }
    this.postings.push(p)
    // what the links must not give (§3.7; read by O15-link): a device the user lost, outside the head's keep and
    // certified only under replaced primaries, gets no push link by presenting the user's records (mutant
    // `link-push-trust`); a push link carries nothing but the identity's rotations and joins with those records (mutant
    // `push-accept-any`)
    {
      const Sg = gate?.S ?? w.state(),
        ids = gate?.ids ?? w.ref.order
      for (const d of this.lost) {
        if (this.keepOf().includes(d)) continue
        if (
          (this.certs.get(d) ?? []).some(
            k => k !== this.prim() && linkOf(Sg, w.ref, ids, this.ik, d, k, this.recs) === 'push'
          )
        )
          p.flaw = `the lost device ${d} gets a push link by presenting the user's records`
      }
      if (
        L === 'push' &&
        pushOk(Sg, { ...e, id: '~probe', t: 'mark', c: {} } as Ev, this.ik, this.recs)
      )
        p.flaw =
          'the push link accepts an event that is no rotation or join carrying the presented records'
    }
    if (L === 'none') return { e, v: undefined as any, link: L, p }
    w.all.push(e)
    w.ref.receive(e)
    const v = w.ref.status.get(e.id)!
    p.delivered = true
    p.id = e.id
    p.verdict = v.s === 'A' ? 'A' : `R:${(v as any).why ?? ''}`
    if (v.s === 'A') s.own.add(e.id)
    // a rate limit of its own (W3(a), W3(c)'s day caps): the client waits a day and signs it again once
    if (
      v.s === 'R' &&
      /^W3[ac]$/.test((v as any).why ?? '') &&
      this.wait &&
      !bullet.endsWith('-retry')
    ) {
      p.bullet = `${bullet}-try`
      this.wait(LIM.day)
      return this.deliver(w, dev, t, c, { ...o, ts: this.clock() }, `${bullet}-retry`, gate)
    }
    return { e, v, link: L, p }
  }

  // ------------------------------------------------------------ the posting procedure
  /** the signer of a rotation carrying the records here: the recovery key in an owned server and in the flow, else an
   * extension signed by the head's primary */
  signer(w: World): string {
    const s = this.srv(w)
    if (s.owner && MUT !== 'cl-owned-ext' && !this.declined) return this.rkNow()
    return this.phrase ? this.rkNow() : this.prim()
  }
  /** the poster for a rotation at `ap`: maker, other kept devices, the record's fresh posting device, a fresh device
   * certified under the new primary. `bad`: what its own chain must not hold */
  poster(w: World, ap: string[], bad: Set<string>, fixed = false): string | undefined {
    const B = w.closure(ap)
    const St = w.ref.evalSet(w.ref.order.filter(id => B.has(id)))
    const now = w.state()
    const keep = this.keepOf()
    const order = [
      ...new Set([
        ...(this.maker ? [this.maker] : []),
        ...keep.filter(d => !this.freshKept.includes(d)),
        ...this.freshKept,
      ]),
    ]
    for (const d of order) {
      if (!this.held(d)) continue
      if (MUT !== 'cl-poster-dropped' && (St.facts.revoked.has(d) || now.facts.revoked.has(d)))
        continue
      // at a position the bullet fixes (a merge), the device's own latest event must be inside it
      if (fixed) {
        const own = w.latestOwn(d)
        if (own && w.ref.admitted(own.id) && !B.has(own.id)) continue
      } else if (!this.chainOk(w, d, bad)) continue
      return d
    }
    // a fresh device certified under the head's primary (an extension; in an owned server the recovery key signs it)
    for (let i = 31; i < 40; i++) {
      const f = `${this.ik}${i}`
      if (w.ref.order.some(id => w.ref.ev(id).dev === f)) continue
      return this.certify(f)
    }
    return undefined
  }
  /** the rotation's content at `ap` from `dev`: the record's devices live there other than the poster (devCap), the
   * missing records, and watermarks covering every device it drops (through `through` for its device) */
  rotation(w: World, dev: string, ap: string[], recs: ChainRec[], by: string, through?: Ev) {
    const B = w.closure(ap)
    const Sb = w.ref.evalSet(w.ref.order.filter(id => B.has(id)))
    const live = [...(Sb.facts.devs.get(this.ik) ?? [])]
    let keep = live
      .filter(v => this.keepOf().includes(v) && (v !== dev || MUT === 'cl-keep-poster'))
      .sort()
    if (MUT === 'cl-keep-poster' && live.includes(dev) && !keep.includes(dev)) keep.push(dev)
    keep = keep.slice(0, Math.max(0, LIM.devCap - 1))
    const probe = {
      id: '~probe',
      t: 'primary_rotate',
      a: this.ik,
      dev,
      seq: 0,
      ap,
      ts: 0,
      c: { keep },
    } as Ev
    const drops = droppedBy(probe, [...B], w.ref)
    const seen: Record<string, number> = {}
    for (const v of drops) {
      let m = -1
      for (const id of B) {
        const e = w.ref.ev(id)
        if (e.dev === v) m = Math.max(m, e.seq)
      }
      if (through && through.dev === v && MUT !== 'cl-wm-noleave') m = Math.max(m, through.seq)
      seen[v] = m
    }
    return { c: { by, chain: recs, keep, seen }, drops }
  }
  /** post a rotation carrying the missing records at `ap` (`bad`: what the poster's chain must not hold). `race` with
   * `same`: a second client of the user that didn't see the first carrier posts the records it carried, from `race` */
  rotate(
    w: World,
    ap0: string[],
    bullet: string,
    bad: Set<string>,
    through?: Ev,
    race?: string,
    fixed = false,
    same?: ChainRec[],
    gate?: Gate
  ) {
    const s = this.srv(w)
    if (!same && !this.missingIn(w).length) return undefined
    const owned = s.owner
    const dev = race ?? this.poster(w, ap0, bad, fixed)
    if (!dev) {
      this.postings.push({
        srv: s.name,
        dev: '',
        t: 'primary_rotate',
        bullet,
        link: 'none',
        delivered: false,
      })
      return undefined
    }
    // a fresh device the record doesn't keep: an extension signed by the head's primary (r8e completeness review M1);
    // in a server where the identity is a genesis owner the carrier must be signed by the recovery key, so the client
    // signs a new record that keeps that device too (the phrase is at hand there) and posts both. Mutant
    // `cl-fresh-unkept`: the fresh device signs with the recovery key outside the record's keep
    let by = this.signer(w)
    if (!this.keepOf().includes(dev) && MUT !== 'cl-fresh-unkept') {
      if (race) {
        if (owned) return undefined
        by = this.prim()
      } else if (owned && !this.declined && MUT !== 'cl-owned-ext') {
        const h = this.head()
        this.recover({
          maker: dev,
          keep: [...(h?.keep ?? []), dev].slice(-8),
          pk: `${this.prim()}f`,
        })
        by = this.rkNow()
      } else by = this.prim()
    }
    const recs = same ?? this.missingIn(w)
    let ap = [...ap0]
    const own = w.latestOwn(dev)
    if (own && w.ref.admitted(own.id) && !w.closure(ap).has(own.id))
      ap = this.cap(w, this.frontier(w, [...ap, own.id]))
    const { c, drops } = this.rotation(w, dev, ap, recs, by, through)
    for (const u of this.ownCounting(w)) s.keepUp.add(u)
    for (const d of drops) s.drops.add(d)
    return this.deliver(w, dev, 'primary_rotate', c, { ap, ts: this.clock() }, bullet, gate)
  }
  /** the trusted position (§1.7): the heads of the events an honest client may cite whose past holds no record of its
   * identity it didn't make, never before an upgrade it signed */
  trustedAp(w: World): string[] {
    let ap = this.headsWithout(w, this.foreign(w))
    const us = this.ownCounting(w).filter(u => !w.closure(ap).has(u))
    if (us.length) ap = this.cap(w, this.frontier(w, [...ap, ...us]))
    return ap
  }

  /**
   * The state-triggered posting in `w` (§1.7 "After a recovery"): what the server lacks of the client's chain, by the
   * bullet that applies first. `race`: a second device of the user posts the same record at the same position
   * concurrently (two clients that didn't see each other: siblings). Returns the postings.
   */
  post(w: World, o: { race?: string; at?: string[]; join?: Opts } = {}): any[] {
    const out = this.postOnce(w, o)
    if (MUT !== 'cl-owned-join') out.push(...this.ownedRk(w))
    return out
  }
  /**
   * A server where the identity is a genesis owner must hold a carrier of the client's head that is a rotation signed by
   * the recovery key (ruling 2: only such a carrier kills a stolen old device's backdated upgrade, §2.5). Where the
   * server holds the head through other carriers only (its own join carried it: an owner that never joined, or rejoined
   * where its list had lost the entry; its signature on a transfer carried it; the user declined the phrase before, so
   * the carrier is an extension; a stolen device of the current epoch posted it as an extension first), the client signs
   * a new record with the phrase (the same devices, a new primary) and posts it there signed by the recovery key, by the
   * bullet that applies: a second carrier of a record the server holds would change nothing (W6). A head the genesis
   * carries needs none (no event is concurrent with the genesis). In the flow the phrase is at hand; outside it the
   * client asks for it (`declined`: the stated residual until the next start). Mutant `cl-owned-join`: only the sweep
   * does this, never the flow, a rejoin or a later sync, so until the next start a stolen old primary's backdated
   * transfer counts
   */
  ownedRk(w: World, label = 'owned'): any[] {
    const s = this.srv(w),
      out: any[] = []
    if (!s.owner || this.declined || !this.recs.length || w.frozenIn(this.ik)) return out
    const hd = this.headD()
    if (!this.heldIn(w).has(hd)) return out // the state-triggered posting carries it, signed by the recovery key here
    const has = (rs: unknown) => Array.isArray(rs) && rs.some(r => recDigest(r) === hd)
    let safe = false
    for (const id of w.ref.order) {
      const e = w.ref.ev(id)
      if (!w.ref.admitted(id)) continue
      if (
        e.t === 'genesis'
          ? has(carriedOf(e, this.ik))
          : e.a === this.ik &&
            e.t === 'primary_rotate' &&
            typeof e.c?.by === 'string' &&
            e.c.by.startsWith('rk') &&
            has(e.c?.chain)
      ) {
        safe = true
        break
      }
    }
    if (safe) return out
    // only where a rotation of its own can be posted (on its list, an archived S, or a member): a new record that no
    // bullet could carry would be spent for nothing
    const S = w.state()
    if (!((s.left && !s.rejoined) || S.facts.upgraded.length || S.facts.mem.has(this.ik)))
      return out
    const had = this.phrase
    const keep = this.keepOf().filter(d => this.held(d))
    // (at the chain's cap there is no record left to sign: the app offers the move, §1.7)
    if (!keep.length || this.recs.length >= CHAIN_MAX) return out
    this.recover({
      maker: this.maker && this.held(this.maker) ? this.maker : keep[0],
      keep,
      pk: `${this.prim()}s`,
    })
    for (const x of this.postOnce(w)) {
      x.p.bullet = `${label}-${x.p.bullet}`
      out.push(x)
    }
    if (!had) this.endFlow()
    return out
  }
  postOnce(w: World, o: { race?: string; at?: string[]; join?: Opts } = {}): any[] {
    const s = this.srv(w)
    const S = w.state()
    const out: any[] = []
    if (w.frozenIn(this.ik)) return out
    if (!this.missingIn(w).length) return out
    // the race: the second client's session meets a member that hasn't the first carrier yet
    const gate: Gate | undefined = o.race ? { S, ids: [...w.ref.order] } : undefined
    const bd = S.BD?.get(this.ik)
    if (bd && bd.st !== 'protected' && bd.void !== 'chain') return out // unprotected there (void by ik): nothing to carry
    // 2. left: the recorded leave or removal (it replaces the member, older-epoch and upgraded bullets)
    if (s.left && !s.rejoined && MUT !== 'cl-left-heads') {
      const E = w.ref.ev(s.left)
      let anchor = E
      if (MUT === 'cl-left-latest') {
        const outs = w.ref.order.filter(id => {
          const e = w.ref.ev(id)
          return (
            w.ref.admitted(id) &&
            ((e.t === 'leave' && e.a === this.ik) ||
              ((e.t === 'kick' || e.t === 'ban') && e.c?.to === this.ik))
          )
        })
        const latest = outs
          .filter(x => !outs.some(y => y !== x && w.ref.anc(y).has(x)))
          .sort()
          .pop()
        if (latest) anchor = w.ref.ev(latest)
      }
      let ap = [...anchor.ap]
      // I1: a counting upgrade the client signed that the parents don't hold: the frontier of the parents and it
      if (MUT !== 'cl-upg-atleave') {
        const us = this.ownCounting(w).filter(u => !w.closure(ap).has(u))
        if (us.length) ap = this.cap(w, this.frontier(w, [...ap, ...us]))
      }
      const bad = new Set([anchor.id])
      const r = this.rotate(w, ap, 'left', bad, anchor.t === 'leave' ? anchor : undefined)
      if (r) out.push(r)
      if (r && o.race) {
        const r2 = this.rotate(
          w,
          ap,
          'left',
          bad,
          anchor.t === 'leave' ? anchor : undefined,
          o.race,
          false,
          r.e.c.chain,
          gate
        )
        if (r2) out.push(r2)
      }
      return out
    }
    const bad = this.foreign(w)
    const trusted = () => {
      if (MUT === 'cl-member-heads' || (S.facts.upgraded.length && MUT === 'cl-upg-heads'))
        return this.cap(w, w.heads(w.ref.order.filter(id => !w.excluded().has(id))))
      let ap = this.headsWithout(w, bad)
      const us = this.ownCounting(w).filter(u => !w.closure(ap).has(u))
      if (us.length) ap = this.cap(w, this.frontier(w, [...ap, ...us]))
      return ap
    }
    // 3. archived
    if (S.facts.upgraded.length) {
      const ap = o.at ?? trusted()
      const r = this.rotate(
        w,
        ap,
        'archived',
        MUT === 'cl-upg-heads' ? new Set() : bad,
        undefined,
        undefined,
        !!o.at
      )
      if (r) out.push(r)
      if (r && o.race) {
        const r2 = this.rotate(w, ap, 'archived', bad, undefined, o.race, false, r.e.c.chain, gate)
        if (r2) out.push(r2)
      }
      return out
    }
    // 4. older epoch: a member through an introduction it didn't make
    const intro = this.foreignIntro(w)
    if (intro && S.facts.mem.has(this.ik)) {
      const add = this.addOf(w, intro)
      const besideAt = add ? [add] : s.owner ? [...w.ref.ev(intro).ap] : undefined
      // (an add that names a head its chain doesn't reach can't carry its join: §2.2)
      const reach = new Set([this.crD(), ...this.recs.map(r => recDigest(r))])
      const addHead = add ? w.ref.ev(add).c?.head : undefined
      const usable = besideAt && (typeof addHead !== 'string' || reach.has(addHead))
      const beside = () => {
        const j = usable ? this.join(w, { ap: besideAt }, 'beside') : undefined
        if (j) out.push(j)
        return j
      }
      const rotateAt = () => {
        const ap =
          MUT === 'cl-older-heads'
            ? this.cap(w, w.heads(w.ref.order.filter(id => !w.excluded().has(id))))
            : [intro]
        const r = this.rotate(
          w,
          ap,
          'older-epoch',
          MUT === 'cl-older-heads' ? bad : new Set([...bad].filter(x => x !== intro))
        )
        if (r) out.push(r)
        if (r && o.race && r.v?.s === 'A') {
          const r2 = this.rotate(
            w,
            ap,
            'older-epoch',
            new Set(),
            undefined,
            o.race,
            false,
            r.e.c.chain,
            gate
          )
          if (r2) out.push(r2)
        }
        return r
      }
      // the records that introduction carried: on the client's own chain (a stolen device of an older epoch that used the
      // invite or rejoined: the rotation at it adopts the membership and cuts what that device did afterwards), or not
      // (a leaked old phrase's branch, which the client's records kill or freeze: a rotation there would kill the join
      // the membership rests on, so the client joins beside it, at the same add, a genesis owner, who needs none, at that
      // introduction's parents, and the identity stays a member). Each falls back to the other where it is refused
      const mine = new Set([this.crD(), ...this.recs.map(r => recDigest(r))])
      const dead = carriedOf(w.ref.ev(intro), this.ik).some(r => !mine.has(recDigest(r)))
      if (dead && usable && MUT !== 'cl-older-nojoin') {
        const j = beside()
        if (!j || j.v?.s !== 'A') {
          if (j?.p) j.p.bullet = 'beside-try'
          rotateAt()
        }
      } else {
        const r = rotateAt()
        if (!r || r.v?.s !== 'A') {
          if (r?.p) r.p.bullet = 'older-epoch-try'
          beside()
        }
      }
      return out
    }
    // 5. member
    if (S.facts.mem.has(this.ik)) {
      const ap = o.at ?? trusted()
      const r = this.rotate(w, ap, 'member', bad, undefined, undefined, !!o.at)
      if (r) out.push(r)
      if (r && o.race) {
        const r2 = this.rotate(w, ap, 'member', bad, undefined, o.race, false, r.e.c.chain, gate)
        if (r2) out.push(r2)
      }
      return out
    }
    // 6. a pending invite (or a successor's carry-over add): a join carrying the chain
    if (S.facts.pending.has(this.ik)) {
      const j = this.join(w, o.join ?? {}, 'join')
      if (j) out.push(j)
    }
    return out
  }
  /**
   * The flow after its record is made (a recovery, a reset or a restore): the state-triggered posting in every server
   * the client knows whose state holds the identity, the servers where it is a genesis owner first, while the phrase is
   * at hand; then the phrase leaves memory. A server the flow didn't reach (no peer online, or learned later) is the
   * sweep's: there an owned server asks for the phrase again. Mutant `cl-flow-order`: the phrase leaves before the owned
   * servers are posted (their rotations are then extensions)
   */
  flow(worlds: World[], o: { race?: string; at?: string[]; join?: Opts } = {}): any[] {
    const out: any[] = []
    const ws = [...worlds].sort((a, b) => Number(this.srv(b).owner) - Number(this.srv(a).owner))
    if (MUT === 'cl-flow-order') {
      this.endFlow()
      this.declined = true
    }
    const n0 = this.recs.length
    for (const w of ws) {
      this.sync(w)
      out.push(...this.post(w, o))
    }
    // a record the pass itself made (an owned server whose carrier was a join) goes to the servers before it too
    if (this.recs.length > n0) for (const w of ws) out.push(...this.post(w))
    this.endFlow()
    return out
  }
  /** the start-up sweep over every server the client knows (each identity's app runs its own when it starts) */
  sweepAll(worlds: World[]): any[] {
    const out: any[] = []
    for (const w of worlds) {
      this.sync(w)
      out.push(...this.sweep(w))
    }
    return out
  }
  /**
   * The user rejoins a server on its list, once a member's new add (or a code) made it pending (a genesis owner's join
   * needs no add to be admitted, but it has no link of its own, §3.7): what the server lacks of its chain goes first, at
   * the recorded leave or removal (the left bullet), then the join from a device it holds, with the revocations at the
   * join; the entry leaves the list. Mutant `cl-rejoin-first`: the join alone, on the heads: what a dropped device did
   * since the recorded event stays
   */
  rejoin(w: World, o: Opts = {}): any[] {
    const out: any[] = MUT === 'cl-rejoin-first' ? [] : [...this.postOnce(w)]
    // (where the list had lost the entry, the state-triggered posting was the join itself)
    if (!out.some(x => x.e?.t === 'join' && x.v?.s === 'A')) {
      const j = this.join(w, o, 'rejoin')
      if (j) out.push(j)
    }
    // an owned server: its join carried the head, so a carrier signed by the recovery key follows (`ownedRk`)
    if (MUT !== 'cl-owned-join') out.push(...this.ownedRk(w))
    return out
  }
  /**
   * N26 (f) (§1.7): a record of its own inert by key death through a carrier it didn't post (a stolen primary of a later
   * record posted that record's chain as an extension concurrent with it): the client treats the current primary as
   * stolen and recovers with the phrase (a new record keeping its devices), positioned at the dead record (its frontier
   * with the record's carrier, concurrent with the thief's carrier, which then dies by epoch death), with the dead
   * record's watermarks. Mutant `cl-n26f-heads`: on the trusted heads instead, where the drops it repeats come too late.
   */
  repairKeyDeath(w: World, pk: string) {
    const s = this.srv(w),
      S = w.state()
    const dead = w.ref.order.filter(id => {
      const e = w.ref.ev(id)
      if (!s.own.has(id) || e.t !== 'primary_rotate' || !S.X.has(id)) return false
      const by = e.c?.by
      if (typeof by !== 'string' || !by.startsWith('rk')) return false
      // a carrier it didn't post of a key change signed by that key, concurrent with it
      return w.ref.order.some(
        c =>
          !s.own.has(c) &&
          w.ref.admitted(c) &&
          !w.ref.anc(c).has(id) &&
          !w.ref.anc(id).has(c) &&
          c !== id &&
          carriedOf(w.ref.ev(c), this.ik).some(r => r.by === by && r.rk !== undefined)
      )
    })
    if (!dead.length) return []
    const d = w.ref.ev(dead[0])
    // only where it matters: a device the dead record dropped is live again, or an event of one past its watermark counts
    // (a later record of its own that drops the same devices already covers it)
    const fixedT = (t: string) => t === 'genesis' || t === 'device_revoke' || t === 'primary_rotate'
    const dd = droppedBy(d, w.ref.order, w.ref)
    const harm =
      dd.some(v => !S.facts.revoked.has(v)) ||
      w.ref.order.some(id => {
        const e = w.ref.ev(id)
        return (
          dd.includes(e.dev) &&
          e.seq > ((d.c?.seen?.[e.dev] ?? -1) as number) &&
          !fixedT(e.t) &&
          !S.X.has(id) &&
          !S.tail.has(id)
        )
      })
    if (!harm) return []
    // positioned at the dead record, after the client's own later rotations there (one concurrent with them would
    // contest them), so concurrent with the thief's carrier; the poster: a device whose own latest event is inside that
    // position (the dead record's own device), else a fresh device the new record keeps
    const later = w.ref.order.filter(
      id =>
        s.own.has(id) &&
        w.ref.ev(id).t === 'primary_rotate' &&
        w.ref.anc(id).has(d.id) &&
        !S.X.has(id)
    )
    const ap =
      MUT === 'cl-n26f-heads'
        ? this.trustedAp(w)
        : this.cap(w, this.frontier(w, [...d.ap, d.id, ...later]))
    const inPos = (x: string) => {
      const own = w.latestOwn(x)
      return !own || w.closure(ap).has(own.id)
    }
    const dev =
      this.held(d.dev) && inPos(d.dev) && !S.facts.revoked.has(d.dev) ? d.dev : `${this.ik}12`
    const keep = [...new Set([...this.keepOf().filter(x => this.held(x)), dev])]
    this.recover({ maker: dev, keep, pk })
    const B = w.closure(ap)
    const Sb = w.ref.evalSet(w.ref.order.filter(id => B.has(id)))
    const have = new Set((Sb.BD?.get(this.ik)?.chain ?? []).map(r => recDigest(r)))
    const recs = this.recs.filter(r => !have.has(recDigest(r)))
    const { c, drops } = this.rotation(w, dev, ap, recs, this.rkNow())
    // the dead record's watermarks where they reach further (what it disowned is disowned again)
    for (const [v, m] of Object.entries((d.c?.seen ?? {}) as Record<string, number>))
      if (drops.includes(v) && m >= (c.seen[v] ?? -1)) c.seen[v] = m
    for (const x of drops) s.drops.add(x)
    const r = this.deliver(w, dev, 'primary_rotate', c, { ap, ts: this.clock() }, 'n26f')
    this.endFlow()
    return [r]
  }
  /** a join of its identity it didn't make that the membership rests on (the earliest), where no join of its own after
   * its own last leave or recorded removal is in force: the older-epoch bullet */
  foreignIntro(w: World): string | undefined {
    const s = this.srv(w),
      S = w.state()
    const live = (id: string) => w.ref.admitted(id) && !S.X.has(id) && !S.tail.has(id)
    // the joins the membership rests on (§3.2 Mem): live, with every effective kick, ban or leave of it in their past
    const rems = w.ref.order.filter(id => {
      const e = w.ref.ev(id)
      return (
        S.eff.has(id) &&
        (((e.t === 'kick' || e.t === 'ban') && e.c?.to === this.ik) ||
          (e.t === 'leave' && e.a === this.ik))
      )
    })
    const rests = (id: string) => live(id) && rems.every(r => w.ref.anc(id).has(r))
    const joins = w.ref.order.filter(id => {
      const e = w.ref.ev(id)
      return e.a === this.ik && e.t === 'join' && rests(id)
    })
    if (joins.some(id => s.own.has(id))) return undefined
    const theirs = joins.filter(id => !s.own.has(id))
    return theirs.filter(x => !theirs.some(y => y !== x && w.ref.anc(x).has(y)))[0]
  }
  addOf(w: World, j: string): string | undefined {
    const B = w.ref.anc(j)
    return w.ref.order
      .filter(id => B.has(id) && w.ref.ev(id).t === 'add' && w.ref.ev(id).c?.to === this.ik)
      .pop()
  }
  /** the client crashes between a join and its revocations (the sweep repeats them on the next start) */
  crash = false
  /**
   * A join carrying the creation record and the chain from a device it holds, then, in the same signing transaction,
   * a `device_revoke` under the head's primary at the join for every device of its identity live in B(join) that the head
   * neither keeps nor certified (`seen` its last seq there). Positioned where `o.ap` says (the add, or the heads).
   */
  join(w: World, o: Opts = {}, bullet = 'join') {
    const s = this.srv(w)
    // an add naming a head its chain doesn't reach: the join is positioned on the heads of the events it may cite that
    // don't have that add in their past (it still needs a usable add there)
    if (!o.ap && MUT !== 'cl-join-heads') {
      const reach = new Set([this.crD(), ...this.recs.map(r => recDigest(r))])
      const bad = new Set(
        w.ref.order.filter(id => {
          const e = w.ref.ev(id)
          return (
            e.t === 'add' &&
            e.c?.to === this.ik &&
            typeof e.c?.head === 'string' &&
            !reach.has(e.c.head)
          )
        })
      )
      if (bad.size) o = { ...o, ap: this.headsWithout(w, bad) }
    }
    const dev =
      this.poster(w, o.ap ?? w.capHeads(this.maker ?? this.keepOf()[0]), new Set()) ?? this.maker!
    // the join carries the creation record and the chain (mutant `cl-join-nochain`: the creation record alone, certified
    // by the head's primary all the same)
    const c = {
      rk: this.cr.rk,
      ...(this.cr.pk !== 'p0' ? { pk: this.cr.pk } : {}),
      ...(this.recs.length && MUT !== 'cl-join-nochain' ? { chain: [...this.recs] } : {}),
      by: this.prim(),
    }
    const op = this.vouch
      ? this.vouch(w, dev, { ...o, ts: this.clock() })
      : { ...o, ts: this.clock() }
    const r = this.deliver(w, dev, 'join', c, op, bullet)
    if (r.v?.s === 'A') {
      s.rejoined = r.e.id
      if (!this.crash) this.revokeAt(w, r.e.id)
      this.crash = false
    }
    return r
  }
  /** the revocations at a join that brought the head (and the sweep's repetition of them) */
  revokeAt(w: World, at: string) {
    if (MUT === 'cl-no-revoke' || env('ACL_GEN_NOREVOKE')) return []
    const out: any[] = []
    const lf = w.ref.rec(at).local.facts
    const S = w.state()
    for (const v of [...(lf.devs.get(this.ik) ?? [])].sort()) {
      if (
        this.keepOf().includes(v) ||
        (this.certs.get(v) ?? []).includes(this.prim()) ||
        v === w.ref.ev(at).dev
      )
        continue
      if (S.facts.revoked.has(v)) continue
      let m = -1
      for (const id of w.closure([at])) {
        const e = w.ref.ev(id)
        if (e.dev === v) m = Math.max(m, e.seq)
      }
      out.push(
        this.deliver(
          w,
          w.ref.ev(at).dev,
          'device_revoke',
          { by: this.prim(), dev: v, seen: m },
          { ap: [at], ts: this.clock() },
          'revoke'
        )
      )
    }
    return out
  }
  /**
   * The start-up sweep (§1.7): the state-triggered posting again, and in a server where the identity is a member, the
   * revocations at its first event there that carried the head (a crash between a join and its revocations closes here).
   * In an owned server whose only carrier is not signed by the recovery key it asks for the phrase.
   */
  sweep(w: World) {
    if (MUT === 'cl-no-sweep') return []
    const s = this.srv(w),
      out: any[] = []
    out.push(...this.postOnce(w))
    // an owned server whose carriers of the head are none signed by the recovery key (the phrase was declined before, or
    // a join carried the head): the sweep asks for the phrase and posts a new record signed by the recovery key
    // (`ownedRk`), concurrent with a stolen device's backdated upgrade
    out.push(...this.ownedRk(w, 'sweep'))
    const S = w.state()
    if (S.facts.mem.has(this.ik)) {
      const hd = this.headD()
      const first = w.ref.order.find(
        id =>
          s.own.has(id) &&
          carriedOf(w.ref.ev(id), this.ik).some(r => recDigest(r) === hd) &&
          w.ref.ev(id).t === 'join'
      )
      if (first) out.push(...this.revokeAt(w, first))
    }
    return out
  }
  /** what the properties read: the postings in `w`, whether each had a link, the recorded event and the drops */
  meta(w: World) {
    const s = this.srv(w)
    return {
      postings: this.postings.filter(p => p.srv === s.name),
      leftAt: s.left,
      leftDrops: [...s.drops],
      keepUp: [...s.keepUp],
    }
  }
}
const rankL = (L: Link) => (L === 'full' ? 3 : L === 'push' ? 2 : L === 'acl' ? 1 : 0)
/** whether a link carries the event: full anything; ACL-only the identity's join, device_add or rotation; push
 * (`pushOk`) its rotation or join carrying the records the session presented */
export function accepts(S: any, L: Link, e: Ev, ik: string, presented: ChainRec[]): boolean {
  if (L === 'full') return true
  if (L === 'acl')
    return e.a === ik && (e.t === 'join' || e.t === 'device_add' || e.t === 'primary_rotate')
  if (L === 'push') return pushOk(S, e, ik, presented)
  return false
}
