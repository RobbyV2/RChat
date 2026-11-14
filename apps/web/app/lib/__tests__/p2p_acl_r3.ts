import { sha256 } from '@noble/hashes/sha2.js'
import { b64u, utf8 } from '../p2p/canonical'
import {
  headOf,
  makeCreation,
  recordId,
  TAG2,
  type ChainRecord,
  type CreationRecord,
} from '../p2p/chain'
import { keyId, publicOf, signTagged, type KeyPair } from '../p2p/keys'
import {
  droppedBy,
  protection,
  voidDevice,
  type IdentityKeys,
  type KeyEv,
  type KeysCtx,
  type Protection,
} from '../p2p/acl/keys'
import { genCase } from './acl_model_r8f/gen'
import * as M from './acl_model_r8f/model'
import { protectionOracle } from './acl_model_r8f/props'
import { B3_TEMPLATES } from './acl_model_r8f/tplfuzz'
import type { World } from './acl_model_r8f/world'

// Turns the events of the r8f model (keys and devices are names, chain records name their signer)
// into the rules-3 wire fields of spec §8.1 with real keys, real creation and chain records and
// the admitted signer of every record written into `by`, and compares what `acl/keys.ts` reads
// from them with the model's `resolveProtection` and with `protectionOracle`.
//
// The fields §2.5 doesn't read (`dcert`, `rec`, `rsig`, an upgrade's `sig`) are left empty here.

const AT = 1_762_400_000_000

const keys = new Map<string, KeyPair>()
const ids = new Map<string, string>()
const names = new Map<string, string>()

export const keyOf = (name: string): KeyPair => {
  let k = keys.get(name)
  if (!k) {
    const sk = sha256(utf8(`rchat-p2p-r3-test ${name}`))
    k = { sk, pk: publicOf(sk) }
    keys.set(name, k)
  }
  return k
}

const idOf = (kind: string, name: string): string => {
  const key = `${kind} ${name}`
  let id = ids.get(key)
  if (!id) {
    id = keyId(keyOf(key).pk)
    ids.set(key, id)
    names.set(id, `${kind} ${name}`)
  }
  return id
}

// An identity's key id, a device's, and a recovery key's or primary's (by the model's name).
export const ikOf = (a: string) => idOf('ik', a)
export const dkOf = (dev: string) => idOf('dk', dev)
export const kOf = (name: string) => idOf('key', name)
const pairOf = (a: string, name: string) => keyOf(name === 'ik' ? `ik ${a}` : `key ${name}`)
// The key a model name stands for in records of identity `a` ("ik" is its identity key).
export const keyIn = (a: string, name: string) => (name === 'ik' ? ikOf(a) : kOf(name))
// The model's name of a key id, for messages.
export const nameOf = (id: string) => names.get(id) ?? id

const fake = (s: string) => b64u(sha256(utf8(`rchat-p2p-r3-test digest ${s}`)))

const creations = new Map<string, CreationRecord>()

export const creationFor = (a: string, rk: string, pk: string): CreationRecord => {
  const key = `${a}|${rk}|${pk}`
  let cr = creations.get(key)
  if (!cr) {
    cr = makeCreation(keyOf(`ik ${a}`), keyOf(`key ${rk}`), pk === 'ik' ? ikOf(a) : kOf(pk), AT)
    creations.set(key, cr)
  }
  return cr
}

const signed = new Map<string, ChainRecord>()

// One world's records: the model's digests and the real records they stand for.
export class Wire {
  // model digest -> the real record identity
  real = new Map<string, string>()
  private recs = new Map<string, ChainRecord>()
  private evs = new Map<string, KeyEv>()

