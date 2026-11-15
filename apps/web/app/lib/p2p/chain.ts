import { sha256, sha512 } from '@noble/hashes/sha2.js'
import { isRecord } from '../bytes'
import { b64u, bytesOf, canonical, canonicalBytes, concat, isInt, nfc, utf8 } from './canonical'
import {
  cleanName,
  isKeyId,
  keyBytes,
  keyId,
  LABEL_MAX,
  signTagged,
  verifyTagged,
  verifyTaggedStrict,
  type KeyPair,
} from './keys'
import { LOCAL } from './limits'

// The key chain of an identity made with a recovery key: the creation record (n = 0, signed by
// the identity key and the recovery key) and up to CHAIN_MAX records after it, each signed by the
// recovery key in force. Creation and chain records are closed formats, and a record's identity
// is the SHA-256 of its canonical form without its signatures. Also the records that hang off the
// chain: v2 certificates, revocations and profiles, successions and the v2 badge proof.

export const CHAIN_MAX = 8
export const KEEP_MAX = 8
export const KEYS_RECORDS = CHAIN_MAX + 1
export const KEYS_BYTES = 7 * 1024

export const TAG2 = {
  create: 'rchat-p2p-create1\0',
  chain: 'rchat-p2p-chain1\0',
  cert: 'rchat-p2p-cert2\0',
  crevoke: 'rchat-p2p-crevoke2\0',
  profile: 'rchat-p2p-profile2\0',
  succ1: 'rchat-p2p-succ1\0',
  succ2: 'rchat-p2p-succ2\0',
  bind: 'rchat-p2p-bind2\0',
} as const

export interface CreationRecord {
  v: 1
  ik: string
  n: 0
  rk: string
  pk: string
  at: number
  sig_ik: string
  sig_rk: string
}

export interface ChainRecord {
  v: 1
  ik: string
  n: number
  prev: string
  pk: string
  keep: string[]
  rk?: string
  at: number
  sig: string
  sig_next?: string
}

export interface Keys {
  cr: CreationRecord
  chain: ChainRecord[]
}

export interface Head {
  n: number
  d: string
}

