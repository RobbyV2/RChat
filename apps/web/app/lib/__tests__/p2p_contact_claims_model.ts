import { sha256 } from '@noble/hashes/sha2.js'
import { b64u, bytesOf, utf8 } from '../p2p/canonical'
import {
  CHAIN_MAX,
  makeCreation,
  readChain,
  recordId,
  safetyHalf,
  TAG2,
  type ChainRecord,
  type CreationRecord,
} from '../p2p/chain'
import {
  ContactClaims,
  rankRestore,
  serverSuccClaims,
  warningText,
  type BadgeToken,
  type ClaimMsg,
  type Src,
} from '../p2p/contact_claims'
import {
  keyId,
  publicOf,
  signCert,
  signProfile,
  signRevocation,
  signTagged,
  TAG,
  type KeyPair,
} from '../p2p/keys'
import * as M from './acl_model_rules3/contacts'

// The model's contact vocabulary (contacts.ts of the rules-3 model: keys, devices and identities are
// names, a record "verifies" by a flag) over production's `ContactClaims` with real keys and
// records. `Contact` here has the model class's surface, so the model's tests run on production
// as they are written; every step also runs the model itself beside it and compares the two.

export type { CR, Rec, Msg, Token } from './acl_model_rules3/contacts'
export { CHAIN_MAX, serverSuccClaims }
type CR = M.CR
type Rec = M.Rec
type Msg = M.Msg

const AT = 1_762_400_000_000

const pairs = new Map<string, KeyPair>()
const pair = (name: string): KeyPair => {
  let k = pairs.get(name)
  if (!k) {
    const sk = sha256(utf8(`rchat-p2p-contact-test ${name}`))
    k = { sk, pk: publicOf(sk) }
    pairs.set(name, k)
  }
  return k
}
const ids = new Map<string, string>()
const named = new Map<string, string>()
const idOf = (kind: string, name: string) => {
  const key = `${kind} ${name}`
  let id = ids.get(key)
  if (!id) {
    id = keyId(pair(key).pk)
    ids.set(key, id)
    named.set(id, name)
  }
  return id
}
export const ikOf = (a: string) => idOf('ik', a)
export const dkOf = (d: string) => idOf('dk', d)
export const kOf = (k: string) => idOf('key', k)
export const ikPair = (a: string) => pair(`ik ${a}`)
export const keyPair = (k: string) => pair(`key ${k}`)
const nameOf = (id: string) => named.get(id) ?? id
const junk = pair('junk')

const isDigest = (x: string) => bytesOf(x, 32) !== null
const digest = (x: string) => (isDigest(x) ? x : b64u(sha256(utf8(`rchat-p2p-contact-test ${x}`))))

// real record identity -> the model's digest of the same record, and its n
const modelOf = new Map<string, string>()
const nOf = new Map<string, number>()
const toM = (d: string) => modelOf.get(d) ?? d

const made = new Map<string, unknown>()
const once = <T>(key: string, make: () => T): T => {
  if (!made.has(key)) made.set(key, make())
  return made.get(key) as T
}

const pkIn = (c: { ik: string }, name: string) => (name === c.ik ? ikOf(c.ik) : kOf(name))

export const creation = (c: CR): CreationRecord =>
  once(`cr ${JSON.stringify(c)}`, () => {
    const cr = makeCreation(ikPair(c.ik), keyPair(c.rk), pkIn(c, c.pk), AT)
    const body = { v: cr.v, ik: cr.ik, n: cr.n, rk: cr.rk, pk: cr.pk, at: cr.at }
    return {
      ...cr,
      ...(c.byIk ? {} : { sig_ik: signTagged(junk.sk, TAG2.create, body) }),
      ...(c.byRk ? {} : { sig_rk: signTagged(junk.sk, TAG2.create, body) }),
      ...(c.extra ?? {}),
    }
  })

