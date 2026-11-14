/* eslint-disable */
// @ts-nocheck
// Copy of notes/acl-model-r8f/contacts.ts (the executable reference model of the P2P ACL spec r8f), used only by tests.
// Revision 8 fix round 3 (ruling 10): an executable reference for the prose areas of §1.7 that the server model leaves
// out: a contact's creation-record states, pinning and pending claims (ruling 7), the epoch rule over chains, succession
// claims v1 and v2 (ruling 6), badge checks against heads (completeness review I3) and the restore flow with the account's
// identity record and backup versions (ruling 9). Keys are names, as in model.ts: a record "verifies" when the key it
// names is the one the rule asks for, and `byIk` marks what only the identity key could have signed. Digests stand for the
// SHA-256 of a record's signed fields (its identity, §1.7: unknown fields refuse the record). Built on the reviewers'
// readings (`acl-scratch-r8b-review-full/rv/contacts.ts`, `acl-scratch-r8c-review-attack/c2-contacts.ts`,
// `acl-scratch-verify-r8c-C1/repro.ts`); `contacts.test.ts` holds the R8-* vectors and a fuzz of message orders.

export const CHAIN_MAX = 8
/** mutants of this module (mutants.ts): `ct-none-default`, `ct-qr-none`, `ct-badge-nohead`, `ct-succ-fifo`, `ct-succ2-dead`,
 * `ct-record-truncate`; fix round 4: `ct-backup-evict`, `ct-backup-size`, `ct-cr-unbounded`, `ct-server-pins`,
 * `ct-restore-first`, `ct-restore-frozen`, `ct-succ-nohold`, `ct-succ030-refuse`, `ct-held-unbounded`, `ct-two-cert1`,
 * `ct-succ1-proof`, `ct-succ-nodedupe`; fix round 5: `ct-acc-keep`, `ct-succ-chain-drop`, `ct-held-block`,
 * `ct-held-forever`, `ct-cr-nodedupe`, `ct-restore-rank`, `ct-safety-two`, `ct-backup-nodelete` */
const MUT = (typeof process !== 'undefined' && process.env.ACL_MUT) || ''
export const CLAIMS_MAX = 4
const hash = (s: string) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** the creation record `{v:1, ik, n:0, rk, pk, at}` signed by ik and rk (tag create1); `byIk`/`byRk`: the signatures verify */
export interface CR {
  ik: string
  rk: string
  pk: string
  byIk: boolean
  byRk: boolean
  extra?: Record<string, unknown>
}
/** a chain record n ≥ 1 (tag chain1): signed by `by`, the recovery key in force after `prev`; a reset names `rk`, a removal `rk: ""` */
export interface Rec {
  ik: string
  n: number
  prev: string
  by: string
  pk: string
  keep: string[]
  rk?: string
  extra?: Record<string, unknown>
}
export const crD = (c: CR) => 'c' + hash(JSON.stringify([c.ik, c.rk, c.pk]))
export const recD = (r: Rec) =>
  'k' + hash(JSON.stringify([r.ik, r.n, r.prev, r.by, r.pk, [...r.keep].sort(), r.rk ?? null]))
/** record formats are closed (attack review M4): a field the format doesn't name refuses the record */
export const crOk = (c: CR) => c.byIk && c.byRk && c.pk !== c.ik && c.pk !== '' && !c.extra
export const recOk = (r: Rec) =>
  r.n >= 1 && r.n <= CHAIN_MAX && r.pk !== r.ik && r.pk !== '' && !r.extra

export type Msg =
  | { k: 'cr'; cr: CR }
  | { k: 'rec'; rec: Rec }
  | { k: 'cert1'; ik: string; dk: string; byIk: boolean } // v1 contact certificate, signed by ik (cert1)
  | { k: 'rev1'; ik: string; dk: string; byIk: boolean } // v1 revocation (revoke1)
  | { k: 'profile1'; ik: string; byIk: boolean } // v1 profile (profile1): every legacy hello carries one
  | { k: 'cert2'; ik: string; dk: string; n: number; pk: string; by: string } // v2 certificate under the head's primary
  | { k: 'rev2'; ik: string; dk: string; n: number; pk: string; by: string } // v2 revocation, by that primary or the recovery key
  // fix round 4 (r8d completeness review I3, the verifier's fix): successions are closed formats `{v: 1, old, new, new_cr,
  // at, sig_old, sig_new}` and `{v: 2, old, head, new, new_cr, at, sig_old, sig_new}`, each signature over the tag and the
  // JCS body without the signatures; `newCr` is the `new_cr` field (the record identity of the new identity's creation
  // record), and `new` the creation record that travels beside it (`succ_cr`, or the new identity's hello `keys`). A v1
  // without `new_cr` is 0.3.0's (its `sig_new` by the new `ik`, `byNewIk`): a legacy claim, never applied, and proof that
  // the old `ik` is in use
  | {
      k: 'succ1'
      old: string
      new: CR
      newCr?: string
      byOldIk: boolean
      byNewRk: boolean
      byNewIk?: boolean
    } // a legacy identity moves (old ik, new rk')
  | {
      k: 'succ2'
      old: string
      head: string
      by: string
      chain: Rec[]
      new: CR
      newCr?: string
      byNewRk: boolean
    } // a protected one moves
  | { k: 'badge'; tok: Token }
  | { k: 'profile2'; ik: string; n: number; pk: string; by: string; name: string; updated: number } // v2 profile, by the head's primary
