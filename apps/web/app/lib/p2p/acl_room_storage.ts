import { decide, pastOf } from './acl/admit'
import { orphanDrops, stableDeny, underDroppable } from './acl/storage'
import type { AclContent, AclEv } from './acl/rules'
import type { ContentEv } from './acl/visibility'
import { LOCAL } from './limits'
import type { RoomCtx } from './acl_room_ctx'
import type { Cause, Drops, Plan, ProofCand, Purgeable } from './acl_room'

// What storage drops now, beyond what it dropped before: the orphan rule's ACL events (held
// descendants: the ACL events that stay and visible content), and content with its header:
// past its device's fork point (but the pair defining it), past a revocation's watermark, or
// hidden and citing a dropped event (controller ruling). `mine`: this device, whose own events
// stay (it cites them).
export function drops(cx: RoomCtx, mine?: string): Drops {
  const ix = cx.r.acl.ix
  if (ix.genesis < 0 || cx.r.unknownRules !== undefined) return { acl: [], content: [] }
  const fe = cx.r.acl.evaluation()
  const v = cx.view()
  const keep = (i: number) => ix.ev[i].dev === mine
  const under = underDroppable(fe, keep)
  const touching = new Set<ContentEv>()
  const cited = new Uint8Array(ix.n)
  for (const m of cx.contents.values()) {
    if (!m.ap.some(p => under[ix.at.get(p) ?? -1] === 1)) continue
    touching.add(m)
    if (v.visible(m)) for (const p of m.ap) cited[ix.at.get(p)!] = 1
  }
  const acl = orphanDrops(fe, i => cited[i] === 1, keep, cx.gone).filter(d => !cx.gone.has(d.id))
  for (const d of acl) cx.gone.set(d.id, d.header)
  const content: string[] = []
  const pairs = new Map<string, Set<string>>()
  for (const m of cx.contents.values()) {
    if (m.dev === mine) continue
    const cites =
      touching.has(m) && m.ap.some(p => cx.gone.has(p) || cx.r.acl.isHeader(p)) && !v.visible(m)
    if (!cites && v.dropKind(m) === null) continue
    let pair = pairs.get(m.dev)
    if (!pair) pairs.set(m.dev, (pair = v.fcPair(m.dev)))
    if (!pair.has(m.id)) content.push(m.id)
  }
  if (content.length) {
    for (const id of content) {
      cx.evict(id, false)
      cx.contents.delete(id)
      cx.bodiless.delete(id)
    }
    cx.cv = null
  }
  return { acl, content }
}

// Evidence worth a proof (spec 2.3, 4.1), for the devices with new events since the last call
// (or `devs`): the held pair with the lowest fork point against each, when a proof of it that
// `q` posts now would be admitted (it lowers F below an ACL event of the device there).
export function proofs(
  cx: RoomCtx,
  q: { a: string; dev: string },
  devs?: readonly string[]
): ProofCand[] {
  const ix = cx.r.acl.ix
  if (ix.genesis < 0 || cx.r.unknownRules !== undefined) return []
  const list = devs ?? [...cx.dirty]
  const v = cx.view()
  const out: ProofCand[] = []
  let plan: Plan | null = null
  for (const d of list) {
    const ev = d === q.dev ? null : v.evidence(d)
    if (ev) plan ??= cx.plan({ t: 'proof', L: 'a', a: q.a, dev: q.dev })
    // Without a position to post from, the rest waits for the next call.
    if (plan && !plan.ap.length) return out
    if (!devs) cx.dirty.delete(d)
    if (!ev || !plan) continue
    const e: AclEv = {
      id: '',
      t: 'proof',
      a: q.a,
      dev: q.dev,
      seq: plan.seq + 1,
      ap: plan.ap,
      ts: plan.ts,
      c: { x: ev.x, y: ev.y } as unknown as AclContent,
    }
    if (plan.aprev !== undefined) e.aprev = plan.aprev
    const r = decide(e, pastOf(ix, plan.ap), cx.r.acl.stateOf(plan.ap), cx.r.opts)
    if (r.ok) out.push({ dev: d, f: ev.f, x: ev.x.id, y: ev.y.id })
  }
  return out
}

// Spec 4.3: the causes hiding held content that still has its body (of `only`, when given),
// with S2 and S3 worked out once per state.
export function purgeable(cx: RoomCtx, only?: readonly string[]): Purgeable {
  const ix = cx.r.acl.ix
  const out: Purgeable = { live: [], causes: [], other: [] }
  if (ix.genesis < 0 || cx.r.unknownRules !== undefined) return out
  const fe = cx.r.acl.evaluation()
  const v = cx.view()
  if (cx.stabAt !== cx.evals) {
    cx.stab.clear()
    cx.stabAt = cx.evals
  }
  const live = new Set<string>()
  for (const P of new Set([...ix.remEv.keys(), ...ix.revokeEv.keys(), ...ix.byAuthor.keys()])) {
    for (const d of fe.againstMember(P)) live.add(ix.ids[d])
    const w = v.wipedBy(P)
    if (w !== null) live.add(ix.ids[w])
  }
  out.live = [...live]
  const pool = only
    ? only.flatMap(id => {
        const m = v.byIdOf(id)
        return m ? [m] : []
      })
    : v.hideable()
  const by = new Map<string, Cause>()
  const stable = (key: string, f: () => boolean) => {
    let x = cx.stab.get(key)
    if (x === undefined) cx.stab.set(key, (x = f()))
    return x
  }
  for (const m of pool) {
    if (cx.bodiless.has(m.id)) continue
    if (v.selfRedacted(m)) {
      const c = by.get('') ?? { id: '', kind: 'self' as const, stable: true, ids: [] }
      c.ids.push(m.id)
      by.set('', c)
      continue
    }
    const h = v.hidden(m)
    if (!h) continue
    let c: Cause | undefined
    if (h.why === 'removed' || h.why === 'wipe') {
      const i = ix.at.get(h.by)!
      c = by.get(h.by) ?? {
        id: h.by,
        kind: h.why === 'wipe' ? 'wipe' : 'deny',
        stable: stable(h.by, () => stableDeny(fe, i)),
        ids: [],
      }
    } else if (h.why === 'redacted') {
      const r = v.byIdOf(h.by)!
      c = by.get(h.by) ?? {
        id: h.by,
        kind: 'redact',
        stable: stable(`${h.by}|${m.a}`, () => v.stableRedaction(r, m)),
        ids: [],
      }
    }
    if (!c) {
      out.other.push(m.id)
      continue
    }
    c.ids.push(m.id)
    by.set(c.id, c)
  }
  out.causes = [...by.values()]
  return out
}

