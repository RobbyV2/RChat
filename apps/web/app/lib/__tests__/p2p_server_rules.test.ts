import { describe, expect, test } from 'bun:test'
import { genCase } from './acl_model/gen'
import type { EvalResult } from '../p2p/acl/facts'
import { P, rkey } from '../p2p/acl/rules'
import {
  applySummary,
  diffSummary,
  emptySummary,
  toStored,
  type MemberSum,
  type Summary,
  type SumDelta,
} from '../p2p/acl/summary'
import { AclRoom, IMPL, KEEP } from '../p2p/acl_room'
import { MODEL_LIMITS, testBinds, toProd } from './p2p_acl_world'
import { buildEvent2 } from '../p2p/event_v2'
import { signRevocation2 } from '../p2p/event_v2'
import { HOLD_MS } from '../p2p/acl_room'
import { MIN, ServerWorld } from './p2p_server_world'

// The rules of P2P servers as the host's evaluator applies them to real signed events (spec
// 2.1 receipt outcomes, 1.2 honest parents, 3.5 watermarks and visibility, 4.2 storage): the
// semantics themselves are the ACL core's (p2p_acl_*); these test the wiring around it.

// Everything a recorded state holds.
const sets = (s: EvalResult) =>
  JSON.stringify([
    [...s.X].sort(),
    [...s.tail].sort(),
    [...s.void].sort(),
    [...s.eff].sort(),
    [...s.cut].map(([id, r]) => `${id}:${rkey(r)}`).sort(),
    [...s.F].sort(),
    [...s.FI].sort(),
    [...s.RF].sort(),
    [...s.PC].sort(),
  ])

describe('receipt outcomes (spec 2.1)', () => {
  test('malformed, rejected, pending, admitted, held and unknown rules', () => {
    const w = ServerWorld.create('O')
    const ch = w.channel('O')
    w.join('O', 'B')
    // Malformed: a wire that doesn't verify.
    const m = w.build('B', 'mark', {})
    expect(
      w.receive(m.id, { ...m.wire, sig: m.wire.sig.replace(/^./, x => (x === 'A' ? 'B' : 'A')) }).s
    ).toBe('M')
    // Rejected by the rules: a member kicking the owner, renaming the server.
    expect(
      w.post('B', 'kick', p => ({ to: w.who('O').a, seen: p.seen ?? {} }), { to: w.who('O').a }).out
    ).toEqual({
      s: 'R',
      why: 'auth',
    })
    expect(w.post('B', 'settings', { name: 'Mine' }).out.s).toBe('R')
    // Pending: a parent nobody holds.
    const lost = w.post('B', 'msg', { body: 'x', ch }, { ap: ['A'.repeat(43)] })
    expect(lost.out).toEqual({ s: 'P', missing: ['A'.repeat(43)] })
    // Admitted, with the record to store.
    const ok = w.post('B', 'mark', {})
    expect(ok.out.s).toBe('A')
    if (ok.out.s === 'A') expect(ok.out.rec.cls).toBe('A')
    // Dated more than 5 minutes ahead: admitted, held, not applied.
    const ahead = w.build('O', 'kick', p => ({ to: w.who('B').a, seen: p.seen ?? {} }), {
      ts: w.now + HOLD_MS + MIN,
      to: w.who('B').a,
    })
    expect(w.receive(ahead.id, ahead.wire).s).toBe('H')
    expect(w.sum.members[w.who('B').a].m).toBe('join')
    w.now += HOLD_MS + 2 * MIN
    expect(w.receive(ahead.id, ahead.wire).s).toBe('A')
    expect(w.sum.members[w.who('B').a].m).toBe('leave')
    // A child of a rejected event is rejected.
    const bad = w.build('B', 'settings', { name: 'x' })
    expect(w.receive(bad.id, bad.wire).s).toBe('R')
    const child = buildEvent2(w.who('O'), w.srv, 'mark', 'a', {}, { seq: 99, ap: [bad.id] }, w.now)
    expect(w.receive(child.id, child.wire)).toEqual({ s: 'R', why: 'parent' })
  })

  test('a server of a rules version this build does not know is stored unchecked, read-only', () => {
    const w = ServerWorld.create('O', { rules: 3, whatever: [1, 2] })
    expect(w.sum.rules).toBe(3)
    const e = buildEvent2(w.who('O'), w.srv, 'kick', 'a', { to: 7 }, { seq: 1, ap: [w.srv] }, w.now)
    expect(w.receive(e.id, e.wire)).toEqual({ s: 'U', rules: 3 })
    expect(w.sum.rules).toBe(3)
    expect(w.sum.members).toEqual({})
  })
})

