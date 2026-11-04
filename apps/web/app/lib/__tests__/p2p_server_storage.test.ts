import { describe, expect, test } from 'bun:test'
import { genCase } from './acl_model/gen'
import { orphanDrops as referenceDrops } from '../p2p/acl/equivocation'
import type { EvalResult } from '../p2p/acl/facts'
import { AclReplica, totCounted } from '../p2p/acl/admit'
import { headerContent, headerOf, orphanDrops } from '../p2p/acl/storage'
import { P, rkey } from '../p2p/acl/rules'
import { AclRoom, IMPL, type AclItem } from '../p2p/acl_room'
import { signDeviceCert2 } from '../p2p/acl/binding'
import { contentEvOf, signRevocation2 } from '../p2p/event'
import { SHARE, shareAdd, shareLive, shareTotal, withinShare } from '../p2p/shares'
import { MODEL_LIMITS, prodReplica, testBinds } from './p2p_acl_world'
import { headerOk } from '../p2p/event'
import { messageActs, type P2pMessage } from '../p2p/dm'
import { banRequest } from '../p2p/app'
import type { ServerView } from '../p2p/server'
import { ServerWorld, type Sent } from './p2p_server_world'

// Storage rules of P2P servers as the ACL core decides them (spec 2.3 orphan rule and headers,
// 4.1 proofs and shares, 4.2 dropped headers, 4.3 stability), on the host's evaluator with real
// signed events.

// `gone`: dropped events, left out of the statuses (a cold store holds only their headers).
const sets = (s: EvalResult, gone: ReadonlySet<string> = new Set()) => {
  const held = (id: string) => !gone.has(id)
  return JSON.stringify([
    [...s.X].filter(held).sort(),
    [...s.tail].filter(held).sort(),
    [...s.void].filter(held).sort(),
    [...s.eff].filter(held).sort(),
    [...s.cut]
      .filter(([id]) => held(id))
      .map(([id, r]) => `${id}:${rkey(r)}`)
      .sort(),
    [...s.F].sort(),
    [...s.FI].sort(),
    [...s.RF].sort(),
    [...s.PC].filter(held).sort(),
  ])
}

// What a store holds after applying drops: kept events whole, dropped ACL events as headers (their
// core with the content `acl/` keeps, and their record) when `acl/` keeps the header, otherwise
// not at all, and dropped content not at all.
const stored = (
  w: ServerWorld,
  gone: ReadonlySet<string> | ReadonlyMap<string, boolean>,
  contentGone: Set<string>
) => {
  const hdr = (id: string) => (gone instanceof Map ? gone.get(id) : gone.has(id) || undefined)
  const acl: AclItem[] = []
  for (const it of w.acl) {
    const h = hdr(it.id)
    if (h === undefined) acl.push(it)
    else if (h)
      acl.push({
        id: it.id,
        w: { ev: it.w.ev, c: headerContent(it.w.c), sig: it.w.sig },
        rec: it.rec,
        hdr: true,
      })
  }
  return { acl, contents: w.contents.filter(m => !contentGone.has(m.id)) }
}

