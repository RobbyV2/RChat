import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { isRecord } from '../bytes'
import {
  b64u,
  bytesOf,
  canonicalBytes,
  concat,
  fromB64u,
  parseCanonicalBytes,
  randomBytes,
  utf8,
} from './canonical'
import { gcmOpen, gcmSeal, nonceOf } from './frames'
import { baseId, keyBytes, peerId, sign, verify, verifyCert, type Cert, type KeyPair } from './keys'

// SIGMA-I over the PeerJS data channel (note section 4). The signaling server relays the SDP and
// could sit in the middle of DTLS, so confidentiality never relies on DTLS: both sides prove
// possession of their device key over a transcript bound to both peer ids, and the initiator's
// identity travels encrypted, so an active prober learns nothing about who dialed.
//
//   I -> R  H1 {v, e_i, n_i, purpose}
//   R -> I  H2 {e_r, n_r, box: AES-GCM(k_hs, 0, {certR, sigR})}
//           sigR = Ed25519(dk_r, "rchat-p2p-auth1\0R" || T1 || peerId_i || peerId_r)
//   I -> R  H3 {box: AES-GCM(k_hs, 1, {certI, sigI})}, sigI = Ed25519(dk_i, "...\0I" || T2)
//
//   T1 = SHA-256(H1 || e_r || n_r), T2 = SHA-256(T1 || H2), k_hs = HKDF(ss, T1, "rchat-p2p hs1")
//   traffic keys = HKDF(ss, SHA-256(T2 || H3), "rchat-p2p tx1") -> k_i2r || k_r2i

export type Purpose = 'peer' | 'rekey'

export interface Me {
  dk: KeyPair
  cert: Cert
  // The peer id we are registered under, suffix included.
  peer: string
}

export interface Remote {
  cert: Cert
  ik: string
  dk: string
}

export interface Keys {
  send: Uint8Array
  recv: Uint8Array
  bulkSend: Uint8Array
  bulkRecv: Uint8Array
}

export interface Established {
  remote: Remote
  keys: Keys
}

export class HandshakeError extends Error {}

const fail = (why: string): never => {
  throw new HandshakeError(why)
}

const NONCE_LEN = 16
const HS_MAX = 4096
const AUTH = 'rchat-p2p-auth1\0'
const enc = (s: string) => utf8(s)

const parse = (bytes: Uint8Array, keys: string[]) => {
  if (bytes.length > HS_MAX) fail('handshake too large')
  let v: unknown
  try {
    v = parseCanonicalBytes(bytes)
  } catch {
    return fail('malformed handshake')
  }
  if (!isRecord(v) || Object.keys(v).length !== keys.length || !keys.every(k => k in v))
    fail('malformed handshake')
  return v as Record<string, unknown>
}

const shared = (sk: Uint8Array, pk: Uint8Array) => {
  try {
    return x25519.getSharedSecret(sk, pk)
  } catch {
    return fail('bad ephemeral key')
  }
}

const hsKey = (ss: Uint8Array, t1: Uint8Array) => hkdf(sha256, ss, t1, enc('rchat-p2p hs1'), 32)

const traffic = (ss: Uint8Array, t2: Uint8Array, h3: Uint8Array, initiator: boolean): Keys => {
  const salt = sha256(concat(t2, h3))
  const tx = hkdf(sha256, ss, salt, enc('rchat-p2p tx1'), 64)
  const bulk = hkdf(sha256, ss, salt, enc('rchat-p2p bulk1'), 64)
  const [i2r, r2i] = [tx.slice(0, 32), tx.slice(32)]
  const [bi2r, br2i] = [bulk.slice(0, 32), bulk.slice(32)]
  return initiator
    ? { send: i2r, recv: r2i, bulkSend: bi2r, bulkRecv: br2i }
    : { send: r2i, recv: i2r, bulkSend: br2i, bulkRecv: bi2r }
}

const authBox = async (key: Uint8Array, counter: number, cert: Cert, sig: Uint8Array) =>
  gcmSeal(key, nonceOf(counter), canonicalBytes({ cert, sig: b64u(sig) }))

const openAuth = async (key: Uint8Array, counter: number, box: unknown) => {
  let raw: Uint8Array
  try {
    raw = await gcmOpen(key, nonceOf(counter), b64Bytes(box))
  } catch {
    return fail('handshake did not decrypt')
  }
  const v = parse(raw, ['cert', 'sig'])
  if (!verifyCert(v.cert)) fail('bad certificate')
  const sig = bytesOf(v.sig, 64)
  if (!sig) fail('bad signature')
  return { cert: v.cert as Cert, sig: sig as Uint8Array }
}

