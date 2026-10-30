import type { EventRecord, P2pDatabase } from './db'
import { memberOf, type StateMap } from './state'

// Soft-fail (note section 6): a message stays stored and synced but is never shown or notified
// when the resolved state says its sender is no longer a member (banned, kicked, left, or only
// invited again) and it isn't an ancestor of the event that changed that. So a message written
// before a ban stays, and one written after it (however it is dated) is hidden everywhere.
//
// Ancestors are found by walking back from the change event over `prev` links, deepest first,
// and the walk is kept per change event: later questions continue it instead of starting over.
// It only goes as deep as the question needs (an ancestor is always shallower), and stops at
// SOFTFAIL.walk events. Past that, or when the walk met events this device doesn't have (so the
// answer can't be known here), a message counts as an ancestor if it arrived here before the
// change did; a walk that met missing events is started over once one of them arrives.
//
// A message marked `soft` when it was stored (its sender was out, and it wasn't an ancestor of
// that) stays hidden for good, even after they come back: what they wrote while out never
// shows. Unless the removal itself is overturned (resolution rejects it, or it loses in a
// merge): then it was never in effect.

export const SOFTFAIL = {
  walk: 50_000,
  // Change events whose walks are kept.
  cached: 64,
  batch: 256,
}

interface Walk {
  // Ancestors found so far (the change event included), and what waits to be expanded, deepest
  // first.
  seen: Set<string>
  frontier: { id: string; depth: number }[]
  steps: number
  receivedAt: number
  // Ancestors not stored here.
  gaps: Set<string>
}

const insert = (list: { id: string; depth: number }[], x: { id: string; depth: number }) => {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (list[mid].depth > x.depth) lo = mid + 1
    else hi = mid
  }
  list.splice(lo, 0, x)
}

export class SoftFail {
  private walks = new Map<string, Walk>()
  // Whether a removal was overturned (rejected or lost in resolution): what it marked soft shows
  // again.
  overturned: (id: string) => boolean = () => false
  // Whether a member was seen equivocating at or before this chain number.
  flagged: (ik: string, dseq: number) => boolean = () => false

  constructor(
    private db: P2pDatabase,
    private limits = SOFTFAIL
  ) {}

  // Whether a stored non-state event is shown under `state`.
  async visible(rec: EventRecord, state: StateMap): Promise<boolean> {
    if (rec.purged) return false
    if (rec.soft && (rec.soft === true || !this.overturned(rec.soft))) return false
    if (rec.dseq !== undefined && this.flagged(rec.sender, rec.dseq)) return false
    const m = memberOf(state, rec.sender)
    if (m?.m === 'join') return true
    if (!m) return false
    return this.ancestor(m.id, rec)
  }

  // Whether `rec` is `change` or one of its ancestors.
  async ancestor(change: string, rec: Pick<EventRecord, 'id' | 'depth' | 'receivedAt'>) {
    if (rec.id === change) return true
    let w = this.walks.get(change)
    if (!w) {
      const top = await this.db.get('events', change)
      if (!top) return false
      w = {
        seen: new Set([change]),
        frontier: [],
        steps: 0,
        receivedAt: top.receivedAt,
        gaps: new Set(),
      }
      for (const p of top.wire.ev.prev) await this.push(w, p)
      this.walks.set(change, w)
      while (this.walks.size > this.limits.cached)
        this.walks.delete(this.walks.keys().next().value as string)
    }
    while (!w.seen.has(rec.id) && w.frontier.length && w.frontier[0].depth >= rec.depth) {
      if (w.steps >= this.limits.walk) return rec.receivedAt < w.receivedAt
      await this.expand(w)
    }
    if (w.seen.has(rec.id)) return true
    return w.gaps.size ? rec.receivedAt < w.receivedAt : false
  }

  private async push(w: Walk, id: string) {
    if (w.seen.has(id)) return
    w.seen.add(id)
    const r = await this.db.get('events', id)
    if (r) insert(w.frontier, { id, depth: r.depth })
    else w.gaps.add(id)
  }

  // Takes the deepest events off the frontier and adds their parents.
  private async expand(w: Walk) {
    const batch = w.frontier.splice(0, this.limits.batch)
    const tx = this.db.transaction('events')
    const parents: string[] = []
    for (const x of batch) {
      w.steps += 1
      const r = await tx.store.get(x.id)
      if (r) for (const p of r.wire.ev.prev) if (!w.seen.has(p)) parents.push(p)
    }
    const found: { id: string; depth: number }[] = []
    for (const p of new Set(parents)) {
      if (w.seen.has(p)) continue
      w.seen.add(p)
      const r = await tx.store.get(p)
      if (r) found.push({ id: p, depth: r.depth })
      else w.gaps.add(p)
    }
    await tx.done
    for (const f of found) insert(w.frontier, f)
  }

  forget() {
    this.walks.clear()
  }

  // Events stored here: walks that were missing one of them start over.
  arrived(ids: Iterable<string>) {
    for (const id of ids) for (const [k, w] of this.walks) if (w.gaps.has(id)) this.walks.delete(k)
  }
}