// The growth bound of spec 4.1 as revision 7 restates it (the model's O11-growth), over what
// storage keeps of a replica after its drop list: per non-owner identity, over its events nobody
// else acknowledged, stored whole or as headers, (a) every maximal stored one is no structural
// candidate, at most one per device chain plus one rotation; (b) every stored one lies in the
// recorded pool of a maximal one; (c) per device chain, its counted events before its fork point
// are at most totU; (d) per device chain, at most 2 kept headers at or past its fork point that
// are no identity ops, in no other chain's kept event's past and in no kept identity-op header's
// of the same chain. Returns the failures and the most headers below a kept identity op.
function growthBound(pr: AclReplica, drops: ReadonlyMap<string, boolean>) {
  const fe = pr.acl.evaluation()
  const ix = fe.ix
  const S = pr.state()
  const fails: string[] = []
  const has = (x: string, id: string) => ix.has(ix.at.get(x)!, ix.at.get(id)!)
  const order = [...pr.order]
  const hdrs = order.filter(id => drops.get(id) === true)
  const kept = order.filter(id => !drops.has(id))
  const ackd = (id: string) => order.some(f => pr.ev(f).a !== pr.ev(id).a && has(f, id))
  const structural = (id: string) => fe.candidateIn(ix.at.get(id)!, S.F, S.FI, S.RF)
  const keptOther = (id: string) =>
    [...hdrs, ...kept].some(x => pr.ev(x).dev !== pr.ev(id).dev && has(x, id))
  const keptIdSame = (id: string) =>
    hdrs.some(x => x !== id && pr.ev(x).dev === pr.ev(id).dev && pr.rec(x).depth >= 0 && has(x, id))
  const byA = new Map<string, string[]>()
  const hdrA = new Map<string, string[]>()
  for (const id of order) {
    const e = pr.ev(id)
    if (e.t === 'genesis' || S.facts.owners.has(e.a) || drops.get(id) === false || ackd(id))
      continue
    const m = drops.get(id) ? hdrA : byA
    if (!m.has(e.a)) m.set(e.a, [])
    m.get(e.a)!.push(id)
  }
  let maxBelowId = 0
  for (const a of new Set([...byA.keys(), ...hdrA.keys()])) {
    const st = byA.get(a) ?? []
    const hd = hdrA.get(a) ?? []
    const max = st.filter(x => !st.some(y => y !== x && has(y, x)))
    for (const m of max)
      if (structural(m)) fails.push(`${a}: maximal ${m} is a structural candidate`)
    const perDev = new Map<string, number>()
    for (const m of max)
      if (pr.ev(m).t !== 'primary_rotate')
        perDev.set(pr.ev(m).dev, (perDev.get(pr.ev(m).dev) ?? 0) + 1)
    for (const [v, n] of perDev) if (n > 1) fails.push(`${a}: ${n} maximal stored events on ${v}`)
    if (max.filter(m => pr.ev(m).t === 'primary_rotate').length > 1)
      fails.push(`${a}: two maximal stored rotations`)
    const stSet = new Set(st)
    const cover = new Set<string>()
    for (const m of max) for (const z of pr.rec(m).pool ?? [m]) if (stSet.has(z)) cover.add(z)
    if (cover.size < st.length) fails.push(`${a}: ${st.length - cover.size} outside the pools`)
    const pre = new Map<string, number>()
    const past = new Map<string, number>()
    const below = new Map<string, number>()
    for (const id of [...st, ...hd]) {
      const e = pr.ev(id)
      if (e.seq < (S.F.get(e.dev) ?? Infinity)) {
        if (totCounted(e.t)) pre.set(e.dev, (pre.get(e.dev) ?? 0) + 1)
      } else if (drops.get(id) && pr.rec(id).depth < 0 && !keptOther(id)) {
        const m = keptIdSame(id) ? below : past
        m.set(e.dev, (m.get(e.dev) ?? 0) + 1)
      }
    }
    for (const [v, n] of pre) if (n > pr.lim.totU) fails.push(`${a}: ${n} counted before F(${v})`)
    for (const [v, n] of past) if (n > 2) fails.push(`${a}: ${n} kept headers past F(${v})`)
    for (const n of below.values()) maxBelowId = Math.max(maxBelowId, n)
  }
  return { fails, maxBelowId, headers: hdrs.length }
}

// O's server with members Y (devices Y and Y2) and Z, and a channel.
const probeWorld = () => {
  const w = ServerWorld.create('O')
  const ch = w.channel('O')
  w.join('O', 'Y')
  w.device('Y', 'Y2')
  w.addDevice('Y2')
  w.join('O', 'Z')
  w.ok('O', 'mark')
  return { w, ch }
}

// `n` relays of Z's revocation record by Y's first device, all siblings at one position (one seq,
// one aprev): void by equivocation (spec 2.3).
const voidRelays = (w: ServerWorld, n: number) => {
  const z = w.who('Z')
  const p = w.plan('Y', 'device_revoke')
  const c = { ik: z.a, dk: z.dev, seen: 1000, rec: signRevocation2(z.ik, w.srv, z.dev, 1000) }
  const out: Sent[] = []
  for (let k = 0; k < n; k++)
    out.push(
      w.ok('Y', 'device_revoke', c, { ap: p.ap, seq: p.seq + 1, aprev: p.aprev, ts: p.ts + 1 + k })
    )
  return out
}