const closed = (x: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every(k => k in x) &&
  Object.keys(x).every(k => required.includes(k) || optional.includes(k))

const isSig = (x: unknown) => bytesOf(x, 64) !== null
const isDigest = (x: unknown): x is string => bytesOf(x, 32) !== null

// Canonical JSON refuses -0, so a record holding it is refused before its identity is computed.
const int = (x: unknown, min = 0): x is number => isInt(x, min) && !Object.is(x, -0)

const digestOf = (body: unknown) => b64u(sha256(canonicalBytes(body)))

// Signature checks repeat for every reading of a chain, so their results are kept. The records the
// instance also verifies are checked as it checks them.
const CHECKS_MAX = LOCAL.misc.chainChecks
const STRICT: ReadonlySet<string> = new Set([TAG2.create, TAG2.chain, TAG2.bind])
const checks = new Map<string, boolean>()

const checked = (pk: string, tag: string, body: unknown, sig: string) => {
  let key: string
  try {
    key = `${pk} ${tag}${canonical(body)} ${sig}`
  } catch {
    return false
  }
  const hit = checks.get(key)
  if (hit !== undefined) return hit
  const ok = (STRICT.has(tag) ? verifyTaggedStrict : verifyTagged)(pk, tag, body, sig)
  if (checks.size >= CHECKS_MAX) checks.clear()
  checks.set(key, ok)
  return ok
}

const creationBody = ({ v, ik, n, rk, pk, at }: CreationRecord) => ({ v, ik, n, rk, pk, at })

const chainBody = ({ v, ik, n, prev, pk, keep, rk, at }: ChainRecord) =>
  rk === undefined ? { v, ik, n, prev, pk, keep, at } : { v, ik, n, prev, pk, keep, rk, at }

const isChainShape = (x: Record<string, unknown>) => 'prev' in x

export const recordId = (r: CreationRecord | ChainRecord): string =>
  digestOf(
    isChainShape(r as unknown as Record<string, unknown>)
      ? chainBody(r as ChainRecord)
      : creationBody(r as CreationRecord)
  )

export const headOf = (r: CreationRecord | ChainRecord): Head => ({ n: r.n, d: recordId(r) })

export const makeCreation = (ik: KeyPair, rk: KeyPair, pk: string, at: number): CreationRecord => {
  const body = { v: 1 as const, ik: keyId(ik.pk), n: 0 as const, rk: keyId(rk.pk), pk, at }
  return {
    ...body,
    sig_ik: signTagged(ik.sk, TAG2.create, body),
    sig_rk: signTagged(rk.sk, TAG2.create, body),
  }
}

const sortedKeys = (keep: string[]) => [...new Set(keep)].sort()

export const makeRecovery = (
  ik: string,
  rk: KeyPair,
  prev: Head,
  pk: string,
  keep: string[],
  at: number
): ChainRecord => {
  const body = { v: 1 as const, ik, n: prev.n + 1, prev: prev.d, pk, keep: sortedKeys(keep), at }
  return { ...body, sig: signTagged(rk.sk, TAG2.chain, body) }
}

export const makeReset = (
  ik: string,
  rk: KeyPair,
  next: KeyPair,
  prev: Head,
  pk: string,
  keep: string[],
  at: number
): ChainRecord => {
  const body = {
    v: 1 as const,
    ik,
    n: prev.n + 1,
    prev: prev.d,
    pk,
    keep: sortedKeys(keep),
    rk: keyId(next.pk),
    at,
  }
  return {
    ...body,
    sig: signTagged(rk.sk, TAG2.chain, body),
    sig_next: signTagged(next.sk, TAG2.chain, body),
  }
}

export const makeRemoval = (
  ik: string,
  rk: KeyPair,
  prev: Head,
  pk: string,
  keep: string[],
  at: number
): ChainRecord => {
  const body = {
    v: 1 as const,
    ik,
    n: prev.n + 1,
    prev: prev.d,
    pk,
    keep: sortedKeys(keep),
    rk: '',
    at,
  }
  return { ...body, sig: signTagged(rk.sk, TAG2.chain, body) }
}

export const isCreation = (x: unknown): x is CreationRecord => {
  if (!isRecord(x) || !closed(x, ['v', 'ik', 'n', 'rk', 'pk', 'at', 'sig_ik', 'sig_rk']))
    return false
  const { v, ik, n, rk, pk, at, sig_ik, sig_rk } = x
  if (
    v !== 1 ||
    !Object.is(n, 0) ||
    !isKeyId(ik) ||
    !isKeyId(rk) ||
    !isKeyId(pk) ||
    pk === ik ||
    !int(at) ||
    !isSig(sig_ik) ||
    !isSig(sig_rk)
  )
    return false
  const body = creationBody(x as unknown as CreationRecord)
  return (
    checked(ik, TAG2.create, body, sig_ik as string) &&
    checked(rk, TAG2.create, body, sig_rk as string)
  )
}

export const isChainRecord = (x: unknown): x is ChainRecord => {
  if (
    !isRecord(x) ||
    !closed(x, ['v', 'ik', 'n', 'prev', 'pk', 'keep', 'at', 'sig'], ['rk', 'sig_next'])
  )
    return false
  const { v, ik, n, prev, pk, keep, rk, at, sig, sig_next } = x
  const reset = typeof rk === 'string' && rk !== ''
  return (
    v === 1 &&
    isKeyId(ik) &&
    int(n, 1) &&
    n <= CHAIN_MAX &&
    isDigest(prev) &&
    isKeyId(pk) &&
    pk !== ik &&
    Array.isArray(keep) &&
    keep.length <= KEEP_MAX &&
    keep.every(isKeyId) &&
    (!('rk' in x) || rk === '' || isKeyId(rk)) &&
    int(at) &&
    isSig(sig) &&
    (reset ? isSig(sig_next) : !('sig_next' in x))
  )
}

export type ChainKind = 'recovery' | 'reset' | 'removal'

export const kindOf = (r: ChainRecord): ChainKind =>
  r.rk === undefined ? 'recovery' : r.rk === '' ? 'removal' : 'reset'

export interface ChainView {
  cr: CreationRecord
  heads: Head[]
  top: number
  frozen: boolean
  has(d: string): boolean
  verifies(r: ChainRecord): boolean
  counts(d: string): boolean
  dead(d: string): boolean
  deadKey(key: string): boolean
  under(a: string, b: string): boolean
  primary(h: Head): string
  inForce(h: Head): string
  trusted(h: Head): string[]
  signer(d: string): string
  record(d: string): ChainRecord | undefined
  records(): ChainRecord[]
  recoveryKeys(h: Head): string[]
}

interface Node {
  d: string
  n: number
  par?: Node
  rec?: ChainRecord
  key: string
  prim: string
}

const byDigest = (a: { d: string }, b: { d: string }) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0)