  constructor(
    private ref: M.Replica,
    all: Iterable<M.Ev>
  ) {
    const found = new Map<string, { a: string; r: M.ChainRec }>()
    const note = (a: string, list: unknown) => {
      if (!Array.isArray(list)) return
      for (const r of list)
        if (r && typeof r === 'object' && !Array.isArray(r) && Number.isSafeInteger(r.n)) {
          const key = `${a}|${M.recDigest(r)}`
          if (!found.has(key)) found.set(key, { a, r })
        }
    }
    for (const e of all) {
      if (e.t === 'genesis')
        for (const o of (e.c?.owners ?? []) as string[]) {
          const c = M.creationOf(e, o)
          if (c) {
            this.creation(o, c.rk, c.pk)
            note(o, c.chain)
          }
        }
      if (e.t === 'join') {
        const c = M.creationOf(e)
        if (c) {
          this.creation(e.a, c.rk, c.pk)
          note(e.a, c.chain)
        }
      }
      if (e.t === 'primary_rotate') note(e.a, e.c?.chain)
      if (e.t === 'upgrade' && e.c?.sigs && typeof e.c.sigs === 'object')
        for (const [o, s] of Object.entries(e.c.sigs as Record<string, { chain?: unknown }>))
          if (s && typeof s === 'object') note(o, s.chain)
    }
    for (const { a, r } of [...found.values()].sort((x, y) => x.r.n - y.r.n)) this.record(a, r)
  }

  creation(a: string, rk: string, pk: string): CreationRecord {
    const cr = creationFor(a, rk, pk)
    this.real.set(M.crDigest(a, rk, pk), recordId(cr))
    return cr
  }

  // The real record of a model chain record: signed by the key the model record names, a reset
  // also by the next key. A record the model's format refuses gets a field the format doesn't
  // name.
  record(a: string, r: M.ChainRec): ChainRecord {
    const d = `${a}|${M.recDigest(r)}`
    const hit = this.recs.get(d)
    if (hit) return hit
    const prev = this.real.get(r.prev) ?? fake(r.prev)
    const key = `${d}|${prev}`
    let rec = signed.get(key)
    if (!rec) {
      const body: Record<string, unknown> = {
        v: 1,
        ik: ikOf(a),
        n: r.n,
        prev,
        pk: typeof r.pk === 'string' ? keyIn(a, r.pk) : ikOf(a),
        keep: [...new Set((r.keep ?? []).map(dkOf))].sort(),
        at: AT,
      }
      if (r.rk !== undefined) body.rk = r.rk === '' ? '' : kOf(r.rk)
      rec = {
        ...body,
        sig: signTagged(pairOf(a, typeof r.by === 'string' ? r.by : 'ik').sk, TAG2.chain, body),
      } as ChainRecord
      if (r.rk) rec.sig_next = signTagged(keyOf(`key ${r.rk}`).sk, TAG2.chain, body)
      if (!M.chainRecOk(r)) (rec as unknown as Record<string, unknown>).unread = 1
      signed.set(key, rec)
    }
    this.recs.set(d, rec)
    if (M.chainRecOk(r)) this.real.set(M.recDigest(r), headOf(rec).d)
    return rec
  }

  private chain(a: string, list: unknown): ChainRecord[] | undefined {
    if (!Array.isArray(list)) return undefined
    return list
      .filter(r => r && typeof r === 'object' && !Array.isArray(r) && Number.isSafeInteger(r.n))
      .map(r => this.record(a, r))
  }

  private bundle(e: M.Ev, a: string): Record<string, unknown> {
    const c = M.creationOf(e, a)
    const out: Record<string, unknown> = { ik: ikOf(a), dcert: '' }
    if (!c) return out
    out.cr = this.creation(a, c.rk, c.pk)
    const chain = this.chain(a, c.chain)
    if (chain?.length) out.chain = chain
    return out
  }

  private by(e: M.Ev): string | undefined {
    const name = this.ref.rec(e.id)?.by ?? (typeof e.c?.by === 'string' ? e.c.by : 'ik')
    return name === 'ik' ? undefined : kOf(name)
  }

