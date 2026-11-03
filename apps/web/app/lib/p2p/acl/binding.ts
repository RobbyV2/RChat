import { b64u, bytesOf, canonicalBytes, concat, utf8 } from '../canonical'
import { keyBytes, keyId, sign, verify, type KeyPair } from '../keys'

// Device certificates of introductions (spec §1.1, §1.4): the identity's primary key signs the
// server, the identity, the device and the identity-chain position (`iprev`) of the event that
// introduces the device. A genesis has no server id yet: its owners' bundles name its nonce, and
// no position.

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

export const genesisSrv = (nonce: string) => `genesis:${nonce}`

// A genesis owner bundle (§1.1 `idb`) for the genesis with `nonce`: its certificate binds `dk` to
// its identity, which plays primary until Task 17 gives identities separate keys. Every owner,
// co-owners included, signs its own.
export const genesisBundle = (ik: KeyPair, dk: string, nonce: string) => {
  const id = keyId(ik.pk)
  return { ik: id, dk, dcert: signDeviceCert2(ik, genesisSrv(nonce), id, dk) }
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
