import { CHUNK, jsChunk, wire, type Progress, type Solved } from './solve_js'

// Solving with runners: each runner tries chunks of nonces for one puzzle, in a worker (wasm or
// JavaScript) or in this realm. Runner `j` searches from `j * 2^56`; the first winner of a
// sub-puzzle moves every runner to the next one.

export class SolveAborted extends Error {
  constructor() {
    super('The solve was cancelled')
    this.name = 'SolveAborted'
  }
}

// The solver path itself broke: a worker could not start, stopped, crashed or went silent. Only
// this marks a path as failed; an error of any other kind is about the solve, not the path.
export class PathFailed extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathFailed'
  }
}

export interface Runner {
  // Tries `count` nonces of sub-puzzle `sub` from `start`: the winning nonce plus one, or 0.
  chunk(sub: number, start: bigint, count: number): Promise<bigint>
}

export interface SolveOpts {
  onProgress?: (p: Progress) => void
  signal?: AbortSignal
  // Awaited between chunks: the solve queue's `turn.next`.
  turn?: () => Promise<void>
  chunk?: number
  // How many runners to use; all of them when absent.
  threads?: number
}

const ZERO = BigInt(0)
const ONE = BigInt(1)
const RANGE = BigInt(56)

export const solveWith = async (
  runners: readonly Runner[],
  k: number,
  opts: SolveOpts = {}
): Promise<Solved> => {
  const used = runners.slice(0, Math.max(1, opts.threads ?? runners.length))
  if (used.length === 0 && k > 0) throw new Error('No solver runner')
  const size = opts.chunk ?? CHUNK
  const started = performance.now()
  const nonces: bigint[] = []
  let tries = 0
  let failed = false
  let failure: unknown
  for (let sub = 0; sub < k; sub += 1) {
    let found: bigint | null = null
    await Promise.all(
      used.map(async (runner, j) => {
        let at = BigInt(j) << RANGE
        try {
          while (found === null && !failed) {
            if (opts.signal?.aborted) throw new SolveAborted()
            const hit = await runner.chunk(sub, at, size)
            tries += hit === ZERO ? size : Number(hit - at)
            at += BigInt(size)
            if (hit !== ZERO && found === null) found = hit - ONE
            opts.onProgress?.({ solved: found === null ? sub : sub + 1, tries })
            if (found === null) await opts.turn?.()
          }
        } catch (e) {
          if (!failed) failure = e
          failed = true
        }
      })
    )
    if (failed) throw failure
    if (found !== null) nonces.push(found)
  }
  return {
    nonces: wire(nonces),
    tries,
    elapsedMs: performance.now() - started,
    threads: Math.max(1, used.length),
  }
}

const SLICE_MIN = 256
const SLICE_START = 1024
const SLICE_MAX = 1 << 20

// The slice that would have taken `sliceMs` at the rate the last one ran at.
export const nextSlice = (tries: number, ms: number, sliceMs: number): number =>
  Math.min(SLICE_MAX, Math.max(SLICE_MIN, ms > 0 ? Math.round((tries * sliceMs) / ms) : tries * 4))

// A turn of the event loop. A message, not a timer: browsers hold the timers of a hidden tab back
// to one a second and later one a minute, and a hidden tab still has to solve for its socket.
const breath = (): Promise<void> =>
  new Promise(resolve => {
    if (typeof MessageChannel !== 'function') {
      setTimeout(resolve, 0)
      return
    }
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })

export interface JsRunnerOpts {
  // The time one slice may hold the thread; without it a chunk runs in one go.
  sliceMs?: number
  pause?: () => Promise<void>
  now?: () => number
  signal?: AbortSignal
}

// A runner in this realm. With `sliceMs` it works in short slices and pauses between them, so
// the main thread stays live.
export const jsRunner = (seed: Uint8Array, target: bigint, opts: JsRunnerOpts = {}): Runner => {
  const { sliceMs, signal } = opts
  const now = opts.now ?? (() => performance.now())
  const pause = opts.pause ?? breath
  let size = SLICE_START
  return {
    chunk: async (sub, start, count) => {
      let done = 0
      while (done < count) {
        const tries = sliceMs === undefined ? count : Math.min(size, count - done)
        const began = now()
        const hit = jsChunk(seed, sub, start + BigInt(done), tries, target)
        if (hit !== ZERO) return hit
        done += tries
        if (sliceMs !== undefined) size = nextSlice(tries, now() - began, sliceMs)
        if (done < count) {
          await pause()
          if (signal?.aborted) throw new SolveAborted()
        }
      }
      return ZERO
    },
  }
}