export const readChain = (cr: CreationRecord, recs: Iterable<ChainRecord>): ChainView => {
  if (!isCreation(cr)) throw new Error('bad creation record')
  const root: Node = { d: recordId(cr), n: 0, key: cr.rk, prim: cr.pk }
  const at = new Map<string, Node>([[root.d, root]])
  // Copies of one record may differ in their signatures: a copy that doesn't verify never
  // stands in for one that does.
  const pending = new Map<string, { d: string; r: ChainRecord }>()
  for (const r of recs)
    if (isChainRecord(r) && r.ik === cr.ik) {
      const d = recordId(r)
      pending.set(`${d} ${r.sig} ${r.sig_next ?? ''}`, { d, r })
    }
  const signed = (r: ChainRecord, key: string) => {
    const body = chainBody(r)
    return (
      checked(key, TAG2.chain, body, r.sig) &&
      (!r.rk || checked(r.rk, TAG2.chain, body, r.sig_next ?? ''))
    )
  }
  for (let grew = true; grew;) {
    grew = false
    for (const [copy, { d, r }] of pending) {
      const p = at.get(r.prev)
      if (!p || r.n !== p.n + 1) continue
      pending.delete(copy)
      if (at.has(d) || !signed(r, p.key)) continue
      const key = r.rk === undefined ? p.key : r.rk === '' ? r.pk : r.rk
      at.set(d, { d, n: r.n, par: p, rec: r, key, prim: r.pk })
      grew = true
    }
  }
  const up = (x: Node, y: Node) => {
    for (let z: Node | undefined = y; z; z = z.par) if (z === x) return true
    return false
  }
  const nodes = [...at.values()]
  const changes = nodes.filter(x => x.rec && x.rec.rk !== undefined)
  const killed = new Set<Node>()
  let frozen = false
  for (const m of changes)
    for (const x of nodes) {
      if (x === m || !x.par || x.par.key !== m.par!.key || up(x, m) || up(m, x)) continue
      killed.add(x)
      if (x.rec!.rk !== undefined) frozen = true
    }
  const alive = (x: Node) => {
    for (let z: Node | undefined = x; z; z = z.par) if (killed.has(z)) return false
    return true
  }
  const live = nodes.filter(alive)
  const top = Math.max(...live.map(x => x.n))
  const heads = live
    .filter(x => x.n === top)
    .sort(byDigest)
    .map(({ n, d }) => ({ n, d }))
  const node = (h: Head) => {
    const x = at.get(h.d)
    return x && x.n === h.n ? x : undefined
  }
  return {
    cr,
    heads,
    top,
    frozen,
    has: d => at.has(d),
    verifies: r => {
      const p = isChainRecord(r) ? at.get(recordId(r))?.par : undefined
      return !!p && signed(r, p.key)
    },
    counts: d => {
      const x = at.get(d)
      return !!x && alive(x)
    },
    dead: d => {
      const x = at.get(d)
      return !!x && !alive(x)
    },
    deadKey: key => changes.some(m => m.par!.key === key && alive(m)),
    under: (a, b) => {
      const x = at.get(a)
      const y = at.get(b)
      return !!x && !!y && up(x, y)
    },
    primary: h => node(h)?.prim ?? '',
    inForce: h => node(h)?.key ?? '',
    trusted: h => [...(node(h)?.rec?.keep ?? [])].sort(),
    signer: d => at.get(d)?.par?.key ?? '',
    record: d => at.get(d)?.rec,
    records: () =>
      nodes
        .filter(x => x.rec)
        .sort((a, b) => a.n - b.n || byDigest(a, b))
        .map(x => x.rec!),
    recoveryKeys: h => {
      const out: string[] = []
      for (let z = node(h); z; z = z.par) if (alive(z) && !out.includes(z.key)) out.push(z.key)
      return out
    },
  }
}