/** what the instance's badge token names (§1.7 item 5; fix round 3: the head it was issued for) */
export interface Token {
  sub: string
  ik: string
  head?: { n: number; d: string }
  iat: number
}
/** where a message came from: a contact code or card the user opened, a hello of a handshake the user accepted, a QR
 * or safety-number check done in person, a server introduction, or a store an older version wrote */
export type Src = 'card' | 'hello' | 'qr' | 'safety' | 'server' | 'carried'
const PINS = new Set<Src>(['qr', 'safety'])
/** fix round 4 (r8d completeness review I2 (c)): the direct sources, the only ones that pin a creation record */
const DIRECT = new Set<Src>(['card', 'hello', 'qr', 'safety'])

/** a succession claim; `legacy`: 0.3.0's v1 (no creation record for the new identity), shown with Verify and Accept */
export interface SuccClaim {
  old: string
  new: string
  cr?: CR
  v: 1 | 2
  head?: string
  by?: string
  direct: boolean
  verified?: boolean
  accepted?: boolean
  legacy?: boolean
  dead?: boolean
}
/** fix round 5 (r8e attack review M2): held v2 claims expire after 30 days */
export const HELD_MS = 30 * 86_400_000

/** a chain (§1.7): attach, chain key death, rival resets, heads */
export function chainOf(cr: CR, recs: Iterable<Rec>) {
  type N = { d: string; n: number; par?: N; r?: Rec; key: string; prim: string; keep?: string[] }
  const root: N = { d: crD(cr), n: 0, key: cr.rk, prim: cr.pk }
  const at = new Map<string, N>([[root.d, root]])
  const pend = new Map<string, Rec>()
  for (const r of recs) if (r.ik === cr.ik && recOk(r)) pend.set(recD(r), r)
  for (let grew = true; grew;) {
    grew = false
    for (const [d, r] of pend) {
      const p = at.get(r.prev)
      if (!p || r.n !== p.n + 1 || r.by !== p.key) continue
      at.set(d, {
        d,
        n: r.n,
        par: p,
        r,
        key: r.rk === undefined ? p.key : r.rk === '' ? r.pk : r.rk,
        prim: r.pk,
        keep: r.keep,
      })
      pend.delete(d)
      grew = true
    }
  }
  const up = (x: N, y: N) => {
    for (let z: N | undefined = y; z; z = z.par) if (z.d === x.d) return true
    return false
  }
  const kcs = [...at.values()].filter(x => x.r && x.r.rk !== undefined)
  const dead = new Set<N>()
  let rival = false
  for (const m of kcs)
    for (const x of at.values()) {
      if (x === m || !x.r || x.r.by !== m.r!.by || up(x, m) || up(m, x)) continue
      dead.add(x)
      if (x.r.rk !== undefined) rival = true
    }
  const alive = (x: N) => {
    for (let z: N | undefined = x; z; z = z.par) if (dead.has(z)) return false
    return true
  }
  const live = [...at.values()].filter(alive)
  const top = Math.max(...live.map(x => x.n))
  const heads = live.filter(x => x.n === top).sort((x, y) => (x.d < y.d ? -1 : 1))
  // a key K is dead when a valid key change signed by K is held (a leaked old phrase is dead after a reset)
  const deadKey = (K: string) => kcs.some(m => m.r!.by === K && alive(m))
  return { at, alive, heads, rival, top, deadKey, up }
}

/** Safety number halves (§1.7; fix round 3, completeness review M5): `safety.ts` hashes VERSION ‖ K ‖ "rchat-p2p", then
 * 5200 times h ‖ K; legacy: VERSION [0, 0] and K = ik; protected: VERSION [0, 1] and K = ik ‖ SHA-256(rk). Here the half
 * is its input, and "scan" stands for the screen that shows no number. */
export const halfOf = (ik: string, rk?: string) => (rk ? `v1:${ik}:${rk}` : `v0:${ik}`)

