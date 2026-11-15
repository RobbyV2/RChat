import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { ed25519, ED25519_TORSION_SUBGROUP } from '@noble/curves/ed25519.js'
import { bytesToNumberLE, numberToBytesLE } from '@noble/curves/utils.js'
import { sha512 } from '@noble/hashes/sha2.js'
import { chainVectors, vectorKey } from '../../../scripts/p2p_chain_vectors'
import { deviceCertOk, signDeviceCert2, TAG_DEVICE } from '../p2p/acl/binding'
import { b64u, bytesOf, canonical, canonicalBytes, concat, utf8 } from '../p2p/canonical'
import { CARD_MAX, PREFIX } from '../p2p/card'
import {
  atHead,
  bindingBody2,
  bindingHead2,
  bindingProof2,
  bindingRequest2,
  CHAIN_MAX,
  headOf,
  isChainRecord,
  isCreation,
  isSuccessionV1,
  isSuccessionV2,
  KEYS_BYTES,
  keysOf,
  kindOf,
  makeCreation,
  makeRecovery,
  makeRemoval,
  makeReset,
  readChain,
  readKeys,
  readSuccession,
  recordId,
  safetyHalf,
  safetyKey,
  signCertV2,
  signProfileV2,
  signRevocationV2,
  signSuccessionV1,
  signSuccessionV2,
  succession2SignedBy,
  TAG2,
  trustedDevices,
  verifyCertV2,
  verifyProfileV2,
  verifyRevocationV2,
  verifySuccessionV1,
  verifySuccessionV2,
  type ChainRecord,
  type CreationRecord,
} from '../p2p/chain'
import { AclRoom } from '../p2p/acl_room'
import { TAG_SIG } from '../p2p/event_v1'
import {
  eventIdBytes2,
  signRevocation2,
  signRotation2,
  signUpgrade,
  TAG_REVOKE,
  TAG_ROTATE,
  TAG_SIG2,
  TAG_UPGRADE,
  upgradeSigOk,
} from '../p2p/event_v2'
import {
  bindingProof,
  isKeyId,
  keyId,
  signCert,
  signProfile,
  signRevocation,
  signSuccession,
  signTagged,
  TAG,
  verifyCert,
  verifyProfile,
  verifyRevocation,
  verify,
  verifySuccession,
  verifyTagged,
  verifyTaggedStrict,
  type KeyPair,
} from '../p2p/keys'
import { safetyDigits } from '../p2p/safety'
import { VOICE_TAG } from '../p2p/voice'
import { ServerWorld } from './p2p_server_world'

// Spec r8f 1.7: the key chain as real records. V is made with a recovery key (rkV, the epoch-0
// primary p0, the creating device D1); a thief holds D1 and p0, never ik or rkV.

const ASSET = fileURLToPath(
  new URL('../../../../../assets/p2p_chain_vectors.json', import.meta.url)
)

const K = vectorKey
const id = (name: string) => keyId(K(name).pk)
const AT = 1_762_400_000_000

const V = K('V')
const I = keyId(V.pk)
const rkV = K('rkV')
const rkV2 = K('rkV2')
const p0 = K('p0')
const crV = makeCreation(V, rkV, keyId(p0.pk), AT)
const h0 = headOf(crV)
const r1 = makeRecovery(I, rkV, h0, id('pk1'), [id('D2')], AT)
const cert1D1 = signCert(V, K('D1').pk, AT, 'Browser')
const unsigned = <T extends object>(r: T) =>
  Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('sig')))

// Signatures only a key's holder can make, with T a point of order 8: R = rB + jT under its key A,
// or under A + T, a key with a torsion part that is still a valid key id (the first nonce and j
// that `want` takes).
const { Point } = ed25519
const T8 = Point.fromHex(ED25519_TORSION_SUBGROUP[1])
const scalarOf = (...parts: Uint8Array[]) =>
  Point.Fn.create(bytesToNumberLE(sha512(concat(...parts))))
const craft = (
  key: KeyPair,
  msg: Uint8Array,
  torsion: boolean,
  want: (j: number, k: number) => boolean
) => {
  const { scalar: a, prefix } = ed25519.utils.getExtendedPublicKey(key.sk)
  const pk = (torsion ? Point.BASE.multiply(a).add(T8) : Point.BASE.multiply(a)).toBytes()
  for (let c = 0; ; c += 1) {
    const r = scalarOf(prefix, msg, Uint8Array.of(c))
    for (let j = 0; j < 8; j += 1) {
      const R = Point.BASE.multiply(r)
        .add(T8.multiplyUnsafe(BigInt(j)))
        .toBytes()
      const k = scalarOf(R, pk, msg)
      if (want(j, Number(k % BigInt(8))))
        return { pk, sig: concat(R, numberToBytesLE((r + k * a) % Point.Fn.ORDER, 32)) }
    }
  }
}
const withT = (key: KeyPair, msg: Uint8Array) => craft(key, msg, false, j => j === 1).sig
const smallR = (key: KeyPair, msg: Uint8Array, R: Uint8Array) => {
  const { scalar: a } = ed25519.utils.getExtendedPublicKey(key.sk)
  return concat(R, numberToBytesLE((scalarOf(R, key.pk, msg) * a) % Point.Fn.ORDER, 32))
}
// 0.3.0's rule: noble's cofactored check.
const cofactored = (pk: Uint8Array, msg: Uint8Array, sig: Uint8Array) =>
  ed25519.verify(sig, msg, pk, { zip215: false })
const torsionCases = (key: KeyPair, msg: Uint8Array): [string, Uint8Array, Uint8Array][] => {
  const exact = craft(key, msg, true, (j, k) => j !== 0 && (j + k) % 8 === 0)
  const plain = craft(key, msg, true, (j, k) => j === 0 && k !== 0)
  return [
    ['honest', key.pk, ed25519.sign(msg, key.sk)],
    ['R + T', key.pk, withT(key, msg)],
    ['R = T', key.pk, smallR(key, msg, T8.toBytes())],
    ['R = 0', key.pk, smallR(key, msg, Point.ZERO.toBytes())],
    ['key A + T, the equation without the cofactor', exact.pk, exact.sig],
    ['key A + T, an honest R', plain.pk, plain.sig],
  ]
}
// verify_strict's answers on torsionCases
const STRICT_ANSWERS: [string, boolean][] = [
  ['honest', true],
  ['R + T', false],
  ['R = T', false],
  ['R = 0', false],
  ['key A + T, the equation without the cofactor', true],
  ['key A + T, an honest R', false],
]