export const record = (r: Rec): ChainRecord => {
  const rec = sign(r)
  const d = recordId(rec)
  if (!modelOf.has(d)) {
    modelOf.set(d, M.recD({ ...r, prev: toM(r.prev) }))
    nOf.set(d, r.n)
  }
  return rec
}

const sign = (r: Rec): ChainRecord =>
  once(`rec ${JSON.stringify(r)}`, () => {
    const body: Record<string, unknown> = {
      v: 1,
      ik: ikOf(r.ik),
      n: r.n,
      prev: digest(r.prev),
      pk: pkIn(r, r.pk),
      keep: [...new Set(r.keep.map(dkOf))].sort(),
      at: AT,
    }
    if (r.rk !== undefined) body.rk = r.rk === '' ? '' : kOf(r.rk)
    const rec = { ...body, sig: signTagged(keyPair(r.by).sk, TAG2.chain, body) } as ChainRecord
    if (r.rk) rec.sig_next = signTagged(keyPair(r.rk).sk, TAG2.chain, body)
    return { ...rec, ...(r.extra ?? {}) }
  })

// The record identities, as the model's `crD` and `recD`: here the real ones.
export const crD = (c: CR): string => {
  const d = recordId(creation({ ...c, byIk: true, byRk: true, extra: undefined }))
  modelOf.set(d, M.crD(c))
  nOf.set(d, 0)
  return d
}
export const recD = (r: Rec): string => recordId(record({ ...r, extra: undefined }))

const halves = new Map<string, string>()
// The safety number half, as the model's `halfOf`: here the real 30 digits.
export const halfOf = (ik: string, rk?: string): string => {
  const key = `${ik} ${rk ?? ''}`
  let h = halves.get(key)
  if (!h) {
    h = safetyHalf(ikOf(ik), rk === undefined ? undefined : kOf(rk))
    halves.set(key, h)
  }
  return h
}
export const ownHalf = (ik: string, cr?: CR) => halfOf(ik, cr?.rk)

const modelMsg = (m: Msg): Msg => {
  if (m.k === 'rec') return { k: 'rec', rec: { ...m.rec, prev: toM(m.rec.prev) } }
  if (m.k === 'succ1') return m.newCr === undefined ? m : { ...m, newCr: toM(m.newCr) }
  if (m.k === 'succ2')
    return {
      ...m,
      head: toM(m.head),
      newCr: m.newCr === undefined ? undefined : toM(m.newCr),
      chain: m.chain.map(r => ({ ...r, prev: toM(r.prev) })),
    }
  if (m.k === 'badge' && m.tok.head)
    return { k: 'badge', tok: { ...m.tok, head: { n: m.tok.head.n, d: toM(m.tok.head.d) } } }
  return m
}

const token = (t: M.Token): BadgeToken => ({
  sub: t.sub,
  ik: ikOf(t.ik),
  iat: t.iat,
  ...(t.head ? { head: { n: t.head.n, d: digest(t.head.d) } } : {}),
})

const by = (ok: boolean, k: KeyPair) => (ok ? k : junk)