export class Contact {
  st: 'known' | 'none' | 'unknown'
  cr?: CR
  recs = new Map<string, Rec>()
  certs1 = new Set<string>()
  revs1 = new Set<string>()
  certs2: Extract<Msg, { k: 'cert2' }>[] = []
  revs2: Extract<Msg, { k: 'rev2' }>[] = []
  proof = false // an ik-signed record other than the creation record and the creating device's v1 certificate
  claims: { cr: CR; recs: Rec[] }[] = [] // pending creation-record claims (unknown)
  crOverflow = false // fix round 4 (completeness review I2 (b)): a claim past the cap was dropped
  held: Rec[] = [] // chain records an unknown contact holds for whichever claim is pinned (at most CHAIN_MAX + 1 per claim)
  succ: SuccClaim[] = []
  succOverflow = false
  /** fix round 4 (completeness review I3): v2 claims held unchecked (an unknown contact, or a head it doesn't hold yet);
   * fix round 5 (r8e attack review M2): with the time each was received, for the 30-day expiry */
  succTodo: { m: Extract<Msg, { k: 'succ2' }>; src: Src; at: number }[] = []
  /** the contact's clock (ms), for held claims' expiry */
  now = 0
  warning = ''
  badge?: Token
  badgeTodo: Token[] = []
  profiles2: Extract<Msg, { k: 'profile2' }>[] = []
  cardName?: string
  log: string[] = []
  constructor(
    public ik: string,
    src: Src,
    first: Msg[]
  ) {
    // fix round 3 (ruling 7): a contact is none only with proof that ik is still in use; a source that brings no
    // creation record and no proof gives unknown; a store an older version wrote is unknown
    const cr = first.find(
      (m): m is Extract<Msg, { k: 'cr' }> => m.k === 'cr' && m.cr.ik === ik && crOk(m.cr)
    )
    // fix round 4 (completeness review I2 (c)): only a direct source pins at creation; a server's record is a pending
    // claim, as in recv (mutant `ct-server-pins`)
    this.st =
      src === 'carried'
        ? 'unknown'
        : cr && (DIRECT.has(src) || MUT === 'ct-server-pins')
          ? 'known'
          : first.some(m => this.isProof(m)) || MUT === 'ct-none-default'
            ? 'none'
            : 'unknown'
    if (this.st === 'known') this.cr = cr!.cr
    for (const m of first) if (!(this.st === 'known' && m === cr)) this.recv(m, src)
  }
  /** an ik-signed record other than create1 and cert1 (two distinct v1 certificates count too): a protected identity can
   * make none, since its ik is erased */
  private isProof(m: Msg) {
    if (m.k === 'profile1' || m.k === 'rev1') return m.ik === this.ik && m.byIk
    if (m.k === 'succ1') return MUT !== 'ct-succ1-proof' && m.old === this.ik && m.byOldIk
    if (m.k === 'cert1')
      return (
        MUT !== 'ct-two-cert1' &&
        m.ik === this.ik &&
        m.byIk &&
        this.certs1.size > 0 &&
        !this.certs1.has(m.dk)
      )
    return false
  }
  recv(m: Msg, src: Src) {
    // fix round 5 (r8e attack review M2): held claims expire after 30 days (mutant `ct-held-forever`)
    if (this.succTodo.length && MUT !== 'ct-held-forever')
      this.succTodo = this.succTodo.filter(x => this.now - x.at < HELD_MS)
    if (this.isProof(m) && !this.proof) this.onProof()
    switch (m.k) {
      case 'cr':
        return this.onCr(m.cr, src)
      case 'rec':
        if (m.rec.ik !== this.ik || !recOk(m.rec)) return
        if (this.st === 'known') {
          this.recs.set(recD(m.rec), m.rec)
          if (this.chain()!.rival)
            this.warning = `Someone has ${this.ik}'s backup phrase. Ask them to move to a new identity.`
          this.dropStaleBadge()
          this.retryBadges()
          this.dropDeadSucc()
          this.retrySucc()
        } else if (this.st === 'unknown') this.hold(m.rec) // applied when a claim is pinned (Accept, Verify, a QR)
        return
      case 'cert1':
        if (m.ik === this.ik && m.byIk) this.certs1.add(m.dk)
        return
      case 'rev1':
        if (m.ik === this.ik && m.byIk) this.revs1.add(m.dk)
        return
      case 'profile1':
        return
      case 'cert2':
        if (m.ik === this.ik) this.certs2.push(m)
        return
      case 'rev2':
        if (m.ik === this.ik) this.revs2.push(m)
        return
      case 'succ1': {
        const direct = src === 'card' || PINS.has(src)
        // fix round 4 (completeness review I3): 0.3.0's v1 (no new_cr, sig_new by the new ik) is a legacy claim with
        // Verify and Accept, never applied (mutant `ct-succ030-refuse`: refused, as in fix round 3)
        if (m.newCr === undefined)
          return this.onSucc(
            { old: m.old, new: m.new.ik, v: 1, legacy: true, direct },
            MUT !== 'ct-succ030-refuse' && m.byOldIk && m.old === this.ik && !!m.byNewIk
          )
        return this.onSucc(
          { old: m.old, new: m.new.ik, cr: m.new, v: 1, direct },
          m.byOldIk && m.old === this.ik && m.byNewRk && crOk(m.new) && m.newCr === crD(m.new)
        )
      }
      case 'succ2':
        return this.onSucc2(m, src)
      case 'badge':
        return this.onBadge(m.tok)
      case 'profile2':
        if (m.ik === this.ik) this.profiles2.push(m)
        return
    }
  }
  private onProof() {
    this.proof = true
    if (this.succTodo.length) {
      this.log.push('held successions refused: ik is hot')
      this.succTodo = []
    }
    if (this.st === 'unknown') {
      if (this.claims.length) {
        this.warning = `Someone has ${this.ik}'s identity key. Ask them to move to a new identity.`
        this.log.push('claims refused: ik is hot')
      }
      this.claims = []
      this.held = [] // fix round 4 (attack review M6): held records go with the claims
      this.st = 'none'
    } else if (this.st === 'known') {
      // a protected ik never signs again, so the pinned record was made with a hot ik by someone else: void
      this.warning = `Someone has ${this.ik}'s identity key. Ask them to move to a new identity.`
      this.log.push('known record void: ik is hot')
      this.cr = undefined
      this.recs.clear()
      this.st = 'none'
    }
  }
  private onCr(c: CR, src: Src) {
    if (c.ik !== this.ik || !crOk(c)) return
    if (this.st === 'known') {
      if (crD(c) !== crD(this.cr!)) {
        this.warning = `Someone may be impersonating ${this.ik}. Check their safety number.`
        this.log.push('cr refused (known)')
      }
      return
    }
    if (this.st === 'none' && !(MUT === 'ct-qr-none' && PINS.has(src))) {
      this.warning = `Someone has ${this.ik}'s identity key. Ask them to move to a new identity.`
      this.log.push('cr refused (none)')
      return
    }
    // unknown: an in-person check (QR, safety number) pins; any other source holds a pending claim
    if (PINS.has(src)) {
      this.pin(c, this.claims.find(x => crD(x.cr) === crD(c))?.recs ?? [])
      this.log.push(`pinned by ${src}`)
      return
    }
    // fix round 4 (completeness review I2 (b)): capped as the succession claims are: deduplicated, the first ones kept,
    // never FIFO; past the cap a claim is dropped with "Many records claimed. Verify in person.", except from a card the
    // user opened (a direct source; mutant `ct-cr-unbounded`: no cap)
    if (!this.claims.some(x => crD(x.cr) === crD(c)) || MUT === 'ct-cr-nodedupe') {
      if (this.claims.length >= CLAIMS_MAX && src !== 'card' && MUT !== 'ct-cr-unbounded') {
        this.crOverflow = true
        this.log.push('Many records claimed. Verify in person.')
        return
      }
      this.claims.push({ cr: c, recs: [] })
    }
    if (this.claims.length > 1)
      this.warning = `Someone may be impersonating ${this.ik}. Check their safety number.`
    this.log.push(`pending claim (${this.claims.length})`)
  }
  private pin(c: CR, recs: Rec[]) {
    this.st = 'known'
    this.cr = c
    this.claims = []
    this.warning = ''
    for (const r of [...recs, ...this.held])
      if (r.ik === this.ik && recOk(r)) this.recs.set(recD(r), r)
    this.held = []
    this.retrySucc()
  }
  /** fix round 4 (attack review M6): an unknown contact holds at most CHAIN_MAX + 1 chain records per pending claim (the
   * records whose `prev` path reaches that claim's creation record), and as many again that attach to none yet; the rest
   * are dropped (a sender re-sends its chain with each hello). Mutant `ct-held-unbounded` */
  private hold(r: Rec) {
    if (MUT === 'ct-held-unbounded') {
      this.held.push(r)
      return
    }
    if (this.held.some(x => recD(x) === recD(r))) return
    const byD = new Map(this.held.map(x => [recD(x), x] as const))
    byD.set(recD(r), r)
    const rootOf = (x: Rec) => {
      let d = x.prev
      for (let i = 0; i <= CHAIN_MAX && byD.has(d); i++) d = byD.get(d)!.prev
      return d
    }
    const roots = new Set(this.claims.map(c => crD(c.cr)))
    const bucket = (x: Rec) => {
      const d = rootOf(x)
      return roots.has(d) ? d : ''
    }
    const b = bucket(r)
    if ([...byD.values()].filter(x => bucket(x) === b).length > CHAIN_MAX + 1) {
      this.log.push('chain record dropped: too many held')
      return
    }
    this.held.push(r)
  }
  /** the user's Accept or Verify of a pending creation-record claim: possible only while it is the only one */
  accept(c: CR) {
    if (this.st !== 'unknown' || this.claims.length !== 1 || crD(this.claims[0].cr) !== crD(c))
      return false
    this.pin(c, this.claims[0].recs)
    return true
  }
  chain() {
    return this.cr ? chainOf(this.cr, this.recs.values()) : undefined
  }
  /** the devices this contact trusts (the epoch rule): the head's keep, plus v2 certificates under the head's primary,
   * minus revocations by that primary or by a live recovery key; in epoch 0 the creating device's v1 certificate and the
   * certificates under the creation record's primary. Legacy (none, unknown): v1 certificates minus v1 revocations. */
  trusted(): string[] {
    if (this.st !== 'known') return [...this.certs1].filter(d => !this.revs1.has(d)).sort()
    const C = this.chain()!
    if (C.rival) return []
    const out = new Set<string>()
    for (const h of C.heads) {
      const base = h.n === 0 ? [...this.certs1] : [...(h.keep ?? [])]
      for (const d of base) out.add(d)
      for (const c of this.certs2)
        if (c.n === h.n && c.pk === h.prim && c.by === h.prim) out.add(c.dk)
      for (const r of this.revs2) {
        if (r.n === h.n && r.pk === h.prim && r.by === h.prim) out.delete(r.dk)
        // a revocation signed by a recovery key counts at any later epoch unless a key change killed that key
        else if (
          (r.by === h.key ||
            [...C.at.values()].some(x => C.alive(x) && x.key === r.by && C.up(x, h))) &&
          !C.deadKey(r.by)
        )
          out.delete(r.dk)
      }
    }
    // the creating device's v1 certificate counts only while a head keeps it (or in epoch 0)
    return [...out].sort()
  }
  /** the half this contact's safety number screen compares (fix round 3, ruling 7): a known record's; a single pending
   * claim's (a match is Verify); legacy's over ik once proof says ik is hot; otherwise no number ("scan": an ik-only
   * number can never match a protected identity) */
  safetyHalf(): string {
    if (this.st === 'known') return halfOf(this.ik, this.cr!.rk)
    if (this.st === 'none') return halfOf(this.ik)
    if (this.claims.length === 1 || (MUT === 'ct-safety-two' && this.claims.length))
      return halfOf(this.ik, this.claims[0].cr.rk)
    // fix round 5 (r8e completeness review M5): two or more pending claims show no number either ("Scan their code")
    return 'scan'
  }
  /** succession claims (ruling 6): a bounded list, never FIFO */
  private onSucc(c: SuccClaim, ok: boolean) {
    if (!ok) {
      this.log.push(`succession ${c.v} refused`)
      return
    }
    if (this.succ.some(x => x.old === c.old && x.new === c.new) && MUT !== 'ct-succ-nodedupe')
      return // dedupe by (old, new)
    // keep the first claim per new identity; past the cap say so, except that a direct source (a card or QR of the new
    // identity the user scanned) always attaches it
    if (MUT === 'ct-succ-fifo' && this.succ.length >= CLAIMS_MAX) this.succ.shift()
    else if (this.succ.length >= CLAIMS_MAX && !c.direct) {
      this.succOverflow = true
      this.log.push('Many moves claimed. Verify in person.')
      return
    }
    this.succ.push(c)
  }
  private onSucc2(m: Extract<Msg, { k: 'succ2' }>, src: Src) {
    if (m.old !== this.ik) return
    // v2 (a protected identity moves): signed by the recovery key in force after the named head (after a removal its
    // primary) and by the new identity's rk', never by ik'. Fix round 4 (completeness review I3): it travels without the
    // old chain (a contact gets that from the old identity's hello `keys`, or the new one's `keys_old`) and with the new
    // identity's creation record, whose identity must equal `new_cr`; it counts while its head counts, and dies by key
    // death like a chain record. Not a chain record: no n, no cap. An unknown contact holds it with the creation-record
    // claims, and a known contact that lacks the named head holds it until the chain arrives (mutant `ct-succ-nohold`)
    const wellFormed = m.byNewRk && crOk(m.new) && m.newCr === crD(m.new)
    if (wellFormed && this.st === 'unknown' && MUT !== 'ct-succ-nohold')
      return this.holdSucc(m, src)
    if (this.st === 'none') {
      this.log.push('succession 2 refused (none)')
      return
    }
    let ok = this.st === 'known' && wellFormed
    if (ok) {
      // fix round 5 (r8e attack review M1): the chain records a v2 carries (the new identity's hello `keys_old`) are stored
      // like any chain record the contact receives, so a record that arrives later can't strand the claim (mutant
      // `ct-succ-chain-drop`: they are only read, as in fix round 4)
      if (MUT !== 'ct-succ-chain-drop') {
        let grew = false
        for (const r of m.chain)
          if (r.ik === this.ik && recOk(r) && !this.recs.has(recD(r))) {
            this.recs.set(recD(r), r)
            grew = true
          }
        if (grew) {
          if (this.chain()!.rival)
            this.warning = `Someone has ${this.ik}'s backup phrase. Ask them to move to a new identity.`
          this.dropStaleBadge()
          this.retryBadges()
          this.dropDeadSucc()
        }
      }
      const C = chainOf(this.cr!, [...this.recs.values(), ...m.chain])
      const h = C.at.get(m.head)
      if (!h && MUT !== 'ct-succ-nohold') return this.holdSucc(m, src)
      // after rival resets each branch's key in force may sign: both claims show, for the user to verify one
      ok = C.rival
        ? !!h && m.by === h.key
        : !!h &&
          (C.alive(h) || MUT === 'ct-succ2-dead') &&
          m.by === h.key &&
          (!C.deadKey(m.by) || MUT === 'ct-succ2-dead') &&
          (C.heads.some(x => C.up(h, x)) || MUT === 'ct-succ2-dead')
    }
    this.onSucc(
      {
        old: m.old,
        new: m.new.ik,
        cr: m.new,
        v: 2,
        head: m.head,
        by: m.by,
        direct: src === 'card' || PINS.has(src),
      },
      ok
    )
  }
  /** fix round 4: a v2 claim counts while its head counts: a record that arrives later and kills its head or its key (a
   * reset after which the old phrase signed it) drops a claim the user hasn't accepted (the order fuzz found it). Fix
   * round 5 (the controller's ruling 5; r8e attack review I4, its verifier's fix): an accepted but unverified claim it
   * kills stays listed, marked dead, with "This move was signed with a backup phrase {name} has since replaced. Verify it
   * in person."; Accept can't bring it back, Verify (in person) can; a verified claim stays as it is (mutant
   * `ct-acc-keep`: kept silently, as in fix round 4). A claim whose head the contact doesn't hold yet is not dead (r8e
   * attack review M1): it waits for the record */
  private dropDeadSucc() {
    if (MUT === 'ct-succ2-dead') return
    const C = this.chain()!
    const alive = (c: SuccClaim) => {
      if (c.v !== 2 || C.rival) return true
      const h = C.at.get(c.head!)
      if (!h) return MUT === 'ct-succ-chain-drop' ? false : true
      return C.alive(h) && !C.deadKey(c.by!) && C.heads.some(x => C.up(h, x))
    }
    for (const c of this.succ)
      if (c.accepted && !c.verified && MUT !== 'ct-acc-keep') {
        const d = !alive(c)
        if (d && !c.dead) {
          this.log.push('accepted succession 2 dead: its head or key died')
          this.warning = `This move was signed with a backup phrase ${this.ik} has since replaced. Verify it in person.`
        }
        c.dead = d
      }
    const keep = this.succ.filter(c => c.accepted || alive(c))
    if (keep.length !== this.succ.length) {
      this.log.push('succession 2 dropped: its head or key died')
      this.succ = keep
    }
  }
  /** held v2 claims, bounded like the claims list: deduplicated, the first ones kept, never FIFO; a direct source attaches */
  /** fix round 5 (r8e attack review M2): held claims are unchecked, so anyone can make them: they never block a claim that
   * checks (those go to the claims list), and when the held list is full the oldest held claim is evicted, not the newer
   * one refused (mutant `ct-held-block`: fix round 4's refusal, which let four strangers block V's genuine move) */
  private holdSucc(m: Extract<Msg, { k: 'succ2' }>, src: Src) {
    if (this.succTodo.some(x => x.m.new.ik === m.new.ik && x.m.head === m.head && x.m.by === m.by))
      return
    const direct = src === 'card' || PINS.has(src)
    if (this.succTodo.length >= CLAIMS_MAX && !direct) {
      this.succOverflow = true
      this.log.push('Many moves claimed. Verify in person.')
      if (MUT === 'ct-held-block') return
      this.succTodo.shift()
    }
    this.succTodo.push({ m, src, at: this.now })
    this.log.push(`succession 2 held (${this.st})`)
  }
  /** re-checks the held v2 claims once the contact is known: when a claim is pinned, and on each new chain record */
  private retrySucc() {
    if (this.st !== 'known' || !this.succTodo.length) return
    const todo = this.succTodo
    this.succTodo = []
    for (const x of todo) {
      if (!chainOf(this.cr!, [...this.recs.values(), ...x.m.chain]).at.get(x.m.head)) {
        this.succTodo.push(x)
        continue
      }
      this.onSucc2(x.m, x.src)
    }
  }
  /** Accept is a merge onto the successor's pending request (unverified); Verify the same with the verified mark */
  acceptSucc(newIk: string, verified: boolean): SuccClaim | undefined {
    const c = this.succ.find(x => x.new === newIk)
    if (!c) return undefined
    if (c.dead && !verified) return undefined // fix round 5 (r8e attack review I4): only Verify brings a dead move back
    c.accepted = true
    if (verified) {
      c.verified = true
      c.dead = false
    }
    return c
  }
  /** badges (completeness review I3): a token names the head it was issued for; a contact holding the creation record
   * ignores a token with no head, one whose head is older than a valid record it holds, and holds one naming a head it
   * doesn't know as unchecked until the chain arrives; a later record drops a slot that names an older head */
  private onBadge(tok: Token) {
    if (tok.ik !== this.ik) return
    if (this.st !== 'known' || MUT === 'ct-badge-nohead') {
      if (!this.badge || tok.iat > this.badge.iat) this.badge = tok
      return
    } // as 0.3.0
    if (!tok.head) {
      this.log.push('badge without a head ignored')
      return
    }
    const C = this.chain()!
    const h = C.at.get(tok.head.d)
    if (!h) {
      if (tok.head.n > C.top) this.badgeTodo.push(tok)
      else this.log.push('badge naming an unknown head ignored')
      return
    }
    if (!C.alive(h) || h.n < C.top) {
      this.log.push('badge naming an older head ignored')
      return
    }
    if (!this.badge || (this.badge.head?.n ?? -1) < h.n || tok.iat > this.badge.iat)
      this.badge = tok
  }
  private dropStaleBadge() {
    if (MUT === 'ct-badge-nohead') return
    const C = this.chain()
    if (!C || !this.badge?.head) return
    const h = C.at.get(this.badge.head.d)
    if (!h || !C.alive(h) || h.n < C.top) {
      this.log.push('badge slot dropped: older head')
      this.badge = undefined
    }
  }
  private retryBadges() {
    const todo = this.badgeTodo
    this.badgeTodo = []
    for (const t of todo) this.onBadge(t)
  }
}