// Content held without its body (purged, or evicted for space) that shows now: its body is
// wanted from peers (spec 4.3 restore).
// An edit is wanted only while its target shows; a body evicted for space only when viewed (the
// page asks for those itself).
export function wanted(cx: RoomCtx): string[] {
  if (!cx.bodiless.size) return []
  return [...cx.bodiless].filter(id => !cx.evicted.has(id) && cx.shows(id))
}

// Whether these bodies may be taken back now (`viewed`: also evicted ones): each shows, and an
// edit only with its target.
export function restorable(cx: RoomCtx, ids: readonly string[], viewed: boolean): boolean[] {
  return ids.map(id => cx.bodiless.has(id) && (viewed || !cx.evicted.has(id)) && cx.shows(id))
}

export function shows(cx: RoomCtx, id: string) {
  const v = cx.view()
  const m = v.byIdOf(id)
  if (!m || !v.visible(m)) return false
  const t = m.t === 'edit' && typeof m.c?.target === 'string' ? v.byIdOf(m.c.target) : null
  return m.t !== 'edit' || (!!t && v.visible(t))
}

// Content storage didn't keep after all (refused after it was decided): it goes, and its
// device's highest held seq is what is held again (a removal's watermark covers no more).
export function unhold(cx: RoomCtx, ids: readonly string[]) {
  const devs = new Set<string>()
  for (const id of ids) {
    const m = cx.contents.get(id)
    if (m) devs.add(m.dev)
    cx.evict(id, false)
    cx.contents.delete(id)
    cx.bodiless.delete(id)
  }
  if (!devs.size) return
  cx.cv = null
  for (const d of devs) cx.maxContent.delete(d)
  for (const m of cx.contents.values())
    if (devs.has(m.dev)) cx.maxContent.set(m.dev, Math.max(cx.maxContent.get(m.dev) ?? -1, m.seq))
}

// Storage purged bodies (`have` false; `evicted`: for space) or got them back.
export function bodies(cx: RoomCtx, ids: readonly string[], have: boolean, evicted = false) {
  for (const id of ids) {
    if (have) {
      cx.bodiless.delete(id)
      cx.evict(id, false)
      // Its author's edits that waited with it (evicted too) are wanted with it now.
      for (const x of [...(cx.evictedEdits.get(id) ?? [])]) cx.evict(x, false)
    } else if (cx.contents.has(id)) {
      cx.bodiless.add(id)
      if (evicted) cx.evict(id, true)
    }
  }
}

export function evict(cx: RoomCtx, id: string, on: boolean) {
  const m = cx.contents.get(id)
  const t = m?.t === 'edit' && typeof m.c?.target === 'string' ? m.c.target : null
  if (on) {
    cx.evicted.add(id)
    if (t !== null) {
      let s = cx.evictedEdits.get(t)
      if (!s) cx.evictedEdits.set(t, (s = new Set()))
      s.add(id)
    }
  } else if (cx.evicted.delete(id) && t !== null) {
    const s = cx.evictedEdits.get(t)
    s?.delete(id)
    if (s && !s.size) cx.evictedEdits.delete(t)
  }
}

// Moderators' redactions `me` may acknowledge with a mark (spec 4.3 S2; controller ruling): each
// hides its target here, isn't acknowledged yet, isn't by `me` or of `me`'s message, `me` hasn't
// named it in a mark, and at least 2 members other than its two authors could acknowledge it.
export function acks(cx: RoomCtx, me: string): string[] {
  const ix = cx.r.acl.ix
  if (ix.genesis < 0 || cx.r.unknownRules !== undefined) return []
  const v = cx.view()
  const F = cx.r.state().facts
  const named = new Set<string>()
  for (const i of ix.byAuthor.get(me) ?? []) {
    const ack = ix.ev[i].c.ack
    if (Array.isArray(ack)) for (const x of ack) if (typeof x === 'string') named.add(x)
  }
  const out: string[] = []
  for (const r of cx.contents.values()) {
    if (r.t !== 'redact' || r.a === me || named.has(r.id) || typeof r.c?.target !== 'string')
      continue
    const t = v.byIdOf(r.c.target)
    if (!t || t.a === me || t.a === r.a) continue
    const h = v.hidden(t)
    if (h?.why !== 'redacted' || h.by !== r.id) continue
    // S2 needs 3 acknowledging events of 2 identities, and each names it once: 3 members besides
    // its two authors.
    let others = 0
    for (const P of F.mem) if (P !== r.a && P !== t.a) others += 1
    if (others < 3 || v.redactionWitnessed(r, t)) continue
    out.push(r.id)
    if (out.length >= LOCAL.acl.acksPerPass) break
  }
  return out
}