export const realMsg = (m: Msg): ClaimMsg =>
  once(`msg ${JSON.stringify(m)}`, (): ClaimMsg => {
    switch (m.k) {
      case 'cr':
        return { k: 'cr', cr: creation(m.cr) }
      case 'rec':
        return { k: 'rec', rec: record(m.rec) }
      case 'cert1':
        dkOf(m.dk)
        return {
          k: 'cert1',
          cert: {
            ...signCert(by(m.byIk, ikPair(m.ik)), pair(`dk ${m.dk}`).pk, AT, 'Browser'),
            ik: ikOf(m.ik),
          },
        }
      case 'rev1':
        return {
          k: 'rev1',
          rev: { ...signRevocation(by(m.byIk, ikPair(m.ik)), dkOf(m.dk), AT), ik: ikOf(m.ik) },
        }
      case 'profile1':
        return {
          k: 'profile1',
          profile: { ...signProfile(by(m.byIk, ikPair(m.ik)), m.ik, AT), ik: ikOf(m.ik) },
        }
      case 'cert2': {
        const body = {
          v: 2,
          ik: ikOf(m.ik),
          dk: dkOf(m.dk),
          pk: kOf(m.pk),
          n: m.n,
          created: AT,
          label: 'Browser',
        }
        return { k: 'cert2', cert: { ...body, sig: signTagged(keyPair(m.by).sk, TAG2.cert, body) } }
      }
      case 'rev2': {
        const body = { v: 2, ik: ikOf(m.ik), dk: dkOf(m.dk), pk: kOf(m.pk), n: m.n, revoked_at: AT }
        return {
          k: 'rev2',
          rev: { ...body, sig: signTagged(keyPair(m.by).sk, TAG2.crevoke, body) },
        }
      }
      case 'profile2': {
        const body = {
          v: 2,
          ik: ikOf(m.ik),
          pk: kOf(m.pk),
          n: m.n,
          name: m.name,
          updated: m.updated,
        }
        return {
          k: 'profile2',
          profile: { ...body, sig: signTagged(keyPair(m.by).sk, TAG2.profile, body) },
        }
      }
      case 'succ1': {
        const old = by(m.byOldIk, ikPair(m.old))
        if (m.newCr === undefined) {
          // the form without new_cr: the new half signed by the new identity key
          const body = { v: 1, old: ikOf(m.old), new: ikOf(m.new.ik), at: AT }
          return {
            k: 'succ',
            succ: {
              ...body,
              sig_old: signTagged(old.sk, TAG.succession, body),
              sig_new: signTagged(by(!!m.byNewIk, ikPair(m.new.ik)).sk, TAG.succession, body),
            },
          }
        }
        const body = {
          v: 1,
          old: ikOf(m.old),
          new: ikOf(m.new.ik),
          new_cr: digest(m.newCr),
          at: AT,
        }
        const next = m.byNewRk ? keyPair(m.new.rk) : m.byNewIk ? ikPair(m.new.ik) : junk
        return {
          k: 'succ',
          succ: {
            ...body,
            sig_old: signTagged(old.sk, TAG2.succ1, body),
            sig_new: signTagged(next.sk, TAG2.succ1, body),
          },
          succ_cr: creation(m.new),
        }
      }
      case 'succ2': {
        const body = {
          v: 2,
          old: ikOf(m.old),
          head: { n: nOf.get(m.head) ?? 1, d: digest(m.head) },
          new: ikOf(m.new.ik),
          new_cr: digest(m.newCr ?? ''),
          at: AT,
        }
        return {
          k: 'succ',
          succ: {
            ...body,
            sig_old: signTagged(keyPair(m.by).sk, TAG2.succ2, body),
            sig_new: signTagged(by(m.byNewRk, keyPair(m.new.rk)).sk, TAG2.succ2, body),
          },
          succ_cr: creation(m.new),
          chain: m.chain.map(record),
        }
      }
      case 'badge':
        return { k: 'badge', token: token(m.tok) }
    }
  })

const crs = new Map<string, CR>()
const noteCr = (m: Msg) => {
  if (m.k === 'cr') crs.set(recordId(creation(m.cr)), m.cr)
}

interface Claim {
  old: string
  new: string
  v: 1 | 2
  legacy?: boolean
  accepted?: boolean
  verified?: boolean
  dead?: boolean
}

const shown = new Map<string, string>()
const flags = (c: Claim) => [c.new, c.v, !!c.legacy, !!c.accepted, !!c.verified, !!c.dead]

export class Contact {
  readonly model: M.Contact
  readonly real: ContactClaims
  cardName?: string

  constructor(
    readonly ik: string,
    src: Src,
    first: Msg[]
  ) {
    first.forEach(noteCr)
    this.model = new M.Contact(ik, src, first.map(modelMsg))
    this.real = new ContactClaims(ikOf(ik), src, first.map(realMsg), 0)
    this.same('at the start')
  }