/** the name a contact shows (§1.7 item 2): a protected identity's latest v2 profile of the current epoch (by the head's
 * primary); otherwise, and on an older peer, the card's name */
export function shownName(c: Contact): string | undefined {
  if (c.st !== 'known') return c.cardName
  const C = c.chain()!
  const ok = c.profiles2.filter(p =>
    C.heads.some(h => h.n === p.n && h.prim === p.pk && p.by === h.prim)
  )
  return ok.length ? ok.sort((a, b) => b.updated - a.updated)[0].name : c.cardName
}
/** what a server's members show for a member's moves (§1.7 "Servers"): the distinct verified `succ` values of all of its
 * `profile` writes, never only the register's current value */
export const serverSuccClaims = (writes: { succ?: { new: string; verified: boolean } }[]) =>
  [...new Set(writes.filter(w => w.succ?.verified).map(w => w.succ!.new))].sort()

/** the user's own client (V): the half it shows, and what it says when a contact's `yours` echo lacks its record */
export const ownHalf = (ik: string, cr?: CR) => (cr ? halfOf(ik, cr.rk) : halfOf(ik))

// ---------------------------------------------------------------- restore and the account's records (ruling 9)

/** the account's identity record (§1.7 item 9; fix round 3): append-only; deleting or turning it off needs re-auth
 * (plan K's `reauth::check`: the password or a phrase signature, never a fresh session) */