describe('the orphan rule in storage (spec 2.3)', () => {
  test('the drop list storage applies equals the reference rule on equivocation-heavy universes, headers included', () => {
    let some = 0
    let bare = 0
    for (let s = 1; s <= 120; s++) {
      const pr = prodReplica(genCase(1_000_000 + s, { equivocation: true, maxAdv: 14 }).w)
      const noHdr = new Set<string>()
      const ref = [...referenceDrops([...pr.order], pr.state(), pr, [], noHdr)]
        .sort()
        .map(id => `${id}:${!noHdr.has(id)}`)
      const fe = pr.acl.evaluation()
      const mine = orphanDrops(fe, () => false)
      expect([s, mine.map(d => `${d.id}:${d.header}`).sort()]).toEqual([s, ref])
      if (ref.length) some += 1
      bare += noHdr.size
    }
    expect(some).toBeGreaterThan(10)
    expect(bare).toBeGreaterThan(10)
  }, 300_000)

  test('what storage keeps after the drop list stays within the restated growth bound (O11-growth, revision 7) on the model universes', () => {
    let headers = 0
    let below = 0
    const gens = [
      ...Array.from({ length: 2000 }, (_, i) => () => genCase(i + 1).w),
      ...Array.from(
        { length: 120 },
        (_, i) => () => genCase(1_000_001 + i, { equivocation: true, maxAdv: 14 }).w
      ),
    ]
    for (const [k, gen] of gens.entries()) {
      const pr = prodReplica(gen())
      const drops = new Map(
        orphanDrops(pr.acl.evaluation(), () => false).map(d => [d.id, d.header])
      )
      const g = growthBound(pr, drops)
      expect([k, g.fails]).toEqual([k, []])
      headers += g.headers
      below = Math.max(below, g.maxBelowId)
    }
    expect(headers).toBeGreaterThan(100)
    // headers below a kept identity-op header of their chain: bounded by W3(b) on that branch
    expect(below).toBeLessThanOrEqual(MODEL_LIMITS.totU)
  }, 600_000)

  test('a cold start with the dropped events restored from their headers (outside the index) or gone evaluates as before, on the same universes (identity ops, rotations and joins among them)', () => {
    const kinds = new Set<string>()
    for (let s = 1; s <= 120; s++) {
      const pr = prodReplica(genCase(1_000_000 + s, { equivocation: true, maxAdv: 14 }).w)
      const drops = new Map(
        orphanDrops(pr.acl.evaluation(), () => false).map(d => [d.id, d.header])
      )
      if (!drops.size) continue
      const r = new AclReplica({ binds: testBinds, agreed: MODEL_LIMITS })
      for (const id of pr.order) {
        const e = pr.ev(id)
        const h = drops.get(id)
        if (h) kinds.add(e.t)
        if (h === undefined) r.restore(e, pr.rec(id))
        else if (h) r.restoreHeader(headerOf(e), pr.rec(id))
      }
      expect([s, sets(r.state())]).toEqual([s, sets(pr.state(), new Set(drops.keys()))])
    }
    expect([...kinds].some(t => ['device_add', 'join', 'primary_rotate'].includes(t))).toBe(true)
  }, 300_000)
})

describe('the reviewer’s probe: void relays cited by a removed member’s hidden content', () => {
  test('a kicked member’s second device posts content at an old position, each citing 10 void relays: all of it goes, and stored void events stay within the pool bound', () => {
    const { w, ch } = probeWorld()
    const y = w.who('Y')
    const relays = voidRelays(w, 400)
    const S0 = w.room.r.state()
    expect(relays.every(r => S0.X.has(r.id))).toBe(true)
    const old = w.plan('Y2', 'msg')
    w.ok('O', 'kick', p => ({ to: y.a, seen: p.seen ?? {} }), { to: y.a })
    // Y2's content at the old position, each citing 10 relays, written after the kick it never saw.
    const msgs: Sent[] = []
    let cprev: string | undefined
    for (let k = 0; k < 40; k++) {
      const ap = relays.slice(10 * k, 10 * k + 10).map(r => r.id)
      const s = w.ok(
        'Y2',
        'msg',
        { body: `hidden ${k}`, ch },
        { ap, seq: old.seq + 1 + k, ...(cprev ? { cprev } : {}), ts: w.now + k }
      )
      cprev = s.id
      msgs.push(s)
    }
    expect(w.room.display(msgs.map(m => m.id)).every(sh => sh?.hidden?.why === 'removed')).toBe(
      true
    )
    const d = w.room.drops()
    expect(d.acl.map(x => x.id).sort()).toEqual(relays.map(r => r.id).sort())
    // Revision 7: siblings past the fork point go without their headers, but the two that keep
    // the device's fork point where it is (one seq and one aprev for all of them).
    const hdrs = d.acl.filter(x => x.header).map(x => x.id)
    expect(hdrs).toEqual(
      relays
        .map(r => r.id)
        .sort()
        .slice(0, 2)
        .sort((a, b) => w.room.r.acl.ix.at.get(a)! - w.room.r.acl.ix.at.get(b)!)
    )
    expect(d.content.sort()).toEqual(msgs.map(m => m.id).sort())
    // Nothing more the next time.
    expect(w.room.drops()).toEqual({ acl: [], content: [] })
    // Stored void events (whole): none of the relays, within §4.1's bound; 2 headers.
    const gone = new Map(d.acl.map(x => [x.id, x.header]))
    expect(growthBound(w.room.r, gone).fails).toEqual([])
    const kept = w.acl.filter(it => !gone.has(it.id) && S0.X.has(it.id))
    expect(kept.length).toBeLessThanOrEqual(w.room.r.lim.poolU)
    expect(kept.length).toBe(0)
    // A cold start from what is stored: the headers are evidence, the state is the same.
    const live = w.room.r.state()
    const st = stored(w, gone, new Set(d.content))
    expect(st.acl.filter(it => it.hdr).length).toBe(2)
    const r = new AclRoom(w.srv)
    const out = r.restore(st.acl, st.contents)
    expect([out.lost, out.refused, out.mismatch]).toEqual([[], [], false])
    const dropped = new Set(gone.keys())
    expect(sets(r.r.state())).toBe(sets(live, dropped))
    expect(r.summary()).toEqual(w.room.summary())
    // A dropped relay fetched again (something cites it) is admitted as it was, whole: one that
    // kept its header, and one that went without it.
    for (const id of [hdrs[0], d.acl.find(x => !x.header)!.id]) {
      const x = relays.find(y => y.id === id)!
      const back = r.receiveAcl(x.id, x.wire, w.now)
      expect(back.s).toBe('A')
      expect(r.r.ev(x.id).c.rec).toBe(x.wire.c?.rec)
      dropped.delete(x.id)
      expect(sets(r.r.state())).toBe(sets(live, dropped))
    }
  }, 120_000)

  test('visible content holds what it cites; the device’s own events always stay', () => {
    const { w, ch } = probeWorld()
    const relays = voidRelays(w, 12)
    // Y is a member: content citing relays shows, so it holds them.
    const p = w.plan('Y2', 'msg')
    const m = w.ok(
      'Y2',
      'msg',
      { body: 'cites', ch },
      { ap: relays.slice(0, 3).map(r => r.id), seq: p.seq + 1 }
    )
    expect(w.room.display([m.id])[0]?.hidden).toBeNull()
    const d = w.room.drops()
    expect(d.acl.map(x => x.id).sort()).toEqual(
      relays
        .slice(3)
        .map(r => r.id)
        .sort()
    )
    expect(d.content).toEqual([])
    // The posting device's own events are never dropped by its own replica.
    const w2 = probeWorld().w
    const r2 = voidRelays(w2, 5)
    expect(w2.room.drops(w2.who('Y').dev).acl).toEqual([])
    expect(w2.room.drops().acl.length).toBe(r2.length)
  }, 60_000)
})

