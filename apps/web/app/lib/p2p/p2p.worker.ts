import type { AdmitOpts } from './acl/admit'
import type { AclRoom } from './acl_room'
import { loadPermissionRules } from '../perms_load'
import { hashBlob } from './hashing'
import { runKdfJob, type KdfJob } from './kdf_job'
import { serveAcl, type HostRequest } from './resolve_host'
import { time } from '../platform/time'

// The P2P worker, off the main thread. One script for every job, so the bundler gives every
// instance the same bootstrap URL (two worker scripts behind one bootstrap URL can get each
// other's code in Chromium).
// - Hashing attachments, so a large file never blocks the UI. In: `{id, file}`; out:
//   `{id, progress: [done, total]}`, then `{id, ok: Hashed}` or `{id, err}`.
// - The ACL evaluator of P2P servers (resolve_host.ts): an AclRoom per room, kept between
//   requests, with the account's limits (`{op: 'local'}`, first). In: `{id, op, room, ...}`.
// - The passphrase key where WebAssembly can't make it (kdf_job.ts). In: `{id, kdf}`.

interface HashJob {
  id: number
  file: Blob
}

const post = (m: unknown) =>
  (self as unknown as { postMessage: (m: unknown) => void }).postMessage(m)

// The ACL evaluator decides through the shared permission rules: the page says where they are,
// and requests wait for the load. A failed load is reported as `{id: 0, err}`, so the page
// evaluates in its own thread instead.
let rules: Promise<void> = Promise.reject(new Error('no permission rules'))
rules.catch(() => {})
const RULES_FAILED = 'The permission rules could not load'
const rooms = new Map<string, AclRoom>()
const opts: Partial<AdmitOpts> = {}

const hash = ({ id, file }: HashJob) => {
  let last = 0
  hashBlob(file, (done, total) => {
    const now = time().now()
    if (done === total || now - last > 100) {
      last = now
      post({ id, progress: [done, total] })
    }
  }).then(
    ok => post({ id, ok }),
    (err: unknown) => post({ id, err: err instanceof Error ? err.message : String(err) })
  )
}

self.onmessage = (e: MessageEvent<HashJob | HostRequest | KdfJob>) => {
  const m = e.data
  if ('op' in m && m.op === 'rules') {
    rules = loadPermissionRules(m.base)
    rules.catch(() => post({ id: 0, err: RULES_FAILED }))
  } else if ('op' in m)
    void rules.then(
      () => serveAcl(rooms, m, post, opts),
      () => post({ id: m.id, err: RULES_FAILED })
    )
  else if ('kdf' in m) runKdfJob(m, post)
  else hash(m)
}