export class IdentityRecords {
  rows = new Map<string, { cr: CR; recs: Rec[] }>()
  put(ik: string, cr: CR, recs: Rec[], reauth = false): 'ok' | 'invalid' | 'reauth' {
    if (!crOk(cr) || cr.ik !== ik) return 'invalid'
    const C = chainOf(cr, recs)
    if (recs.some(r => !C.at.has(recD(r)))) return 'invalid' // "That isn't a valid P2P identity record"
    const cur = this.rows.get(ik)
    if (cur && !reauth && MUT !== 'ct-record-truncate') {
      // a PUT must keep the stored creation record and extend the stored chain (a superset that holds its heads)
      if (crD(cur.cr) !== crD(cr)) return 'reauth'
      const have = new Set(recs.map(recD))
      if (cur.recs.some(r => !have.has(recD(r)))) return 'reauth'
    }
    this.rows.set(ik, { cr, recs: [...recs] })
    return 'ok'
  }
  delete(ik: string, reauth = false): 'ok' | 'reauth' {
    if (!reauth) return 'reauth'
    this.rows.delete(ik)
    return 'ok'
  }
}
/**
 * The encrypted backup (§1.7 item 8; fix round 4: the controller's ruling 3 on the r8d completeness review I2, the
 * verifier's fix). Versions leave with time, never because of a PUT: the instance keeps per (account, ik) the last 3
 * versions, the first version uploaded on each UTC day of the last 30, and the newest version older than that, at most
 * 35. A PUT never needs re-auth and may drop only a version of the current day that is neither that day's first nor among
 * the last 3, so a stolen device's emptied dumps never remove a day's first version (mutant `ct-backup-evict`: fix round
 * 3's last 3). Sizes: `P2P_BACKUP_MAX_MIB` (default 64) bounds one version and `P2P_BACKUP_TOTAL_MIB` (default 256; 0 =
 * no total) the account's kept versions; a PUT over either is refused ("full") and never evicts (mutant
 * `ct-backup-size`: it evicts the oldest instead). Purging and turning the setting off need re-auth (`reauth::check`).
 */
