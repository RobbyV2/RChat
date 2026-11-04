import { describe, expect, test } from 'bun:test'
import { AclReplica, decideContent, pastOf } from '../p2p/acl/admit'
import {
  aclEvOf,
  buildEvent2,
  contentEvOf,
  eventId2,
  eventIdBytes2,
  signRevocation2,
  signRotation2,
  signUpgrade,
  TAG_SIG2,
  validate2,
  type CoreV2,
  type WireV2,
} from '../p2p/event_v2'
import { eventId } from '../p2p/event_v1'
import { type Author } from '../p2p/content'
import { b64u, concat, utf8 } from '../p2p/canonical'
import { keyId, newKeyPair, sign } from '../p2p/keys'
import { P } from '../p2p/acl/rules'
import { genesisBundle, genesisSrv, signDeviceCert2 } from '../p2p/acl/binding'

// The v2 event format of P2P servers (ACL spec §1.2): cores, ids, signatures, schemas, and the
// way into the ACL core.

const author = (): Author => ({ ik: newKeyPair(), dk: newKeyPair() })
// An identity bundle for a join that introduces the author's device at identity-chain position
// `iprev` of server `s`.
const idbOf = (x: Author, s = srv, iprev?: string) => ({
  ik: keyId(x.ik.pk),
  dcert: signDeviceCert2(x.ik, s, keyId(x.ik.pk), keyId(x.dk.pk), iprev),
})
const O = author()
const U = author()
const NONCE = b64u(new Uint8Array(16).fill(7))
const entry = (x: Author) => ({ ik: keyId(x.ik.pk), dk: keyId(x.dk.pk) })
// A genesis content whose owners `xs` each sign their own bundle over it.
const genesisOf = (xs: Author[], extra: Record<string, unknown> = {}) => {
  const skel = {
    rules: 2,
    nonce: NONCE,
    owners: xs.map(entry),
    everyone_bits: P.Invite | P.ViewChannel | P.SendMessages,
    name: 'S',
    ...extra,
  }
  return { ...skel, owners: xs.map(x => genesisBundle(x.ik, keyId(x.dk.pk), skel)) }
}
const genesisContent = genesisOf([O])
const owner = genesisContent.owners[0]
const g = buildEvent2(O, null, 'genesis', 'a', genesisContent, { seq: 0 }, 1)
const srv = g.id