// The bounds of a `{cr, chain}`: at most KEYS_RECORDS records and KEYS_BYTES of canonical JSON.
// Checked before any signature, and a chain with too many records is not read at all.
const keysFit = (cr: unknown, chain: unknown[]) => {
  if (chain.length > KEYS_RECORDS - 1) return false
  try {
    return canonicalBytes({ cr, chain }).length <= KEYS_BYTES
  } catch {
    return false
  }
}

// The `{cr, chain}` shape of a hello's `keys`, `keys_old` and `yours`, of `redeem` and of the
// account's identity record: the creation record and the chain records in order of n.
export const readKeys = (x: unknown): Keys | null => {
  if (!isRecord(x)) return null
  const { cr, chain } = x
  if (!Array.isArray(chain) || !keysFit(cr, chain) || !isCreation(cr)) return null
  let n = 1
  for (const r of chain) {
    if (!isChainRecord(r) || r.ik !== cr.ik || r.n < n) return null
    n = r.n
  }
  return { cr, chain: chain as ChainRecord[] }
}

export const keysOf = (view: ChainView): Keys => ({ cr: view.cr, chain: view.records() })

// ----- Certificate v2 -----

export interface CertV2 {
  v: 2
  ik: string
  dk: string
  pk: string
  n: number
  created: number
  label: string
  sig: string
}

const certBody2 = ({ v, ik, dk, pk, n, created, label }: CertV2) => ({
  v,
  ik,
  dk,
  pk,
  n,
  created,
  label,
})

export const signCertV2 = (
  pk: KeyPair,
  ik: string,
  n: number,
  dk: string,
  created: number,
  label: string
): CertV2 => {
  const body = {
    v: 2 as const,
    ik,
    dk,
    pk: keyId(pk.pk),
    n,
    created,
    label: nfc(label).slice(0, LABEL_MAX),
  }
  return { ...body, sig: signTagged(pk.sk, TAG2.cert, body) }
}

export const verifyCertV2 = (x: unknown, ik?: string): x is CertV2 => {
  if (!isRecord(x) || !closed(x, ['v', 'ik', 'dk', 'pk', 'n', 'created', 'label', 'sig']))
    return false
  const { v, dk, pk, n, created, label, sig } = x
  if (
    v !== 2 ||
    !isKeyId(x.ik) ||
    !isKeyId(dk) ||
    !isKeyId(pk) ||
    !int(n) ||
    n > CHAIN_MAX ||
    !int(created) ||
    typeof label !== 'string' ||
    label.length > LABEL_MAX ||
    !isSig(sig) ||
    (ik !== undefined && x.ik !== ik)
  )
    return false
  return checked(pk, TAG2.cert, certBody2(x as unknown as CertV2), sig as string)
}

// ----- Revocation v2 -----

export interface RevocationV2 {
  v: 2
  ik: string
  dk: string
  pk: string
  n: number
  revoked_at: number
  successor?: string
  sig: string
}

const revocationBody2 = ({ v, ik, dk, pk, n, revoked_at, successor }: RevocationV2) =>
  successor === undefined
    ? { v, ik, dk, pk, n, revoked_at }
    : { v, ik, dk, pk, n, revoked_at, successor }

// Signed by the head's primary or by the recovery key; `pk` and `n` name the head either way.
export const signRevocationV2 = (
  by: KeyPair,
  ik: string,
  pk: string,
  n: number,
  dk: string,
  revokedAt: number,
  successor?: string
): RevocationV2 => {
  const body: Omit<RevocationV2, 'sig'> = { v: 2, ik, dk, pk, n, revoked_at: revokedAt }
  if (successor !== undefined) body.successor = successor
  return { ...body, sig: signTagged(by.sk, TAG2.crevoke, body) }
}

