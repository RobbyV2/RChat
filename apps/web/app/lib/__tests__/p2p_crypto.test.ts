import { describe, expect, test } from 'bun:test'
import { deflateRawSync } from 'node:zlib'
import { b64u, canonical, fromB64u, parseCanonical, utf8 } from '../p2p/canonical'
import { inflateRaw, storeRaw } from '../p2p/inflate'
import {
  base32,
  baseId,
  cleanName,
  fingerprint,
  isKeyId,
  keyId,
  newKeyPair,
  peerId,
  peerIds,
  publicOf,
  signCert,
  signProfile,
  signRevocation,
  signSuccession,
  TAG,
  verify,
  verifyCert,
  verifyProfile,
  verifyRevocation,
  verifySuccession,
  verifyTagged,
  type KeyPair,
} from '../p2p/keys'
import { BAD_CARD, CARD_MAX, decodeCard, encodeCard, makeCard, PREFIX } from '../p2p/card'
import {
  checkVerifyCode,
  parseVerifyCode,
  safetyDigits,
  safetyGroups,
  verifyCode,
} from '../p2p/safety'

const throws = (fn: () => unknown) => {
  try {
    fn()
    return false
  } catch (e) {
    return e instanceof Error
  }
}

const rejects = async (p: Promise<unknown>) => {
  try {
    await p
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

// Deterministic keys for fixed vectors.
const seeded = (n: number): KeyPair => {
  const sk = new Uint8Array(32).fill(n)
  return { sk, pk: publicOf(sk) }
}

describe('canonical JSON', () => {
  test('fixed vectors', () => {
    expect(canonical({ b: 1, a: [true, null, 'x'], c: { z: -5, y: '' } })).toBe(
      '{"a":[true,null,"x"],"b":1,"c":{"y":"","z":-5}}'
    )
    expect(canonical('é\n"\\\u0001')).toBe('"é\\n\\"\\\\\\u0001"')
    expect(canonical({ é: 1, e: 2, Z: 3 })).toBe('{"Z":3,"e":2,"é":1}')
    // UTF-16 code unit order (RFC 8785): a surrogate pair (U+1F600) sorts before U+FF61.
    expect(canonical({ '｡': 2, '😀': 1 })).toBe('{"😀":1,"｡":2}')
    expect(canonical(9007199254740991)).toBe('9007199254740991')
    expect(canonical([])).toBe('[]')
    expect(canonical({})).toBe('{}')
  })

  test('refuses what has no single encoding', () => {
    expect(throws(() => canonical(1.5))).toBe(true)
    expect(throws(() => canonical(-0))).toBe(true)
    expect(throws(() => canonical(2 ** 53))).toBe(true)
    expect(throws(() => canonical(NaN))).toBe(true)
    expect(throws(() => canonical({ a: undefined }))).toBe(true)
    expect(throws(() => canonical('é'))).toBe(true)
    expect(throws(() => canonical({ é: 1 }))).toBe(true)
    expect(throws(() => canonical('\ud800'))).toBe(true)
    expect(throws(() => canonical(new Date(0)))).toBe(true)
    expect(throws(() => canonical(BigInt(1) as unknown))).toBe(true)
  })

  test('parse accepts only canonical text', () => {
    expect(parseCanonical('{"a":1,"b":[2]}')).toEqual({ a: 1, b: [2] })
    for (const bad of [
      '{"b":1,"a":2}',
      '{"a":1,"a":2}',
      '{ "a":1}',
      '1.0',
      '{"a":1e3}',
      '"\\u00e9"',
    ])
      expect(throws(() => parseCanonical(bad))).toBe(true)
    expect(throws(() => parseCanonical('nope'))).toBe(true)
  })

  test('base64url is strict', () => {
    const b = new Uint8Array([0, 255, 250, 1])
    expect(b64u(b)).toBe('AP_6AQ')
    expect([...fromB64u('AP_6AQ')]).toEqual([...b])
    for (const bad of ['AP_6AQ==', 'AP+6AQ', 'AP_6AR', 'A', 'AP 6AQ'])
      expect(throws(() => fromB64u(bad))).toBe(true)
  })
})

describe('keys and signatures', () => {
  const ik = newKeyPair()
  const dk = newKeyPair()

  test('cert round trip and tampering with each field', () => {
    const cert = signCert(ik, dk.pk, 1000, 'Firefox on Linux')
    expect(verifyCert(cert)).toBe(true)
    expect(verifyCert(cert, keyId(ik.pk))).toBe(true)
    expect(verifyCert(cert, keyId(dk.pk))).toBe(false)
    const other = keyId(newKeyPair().pk)
    for (const bad of [
      { ...cert, v: 2 },
      { ...cert, ik: other },
      { ...cert, dk: other },
      { ...cert, created: 1001 },
      { ...cert, label: 'Chrome' },
      { ...cert, sig: cert.sig.replace(/^./, c => (c === 'A' ? 'B' : 'A')) },
      { ...cert, extra: 1 },
    ])
      expect(verifyCert(bad)).toBe(false)
    const { sig: _sig, ...unsigned } = cert
    void _sig
    expect(verifyCert(unsigned)).toBe(false)
  })

  test('revocation, profile and succession', () => {
    const rev = signRevocation(ik, keyId(dk.pk), 5, keyId(newKeyPair().pk))
    expect(verifyRevocation(rev, keyId(ik.pk))).toBe(true)
    for (const bad of [
      { ...rev, revoked_at: 6 },
      { ...rev, dk: keyId(ik.pk) },
      { ...rev, successor: keyId(dk.pk) },
    ])
      expect(verifyRevocation(bad)).toBe(false)
    const { successor: _s, ...noSuccessor } = rev
    void _s
    expect(verifyRevocation(noSuccessor)).toBe(false)

    const profile = signProfile(ik, '  Alice \u0007 ', 10, '#ff0000')
    expect(profile.name).toBe('Alice')
    expect(verifyProfile(profile, keyId(ik.pk))).toBe(true)
    for (const bad of [
      { ...profile, name: 'Mallory' },
      { ...profile, color: '#00ff00' },
      { ...profile, updated: 11 },
      { ...profile, ik: keyId(dk.pk) },
    ])
      expect(verifyProfile(bad)).toBe(false)
    expect(verifyProfile({ ...signProfile(ik, 'x'.repeat(40), 1), name: 'x'.repeat(40) })).toBe(
      false
    )
    expect(cleanName('x'.repeat(40))).toHaveLength(32)

    const next = newKeyPair()
    const succ = signSuccession(ik, next, 99)
    expect(verifySuccession(succ)).toBe(true)
    expect(verifySuccession({ ...succ, new: keyId(dk.pk) })).toBe(false)
    expect(verifySuccession({ ...succ, sig_new: succ.sig_old })).toBe(false)
    expect(verifySuccession({ ...succ, at: 100 })).toBe(false)
  })

  test('small-order keys and non-canonical signatures are refused', () => {
    // The identity point with R = identity, S = 0 "verifies" any message under ZIP-215.
    const weak = new Uint8Array(32)
    weak[0] = 1
    const sig = new Uint8Array(64)
    sig[0] = 1
    expect(isKeyId(b64u(weak))).toBe(false)
    expect(verify(weak, utf8('anything'), sig)).toBe(false)
    expect(verifyTagged(b64u(weak), TAG.profile, { v: 1 }, b64u(sig))).toBe(false)
    const ik = newKeyPair()
    const cert = signCert(ik, newKeyPair().pk, 1, 'x')
    expect(verifyCert(cert)).toBe(true)
    expect(verifyCert({ ...cert, ik: b64u(weak), sig: b64u(sig) })).toBe(false)
  })

  test('a signature for one record kind never verifies as another', () => {
    const cert = signCert(ik, dk.pk, 1, '')
    const asProfile = { v: 1, ik: cert.ik, name: 'x', updated: 1, sig: cert.sig }
    expect(verifyProfile(asProfile)).toBe(false)
  })

  test('peer ids', () => {
    expect(base32(new Uint8Array([0xff, 0x00]))).toBe('74aa')
    expect(base32(utf8('foobar'))).toBe('mzxw6ytboi')
    const key = seeded(7)
    const id = peerId(key.pk)
    expect(id).toBe(peerId(keyId(key.pk)))
    expect(/^rcp-[a-z2-7]{26}$/.test(id)).toBe(true)
    expect(peerIds(keyId(key.pk))).toEqual([id, `${id}-1`, `${id}-2`, `${id}-3`])
    expect(baseId(`${id}-2`)).toBe(id)
    expect(baseId(id)).toBe(id)
    expect(fingerprint(keyId(key.pk)).split(' ')).toHaveLength(10)
  })
})

describe('inflate', () => {
  test('matches zlib for random and repetitive input', () => {
    let seed = 42
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff
    for (const size of [0, 1, 100, 5000, 70000]) {
      const random = new Uint8Array(size).map(() => rnd())
      const text = utf8('abcabcabd'.repeat(Math.ceil(size / 9))).subarray(0, size)
      for (const data of [random, text]) {
        const z = new Uint8Array(deflateRawSync(data))
        expect([...inflateRaw(z, size + 1)]).toEqual([...data])
        expect([...inflateRaw(storeRaw(data), size + 1)]).toEqual([...data])
      }
    }
  })

  test('refuses corrupt or oversized input', () => {
    const z = new Uint8Array(deflateRawSync(utf8('a'.repeat(10000))))
    expect(throws(() => inflateRaw(z, 100))).toBe(true)
    expect(throws(() => inflateRaw(z.subarray(0, z.length - 2), 20000))).toBe(true)
    expect(throws(() => inflateRaw(new Uint8Array([0xff, 0xff, 0xff]), 100))).toBe(true)
  })
})

describe('contact cards', () => {
  const ik = newKeyPair()
  const dk = newKeyPair()
  const cert = signCert(ik, dk.pk, 1, 'Browser')

  test('round trip', async () => {
    const card = makeCard(ik, [cert], 'Alice', 'chat.example.com')
    const text = await encodeCard(card)
    expect(text.startsWith(PREFIX)).toBe(true)
    expect(text.length < 400).toBe(true)
    expect(await decodeCard(`  ${text}\n`)).toEqual(card)
  })

  test('size cap, unsigned extras and corrupted input', async () => {
    const big = makeCard(ik, [cert], 'A', 'h'.repeat(253))
    expect((await encodeCard(big)).length <= CARD_MAX).toBe(true)
    const many = makeCard(
      ik,
      Array.from({ length: 4 }, (_, i) => signCert(ik, newKeyPair().pk, i, 'x'.repeat(64))),
      'A',
      'h'.repeat(253)
    )
    const more = Array.from({ length: 12 }, (_, i) =>
      signCert(ik, newKeyPair().pk, i, 'y'.repeat(64))
    )
    expect(await rejects(encodeCard({ ...many, certs: [...many.certs, ...more] }))).toBe(
      'Contact card is too large'
    )
    const card = makeCard(ik, [cert], 'Alice', 'host')
    const text = await encodeCard(card)
    // Fields a newer version adds are dropped, not refused (forward compatibility), and never
    // kept: unsigned, they could never be enforced.
    expect(await decodeCard(await encodeCard({ ...card, exp: 5000 } as typeof card))).toEqual(card)
    expect(await rejects(decodeCard(text.slice(0, -3)))).toBe(BAD_CARD)
    expect(await rejects(decodeCard(text.replace(PREFIX, 'rcp2.')))).toBe(BAD_CARD)
    expect(await rejects(decodeCard(`${PREFIX}${'A'.repeat(3000)}`))).toBe(BAD_CARD)
    expect(await rejects(decodeCard(await encodeCard({ ...card, name: 5 } as never)))).toBe(
      BAD_CARD
    )
    const otherCert = signCert(newKeyPair(), dk.pk, 1, '')
    expect(await rejects(decodeCard(await encodeCard({ ...card, certs: [otherCert] })))).toBe(
      BAD_CARD
    )
  })
})

describe('safety numbers', () => {
  const a = keyId(seeded(1).pk)
  const b = keyId(seeded(2).pk)

  test('symmetric, 60 digits in 12 groups', () => {
    expect(safetyDigits(a, b)).toBe(safetyDigits(b, a))
    expect(/^\d{60}$/.test(safetyDigits(a, b))).toBe(true)
    expect(safetyGroups(a, b)).toHaveLength(12)
    expect(safetyDigits(a, b) === safetyDigits(a, keyId(seeded(3).pk))).toBe(false)
  })

  test('fixed vector', () => {
    expect(a).toBe('iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w')
    expect(safetyGroups(a, b).join(' ')).toBe(FIXED)
  })

  test('verification codes', () => {
    const nonce = new Uint8Array(16).fill(9)
    const code = verifyCode(a, b, nonce)
    expect(parseVerifyCode(code)).toEqual({ a, b, n: b64u(nonce) })
    expect(checkVerifyCode(code, b, a)).toBe('ok')
    expect(checkVerifyCode(code, b, keyId(seeded(3).pk))).toBe('not_them')
    expect(checkVerifyCode(code, keyId(seeded(3).pk), a)).toBe('not_me')
    expect(checkVerifyCode('rcv1.zzz', b, a)).toBe('bad')
    expect(checkVerifyCode(code.slice(0, -2), b, a)).toBe('bad')
  })
})

const FIXED = '42242 63039 46464 23105 13343 98447 69758 83113 15321 20993 37219 33664'

describe('contact card QR', () => {
  test('a typical card fits a mid-size QR and decodes back', async () => {
    const { encode } = await import('uqr')
    const { default: jsQR } = await import('jsqr')
    const ik = newKeyPair()
    const card = makeCard(
      ik,
      [signCert(ik, newKeyPair().pk, 1, 'Browser')],
      'Alice',
      'chat.example.com'
    )
    const text = await encodeCard(card)
    const qr = encode(text, { ecc: 'M', border: 4 })
    expect(qr.version <= 14).toBe(true)
    const scale = 4
    const side = qr.size * scale
    const px = new Uint8ClampedArray(side * side * 4)
    for (let y = 0; y < side; y += 1)
      for (let x = 0; x < side; x += 1) {
        const v = qr.data[Math.floor(y / scale)][Math.floor(x / scale)] ? 0 : 255
        px.set([v, v, v, 255], (y * side + x) * 4)
      }
    expect(jsQR(px, side, side)?.data).toBe(text)
  })
})
