import { hashBlob } from './hashing'

// Hashes attachments off the main thread, so a large file never blocks the UI. Messages in:
// `{id, file}`; out: `{id, progress: [done, total]}`, then `{id, ok: Hashed}` or `{id, err}`.

interface Job {
  id: number
  file: Blob
}

const post = (m: unknown) =>
  (self as unknown as { postMessage: (m: unknown) => void }).postMessage(m)

self.onmessage = (e: MessageEvent<Job>) => {
  const { id, file } = e.data
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