export const isRevocationV2 = (x: unknown, ik?: string): x is RevocationV2 => {
  if (!isRecord(x) || !closed(x, ['v', 'ik', 'dk', 'pk', 'n', 'revoked_at', 'sig'], ['successor']))
    return false
  const { v, dk, pk, n, revoked_at, successor, sig } = x
  return (
    v === 2 &&
    isKeyId(x.ik) &&
    isKeyId(dk) &&
    isKeyId(pk) &&
    int(n) &&
    n <= CHAIN_MAX &&
    int(revoked_at) &&
    (!('successor' in x) || isKeyId(successor)) &&
    isSig(sig) &&
    (ik === undefined || x.ik === ik)
  )
}

export const verifyRevocationV2 = (x: unknown, by: string, ik?: string): x is RevocationV2 =>
  isRevocationV2(x, ik) && checked(by, TAG2.crevoke, revocationBody2(x), x.sig)

// The key that signed it: the primary it names, else one of `keys`.
export const revocationSigner = (r: RevocationV2, keys: Iterable<string>): string | null => {
  for (const k of new Set([r.pk, ...keys])) if (verifyRevocationV2(r, k)) return k
  return null
}

// ----- Profile v2 -----

export interface ProfileV2 {
  v: 2
  ik: string
  pk: string
  n: number
  name: string
  color?: string
  updated: number
  sig: string
}

const COLOR = /^#[0-9a-f]{6}$/

const profileBody2 = ({ v, ik, pk, n, name, color, updated }: ProfileV2) =>
  color === undefined ? { v, ik, pk, n, name, updated } : { v, ik, pk, n, name, color, updated }

export const signProfileV2 = (
  pk: KeyPair,
  ik: string,
  n: number,
  name: string,
  updated: number,
  color?: string
): ProfileV2 => {
  const body: Omit<ProfileV2, 'sig'> = {
    v: 2,
    ik,
    pk: keyId(pk.pk),
    n,
    name: cleanName(name),
    updated,
  }
  if (color !== undefined && COLOR.test(color)) body.color = color
  return { ...body, sig: signTagged(pk.sk, TAG2.profile, body) }
}

export const verifyProfileV2 = (x: unknown, ik?: string): x is ProfileV2 => {
  if (!isRecord(x) || !closed(x, ['v', 'ik', 'pk', 'n', 'name', 'updated', 'sig'], ['color']))
    return false
  const { v, pk, n, name, color, updated, sig } = x
  if (
    v !== 2 ||
    !isKeyId(x.ik) ||
    !isKeyId(pk) ||
    !int(n) ||
    n > CHAIN_MAX ||
    typeof name !== 'string' ||
    !name ||
    name !== cleanName(name) ||
    ('color' in x && (typeof color !== 'string' || !COLOR.test(color))) ||
    !int(updated) ||
    !isSig(sig) ||
    (ik !== undefined && x.ik !== ik)
  )
    return false
  return checked(pk, TAG2.profile, profileBody2(x as unknown as ProfileV2), sig as string)
}

// A record signed by a primary counts only in its own epoch: at a head with that n and primary.
export const atHead = (view: ChainView, r: { n: number; pk: string }) =>
  view.heads.some(h => h.n === r.n && view.primary(h) === r.pk)

// A revocation counts at a head when the head's primary signed it in its epoch, or a recovery
// key of the head's past that no reset or removal killed.
export const revokes = (view: ChainView, h: Head, r: RevocationV2): boolean => {
  if (r.ik !== view.cr.ik) return false
  const prim = view.primary(h)
  const keys = view.recoveryKeys(h)
  const by = revocationSigner(r, keys)
  if (by === null) return false
  return (r.n === h.n && r.pk === prim && by === prim) || (keys.includes(by) && !view.deadKey(by))
}

// The devices a peer trusts for a chain: each head's keep (in epoch 0 the v1 certificates),
// plus v2 certificates under the head's primary, minus the revocations that count there. None
// after rival resets.
export const trustedDevices = (
  view: ChainView,
  certs1: Iterable<string>,
  certs2: Iterable<CertV2>,
  revs2: Iterable<RevocationV2>
): string[] => {
  if (view.frozen) return []
  const out = new Set<string>()
  const certs = [...certs2]
  const revs = [...revs2]
  for (const h of view.heads) {
    const prim = view.primary(h)
    for (const d of h.n === 0 ? certs1 : view.trusted(h)) out.add(d)
    for (const c of certs) if (c.ik === view.cr.ik && c.n === h.n && c.pk === prim) out.add(c.dk)
    for (const r of revs) if (revokes(view, h, r)) out.delete(r.dk)
  }
  return [...out].sort()
}

