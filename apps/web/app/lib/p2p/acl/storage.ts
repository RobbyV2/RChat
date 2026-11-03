import { anchorOf, Mono, type Anchor, type FastEval } from './eval'
import { gt, poster, type AclContent, type AclEv, type Rank } from './rules'

// What storage may do with admitted events, decided here so storage applies it as given: the
// orphan rule's drops and the headers they keep (spec §2.3, §4.2), and the deterministic parts of
// a cause's stability (§4.3 S2, S3).

// An ACL event the orphan rule lets storage drop; its header stays when `header`.
export interface Drop {
  id: string
  header: boolean
}

const NEVER: readonly string[] = ['genesis', 'upgrade', 'proof']

// Whether an event the orphan rule drops keeps its header. Revision 6: every one does (§2.3).
export const keepsHeader = () => true

// The orphan rule (§2.3) on everything held: an X event other than the genesis, an upgrade or a
// proof may go when nothing held is built on it. Held descendants are the ACL events that stay
// and the content that holds its position (`cited`: visible content cites the event; hidden
// content holds nothing, controller ruling). `keep`: events storage keeps whatever (this device's
// own chain, which it cites). Linear in the index: events are visited children first.
export function orphanDrops(
  fe: FastEval,
  cited: (i: number) => boolean,
  keep: (i: number) => boolean = () => false
): Drop[] {
  const ix = fe.ix
  const held = new Uint8Array(ix.n)
  for (let i = ix.n - 1; i >= 0; i--) {
    if (!fe.inS(i)) continue
    if (!droppable(fe, i, keep) || cited(i)) {
      held[i] = 1
      continue
    }
    for (const k of ix.kids[i])
      if (held[k]) {
        held[i] = 1
        break
      }
  }
  const out: Drop[] = []
  for (let i = 0; i < ix.n; i++)
    if (fe.inS(i) && !held[i]) out.push({ id: ix.ids[i], header: keepsHeader() })
  return out
}

export const droppable = (fe: FastEval, i: number, keep: (i: number) => boolean) =>
  fe.X[i] === 1 && !NEVER.includes(fe.ix.ev[i].t) && !keep(i)

// Events that are droppable or have a droppable event in their past: content citing one of them
// may be all that holds it.
export function underDroppable(fe: FastEval, keep: (i: number) => boolean): Uint8Array {
  const ix = fe.ix
  const out = new Uint8Array(ix.n)
  for (let i = 0; i < ix.n; i++) {
    if (!fe.inS(i)) continue
    if (droppable(fe, i, keep)) out[i] = 1
    else for (const p of ix.pa[i]) if (out[p]) out[i] = 1
  }
  return out
}

// A dropped event's header (§2.3): its core with what indexing and evidence read of its content
// (targets, roles, bits, codes, devices, watermarks), without bulk such as certificates and
// profiles. A header counts as every kind of evidence; it never takes effect.
export function headerContent(c: Record<string, unknown> | null): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const small = (v: unknown) =>
    typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 128)
  for (const [k, v] of Object.entries(c ?? {})) {
    if (small(v)) out[k] = v
    else if (Array.isArray(v) && v.length <= 16 && v.every(x => typeof x === 'string' && small(x)))
      out[k] = v
    else if (
      typeof v === 'object' &&
      v !== null &&
      !Array.isArray(v) &&
      Object.keys(v).length <= 16 &&
      Object.values(v).every(x => typeof x === 'number')
    )
      out[k] = v
  }
  return out
}

export const headerOf = (e: AclEv): AclEv => ({
  ...e,
  c: headerContent(e.c as Record<string, unknown>) as AclContent,
})

// S2 (§4.3): at least 3 admitted ACL events, none void by equivocation, by at least 2 identities
// other than `not`, acknowledge the cause (`acks`, tried from index `from` on).
export function witnessed(
  fe: FastEval,
  from: number,
  acks: (i: number) => boolean,
  not: readonly string[]
): boolean {
  const ix = fe.ix
  const who = new Set<string>()
  let n = 0
  for (let i = Math.max(0, from); i < ix.n; i++) {
    if (!fe.inS(i) || fe.X[i] === 1) continue
    const a = poster(ix.ev[i])
    if (not.includes(a) || not.includes(ix.ev[i].a) || !acks(i)) continue
    n += 1
    who.add(a)
    if (n >= 3 && who.size >= 2) return true
  }
  return false
}

// S3 (§4.3): no admitted deny at a stratum above `k`, concurrent with the cause (`conc`), takes
// away something in the authority the cause relied on (its anchor: an ACL deny's admission state,
// or a redaction's position).
export function uncontested(
  fe: FastEval,
  an: Anchor,
  k: Rank,
  conc: (i: number) => boolean
): boolean {
  const ix = fe.ix
  const base = new Mono(ix, an, null, null, new Set()).authorized()
  for (let i = 0; i < ix.n; i++) {
    if (!fe.inS(i) || !ix.isD[i] || !gt(ix.k(i), k) || !conc(i)) continue
    if (!base || !new Mono(ix, an, null, null, new Set([i])).authorized()) return false
  }
  return true
}

// S2 and S3 of an ACL cause d (a per-member deny, or a ban that hides everything): acknowledged
// by others than its author and target, and uncontested by a more senior concurrent deny.
export function stableDeny(fe: FastEval, d: number): boolean {
  const ix = fe.ix
  const e = ix.ev[d]
  const to = typeof e.c.to === 'string' ? e.c.to : e.a
  if (!witnessed(fe, d + 1, i => ix.has(i, d), [e.a, poster(e), to])) return false
  return uncontested(fe, anchorOf(ix, d), ix.k(d), i => i !== d && !ix.has(d, i) && !ix.has(i, d))
}
