import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { genCase } from './acl_model/gen'
import { orphanDrops as referenceDrops } from '../p2p/acl/equivocation'
import type { EvalResult } from '../p2p/acl/facts'
import { AclReplica } from '../p2p/acl/admit'
import { headerContent, headerOf, orphanDrops } from '../p2p/acl/storage'
import { LIM, P, rkey } from '../p2p/acl/rules'
import { AclRoom, IMPL, type AclItem } from '../p2p/acl_room'
import { signRevocation2 } from '../p2p/event'
import { SHARE, shareAdd, shareLive, shareTotal, withinShare } from '../p2p/shares'
import { prodReplica, testBinds, useModelLimits, useProductionLimits } from './p2p_acl_world'
import { headerOk } from '../p2p/event'
import { messageActs, type P2pMessage } from '../p2p/dm'
import { banRequest } from '../p2p/app'
import type { ServerView } from '../p2p/server'
import { ServerWorld, type Sent } from './p2p_server_world'

// Storage rules of P2P servers as the ACL core decides them (spec 2.3 orphan rule and headers,
// 4.1 proofs and shares, 4.2 dropped headers, 4.3 stability), on the host's evaluator with real
// signed events.

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

// What a store holds after applying drops: kept events whole, dropped ACL events as headers (their
// core with the content `acl/` keeps, and their record), dropped content not at all.
const stored = (w: ServerWorld, gone: Set<string>, contentGone: Set<string>) => {
  const acl: AclItem[] = w.acl.map(it =>
    gone.has(it.id)
      ? {
          id: it.id,
          w: { ev: it.w.ev, c: headerContent(it.w.c), sig: it.w.sig },
          rec: it.rec,
          hdr: true,
        }
      : it
  )
  return { acl, contents: w.contents.filter(m => !contentGone.has(m.id)) }
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
  beforeAll(useModelLimits)
  afterAll(useProductionLimits)

  test('the drop list storage applies equals the reference rule on equivocation-heavy universes', () => {
    let some = 0
    for (let s = 1; s <= 120; s++) {
      const pr = prodReplica(genCase(1_000_000 + s, { equivocation: true, maxAdv: 14 }).w)
      const ref = [...referenceDrops([...pr.order], pr.state(), pr)].sort()
      const fe = pr.acl.evaluation()
      const mine = orphanDrops(fe, () => false)
      expect([s, mine.map(d => d.id).sort()]).toEqual([s, ref])
      expect(mine.every(d => d.header)).toBe(true)
      if (ref.length) some += 1
    }
    expect(some).toBeGreaterThan(10)
  }, 300_000)

  test('a cold start with the dropped events restored from their headers evaluates as before, on the same universes (identity ops, rotations and joins among them)', () => {
    const kinds = new Set<string>()
    for (let s = 1; s <= 120; s++) {
      const pr = prodReplica(genCase(1_000_000 + s, { equivocation: true, maxAdv: 14 }).w)
      const gone = new Set(orphanDrops(pr.acl.evaluation(), () => false).map(d => d.id))
      if (!gone.size) continue
      const r = new AclReplica({ binds: testBinds })
      for (const id of pr.order) {
        const e = pr.ev(id)
        if (gone.has(id)) kinds.add(e.t)
        r.restore(gone.has(id) ? headerOf(e) : e, pr.rec(id))
      }
      expect([s, sets(r.state())]).toEqual([s, sets(pr.state())])
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
    expect(d.acl.every(x => x.header)).toBe(true)
    expect(d.content.sort()).toEqual(msgs.map(m => m.id).sort())
    // Nothing more the next time.
    expect(w.room.drops()).toEqual({ acl: [], content: [] })
    // Stored void events (whole): none of the relays, within §4.1's bound.
    const gone = new Set(d.acl.map(x => x.id))
    const kept = w.acl.filter(it => !gone.has(it.id) && S0.X.has(it.id))
    expect(kept.length).toBeLessThanOrEqual(LIM.poolU)
    expect(kept.length).toBe(0)
    // A cold start from what is stored: the headers are evidence, the state is the same.
    const live = w.room.r.state()
    const st = stored(w, gone, new Set(d.content))
    const r = new AclRoom(w.srv)
    const out = r.restore(st.acl, st.contents)
    expect([out.lost, out.refused, out.mismatch]).toEqual([[], [], false])
    expect(sets(r.r.state())).toBe(sets(live))
    expect(r.summary()).toEqual(w.room.summary())
    // A dropped relay fetched again (something cites it) is admitted as it was, whole.
    const back = r.receiveAcl(relays[0].id, relays[0].wire, w.now)
    expect(back.s).toBe('A')
    expect(r.r.ev(relays[0].id).c.rec).toBe(relays[0].wire.c?.rec)
    expect(sets(r.r.state())).toBe(sets(live))
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

  test('a header whose record can’t be read is lost (its content is gone), the rest restores', () => {
    const { w } = probeWorld()
    const relays = voidRelays(w, 3)
    const d = w.room.drops()
    const gone = new Set(d.acl.map(x => x.id))
    const st = stored(w, gone, new Set())
    const r = new AclRoom(w.srv)
    const out = r.restore(
      st.acl.map(it => (it.id === relays[0].id ? { ...it, rec: { ...it.rec!, v: IMPL - 1 } } : it)),
      st.contents
    )
    expect(out.lost).toEqual([relays[0].id])
    expect(out.mismatch).toBe(false)
    expect(r.r.admitted(relays[1].id)).toBe(true)
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