  get now() {
    return this.model.now
  }
  set now(t: number) {
    this.model.now = t
    this.real.now = t
  }

  recv(m: Msg, src: Src) {
    noteCr(m)
    this.model.recv(modelMsg(m), src)
    this.real.receive(realMsg(m), src, this.model.now)
    this.same(`after ${m.k} from ${src}`)
  }

  accept(c: CR): boolean {
    const want = this.model.accept(c)
    const got = this.real.accept({ kind: 'cr', id: recordId(creation(c)) })
    if (want !== got) throw new Error(`accept: the model says ${want}, production ${got}`)
    this.same('after accept')
    return got
  }

  acceptSucc(next: string, verified: boolean): Claim | undefined {
    const want = this.model.acceptSucc(next, verified)
    const ref = { kind: 'succ' as const, new: ikOf(next) }
    const got = verified ? this.real.verify(ref) : this.real.accept(ref)
    if (!!want !== got) throw new Error(`acceptSucc: the model says ${!!want}, production ${got}`)
    this.same('after acceptSucc')
    return got ? this.succ.find(x => x.new === next) : undefined
  }

  get st() {
    return this.real.st
  }
  get cr(): CR | undefined {
    return this.real.cr && crs.get(recordId(this.real.cr))
  }
  get warning(): string {
    return this.real.warning ? warningText(this.real.warning, this.ik) : ''
  }
  get claims(): { cr: CR }[] {
    return this.real.pending.map(c => ({ cr: crs.get(recordId(c))! }))
  }
  get crOverflow() {
    return this.real.crOverflow
  }
  get held() {
    return this.real.heldRecs
  }
  get succ(): Claim[] {
    return this.real.succ.map(c => {
      const out: Claim = { old: nameOf(c.old), new: nameOf(c.new), v: c.v }
      if (c.legacy) out.legacy = true
      if (c.accepted !== undefined) out.accepted = c.accepted
      if (c.verified !== undefined) out.verified = c.verified
      if (c.dead !== undefined) out.dead = c.dead
      return out
    })
  }
  get succOverflow() {
    return this.real.succOverflow
  }
  get succTodo(): { m: { new: { ik: string } } }[] {
    return this.real.heldSucc.map(x => ({ m: { new: { ik: nameOf(x.succ.new) } } }))
  }
  get badge(): BadgeToken | undefined {
    return this.real.badge
  }
  get badgeTodo() {
    return this.real.badgeTodo
  }
  get log() {
    return this.model.log
  }

  trusted(): string[] {
    return this.real.trusted().map(nameOf).sort()
  }
  // The 30 digits take 5,200 hashes: asked once for each thing they can be made from.
  safetyHalf(): string {
    const p = this.real
    const key = `${p.ik} ${p.st} ${p.cr ? recordId(p.cr) : ''} ${p.pending.map(recordId).join(',')}`
    let h = shown.get(key)
    if (h === undefined) {
      h = p.half() ?? 'scan'
      shown.set(key, h)
    }
    return h
  }
  chain() {
    const C = this.real.chain()
    return C && { top: C.top, at: { get: (d: string) => (C.has(d) ? { d } : undefined) } }
  }

