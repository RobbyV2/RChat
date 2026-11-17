import { isRecord } from '../bytes'
import { canonical, isInt } from './canonical'
import {
  atHead,
  CHAIN_MAX,
  isChainRecord,
  isCreation,
  isRevocationV2,
  isSuccessionV1,
  isSuccessionV2,
  readChain,
  recordId,
  revokes,
  safetyHalf,
  succession2SignedBy,
  TAG2,
  trustedDevices,
  verifyCertV2,
  verifyProfileV2,
  verifySuccessionV1,
  verifySuccessionV2New,
  type CertV2,
  type ChainRecord,
  type ChainView,
  type CreationRecord,
  type Head,
  type ProfileV2,
  type RevocationV2,
  type SuccessionV1,
  type SuccessionV2,
} from './chain'
import {
  isKeyId,
  verifyCert,
  verifyProfile,
  verifyRevocation,
  verifySuccession,
  verifyTagged,
  type Succession,
} from './keys'

// What one contact holds about an identity's protection: its creation-record
// state (known, none, unknown) with the pending claims, the chain and the devices it trusts by
// the epoch rule, the succession claims (v1 with or without `new_cr`, v2) with the held ones, and the badge
// against the chain's heads. A pure state machine over verified records: it signs nothing,
// stores nothing and applies no move by itself.

export type CrState = 'known' | 'none' | 'unknown'

// Where a message came from: a contact code or card the user opened, the hello of a handshake the
// user accepted, a QR or safety-number check done in person, a server introduction, or a store
// an older version wrote.
export type Src = 'card' | 'hello' | 'qr' | 'safety' | 'server' | 'carried'

export const CLAIMS_MAX = 4
export const HELD_MS = 30 * 86_400_000
export const HELD_RECORDS = CHAIN_MAX + 1
// Most stored records a contact is read from.
const STORED_RECORDS = 256
export const CERTS2_MAX = 32
export const REVS2_MAX = 32
export const PROFILES2_MAX = 8
export const BADGES_HELD = 4

const PINS = new Set<Src>(['qr', 'safety'])
const DIRECT = new Set<Src>(['card', 'hello', 'qr', 'safety'])

// What the instance's badge token names: the account, the identity and the head it was issued for.
export interface BadgeToken {
  sub: string
  ik: string
  head?: Head
  iat: number
}

export type ClaimMsg =
  | { k: 'cr'; cr: unknown }
  | { k: 'rec'; rec: unknown }
  | { k: 'cert1'; cert: unknown }
  | { k: 'rev1'; rev: unknown }
  | { k: 'profile1'; profile: unknown }
  | { k: 'cert2'; cert: unknown }
  | { k: 'rev2'; rev: unknown }
  | { k: 'profile2'; profile: unknown }
  // a succession with the new identity's creation record beside it (`succ_cr`, or its hello's
  // `keys`), and for a v2 the old chain a hello's `keys_old` brings
  | { k: 'succ'; succ: unknown; succ_cr?: unknown; chain?: unknown }
  | { k: 'badge'; token: BadgeToken }

export interface SuccClaim {
  old: string
  new: string
  v: 1 | 2
  succ: Succession | SuccessionV1 | SuccessionV2
  // the new identity's creation record; none for a v1 without `new_cr`
  cr?: CreationRecord
  // v2: the head it names and the key in force there, which signed it
  head?: Head
  by?: string
  direct: boolean
  legacy?: boolean
  accepted?: boolean
  verified?: boolean
  dead?: boolean
}

interface HeldSucc {
  succ: SuccessionV2
  cr: CreationRecord
  chain: ChainRecord[]
  src: Src
  at: number
}

export type WarningCode = 'impersonation' | 'ik-hot' | 'phrase' | 'move-dead'

export const warningText = (code: WarningCode, name: string): string =>
  code === 'impersonation'
    ? `Someone may be impersonating ${name}. Check their safety number.`
    : code === 'ik-hot'
      ? `Someone has ${name}'s identity key. Ask them to move to a new identity.`
      : code === 'phrase'
        ? `Someone has ${name}'s backup phrase. Ask them to move to a new identity.`
        : `This move was signed with a backup phrase ${name} has since replaced. Verify it in person.`

export const MANY_RECORDS = 'Many records claimed. Verify in person.'
export const MANY_MOVES = 'Many moves claimed. Verify in person.'
export const SCAN = 'Scan their code.'

export type ClaimRef = { kind: 'cr'; id: string } | { kind: 'succ'; new: string }

export type ClaimView =
  { kind: 'cr'; id: string; cr: CreationRecord } | ({ kind: 'succ' } & SuccClaim)