// Y's three concurrent device_adds over one identity position (identity siblings: void, kept as
// headers) and a mark of one of those fresh devices (void, kept as a header whose parent is a
// header), then honest activity; storage applies the drops. `note` goes in the mark (a header
// keeps no long string); `msg`, that device's message citing the mark, is only signed.
const siblingDevices = (note?: string) => {
  const w = ServerWorld.create('O')
  const ch = w.channel('O')
  w.join('O', 'Y')
  w.ok('O', 'mark')
  const y = w.who('Y')
  const built = ['Y5', 'Y6', 'Y7'].map(d => {
    const dv = w.device('Y', d)
    return w.build(d, 'device_add', p => ({
      dcert: signDeviceCert2(y.ik, w.srv, y.a, dv.dev, p.iprev),
    }))
  })
  for (const b of built) expect(w.receive(b.id, b.wire).s).toBe('A')
  const mark = w.ok('Y7', 'mark', note ? { note } : {})
  // signed, not delivered here: an import, or content another store kept
  const msg = w.build('Y7', 'msg', { body: 'from a void device', ch })
  w.ok('O', 'mark')
  const add7 = built[2]
  const d = w.room.drops()
  const gone = new Map(d.acl.map(x => [x.id, x.header]))
  expect([gone.get(add7.id), gone.get(mark.id)]).toEqual([true, true])
  return { w, ch, mark, msg, add7, gone, contentGone: new Set(d.content) }
}

describe('headers outside the index (port fix round 1)', () => {
  test('a cold replica serves ACL state to a peer whose heads or wants name an event it holds only as a header, and decides an import citing one', () => {
    const { w, mark, msg, gone, contentGone } = siblingDevices()
    const st = stored(w, gone, contentGone)
    const r = new AclRoom(w.srv)
    const out = r.restore(st.acl, st.contents)
    expect([out.lost, out.refused]).toEqual([[], []])
    expect(r.r.acl.isHeader(mark.id)).toBe(true)
    const held = r.summary().heads
    // a peer at the header: nothing it holds is sent again; wanting it gives nothing (not held)
    const toPeer = r.aclDiff(held, [mark.id], 1000)
    expect(toPeer.length).toBeGreaterThan(0)
    expect(
      toPeer.some(id =>
        w.room.r.acl.ix.has(w.room.r.acl.ix.at.get(mark.id)!, w.room.r.acl.ix.at.get(id)!)
      )
    ).toBe(false)
    expect(r.aclDiff([mark.id], held, 1000)).toEqual([])
    expect(r.aclDiff([mark.id], [], 1000)).toEqual([])
    // an imported copy of content citing the header (restore's check)
    const r2 = new AclRoom(w.srv)
    const out2 = r2.restore(st.acl, st.contents, [{ id: msg.id, w: msg.wire }])
    expect(out2.lost).toEqual([])
    expect(r2.r.acl.isHeader(mark.id)).toBe(false)
  })

  test('a header fetched again while its parent is still a header waits for that parent; both come back whole and survive the next cold start', () => {
    const { w, mark, add7, gone, contentGone } = siblingDevices()
    const st = stored(w, gone, contentGone)
    const r = new AclRoom(w.srv)
    r.restore(st.acl, st.contents)
    // as the page would: what the replica waits for comes first
    const whole = new Map<string, AclItem>()
    const deliver = (id: string): void => {
      const wire = w.wires.get(id)!
      const v = r.receiveAcl(id, wire, w.now)
      if (v.s === 'P') {
        for (const p of v.missing) deliver(p)
        deliver(id)
        return
      }
      expect(v.s).toBe('A')
      if (v.s === 'A') whole.set(id, { id, w: wire, rec: v.rec })
    }
    deliver(mark.id)
    expect([...whole.keys()].sort()).toEqual([add7.id, mark.id].sort())
    for (const id of whole.keys()) expect(r.r.acl.isHeader(id)).toBe(false)
    // the store now holds both whole; a cold start from it decides nothing again and refuses nothing
    const after = st.acl.map(it => whole.get(it.id) ?? it)
    for (const it of whole.values()) if (!after.some(x => x.id === it.id)) after.push(it)
    const r2 = new AclRoom(w.srv)
    const out = r2.restore(after, st.contents)
    expect([out.refused, out.lost, out.mismatch]).toEqual([[], [], false])
    for (const id of whole.keys()) expect(r2.r.indexed(id)).toBe(true)
  })

  test('a header indexed for content that cites it gets its whole content back when the event is fetched again', () => {
    const note = 'n'.repeat(300)
    const { w, mark, msg, gone, contentGone } = siblingDevices(note)
    const st = stored(w, gone, contentGone)
    const r = new AclRoom(w.srv)
    // storage still holds the content that cites the mark (the pair defining a fork point)
    r.restore(st.acl, [...st.contents, contentEvOf(msg.id, msg.wire)])
    expect(r.r.indexed(mark.id)).toBe(true)
    expect(r.r.ev(mark.id).c.note).toBeUndefined()
    expect(r.receiveAcl(mark.id, mark.wire, w.now).s).toBe('A')
    const ix = r.r.acl.ix
    expect([r.r.ev(mark.id).c.note, ix.ev[ix.at.get(mark.id)!].c.note]).toEqual([note, note])
  })
})