// ----- Succession -----

export interface SuccessionV1 {
  v: 1
  old: string
  new: string
  new_cr: string
  at: number
  sig_old: string
  sig_new: string
}

export interface SuccessionV2 {
  v: 2
  old: string
  head: Head
  new: string
  new_cr: string
  at: number
  sig_old: string
  sig_new: string
}

const succBody1 = ({ v, old, new: next, new_cr, at }: SuccessionV1) => ({
  v,
  old,
  new: next,
  new_cr,
  at,
})

const succBody2 = ({ v, old, head, new: next, new_cr, at }: SuccessionV2) => ({
  v,
  old,
  head: { n: head.n, d: head.d },
  new: next,
  new_cr,
  at,
})

export const signSuccessionV1 = (
  old: KeyPair,
  newRk: KeyPair,
  newCr: CreationRecord,
  at: number
): SuccessionV1 => {
  const body = {
    v: 1 as const,
    old: keyId(old.pk),
    new: newCr.ik,
    new_cr: recordId(newCr),
    at,
  }
  return {
    ...body,
    sig_old: signTagged(old.sk, TAG2.succ1, body),
    sig_new: signTagged(newRk.sk, TAG2.succ1, body),
  }
}

export const signSuccessionV2 = (
  oldKey: KeyPair,
  old: string,
  head: Head,
  newRk: KeyPair,
  newCr: CreationRecord,
  at: number
): SuccessionV2 => {
  const body = {
    v: 2 as const,
    old,
    head: { n: head.n, d: head.d },
    new: newCr.ik,
    new_cr: recordId(newCr),
    at,
  }
  return {
    ...body,
    sig_old: signTagged(oldKey.sk, TAG2.succ2, body),
    sig_new: signTagged(newRk.sk, TAG2.succ2, body),
  }
}

const names = (x: Record<string, unknown>, cr: unknown): cr is CreationRecord =>
  isCreation(cr) && cr.ik === x.new && recordId(cr) === x.new_cr && x.old !== x.new

export const isSuccessionV1 = (x: unknown): x is SuccessionV1 =>
  isRecord(x) &&
  closed(x, ['v', 'old', 'new', 'new_cr', 'at', 'sig_old', 'sig_new']) &&
  x.v === 1 &&
  isKeyId(x.old) &&
  isKeyId(x.new) &&
  isDigest(x.new_cr) &&
  int(x.at) &&
  isSig(x.sig_old) &&
  isSig(x.sig_new)

// `newCr` is the new identity's creation record, which travels beside the succession.
export const verifySuccessionV1 = (x: unknown, newCr: unknown): x is SuccessionV1 => {
  if (!isSuccessionV1(x) || !names(x as unknown as Record<string, unknown>, newCr)) return false
  const body = succBody1(x)
  return (
    checked(x.old, TAG2.succ1, body, x.sig_old) && checked(newCr.rk, TAG2.succ1, body, x.sig_new)
  )
}

export const isSuccessionV2 = (x: unknown): x is SuccessionV2 => {
  if (!isRecord(x) || !closed(x, ['v', 'old', 'head', 'new', 'new_cr', 'at', 'sig_old', 'sig_new']))
    return false
  const { v, old, head, new_cr, at, sig_old, sig_new } = x
  return (
    v === 2 &&
    isKeyId(old) &&
    isRecord(head) &&
    closed(head, ['n', 'd']) &&
    int(head.n) &&
    head.n <= CHAIN_MAX &&
    isDigest(head.d) &&
    isKeyId(x.new) &&
    isDigest(new_cr) &&
    int(at) &&
    isSig(sig_old) &&
    isSig(sig_new)
  )
}