const headIn = (C: ChainView, d: string): Head | undefined => {
  if (d === recordId(C.cr)) return { n: 0, d }
  const r = C.record(d)
  return r ? { n: r.n, d } : undefined
}

// Copies of one record may differ in their signatures.
const copyOf = (r: ChainRecord) => `${recordId(r)} ${r.sig} ${r.sig_next ?? ''}`

const revOf = ({ dk, pk, n, revoked_at, successor, sig }: RevocationV2) =>
  `${dk} ${pk} ${n} ${revoked_at} ${successor ?? ''} ${sig}`

// A v1 succession's old half: the old identity key signed it, whoever signed the new half. Both
// forms: without `new_cr`, and the one that names the new creation record.
const signedByOld = (x: Record<string, unknown>): boolean => {
  if (isSuccessionV1(x)) {
    const { v, old, new: next, new_cr, at } = x
    return verifyTagged(old, TAG2.succ1, { v, old, new: next, new_cr, at }, x.sig_old)
  }
  const { v, old, new: next, at, sig_old } = x
  if (v !== 1 || !isKeyId(old) || !isKeyId(next) || !isInt(at) || 'new_cr' in x) return false
  return verifyTagged(old, TAG2.succ1, { v, old, new: next, at }, sig_old)
}

// Hellos repeat their v1 records, so what the identity key signed is checked once.
const V1_MAX = 4096
const v1Checks = new Map<string, boolean>()
const v1Ok = (kind: 'cert' | 'revoke' | 'profile', ik: string, x: unknown): boolean => {
  if (!isRecord(x) || typeof x.sig !== 'string') return false
  let key: string
  try {
    key = `${kind} ${ik} ${canonical(x)}`
  } catch {
    return false
  }
  const hit = v1Checks.get(key)
  if (hit !== undefined) return hit
  const ok =
    kind === 'cert'
      ? verifyCert(x, ik)
      : kind === 'revoke'
        ? verifyRevocation(x, ik)
        : verifyProfile(x, ik)
  if (v1Checks.size >= V1_MAX) v1Checks.clear()
  v1Checks.set(key, ok)
  return ok
}

const cut = <T>(xs: T[], max: number) => {
  while (xs.length > max) xs.shift()
}

// The claim a held record is for: the creation record its `prev` path reaches through the held
// records, or '' when it reaches none.
const bucketsOf = (claims: readonly CreationRecord[], recs: readonly ChainRecord[]) => {
  const roots = new Set(claims.map(recordId))
  const byD = new Map(recs.map(x => [recordId(x), x] as const))
  return (x: ChainRecord) => {
    let p = x.prev
    for (let i = 0; i <= CHAIN_MAX && byD.has(p); i += 1) p = byD.get(p)!.prev
    return roots.has(p) ? p : ''
  }
}

// What an unknown contact holds once `r` is placed, or null when `r` is refused. At most
// HELD_RECORDS chain records per pending claim and as many again that reach no claim, counting
// copies, counted after `r` is placed: a record moves to a claim when its parent arrives. Over
// the cap a claim drops a record that doesn't verify under it, `r` first and then the oldest,
// with what then reaches no claim; when every one verifies, `r` is refused.
const placeHeld = (
  claims: readonly CreationRecord[],
  held: readonly ChainRecord[],
  r: ChainRecord
): ChainRecord[] | null => {
  const before = bucketsOf(claims, held)
  const loose = new Set(held.filter(x => before(x) === ''))
  let recs = [...held, r]
  for (;;) {
    const bucket = bucketsOf(claims, recs)
    const counts = new Map<string, number>()
    for (const x of recs) counts.set(bucket(x), (counts.get(bucket(x)) ?? 0) + 1)
    const over = [...counts].find(([, n]) => n > HELD_RECORDS)?.[0]
    if (over === undefined) return recs
    const mine = recs.filter(x => bucket(x) === over)
    const claim = claims.find(c => recordId(c) === over)
    const C = claim && readChain(claim, recs)
    const gone = C
      ? mine.includes(r) && !C.verifies(r)
        ? r
        : mine.find(x => !C.verifies(x))
      : mine.find(x => x !== r && !loose.has(x))
    if (!gone || gone === r) return null
    recs = recs.filter(x => x !== gone)
  }
}

