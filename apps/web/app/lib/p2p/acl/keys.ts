import { isRecord } from '../../bytes'
import {
  isChainRecord,
  isCreation,
  readChain,
  recordId,
  type ChainRecord,
  type ChainView,
  type CreationRecord,
  type Head,
} from '../chain'

// The protection state (rules 3): for every identity whose creation record a set of
// admitted ACL events holds, whether the record is void or the identity frozen, the keys of its
// chain heads, the head each of its records was made under, and the records that are inert. A
// function of the set alone: the causal order, the records' signers and the chain records they
// carry.

// ----- Rules-3 content fields -----

export interface Idb3 {
  ik: string
  dcert: string
  cr?: CreationRecord
  chain?: ChainRecord[]
  by?: string
}

export interface OwnerBundle3 {
  ik: string
  dk: string
  dcert: string
  cr?: CreationRecord
  chain?: ChainRecord[]
  by?: string
}

export interface DeviceAdd3 {
  dcert: string
  by?: string
}

export interface DeviceRevoke3 {
  ik: string
  dk: string
  rec: string
  seen: number
  by?: string
}

export interface PrimaryRotate3 {
  ik: string
  pcert: string
  keep: string[]
  seen: Record<string, number>
  rsig: string
  chain?: ChainRecord[]
  by?: string
}

export interface Add3 {
  to: string
  code?: string
  head?: Head
}

export type UpgradeSig3 = string | { by: string; sig: string; chain?: ChainRecord[] }

export interface Upgrade3 {
  g: unknown
  sigs: Record<string, UpgradeSig3>
}

// ----- Input -----

// What the protection state reads of an event: its type, acting identity, signing device and
// content.
export interface KeyEv {
  id: string
  t: string
  a: string
  dev: string
  c: Record<string, unknown>
}

export interface KeysCtx {
  ev(id: string): KeyEv
  // B(e): the strict causal past
  anc(id: string): ReadonlySet<string>
  // an identity op at admission (the genesis, a device_add, a rotation, a join that introduces
  // its device)
  intro(id: string): boolean
}

// ----- Output -----

export type ProtectionState = 'none' | 'protected' | 'void' | 'frozen'

export interface IdentityKeys {
  st: Exclude<ProtectionState, 'none'>
  // void: another creation record, or a record signed by the identity key
  why?: 'cr' | 'ik'
  // the keys a record positioned on the whole set may be signed by: recovery keys, primaries
  rec: string[]
  prim: string[]
  // the identities of the creation records the set carries (one, or several when void)
  crs: string[]
  cr?: CreationRecord
  // every chain record the set carries for the identity
  chain: ChainRecord[]
  heads: Head[]
}

// A record's admitted signer and the head of its own position it was made under.
export interface RecordAt {
  by: string
  head?: Head
  // signed by the head's recovery key (else by its primary)
  rk: boolean
  // a rotation not signed by the identity key: the single chain head of its position, when it
  // is a chain record, with the devices it keeps (the sibling rule)
  head1?: { d: string; keep: string[] }
}

export interface Protection {
  ids: Map<string, IdentityKeys>
  // per record (a rotation, a device certificate, a revocation) and per `${upgrade} ${ik}`
  records: Map<string, RecordAt>
  inert: Set<string>
  // the valid rotations of protected identities
  lineage: Set<string>
  // the frozen identities, each with the carriers of its rival records
  frozen: Map<string, string[]>
  rivalCarriers: Set<string>
  inertUpgrades: Set<string>
}

export const stateOf = (p: Protection, ik: string): ProtectionState => p.ids.get(ik)?.st ?? 'none'

const RECORD_T = new Set(['primary_rotate', 'device_add', 'device_revoke', 'join'])

const str = (x: unknown): string | undefined => (typeof x === 'string' ? x : undefined)

export const introduced = (e: KeyEv): string[] => {
  if (e.t === 'genesis' || e.t === 'join' || e.t === 'device_add') return [e.dev]
  if (e.t === 'primary_rotate')
    return [e.dev, ...(Array.isArray(e.c.keep) ? (e.c.keep as string[]) : [])]
  return []
}

