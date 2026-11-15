// Writes assets/p2p_chain_vectors.json from p2p/chain.ts with fixed test keys, for the instance
// to check its own chain and badge code against. Run with
// `bun apps/web/scripts/p2p_chain_vectors.ts` and commit the result.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ed25519, ED25519_TORSION_SUBGROUP } from '@noble/curves/ed25519.js'
import { bytesToNumberLE, numberToBytesLE } from '@noble/curves/utils.js'
import { sha256, sha512 } from '@noble/hashes/sha2.js'
import { format, resolveConfig } from 'prettier'
import { b64u, canonicalBytes, concat, utf8 } from '../app/lib/p2p/canonical'
import {
  bindingBody2,
  bindingHead2,
  bindingRequest2,
  CHAIN_MAX,
  headOf,
  isChainRecord,
  isCreation,
  KEYS_BYTES,
  makeCreation,
  makeRecovery,
  makeRemoval,
  makeReset,
  readChain,
  recordId,
  TAG2,
  type ChainRecord,
  type CreationRecord,
  type Head,
} from '../app/lib/p2p/chain'
import { keyId, publicOf, signTagged, TAG, type KeyPair } from '../app/lib/p2p/keys'

const OUT = fileURLToPath(new URL('../../../assets/p2p_chain_vectors.json', import.meta.url))

export const vectorKey = (name: string): KeyPair => {
  const sk = sha256(utf8(`rchat-p2p-chain-vector ${name}`))
  return { sk, pk: publicOf(sk) }
}

const id = (name: string) => keyId(vectorKey(name).pk)

// Signatures only the key's holder can make, with T a point of order 8: R = rB + jT under the
// key A, or under A + T, a key with a torsion part that is still a valid key id. The first j and
// nonce that `want` takes win, so the file is the same every time.
const { Point } = ed25519
const T8 = Point.fromHex(ED25519_TORSION_SUBGROUP[1])
const scalarOf = (...parts: Uint8Array[]) =>
  Point.Fn.create(bytesToNumberLE(sha512(concat(...parts))))
const torsionKey = (name: string) => {
  const { scalar } = ed25519.utils.getExtendedPublicKey(vectorKey(name).sk)
  return Point.BASE.multiply(scalar).add(T8).toBytes()
}
const crafted = (
  name: string,
  tag: string,
  body: unknown,
  torsion: boolean,
  want: (j: number, k: number) => boolean
) => {
  const { scalar: a, prefix, pointBytes } = ed25519.utils.getExtendedPublicKey(vectorKey(name).sk)
  const pk = torsion ? torsionKey(name) : pointBytes
  const msg = concat(utf8(tag), canonicalBytes(body))
  for (let c = 0; ; c += 1) {
    const r = scalarOf(prefix, msg, Uint8Array.of(c))
    for (let j = 0; j < 8; j += 1) {
      const R = Point.BASE.multiply(r)
        .add(T8.multiplyUnsafe(BigInt(j)))
        .toBytes()
      const k = scalarOf(R, pk, msg)
      if (want(j, Number(k % BigInt(8))))
        return b64u(concat(R, numberToBytesLE((r + k * a) % Point.Fn.ORDER, 32)))
    }
  }
}
// R + T beside an honest R: a cofactored check accepts it, verify_strict refuses it.
const withT = (name: string, tag: string, body: unknown) =>
  crafted(name, tag, body, false, j => j === 1)

const AT = 1_762_400_000_000
const SUB = 'vera@chat.example.org'
const TS = 1_762_400_000

interface Expect {
  cr: boolean
  heads: Head[]
  primary: string[]
  in_force: string[]
  frozen: boolean
  refused: number[]
  dead: number[]
}

export interface ChainCase {
  name: string
  cr: unknown
  chain: unknown[]
  expect: Expect
}

export interface BindCase {
  name: string
  sub: string
  ik: string
  ts: number
  proof: string
  cr: unknown
  chain: unknown[]
  expect: { ok: boolean; head?: Head }
}

const expectOf = (cr: unknown, chain: unknown[]): Expect => {
  if (!isCreation(cr))
    return { cr: false, heads: [], primary: [], in_force: [], frozen: false, refused: [], dead: [] }
  const good = chain.filter((r): r is ChainRecord => isChainRecord(r))
  const view = readChain(cr, good)
  const at = (ok: (r: unknown) => boolean) => chain.flatMap((r, i) => (ok(r) ? [i] : []))
  return {
    cr: true,
    heads: view.heads,
    primary: view.heads.map(h => view.primary(h)),
    in_force: view.heads.map(h => view.inForce(h)),
    frozen: view.frozen,
    refused: at(r => !isChainRecord(r) || !view.verifies(r)),
    dead: at(r => isChainRecord(r) && view.verifies(r) && view.dead(recordId(r))),
  }
}