  ev(id: string): KeyEv {
    const hit = this.evs.get(id)
    if (hit) return hit
    const e = this.ref.ev(id)
    const a = e.a
    let c: Record<string, unknown> = {}
    const by = this.by(e)
    const named = by === undefined ? {} : { by }
    switch (e.t) {
      case 'genesis':
        c = {
          rules: e.c?.rules,
          owners: ((e.c?.owners ?? []) as string[]).map(o => ({
            ...this.bundle(e, o),
            ...(o === a ? { dk: dkOf(e.dev) } : {}),
          })),
        }
        break
      case 'join':
        c = { idb: { ...this.bundle(e, a), ...named } }
        break
      case 'device_add':
        c = { dcert: '', ...named }
        break
      case 'device_revoke':
        c = { ik: ikOf(a), dk: dkOf(e.c?.dev ?? ''), rec: '', seen: e.c?.seen, ...named }
        break
      case 'primary_rotate': {
        const chain = this.chain(a, e.c?.chain)
        c = {
          ik: ikOf(a),
          pcert: typeof e.c?.pcert === 'string' ? keyIn(a, e.c.pcert) : '',
          keep: ((e.c?.keep ?? []) as string[]).map(dkOf),
          seen: Object.fromEntries(
            Object.entries((e.c?.seen ?? {}) as Record<string, number>).map(([d, s]) => [
              dkOf(d),
              s,
            ])
          ),
          rsig: '',
          ...(chain?.length ? { chain } : {}),
          ...named,
        }
        break
      }
      case 'upgrade': {
        const sigBy = this.ref.rec(id)?.sigBy
        const src = e.c?.sigs
        if (sigBy && src && typeof src === 'object' && !Array.isArray(src)) {
          const sigs: Record<string, unknown> = {}
          for (const [o, name] of Object.entries(sigBy)) {
            const s = (src as Record<string, { chain?: unknown } | string>)[o]
            const chain = typeof s === 'object' ? this.chain(o, s.chain) : undefined
            sigs[ikOf(o)] =
              name === 'ik' && !chain?.length
                ? ''
                : { by: keyIn(o, name), sig: '', ...(chain?.length ? { chain } : {}) }
          }
          c = { g: e.c?.g, sigs }
        } else c = { g: e.c?.g }
        break
      }
    }
    const out: KeyEv = { id, t: e.t, a: ikOf(a), dev: dkOf(e.dev), c }
    this.evs.set(id, out)
    return out
  }

  ctx(): KeysCtx {
    return {
      ev: id => this.ev(id),
      anc: id => this.ref.anc(id),
      intro: id => (this.ref.rec(id)?.depth ?? -1) >= 0,
    }
  }
}

export const wireOf = (ref: M.Replica, ids: readonly string[] = ref.order) =>
  new Wire(
    ref,
    ids.map(id => ref.ev(id))
  )

const RECORD_T = new Set(['primary_rotate', 'device_add', 'device_revoke', 'join'])
const sorted = (xs: Iterable<string>) => [...xs].sort()
const same = (a: Iterable<string>, b: Iterable<string>) =>
  JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))

const stOf = (m: M.Protection): IdentityKeys['st'] =>
  m.st === 'protected' ? 'protected' : m.void === 'chain' ? 'frozen' : 'void'