describe('honest parents (spec 1.2)', () => {
  test('at most 10, newest first, with our own last ACL event in their closure', () => {
    const w = ServerWorld.create('O')
    const names = Array.from({ length: 12 }, (_, i) => `M${i}`)
    for (const n of names) w.join('O', n)
    const at = w.plan('O', 'mark').ap
    // The owner and 12 members post from one position: 13 heads.
    const own = w.ok('O', 'mark', {}, { ap: at })
    for (const n of names) w.ok(n, 'mark', {}, { ap: at })
    const p = w.plan('O', 'mark')
    expect(p.ap.length).toBe(10)
    // The owner's own mark is older than the ten newest, so it replaces the last one.
    expect(p.ap.at(-1)).toBe(own.id)
    expect(p.aprev).toBe(own.id)
    expect(w.post('O', 'mark').out.s).toBe('A')
  })

  test('never a candidate, a void or tail event, or a non-member’s, but a member’s leave', () => {
    const w = ServerWorld.create('O')
    w.join('O', 'B')
    w.join('O', 'C')
    w.join('O', 'D')
    w.join('O', 'E')
    // B forks its device: two marks with one seq at one position, nobody witnesses them.
    const at = w.plan('B', 'mark')
    const f1 = w.ok('B', 'mark', { n: 1 }, { ap: at.ap })
    const f2 = w.ok('B', 'mark', { n: 2 }, { ap: at.ap, seq: at.seq + 1, aprev: at.aprev })
    // C is kicked; its concurrent mark (from before the kick) is a non-member's.
    const before = w.plan('C', 'mark').ap
    w.ok('O', 'kick', p => ({ to: w.who('C').a, seen: p.seen ?? {} }), {
      ap: before,
      to: w.who('C').a,
    })
    const late = w.ok('C', 'mark', {}, { ap: before })
    // D leaves: its leave is cited.
    const leave = w.ok('D', 'leave', p => ({ seen: p.seen ?? {} }))
    // E's second device is revoked; what it signs past the watermark is in the tail.
    const e2 = w.device('E', 'E2')
    w.addDevice('E2')
    const pos = w.plan('E2', 'mark').ap
    const seen = w.room.maxSeq(e2.dev)
    w.ok('E', 'device_revoke', {
      ik: e2.a,
      dk: e2.dev,
      seen,
      rec: signRevocation2(e2.ik, w.srv, e2.dev, seen),
    })
    const tail = w.ok('E2', 'mark', {}, { ap: pos })
    const ap = w.plan('O', 'mark').ap
    const cov = (id: string) => w.room.aclDiff(ap, [], 1e6).includes(id)
    for (const x of [f1, f2, late, tail]) expect(cov(x.id)).toBe(false)
    expect(cov(leave.id)).toBe(true)
  })
})

describe('the remover’s watermark (spec 1.4, 3.5)', () => {
  test('kick, ban and leave cover every live device of their target, content included', () => {
    const w = ServerWorld.create('O')
    const ch = w.channel('O')
    w.join('O', 'B')
    const b2 = w.device('B', 'B2')
    w.addDevice('B2')
    w.ok('B', 'msg', { body: 'one', ch })
    w.ok('B2', 'msg', { body: 'two', ch })
    w.ok('B2', 'msg', { body: 'three', ch })
    const kick = w.ok('O', 'kick', p => ({ to: w.who('B').a, seen: p.seen ?? {} }), {
      to: w.who('B').a,
    })
    const seen = (kick.wire.c as { seen: Record<string, number> }).seen
    expect(Object.keys(seen).sort()).toEqual([w.who('B').dev, b2.dev].sort())
    expect(seen[b2.dev]).toBe(w.room.maxSeq(b2.dev))
    // Their messages stay: every one is within the watermark.
    const shown = w.room.display(w.contents.map(m => m.id))
    expect(shown.every(s => s?.hidden === null)).toBe(true)
    // A leave covers the leaver's devices.
    w.join('O', 'C')
    const c2 = w.device('C', 'C2')
    w.addDevice('C2')
    const leave = w.ok('C', 'leave', p => ({ seen: p.seen ?? {} }))
    expect(Object.keys((leave.wire.c as { seen: object }).seen).sort()).toEqual(
      [w.who('C').dev, c2.dev].sort()
    )
    // Without the watermark a kick is refused.
    w.join('O', 'D')
    w.ok('D', 'msg', { body: 'hi', ch })
    expect(w.post('O', 'kick', { to: w.who('D').a, seen: {} }).out).toEqual({
      s: 'R',
      why: 'seen',
    })
  })
})