describe('v2 events', () => {
  test('a genesis has no server and no parents; its id is the server id', () => {
    const v = validate2(g.wire, null)
    expect(v.ok && v.id).toBe(srv)
    expect(eventId2(g.wire.ev)).toBe(srv)
    expect(validate2(g.wire, srv)).toEqual({ ok: false, why: 'server' })
  })

  test('a genesis of an unknown rules version is valid on the wire; its events are not checked against rules 2', () => {
    const g3 = buildEvent2(O, null, 'genesis', 'a', { rules: 3, owners: 'new' }, { seq: 0 }, 1)
    const v = validate2(g3.wire, null)
    expect(v.ok).toBe(true)
    expect(validate2({ ...g3.wire, c: { rules: 'three' } }, null).ok).toBe(false)
    const k = buildEvent2(O, g3.id, 'kick', 'a', { to: 5 }, { seq: 1, ap: [g3.id] }, 2)
    expect(validate2(k.wire, g3.id, 3).ok).toBe(true)
    expect(validate2(k.wire, g3.id)).toEqual({ ok: false, why: 'content' })
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
    const r = new AclReplica()
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
    const chan = buildEvent2(
      O,
      srv,
      'channel',
      'a',
      { id: 'c0', name: 'general' },
      { seq: 2, ap: [add.id], aprev: add.id },
      2
    )
    expect(recv(chan.wire).s).toBe('A')
    const join = buildEvent2(U, srv, 'join', 'a', { idb: idbOf(U) }, { seq: 0, ap: [chan.id] }, 3)
    expect(recv(join.wire).s).toBe('A')
    expect(r.state().facts.mem.has(keyId(U.ik.pk))).toBe(true)
    const msg = buildEvent2(
      U,
      srv,
      'msg',
      'c',
      { body: 'hello', ch: 'c0' },
      { seq: 1, ap: [join.id], prev: [] },
      4
    )
    const m = contentEvOf(msg.id, msg.wire)
    expect(decideContent(m, pastOf(r.acl.ix, m.ap), r.acl.stateOf(m.ap)).ok).toBe(true)
    const stranger = author()
    const x = buildEvent2(
      stranger,
      srv,
      'msg',
      'c',
      { body: 'no', ch: 'c0' },
      { seq: 1, ap: [join.id], prev: [] },
      4
    )
    const mx = contentEvOf(x.id, x.wire)
    expect(decideContent(mx, pastOf(r.acl.ix, mx.ap), r.acl.stateOf(mx.ap)).ok).toBe(false)
  })

  test("relayed device revocations (§1.4, §1.6): any member may carry an identity's signed record; the core reads it as that identity's; rotations are never relayed", () => {
    const R = author()
    const R_ = keyId(R.ik.pk)
    const O_ = keyId(O.ik.pk)
    const dk2 = keyId(newKeyPair().pk)
    const chain = { seq: 1, ap: [srv], aprev: srv }
    const rev = (rec: string) =>
      buildEvent2(R, srv, 'device_revoke', 'a', { ik: O_, dk: dk2, seen: 3, rec }, chain, 2)
    const ok = validate2(rev(signRevocation2(O.ik, srv, dk2, 3)).wire, srv)
    expect(ok.ok).toBe(true)
    const e = ok.ok ? aclEvOf(ok.id, ok.wire) : null
    expect([e?.a, e?.relay, e?.dev]).toEqual([O_, R_, keyId(R.dk.pk)])
    // the relayer can't sign the record itself
    expect(validate2(rev(signRevocation2(R.ik, srv, dk2, 3)).wire, srv).ok).toBe(false)
    // a rotation is posted by the identity's own device: its record can't be carried by another
    // member, signed for the posting device or for none
    const rc = { pcert: 'p2', keep: [], seen: {} }
    const rot = (by: Author, rsig: string) =>
      buildEvent2(
        by,
        srv,
        'primary_rotate',
        'a',
        { ik: O_, ...rc, rsig },
        { ...chain, iprev: srv },
        2
      )
    const forOwn = signRotation2(O.ik, srv, keyId(O.dk.pk), srv, rc)
    expect(validate2(rot(O, forOwn).wire, srv).ok).toBe(true)
    expect(validate2(rot(R, forOwn).wire, srv).ok).toBe(false)
    expect(validate2(rot(R, signRotation2(O.ik, srv, keyId(R.dk.pk), srv, rc)).wire, srv).ok).toBe(
      false
    )
    expect(validate2(rot(R, signRotation2(O.ik, srv, '', srv, rc)).wire, srv).ok).toBe(false)
  })

  test("A1: an introduction's certificate is signed by the identity's primary over the server, the device and the identity-chain position; a forged or mismatched one is refused", () => {
    const r = new AclReplica()
    const recv = (w: WireV2) => {
      const v = validate2(w, w.ev.t === 'genesis' ? null : srv)
      if (!v.ok) return { s: 'M', why: v.why }
      return r.receive(aclEvOf(v.id, v.wire))
    }
    const thief = author()
    const O_ = keyId(O.ik.pk)
    const U_ = keyId(U.ik.pk)
    // genesis: the author's owner bundle certifies the posting device
    const genBy = (x: Author, c: Record<string, unknown>) => {
      const e = buildEvent2(x, null, 'genesis', 'a', c, { seq: 0 }, 1)
      const v = validate2(e.wire, null)
      return v.ok ? new AclReplica().receive(aclEvOf(v.id, v.wire)) : { s: 'M', why: v.why }
    }
    const gen = (c: Record<string, unknown>) => genBy(O, c)
    const genesisRefused = { s: 'R' as const, why: 'genesis' }
    const other = b64u(new Uint8Array(16).fill(8))
    const O1 = genesisContent
    expect(gen({ ...O1, owners: [{ ik: O_ }] })).toEqual(genesisRefused)
    expect(gen(genesisOf([{ ik: O.ik, dk: thief.dk }]))).toEqual(genesisRefused)
    expect(gen({ ...O1, owners: genesisOf([O], { nonce: other }).owners })).toEqual(genesisRefused)
    const thiefCert = signDeviceCert2(thief.ik, genesisSrv(O1), O_, owner.dk)
    expect(gen({ ...O1, owners: [{ ...owner, dcert: thiefCert }] })).toEqual(genesisRefused)
    // co-owners: each one's own bundle for this genesis, verified to its identity
    const C = author()
    const OC = genesisOf([O, C])
    const [ob, cb] = OC.owners
    const withC = (c: Record<string, unknown>) => gen({ ...OC, owners: [ob, c] })
    expect(withC(entry(C))).toEqual(genesisRefused)
    expect(withC({ ...cb, dcert: genesisBundle(O.ik, cb.dk, OC).dcert })).toEqual(genesisRefused)
    expect(withC({ ...cb, dcert: signDeviceCert2(O.ik, genesisSrv(OC), cb.ik, cb.dk) })).toEqual(
      genesisRefused
    )
    expect(withC(genesisOf([O, C], { nonce: other }).owners[1])).toEqual(genesisRefused)
    expect(gen(OC)).toEqual({ s: 'A' })
    // a bundle binds the one genesis it was made for: another server's nonce and owner bundles
    // copied into a new genesis, or any other field changed, are refused (re-review probe)
    const M = author()
    const skelM = { ...OC, owners: [entry(M), entry(C), entry(O)] }
    const copycat = { ...skelM, owners: [genesisBundle(M.ik, keyId(M.dk.pk), skelM), cb, ob] }
    expect(genBy(M, copycat)).toEqual(genesisRefused)
    expect(genBy(M, { ...copycat, owners: [copycat.owners[0], cb] })).toEqual(genesisRefused)
    for (const f of [
      { name: 'T' },
      { everyone_bits: P.ViewChannel },
      { from: { srv } },
      { nonce: other },
      { x_newer: 1 },
    ])
      expect(gen({ ...OC, ...f })).toEqual(genesisRefused)
    expect(withC({ ...cb, dk: keyId(thief.dk.pk) })).toEqual(genesisRefused)
    expect(gen({ ...OC, owners: [cb, ob] })).toEqual(genesisRefused)
    // the nonce is 16 bytes
    for (const nonce of ['AAAA', b64u(new Uint8Array(32))])
      expect(gen(genesisOf([O], { nonce }))).toEqual({ s: 'M', why: 'content' })
    expect(gen(genesisOf([O], { nonce: other })).s).toBe('A')
    expect(recv(g.wire).s).toBe('A')
    const add = buildEvent2(O, srv, 'add', 'a', { to: U_ }, { seq: 1, ap: [srv], aprev: srv }, 2)
    expect(recv(add.wire).s).toBe('A')
    // join: the bundle certifies the joining device at the identity's first position
    const join = (c: Record<string, unknown>) =>
      buildEvent2(U, srv, 'join', 'a', c, { seq: 0, ap: [add.id] }, 3)
    const dev = { s: 'R' as const, why: 'dev' }
    expect(recv(join({}).wire)).toEqual(dev)
    expect(recv(join({ idb: idbOf(U, 'AAAA') }).wire)).toEqual(dev)
    expect(recv(join({ idb: idbOf(U, srv, add.id) }).wire)).toEqual(dev)
    expect(recv(join({ idb: { ...idbOf(U), ik: O_ } }).wire)).toEqual(dev)
    const forged = signDeviceCert2(thief.ik, srv, U_, keyId(U.dk.pk))
    expect(recv(join({ idb: { ik: U_, dcert: forged } }).wire)).toEqual(dev)
    const j = join({ idb: idbOf(U) })
    expect(recv(j.wire).s).toBe('A')
    // a device of another identity is never live for U
    const borrowed = buildEvent2(
      { ik: U.ik, dk: O.dk },
      srv,
      'mark',
      'a',
      {},
      {
        seq: 2,
        ap: [j.id],
        aprev: add.id,
      },
      4
    )
    expect(recv(borrowed.wire)).toEqual({ s: 'R', why: 'auth' })
    // device_add: signed by the live primary (U's identity key) over its iprev
    const U2: Author = { ik: U.ik, dk: newKeyPair() }
    const d2 = keyId(U2.dk.pk)
    const dadd = (by: Author, dk: string, cert: string, ap: string, iprev: string, ts = 7) =>
      buildEvent2(by, srv, 'device_add', 'a', { dcert: cert }, { seq: 0, ap: [ap], iprev }, ts)
    expect(recv(dadd(U2, d2, signDeviceCert2(U2.dk, srv, U_, d2, j.id), j.id, j.id).wire)).toEqual(
      dev
    )
    expect(recv(dadd(U2, d2, signDeviceCert2(U.ik, srv, U_, d2, srv), j.id, j.id).wire)).toEqual(
      dev
    )
    const a2 = dadd(U2, d2, signDeviceCert2(U.ik, srv, U_, d2, j.id), j.id, j.id)
    expect(recv(a2.wire).s).toBe('A')
    // a rotation that names a new primary key: from then on only that key certifies devices
    const P2 = newKeyPair()
    const rc = { pcert: keyId(P2.pk), keep: [d2], seen: {} }
    const rsig = signRotation2(U.ik, srv, keyId(U.dk.pk), a2.id, rc)
    const rot = buildEvent2(
      U,
      srv,
      'primary_rotate',
      'a',
      { ik: U_, ...rc, rsig },
      { seq: 1, ap: [a2.id], aprev: j.id, iprev: a2.id },
      8
    )
    expect(recv(rot.wire).s).toBe('A')
    const U3: Author = { ik: U.ik, dk: newKeyPair() }
    const d3 = keyId(U3.dk.pk)
    expect(
      recv(dadd(U3, d3, signDeviceCert2(U.ik, srv, U_, d3, rot.id), rot.id, rot.id, 9).wire)
    ).toEqual(dev)
    const a3 = dadd(U3, d3, signDeviceCert2(P2, srv, U_, d3, rot.id), rot.id, rot.id, 9)
    expect(recv(a3.wire)).toEqual({ s: 'A' })
    expect([...(r.state().facts.devs.get(U_) ?? [])].sort()).toEqual(
      [keyId(U.dk.pk), d2, d3].sort()
    )
  })

  test('a proof carries two signed headers of one device, verified on the wire; the core lowers F with them', () => {
    const r = new AclReplica()
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
    const join = buildEvent2(U, srv, 'join', 'a', { idb: idbOf(U) }, { seq: 0, ap: [add.id] }, 3)
    expect(recv(join.wire).s).toBe('A')
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
    const g2 = buildEvent2(O, null, 'genesis', 'a', genesisOf([O, B]), { seq: 0 }, 1)
    const s2 = g2.id
    const r = new AclReplica()
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