// The differences between the model's protection state of a set and production's.
export function modelDiff(
  ref: M.Replica,
  ids: readonly string[],
  wire: Wire = wireOf(ref, ids),
  P: Protection = protection(ids, wire.ctx())
): string[] {
  const out: string[] = []
  const R = M.resolveProtection([...ids], ref)
  const real = (d: string) => wire.real.get(d) ?? `?${d}`
  for (const [a, m] of R.BD) {
    const p = P.ids.get(ikOf(a))
    if (!p) {
      out.push(`${a}: the model has ${stOf(m)}, production nothing`)
      continue
    }
    const want = {
      st: stOf(m),
      why: m.st === 'protected' || m.void === 'chain' ? undefined : m.void,
      rec: sorted(m.rec.map(k => keyIn(a, k))),
      prim: sorted(m.prim.map(k => keyIn(a, k))),
      crs: sorted(
        (m.crs ?? []).map(v => recordId(creationFor(a, ...(v.split('|') as [string, string]))))
      ),
      heads: sorted((m.heads ?? []).map(real)),
      chain: stOf(m) === 'void' ? [] : sorted((m.chain ?? []).map(r => real(M.recDigest(r)))),
    }
    const got = {
      st: p.st,
      why: p.why,
      rec: sorted(p.rec),
      prim: sorted(p.prim),
      crs: sorted(p.crs),
      heads: sorted(p.heads.map(h => h.d)),
      chain: sorted(p.chain.map(recordId)),
    }
    if (JSON.stringify(want) !== JSON.stringify(got))
      out.push(`${a}: model ${JSON.stringify(want)}, production ${JSON.stringify(got)}`)
  }
  for (const ik of P.ids.keys())
    if (![...R.BD.keys()].some(a => ikOf(a) === ik))
      out.push(`${nameOf(ik)}: production has a state, the model none`)
  const sets: [string, Iterable<string>, Iterable<string>][] = [
    ['inert', R.inert, P.inert],
    ['lineage', R.lineage, P.lineage],
    ['frozen', [...R.frozen].map(ikOf), P.frozen.keys()],
    ['rival carriers', R.rivalCarriers, P.rivalCarriers],
    [
      'inert upgrades',
      [...R.inert].filter(id => ref.ev(id).t === 'upgrade' && ref.rec(id)?.sigBy),
      P.inertUpgrades,
    ],
  ]
  for (const [what, m, p] of sets)
    if (!same(m, p)) out.push(`${what}: model ${sorted(m).join(',')}, production ${sorted(p)}`)
  return out
}

// The same against the second reference: the state, the keys and the inert records, both ways.
export function oracleDiff(
  ref: M.Replica,
  ids: readonly string[],
  wire: Wire = wireOf(ref, ids),
  P: Protection = protection(ids, wire.ctx())
): string[] {
  const out: string[] = []
  const O = protectionOracle(ref, [...ids])
  const inert = new Set<string>()
  for (const [a, o] of O) {
    for (const x of o.inert) inert.add(x)
    const p = P.ids.get(ikOf(a))
    const st = o.st === 'protected' ? 'protected' : o.why === 'chain' ? 'frozen' : 'void'
    const want = {
      st,
      rec: sorted(o.rec.map(k => keyIn(a, k))),
      prim: sorted(o.prim.map(k => keyIn(a, k))),
      won: o.won ? recordId(creationFor(a, ...(o.won.split('|') as [string, string]))) : undefined,
      rivals: o.rivals ? sorted(o.rivals) : undefined,
    }
    const got = p && {
      st: p.st,
      rec: sorted(p.rec),
      prim: sorted(p.prim),
      won: p.st === 'protected' ? p.crs[0] : undefined,
      rivals: p.st === 'frozen' ? P.frozen.get(ikOf(a)) : undefined,
    }
    if (JSON.stringify(want) !== JSON.stringify(got))
      out.push(`${a}: oracle ${JSON.stringify(want)}, production ${JSON.stringify(got)}`)
  }
  for (const ik of P.ids.keys())
    if (![...O.keys()].some(a => ikOf(a) === ik))
      out.push(`${nameOf(ik)}: production has a state, the oracle none`)
  if (!same(inert, P.inert))
    out.push(`inert: oracle ${sorted(inert).join(',')}, production ${sorted(P.inert)}`)
  return out
}