const bundleOf = (e: KeyEv, a: string): Record<string, unknown> | undefined => {
  if (e.t === 'join') return e.a === a && isRecord(e.c.idb) ? e.c.idb : undefined
  if (e.t !== 'genesis' || !Array.isArray(e.c.owners)) return undefined
  return e.c.owners.find((o): o is Record<string, unknown> => isRecord(o) && o.ik === a)
}

// The creation record an introduction carries for identity `a`.
export const creationOf = (e: KeyEv, a: string = e.a): CreationRecord | undefined => {
  const cr = bundleOf(e, a)?.cr
  return isCreation(cr) && cr.ik === a ? cr : undefined
}

const chainOk = (x: unknown, a: string): ChainRecord[] =>
  Array.isArray(x) ? x.filter((r): r is ChainRecord => isChainRecord(r) && r.ik === a) : []

// The chain records an event carries for identity `a`: an introduction's, or a rotation's.
export const carriedOf = (e: KeyEv, a: string = e.a): ChainRecord[] => {
  if (e.t === 'primary_rotate') return e.a === a ? chainOk(e.c.chain, a) : []
  return creationOf(e, a) ? chainOk(bundleOf(e, a)?.chain, a) : []
}

// The key a record names as its signer: an absent `by` means the identity key.
export const signerOf = (e: KeyEv): string =>
  str(e.t === 'join' ? (isRecord(e.c.idb) ? e.c.idb.by : undefined) : e.c.by) ?? e.a

const sigEntry = (u: KeyEv, a: string): { by: string; chain: ChainRecord[] } | undefined => {
  const sigs = u.c.sigs
  if (u.t !== 'upgrade' || !isRecord(sigs) || !Object.hasOwn(sigs, a)) return undefined
  const s = sigs[a]
  if (typeof s === 'string') return { by: a, chain: [] }
  if (!isRecord(s)) return undefined
  return { by: str(s.by) ?? a, chain: chainOk(s.chain, a) }
}

const ownersOf = (g: KeyEv | undefined): string[] =>
  g && Array.isArray(g.c.owners)
    ? g.c.owners.flatMap(o => (isRecord(o) && typeof o.ik === 'string' ? [o.ik] : []))
    : []

interface Carrier {
  id: string
  recs: ChainRecord[]
}

// A chain read at a position: when the records the position brings make rival resets, they are
// read on their own branch (what they carry and its ancestors), as admission checks them.
const branchOf = (
  cr: CreationRecord,
  before: ChainRecord[],
  own: ChainRecord[],
  T0: ChainView
): ChainView => {
  if (!own.length) return T0
  const all = [...before, ...own]
  const T1 = readChain(cr, all)
  if (!T1.frozen) return T1
  const keep = new Set<string>()
  for (const r of own)
    for (let d: string | undefined = recordId(r); d && T1.record(d); d = T1.record(d)?.prev)
      keep.add(d)
  return readChain(
    cr,
    all.filter(r => keep.has(recordId(r)))
  )
}

