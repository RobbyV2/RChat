import { hashBlob } from './hashing'
import type { Resolver } from './resolve'
import { serveResolve, type HostRequest } from './resolve_host'

// The P2P worker, off the main thread. One script for every job, so the bundler gives every
// instance the same bootstrap URL (two worker scripts behind one bootstrap URL can get each
// other's code in Chromium).
// - Hashing attachments, so a large file never blocks the UI. In: `{id, file}`; out:
//   `{id, progress: [done, total]}`, then `{id, ok: Hashed}` or `{id, err}`.
// - State resolution of P2P servers (resolve_host.ts): a resolver per room, kept between
//   requests so new events are worked out incrementally. In: `{id, op, room, events?}`.

interface HashJob {
  id: number
  file: Blob
}

const post = (m: unknown) =>
  (self as unknown as { postMessage: (m: unknown) => void }).postMessage(m)

const rooms = new Map<string, Resolver>()

const hash = ({ id, file }: HashJob) => {
  let last = 0
  hashBlob(file, (done, total) => {
    const now = Date.now()
    if (done === total || now - last > 100) {
      last = now
      post({ id, progress: [done, total] })
    }
  }).then(
    ok => post({ id, ok }),
    (err: unknown) => post({ id, err: err instanceof Error ? err.message : String(err) })
  )
}

self.onmessage = (e: MessageEvent<HashJob | HostRequest>) => {
  const m = e.data
  if ('op' in m) serveResolve(rooms, m, post)
  else hash(m)
}