describe('stored records and headers (spec 2.4)', () => {
  test('a record naming a base that isn’t there, or a cycle of bases, is refused and admitted again: no throw, no loop', () => {
    const { w } = probeWorld()
    w.ok('Z', 'mark')
    const live = w.room.r.state()
    const ids = w.acl.map(it => it.id)
    const newest = ids[ids.length - 1]
    const missing = w.restore(it =>
      it.id === newest
        ? { ...it, rec: { ...it.rec!, st: { ...it.rec!.st, b: 'A'.repeat(43) } } }
        : it
    )
    expect(missing.fresh.map(f => f.id)).toEqual([newest])
    expect(sets(missing.r.r.state())).toBe(sets(live))
    // x is a parent of y; each record names the other as its base.
    const yi = w.acl.findIndex(it => it.w.ev.ap && it.w.ev.ap.length && it.rec?.st.b)
    const y = w.acl[yi]
    const x = y.rec!.st.b!
    const cycle = w.restore(it =>
      it.id === x
        ? { ...it, rec: { ...it.rec!, st: { ...it.rec!.st, b: y.id } } }
        : it.id === y.id
          ? { ...it, rec: { ...it.rec!, st: { ...it.rec!.st, b: x } } }
          : it
    )
    expect(cycle.fresh.map(f => f.id)).toEqual([x])
    for (const it of w.acl)
      expect(sets(cycle.r.r.rec(it.id).local)).toBe(sets(w.room.r.rec(it.id).local))
    expect(sets(cycle.r.r.state())).toBe(sets(live))
  })

  test('a header whose record can’t be read is lost (its content is gone), the rest restores; one of the previous version is read', () => {
    const { w } = probeWorld()
    voidRelays(w, 3)
    const d = w.room.drops()
    const gone = new Map(d.acl.map(x => [x.id, x.header]))
    const st = stored(w, gone, new Set())
    const [h0, h1] = st.acl.filter(it => it.hdr).map(it => it.id)
    expect(typeof h1).toBe('string')
    const r = new AclRoom(w.srv)
    const out = r.restore(
      st.acl.map(it =>
        it.id === h0
          ? { ...it, rec: { ...it.rec!, v: 1 } }
          : it.id === h1
            ? { ...it, rec: { ...it.rec!, v: IMPL - 1 } }
            : it
      ),
      st.contents
    )
    expect(out.lost).toEqual([h0])
    expect(out.mismatch).toBe(false)
    expect(r.r.admitted(h1)).toBe(true)
    expect(r.r.acl.isHeader(h1)).toBe(true)
  })
})

