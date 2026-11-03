import { sha256 } from '@noble/hashes/sha2.js'
import { isRecord } from '../../bytes'
import { b64u, bytesOf, canonicalBytes, concat, utf8 } from '../canonical'
import { keyBytes, keyId, sign, verify, type KeyPair } from '../keys'

// Device certificates of introductions (spec §1.1, §1.4): the identity's primary key signs the
// server, the identity, the device and the identity-chain position (`iprev`) of the event that
// introduces the device. A genesis has no server id yet: its owners' bundles name the digest of
// the genesis content, and no position.

export const TAG_DEVICE = 'rchat-p2p-device2\0'

const certInput = (srv: string, ik: string, dk: string, iprev: string) =>
  concat(utf8(TAG_DEVICE), utf8(srv), utf8('\0'), canonicalBytes({ ik, dk, iprev }))

export const signDeviceCert2 = (
  primary: KeyPair,
  srv: string,
  ik: string,
  dk: string,
  iprev?: string
) => b64u(sign(primary.sk, certInput(srv, ik, dk, iprev ?? '')))

// The hash of a genesis content with every owner's `dcert` removed: every other field, the
// nonce, `rules` and each owner's `ik` and `dk` included. Throws on content that isn't JSON.
export const genesisDigest = (c: Record<string, unknown>) => {
  const bare = (o: unknown) =>
    isRecord(o) ? Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'dcert')) : o
  const skel = Array.isArray(c.owners) ? { ...c, owners: c.owners.map(bare) } : c
  return b64u(sha256(canonicalBytes(skel)))
}

export const genesisSrv = (c: Record<string, unknown>) => `genesis:${genesisDigest(c)}`

// A genesis owner bundle (§1.1 `idb`) for the genesis content `c`, whose owners list this owner
// with `dk`: its certificate binds `dk` to its identity, which plays primary until Task 17 gives
// identities separate keys. Every owner, co-owners included, signs its own.
export const genesisBundle = (ik: KeyPair, dk: string, c: Record<string, unknown>) => {
  const id = keyId(ik.pk)
  return { ik: id, dk, dcert: signDeviceCert2(ik, genesisSrv(c), id, dk) }
}

export function deviceCertOk(
  primary: string,
  srv: string,
  ik: string,
  dk: string,
  iprev: string,
  cert: unknown
): boolean {
  const pk = keyBytes(primary)
  const sb = bytesOf(cert, 64)
  try {
    return !!pk && !!sb && verify(pk, certInput(srv, ik, dk, iprev), sb)
  } catch {
    return false
  }
}