// What evaluation reads beside the protection state, against the model's functions: the single
// head recorded for each rotation (the sibling rule), the devices each rotation outside X drops,
// and the void devices. `X` is the model's X of the set.
export function readsDiff(
  ref: M.Replica,
  ids: readonly string[],
  X: ReadonlySet<string>,
  wire: Wire = wireOf(ref, ids),
  P: Protection = protection(ids, wire.ctx())
): string[] {
  const out: string[] = []
  const cx = wire.ctx()
  const real = (d: string) => wire.real.get(d) ?? `?${d}`
  M.withLim(ref.lim, () => {
    const E = ids.filter(id => !X.has(id))
    const devs = new Map<string, string>()
    for (const id of ids) {
      const e = ref.ev(id)
      if ((ref.rec(id)?.depth ?? -1) >= 0) for (const d of M.introduces(e)) devs.set(d, e.a)
      const p = P.ids.get(ikOf(e.a))
      // O15-signer: the signer admission recorded, under a head of the record's own position
      if (p && RECORD_T.has(e.t) && (e.t !== 'join' || (ref.rec(id)?.depth ?? -1) >= 0)) {
        const at = P.records.get(id)
        const by = keyIn(e.a, ref.rec(id)?.by ?? 'ik')
        if (at?.by !== by) out.push(`signer of ${id}: model ${by}, production ${at?.by}`)
        if (p.st !== 'void' && !at?.head) out.push(`${id}: no head of its position has its signer`)
      }
      if (p && p.st !== 'void' && e.t === 'upgrade')
        for (const [o, name] of Object.entries(ref.rec(id)?.sigBy ?? {})) {
          const at = P.records.get(`${id} ${ikOf(o)}`)
          if (!P.ids.has(ikOf(o)) || P.ids.get(ikOf(o))!.st === 'void') continue
          if (at?.by !== keyIn(o, name) || !at.head)
            out.push(`signature of ${o} on ${id}: model ${name}, production ${JSON.stringify(at)}`)
        }
      if (e.t !== 'primary_rotate') continue
      if (p && p.st !== 'void') {
        const h = ref.rec(id)?.head1
        const want = h && { d: real(h.d), keep: sorted(h.keep.map(dkOf)) }
        const got = P.records.get(id)?.head1
        if (JSON.stringify(want) !== JSON.stringify(got))
          out.push(
            `head of ${id}: model ${JSON.stringify(want)}, production ${JSON.stringify(got)}`
          )
      }
      if (X.has(id)) continue
      const want = sorted(M.droppedBy(e, E, ref).map(dkOf))
      const got = droppedBy(cx.ev(id), E, cx, P, M.LIM.devCap)
      if (!same(want, got)) out.push(`${id} drops: model ${want}, production ${got}`)
    }
    const S = { X } as unknown as M.EvalResult
    for (const [dev, a] of devs)
      if (M.voidDevice(S, ref, [...ids], a, dev) !== voidDevice(X, cx, ids, ikOf(a), dkOf(dev)))
        out.push(`void device ${dev}: the model and production differ`)
  })
  return out
}

// Every comparison on a world's final set, and with `prefixes` the model comparison on every
// prefix of its arrival order (each is a causally closed set).
export function worldDiff(w: World, prefixes = false): string[] {
  const ref = w.ref
  const ids = ref.order
  if (!ids.length) return []
  const wire = wireOf(ref)
  const P = protection(ids, wire.ctx())
  const out = [
    ...modelDiff(ref, ids, wire, P),
    ...oracleDiff(ref, ids, wire, P),
    ...readsDiff(ref, ids, w.state().X, wire, P),
  ]
  if (prefixes)
    for (let k = 1; k < ids.length && !out.length; k++)
      for (const d of modelDiff(ref, ids.slice(0, k), wire)) out.push(`after ${ids[k - 1]}: ${d}`)
  return out
}

// The differences on `n` seeds of a b3 template (rules 3), each named by its seed.
export function sweep(template: string, from: number, n: number, stop = 20): string[] {
  const out: string[] = []
  for (let s = from; s < from + n && out.length < stop; s++) {
    const w = genCase(s, { template, rules: 3 }).w
    for (const d of worldDiff(w, s % 20 === 0)) out.push(`${template} seed ${s}: ${d}`)
  }
  return out
}

// `bun p2p_acl_r3.ts <template> <from> <n>` prints the differences on those seeds, for a run of
// the comparison in a process of its own (the model reads its mutant from ACL_MUT when it loads).
if (import.meta.main) {
  const [template, from, n] = process.argv.slice(2)
  const differences = sweep(template, Number(from), Number(n))
  console.log(JSON.stringify({ differences, templates: B3_TEMPLATES }))
}