describe('P2P chain records', () => {
  test('R8-chain: a creation record, a recovery and a reset verify; dropping sig_rk, pk = ik, a record signed by the old rk after the reset, a prev that does not match, or a record with an unknown field: refused; a copy with an extra field has the same identity', () => {
    const reset = makeReset(I, rkV, rkV2, headOf(r1), id('pk2'), [id('D2')], AT)
    expect(isCreation(crV)).toBe(true)
    const view = readChain(crV, [r1, reset])
    expect(view.heads).toEqual([headOf(reset)])
    expect([view.primary(view.heads[0]), view.inForce(view.heads[0])]).toEqual([
      id('pk2'),
      keyId(rkV2.pk),
    ])
    expect([view.counts(recordId(r1)), view.counts(recordId(reset)), view.frozen]).toEqual([
      true,
      true,
      false,
    ])
    expect([kindOf(r1), kindOf(reset)]).toEqual(['recovery', 'reset'])

    const { sig_rk, ...noRk } = crV
    expect(isCreation(noRk)).toBe(false)
    expect(isCreation({ ...crV, sig_rk: crV.sig_ik })).toBe(false)
    expect(isCreation({ ...crV, sig_ik: sig_rk })).toBe(false)
    const body = { ...unsigned(crV), pk: I }
    const selfPrimary = {
      ...body,
      sig_ik: signTagged(V.sk, TAG2.create, body),
      sig_rk: signTagged(rkV.sk, TAG2.create, body),
    }
    expect(isCreation(selfPrimary)).toBe(false)
    expect(() => readChain(selfPrimary as unknown as CreationRecord, [])).toThrow()

    const stale = makeRecovery(I, rkV, headOf(reset), id('pk3'), [], AT)
    const fresh = makeRecovery(I, rkV2, headOf(reset), id('pk3'), [], AT)
    expect(readChain(crV, [r1, reset, stale]).has(recordId(stale))).toBe(false)
    expect(readChain(crV, [r1, reset, fresh]).heads).toEqual([headOf(fresh)])
    const lost = makeRecovery(I, rkV, { n: 0, d: recordId(r1) }, id('pk1'), [], AT)
    expect(readChain(crV, [lost]).heads).toEqual([h0])
    const skip = makeRecovery(I, rkV, { n: 1, d: h0.d }, id('pk1'), [], AT)
    expect(readChain(crV, [skip]).heads).toEqual([h0])

    const noted = { ...r1, note: 1 }
    expect(isChainRecord(noted)).toBe(false)
    expect(readChain(crV, [noted as ChainRecord]).heads).toEqual([h0])
    expect(isCreation({ ...crV, x: 1 })).toBe(false)
    expect(recordId({ ...crV, x: 1 } as CreationRecord)).toBe(recordId(crV))
    expect(recordId(noted as ChainRecord)).toBe(recordId(r1))
    expect(recordId({ ...crV, sig_ik: crV.sig_rk })).toBe(recordId(crV))
    expect(recordId(crV)).toBe(
      b64u(
        createHash('sha256')
          .update(canonical(unsigned(crV)))
          .digest()
      )
    )
    expect(recordId(r1)).toBe(
      b64u(
        createHash('sha256')
          .update(canonical(unsigned(r1)))
          .digest()
      )
    )
  })

  test('a copy of a record with a bad signature never hides the record, whichever comes first', () => {
    const forged = { ...r1, sig: makeRecovery(I, K('thief'), h0, id('pk1'), [id('D2')], AT).sig }
    expect(recordId(forged)).toBe(recordId(r1))
    expect(isChainRecord(forged)).toBe(true)
    for (const recs of [
      [r1, forged],
      [forged, r1],
    ]) {
      const view = readChain(crV, recs)
      expect(view.heads).toEqual([headOf(r1)])
      expect(view.verifies(r1)).toBe(true)
      expect(view.verifies(forged)).toBe(false)
      expect(view.records()).toEqual([r1])
    }
    expect(readChain(crV, [forged]).heads).toEqual([h0])
    const reset = makeReset(I, rkV, rkV2, h0, id('pk1'), [id('D2')], AT)
    const other = makeReset(I, rkV, K('thief'), h0, id('pk1'), [id('D2')], AT)
    const badNext = { ...reset, sig_next: other.sig_next }
    expect(recordId(badNext)).toBe(recordId(reset))
    for (const recs of [
      [reset, badNext],
      [badNext, reset],
    ]) {
      const view = readChain(crV, recs)
      expect(view.heads).toEqual([headOf(reset)])
      expect(view.inForce(view.heads[0])).toBe(keyId(rkV2.pk))
      expect(view.verifies(badNext)).toBe(false)
    }
    expect(readChain(crV, []).verifies(r1)).toBe(false)
  })

  test('at is never read: records that differ only in at are different records, and both count', () => {
    const early = makeRecovery(I, rkV, h0, id('pk1'), [id('D2')], 0)
    const late = makeRecovery(I, rkV, h0, id('pk1'), [id('D2')], Number.MAX_SAFE_INTEGER)
    expect(recordId(early)).not.toBe(recordId(late))
    const view = readChain(makeCreation(V, rkV, keyId(p0.pk), 0), [])
    expect(view.heads.length).toBe(1)
    const both = readChain(crV, [late, early])
    expect(both.heads.map(h => h.d).sort()).toEqual([recordId(early), recordId(late)].sort())
    const next = makeRecovery(I, rkV, headOf(late), id('pk2'), [], 5)
    expect(readChain(crV, [late, early, next]).heads).toEqual([headOf(next)])
  })

  test('B3 records are closed formats: every field of a record is checked, and no field is optional but rk and sig_next', () => {
    const reset = makeReset(I, rkV, rkV2, h0, id('pk1'), [id('D2')], AT)
    const removal = makeRemoval(I, rkV, h0, id('pk1'), [id('D2')], AT)
    expect([isChainRecord(r1), isChainRecord(reset), isChainRecord(removal)]).toEqual([
      true,
      true,
      true,
    ])
    for (const k of Object.keys(crV)) {
      const { [k]: gone, ...rest } = crV as unknown as Record<string, unknown>
      void gone
      expect(isCreation(rest)).toBe(false)
    }
    for (const k of Object.keys(r1)) {
      const { [k]: gone, ...rest } = r1 as unknown as Record<string, unknown>
      void gone
      expect(isChainRecord(rest)).toBe(false)
    }
    const bad: Record<string, unknown>[] = [
      { v: 2 },
      { n: 0 },
      { n: CHAIN_MAX + 1 },
      { n: 1.5 },
      { prev: 'x' },
      { prev: I + 'A' },
      { pk: I },
      { pk: '' },
      { ik: 'V' },
      { keep: id('D2') },
      { keep: ['D2'] },
      { keep: Array.from({ length: 9 }, (_, i) => id(`k${i}`)) },
      { at: -1 },
      { at: '0' },
      { sig: '' },
      { rk: 7 },
      { rk: 'x' },
      { sig_next: reset.sig_next },
    ]
    for (const b of bad) expect(isChainRecord({ ...r1, ...b })).toBe(false)
    expect(isChainRecord({ ...removal, sig_next: reset.sig_next })).toBe(false)
    const { sig_next, ...bare } = reset
    void sig_next
    expect(isChainRecord(bare)).toBe(false)
    for (const b of [{ v: 2 }, { n: 1 }, { rk: '' }, { pk: 'x' }, { at: 1.5 }, { ik: 'V' }])
      expect(isCreation({ ...crV, ...b })).toBe(false)
    expect(isCreation(null)).toBe(false)
    expect(isChainRecord([r1])).toBe(false)
  })

  test('B3 reset and removal are chain records signed by the key in force', () => {
    const reset = makeReset(I, rkV, rkV2, h0, id('pk1'), [id('D2')], AT)
    const afterReset = readChain(crV, [reset])
    expect(afterReset.inForce(afterReset.heads[0])).toBe(keyId(rkV2.pk))
    expect(afterReset.signer(recordId(reset))).toBe(keyId(rkV.pk))
    const byNext = makeReset(I, rkV2, rkV2, h0, id('pk1'), [id('D2')], AT)
    expect(readChain(crV, [byNext]).heads).toEqual([h0])
    const forged = {
      ...reset,
      sig_next: makeReset(I, rkV, K('thief'), h0, id('pk1'), [id('D2')], AT).sig_next,
    }
    expect(readChain(crV, [forged]).heads).toEqual([h0])

    const removal = makeRemoval(I, rkV, h0, id('hot'), [id('D2')], AT)
    const afterRemoval = readChain(crV, [removal])
    expect(kindOf(removal)).toBe('removal')
    expect([
      afterRemoval.primary(afterRemoval.heads[0]),
      afterRemoval.inForce(afterRemoval.heads[0]),
    ]).toEqual([id('hot'), id('hot')])
    const byOld = makeRecovery(I, rkV, headOf(removal), id('pk2'), [], AT)
    const byHot = makeRecovery(I, K('hot'), headOf(removal), id('pk2'), [], AT)
    expect(readChain(crV, [removal, byOld]).heads).toEqual([headOf(removal)])
    expect(readChain(crV, [removal, byHot]).heads).toEqual([headOf(byHot)])
  })

  test('B3 a reset installs a new primary', () => {
    const reset = makeReset(I, rkV, rkV2, h0, id('pk1'), [id('D2')], AT)
    const view = readChain(crV, [reset])
    expect(view.primary(h0)).toBe(keyId(p0.pk))
    expect(view.primary(view.heads[0])).toBe(id('pk1'))
    const { pk, ...noPk } = reset
    void pk
    expect(isChainRecord(noPk)).toBe(false)
    const cert = signCertV2(p0, I, 0, id('T9'), AT, 'Browser')
    expect([atHead(readChain(crV, []), cert), atHead(view, cert)]).toEqual([true, false])
  })

  test('R8-same-n: two recoveries with the same n both count until a record cites one; n + 1 accepted whichever it cites', () => {
    const ra = makeRecovery(I, rkV, h0, id('pkA'), [id('A')], AT)
    const rb = makeRecovery(I, rkV, h0, id('pkB'), [id('B')], AT)
    const two = readChain(crV, [rb, ra])
    expect(two.heads.map(h => h.d).sort()).toEqual([recordId(ra), recordId(rb)].sort())
    expect(trustedDevices(two, [id('D1')], [], [])).toEqual([id('A'), id('B')].sort())
    for (const cited of [ra, rb]) {
      const next = makeRecovery(I, rkV, headOf(cited), id('pk2'), [id('A'), id('B')], AT)
      const view = readChain(crV, [rb, ra, next])
      expect([view.top, view.heads]).toEqual([2, [headOf(next)]])
      expect(trustedDevices(view, [id('D1')], [], [])).toEqual([id('A'), id('B')].sort())
      expect([view.counts(recordId(ra)), view.counts(recordId(rb)), view.frozen]).toEqual([
        true,
        true,
        false,
      ])
    }
  })

  test("R8-rival-reset: the user's reset and a thief's reset, both by the old key: no device trusted", () => {
    const mine = makeReset(I, rkV, rkV2, h0, id('pk1'), [id('D2')], AT)
    const theirs = makeReset(I, rkV, K('rkZ'), h0, id('pZ'), [id('Z1')], AT)
    const view = readChain(crV, [mine, theirs])
    expect(view.frozen).toBe(true)
    expect(
      trustedDevices(view, [id('D1')], [signCertV2(K('pk1'), I, 1, id('D5'), AT, '')], [])
    ).toEqual([])
    expect([view.dead(recordId(mine)), view.dead(recordId(theirs)), view.heads]).toEqual([
      true,
      true,
      [h0],
    ])
    const removal = makeRemoval(I, rkV, h0, id('pZ'), [id('Z1')], AT)
    expect(readChain(crV, [mine, removal]).frozen).toBe(true)
    const recovery = makeRecovery(I, rkV, h0, id('pZ'), [id('Z1')], AT)
    const killed = readChain(crV, [mine, recovery])
    expect([killed.frozen, killed.dead(recordId(recovery)), killed.heads]).toEqual([
      false,
      true,
      [headOf(mine)],
    ])
    const later = makeReset(I, rkV, K('rkZ'), headOf(r1), id('pZ'), [], AT)
    const chained = readChain(crV, [r1, later])
    expect([chained.frozen, chained.counts(recordId(r1)), chained.deadKey(keyId(rkV.pk))]).toEqual([
      false,
      true,
      true,
    ])
  })

  test('R8-rk-revoke: a revocation signed by the recovery key applies after a recovery; after a reset one signed by the old key is ignored (key death)', () => {
    const rx = makeRecovery(I, rkV, h0, id('pk1'), [id('D2'), id('D5')], AT)
    const rev = signRevocationV2(rkV, I, keyId(p0.pk), 0, id('D5'), AT)
    expect(verifyRevocationV2(rev, keyId(rkV.pk), I)).toBe(true)
    expect(verifyRevocationV2(rev, keyId(p0.pk))).toBe(false)
    expect(trustedDevices(readChain(crV, [rx]), [id('D1')], [], [rev])).toEqual([id('D2')])
    const reset = makeReset(I, rkV, rkV2, h0, id('pk1'), [id('D2'), id('D5')], AT)
    expect(trustedDevices(readChain(crV, [reset]), [id('D1')], [], [rev])).toEqual(
      [id('D2'), id('D5')].sort()
    )
    const fresh = signRevocationV2(rkV2, I, id('pk1'), 1, id('D5'), AT)
    expect(trustedDevices(readChain(crV, [reset]), [id('D1')], [], [fresh])).toEqual([id('D2')])
  })

  test('R8-epoch: after a recovery the certificate and revocation of the old primary are ignored; a certificate under the head primary counts', () => {
    const view = readChain(crV, [makeRecovery(I, rkV, h0, keyId(K('pk1').pk), [id('D2')], AT)])
    const stolen = signCertV2(p0, I, 0, id('T9'), AT, 'Browser')
    const revoke = signRevocationV2(p0, I, keyId(p0.pk), 0, id('D2'), AT)
    const added = signCertV2(K('pk1'), I, 1, id('D3'), AT, 'Phone')
    expect(verifyCertV2(stolen, I) && verifyCertV2(added, I)).toBe(true)
    expect(trustedDevices(view, [id('D1')], [stolen, added], [revoke])).toEqual(
      [id('D2'), id('D3')].sort()
    )
    const before = readChain(crV, [])
    expect(trustedDevices(before, [id('D1')], [stolen], [])).toEqual([id('D1'), id('T9')].sort())
    expect(
      trustedDevices(
        before,
        [id('D1')],
        [stolen],
        [signRevocationV2(p0, I, keyId(p0.pk), 0, id('D1'), AT)]
      )
    ).toEqual([id('T9')])
    const dropped = signRevocationV2(K('pk1'), I, id('pk1'), 1, id('D3'), AT, id('D2'))
    expect(trustedDevices(view, [], [added], [dropped])).toEqual([id('D2')])
    const wrongEpoch = signCertV2(K('pk1'), I, 0, id('D4'), AT, '')
    expect(trustedDevices(view, [], [wrongEpoch], [])).toEqual([id('D2')])
  })

  test('R8-succession-cap: at the cap a ninth record is refused, and a v2 succession at the cap counts', () => {
    const recs: ChainRecord[] = []
    for (let n = 1, prev = h0; n <= CHAIN_MAX + 1; n += 1) {
      const body = {
        v: 1 as const,
        ik: I,
        n,
        prev: prev.d,
        pk: id(`pk${n}`),
        keep: [id('D2')],
        at: AT,
      }
      const r = { ...body, sig: signTagged(rkV.sk, TAG2.chain, body) }
      recs.push(r)
      prev = headOf(r)
    }
    expect(isChainRecord(recs[CHAIN_MAX])).toBe(false)
    const view = readChain(crV, recs)
    expect([view.top, view.heads]).toEqual([CHAIN_MAX, [headOf(recs[CHAIN_MAX - 1])]])
    expect(() => makeRecovery(I, rkV, view.heads[0], id('pk9'), [], AT)).not.toThrow()
    expect(isChainRecord(makeRecovery(I, rkV, view.heads[0], id('pk9'), [], AT))).toBe(false)
    const W = K('W')
    const rkW = K('rkW')
    const crW = makeCreation(W, rkW, id('pW'), AT)
    const move = signSuccessionV2(rkV, I, view.heads[0], rkW, crW, AT)
    expect(verifySuccessionV2(move, crW, view.inForce(view.heads[0]))).toBe(true)
  })

  test('R8-succession-size: at n = 8 with 8 keeps, real keys, digests and signatures: a profile with succ, succ_cr and a badge fits 4 KiB, the old card with them fits CARD_MAX with 3 certs2; with the old chain neither fits; the chain fits 6 KiB', () => {
    const chain: ChainRecord[] = []
    for (let n = 1, prev = h0; n <= CHAIN_MAX; n += 1) {
      const keep = Array.from({ length: 8 }, (_, i) => id(`dev ${n}.${i}`))
      const r = makeRecovery(I, rkV, prev, id(`pk${n}`), keep, AT)
      chain.push(r)
      prev = headOf(r)
    }
    const view = readChain(crV, chain)
    const head = view.heads[0]
    const W = K('W')
    const rkW = K('rkW')
    const crW = makeCreation(W, rkW, id('pW'), AT)
    const succ = signSuccessionV2(rkV, I, head, rkW, crW, AT)
    const len = (x: unknown) => canonicalBytes(x).length
    const cardLen = (x: unknown) =>
      (PREFIX + b64u(new Uint8Array(deflateRawSync(canonicalBytes(x))))).length
    const binding = 'x'.repeat(600)
    const profile = (extra: object) =>
      len({ name: 'A name of thirty-two characters!', color: '#336699', binding, ...extra })
    const certs2 = (k: number) =>
      Array.from({ length: k }, (_, i) => signCertV2(K('pk8'), I, 8, id(`c${i}`), AT, 'Browser'))
    const card = (k: number, extra: object) =>
      cardLen({
        v: 1,
        ik: I,
        cr: crV,
        head,
        certs: [cert1D1],
        certs2: certs2(k),
        name: 'A name',
        sig_host: 'chat.example.org',
        ...extra,
      })
    expect(profile({ succ, succ_cr: crW })).toBeLessThanOrEqual(4096)
    expect(card(3, { succ, succ_cr: crW })).toBeLessThanOrEqual(CARD_MAX)
    expect(profile({ succ: { ...succ, chain: [crV, ...chain] }, succ_cr: crW })).toBeGreaterThan(
      4096
    )
    expect(card(0, { succ: { ...succ, chain }, succ_cr: crW })).toBeGreaterThan(CARD_MAX)
    const keys = keysOf(view)
    expect(len(keys)).toBeLessThanOrEqual(6 * 1024)
    expect(readKeys(keys)).toEqual(keys)
    expect([len(crV), len(certs2(1)[0])].every(n => n > 300 && n < 420)).toBe(true)
  })

  test('R8-safety-rk: two creation records with one ik give different halves; an unprotected identity keeps its 0.3.0 half', () => {
    expect(safetyHalf(I, keyId(rkV.pk))).not.toBe(safetyHalf(I, keyId(rkV2.pk)))
    expect(safetyHalf(I, keyId(rkV.pk))).not.toBe(safetyHalf(I))
    expect(/^\d{30}$/.test(safetyHalf(I, keyId(rkV.pk)))).toBe(true)
    const L = id('L')
    const [a, b] = I < L ? [I, L] : [L, I]
    expect(safetyDigits(I, L)).toBe(safetyHalf(a) + safetyHalf(b))
    expect(safetyKey(I)).toEqual(V.pk)
    const k = safetyKey(I, keyId(rkV.pk))
    expect(k.length).toBe(64)
    expect(k.subarray(0, 32)).toEqual(V.pk)
    expect(b64u(k.subarray(32))).toBe(b64u(createHash('sha256').update(rkV.pk).digest()))
    const sha512 = (...parts: Uint8Array[]) =>
      new Uint8Array(
        createHash('sha512')
          .update(concat(...parts))
          .digest()
      )
    let h = sha512(new Uint8Array([0, 1]), k, utf8('rchat-p2p'))
    for (let i = 0; i < 5200; i += 1) h = sha512(h, k)
    let digits = ''
    for (let c = 0; c < 6; c += 1) {
      let n = 0
      for (let j = 0; j < 5; j += 1) n = n * 256 + h[c * 5 + j]
      digits += String(n % 100000).padStart(5, '0')
    }
    expect(safetyHalf(I, keyId(rkV.pk))).toBe(digits)
    expect(() => safetyKey('x')).toThrow()
    expect(() => safetyKey(I, 'x')).toThrow()
  })

  test('R8-contexts: every record of the signature-context table verifies only under its own tag; a v1 certificate or a creation record presented as a server dcert, rec, rsig or upgrade signature fails to verify', () => {
    const tags = [
      TAG2.create,
      TAG2.chain,
      TAG.cert,
      TAG2.cert,
      TAG.revoke,
      TAG2.crevoke,
      TAG.profile,
      TAG2.profile,
      TAG.succession,
      TAG2.succ2,
      TAG.bind,
      TAG2.bind,
      TAG_DEVICE,
      TAG_REVOKE,
      TAG_ROTATE,
      TAG_UPGRADE,
      'rchat-p2p-checkpoint2\0',
      TAG_SIG2,
      TAG_SIG,
      'rchat-p2p-auth1\0',
      TAG.offer,
      VOICE_TAG,
    ]
    expect(TAG2.succ1).toBe(TAG.succession)
    expect(new Set(tags).size).toBe(22)
    for (const t of tags) {
      expect(/^rchat-p2p-[a-z0-9]+\0$/.test(t)).toBe(true)
      for (const u of tags) expect(t !== u && u.startsWith(t)).toBe(false)
    }
    const body = { ik: I, dk: id('D1'), n: 0 }
    for (const t of tags) {
      const sig = signTagged(V.sk, t, body)
      for (const u of tags) expect(verifyTagged(I, u, body, sig)).toBe(t === u)
    }

    const W = K('W')
    const rkW = K('rkW')
    const crW = makeCreation(W, rkW, id('pW'), AT)
    const reset = makeReset(I, rkV, rkV2, h0, id('pk1'), [id('D2')], AT)
    const cert2 = signCertV2(p0, I, 0, id('D2'), AT, 'Phone')
    const rev2 = signRevocationV2(p0, I, keyId(p0.pk), 0, id('D2'), AT)
    const prof2 = signProfileV2(p0, I, 0, 'Vera', AT, '#336699')
    const s1 = signSuccessionV1(K('L'), rkW, crW, AT)
    const s2 = signSuccessionV2(rkV, I, h0, rkW, crW, AT)
    const records: [string, string, string, object, string][] = [
      ['create1 by ik', TAG2.create, I, unsigned(crV), crV.sig_ik],
      ['create1 by rk', TAG2.create, keyId(rkV.pk), unsigned(crV), crV.sig_rk],
      ['chain1', TAG2.chain, keyId(rkV.pk), unsigned(reset), reset.sig],
      ['chain1 by the next key', TAG2.chain, keyId(rkV2.pk), unsigned(reset), reset.sig_next!],
      ['cert1', TAG.cert, I, unsigned(cert1D1), cert1D1.sig],
      ['cert2', TAG2.cert, keyId(p0.pk), unsigned(cert2), cert2.sig],
      [
        'revoke1',
        TAG.revoke,
        id('L'),
        unsigned(signRevocation(K('L'), id('D2'), AT)),
        signRevocation(K('L'), id('D2'), AT).sig,
      ],
      ['crevoke2', TAG2.crevoke, keyId(p0.pk), unsigned(rev2), rev2.sig],
      [
        'profile1',
        TAG.profile,
        id('L'),
        unsigned(signProfile(K('L'), 'Lee', AT)),
        signProfile(K('L'), 'Lee', AT).sig,
      ],
      ['profile2', TAG2.profile, keyId(p0.pk), unsigned(prof2), prof2.sig],
      ['succ1 by the old ik', TAG2.succ1, id('L'), unsigned(s1), s1.sig_old],
      ['succ1 by the new rk', TAG2.succ1, keyId(rkW.pk), unsigned(s1), s1.sig_new],
      ['succ2 by the old rk', TAG2.succ2, keyId(rkV.pk), unsigned(s2), s2.sig_old],
      ['succ2 by the new rk', TAG2.succ2, keyId(rkW.pk), unsigned(s2), s2.sig_new],
      [
        'bind2',
        TAG2.bind,
        keyId(p0.pk),
        bindingBody2('vera@chat.example.org', I, h0, 1),
        bindingProof2(p0, 'vera@chat.example.org', I, h0, 1),
      ],
    ]
    for (const [name, tag, key, signedBody, sig] of records)
      for (const u of tags)
        expect([name, u, verifyTagged(key, u, signedBody, sig)]).toEqual([name, u, u === tag])

    const raw = (key: KeyPair, tag: string, rest: Uint8Array) =>
      ed25519.sign(concat(utf8(tag), rest), key.sk)
    const check = (key: KeyPair, tag: string, rest: Uint8Array, sig: Uint8Array) =>
      ed25519.verify(sig, concat(utf8(tag), rest), key.pk)
    const rest = canonicalBytes(body)
    const srvRest = concat(utf8('srv'), utf8('\0'), rest)
    for (const t of tags) {
      const plain = raw(V, t, rest)
      const bound = raw(V, t, srvRest)
      for (const u of tags) {
        expect(check(V, u, rest, plain)).toBe(t === u)
        expect(check(V, u, srvRest, plain)).toBe(false)
        expect(check(V, u, rest, bound)).toBe(false)
      }
    }
    const bind1 = bytesOf(bindingProof(V, 'vera@chat.example.org', 1), 64)!
    for (const u of tags)
      expect(check(V, u, concat(utf8('vera@chat.example.org'), utf8('\0'), utf8('1')), bind1)).toBe(
        u === TAG.bind
      )

    const srv = 'srv'
    const D1 = id('D1')
    const real = signDeviceCert2(V, srv, I, D1)
    expect(deviceCertOk(I, srv, I, D1, '', real)).toBe(true)
    const g = { nonce: 'n', owners: [] }
    const seen = { [D1]: 0 }
    for (const sig of [cert1D1.sig, crV.sig_ik]) {
      expect(deviceCertOk(I, srv, I, D1, '', sig)).toBe(false)
      expect(upgradeSigOk(I, srv, g, sig)).toBe(false)
      expect(sig).not.toBe(signRevocation2(V, srv, D1, 0))
      expect(sig).not.toBe(signRotation2(V, srv, D1, undefined, { keep: [], seen }))
      expect(sig).not.toBe(signUpgrade(V, srv, g))
    }
    for (const sig of [
      real,
      signRevocation2(V, srv, D1, 0),
      signRotation2(V, srv, D1, undefined, {}),
      signUpgrade(V, srv, g),
    ]) {
      expect(isCreation({ ...crV, sig_ik: sig })).toBe(false)
      expect(verifyCert({ ...cert1D1, sig }, I)).toBe(false)
    }
    expect(verifyCert(cert1D1, I)).toBe(true)
    expect(verifyProfile({ ...prof2, v: 1 })).toBe(false)
    expect(verifyRevocation(rev2)).toBe(false)
    expect(verifySuccession(s1)).toBe(false)
  }, 60_000)

  test('v2 certificates, revocations and profiles are closed and signed by the key they name', () => {
    const cert = signCertV2(p0, I, 0, id('D2'), AT, 'Phone')
    expect(verifyCertV2(cert)).toBe(true)
    expect(verifyCertV2(cert, id('L'))).toBe(false)
    expect(verifyCertV2({ ...cert, note: 1 })).toBe(false)
    expect(verifyCertV2({ ...cert, n: 1 })).toBe(false)
    expect(verifyCertV2({ ...cert, v: 1 })).toBe(false)
    expect(verifyCertV2({ ...cert, pk: I })).toBe(false)
    expect(verifyCertV2(cert1D1)).toBe(false)
    expect(verifyCert(cert)).toBe(false)
    const rev = signRevocationV2(p0, I, keyId(p0.pk), 0, id('D2'), AT, id('D3'))
    expect(verifyRevocationV2(rev, keyId(p0.pk))).toBe(true)
    expect(verifyRevocationV2({ ...rev, successor: id('D4') }, keyId(p0.pk))).toBe(false)
    expect(verifyRevocationV2({ ...rev, note: 1 }, keyId(p0.pk))).toBe(false)
    expect(verifyRevocationV2(rev, keyId(p0.pk), id('L'))).toBe(false)
    const prof = signProfileV2(p0, I, 0, '  Vera  ', AT, '#336699')
    expect(prof.name).toBe('Vera')
    expect(verifyProfileV2(prof, I)).toBe(true)
    expect(verifyProfileV2({ ...prof, name: 'Mallory' })).toBe(false)
    expect(verifyProfileV2({ ...prof, note: 1 })).toBe(false)
    expect(verifyProfileV2({ ...prof, color: 'red' })).toBe(false)
    expect(verifyProfileV2(signProfileV2(p0, I, 0, 'Vera', AT))).toBe(true)
    expect(atHead(readChain(crV, []), prof)).toBe(true)
    expect(atHead(readChain(crV, [r1]), prof)).toBe(false)
  })

  test('succession v1 and v2 are closed formats: sig_old by the old key, sig_new by the new recovery key, never by the new ik', () => {
    const L = K('L')
    const W = K('W')
    const rkW = K('rkW')
    const crW = makeCreation(W, rkW, id('pW'), AT)
    const s1 = signSuccessionV1(L, rkW, crW, AT)
    expect(Object.keys(s1).sort()).toEqual([
      'at',
      'new',
      'new_cr',
      'old',
      'sig_new',
      'sig_old',
      'v',
    ])
    expect(verifySuccessionV1(s1, crW)).toBe(true)
    expect(verifySuccessionV1({ ...s1, note: 1 }, crW)).toBe(false)
    expect(verifySuccessionV1(s1, makeCreation(W, K('rkT'), id('pW'), AT))).toBe(false)
    expect(verifySuccessionV1(s1, makeCreation(K('X'), rkW, id('pW'), AT))).toBe(false)
    expect(verifySuccessionV1(s1, { ...crW, note: 1 })).toBe(false)
    expect(verifySuccessionV1(s1, makeCreation(W, rkW, id('pW2'), AT))).toBe(false)
    expect(verifySuccessionV1(s1, makeCreation(W, rkW, id('pW'), AT + 1))).toBe(false)
    const byNewIk = signSuccessionV1(L, W, crW, AT)
    expect(isSuccessionV1(byNewIk)).toBe(true)
    expect(verifySuccessionV1(byNewIk, crW)).toBe(false)
    expect(verifySuccessionV1(signSuccessionV1(K('thief'), rkW, crW, AT), crW)).toBe(true)
    expect(verifySuccessionV1({ ...s1, old: id('thief') }, crW)).toBe(false)
    const old = signSuccession(L, W, AT)
    expect(verifySuccession(old)).toBe(true)
    expect(isSuccessionV1(old)).toBe(false)
    expect(verifySuccession(s1)).toBe(false)

    const view = readChain(crV, [r1])
    const head = view.heads[0]
    const s2 = signSuccessionV2(rkV, I, head, rkW, crW, AT)
    expect(Object.keys(s2).sort()).toEqual([
      'at',
      'head',
      'new',
      'new_cr',
      'old',
      'sig_new',
      'sig_old',
      'v',
    ])
    expect(verifySuccessionV2(s2, crW, view.inForce(head))).toBe(true)
    expect(succession2SignedBy(s2, view.primary(head))).toBe(false)
    expect(
      verifySuccessionV2(signSuccessionV2(K('pk1'), I, head, rkW, crW, AT), crW, view.inForce(head))
    ).toBe(false)
    expect(
      verifySuccessionV2(signSuccessionV2(rkV, I, head, W, crW, AT), crW, view.inForce(head))
    ).toBe(false)
    expect(verifySuccessionV2({ ...s2, head: h0 }, crW, view.inForce(head))).toBe(false)
    expect(verifySuccessionV2({ ...s2, by: keyId(rkV.pk) }, crW, view.inForce(head))).toBe(false)
    expect(isSuccessionV2({ ...s2, head: { ...head, x: 1 } })).toBe(false)
    expect(isSuccessionV2({ ...s2, v: 1 })).toBe(false)
    const removal = makeRemoval(I, rkV, h0, id('hot'), [], AT)
    const hot = readChain(crV, [removal])
    const s3 = signSuccessionV2(K('hot'), I, hot.heads[0], rkW, crW, AT)
    expect(verifySuccessionV2(s3, crW, hot.inForce(hot.heads[0]))).toBe(true)
    expect(verifySuccessionV1(s2, crW) || verifySuccessionV2(s1, crW, keyId(rkV.pk))).toBe(false)
  })

  test('a value canonical JSON refuses (-0, a float, past 2^53, a lone surrogate, not NFC) makes every reader return false or null, never throw', () => {
    const W = K('W')
    const rkW = K('rkW')
    const crW = makeCreation(W, rkW, id('pW'), AT)
    const view = readChain(crV, [r1])
    const head = view.heads[0]
    const nums = [-0, 1.5, 1e300, 2 ** 53]
    const texts = ['\ud800', 'A\udc00', 'e\u0301']
    const variants = <T extends object>(x: T, fields: string[], values: unknown[]) =>
      fields.flatMap(f => values.map(v => ({ ...x, [f]: v })))
    const cert = signCertV2(p0, I, 0, id('D2'), AT, 'Phone')
    const rev = signRevocationV2(p0, I, keyId(p0.pk), 0, id('D2'), AT)
    const prof = signProfileV2(p0, I, 0, 'Vera', AT)
    const s1 = signSuccessionV1(K('L'), rkW, crW, AT)
    const s2 = signSuccessionV2(rkV, I, head, rkW, crW, AT)
    const req = bindingRequest2(K('pk1'), 'v@x', { cr: crV, chain: [r1] }, head, 5)
    const results: unknown[] = []
    const run = (f: () => unknown) => {
      expect(f).not.toThrow()
      results.push(f())
    }
    for (const c of variants(crV, ['n', 'at'], nums)) {
      run(() => isCreation(c))
      run(() => readKeys({ cr: c, chain: [] }))
      run(() => readSuccession({ succ: s1, succ_cr: c }))
      run(() => bindingHead2('v@x', { ...req, cr: c }))
    }
    for (const r of [...variants(r1, ['at'], nums), { ...r1, rk: undefined }]) {
      run(() => isChainRecord(r))
      run(() => readKeys({ cr: crV, chain: [r] }))
      run(() => bindingHead2('v@x', { ...req, chain: [r] }))
      expect(readChain(crV, [r as ChainRecord]).top).toBe(0)
    }
    for (const c of [
      ...variants(cert, ['n', 'created'], nums),
      ...variants(cert, ['label'], texts),
    ])
      run(() => verifyCertV2(c))
    for (const r of [
      ...variants(rev, ['n', 'revoked_at'], nums),
      { ...rev, successor: undefined },
    ]) {
      run(() => verifyRevocationV2(r, keyId(p0.pk)))
      expect(trustedDevices(readChain(crV, []), [id('D2')], [], [r as typeof rev])).toEqual([
        id('D2'),
      ])
    }
    for (const p of [
      ...variants(prof, ['n', 'updated'], nums),
      ...variants(prof, ['name'], texts),
      { ...prof, color: undefined },
    ])
      run(() => verifyProfileV2(p))
    for (const s of variants(s1, ['at'], nums)) {
      run(() => isSuccessionV1(s))
      run(() => verifySuccessionV1(s, crW))
      run(() => readSuccession({ succ: s, succ_cr: crW }))
    }
    for (const s of [
      ...variants(s2, ['at'], nums),
      ...nums.map(n => ({ ...s2, head: { ...s2.head, n } })),
    ]) {
      run(() => isSuccessionV2(s))
      run(() => verifySuccessionV2(s, crW, keyId(rkV.pk)))
      run(() => succession2SignedBy(s as typeof s2, keyId(rkV.pk)))
    }
    for (const ts of nums) run(() => bindingHead2('v@x', { ...req, ts }))
    expect(results.filter(x => x !== false && x !== null)).toEqual([])
  })

  test('r8e completeness M3: succ and succ_cr are sibling fields, never succ_cr inside the closed succession; keys, keys_old and the yours echo are {cr, chain}', () => {
    const W = K('W')
    const rkW = K('rkW')
    const crW = makeCreation(W, rkW, id('pW'), AT)
    const s1 = signSuccessionV1(K('L'), rkW, crW, AT)
    const s2 = signSuccessionV2(rkV, I, h0, rkW, crW, AT)
    expect(readSuccession({ name: 'Vera', succ: s2, succ_cr: crW })).toEqual({
      succ: s2,
      succ_cr: crW,
    })
    expect(readSuccession({ succ: s1, succ_cr: crW })).toEqual({ succ: s1, succ_cr: crW })
    expect(readSuccession({ succ: { ...s2, succ_cr: crW } })).toBeNull()
    expect(readSuccession({ succ: { ...s2, succ_cr: crW }, succ_cr: crW })).toBeNull()
    expect(readSuccession({ succ: s2 })).toBeNull()
    expect(readSuccession({ succ: s2, succ_cr: crV })).toBeNull()
    expect(readSuccession({ succ: { ...s2, chain: [r1] }, succ_cr: crW })).toBeNull()
    expect(readSuccession(null)).toBeNull()

    const ra = makeRecovery(I, rkV, h0, id('pkA'), [id('A')], AT)
    const view = readChain(crV, [r1, ra])
    const keys = keysOf(view)
    expect(Object.keys(keys)).toEqual(['cr', 'chain'])
    expect(keys.chain.map(r => r.n)).toEqual([1, 1])
    expect(readKeys({ ...keys, later: true })).toEqual(keys)
    expect(readKeys({ cr: crV, chain: [] })).toEqual({ cr: crV, chain: [] })
    expect(readKeys([crV, r1])).toBeNull()
    expect(readKeys({ cr: crV })).toBeNull()
    expect(readKeys({ cr: crV, chain: [crV] })).toBeNull()
    expect(readKeys({ cr: { ...crV, x: 1 }, chain: [] })).toBeNull()
    expect(readKeys({ cr: crV, chain: [{ ...r1, x: 1 }] })).toBeNull()
    const r2 = makeRecovery(I, rkV, headOf(r1), id('pk2'), [], AT)
    expect(readKeys({ cr: crV, chain: [r2, r1] })).toBeNull()
    expect(readKeys({ cr: crV, chain: [r1, r2] })).toEqual({ cr: crV, chain: [r1, r2] })
    const crW2 = makeCreation(W, rkW, id('pW'), AT)
    expect(readKeys({ cr: crW2, chain: [r1] })).toBeNull()
    expect(readKeys({ cr: crV, chain: Array.from({ length: 9 }, () => r1) })).toBeNull()
  })

  test('a badge proof v2 is signed by the head primary over {sub, ik, head, ts}', () => {
    const sub = 'vera@chat.example.org'
    const pk1 = K('pk1')
    const head = headOf(r1)
    const keys = { cr: crV, chain: [r1] }
    expect(canonical(bindingBody2(sub, I, head, 5))).toBe(
      `{"head":{"d":"${head.d}","n":1},"ik":"${I}","sub":"${sub}","ts":5}`
    )
    const req = bindingRequest2(pk1, sub, keys, head, 5)
    expect(Object.keys(req).sort()).toEqual(['chain', 'cr', 'ik', 'proof', 'ts'])
    expect(bindingHead2(sub, req)).toEqual(head)
    expect(bindingHead2('mallory@chat.example.org', req)).toBeNull()
    expect(bindingHead2(sub, { ...req, ts: 6 })).toBeNull()
    expect(bindingHead2(sub, bindingRequest2(p0, sub, keys, h0, 5))).toBeNull()
    expect(bindingHead2(sub, bindingRequest2(pk1, sub, keys, h0, 5))).toBeNull()
    expect(bindingHead2(sub, bindingRequest2(p0, sub, { cr: crV, chain: [] }, h0, 5))).toEqual(h0)
    expect(bindingHead2(sub, { ...req, chain: [{ ...r1, x: 1 }] })).toBeNull()
    expect(bindingHead2(sub, { ...req, ik: id('L') })).toBeNull()
    expect(bindingHead2(sub, null)).toBeNull()
  })

  test('a badge request holds at most 9 records and 7 KiB (review n-p2p-ahead r2 M3, review n-k-server r1 owner question 1): more is refused before a record is read, and the largest valid chain fits', () => {
    const sub = 'vera@chat.example.org'
    const siblings = Array.from({ length: CHAIN_MAX + 1 }, (_, i) =>
      makeRecovery(I, rkV, h0, id(`s${i}`), [id('D2')], AT)
    )
    const eight = siblings.slice(0, CHAIN_MAX)
    const view = readChain(crV, siblings)
    expect(view.heads.length).toBe(CHAIN_MAX + 1)
    const head = headOf(siblings[0])
    const nine = bindingRequest2(K('s0'), sub, { cr: crV, chain: siblings }, head, 7)
    expect(bindingHead2(sub, nine)).toBeNull()
    expect(readKeys({ cr: crV, chain: siblings })).toBeNull()
    const fits = bindingRequest2(K('s0'), sub, { cr: crV, chain: eight }, head, 7)
    expect(bindingHead2(sub, fits)).toEqual(head)
    // nothing of an over-long chain is read: not a field, so not a signature
    let reads = 0
    const watched = siblings.map(
      r => new Proxy(r, { get: (o, k) => ((reads += 1), Reflect.get(o, k)) })
    )
    expect(bindingHead2(sub, { ...nine, chain: watched })).toBeNull()
    expect(readKeys({ cr: crV, chain: watched })).toBeNull()
    expect(reads).toBe(0)

    // The largest valid {cr, chain}: 8 resets that keep 8 devices each, every at at its largest
    expect(KEYS_BYTES).toBe(7 * 1024)
    const crMax = makeCreation(V, rkV, keyId(p0.pk), Number.MAX_SAFE_INTEGER)
    const resets: ChainRecord[] = []
    for (let n = 1, prev = headOf(crMax), rk = rkV; n <= CHAIN_MAX; n += 1) {
      const next = K(`rk${n}`)
      const keep = Array.from({ length: 8 }, (_, i) => id(`dev ${n}.${i}`))
      const r = makeReset(I, rk, next, prev, id(`q${n}`), keep, Number.MAX_SAFE_INTEGER)
      resets.push(r)
      prev = headOf(r)
      rk = next
    }
    const top = headOf(resets[CHAIN_MAX - 1])
    const wide = readChain(crMax, resets)
    expect([wide.heads, resets.every(r => wide.verifies(r))]).toEqual([[top], true])
    const keys = { cr: crMax, chain: resets }
    expect(canonicalBytes(keys).length).toBe(6913)
    const big = bindingRequest2(K(`q${CHAIN_MAX}`), sub, keys, top, 7)
    expect(bindingHead2(sub, big)).toEqual(top)
    expect(readKeys(keys)).toEqual(keys)
    // nothing valid is larger, so a request one byte over holds a record that isn't valid
    const pad = 'x'.repeat(KEYS_BYTES + 1 - canonicalBytes(keys).length - ',"pad":""'.length)
    const over = { cr: { ...crMax, pad }, chain: resets }
    expect(canonicalBytes(over).length).toBe(KEYS_BYTES + 1)
    expect(bindingHead2(sub, { ...big, cr: over.cr })).toBeNull()
    expect(readKeys(over)).toBeNull()
    // a request whose records canonical JSON refuses is refused, not thrown
    expect(bindingHead2(sub, { ...fits, chain: [{ ...eight[0], at: 0.5 }] })).toBeNull()
    expect(bindingHead2(sub, { ...fits, chain: 'x' })).toBeNull()
  })

  test('torsion_sig (review n-k-server r1 m1): creation records, chain records and bind2 proofs, which the instance also verifies, verify as its verify_strict does, so an old phrase can no longer hand the user a record the instance refuses', () => {
    const body = { v: 1, x: 'y' }
    for (const tag of [TAG2.create, TAG2.chain, TAG2.bind]) {
      const msg = concat(utf8(tag), canonicalBytes(body))
      expect(
        torsionCases(V, msg).map(([name, pk, sig]) => [
          tag,
          name,
          verifyTaggedStrict(keyId(pk), tag, body, b64u(sig)),
        ])
      ).toEqual(STRICT_ANSWERS.map(([name, ok]) => [tag, name, ok]))
    }
    // honest signatures and their bit flips: the same answers as the cofactored check
    for (let i = 0; i < 64; i += 1) {
      const key = K(`flip ${i}`)
      const m = concat(utf8(TAG2.chain), canonicalBytes({ i }))
      const sig = ed25519.sign(m, key.sk)
      const bad = sig.slice()
      bad[i] ^= 1 << (i % 8)
      const strict = (s: Uint8Array) =>
        verifyTaggedStrict(keyId(key.pk), TAG2.chain, { i }, b64u(s))
      expect([i, strict(sig), strict(bad)]).toEqual([i, true, cofactored(key.pk, m, bad)])
    }

    // the probe: after the user's reset, a thief with the old phrase signs a sibling with R + T
    const rk = K('torsion rk')
    const rk2 = K('torsion rk2')
    const ik = K('torsion ik')
    const T0 = keyId(ik.pk)
    const cr = makeCreation(ik, rk, id('torsion pk0'), AT)
    const reset = makeReset(T0, rk, rk2, headOf(cr), id('torsion pk1'), [id('torsion d1')], AT + 1)
    const sibling = makeRecovery(T0, rk, headOf(cr), id('torsion pkT'), [id('torsion dT')], AT + 2)
    const { sig: _sig, ...rest } = sibling
    void _sig
    const thief = {
      ...rest,
      sig: b64u(withT(rk, concat(utf8(TAG2.chain), canonicalBytes(rest)))),
    }
    expect(readChain(cr, [reset, sibling]).verifies(sibling)).toBe(true)
    expect(verifyTagged(keyId(rk.pk), TAG2.chain, rest, thief.sig)).toBe(true)
    const view = readChain(cr, [reset, thief])
    expect([view.verifies(thief), view.has(recordId(thief)), view.heads]).toEqual([
      false,
      false,
      [headOf(reset)],
    ])
    const sub = 'vera@chat.example.org'
    const mine = bindingRequest2(K('torsion pk1'), sub, { cr, chain: [reset] }, headOf(reset), 9)
    expect(bindingHead2(sub, mine)).toEqual(headOf(reset))
    expect(bindingHead2(sub, { ...mine, chain: [reset, thief] })).toBeNull()
    const bound = bindingBody2(sub, T0, headOf(reset), 9)
    const proof = b64u(withT(K('torsion pk1'), concat(utf8(TAG2.bind), canonicalBytes(bound))))
    expect(verifyTagged(id('torsion pk1'), TAG2.bind, bound, proof)).toBe(true)
    expect(bindingHead2(sub, { ...mine, proof })).toBeNull()

    // the user's creation record re-signed with R + T by its own recovery key or identity key
    const { sig_ik: _ik, sig_rk: _rk, ...crBody } = cr
    void _ik
    void _rk
    const crMsg = concat(utf8(TAG2.create), canonicalBytes(crBody))
    const tRk = { ...cr, sig_rk: b64u(withT(rk, crMsg)) }
    const tIk = { ...cr, sig_ik: b64u(withT(ik, crMsg)) }
    expect([
      verifyTagged(keyId(rk.pk), TAG2.create, crBody, tRk.sig_rk),
      verifyTagged(T0, TAG2.create, crBody, tIk.sig_ik),
    ]).toEqual([true, true])
    expect([isCreation(cr), isCreation(tRk), isCreation(tIk)]).toEqual([true, false, false])
    expect([readKeys({ cr: tRk, chain: [reset] }), readKeys({ cr: tIk, chain: [] })]).toEqual([
      null,
      null,
    ])
    expect(bindingHead2(sub, { ...mine, cr: tRk })).toBeNull()
  })

  test('torsion_split (review n-k-server r2 I1): every other P2P signature verifies as 0.3.0 verifies it, so a replica of a rules-2 server admits an event and a device certificate signed with R + T as an older replica does', () => {
    const msg = utf8('rchat torsion')
    const cases = torsionCases(V, msg)
    expect(cases.map(([name, pk, sig]) => [name, cofactored(pk, msg, sig)])).toEqual(
      cases.map(([name]) => [name, true])
    )
    expect(cases.map(([name, pk, sig]) => [name, verify(pk, msg, sig)])).toEqual(
      cases.map(([name]) => [name, true])
    )
    const body = { v: 1, x: 'y' }
    for (const tag of [
      TAG.profile,
      TAG2.cert,
      TAG2.profile,
      TAG2.crevoke,
      TAG2.succ1,
      TAG2.succ2,
    ]) {
      const crafted = torsionCases(V, concat(utf8(tag), canonicalBytes(body)))
      expect(
        crafted.map(([name, pk, sig]) => [tag, name, verifyTagged(keyId(pk), tag, body, b64u(sig))])
      ).toEqual(crafted.map(([name]) => [tag, name, true]))
    }
    // a v2 certificate signed with R + T verifies, as every record the instance never reads
    const cert = signCertV2(p0, I, 0, id('torsion D'), AT, 'Browser')
    const { sig: _c, ...certBody } = cert
    void _c
    const tCert = {
      ...cert,
      sig: b64u(withT(p0, concat(utf8(TAG2.cert), canonicalBytes(certBody)))),
    }
    expect([verifyCertV2(cert), verifyCertV2(tCert), tCert.sig === cert.sig]).toEqual([
      true,
      true,
      false,
    ])
    expect(
      cases.filter(([name]) => name.startsWith('key A + T')).map(([, pk]) => isKeyId(keyId(pk)))
    ).toEqual([true, true])

    // the probe: a rules-2 server; N joins with a device certificate signed with R + T, M leaves
    // with its own leave signed with R + T, and the owner's next event cites it
    const w = ServerWorld.create('O', { rules: 2 })
    expect(w.sum.rules).toBe(2)
    w.join('O', 'M')
    const N = w.who('N')
    w.ok('O', 'add', { to: N.a })
    const join = w.post('N', 'join', p => ({
      idb: {
        ik: N.a,
        dcert: b64u(
          withT(
            N.ik,
            concat(
              utf8(TAG_DEVICE),
              utf8(w.srv),
              utf8('\0'),
              canonicalBytes({ ik: N.a, dk: N.dev, iprev: p.iprev ?? '' })
            )
          )
        ),
      },
    }))
    expect(join.out.s).toBe('A')
    const e = w.build('M', 'leave', {})
    const leave = {
      ...e.wire,
      sig: b64u(withT(w.who('M').dk, concat(utf8(TAG_SIG2), eventIdBytes2(e.wire.ev)))),
    }
    expect(w.receive(e.id, leave).s).toBe('A')
    const later = w.post('O', 'channel', {
      id: 'AAAAAAAAAAA',
      name: 'general',
      kind: 'text',
      pos: 0,
    })
    expect([later.wire.ev.ap?.includes(e.id), later.out.s]).toEqual([true, 'A'])
    // a second replica fed the same events in the same order admits every one
    const other = new ServerWorld()
    other.srv = w.srv
    other.room = new AclRoom(w.srv, {})
    const wires = [...w.wires]
    expect(wires.map(([eid, wire]) => [wire.ev.t, other.receive(eid, wire).s])).toEqual(
      wires.map(([, wire]) => [wire.ev.t, 'A'])
    )
    expect(Object.keys(other.sum.members ?? {}).sort()).toEqual(
      Object.keys(w.sum.members ?? {}).sort()
    )
  })

  test('assets/p2p_chain_vectors.json is what the generator writes', () => {
    const made = chainVectors()
    expect(JSON.parse(readFileSync(ASSET, 'utf8'))).toEqual(JSON.parse(JSON.stringify(made)))
    expect(made.cases.length).toBeGreaterThanOrEqual(30)
    expect(made.cases.filter(c => !c.expect.cr).length).toBe(6)
    expect(made.cases.filter(c => c.expect.frozen).length).toBe(2)
    expect(made.cases.filter(c => c.expect.refused.length).map(c => c.name)).toContain(
      'a ninth record is refused'
    )
    expect(made.bind2.filter(c => c.expect.ok).length).toBe(5)
    const refusedBind = made.bind2.filter(c => !c.expect.ok).map(c => c.name)
    expect(refusedBind).toContain('a chain of 9 records is refused')
    expect(refusedBind).toContain('a request over 7 KiB is refused')
    const size = (name: string) => {
      const c = made.bind2.find(b => b.name === name)!
      return canonicalBytes({ cr: c.cr, chain: c.chain }).length
    }
    expect(
      size('the largest valid chain: 8 resets that keep 8 devices each, every at at its largest')
    ).toBe(6913)
    expect(size('a request over 7 KiB is refused')).toBe(KEYS_BYTES + 1)
    const expected = (name: string) => made.cases.find(c => c.name === name)!.expect
    const torsion = expected('a signature whose R has a small-order part is refused')
    expect([torsion.refused, torsion.dead]).toEqual([[1], []])
    const key = expected('a key with a torsion part: what holds without the cofactor counts')
    expect([key.refused, key.heads.length]).toEqual([[2], 1])
    expect(
      expected(
        'a creation record whose recovery key signature has an R with a small-order part is refused'
      ).cr
    ).toBe(false)
    expect(refusedBind).toContain('a proof whose R has a small-order part is refused')
    expect(new Set(made.bind2.map(c => c.name)).size).toBe(made.bind2.length)
    expect(new Set(made.cases.map(c => c.name)).size).toBe(made.cases.length)
  })
})