const b64Bytes = (x: unknown): Uint8Array => {
  if (typeof x !== 'string' || x.length > HS_MAX) return fail('malformed handshake')
  try {
    return fromB64u(x)
  } catch {
    return fail('malformed handshake')
  }
}

const wipe = (...bs: Uint8Array[]) => bs.forEach(b => b.fill(0))

export class Initiator {
  private e = x25519.keygen()
  private n = randomBytes(NONCE_LEN)
  private h1Bytes: Uint8Array | null = null
  private done = false

  constructor(
    private me: Me,
    // The peer id we dialed.
    private dialed: string,
    private purpose: Purpose = 'peer'
  ) {}

  h1(): Uint8Array {
    this.h1Bytes = canonicalBytes({
      v: 1,
      e: b64u(this.e.publicKey),
      n: b64u(this.n),
      purpose: this.purpose,
    })
    return this.h1Bytes
  }

  async h2(bytes: Uint8Array): Promise<Established & { h3: Uint8Array }> {
    if (this.done || !this.h1Bytes) fail('unexpected H2')
    this.done = true
    const v = parse(bytes, ['e', 'n', 'box'])
    const er = bytesOf(v.e, 32)
    const nr = bytesOf(v.n, NONCE_LEN)
    if (!er || !nr) return fail('malformed H2')
    const ss = shared(this.e.secretKey, er)
    const t1 = sha256(concat(this.h1Bytes as Uint8Array, er, nr))
    const k = hsKey(ss, t1)
    const { cert, sig } = await openAuth(k, 0, v.box)
    const dk = keyBytes(cert.dk) as Uint8Array
    if (peerId(dk) !== baseId(this.dialed)) fail('wrong peer')
    const signed = concat(enc(`${AUTH}R`), t1, enc(this.me.peer), enc(this.dialed))
    if (!verify(dk, signed, sig)) fail('bad responder signature')
    const t2 = sha256(concat(t1, bytes))
    const sigI = sign(this.me.dk.sk, concat(enc(`${AUTH}I`), t2))
    const h3 = canonicalBytes({ box: b64u(await authBox(k, 1, this.me.cert, sigI)) })
    const keys = traffic(ss, t2, h3, true)
    wipe(this.e.secretKey, ss, k)
    return { h3, remote: { cert, ik: cert.ik, dk: cert.dk }, keys }
  }
}

export class Responder {
  private e = x25519.keygen()
  private n = randomBytes(NONCE_LEN)
  private state: { ss: Uint8Array; t2: Uint8Array; k: Uint8Array } | null = null
  private stage: 'h1' | 'h3' | 'done' = 'h1'

  constructor(
    private me: Me,
    // The peer id the connection came from.
    private from: string,
    private purpose: Purpose = 'peer'
  ) {}

  async h1(bytes: Uint8Array): Promise<Uint8Array> {
    if (this.stage !== 'h1') fail('unexpected H1')
    this.stage = 'h3'
    const v = parse(bytes, ['v', 'e', 'n', 'purpose'])
    if (v.v !== 1) fail('unsupported version')
    if (v.purpose !== this.purpose) fail('wrong purpose')
    const ei = bytesOf(v.e, 32)
    if (!ei || !bytesOf(v.n, NONCE_LEN)) return fail('malformed H1')
    const ss = shared(this.e.secretKey, ei)
    const t1 = sha256(concat(bytes, this.e.publicKey, this.n))
    const k = hsKey(ss, t1)
    const sigR = sign(this.me.dk.sk, concat(enc(`${AUTH}R`), t1, enc(this.from), enc(this.me.peer)))
    const h2 = canonicalBytes({
      e: b64u(this.e.publicKey),
      n: b64u(this.n),
      box: b64u(await authBox(k, 0, this.me.cert, sigR)),
    })
    this.state = { ss, k, t2: sha256(concat(t1, h2)) }
    wipe(this.e.secretKey)
    return h2
  }

  async h3(bytes: Uint8Array): Promise<Established> {
    const st = this.state
    if (this.stage !== 'h3' || !st) return fail('unexpected H3')
    this.stage = 'done'
    this.state = null
    const v = parse(bytes, ['box'])
    const { cert, sig } = await openAuth(st.k, 1, v.box)
    const dk = keyBytes(cert.dk) as Uint8Array
    if (peerId(dk) !== baseId(this.from)) fail('wrong peer')
    if (!verify(dk, concat(enc(`${AUTH}I`), st.t2), sig)) fail('bad initiator signature')
    const keys = traffic(st.ss, st.t2, bytes, false)
    wipe(st.ss, st.k)
    return { remote: { cert, ik: cert.ik, dk: cert.dk }, keys }
  }
}