export function protection(
  ids: readonly string[],
  cx: KeysCtx,
  ghosts: readonly string[] = []
): Protection {
  const out: Protection = {
    ids: new Map(),
    records: new Map(),
    inert: new Set(),
    lineage: new Set(),
    frozen: new Map(),
    rivalCarriers: new Set(),
    inertUpgrades: new Set(),
  }
  const all = ghosts.length ? [...ids, ...ghosts] : ids
  const evs = all.map(id => cx.ev(id))
  const g = evs.find(e => e.t === 'genesis')
  if ((g?.c.rules ?? 2) !== 3) return out
  const owners = new Set(ownersOf(g))
  const crs = new Map<string, Map<string, CreationRecord>>()
  const addCr = (a: string, c: CreationRecord | undefined) => {
    if (!c) return
    if (!crs.has(a)) crs.set(a, new Map())
    crs.get(a)!.set(recordId(c), c)
  }
  if (g) for (const o of owners) addCr(o, creationOf(g, o))
  for (const e of evs) if (e.t === 'join') addCr(e.a, creationOf(e))
  if (!crs.size) return out
  const inPast = (x: string, y: string) => cx.anc(y).has(x)
  const conc = (x: string, y: string) => x !== y && !inPast(x, y) && !inPast(y, x)
  const upgrades = evs.filter(e => e.t === 'upgrade' && isRecord(e.c.sigs))
  const inert = out.inert

  for (const [a, vals] of crs) {
    const mine = evs.filter(e => e.a === a)
    const records = mine.filter(e => RECORD_T.has(e.t) && (e.t !== 'join' || cx.intro(e.id)))
    const sigRecs = upgrades.flatMap(u => {
      const s = sigEntry(u, a)
      return s ? [{ u, ...s }] : []
    })
    const carriers: Carrier[] = []
    for (const e of evs) {
      if (e.t === 'genesis' ? !owners.has(a) : e.a !== a) continue
      const recs = carriedOf(e, a)
      if (recs.length) carriers.push({ id: e.id, recs })
    }
    for (const s of sigRecs) if (s.chain.length) carriers.push({ id: s.u.id, recs: s.chain })
    const cr = [...vals.values()][0]
    const chainAll = carriers.flatMap(c => c.recs)
    const T = readChain(cr, chainAll)
    const ikRec = records.some(e => signerOf(e) === a) || sigRecs.some(s => s.by === a)
    const why = vals.size > 1 ? 'cr' : ikRec ? 'ik' : undefined
    const crIds = [...vals.keys()].sort()
    if (why) {
      for (const e of records) {
        const by = signerOf(e)
        out.records.set(e.id, { by, rk: false })
        if (by !== a) inert.add(e.id)
      }
      for (const s of sigRecs) {
        out.records.set(`${s.u.id} ${a}`, { by: s.by, rk: false })
        if (s.by !== a) {
          inert.add(s.u.id)
          out.inertUpgrades.add(s.u.id)
        }
      }
      out.ids.set(a, { st: 'void', why, rec: [a], prim: [a], crs: crIds, chain: [], heads: [] })
      continue
    }
    const isFrozen = T.frozen
    const carriersOf = new Map<string, string[]>()
    for (const c of carriers)
      for (const r of c.recs) {
        if (!T.verifies(r)) continue
        const d = recordId(r)
        if (!carriersOf.has(d)) carriersOf.set(d, [])
        carriersOf.get(d)!.push(c.id)
      }
    const knownAt = (x: string, self: boolean) =>
      carriers.filter(c => (self && c.id === x) || inPast(c.id, x)).flatMap(c => c.recs)
    const nodes = T.records()
    const changes = nodes.filter(r => r.rk !== undefined)
    const rivals: string[] = []
    if (isFrozen) {
      for (const m of changes) {
        const d = recordId(m)
        const by = T.signer(d)
        if (
          changes.some(m2 => {
            const d2 = recordId(m2)
            return d2 !== d && T.signer(d2) === by && !T.under(d, d2) && !T.under(d2, d)
          })
        )
          rivals.push(d)
      }
      const carrying = new Set<string>()
      for (const d of rivals) for (const c of carriersOf.get(d) ?? []) carrying.add(c)
      for (const c of carrying) out.rivalCarriers.add(c)
      out.frozen.set(a, [...carrying].sort())
    }
    const underRival = (d: string) => rivals.some(m => T.under(m, d))
    const deathValid = (d: string) => T.counts(d) || (isFrozen && underRival(d))
    const rkKeys = new Set<string>([
      cr.rk,
      ...nodes.map(r => T.inForce({ n: r.n, d: recordId(r) })),
    ])
    const rkCarrier = (c: string) => {
      const ce = cx.ev(c)
      return ce.t === 'primary_rotate' && rkKeys.has(signerOf(ce))
    }
    // Does a record made under `node` (signed by its recovery key, else by its primary) and
    // positioned at `pos` die in the set? `Tn` holds the node. For an upgrade (`upg`), key death
    // and epoch death read only carriers that are rotations signed by a recovery key.
    const dies = (
      node: Head,
      Tn: ChainView,
      rkSigned: boolean,
      by: string,
      pos: string,
      upg: boolean
    ) => {
      if (!Tn.counts(node.d)) return true
      const killer = (c: string) => conc(c, pos) && (!upg || rkCarrier(c))
      for (const m of nodes) {
        const d = recordId(m)
        if (!deathValid(d)) continue
        const hit = rkSigned
          ? m.rk !== undefined && T.signer(d) === by && T.under(node.d, d)
          : m.n > node.n
        if (hit && (carriersOf.get(d) ?? []).some(killer)) return true
      }
      return false
    }
    const headBy = (V: ChainView, by: string, key: boolean) =>
      V.heads.find(h => (key ? V.inForce(h) : V.primary(h)) === by)

    const inertRk = new Set<string>()
    for (const e of records) {
      const id = e.id
      const by = signerOf(e)
      const carries = e.t === 'primary_rotate' || e.t === 'join' ? carriedOf(e, a) : []
      const before = knownAt(id, false)
      const T0 = readChain(cr, before)
      const T1 = branchOf(cr, before, carries, T0)
      const fresh = carries.some(r => !T0.verifies(r))
      let node: Head | undefined
      let rk = false
      if (e.t === 'primary_rotate') {
        node = headBy(T1, by, true)
        rk = !!node
        if (!node && fresh) node = headBy(T1, by, false)
      } else if (e.t === 'device_revoke') {
        node = headBy(T0, by, true)
        rk = !!node
        if (!node) node = headBy(T0, by, false)
      } else node = headBy(T1, by, false)
      const at: RecordAt = { by, rk }
      if (node) at.head = node
      if (e.t === 'primary_rotate' && T1.heads.length === 1 && T1.heads[0].n > 0)
        at.head1 = { d: T1.heads[0].d, keep: T1.trusted(T1.heads[0]) }
      out.records.set(id, at)
      if (isFrozen && e.t === 'device_revoke') continue
      if (!node) {
        inert.add(id)
        inertRk.add(id)
        continue
      }
      if (dies(node, T, rk, by, id, true)) inertRk.add(id)
      if (dies(node, T, rk, by, id, false)) inert.add(id)
      else if (e.t === 'primary_rotate') out.lineage.add(id)
    }

    for (const s of sigRecs) {
      const u = s.u.id
      const before = knownAt(u, false)
      const T0 = readChain(cr, before)
      const T1 = branchOf(cr, before, s.chain, T0)
      let node = headBy(T1, s.by, false)
      let rk = false
      if (!node) {
        node = headBy(T1, s.by, true)
        rk = !!node
      }
      const at: RecordAt = { by: s.by, rk }
      if (node) at.head = node
      out.records.set(`${u} ${a}`, at)
      if (!node) {
        inert.add(u)
        continue
      }
      const Tn = s.chain.length ? readChain(cr, [...chainAll, ...s.chain]) : T
      if (dies(node, Tn, rk, s.by, u, true)) inert.add(u)
    }

    // An event whose device's every introduction (in its past, or itself) is inert is inert. An
    // upgrade reads its author device's introductions with the recovery-key-only deaths.
    const upgSet = new Set(sigRecs.map(s => s.u.id))
    const introsOf = new Map<string, string[]>()
    for (const e of mine)
      if (cx.intro(e.id))
        for (const dev of introduced(e)) {
          if (!introsOf.has(dev)) introsOf.set(dev, [])
          introsOf.get(dev)!.push(e.id)
        }
    for (const e of mine) {
      const id = e.id
      const isUpg = upgSet.has(id)
      const needRk = !inertRk.has(id) && (isUpg || cx.intro(id))
      if (inert.has(id) && !needRk) continue
      const intros = (introsOf.get(e.dev) ?? []).filter(x => x === id || inPast(x, id))
      if (
        needRk &&
        ((isUpg && inert.has(id)) || (intros.length > 0 && intros.every(x => inertRk.has(x))))
      )
        inertRk.add(id)
      if (inert.has(id)) continue
      if (isUpg) {
        if (inertRk.has(id)) inert.add(id)
        continue
      }
      if (intros.length && intros.every(x => inert.has(x))) inert.add(id)
    }
    for (const u of upgSet) if (inert.has(u)) out.inertUpgrades.add(u)

    if (isFrozen) {
      out.ids.set(a, {
        st: 'frozen',
        rec: [],
        prim: [],
        crs: crIds,
        cr,
        chain: chainAll,
        heads: [],
      })
      continue
    }
    out.ids.set(a, {
      st: 'protected',
      rec: [...new Set(T.heads.map(h => T.inForce(h)))].sort(),
      prim: [...new Set(T.heads.map(h => T.primary(h)))].sort(),
      crs: crIds,
      cr,
      chain: chainAll,
      heads: T.heads,
    })
  }
  return out
}