describe('genesis and content', () => {
  test('@everyone may view and send; channel content needs its channel', () => {
    const w = ServerWorld.create('O')
    expect(w.sum.everyone & (P.ViewChannel | P.SendMessages)).toBe(P.ViewChannel | P.SendMessages)
    const ch = w.channel('O')
    w.join('O', 'B')
    expect(w.post('B', 'msg', { body: 'no channel' }).out).toEqual({ s: 'R', why: 'channel' })
    expect(w.post('B', 'msg', { body: 'ok', ch }).out.s).toBe('C')
    expect(w.post('B', 'react', { target: w.contents[0].id, key: 'x', on: true }).out).toEqual({
      s: 'R',
      why: 'channel',
    })
    // Held without its content (redacted where it came from): only from someone who can send.
    const bare = (name: string) => {
      const e = w.build(name, 'msg', { body: 'gone', ch })
      return w.receive(e.id, { ...e.wire, c: null }).s
    }
    expect(bare('B')).toBe('C')
    w.ok('O', 'role_bits', { role: 'everyone', bit: P.SendMessages, on: false })
    expect(bare('B')).toBe('R')
  })
})

describe('admission records (spec 4.2, the evaluation cache)', () => {
  const busy = () => {
    const w = ServerWorld.create('O')
    const ch = w.channel('O')
    for (const n of ['B', 'C', 'D', 'E']) w.join('O', n)
    w.ok('O', 'role_create', { pos: 5, bits: P.Kick | P.Ban })
    const role = w.acl.at(-1)!.id
    w.ok('O', 'assign', { to: w.who('B').a, role })
    w.ok('C', 'msg', { body: 'c1', ch })
    const old = w.plan('C', 'msg').ap
    w.ok('B', 'ban', p => ({ to: w.who('C').a, seen: p.seen ?? {} }), { to: w.who('C').a })
    w.ok('C', 'msg', { body: 'after the ban', ch }, { ap: old })
    const at = w.plan('D', 'mark')
    w.ok('D', 'mark', { n: 1 }, { ap: at.ap })
    w.ok('D', 'mark', { n: 2 }, { ap: at.ap, seq: at.seq + 1, aprev: at.aprev })
    w.ok('E', 'msg', { body: 'e1', ch })
    w.ok('O', 'revoke', p => ({ to: w.who('B').a, role, seen: p.seen ?? {} }), {
      to: w.who('B').a,
    })
    w.ok('E', 'msg', { body: 'e2', ch })
    return { w, ch }
  }

  test('a cold start rebuilds every admission state and the state, deciding nothing again', () => {
    const { w } = busy()
    const live = w.room
    const { r, out } = w.restore()
    expect(out).toEqual({ fresh: [], refused: [], mismatch: false, lost: [] })
    expect(r.summary()).toEqual(live.summary())
    for (const it of w.acl) {
      expect(sets(r.r.rec(it.id).local)).toBe(sets(live.r.rec(it.id).local))
      expect(r.r.rec(it.id).pool ?? []).toEqual(live.r.rec(it.id).pool ?? [])
    }
    const ids = w.contents.map(m => m.id)
    expect(r.display(ids)).toEqual(live.display(ids))
    expect(live.display(ids).filter(s => s?.hidden).length).toBeGreaterThan(0)
    // Both go on alike.
    const next = w.build('O', 'mark', {})
    const a = live.receiveAcl(next.id, next.wire, w.now)
    const b = r.receiveAcl(next.id, next.wire, w.now)
    expect(b).toEqual(a)
  })

  test('content positions keep light admission states equal to the full ones', () => {
    const { w } = busy()
    const acl = w.room.r.acl
    // Content admission kept each position's state: rendering finds it.
    const hits = acl.stats.contentHits
    for (const m of w.contents) {
      const light = acl.contentStateOf(m.ap)
      const full = acl.stateOf(m.ap)
      expect(sets(light)).toBe(sets(full))
      expect([...light.cut].sort()).toEqual([...full.cut].sort())
    }
    expect(acl.stats.contentHits - hits).toBe(w.contents.length)
  })

  test('events stored without a readable record are admitted again, to the same record', () => {
    const { w } = busy()
    const drop = new Set(w.acl.filter((_x, i) => i % 3 === 1).map(x => x.id))
    const { r, fresh } = w.restore(it => (drop.has(it.id) ? { id: it.id, w: it.w } : it))
    expect(new Set(fresh.map(f => f.id))).toEqual(drop)
    for (const f of fresh) expect(f.rec).toEqual(w.acl.find(x => x.id === f.id)!.rec!)
    expect(r.summary()).toEqual(w.room.summary())
  })

  test('records of another version or shape are admitted again; a wrong one is found and all are', () => {
    const { w } = busy()
    const live = w.room.summary()
    const all = new Set(w.acl.map(x => x.id))
    const ids = (f: { id: string }[]) => new Set(f.map(x => x.id))
    // Written by another implementation version (spec 2.4).
    const old = w.restore(it => ({ ...it, rec: { ...it.rec!, v: IMPL - 1 } }))
    expect(ids(old.fresh)).toEqual(all)
    expect(old.r.summary()).toEqual(live)
    // Malformed (an import).
    const bad = w.restore(it => ({ ...it, rec: { ...it.rec!, st: 7 } as never }))
    expect(ids(bad.fresh)).toEqual(all)
    // Well formed but wrong: the newest record's rank, or a state that lists a cut too many.
    const last = w.acl.at(-1)!.id
    const rank = w.restore(it =>
      it.id === last ? { ...it, rec: { ...it.rec!, k: [9e9, 'x'] as const } } : it
    )
    expect(rank.out.mismatch).toBe(true)
    expect(ids(rank.fresh)).toEqual(all)
    expect(rank.r.summary()).toEqual(live)
    const st = w.restore(it =>
      it.id === last
        ? { ...it, rec: { ...it.rec!, st: { ...it.rec!.st, X: [[w.acl[2].id], []] } } }
        : it
    )
    expect(st.out.mismatch).toBe(true)
    expect(st.r.summary()).toEqual(live)
  })

  test('the evaluator keeps no rejected or unknown-rules event, only bounded ids', () => {
    const w = ServerWorld.create('O')
    w.join('O', 'B')
    const was = KEEP.rejected
    KEEP.rejected = 5
    try {
      const before = w.room.r.evs.size
      for (let i = 0; i < 20; i++)
        expect(w.post('B', 'settings', { name: `x${i}` }).out.s).toBe('R')
      expect(w.room.r.evs.size).toBe(before)
      const R = [...w.room.r.status.values()].filter(v => v.s === 'R').length
      expect(R).toBe(5)
    } finally {
      KEEP.rejected = was
    }
    const u = ServerWorld.create('O', { rules: 3 })
    for (let i = 1; i <= 30; i++) {
      const e = buildEvent2(u.who('O'), u.srv, 'mark', 'a', {}, { seq: i, ap: [u.srv] }, u.now)
      expect(u.receive(e.id, e.wire).s).toBe('U')
    }
    expect(u.room.r.evs.size).toBe(0)
    expect(u.sum.count).toBe(31)
  })

  test('the page’s copy of the state follows the deltas', () => {
    const { w } = busy()
    const room = w.restore().r
    let copy = emptySummary()
    const deltas: (SumDelta | null)[] = [room.delta()]
    copy = applySummary(copy, deltas[0])
    const msg = w.build('E', 'msg', { body: 'more', ch: 'AAAAAAAAAAA' })
    room.receiveContent(msg.id, msg.wire, w.now)
    expect(room.delta()).toBeNull()
    const kick = w.build('O', 'kick', p => ({ to: w.who('E').a, seen: p.seen ?? {} }), {
      to: w.who('E').a,
    })
    room.receiveAcl(kick.id, kick.wire, w.now)
    const d = room.delta()
    expect(Object.keys(d?.put?.members ?? {})).toEqual([w.who('E').a])
    copy = applySummary(copy, d)
    expect(copy).toEqual(room.summary())
  })
})