export const BACKUP_LAST = 3,
  BACKUP_DAYS = 30,
  BACKUP_MAX = 35,
  DAY_MS = 86_400_000,
  MIB = 1 << 20
export class Backups {
  versions = new Map<string, { at: number; blob: string; size: number; version: number }[]>()
  constructor(
    public maxBytes = 64 * MIB,
    public totalBytes = 256 * MIB
  ) {}
  private keep(v: { at: number; blob: string; size: number; version: number }[], now: number) {
    if (MUT === 'ct-backup-evict') return v.slice(-BACKUP_LAST)
    const day = (t: number) => Math.floor(t / DAY_MS),
      today = day(now)
    const keep = new Set(v.slice(-BACKUP_LAST))
    const first = new Map<number, (typeof v)[number]>()
    for (const x of v) if (!first.has(day(x.at))) first.set(day(x.at), x)
    // the first version of each UTC day from today back to 30 days before it, and the newest version older than those
    for (const [d, x] of first) if (d >= today - BACKUP_DAYS) keep.add(x)
    const older = v.filter(x => day(x.at) < today - BACKUP_DAYS)
    if (older.length) keep.add(older[older.length - 1])
    return v.filter(x => keep.has(x))
  }
  private total(except?: string) {
    let t = 0
    for (const [ik, v] of this.versions) if (ik !== except) for (const x of v) t += x.size
    return t
  }
  /** a PUT of version `version` (latest + 1, else "conflict"); "full" when the version or the account's total is over its limit */
  put(
    ik: string,
    blob: string,
    at: number,
    size = blob.length,
    version?: number
  ): 'ok' | 'full' | 'conflict' {
    const v = this.versions.get(ik) ?? []
    const latest = Math.max(v.length ? v[v.length - 1].version : 0, this.deleted.get(ik) ?? 0)
    const n = version ?? latest + 1
    if (n !== latest + 1) return 'conflict'
    if (size > this.maxBytes) return 'full'
    let next = this.keep([...v, { at, blob, size, version: n }], at)
    const over = () =>
      this.totalBytes > 0 && this.total(ik) + next.reduce((a, x) => a + x.size, 0) > this.totalBytes
    if (over()) {
      if (MUT !== 'ct-backup-size') return 'full'
      while (over() && next.length > 1) next = next.slice(1)
    }
    this.versions.set(ik, next)
    return 'ok'
  }
  /** the versions a restore offers at `now`, newest first in the API (here in upload order); the instance prunes by age */
  list(ik: string, now?: number) {
    const v = this.versions.get(ik) ?? []
    if (now !== undefined) this.versions.set(ik, this.keep(v, now))
    return [...(this.versions.get(ik) ?? [])]
  }
  /** fix round 5 (r8e completeness review M2): GET of the latest version returns its number too (`X-Backup-Version`), so
   * a restore opens it with the right additional data */
  latest(ik: string) {
    const v = this.versions.get(ik) ?? []
    const x = v[v.length - 1]
    return x ? { version: x.version, blob: x.blob } : undefined
  }
  /** fix round 5 (r8e completeness review M5): deleting one version needs re-auth (`DELETE …/versions/{version}`); the
   * numbers are never reused (mutant `ct-backup-nodelete`: no such route, as in fix round 4's module) */
  delete(ik: string, version: number, reauth = false): 'ok' | 'reauth' | 'missing' {
    if (MUT === 'ct-backup-nodelete') return 'missing'
    if (!reauth) return 'reauth'
    const v = this.versions.get(ik) ?? []
    if (!v.some(x => x.version === version)) return 'missing'
    this.versions.set(
      ik,
      v.filter(x => x.version !== version)
    )
    this.deleted.set(ik, Math.max(this.deleted.get(ik) ?? 0, version))
    return 'ok'
  }
  /** the highest version number ever stored per identity (a number is never reused, also after a delete) */
  deleted = new Map<string, number>()
  purge(ik: string, reauth = false): 'ok' | 'reauth' {
    if (!reauth) return 'reauth'
    this.versions.delete(ik)
    return 'ok'
  }
  off(ik: string, reauth = false): 'ok' | 'reauth' {
    return this.purge(ik, reauth)
  }
}