// A rotation is in keep when its posting device and every device it keeps are in the keep of its
// position's single head, and that keep names at most `devCap` devices.
export const inKeep = (e: KeyEv, at: RecordAt | undefined, devCap: number): boolean => {
  const h = at?.head1
  if (!h || e.t !== 'primary_rotate' || h.keep.length > devCap) return false
  const keep = Array.isArray(e.c.keep) ? (e.c.keep as string[]) : []
  return h.keep.includes(e.dev) && keep.every(v => h.keep.includes(v))
}

// Two concurrent rotations of one identity, in keep for one chain head: sibling carriers.
export const sameHead = (
  x: KeyEv,
  y: KeyEv,
  cx: KeysCtx,
  p: Protection,
  devCap: number
): boolean => {
  if (x.id === y.id || x.a !== y.a || x.t !== 'primary_rotate' || y.t !== 'primary_rotate')
    return false
  const hx = p.records.get(x.id)
  const hy = p.records.get(y.id)
  return (
    !!hx?.head1 &&
    !!hy?.head1 &&
    hx.head1.d === hy.head1.d &&
    !cx.anc(x.id).has(y.id) &&
    !cx.anc(y.id).has(x.id) &&
    inKeep(x, hx, devCap) &&
    inKeep(y, hy, devCap)
  )
}