  // Production and the model, side by side.
  private same(when: string) {
    const m = this.model
    const p = this.real
    const mHalf = m.safetyHalf()
    const half =
      mHalf === 'scan'
        ? 'scan'
        : halfOf(this.ik, mHalf.startsWith('v1:') ? mHalf.split(':')[2] : undefined)
    const frozenAtPin = m.warning === '' && p.warning === 'phrase' && !!p.chain()?.frozen
    const want = {
      st: m.st,
      cr: m.cr ? recordId(creation(m.cr)) : undefined,
      trusted: m.trusted(),
      warning: frozenAtPin ? warningText('phrase', this.ik) : m.warning,
      claims: m.claims.map(c => recordId(creation(c.cr))),
      crOverflow: m.crOverflow,
      held: m.held.length,
      succ: m.succ.map(flags),
      succOverflow: m.succOverflow,
      succTodo: m.succTodo.map(x => x.m.new.ik),
      badge: m.badge && [m.badge.sub, m.badge.iat],
      badgeTodo: m.badgeTodo.length,
      half,
      name: M.shownName(Object.assign(m, { cardName: this.cardName })),
      proof: m.proof,
    }
    const got = {
      st: p.st,
      cr: p.cr ? recordId(p.cr) : undefined,
      trusted: this.trusted(),
      warning: this.warning,
      claims: p.pending.map(recordId),
      crOverflow: p.crOverflow,
      held: p.heldRecs.length,
      succ: this.succ.map(flags),
      succOverflow: p.succOverflow,
      succTodo: p.heldSucc.map(x => nameOf(x.succ.new)),
      badge: p.badge && [p.badge.sub, p.badge.iat],
      badgeTodo: p.badgeTodo.length,
      half: this.safetyHalf(),
      name: p.name(this.cardName),
      proof: p.proof,
    }
    const a = JSON.stringify(want)
    const b = JSON.stringify(got)
    if (a !== b) throw new Error(`${this.ik} ${when}: the model has ${a}, production ${b}`)
  }
}

export const shownName = (c: Contact) => c.real.name(c.cardName)

export const chainOf = (c: CR, recs: Rec[]) => {
  const C = readChain(creation(c), recs.map(record))
  const want = M.chainOf(
    c,
    recs.map(r => ({ ...r, prev: toM(r.prev) }))
  )
  if (C.top !== want.top || C.frozen !== want.rival)
    throw new Error(`chainOf: the model has top ${want.top}, production ${C.top}`)
  return { top: C.top, rival: C.frozen }
}

type Restored =
  | { ok: true; ik: string; cr: CR; head: string; rec: Rec }
  | { ok: false; why: string; ik?: string; head?: string }

// The model's `restore`: production ranks the ids, and the next record is the caller's to sign.
export const restore = (
  rk: string,
  names: string[],
  fetched: Msg[],
  newDev: string,
  newPk: string
): Restored => {
  fetched.forEach(noteCr)
  const crsIn = fetched.flatMap(m => (m.k === 'cr' ? [creation(m.cr)] : []))
  const recsIn = fetched.flatMap(m => (m.k === 'rec' ? [record(m.rec)] : []))
  const r = rankRestore(
    kOf(rk),
    names.map(x => (x ? ikOf(x) : x)),
    { crs: crsIn, recs: recsIn }
  )
  let out: Restored
  if (r.kind === 'record') {
    const ik = nameOf(r.ik)
    const n = r.head.n + 1
    out = {
      ok: true,
      ik,
      cr: crs.get(recordId(r.cr))!,
      head: r.head.d,
      rec: { ik, n, prev: r.head.d, by: rk, pk: newPk, keep: [newDev] },
    }
  } else if (r.kind === 'move')
    out =
      r.why === 'frozen'
        ? { ok: false, why: 'frozen', ik: nameOf(r.ik), head: r.head.d }
        : { ok: false, why: 'at-cap' }
  else out = { ok: false, why: r.kind === 'fetch' ? 'keep-fetching' : r.why }
  const want = M.restore(rk, names, fetched.map(modelMsg), newDev, newPk)
  const shape = (x: Restored | M.Restored, model: boolean) =>
    JSON.stringify([
      x.ok,
      x.ok ? '' : x.why,
      x.ik,
      x.head === undefined ? undefined : model ? x.head : toM(x.head),
    ])
  if (shape(want, true) !== shape(out, false))
    throw new Error(`restore: the model has ${shape(want, true)}, production ${shape(out, false)}`)
  return out
}