export const chainVectors = () => {
  const ik = vectorKey('ik')
  const rk = vectorKey('rk')
  const rk2 = vectorKey('rk2')
  const thief = vectorKey('thief rk')
  const I = keyId(ik.pk)
  const cr = makeCreation(ik, rk, id('pk0'), AT)
  const h0 = headOf(cr)
  const r1 = makeRecovery(I, rk, h0, id('pk1'), [id('d2')], AT + 1)
  const reset2 = makeReset(I, rk, rk2, headOf(r1), id('pk2'), [id('d2')], AT + 2)
  const reset1 = makeReset(I, rk, rk2, h0, id('pk1r'), [id('d2'), id('d3')], AT + 1)
  const removal1 = makeRemoval(I, rk, h0, id('pkx'), [id('d2')], AT + 1)
  const ra = makeRecovery(I, rk, h0, id('pka'), [id('da')], AT + 1)
  const rb = makeRecovery(I, rk, h0, id('pkb'), [id('db')], AT + 1)
  const rival = makeReset(I, rk, thief, h0, id('pkz'), [id('z1')], AT + 1)
  const other = vectorKey('other ik')
  const otherCr = makeCreation(other, vectorKey('other rk'), id('other pk'), AT)
  const full: ChainRecord[] = []
  for (let n = 1, prev = h0; n <= CHAIN_MAX + 1; n += 1) {
    const keep = Array.from({ length: 8 }, (_, i) => id(`dev ${n}.${i}`))
    const body = {
      v: 1 as const,
      ik: I,
      n,
      prev: prev.d,
      pk: id(`pk${n}`),
      keep: keep.sort(),
      at: AT,
    }
    const r = { ...body, sig: signTagged(rk.sk, TAG2.chain, body) }
    full.push(r)
    prev = headOf(r)
  }
  const underTag = (tag: string) => {
    const { sig, ...body } = r1
    void sig
    return { ...body, sig: signTagged(rk.sk, tag, body) }
  }
  const crBody = ({ sig_ik, sig_rk, ...body }: CreationRecord) => {
    void sig_ik
    void sig_rk
    return body
  }
  const noSigRk = Object.fromEntries(Object.entries(cr).filter(([k]) => k !== 'sig_rk'))
  const pkIsIk = (() => {
    const body = { ...crBody(cr), pk: I }
    return {
      ...body,
      sig_ik: signTagged(ik.sk, TAG2.create, body),
      sig_rk: signTagged(rk.sk, TAG2.create, body),
    }
  })()
  const { sig_next, ...resetNoNext } = reset1
  const forged = { ...r1, sig: makeRecovery(I, thief, h0, id('pk1'), [id('d2')], AT + 1).sig }
  // After the user's reset, a thief with the old phrase signs a sibling with R + T (review
  // n-k-server r1 m1).
  const torsioned = (() => {
    const { sig, ...body } = makeRecovery(I, rk, h0, id('pkT'), [id('dT')], AT + 1)
    void sig
    return { ...body, sig: withT('rk', TAG2.chain, body) }
  })()
  // A removal names a key with a torsion part; of two records it signs, the one whose equation
  // holds without the cofactor counts, R torsion part and all, and the honest one doesn't.
  const removalT = makeRemoval(I, rk, h0, keyId(torsionKey('pkt')), [id('d2')], AT + 1)
  const underT = (pk: string, want: (j: number, k: number) => boolean) => {
    const body = { v: 1, ik: I, n: 2, prev: headOf(removalT).d, pk, keep: [], at: AT + 2 }
    return { ...body, sig: crafted('pkt', TAG2.chain, body, true, want) }
  }
  const exactT = underT(id('pke'), (j, k) => j !== 0 && (j + k) % 8 === 0)
  const plainT = underT(id('pkp'), (j, k) => j === 0 && k !== 0)
  const cases: [string, unknown, unknown[]][] = [
    ['a creation record', cr, []],
    ['a recovery', cr, [r1]],
    ['a recovery and a reset', cr, [r1, reset2]],
    ['records in any order', cr, [reset2, r1]],
    ['a removal: its primary plays recovery', cr, [removal1]],
    [
      'a record after a removal is signed by its primary',
      cr,
      [removal1, makeRecovery(I, vectorKey('pkx'), headOf(removal1), id('pk2'), [], AT + 2)],
    ],
    [
      'a record after a removal signed by the old recovery key is refused',
      cr,
      [removal1, makeRecovery(I, rk, headOf(removal1), id('pk2'), [], AT + 2)],
    ],
    [
      'a record signed by the old recovery key after a reset is refused',
      cr,
      [reset1, makeRecovery(I, rk, headOf(reset1), id('pk2'), [], AT + 2)],
    ],
    [
      'a record after a reset is signed by the next key',
      cr,
      [reset1, makeRecovery(I, rk2, headOf(reset1), id('pk2'), [], AT + 2)],
    ],
    [
      'a prev that does not match is refused',
      cr,
      [makeRecovery(I, rk, { n: 0, d: recordId(otherCr) }, id('pk1'), [], AT + 1)],
    ],
    [
      'an n that does not follow is refused',
      cr,
      [makeRecovery(I, rk, { n: 1, d: h0.d }, id('pk1'), [], AT + 1)],
    ],
    ['a record with an unknown field is refused', cr, [{ ...r1, note: 1 }]],
    [
      'a record signed by another key is refused',
      cr,
      [makeRecovery(I, thief, h0, id('pk1'), [], AT)],
    ],
    ['a record signed under another tag is refused', cr, [underTag(TAG2.create)]],
    [
      "another identity's record is refused",
      cr,
      [makeRecovery(id('other ik'), rk, h0, id('pk1'), [], AT)],
    ],
    ['a reset without the next key signature is refused', cr, [resetNoNext]],
    [
      'a reset whose next key signature is by another key is refused',
      cr,
      [{ ...reset1, sig_next: rival.sig_next }],
    ],
    ['a recovery with a next key signature is refused', cr, [{ ...r1, sig_next }]],
    ['a copy with a bad signature after the record is refused alone', cr, [r1, forged]],
    ['a copy with a bad signature before the record is refused alone', cr, [forged, r1]],
    ['a signature whose R has a small-order part is refused', cr, [reset1, torsioned]],
    [
      'a key with a torsion part: what holds without the cofactor counts',
      cr,
      [removalT, exactT, plainT],
    ],
    ['two recoveries with the same n both count', cr, [ra, rb]],
    [
      'a record after two recoveries with the same n may cite either',
      cr,
      [ra, rb, makeRecovery(I, rk, headOf(rb), id('pk2'), [id('da'), id('db')], AT + 2)],
    ],
    ['a reset kills another record signed by its key', cr, [r1, reset1]],
    ['rival resets freeze the identity', cr, [reset1, rival]],
    ['rival reset and removal freeze the identity', cr, [removal1, rival]],
    ['a chain at its cap', cr, full.slice(0, CHAIN_MAX)],
    ['a ninth record is refused', cr, full],
    ['a creation record without the recovery key signature', noSigRk, []],
    ['a creation record with an unknown field', { ...cr, note: 1 }, []],
    ['a creation record naming the identity key as its primary', pkIsIk, []],
    [
      'a creation record signed under the chain tag',
      (() => {
        const body = crBody(cr)
        return {
          ...body,
          sig_ik: signTagged(ik.sk, TAG2.chain, body),
          sig_rk: signTagged(rk.sk, TAG2.chain, body),
        }
      })(),
      [],
    ],
    [
      'a creation record whose signatures are swapped',
      { ...cr, sig_ik: cr.sig_rk, sig_rk: cr.sig_ik },
      [],
    ],
    [
      'a creation record whose recovery key signature has an R with a small-order part is refused',
      { ...cr, sig_rk: withT('rk', TAG2.create, crBody(cr)) },
      [],
    ],
  ]
  const chainCases: ChainCase[] = cases.map(([name, c, chain]) => ({
    name,
    cr: c,
    chain,
    expect: expectOf(c, chain),
  }))

  const bind = (
    name: string,
    signer: KeyPair,
    chain: ChainRecord[],
    head: Head,
    change: (r: Record<string, unknown>) => Record<string, unknown> = r => r
  ): BindCase => {
    const req = change({ ...bindingRequest2(signer, SUB, { cr, chain }, head, TS) })
    const found = bindingHead2(SUB, req)
    return {
      name,
      sub: SUB,
      ...(req as { ik: string; ts: number; proof: string; cr: unknown; chain: unknown[] }),
      expect: found ? { ok: true, head: found } : { ok: false },
    }
  }
  const pk0 = vectorKey('pk0')
  const pk1 = vectorKey('pk1')
  // Valid records past the bounds of a request: 9 recoveries beside each other. The largest
  // valid {cr, chain} is 8 resets that keep 8 devices each, every at at its largest (6,913
  // bytes), so a request over 7 KiB holds a record that isn't valid: here a padded creation
  // record, one byte over.
  const siblings = Array.from({ length: CHAIN_MAX + 1 }, (_, i) =>
    makeRecovery(I, rk, h0, id(`sib${i}`), [id('d2')], AT + 1)
  )
  const crMax = makeCreation(ik, rk, id('pk0'), Number.MAX_SAFE_INTEGER)
  const resets: ChainRecord[] = []
  for (let n = 1, prev = headOf(crMax), by = rk; n <= CHAIN_MAX; n += 1) {
    const next = vectorKey(`reset rk${n}`)
    const keep = Array.from({ length: 8 }, (_, i) => id(`reset dev ${n}.${i}`))
    const r = makeReset(I, by, next, prev, id(`rpk${n}`), keep, Number.MAX_SAFE_INTEGER)
    resets.push(r)
    prev = headOf(r)
    by = next
  }
  const pad = 'x'.repeat(
    KEYS_BYTES + 1 - canonicalBytes({ cr: crMax, chain: resets }).length - ',"pad":""'.length
  )
  const bind2: BindCase[] = [
    bind('the creation record only: head 0', pk0, [], h0),
    bind('a chain: the head primary signs', pk1, [r1], headOf(r1)),
    bind('an older primary while the chain holds a later record is refused', pk0, [r1], h0),
    bind('the head primary naming an older head is refused', pk1, [r1], h0),
    bind('a proof for another account is refused', pk1, [r1], headOf(r1), r => ({
      ...r,
      proof: signTagged(
        pk1.sk,
        TAG2.bind,
        bindingBody2('mallory@chat.example.org', I, headOf(r1), TS)
      ),
    })),
    bind('a proof for another time is refused', pk1, [r1], headOf(r1), r => ({ ...r, ts: TS + 1 })),
    bind('a proof under the v1 tag is refused', pk1, [r1], headOf(r1), r => ({
      ...r,
      proof: signTagged(pk1.sk, TAG.bind, bindingBody2(SUB, I, headOf(r1), TS)),
    })),
    bind('a proof by the recovery key is refused', rk, [r1], headOf(r1)),
    bind('a chain record that does not attach is refused', pk0, [reset2], h0),
    bind('rival resets are refused', pk0, [reset1, rival], h0),
    bind('a copy with a bad signature beside the record is refused', pk1, [r1], headOf(r1), r => ({
      ...r,
      chain: [r1, forged],
    })),
    bind('a proof whose R has a small-order part is refused', pk1, [r1], headOf(r1), r => ({
      ...r,
      proof: withT('pk1', TAG2.bind, bindingBody2(SUB, I, headOf(r1), TS)),
    })),
    bind('either head of two recoveries with the same n', vectorKey('pkb'), [ra, rb], headOf(rb)),
    bind(
      'a full chain of 8 records that keep 8 devices each',
      vectorKey(`pk${CHAIN_MAX}`),
      full.slice(0, CHAIN_MAX),
      headOf(full[CHAIN_MAX - 1])
    ),
    bind('a chain of 9 records is refused', vectorKey('sib0'), siblings, headOf(siblings[0])),
    bind(
      'the largest valid chain: 8 resets that keep 8 devices each, every at at its largest',
      vectorKey(`rpk${CHAIN_MAX}`),
      resets,
      headOf(resets[CHAIN_MAX - 1]),
      r => ({ ...r, cr: crMax })
    ),
    bind(
      'a request over 7 KiB is refused',
      vectorKey(`rpk${CHAIN_MAX}`),
      resets,
      headOf(resets[CHAIN_MAX - 1]),
      r => ({ ...r, cr: { ...crMax, pad } })
    ),
  ]
  return { v: 1, cases: chainCases, bind2 }
}

if (import.meta.main) {
  const config = await resolveConfig(OUT)
  writeFileSync(OUT, await format(JSON.stringify(chainVectors()), { ...config, parser: 'json' }))
}