// The devices an in-force rotation r drops: every device of its identity that an event of
// E introduces, that r neither keeps nor is posted by, and whose introduction is not after r. A
// rotation in keep doesn't drop what a sibling carrier in E introduces or keeps.
export function droppedBy(
  r: KeyEv,
  E: readonly string[],
  cx: KeysCtx,
  p: Protection,
  devCap: number
): string[] {
  const keep = new Set<string>(introduced(r))
  if (p.records.get(r.id)?.head1)
    for (const id of E) {
      const y = cx.ev(id)
      if (sameHead(r, y, cx, p, devCap)) for (const v of introduced(y)) keep.add(v)
    }
  const out = new Set<string>()
  for (const id of E) {
    if (id === r.id) continue
    const x = cx.ev(id)
    if (x.a !== r.a || cx.anc(id).has(r.id)) continue
    for (const v of introduced(x)) if (!keep.has(v)) out.add(v)
  }
  return [...out].sort()
}

// A void device of identity `a`: some event of the set introduces it, and every one of its
// introductions is in X.
export function voidDevice(
  X: ReadonlySet<string>,
  cx: KeysCtx,
  ids: readonly string[],
  a: string,
  dev: string
): boolean {
  const intros = ids.filter(id => {
    const e = cx.ev(id)
    return e.a === a && cx.intro(id) && introduced(e).includes(dev)
  })
  return intros.length > 0 && intros.every(id => X.has(id))
}