// The new identity's half: its creation record is the one named, and its recovery key signed.
export const verifySuccessionV2New = (x: unknown, newCr: unknown): x is SuccessionV2 =>
  isSuccessionV2(x) &&
  names(x as unknown as Record<string, unknown>, newCr) &&
  checked(newCr.rk, TAG2.succ2, succBody2(x), x.sig_new)

// The old identity's half: `by` is its recovery key in force after the named head.
export const succession2SignedBy = (x: SuccessionV2, by: string) =>
  checked(by, TAG2.succ2, succBody2(x), x.sig_old)

export const verifySuccessionV2 = (x: unknown, newCr: unknown, by: string): x is SuccessionV2 =>
  verifySuccessionV2New(x, newCr) && succession2SignedBy(x, by)

export type Succession2 = SuccessionV1 | SuccessionV2

// A `profile` write's content and a card carry a succession as two sibling fields.
export const readSuccession = (
  x: unknown
): { succ: Succession2; succ_cr: CreationRecord } | null => {
  if (!isRecord(x)) return null
  const { succ, succ_cr } = x
  if (!isCreation(succ_cr)) return null
  if (!isSuccessionV1(succ) && !isSuccessionV2(succ)) return null
  return names(succ as unknown as Record<string, unknown>, succ_cr) ? { succ, succ_cr } : null
}

// ----- Badge proof v2 -----

export const bindingBody2 = (sub: string, ik: string, head: Head, ts: number) => ({
  sub,
  ik,
  head: { n: head.n, d: head.d },
  ts,
})

export const bindingProof2 = (pk: KeyPair, sub: string, ik: string, head: Head, ts: number) =>
  signTagged(pk.sk, TAG2.bind, bindingBody2(sub, ik, head, ts))

export interface BindingRequest2 {
  ik: string
  ts: number
  proof: string
  cr: CreationRecord
  chain: ChainRecord[]
}

export const bindingRequest2 = (
  pk: KeyPair,
  sub: string,
  keys: Keys,
  head: Head,
  ts: number
): BindingRequest2 => ({
  ik: keys.cr.ik,
  ts,
  proof: bindingProof2(pk, sub, keys.cr.ik, head, ts),
  cr: keys.cr,
  chain: keys.chain,
})

// The head a proof was signed for: a head of the chain whose primary signed it. None when the
// request is over the bounds of a `{cr, chain}`, when a record of it doesn't attach, or after
// rival resets.
export const bindingHead2 = (sub: string, req: unknown): Head | null => {
  if (!isRecord(req)) return null
  const { ik, ts, proof, cr, chain } = req
  if (!Array.isArray(chain) || !keysFit(cr, chain)) return null
  if (!isCreation(cr) || cr.ik !== ik || !int(ts) || !isSig(proof)) return null
  if (!chain.every(r => isChainRecord(r) && r.ik === ik)) return null
  const view = readChain(cr, chain as ChainRecord[])
  if (view.frozen || !(chain as ChainRecord[]).every(r => view.verifies(r))) return null
  return (
    view.heads.find(h =>
      checked(view.primary(h), TAG2.bind, bindingBody2(sub, cr.ik, h, ts), proof as string)
    ) ?? null
  )
}

// ----- Safety number -----

// What a safety number half hashes: the identity key, and for an identity made with a
// recovery key also the digest of that key.
export const safetyKey = (ik: string, rk?: string): Uint8Array => {
  const key = keyBytes(ik)
  if (!key) throw new Error('bad identity key')
  if (rk === undefined) return key
  const r = keyBytes(rk)
  if (!r) throw new Error('bad recovery key')
  return concat(key, sha256(r))
}

const ITERATIONS = 5200
const STABLE = utf8('rchat-p2p')

export const safetyHalf = (ik: string, rk?: string) => {
  const key = safetyKey(ik, rk)
  let h = sha512(concat(new Uint8Array([0, rk === undefined ? 0 : 1]), key, STABLE))
  for (let i = 0; i < ITERATIONS; i += 1) h = sha512(concat(h, key))
  let digits = ''
  for (let c = 0; c < 6; c += 1) {
    let n = 0
    for (let j = 0; j < 5; j += 1) n = n * 256 + h[c * 5 + j]
    digits += String(n % 100000).padStart(5, '0')
  }
  return digits
}