describe('ACL backfill (spec 4.2)', () => {
  test('complete and oldest first: a joiner replaying it reaches the same state', () => {
    const w = ServerWorld.create('O')
    w.channel('O')
    for (const n of ['B', 'C', 'D']) w.join('O', n)
    w.ok('O', 'kick', p => ({ to: w.who('C').a, seen: p.seen ?? {} }), { to: w.who('C').a })
    const heads = w.sum.heads
    const all = w.room.aclDiff(heads, [], 1e6)
    expect(all).toEqual(w.acl.map(x => x.id))
    const fresh = new ServerWorld()
    fresh.srv = w.srv
    fresh.room = new (w.room.constructor as typeof import('../p2p/acl_room').AclRoom)(w.srv)
    for (const id of all) expect(fresh.receive(id, w.wires.get(id)!).s).toBe('A')
    expect(fresh.sum).toEqual(w.sum)
    // From a joiner's heads only what it lacks, still oldest first.
    const mid = w.acl[4].id
    const rest = w.room.aclDiff(heads, [mid], 1e6)
    expect(rest.every(id => !w.room.aclDiff([mid], [], 1e6).includes(id))).toBe(true)
    expect(rest).toEqual(all.filter(id => rest.includes(id)))
    expect(w.room.aclDiff(heads, [], 3)).toEqual(all.slice(0, 3))
  })
})