// What the pool needs of a Worker.
export interface WorkerLike {
  postMessage(message: unknown): void
  terminate(): void
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
}

interface Link {
  jobs: Map<number, { resolve: (hit: bigint) => void; reject: (e: Error) => void }>
  boot: { resolve: (wasm: boolean) => void; reject: (e: Error) => void } | null
  id: number
  dead: PathFailed | null
}

const links = new WeakMap<WorkerLike, Link>()

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

// One listener per worker, shared by its boot and by every runner on it.
const link = (worker: WorkerLike): Link => {
  const known = links.get(worker)
  if (known) return known
  const made: Link = { jobs: new Map(), boot: null, id: 0, dead: null }
  links.set(worker, made)
  worker.onmessage = event => {
    const m = record(event.data)
    if (typeof m.ready === 'boolean') {
      const boot = made.boot
      made.boot = null
      if (m.ready) boot?.resolve(m.wasm === true)
      else boot?.reject(new PathFailed('The solver did not load'))
      return
    }
    const job = typeof m.id === 'number' ? made.jobs.get(m.id) : undefined
    if (!job || typeof m.id !== 'number') return
    made.jobs.delete(m.id)
    if (typeof m.hit === 'bigint') job.resolve(m.hit)
    else job.reject(new PathFailed('The solver worker failed'))
  }
  worker.onerror = () => stop(made, 'The solver worker stopped')
  return made
}

// The worker is gone: what waits on it fails, and so does everything asked of it later.
const stop = (l: Link, why: string): PathFailed => {
  const dead = new PathFailed(why)
  l.dead = dead
  l.boot?.reject(dead)
  l.boot = null
  for (const job of l.jobs.values()) job.reject(dead)
  l.jobs.clear()
  return dead
}

// Starts a solver worker (lib/trust/worker.ts): with `wasm` it instantiates the module and
// solves with it, without it it solves in JavaScript. Rejects when the worker can't.
export const bootWorker = (
  worker: WorkerLike,
  wasm: Uint8Array | null,
  timeoutMs: number
): Promise<{ wasm: boolean }> =>
  new Promise((resolve, reject) => {
    const l = link(worker)
    const timer = setTimeout(() => {
      l.boot = null
      reject(new PathFailed('The solver worker did not start'))
    }, timeoutMs)
    l.boot = {
      resolve: ran => {
        clearTimeout(timer)
        resolve({ wasm: ran })
      },
      reject: e => {
        clearTimeout(timer)
        reject(e)
      },
    }
    worker.postMessage({ boot: true, wasm })
  })

const CHUNK_TIMEOUT_MIN = 5000
const CHUNK_TIMEOUT_FACTOR = 20

// How long a worker gets for one chunk: 20 times its longest so far, at least 5 seconds.
export const chunkTimeout = (longestMs: number): number =>
  Math.max(CHUNK_TIMEOUT_MIN, Math.round(longestMs * CHUNK_TIMEOUT_FACTOR))

export interface WorkerRunnerOpts {
  signal?: AbortSignal
  // The time one chunk gets, in place of `chunkTimeout`.
  timeoutMs?: number
}

// A runner on a booted worker, for one puzzle. A chunk ends with the worker's answer, with the
// cancel, or with the worker counted as gone when it stays silent too long.
export const workerRunner = (
  worker: WorkerLike,
  seed: Uint8Array,
  target: bigint,
  opts: WorkerRunnerOpts = {}
): Runner => {
  const l = link(worker)
  const { signal } = opts
  let longest = 0
  return {
    chunk: (sub, start, count) =>
      new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new SolveAborted())
        if (l.dead) return reject(l.dead)
        const id = (l.id += 1)
        const began = performance.now()
        const done = () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', cancel)
          l.jobs.delete(id)
        }
        const cancel = () => {
          done()
          reject(new SolveAborted())
        }
        const timer = setTimeout(
          () => {
            done()
            reject(stop(l, 'The solver worker stopped answering'))
          },
          opts.timeoutMs ?? chunkTimeout(longest)
        )
        signal?.addEventListener('abort', cancel, { once: true })
        l.jobs.set(id, {
          resolve: hit => {
            done()
            longest = Math.max(longest, performance.now() - began)
            resolve(hit)
          },
          reject: e => {
            done()
            reject(e)
          },
        })
        worker.postMessage({ id, seed, target, sub, start, count })
      }),
  }
}
