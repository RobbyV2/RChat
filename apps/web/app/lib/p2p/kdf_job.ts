import { argon2id } from '@noble/hashes/argon2.js'

// The passphrase key made in JavaScript, as a job of the P2P worker (p2p.worker.ts), so the
// page stays usable for the minute it can take. In: `{id, kdf}`; out: `{id, part}` for each
// percent done, then `{id, key}` or `{id, err}`.
export interface KdfJob {
  id: number
  kdf: { password: Uint8Array; salt: Uint8Array; m: number; t: number; p: number; maxmem: number }
}

export type KdfReply =
  { id: number; part: number } | { id: number; key: Uint8Array } | { id: number; err: string }

// Passes each whole percent on once, as a part of 1.
export const eachPercent = (report: (part: number) => void) => {
  let shown = -1
  return (part: number) => {
    const percent = Math.floor(part * 100)
    if (percent === shown) return
    shown = percent
    report(percent / 100)
  }
}

export const runKdfJob = ({ id, kdf }: KdfJob, post: (m: KdfReply) => void) => {
  const { password, salt, m, t, p, maxmem } = kdf
  try {
    const onProgress = eachPercent(part => post({ id, part }))
    post({ id, key: argon2id(password, salt, { m, t, p, dkLen: 32, maxmem, onProgress }) })
  } catch (e) {
    post({ id, err: e instanceof Error ? e.message : String(e) })
  } finally {
    password.fill(0)
  }
}