// Stored held records in an order that places each after the held record its `prev` names.
const parentsFirst = (recs: readonly ChainRecord[]) => {
  const byD = new Map(recs.map(x => [recordId(x), x] as const))
  const depth = (x: ChainRecord) => {
    let n = 0
    for (let p = x.prev; n <= CHAIN_MAX && byD.has(p); n += 1) p = byD.get(p)!.prev
    return n
  }
  return recs
    .map((r, i) => ({ r, i, d: depth(r) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map(x => x.r)
}

export class ContactClaims {
  st: CrState
  cr?: CreationRecord
  recs = new Map<string, ChainRecord>()
  certs1 = new Set<string>()
  revs1 = new Set<string>()
  certs2: CertV2[] = []
  revs2: RevocationV2[] = []
  profiles2: ProfileV2[] = []
  // a record signed by the identity key other than the creation record and the creating device's
  // v1 certificate
  proof = false
  pending: CreationRecord[] = []
  crOverflow = false
  // chain records an unknown contact holds for whichever claim is pinned
  heldRecs: ChainRecord[] = []
  succ: SuccClaim[] = []
  succOverflow = false
  heldSucc: HeldSucc[] = []
  warning: WarningCode | null = null
  badge?: BadgeToken
  badgeTodo: BadgeToken[] = []
  now: number
  private view?: ChainView

  constructor(
    readonly ik: string,
    src: Src,
    first: readonly ClaimMsg[] = [],
    now = 0
  ) {
    this.now = now
    const cr = first.find(
      (m): m is { k: 'cr'; cr: CreationRecord } => m.k === 'cr' && this.crOk(m.cr)
    )
    this.st =
      src === 'carried'
        ? 'unknown'
        : cr && DIRECT.has(src)
          ? 'known'
          : first.some(m => this.signedByIk(m) && this.proves(m))
            ? 'none'
            : 'unknown'
    if (this.st === 'known') this.cr = cr!.cr
    for (const m of first) if (!(this.st === 'known' && m === cr)) this.receive(m, src, now)
  }

  private crOk(c: unknown): c is CreationRecord {
    return isCreation(c) && c.ik === this.ik
  }

  private recOk(r: unknown): r is ChainRecord {
    return isChainRecord(r) && r.ik === this.ik
  }

  // A v1 record of this identity whose signature by the identity key verifies.
  private signedByIk(m: ClaimMsg): boolean {
    if (m.k === 'profile1') return v1Ok('profile', this.ik, m.profile)
    if (m.k === 'rev1') return v1Ok('revoke', this.ik, m.rev)
    if (m.k === 'cert1') return v1Ok('cert', this.ik, m.cert)
    if (m.k === 'succ') return isRecord(m.succ) && m.succ.old === this.ik && signedByOld(m.succ)
    return false
  }

  // Proof that the identity key is in use: a record it signed other than the creation record and
  // the creating device's v1 certificate (a second, different v1 certificate counts).
  private proves(m: ClaimMsg): boolean {
    if (m.k === 'cert1')
      return this.certs1.size > 0 && !this.certs1.has((m.cert as { dk: string }).dk)
    return m.k === 'profile1' || m.k === 'rev1' || m.k === 'succ'
  }

  receive(m: ClaimMsg, src: Src, now: number = this.now): void {
    this.now = now
    if (this.heldSucc.length) this.heldSucc = this.heldSucc.filter(x => now - x.at < HELD_MS)
    const byIk = this.signedByIk(m)
    if (byIk && !this.proof && this.proves(m)) this.onProof()
    switch (m.k) {
      case 'cr':
        return this.onCr(m.cr, src)
      case 'rec':
        if (!this.recOk(m.rec)) return
        if (this.st === 'known') {
          if (this.addRec(m.rec)) this.grew()
          this.retrySucc()
        } else if (this.st === 'unknown') this.hold(m.rec)
        return
      case 'cert1':
        if (byIk) this.certs1.add((m.cert as { dk: string }).dk)
        return
      case 'rev1':
        if (byIk) this.revs1.add((m.rev as { dk: string }).dk)
        return
      case 'profile1':
        return
      case 'cert2':
        if (verifyCertV2(m.cert, this.ik)) this.addCert2(m.cert)
        return
      case 'rev2':
        if (isRevocationV2(m.rev, this.ik)) this.addRev2(m.rev)
        return
      case 'profile2':
        if (verifyProfileV2(m.profile, this.ik)) this.addProfile2(m.profile)
        return
      case 'succ':
        return this.onSuccession(m, src)
      case 'badge':
        return this.onBadge(m.token)
    }
  }

  // ----- The creation-record state -----

  private onProof() {
    this.proof = true
    this.heldSucc = []
    if (this.st === 'unknown') {
      if (this.pending.length) this.warning = 'ik-hot'
      this.pending = []
      this.heldRecs = []
      this.st = 'none'
    } else if (this.st === 'known') {
      this.warning = 'ik-hot'
      this.cr = undefined
      this.recs.clear()
      this.view = undefined
      this.st = 'none'
    }
  }

  private onCr(c: unknown, src: Src) {
    if (!this.crOk(c)) return
    const d = recordId(c)
    if (this.st === 'known') {
      if (d !== recordId(this.cr!)) this.warning = 'impersonation'
      return
    }
    if (this.st === 'none') {
      this.warning = 'ik-hot'
      return
    }
    if (PINS.has(src)) return this.pin(c)
    if (!this.pending.some(x => recordId(x) === d)) {
      if (this.pending.length >= CLAIMS_MAX && src !== 'card') {
        this.crOverflow = true
        return
      }
      this.pending.push(c)
    }
    if (this.pending.length > 1) this.warning = 'impersonation'
  }

  private pin(c: CreationRecord) {
    this.st = 'known'
    this.cr = c
    this.pending = []
    this.warning = null
    this.view = undefined
    const held = this.heldRecs
    this.heldRecs = []
    // What attaches goes in first, so the slots for records that don't attach yet never push
    // it out.
    const C = readChain(c, held)
    for (const r of held) if (C.verifies(r)) this.addRec(r)
    for (const r of held) if (!C.verifies(r)) this.addRec(r)
    if (this.chain()!.frozen) this.warning = 'phrase'
    this.retrySucc()
  }

  private hold(r: ChainRecord) {
    const copy = copyOf(r)
    if (this.heldRecs.some(x => copyOf(x) === copy)) return
    const placed = placeHeld(this.pending, this.heldRecs, r)
    if (placed) this.heldRecs = placed
  }

  // A known contact keeps every record that attaches, and the newest HELD_RECORDS that don't yet.
  private addRec(r: ChainRecord): boolean {
    const key = copyOf(r)
    if (this.recs.has(key)) return false
    this.recs.set(key, r)
    this.view = undefined
    const C = this.chain()!
    if (C.verifies(r)) return true
    const loose = [...this.recs].filter(([, x]) => !C.verifies(x))
    if (loose.length > HELD_RECORDS) {
      this.recs.delete(loose[0][0])
      this.view = undefined
    }
    return true
  }

  private grew() {
    if (this.chain()!.frozen) this.warning = 'phrase'
    this.dropStaleBadge()
    this.retryBadges()
    this.dropDeadSucc()
  }

  // The user's Accept of a pending creation-record claim: only while it is the only one.
  private acceptCr(id: string): boolean {
    if (this.st !== 'unknown' || this.pending.length !== 1 || recordId(this.pending[0]) !== id)
      return false
    this.pin(this.pending[0])
    return true
  }

  chain(): ChainView | undefined {
    if (!this.cr) return undefined
    this.view ??= readChain(this.cr, this.recs.values())
    return this.view
  }

  // ----- Devices, the name and the safety number -----

  // The devices this contact trusts. A known contact: the head's devices by the epoch rule, none
  // after rival resets. Otherwise v1 certificates minus v1 revocations.
  trusted(): string[] {
    const C = this.chain()
    if (!C) return [...this.certs1].filter(d => !this.revs1.has(d)).sort()
    return trustedDevices(C, this.certs1, this.certs2, this.revs2)
  }

  private addCert2(c: CertV2) {
    if (this.certs2.some(x => x.dk === c.dk && x.n === c.n && x.pk === c.pk)) return
    this.certs2.push(c)
    if (this.certs2.length > CERTS2_MAX) this.prune(this.certs2, CERTS2_MAX, atHead)
  }

  // The chains whose keys sign v2 records: the known one, or while unknown each pending claim's
  // with the held records.
  private views(): ChainView[] {
    const C = this.chain()
    if (C) return [C]
    if (this.st !== 'unknown') return []
    return this.pending.map(c => readChain(c, this.heldRecs))
  }

  // A v2 revocation's signer is worked out when the devices are read: it may be a recovery key the
  // contact doesn't hold yet. One that no key verifies counts at no head, so it never pushes out
  // one that counts.
  private addRev2(r: RevocationV2) {
    const key = revOf(r)
    if (this.revs2.some(x => revOf(x) === key)) return
    this.revs2.push(r)
    if (this.revs2.length > REVS2_MAX)
      this.prune(this.revs2, REVS2_MAX, (C, x) => C.heads.some(h => revokes(C, h, x)))
  }

  private addProfile2(p: ProfileV2) {
    const i = this.profiles2.findIndex(x => x.n === p.n && x.pk === p.pk)
    if (i >= 0) {
      if (this.profiles2[i].updated < p.updated) this.profiles2[i] = p
      return
    }
    this.profiles2.push(p)
    if (this.profiles2.length > PROFILES2_MAX) this.prune(this.profiles2, PROFILES2_MAX, atHead)
  }

  // Past its cap a list drops, oldest first, what counts at no head of the chain (while unknown,
  // of a pending claim's), then the oldest of the rest.
  private prune<T>(xs: T[], max: number, counts: (C: ChainView, x: T) => boolean) {
    const views = this.views()
    for (let i = 0; i < xs.length && xs.length > max;)
      if (!views.some(C => counts(C, xs[i]))) xs.splice(i, 1)
      else i += 1
    cut(xs, max)
  }

  // The name shown: a protected identity's latest v2 profile of the current epoch, else the
  // card's name.
  name(cardName?: string): string | undefined {
    const C = this.chain()
    if (!C) return cardName
    const ok = this.profiles2.filter(p => C.heads.some(h => h.n === p.n && C.primary(h) === p.pk))
    return ok.length ? ok.sort((a, b) => b.updated - a.updated)[0].name : cardName
  }

  // The half the safety number screen compares: a known record's, the single pending claim's (a
  // match is Verify), the identity key's once proof says it is in use; otherwise none, and the
  // screen says to scan their code.
  half(): string | null {
    if (this.st === 'known') return safetyHalf(this.ik, this.cr!.rk)
    if (this.st === 'none') return safetyHalf(this.ik)
    if (this.pending.length === 1) return safetyHalf(this.ik, this.pending[0].rk)
    return null
  }

  // ----- Succession claims -----

  private onSuccession(m: { succ: unknown; succ_cr?: unknown; chain?: unknown }, src: Src) {
    const { succ } = m
    if (!isRecord(succ) || succ.old !== this.ik || !isKeyId(succ.new)) return
    const direct = src === 'card' || PINS.has(src)
    if (verifySuccession(succ))
      return this.addSucc({ old: succ.old, new: succ.new, v: 1, succ, legacy: true, direct })
    if (isSuccessionV1(succ)) {
      if (!verifySuccessionV1(succ, m.succ_cr)) return
      const cr = m.succ_cr as CreationRecord
      return this.addSucc({ old: succ.old, new: succ.new, v: 1, succ, cr, direct })
    }
    if (!isSuccessionV2(succ)) return
    const chain = Array.isArray(m.chain)
      ? m.chain.filter((r): r is ChainRecord => this.recOk(r)).slice(0, HELD_RECORDS)
      : []
    const wellFormed = verifySuccessionV2New(succ, m.succ_cr)
    const cr = m.succ_cr as CreationRecord
    if (wellFormed && this.st === 'unknown')
      return this.holdSucc({ succ, cr, chain, src, at: this.now })
    if (this.st !== 'known' || !wellFormed) return
    this.onSucc2({ succ, cr, chain, src, at: this.now })
  }

  // A v2 at a known contact: the chain records it carries are stored like any others; it counts
  // while its head counts, signed by the key in force there; after rival resets each branch's
  // key may sign. A head the contact doesn't hold yet holds the claim.
  private onSucc2(x: HeldSucc) {
    let grew = false
    for (const r of x.chain) if (this.addRec(r)) grew = true
    if (grew) this.grew()
    const C = this.chain()!
    const h = headIn(C, x.succ.head.d)
    if (!h || h.n !== x.succ.head.n) {
      if (!h) this.holdSucc(x)
      return
    }
    const by = C.inForce(h)
    if (!succession2SignedBy(x.succ, by)) return
    if (!C.frozen && !(C.counts(h.d) && !C.deadKey(by) && C.heads.some(t => C.under(h.d, t.d))))
      return
    const { succ, cr, src } = x
    this.addSucc({
      old: succ.old,
      new: succ.new,
      v: 2,
      succ,
      cr,
      head: h,
      by,
      direct: src === 'card' || PINS.has(src),
    })
  }

  // A bounded list, never first-in-first-out: one claim per (old, new), the first ones kept; past
  // the cap a claim is dropped, except from a card or QR of the new identity the user scanned.
  private addSucc(c: SuccClaim) {
    if (this.succ.some(x => x.new === c.new)) return
    if (this.succ.length >= CLAIMS_MAX && !c.direct) {
      this.succOverflow = true
      return
    }
    this.succ.push(c)
  }

  // Held v2 claims are unchecked, so anyone can make them: when the list is full the oldest
  // goes, and they never block a claim that checks.
  private holdSucc(x: HeldSucc) {
    if (this.heldSucc.some(y => y.succ.sig_old === x.succ.sig_old && y.succ.new === x.succ.new))
      return
    const direct = x.src === 'card' || PINS.has(x.src)
    if (this.heldSucc.length >= CLAIMS_MAX && !direct) {
      this.succOverflow = true
      this.heldSucc.shift()
    }
    this.heldSucc.push(x)
  }

  // Re-checks the held v2 claims once the contact is known: when a claim is pinned, and on each
  // new chain record.
  private retrySucc() {
    if (this.st !== 'known' || !this.heldSucc.length) return
    const todo = this.heldSucc
    this.heldSucc = []
    for (const x of todo) {
      const C = readChain(this.cr!, [...this.recs.values(), ...x.chain])
      if (!headIn(C, x.succ.head.d)) this.heldSucc.push(x)
      else this.onSucc2(x)
    }
  }

  private succAlive(c: SuccClaim, C: ChainView): boolean {
    if (c.v !== 2 || C.frozen) return true
    const h = headIn(C, c.head!.d)
    if (!h) return true
    return C.counts(h.d) && !C.deadKey(c.by!) && C.heads.some(t => C.under(h.d, t.d))
  }

  // A record that arrives later and kills a v2's head or key drops a claim the user hasn't
  // accepted; an accepted, unverified one stays listed, marked dead; a verified one stays as it is.
  private dropDeadSucc() {
    const C = this.chain()!
    for (const c of this.succ)
      if (c.accepted && !c.verified) {
        const dead = !this.succAlive(c, C)
        if (dead && !c.dead) this.warning = 'move-dead'
        c.dead = dead
      }
    this.succ = this.succ.filter(c => c.accepted || this.succAlive(c, C))
  }

  // ----- The user's choices -----

  // Accept: a pending creation record (while it is the only one) is pinned; a move is merged
  // onto the successor's request, unverified. A dead move can't be accepted.
  accept(ref: ClaimRef): boolean {
    if (ref.kind === 'cr') return this.acceptCr(ref.id)
    const c = this.succ.find(x => x.new === ref.new)
    if (!c || c.dead) return false
    c.accepted = true
    return true
  }

  // Verify, after an in-person check: pins a pending creation record whatever else is claimed,
  // or merges a move with the verified mark, which also brings a dead move back.
  verify(ref: ClaimRef): boolean {
    if (ref.kind === 'cr') {
      const c = this.pending.find(x => recordId(x) === ref.id)
      if (this.st !== 'unknown' || !c) return false
      this.pin(c)
      return true
    }
    const c = this.succ.find(x => x.new === ref.new)
    if (!c) return false
    c.accepted = true
    c.verified = true
    c.dead = false
    return true
  }

  // Undo reverses the merge of a move: it is a claim again, or gone when its head or key died.
  undo(ref: ClaimRef): boolean {
    if (ref.kind !== 'succ') return false
    const c = this.succ.find(x => x.new === ref.new)
    if (!c || !c.accepted) return false
    delete c.accepted
    delete c.verified
    delete c.dead
    const C = this.chain()
    if (C && !this.succAlive(c, C)) this.succ = this.succ.filter(x => x !== c)
    return true
  }

  claims(): ClaimView[] {
    return [
      ...this.pending.map(cr => ({ kind: 'cr' as const, id: recordId(cr), cr })),
      ...this.succ.map(c => ({ kind: 'succ' as const, ...c })),
    ]
  }

  // What waits unchecked: v2 moves, chain records and badge tokens.
  held(): { succ: SuccessionV2[]; recs: ChainRecord[]; badges: BadgeToken[] } {
    const C = this.chain()
    return {
      succ: this.heldSucc.map(x => x.succ),
      recs: C ? [...this.recs.values()].filter(r => !C.verifies(r)) : [...this.heldRecs],
      badges: [...this.badgeTodo],
    }
  }

  warnings(name: string): string[] {
    return [
      ...(this.warning ? [warningText(this.warning, name)] : []),
      ...(this.crOverflow ? [MANY_RECORDS] : []),
      ...(this.succOverflow ? [MANY_MOVES] : []),
    ]
  }

  // ----- The badge -----

  private onBadge(tok: BadgeToken) {
    if (tok.ik !== this.ik) return
    const C = this.chain()
    const verdict = tokenOk(tok, C)
    if (verdict === 'wait') {
      this.badgeTodo.push(tok)
      cut(this.badgeTodo, BADGES_HELD)
      return
    }
    if (verdict !== 'take') return
    const have = this.badge
    if (!have || (C && (have.head?.n ?? -1) < tok.head!.n) || tok.iat > have.iat) this.badge = tok
  }

  private dropStaleBadge() {
    const C = this.chain()
    if (!C || !this.badge?.head) return
    if (tokenOk(this.badge, C) !== 'take') this.badge = undefined
  }

  private retryBadges() {
    const todo = this.badgeTodo
    this.badgeTodo = []
    for (const t of todo) this.onBadge(t)
  }

  // ----- Storage -----

  toJSON(): Record<string, unknown> {
    return {
      v: 1,
      ik: this.ik,
      st: this.st,
      cr: this.cr,
      recs: [...this.recs.values()],
      certs1: [...this.certs1],
      revs1: [...this.revs1],
      certs2: this.certs2,
      revs2: this.revs2,
      profiles2: this.profiles2,
      proof: this.proof,
      pending: this.pending,
      crOverflow: this.crOverflow,
      heldRecs: this.heldRecs,
      succ: this.succ,
      succOverflow: this.succOverflow,
      heldSucc: this.heldSucc,
      warning: this.warning,
      badge: this.badge,
      badgeTodo: this.badgeTodo,
      now: this.now,
    }
  }

  // Reads what `toJSON` wrote, checking every record again; null when it isn't one.
  static parse(x: unknown): ContactClaims | null {
    if (!isRecord(x) || x.v !== 1 || !isKeyId(x.ik)) return null
    const { st } = x
    if (st !== 'known' && st !== 'none' && st !== 'unknown') return null
    const c = new ContactClaims(x.ik, 'carried')
    const list = <T>(v: unknown, ok: (y: unknown) => y is T, max: number): T[] =>
      Array.isArray(v) ? v.filter(ok).slice(0, max) : []
    const key = (y: unknown): y is string => isKeyId(y)
    const flag = (v: unknown) => v === true
    const crOk = (y: unknown): y is CreationRecord => c.crOk(y)
    const recOk = (y: unknown): y is ChainRecord => c.recOk(y)
    if (st === 'known') {
      if (!crOk(x.cr)) return null
      c.cr = x.cr
    }
    c.st = st
    c.now = isInt(x.now) ? x.now : 0
    c.proof = flag(x.proof) || st === 'none'
    c.certs1 = new Set(list(x.certs1, key, 64))
    c.revs1 = new Set(list(x.revs1, key, 64))
    c.certs2 = list(x.certs2, (y): y is CertV2 => verifyCertV2(y, c.ik), CERTS2_MAX)
    c.revs2 = list(x.revs2, (y): y is RevocationV2 => isRevocationV2(y, c.ik), REVS2_MAX)
    c.profiles2 = list(x.profiles2, (y): y is ProfileV2 => verifyProfileV2(y, c.ik), PROFILES2_MAX)
    if (st === 'known') for (const r of list(x.recs, recOk, STORED_RECORDS)) c.addRec(r)
    if (st === 'unknown') {
      c.pending = list(x.pending, crOk, CLAIMS_MAX + 1)
      const held = list(x.heldRecs, recOk, STORED_RECORDS)
      for (const r of parentsFirst(held)) c.hold(r)
      const kept = new Set(c.heldRecs)
      c.heldRecs = held.filter(r => kept.has(r))
      c.crOverflow = flag(x.crOverflow)
    }
    c.succOverflow = flag(x.succOverflow)
    c.succ = list(x.succ, (y): y is SuccClaim => succOk(y, c.ik), 2 * CLAIMS_MAX)
    if (st !== 'none')
      c.heldSucc = list(x.heldSucc, (y): y is HeldSucc => heldOk(y, c.ik), CLAIMS_MAX + 1)
    const w = x.warning
    c.warning =
      w === 'impersonation' || w === 'ik-hot' || w === 'phrase' || w === 'move-dead' ? w : null
    if (tokenShape(x.badge) && x.badge.ik === c.ik) c.badge = x.badge
    c.badgeTodo = list(x.badgeTodo, tokenShape, BADGES_HELD).filter(t => t.ik === c.ik)
    return c
  }
}

const srcOk = (x: unknown): x is Src =>
  x === 'card' || x === 'hello' || x === 'qr' || x === 'safety' || x === 'server' || x === 'carried'

const headShape = (x: unknown): x is Head => isRecord(x) && isInt(x.n) && typeof x.d === 'string'

const tokenShape = (x: unknown): x is BadgeToken =>
  isRecord(x) &&
  typeof x.sub === 'string' &&
  isKeyId(x.ik) &&
  isInt(x.iat) &&
  (x.head === undefined || headShape(x.head))

const optFlag = (x: unknown) => x === undefined || typeof x === 'boolean'

const succOk = (x: unknown, ik: string): x is SuccClaim => {
  if (!isRecord(x) || x.old !== ik || !isKeyId(x.new)) return false
  if (![x.accepted, x.verified, x.dead, x.legacy].every(optFlag) || typeof x.direct !== 'boolean')
    return false
  const { succ } = x
  if (!isRecord(succ) || succ.old !== ik || succ.new !== x.new) return false
  if (x.legacy) return x.v === 1 && verifySuccession(succ)
  if (x.v === 1) return verifySuccessionV1(succ, x.cr)
  return (
    x.v === 2 &&
    verifySuccessionV2New(succ, x.cr) &&
    headShape(x.head) &&
    isKeyId(x.by) &&
    succession2SignedBy(succ, x.by)
  )
}

const heldOk = (x: unknown, ik: string): x is HeldSucc =>
  isRecord(x) &&
  verifySuccessionV2New(x.succ, x.cr) &&
  x.succ.old === ik &&
  Array.isArray(x.chain) &&
  x.chain.length <= HELD_RECORDS &&
  x.chain.every(r => isChainRecord(r) && r.ik === ik) &&
  srcOk(x.src) &&
  isInt(x.at)

// A badge token against the chain a contact holds for its identity: with no chain, any token
// (take); else ignore a token with no head, one whose head is older than a record held, and one
// naming an unknown head that isn't deeper; a deeper unknown head waits for the chain.
export const tokenOk = (
  tok: BadgeToken,
  view: ChainView | undefined
): 'take' | 'wait' | 'ignore' => {
  if (!view) return 'take'
  if (!tok.head) return 'ignore'
  const h = headIn(view, tok.head.d)
  if (!h) return tok.head.n > view.top ? 'wait' : 'ignore'
  return view.counts(h.d) && h.n >= view.top && h.n === tok.head.n ? 'take' : 'ignore'
}

// What a server's members show for a member's moves: the distinct verified `succ` values of all
// of its `profile` writes, never only the register's current value.
export const serverSuccClaims = (
  writes: readonly { succ?: { new: string; verified: boolean } }[]
) => [...new Set(writes.flatMap(w => (w.succ?.verified ? [w.succ.new] : [])))].sort()

// The half the user's own client shows.
export const ownHalf = (ik: string, cr?: CreationRecord) => safetyHalf(ik, cr?.rk)

// ----- Restoring from the phrase -----

export type Restore =
  // the phrase's key is in force at a head: the next record goes after it
  | { kind: 'record'; ik: string; cr: CreationRecord; chain: ChainRecord[]; head: Head }
  // no record can follow: the chain is at its cap, or rival resets froze it (the move is signed
  // by the phrase's branch key at `head`)
  | { kind: 'move'; why: 'at-cap' }
  | { kind: 'move'; why: 'frozen'; ik: string; head: Head }
  | { kind: 'fetch' }
  | { kind: 'none'; why: 'no-id' | 'no-record' }

const restoreOne = (
  rk: string,
  ik: string,
  crs: readonly CreationRecord[],
  recs: readonly ChainRecord[]
): Restore => {
  const mine = crs.filter(c => c.ik === ik)
  const chain = recs.filter(r => r.ik === ik)
  for (const cr of mine) {
    const C = readChain(cr, chain)
    const nodes: Head[] = [
      { n: 0, d: recordId(cr) },
      ...C.records().map(r => ({ n: r.n, d: recordId(r) })),
    ]
    const held = nodes.filter(h => C.inForce(h) === rk)
    if (C.frozen) {
      const deepest = [...held].sort((a, b) => b.n - a.n)[0]
      if (deepest) return { kind: 'move', why: 'frozen', ik, head: deepest }
      continue
    }
    const h = C.heads.find(x => C.inForce(x) === rk)
    if (h) {
      if (h.n >= CHAIN_MAX) return { kind: 'move', why: 'at-cap' }
      return { kind: 'record', ik, cr, chain: C.records(), head: h }
    }
    if (held.length) return { kind: 'fetch' }
  }
  return mine.length ? { kind: 'fetch' } : { kind: 'none', why: 'no-record' }
}

// Every distinct id from every source is tried against what was fetched, and the best outcome
// wins: a record, then the move, then keep fetching, then nothing.
export const rankRestore = (
  rk: string,
  ids: readonly string[],
  fetched: { crs: readonly unknown[]; recs: readonly unknown[] }
): Restore => {
  const cand = [...new Set(ids.filter(x => x))]
  if (!cand.length) return { kind: 'none', why: 'no-id' }
  const crs = fetched.crs.filter(isCreation)
  const recs = fetched.recs.filter(isChainRecord)
  const rank = (o: Restore) =>
    o.kind === 'record' ? 0 : o.kind === 'move' ? 1 : o.kind === 'fetch' ? 2 : 3
  return cand.map(ik => restoreOne(rk, ik, crs, recs)).sort((a, b) => rank(a) - rank(b))[0]
}