describe('visibility through the host (spec 3.5, 3.6)', () => {
  test('edits, reactions, pins and redactions as the core decides them', () => {
    const w = ServerWorld.create('O')
    const ch = w.channel('O')
    w.join('O', 'B')
    w.join('O', 'C')
    const m = w.ok('B', 'msg', { body: 'hi', ch })
    w.ok('B', 'edit', { target: m.id, body: 'hello', ch })
    const bad = w.ok('C', 'edit', { target: m.id, body: 'mine now', ch })
    w.ok('C', 'react', { target: m.id, key: 'x', on: true, ch })
    w.ok('C', 'react', { target: m.id, key: 'x', on: false, ch })
    w.ok('B', 'react', { target: m.id, key: 'y', on: true, ch })
    w.ok('C', 'pin', { target: m.id, on: true, ch })
    let [s] = w.room.display([m.id])
    expect(s?.edit).not.toBe(bad.id)
    expect(s?.edit).not.toBeNull()
    expect(s?.reactions.map(r => r.key)).toEqual(['y'])
    expect(s?.pin).toBeNull()
    const pin = w.ok('O', 'pin', { target: m.id, on: true, ch })
    ;[s] = w.room.display([m.id])
    expect(s?.pin).toEqual({ id: pin.id, on: true })
    w.ok('B', 'redact', { target: m.id, ch })
    ;[s] = w.room.display([m.id])
    expect(s?.hidden?.why).toBe('redacted')
  })

  test('history `joined`: what belongs to a joiner’s history', () => {
    const w = ServerWorld.create('O')
    const ch = w.channel('O')
    w.ok('O', 'settings', { name: 'S', history: 'joined' })
    const before = w.ok('O', 'msg', { body: 'before', ch })
    w.join('O', 'B')
    const after = w.ok('O', 'msg', { body: 'after', ch })
    const react = w.ok('O', 'react', { target: before.id, key: 'x', on: true, ch })
    const b = w.who('B').a
    expect(w.room.history(b, [before.id, after.id, react.id])).toEqual([false, true, false])
  })
})

describe('the page’s summary (incremental)', () => {
  // Members in key order: the kept summary moves an entry it works out again to the end.
  const norm = (x: Summary) =>
    JSON.stringify(
      toStored({ ...x, members: Object.fromEntries(Object.entries(x.members).sort()) })
    )
  test('a delta passes over the entries the kept summary shares, without comparing them value by value', () => {
    const shared = {
      toJSON() {
        throw new Error('compared value by value')
      },
    } as unknown as MemberSum
    const fresh: MemberSum = {
      m: 'join',
      rank: [1, 'r'],
      perms: 0,
      roles: [],
      devs: [],
      profile: null,
    }
    const a = { ...emptySummary(), members: { x: shared } }
    const b = { ...emptySummary(), members: { x: shared, y: fresh } }
    expect(diffSummary(a, b)).toEqual({ put: { members: { y: fresh } } })
    // and a room's deltas share what no event touched
    const w = ServerWorld.create('O', {}, MODEL_LIMITS)
    w.join('O', 'Y')
    const before = w.room.summary()
    w.ok('O', 'mark')
    expect(w.room.summary().members[w.who('Y').a]).toBe(before.members[w.who('Y').a])
  })
  test('the summary kept between events equals one worked out from scratch after every event of the model universes', () => {
    let events = 0
    for (const gen of [
      ...Array.from({ length: 300 }, (_, i) => () => genCase(i + 1).w),
      ...Array.from(
        { length: 100 },
        (_, i) => () => genCase(1_000_001 + i, { equivocation: true, maxAdv: 14 }).w
      ),
    ]) {
      const mw = gen()
      const room = new AclRoom('t', { binds: testBinds, agreed: MODEL_LIMITS })
      for (const e of mw.all) {
        if (room.r.receive(toProd(e, mw.ref)).s !== 'A') continue
        events++
        const kept = norm(room.summary())
        expect(kept).toBe(norm(room.freshSummary()))
      }
    }
    expect(events).toBeGreaterThan(10_000)
  }, 600_000)
})