describe('content dropped with its header (spec 4.2)', () => {
  test('past its device’s fork point it goes, but the pair that defines the fork point', () => {
    const { w, ch } = probeWorld()
    const p = w.plan('Y2', 'msg')
    const a = w.ok('Y2', 'msg', { body: 'a', ch }, { seq: p.seq + 1 })
    const b = w.ok('Y2', 'msg', { body: 'b', ch }, { seq: p.seq + 1 })
    const c = w.ok('Y2', 'msg', { body: 'c', ch }, { seq: p.seq + 2, cprev: b.id })
    expect(w.room.display([a.id, b.id, c.id]).map(s => s?.hidden?.why)).toEqual([
      'fork',
      'fork',
      'fork',
    ])
    const d = w.room.drops()
    expect(d.acl).toEqual([])
    expect(d.content).toEqual([c.id])
    // Without c the fork point is the same: the pair stays.
    expect(w.room.display([a.id, b.id]).map(s => s?.hidden?.why)).toEqual(['fork', 'fork'])
    expect(w.room.drops()).toEqual({ acl: [], content: [] })
  })

  test('past a revocation’s watermark it goes', () => {
    const { w, ch } = probeWorld()
    const y = w.who('Y')
    const y2 = w.who('Y2')
    const old = w.plan('Y2', 'msg')
    const seen = old.seq
    w.ok('Y', 'device_revoke', {
      ik: y.a,
      dk: y2.dev,
      seen,
      rec: signRevocation2(y.ik, w.srv, y2.dev, seen),
    })
    const late = w.ok('Y2', 'msg', { body: 'late', ch }, { ap: old.ap, seq: seen + 1 })
    expect(w.room.display([late.id])[0]?.hidden?.why).toBe('revoked')
    expect(w.room.drops().content).toEqual([late.id])
  })
})

describe('proofs (spec 2.3, 4.1)', () => {
  test('content evidence that lowers a device’s fork point below an ACL event of it is offered once; posted, it lowers F', () => {
    const { w, ch } = probeWorld()
    const y2 = w.who('Y2')
    const p = w.plan('Y2', 'msg')
    const x = w.ok('Y2', 'msg', { body: 'x', ch }, { seq: p.seq + 1 })
    const y = w.ok('Y2', 'msg', { body: 'y', ch }, { seq: p.seq + 1 })
    const o = w.who('O')
    // Nothing of Y2's ACL is past the fork yet.
    expect(w.room.proofs({ a: o.a, dev: o.dev })).toEqual([])
    w.ok('Y2', 'mark', {}, { seq: p.seq + 2 })
    const [cand] = w.room.proofs({ a: o.a, dev: o.dev })
    expect(cand).toEqual({
      dev: y2.dev,
      f: p.seq + 1,
      x: [x.id, y.id].sort()[0],
      y: [x.id, y.id].sort()[1],
    })
    // Only devices with new events are looked at again, unless asked.
    expect(w.room.proofs({ a: o.a, dev: o.dev })).toEqual([])
    const side = (id: string) => ({ ev: w.wires.get(id)!.ev, sig: w.wires.get(id)!.sig })
    w.ok('O', 'proof', { x: side(cand.x), y: side(cand.y) })
    expect(w.room.r.state().F.get(y2.dev)).toBe(p.seq + 1)
    expect(w.room.proofs({ a: o.a, dev: o.dev }, [y2.dev])).toEqual([])
    // A proof is never dropped.
    expect(w.room.drops().acl).toEqual([])
  })

  test('devices with new events wait for the next call when there is no position to post from', () => {
    const { w, ch } = probeWorld()
    const p = w.plan('Y2', 'msg')
    w.ok('Y2', 'msg', { body: 'x', ch }, { seq: p.seq + 1 })
    w.ok('Y2', 'msg', { body: 'y', ch }, { seq: p.seq + 1 })
    w.ok('Y2', 'mark', {}, { seq: p.seq + 2 })
    const o = w.who('O')
    const room = w.room
    const plan = room.plan.bind(room)
    room.plan = q => ({ ...plan(q), ap: [] })
    expect(room.proofs({ a: o.a, dev: o.dev })).toEqual([])
    room.plan = plan
    expect(room.proofs({ a: o.a, dev: o.dev }).map(c => c.dev)).toEqual([w.who('Y2').dev])
  })
})

// O's server: S (Ban, Kick, Manage roles, Manage messages, above M), M (Ban, Kick, Manage
// messages), and members Y, Z, W.
const modWorld = () => {
  const w = ServerWorld.create('O')
  const ch = w.channel('O')
  for (const n of ['S', 'M', 'Y', 'Z', 'W']) w.join('O', n)
  const bits = P.Ban | P.Kick | P.ManageMessages
  const sr = w.ok('O', 'role_create', { pos: 2, bits: bits | P.ManageRoles }).id
  const mr = w.ok('O', 'role_create', { pos: 1, bits }).id
  w.ok('O', 'assign', { to: w.who('S').a, role: sr })
  w.ok('O', 'assign', { to: w.who('M').a, role: mr })
  return { w, ch, sr, mr }
}