/**
 * Restoring from the phrase (§1.7 "Restoring"; fix round 3, ruling 9). The phrase gives `rk`. The identity id comes from
 * any source: the account's identity record, a `.rchat` file, a contact's code for the user, an invite, a server's
 * member entry, or typed in. The creation record and chain are fetched from peers and servers; they are self-
 * authenticating (the creation record verifies under ik, and nobody can make another one for a protected ik; each chain
 * record verifies under the key in force). The phrase's rk must be the key in force at a head of the fetched chain:
 * otherwise the chain is truncated (or stale), and the client keeps fetching. Then it makes record n+1 (keep: the new
 * device) and posts it.
 */
export type Restored =
  | { ok: true; ik: string; cr: CR; head: string; rec: Rec }
  | {
      ok: false
      why: 'no-id' | 'no-record' | 'keep-fetching' | 'at-cap' | 'frozen'
      ik?: string
      head?: string
    }
export function restore(
  rk: string,
  ids: string[],
  fetched: Msg[],
  newDev: string,
  newPk: string
): Restored {
  // fix round 4 (completeness review I2 (d)): every distinct id from every source is tried, and the best outcome wins: a
  // record, then the move (at the cap, or frozen), then keep fetching, then nothing (mutant `ct-restore-first`: the first
  // id only, as in fix round 3)
  const cand = [...new Set(ids.filter(x => x))]
  if (!cand.length) return { ok: false, why: 'no-id' }
  const outs = (MUT === 'ct-restore-first' ? cand.slice(0, 1) : cand).map(ik =>
    restoreOne(rk, ik, fetched, newDev, newPk)
  )
  const rank = (o: Restored) =>
    o.ok
      ? 0
      : o.why === 'at-cap' || o.why === 'frozen'
        ? MUT === 'ct-restore-rank'
          ? 2.5
          : 1
        : o.why === 'keep-fetching'
          ? 2
          : 3
  return outs.sort((a, b) => rank(a) - rank(b))[0]
}
function restoreOne(
  rk: string,
  ik: string,
  fetched: Msg[],
  newDev: string,
  newPk: string
): Restored {
  const crs = fetched
    .filter((m): m is Extract<Msg, { k: 'cr' }> => m.k === 'cr' && m.cr.ik === ik && crOk(m.cr))
    .map(m => m.cr)
  const recs = fetched
    .filter((m): m is Extract<Msg, { k: 'rec' }> => m.k === 'rec' && m.rec.ik === ik)
    .map(m => m.rec)
  // the user's own creation record: the one whose chain has the phrase's key in force at a head (a legacy identity's
  // thief can mint another with the hot ik; it never chains to this phrase)
  for (const cr of crs) {
    const C = chainOf(cr, recs)
    if (C.rival) {
      // fix round 4 (completeness review I2 (d)): rival resets froze the identity: no record can follow; the phrase's
      // branch key signs the move (succession v2 at the deepest record where that key is in force), and the app says so
      // (mutant `ct-restore-frozen`: keep fetching, as in fix round 3)
      const mine = [...C.at.values()].filter(x => x.key === rk).sort((x, y) => y.n - x.n)[0]
      if (mine && MUT !== 'ct-restore-frozen') return { ok: false, why: 'frozen', ik, head: mine.d }
      continue
    }
    const h = C.heads.find(x => x.key === rk)
    if (h) {
      if (h.n >= CHAIN_MAX) return { ok: false, why: 'at-cap' } // at the cap the client offers the move instead
      return {
        ok: true,
        ik,
        cr,
        head: h.d,
        rec: { ik, n: h.n + 1, prev: h.d, by: rk, pk: newPk, keep: [newDev] },
      }
    }
    // the phrase's key is in force at a record we don't hold yet (a later reset we lack): keep fetching
    if ([...C.at.values()].some(x => x.key === rk) || cr.rk === rk)
      return { ok: false, why: 'keep-fetching' }
  }
  return { ok: false, why: crs.length ? 'keep-fetching' : 'no-record' }
}
