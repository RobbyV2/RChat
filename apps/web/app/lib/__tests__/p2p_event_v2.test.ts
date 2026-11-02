import { describe, expect, test } from 'bun:test'
import { AclReplica, decideContent, pastOf } from '../p2p/acl/admit'
import {
  aclEvOf,
  buildEvent2,
  contentEvOf,
  eventId,
  eventId2,
  eventIdBytes2,
  signRevocation2,
  signRotation2,
  signUpgrade,
  TAG_SIG2,
  validate2,
  type Author,
  type CoreV2,
  type WireV2,
} from '../p2p/event'
import { b64u, concat, utf8 } from '../p2p/canonical'
import { keyId, newKeyPair, sign } from '../p2p/keys'

// The v2 event format of P2P servers (ACL spec §1.2): cores, ids, signatures, schemas, and the
// way into the ACL core.

const author = (): Author => ({ ik: newKeyPair(), dk: newKeyPair() })
const O = author()
const U = author()
const owner = { ik: keyId(O.ik.pk) }
const genesisContent = { rules: 2, nonce: 'AAAA', owners: [owner], everyone_bits: 64, name: 'S' }
const g = buildEvent2(O, null, 'genesis', 'a', genesisContent, { seq: 0 }, 1)
const srv = g.id

describe('v2 events', () => {
  test('a genesis has no server and no parents; its id is the server id', () => {
    const v = validate2(g.wire, null)
    expect(v.ok && v.id).toBe(srv)
    expect(eventId2(g.wire.ev)).toBe(srv)
    expect(validate2(g.wire, srv)).toEqual({ ok: false, why: 'server' })
  })

  test('ids and signatures are tagged v2', () => {
    expect(eventId(g.wire.ev as never)).not.toBe(g.id)
  })

  test('ACL and content events round-trip; a wrong server, a changed content or core is refused', () => {
    const add = buildEvent2(
      O,
      srv,
      'add',
      'a',
      { to: keyId(U.ik.pk) },
      { seq: 1, ap: [srv], aprev: srv },
      2
    )
    expect(validate2(add.wire, srv)).toEqual({ ok: true, id: add.id, wire: add.wire })
    expect(validate2(add.wire, add.id).ok).toBe(false)
    expect(validate2({ ...add.wire, c: { to: 'someone else' } }, srv)).toEqual({
      ok: false,
      why: 'content',
    })
    expect(validate2({ ...add.wire, ev: { ...add.wire.ev, ts: 3 } }, srv)).toEqual({
      ok: false,
      why: 'signature',
    })
    const msg = buildEvent2(
      O,
      srv,
      'msg',
      'c',
      { body: 'hi' },
      { seq: 2, ap: [add.id], prev: [] },
      3
    )
    expect(validate2(msg.wire, srv).ok).toBe(true)
    // a redacted body (null) stays verifiable for content, never for ACL events
    expect(validate2({ ...msg.wire, c: null }, srv).ok).toBe(true)
    expect(validate2({ ...add.wire, c: null }, srv)).toEqual({ ok: false, why: 'content' })
  })

  test('core shape: parents per layer, at most 10 ACL parents, the genesis alone without them', () => {
    const signed = (core: Record<string, unknown>) => {
      const ev = {
        v: 2,
        t: 'mark',
        L: 'a',
        a: keyId(O.ik.pk),
        dev: keyId(O.dk.pk),
        seq: 1,
        ts: 1,
        ch: g.wire.ev.ch,
        srv,
        ap: [srv],
        ...core,
      } as CoreV2
      const sig = b64u(sign(O.dk.sk, concat(utf8(TAG_SIG2), eventIdBytes2(ev))))
      return validate2({ ev, c: genesisContent, sig }, srv)
    }
    expect(signed({}).ok).toBe(true)
    expect(signed({ ap: [] }).ok).toBe(false)
    const many = Array.from({ length: 11 }, (_, i) => b64u(new Uint8Array(32).fill(i)))
    expect(signed({ ap: many }).ok).toBe(false)
    expect(signed({ prev: [] }).ok).toBe(false)
    expect(signed({ L: 'c', aprev: srv }).ok).toBe(false)
    expect(signed({ t: 'genesis' }).ok).toBe(false)
    expect(signed({ depth: 3, auth: [] }).ok).toBe(true)
  })

  test('known ACL types are schema-checked; unknown types and unknown fields are kept and inert', () => {
    const kick = buildEvent2(O, srv, 'kick', 'a', { to: 5 }, { seq: 1, ap: [srv], aprev: srv }, 2)
    expect(validate2(kick.wire, srv)).toEqual({ ok: false, why: 'content' })
    const odd = buildEvent2(
      O,
      srv,
      'x_newer',
      'a',
      { any: [1, 'two'] },
      { seq: 1, ap: [srv], aprev: srv },
      2
    )
    expect(validate2(odd.wire, srv).ok).toBe(true)
    const extra = buildEvent2(
      O,
      srv,
      'mark',
      'a',
      { later: true },
      { seq: 1, ap: [srv], aprev: srv },
      2
    )
    expect(validate2(extra.wire, srv).ok).toBe(true)
  })

  test('into the ACL core: a genesis, an invite and a join are admitted; content is admitted at its position', () => {
    const certs = new Map([
      [keyId(O.dk.pk), keyId(O.ik.pk)],
      [keyId(U.dk.pk), keyId(U.ik.pk)],
    ])
    const bound = { binds: (e: { a: string; dev: string }) => certs.get(e.dev) === e.a }
    const r = new AclReplica(bound)
    const recv = (w: WireV2) => {
      const v = validate2(w, w.ev.t === 'genesis' ? null : srv)
      if (!v.ok) throw new Error(v.why)
      return r.receive(aclEvOf(v.id, v.wire))
    }
    expect(recv(g.wire).s).toBe('A')
    const add = buildEvent2(
      O,
      srv,
      'add',
      'a',
      { to: keyId(U.ik.pk) },
      { seq: 1, ap: [srv], aprev: srv },
      2
    )
    expect(recv(add.wire).s).toBe('A')
    const join = buildEvent2(U, srv, 'join', 'a', {}, { seq: 0, ap: [add.id] }, 3)
    expect(recv(join.wire).s).toBe('A')
    expect(r.state().facts.mem.has(keyId(U.ik.pk))).toBe(true)
    const msg = buildEvent2(
      U,
      srv,
      'msg',
      'c',
      { body: 'hello' },
      { seq: 1, ap: [join.id], prev: [] },
      4
    )
    const m = contentEvOf(msg.id, msg.wire)
    expect(decideContent(m, pastOf(r.acl.ix, m.ap), r.acl.stateOf(m.ap), bound).ok).toBe(true)
    const stranger = author()
    const x = buildEvent2(
      stranger,
      srv,
      'msg',
      'c',
      { body: 'no' },
      { seq: 1, ap: [join.id], prev: [] },
      4
    )
    const mx = contentEvOf(x.id, x.wire)
    expect(decideContent(mx, pastOf(r.acl.ix, mx.ap), r.acl.stateOf(mx.ap), bound).ok).toBe(false)
  })

  test('a proof carries two signed headers of one device, verified on the wire; the core lowers F with them', () => {
    const certs = new Map([
      [keyId(O.dk.pk), keyId(O.ik.pk)],
      [keyId(U.dk.pk), keyId(U.ik.pk)],
    ])
    const r = new AclReplica({ binds: e => certs.get(e.dev) === e.a })
    const recv = (w: WireV2) => {
      const v = validate2(w, w.ev.t === 'genesis' ? null : srv)
      if (!v.ok) return { s: 'M', why: v.why }
      return r.receive(aclEvOf(v.id, v.wire))
    }
    recv(g.wire)
    const add = buildEvent2(
      O,
      srv,
      'add',
      'a',
      { to: keyId(U.ik.pk) },
      { seq: 1, ap: [srv], aprev: srv },
      2
    )
    recv(add.wire)
    const join = buildEvent2(U, srv, 'join', 'a', {}, { seq: 0, ap: [add.id] }, 3)
    recv(join.wire)
    // U's device signs two events at one seq; the second is only ever seen inside a proof
    const m1 = buildEvent2(U, srv, 'mark', 'a', {}, { seq: 1, ap: [join.id], aprev: join.id }, 4)
    const m2 = buildEvent2(
      U,
      srv,
      'mark',
      'a',
      { other: 1 },
      { seq: 1, ap: [join.id], aprev: join.id },
      4
    )
    expect(recv(m1.wire).s).toBe('A')
    const forged = { ev: m2.wire.ev, sig: m1.wire.sig }
    const bad = buildEvent2(
      O,
      srv,
      'proof',
      'a',
      { x: m1.wire, y: forged },
      { seq: 2, ap: [m1.id], aprev: add.id },
      5
    )
    expect(validate2(bad.wire, srv)).toEqual({ ok: false, why: 'content' })
    const p = buildEvent2(
      O,
      srv,
      'proof',
      'a',
      { x: m1.wire, y: m2.wire },
      { seq: 2, ap: [m1.id], aprev: add.id },
      5
    )
    expect(recv(p.wire).s).toBe('A')
    expect(r.state().F.get(keyId(U.dk.pk))).toBe(1)
  })

  test("an upgrade carries every other genesis owner's countersignature, verified on the wire", () => {
    const B = author()
    const owners = [{ ik: keyId(O.ik.pk) }, { ik: keyId(B.ik.pk) }]
    const g2 = buildEvent2(O, null, 'genesis', 'a', { ...genesisContent, owners }, { seq: 0 }, 1)
    const s2 = g2.id
    const certs = new Map([[keyId(O.dk.pk), keyId(O.ik.pk)]])
    const r = new AclReplica({ binds: e => certs.get(e.dev) === e.a })
    r.receive(aclEvOf(g2.id, g2.wire))
    const next = { v: 2, t: 'genesis', note: 'the new server' }
    const up = (sigs: Record<string, string>) =>
      buildEvent2(O, s2, 'upgrade', 'a', { g: next, sigs }, { seq: 1, ap: [s2], aprev: s2 }, 2)
    expect(
      validate2(up({ [keyId(B.ik.pk)]: signUpgrade(B.ik, s2, { other: 1 }) }).wire, s2)
    ).toEqual({
      ok: false,
      why: 'content',
    })
    const none = up({})
    const v0 = validate2(none.wire, s2)
    expect(v0.ok && r.receive(aclEvOf(v0.id, v0.wire))).toEqual({ s: 'R', why: 'auth' })
    const good = up({ [keyId(B.ik.pk)]: signUpgrade(B.ik, s2, next) })
    const v1 = validate2(good.wire, s2)
    expect(v1.ok && r.receive(aclEvOf(v1.id, v1.wire))).toEqual({ s: 'A' })
    expect(r.state().facts.upgraded).toEqual([good.id])
  })

  test("device revocations and rotations carry the identity's signature over the record; a device key alone can't make one", () => {
    const dk2 = newKeyPair()
    const dev2 = keyId(dk2.pk)
    const thief: Author = { ik: newKeyPair(), dk: dk2 }
    const rev = (rec: string) =>
      buildEvent2(
        O,
        srv,
        'device_revoke',
        'a',
        { ik: owner.ik, dk: dev2, seen: 3, rec },
        { seq: 1, ap: [srv], aprev: srv },
        2
      )
    expect(validate2(rev(signRevocation2(O.ik, srv, dev2, 3)).wire, srv).ok).toBe(true)
    expect(validate2(rev(signRevocation2(O.ik, srv, dev2, 4)).wire, srv).ok).toBe(false)
    expect(validate2(rev(signRevocation2(thief.ik, srv, dev2, 3)).wire, srv).ok).toBe(false)
    const rot = (rsig: string, by: Author = O) =>
      buildEvent2(
        by,
        srv,
        'primary_rotate',
        'a',
        { ik: owner.ik, pcert: 'p2', keep: [], seen: {}, rsig },
        { seq: 1, ap: [srv], aprev: srv, iprev: srv },
        2
      )
    const good = signRotation2(O.ik, srv, keyId(O.dk.pk), srv, { pcert: 'p2', keep: [], seen: {} })
    expect(validate2(rot(good).wire, srv).ok).toBe(true)
    // the same record posted from another device, or signed by a device key, is refused
    expect(validate2(rot(good, { ik: O.ik, dk: dk2 }).wire, srv).ok).toBe(false)
    const byDevice = b64u(sign(O.dk.sk, new Uint8Array([1])))
    expect(validate2(rot(byDevice).wire, srv).ok).toBe(false)
  })
})