describe('stability (spec 4.3 S1 to S3)', () => {
  test('a ban that hides everything is stable once 3 ACL events of 2 others acknowledge it, unless a more senior deny concurrent with it would take its authority', () => {
    for (const contested of [false, true]) {
      const { w, ch, sr, mr } = modWorld()
      const y = w.who('Y')
      const msg = w.ok('Y', 'msg', { body: 'before', ch })
      const base = w.plan('O', 'mark').ap
      const ban = w.ok('M', 'ban', p => ({ to: y.a, seen: p.seen ?? {}, wipe: true }), {
        to: y.a,
        ap: base,
      })
      if (contested) {
        // S takes M's role concurrently; the owner takes S's concurrently, so S's revoke is cut
        // and the ban stands, but S's revoke was a more senior deny against its authority.
        const m = w.who('M').a
        w.ok('S', 'revoke', p => ({ to: m, role: mr, seen: p.seen ?? {} }), { to: m, ap: base })
        const s = w.who('S').a
        w.ok('O', 'revoke', p => ({ to: s, role: sr, seen: p.seen ?? {} }), { to: s, ap: base })
      }
      expect(w.room.display([msg.id])[0]?.hidden).toEqual({ why: 'wipe', by: ban.id })
      const cause = () => w.room.purgeable().causes.find(c => c.id === ban.id)
      expect(cause()).toEqual({ id: ban.id, kind: 'wipe', stable: false, ids: [msg.id] })
      expect(w.room.purgeable().live).toContain(ban.id)
      w.ok('Z', 'mark')
      w.ok('Z', 'mark')
      expect(cause()?.stable).toBe(false)
      w.ok('W', 'mark')
      expect(cause()?.stable).toBe(!contested)
    }
  })

  test('a moderator’s redaction is stable once 3 ACL events of 2 others than its and the target’s authors hold it (name it); a self-redaction purges whatever came first', () => {
    const { w, ch } = modWorld()
    const z = w.ok('Z', 'msg', { body: 'z', ch })
    const r = w.ok('M', 'redact', { target: z.id, ch })
    const cause = () => w.room.purgeable().causes.find(c => c.id === r.id)
    expect(cause()).toEqual({ id: r.id, kind: 'redact', stable: false, ids: [z.id] })
    // Who may acknowledge it: not its authors.
    expect(w.room.acks(w.who('Y').a)).toEqual([r.id])
    expect([w.room.acks(w.who('M').a), w.room.acks(w.who('Z').a)]).toEqual([[], []])
    // ACL traffic at or after its position that doesn't hold it counts nothing (controller
    // ruling); neither do its authors' marks.
    for (const n of ['Y', 'W', 'Y']) w.ok(n, 'mark')
    w.ok('M', 'mark', { ack: [r.id] })
    w.ok('Z', 'mark', { ack: [r.id] })
    expect(cause()?.stable).toBe(false)
    w.ok('Y', 'mark', { ack: [r.id] })
    // Y named it: Y has nothing more to acknowledge; W still has.
    expect(w.room.acks(w.who('Y').a)).toEqual([])
    expect(w.room.acks(w.who('W').a)).toEqual([r.id])
    w.ok('W', 'mark', { ack: [r.id] })
    expect(cause()?.stable).toBe(false)
    w.ok('S', 'mark', { ack: [r.id, 'x'] })
    expect(cause()?.stable).toBe(true)
    // Acknowledged: nobody needs to post another mark.
    expect(w.room.acks(w.who('O').a)).toEqual([])
    // The author redacts it too, after the moderator did: it goes at once.
    w.ok('Z', 'redact', { target: z.id, ch })
    expect(w.room.purgeable().causes).toEqual([{ id: '', kind: 'self', stable: true, ids: [z.id] }])
    // Purged here: no cause asks for it any more, and it isn't wanted back while hidden.
    w.room.bodies([z.id], false)
    expect(w.room.purgeable().causes).toEqual([])
    expect(w.room.wanted()).toEqual([])
  })

  test('no acknowledgement is asked for when fewer than 3 members besides the two authors could give it (3 events of 2 identities, each naming it once)', () => {
    const w = ServerWorld.create('O')
    const ch = w.channel('O')
    for (const n of ['M', 'Z', 'Y', 'W']) w.join('O', n)
    const role = w.ok('O', 'role_create', { pos: 1, bits: P.ManageMessages }).id
    w.ok('O', 'assign', { to: w.who('M').a, role })
    const z = w.ok('Z', 'msg', { body: 'z', ch })
    const r = w.ok('M', 'redact', { target: z.id, ch })
    expect(w.room.display([z.id])[0]?.hidden).toEqual({ why: 'redacted', by: r.id })
    // O, Y and W are 3 others: asked. Once W leaves, S2 can't be reached: nobody asks.
    expect(w.room.acks(w.who('O').a)).toEqual([r.id])
    w.ok('W', 'leave', p => ({ seen: p.seen ?? {} }))
    expect([w.room.acks(w.who('O').a), w.room.acks(w.who('Y').a)]).toEqual([[], []])
  })
})

