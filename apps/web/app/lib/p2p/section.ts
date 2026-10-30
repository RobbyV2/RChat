import { isRecord } from '../bytes'
import { bytesOf } from './canonical'

// The `p2p` section of a config export: this browser's P2P identity and history, encrypted with
// a key derived from a passphrase. Only the string and the file carry it, never a share link.
// `m` is in KiB, as Argon2 counts it.

export interface Kdf {
  alg: 'argon2id'
  m: number
  t: number
  p: number
}

export interface P2pSection {
  v: 1
  kdf: Kdf
  salt: string
  iv: string
  ct: string
}

export const SALT_BYTES = 16
export const IV_BYTES = 12

const B64U = /^[A-Za-z0-9_-]+$/

const isInt = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0

export const isKdf = (x: unknown): x is Kdf =>
  isRecord(x) &&
  Object.keys(x).length === 4 &&
  x.alg === 'argon2id' &&
  isInt(x.m) &&
  isInt(x.t) &&
  isInt(x.p)

// Shape only; the parameters are checked against the minimums when it is unlocked, so a weak
// file gets a clear refusal instead of disappearing.
export const cleanP2pSection = (x: unknown): P2pSection | undefined => {
  if (!isRecord(x) || Object.keys(x).length !== 5) return undefined
  const { v, kdf, salt, iv, ct } = x
  if (v !== 1 || !isKdf(kdf)) return undefined
  if (!bytesOf(salt, SALT_BYTES) || !bytesOf(iv, IV_BYTES)) return undefined
  if (typeof ct !== 'string' || !B64U.test(ct) || ct.length % 4 === 1) return undefined
  return {
    v: 1,
    kdf: { alg: 'argon2id', m: kdf.m, t: kdf.t, p: kdf.p },
    salt: salt as string,
    iv: iv as string,
    ct,
  }
}