describe('serving (spec 3.7)', () => {
  test('content of a channel goes only to who may view it; a copy without its body to who may view every channel', () => {
    const { w, ch } = modWorld()
    const priv = 'BBBBBBBBBBB'
    w.ok('O', 'channel', { id: priv, name: 'mods', kind: 'text', pos: 1, restrict_view: true })
    const s = w.who('S').a
    const y = w.who('Y').a
    expect(w.room.viewable(y, [ch, priv, null, ''])).toEqual([true, false, false, true])
    expect(w.room.viewable(w.who('O').a, [ch, priv, null])).toEqual([true, true, true])
    // Discord order: a role overwrite allows it back.
    w.ok('O', 'chperm', {
      ch: priv,
      subj: `r:${w.room.summary().members[s].roles[0]}`,
      allow: P.ViewChannel,
      deny: 0,
    })
    expect(w.room.viewable(s, [priv, null])).toEqual([true, true])
    expect(w.room.viewable(y, [priv])).toEqual([false])
  })
})

describe('per-sender shares (spec 4.2)', () => {
  test('a sender’s share counts a rolling day of receipts, in hours', () => {
    const H = SHARE.hourMs
    let s = shareLive(undefined, 0)
    for (let i = 0; i < 3; i++) s = shareAdd(s, 5 * H + i, 100)
    s = shareAdd(s, 7 * H, 50)
    expect(shareTotal(s)).toEqual({ n: 4, b: 350 })
    expect(withinShare(s, 10, 1 / 4, 20, 10_000)).toBe(true)
    expect(withinShare(s, 10, 1 / 4, 16, 10_000)).toBe(false)
    expect(withinShare(s, 1000, 1 / 4, 1000, 4000)).toBe(false)
    // A day later the first hour is out.
    expect(shareTotal(shareLive(s, 5 * H + SHARE.hours * H))).toEqual({ n: 1, b: 50 })
    // Whatever is stored, a bad value counts nothing.
    expect(shareLive({ x: 1 }, 0)).toEqual([])
    expect(shareLive([[1, -1, 2], 'x'], 0)).toEqual([])
  })
})

describe('headers and the page (spec 2.3, 4.3)', () => {
  test('a header checks out only with its own id, its server and its device’s signature over its core', () => {
    const { w } = probeWorld()
    const [r] = voidRelays(w, 1)
    const h = { ev: r.wire.ev, c: headerContent(r.wire.c), sig: r.wire.sig }
    expect(headerOk(r.id, h, w.srv)).toBe(true)
    expect(headerOk(r.id, { ...h, ev: { ...h.ev, seq: h.ev.seq + 1 } }, w.srv)).toBe(false)
    expect(headerOk(r.id, { ...h, sig: w.wires.get(w.acl[1].id)!.sig }, w.srv)).toBe(false)
    expect(headerOk(w.acl[1].id, h, w.srv)).toBe(false)
    expect(headerOk(r.id, h, 'A'.repeat(43))).toBe(false)
  })

  test('a message without its body here offers no reply, edit, forward or copy; the ban dialog says what a plain ban hides', () => {
    const msg = {
      id: 'm',
      sender: 'me',
      body: 'hi',
      fwd: null,
      unavailable: undefined,
    } as unknown as P2pMessage
    expect(messageActs(msg, true, true)).toEqual({
      edit: true,
      reply: true,
      forward: true,
      copy: true,
    })
    expect(messageActs({ ...msg, body: '', unavailable: true }, true, true)).toEqual({
      edit: false,
      reply: false,
      forward: false,
      copy: false,
    })
    const v = { id: 'room', perms: P.Ban } as ServerView
    expect(banRequest(v, 'ik', 'Bob').body).toBe(
      "Ban Bob? Nothing they post from now on is shown, and they can't come back."
    )
    expect(banRequest(v, 'ik', 'Bob').choices).toBeUndefined()
    const mod = banRequest({ ...v, perms: P.Ban | P.ManageMessages }, 'ik', 'Bob')
    expect(mod.choices?.map(c => c.label)).toEqual([
      'Hide what they post from now on',
      'Also hide all their messages',
    ])
  })
})

describe('evicted edits (spec 4.2)', () => {
  test('a body that comes back takes along the edits that waited on it, looking only at those', () => {
    const { w, ch } = probeWorld()
    const msgs: Sent[] = []
    for (let i = 0; i < 40; i++) msgs.push(w.ok('Z', 'msg', { body: `z ${i}`, ch }))
    const t = msgs[0]
    const e = w.ok('Z', 'edit', { target: t.id, body: 'z 0 again', ch })
    const room = w.room
    room.bodies([...msgs.map(m => m.id), e.id], false, true)
    expect(room.wanted()).toEqual([])
    const contents = (room as unknown as { contents: Map<string, unknown> }).contents
    const get = contents.get.bind(contents)
    let reads = 0
    contents.get = (k: string) => {
      reads += 1
      return get(k)
    }
    room.bodies([t.id], true)
    contents.get = get
    expect(reads).toBeLessThanOrEqual(3)
    expect(room.wanted()).toEqual([e.id])
  })
})
