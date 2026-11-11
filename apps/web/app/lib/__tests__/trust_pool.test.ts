import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PathFailed,
  SolveAborted,
  jsRunner,
  nextSlice,
  solveWith,
  workerRunner,
  bootWorker,
  chunkTimeout,
  type Runner,
  type WorkerLike,
} from '../trust/pool'
import { CHUNK, jsChunk, seedOf, type Progress } from '../trust/solve_js'

const ROOT = fileURLToPath(new URL('../../../../..', import.meta.url))
const WASM = readFileSync(join(ROOT, 'apps/web/public/pow/rchat_pow.wasm'))
const v = JSON.parse(readFileSync(join(ROOT, 'crates/pow/tests/vectors.json'), 'utf8')) as {
  challenge: string
  k: number
  target: string
  nonces: string[]
  nonces_wire: string
  tries: number
}

const big = (n: number | string) => BigInt(n)
const SEED = seedOf(v.challenge)
const TARGET = big(v.target)
const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e
  )
const wins = (seed: Uint8Array, sub: number, nonce: bigint, target: bigint) => {
  const input = Buffer.alloc(51)
  input.write('rchat-pow1', 0, 'ascii')
  Buffer.from(seed).copy(input, 10)
  input[42] = sub
  input.writeBigUInt64LE(nonce, 43)
  return createHash('sha256').update(input).digest().readBigUInt64BE(0) < target
}
const unwire = (nonces: string) =>
  (nonces.match(/.{16}/g) ?? []).map(h => Buffer.from(h, 'hex').readBigUInt64LE(0))

// A runner in this realm: the chunk is computed at once and answered on a later tick.
const plain = (seed = SEED, target = TARGET, log?: string[]): Runner => ({
  chunk: async (sub, start, count) => {
    log?.push(`${sub}@${start}+${count}`)
    await new Promise(r => setTimeout(r, 0))
    return jsChunk(seed, sub, start, count, target)
  },
})

const spawn = (): WorkerLike =>
  new Worker(new URL('../trust/worker.ts', import.meta.url), { type: 'module' }) as WorkerLike

describe('solveWith', () => {
  test('one runner finds the smallest winners of the vectors', async () => {
    const seen: Progress[] = []
    const solved = await solveWith([plain()], v.k, { chunk: 1024, onProgress: p => seen.push(p) })
    expect(solved.nonces).toBe(v.nonces_wire)
    expect(solved.tries).toBe(v.tries)
    expect(solved.elapsedMs >= 0).toBe(true)
    expect(seen[seen.length - 1]).toEqual({ solved: v.k, tries: v.tries })
    expect(
      seen.every(
        (p, i) => i === 0 || (p.solved >= seen[i - 1].solved && p.tries >= seen[i - 1].tries)
      )
    ).toBe(true)
    expect(seen.filter(p => p.solved === 0).length > 0).toBe(true)
  })

  test('the default chunk is 65536 tries', async () => {
    expect(CHUNK).toBe(65_536)
    const log: string[] = []
    await solveWith([plain(SEED, TARGET, log)], 1, {})
    expect(log).toEqual(['0@0+65536'])
  })

  test('runner j searches from j * 2^56, and any winner is a valid one', async () => {
    const log: string[] = []
    const target = TARGET >> big(4)
    const solved = await solveWith(
      [0, 1, 2].map(() => plain(SEED, target, log)),
      8,
      { chunk: 256 }
    )
    const nonces = unwire(solved.nonces)
    expect(nonces).toHaveLength(8)
    nonces.forEach((n, sub) => expect(wins(SEED, sub, n, target)).toBe(true))
    expect(nonces.every(n => n >> big(56) < big(3))).toBe(true)
    const starts = new Set(
      log.map(l => (BigInt(l.split('@')[1].split('+')[0]) >> big(56)).toString())
    )
    expect([...starts].sort()).toEqual(['0', '1', '2'])
    expect(
      solved.tries >=
        nonces.reduce((sum, n) => sum + Number(n & ((big(1) << big(56)) - big(1))) + 1, 0)
    ).toBe(true)
  })

  test('no sub-puzzles is an empty solution, and it needs a runner', async () => {
    expect((await solveWith([plain()], 0, {})).nonces).toBe('')
    expect((await failure(solveWith([], 4, {}))) instanceof Error).toBe(true)
  })

  test('a solve aborted before it starts runs no chunk', async () => {
    const log: string[] = []
    const abort = new AbortController()
    abort.abort()
    const e = await failure(solveWith([plain(SEED, TARGET, log)], v.k, { signal: abort.signal }))
    expect(e instanceof SolveAborted).toBe(true)
    expect(log).toEqual([])
  })

  test('abort stops every runner within one chunk', async () => {
    const log: string[] = []
    const abort = new AbortController()
    const solving = solveWith([plain(SEED, big(0), log), plain(SEED, big(0), log)], 4, {
      chunk: 512,
      signal: abort.signal,
      onProgress: () => abort.abort(),
    })
    expect((await failure(solving)) instanceof SolveAborted).toBe(true)
    expect(log.length >= 1 && log.length <= 2).toBe(true)
  })

  test('it waits for its turn between chunks', async () => {
    const log: string[] = []
    const abort = new AbortController()
    let turns = 0
    let chunks = 0
    let reached!: () => void
    let release!: () => void
    const second = new Promise<void>(r => (reached = r))
    const gate = new Promise<void>(r => (release = r))
    const solving = solveWith([plain(SEED, big(0), log)], 1, {
      chunk: 64,
      signal: abort.signal,
      turn: () => {
        turns += 1
        if (turns !== 2) return Promise.resolve()
        reached()
        return gate
      },
      onProgress: () => {
        chunks += 1
        if (chunks === 4) abort.abort()
      },
    })
    await second
    await new Promise(r => setTimeout(r, 5))
    expect(log).toEqual(['0@0+64', '0@64+64'])
    release()
    expect((await failure(solving)) instanceof SolveAborted).toBe(true)
    expect(log).toHaveLength(4)
  })

  test('a turn that is refused ends the solve with that refusal', async () => {
    const stop = new Error('cancelled by the queue')
    const e = await failure(
      solveWith([plain(SEED, big(0))], 1, { chunk: 64, turn: () => Promise.reject(stop) })
    )
    expect(e).toBe(stop)
  })

  test('a runner that breaks ends the solve with its error, once the others stopped', async () => {
    const log: string[] = []
    const broken: Runner = {
      chunk: async () => {
        throw new Error('worker died')
      },
    }
    const e = await failure(solveWith([plain(SEED, big(0), log), broken], 2, { chunk: 128 }))
    expect((e as Error).message).toBe('worker died')
    const ran = log.length
    await new Promise(r => setTimeout(r, 20))
    expect(log.length).toBe(ran)
    expect(ran <= 2).toBe(true)
  })
})

describe('jsRunner', () => {
  test('answers like jsChunk, in slices with a pause between them', async () => {
    let clock = 0
    let pauses = 0
    const runner = jsRunner(SEED, TARGET, {
      sliceMs: 1,
      now: () => (clock += 5),
      pause: async () => {
        pauses += 1
      },
    })
    const first = big(v.nonces[0])
    expect(await runner.chunk(0, big(0), 4096)).toBe(first + big(1))
    expect(pauses > 2).toBe(true)
    expect(await runner.chunk(0, big(0), Number(first))).toBe(big(0))
    expect(await runner.chunk(1, big(3000), 64)).toBe(jsChunk(SEED, 1, big(3000), 64, TARGET))
    expect(await runner.chunk(1, big(3000), 0)).toBe(big(0))
  })

  test('sizes the next slice to the time it is given', () => {
    expect(nextSlice(1024, 40, 10)).toBe(256)
    expect(nextSlice(1024, 10, 10)).toBe(1024)
    expect(nextSlice(1024, 1, 10)).toBe(10_240)
    expect(nextSlice(4096, 20, 10)).toBe(2048)
    expect(nextSlice(256, 500, 10)).toBe(256)
    expect(nextSlice(1024, 0, 10)).toBe(4096)
    expect(nextSlice(1 << 19, 1, 10)).toBe(1 << 20)
  })

  test('never pauses when it is given no time limit', async () => {
    let pauses = 0
    const runner = jsRunner(SEED, big(0), {
      pause: async () => {
        pauses += 1
      },
    })
    expect(await runner.chunk(0, big(0), 70_000)).toBe(big(0))
    expect(pauses).toBe(0)
  })

  test('pauses without a timer, which a hidden tab would hold back', async () => {
    const scope = globalThis as unknown as { setTimeout: typeof setTimeout }
    const real = scope.setTimeout
    let timers = 0
    scope.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      timers += 1
      return real(...args)
    }) as typeof setTimeout
    try {
      const runner = jsRunner(SEED, big(0), { sliceMs: 0.01 })
      expect(await runner.chunk(0, big(0), 4096)).toBe(big(0))
      expect(timers).toBe(0)
    } finally {
      scope.setTimeout = real
    }
  })

  test('pauses with a timer where there is no MessageChannel', async () => {
    const scope = globalThis as Record<string, unknown>
    const kept = scope.MessageChannel
    delete scope.MessageChannel
    try {
      const runner = jsRunner(SEED, TARGET, { sliceMs: 0.01 })
      expect(await runner.chunk(0, big(0), 4096)).toBe(big(v.nonces[0]) + big(1))
    } finally {
      scope.MessageChannel = kept
    }
  })

  test('stops between slices when aborted', async () => {
    const abort = new AbortController()
    let slices = 0
    const runner = jsRunner(SEED, big(0), {
      sliceMs: 10,
      signal: abort.signal,
      pause: async () => {
        slices += 1
        if (slices === 2) abort.abort()
      },
    })
    expect((await failure(runner.chunk(0, big(0), 1 << 22))) instanceof SolveAborted).toBe(true)
    expect(slices).toBe(2)
  })
})

describe('a solver worker', () => {
  test('runs chunks in JavaScript when it is given no module', async () => {
    const worker = spawn()
    try {
      expect(await bootWorker(worker, null, 20_000)).toEqual({ wasm: false })
      const runner = workerRunner(worker, SEED, TARGET)
      expect(await runner.chunk(0, big(0), 4096)).toBe(big(v.nonces[0]) + big(1))
      expect(await runner.chunk(2, big(0), 100)).toBe(big(0))
      const high = big(5) << big(56)
      expect(await runner.chunk(1, high, 512)).toBe(jsChunk(SEED, 1, high, 512, TARGET))
    } finally {
      worker.terminate()
    }
  })

  test('runs chunks in the committed wasm when it is given the module', async () => {
    const worker = spawn()
    try {
      expect(await bootWorker(worker, WASM, 20_000)).toEqual({ wasm: true })
      const runner = workerRunner(worker, SEED, TARGET)
      const [a, b] = await Promise.all([
        runner.chunk(0, big(0), 4096),
        runner.chunk(3, big(0), 4096),
      ])
      expect(a).toBe(big(v.nonces[0]) + big(1))
      expect(b).toBe(big(v.nonces[3]) + big(1))
      const other = seedOf('c1.1.another')
      const second = workerRunner(worker, other, TARGET)
      expect(await second.chunk(0, big(0), 8192)).toBe(jsChunk(other, 0, big(0), 8192, TARGET))
      expect(await runner.chunk(1, big(0), 4096)).toBe(big(v.nonces[1]) + big(1))
    } finally {
      worker.terminate()
    }
  })

  test('solves the vectors across three workers', async () => {
    const workers = [spawn(), spawn(), spawn()]
    try {
      await Promise.all(workers.map(w => bootWorker(w, WASM, 20_000)))
      const solved = await solveWith(
        workers.map(w => workerRunner(w, SEED, TARGET)),
        v.k,
        { chunk: 2048 }
      )
      unwire(solved.nonces).forEach((n, sub) => expect(wins(SEED, sub, n, TARGET)).toBe(true))
    } finally {
      for (const w of workers) w.terminate()
    }
  })

  test('a module that is not one fails the boot', async () => {
    const worker = spawn()
    try {
      const e = await failure(bootWorker(worker, new Uint8Array([0, 1, 2, 3]), 20_000))
      expect(e instanceof PathFailed).toBe(true)
    } finally {
      worker.terminate()
    }
  })

  test('a worker that never answers fails the boot in time', async () => {
    const silent: WorkerLike = {
      postMessage: () => {},
      terminate: () => {},
      onmessage: null,
      onerror: null,
    }
    const e = await failure(bootWorker(silent, null, 20))
    expect(e instanceof PathFailed).toBe(true)
    expect((e as Error).message).toBe('The solver worker did not start')
  })

  test('a winner from 2^63 up is the same number in wasm and in JavaScript', async () => {
    const all = (big(1) << big(64)) - big(1)
    const start = (big(1) << big(63)) + big(5)
    for (const wasm of [WASM, null]) {
      const worker = spawn()
      try {
        await bootWorker(worker, wasm, 20_000)
        const runner = workerRunner(worker, SEED, all)
        expect(await runner.chunk(0, start, 1)).toBe(start + big(1))
        expect(await runner.chunk(0, start, 1)).toBe(jsChunk(SEED, 0, start, 1, all))
      } finally {
        worker.terminate()
      }
    }
  })

  // A worker that boots and then never answers: frozen or killed without an error event.
  const frozen = (): WorkerLike => {
    const worker: WorkerLike = {
      postMessage: message => {
        if ((message as { boot?: boolean }).boot)
          setTimeout(() => worker.onmessage?.({ data: { ready: true, wasm: false } }), 0)
      },
      terminate: () => {},
      onmessage: null,
      onerror: null,
    }
    return worker
  }

  test('a worker that goes silent after its boot fails the path in time', async () => {
    const worker = frozen()
    expect(await bootWorker(worker, null, 1000)).toEqual({ wasm: false })
    const runner = workerRunner(worker, SEED, TARGET, { timeoutMs: 30 })
    const started = performance.now()
    const e = await failure(runner.chunk(0, big(0), 64))
    expect(e instanceof PathFailed).toBe(true)
    expect((e as Error).message).toBe('The solver worker stopped answering')
    expect(performance.now() - started < 2000).toBe(true)
  })

  test('cancel stops a solve whose worker is silent', async () => {
    const worker = frozen()
    await bootWorker(worker, null, 1000)
    const abort = new AbortController()
    const runner = workerRunner(worker, SEED, TARGET, { signal: abort.signal, timeoutMs: 60_000 })
    const solving = solveWith([runner], 4, { signal: abort.signal })
    setTimeout(() => abort.abort(), 10)
    const started = performance.now()
    expect((await failure(solving)) instanceof SolveAborted).toBe(true)
    expect(performance.now() - started < 2000).toBe(true)
  })

  test('a chunk gets 20 times the longest one so far, and at least 5 seconds', () => {
    expect(chunkTimeout(0)).toBe(5000)
    expect(chunkTimeout(100)).toBe(5000)
    expect(chunkTimeout(250)).toBe(5000)
    expect(chunkTimeout(400)).toBe(8000)
    expect(chunkTimeout(3000)).toBe(60_000)
  })

  test('a late answer to a chunk that was given up is ignored', async () => {
    const worker = frozen()
    await bootWorker(worker, null, 1000)
    const runner = workerRunner(worker, SEED, TARGET, { timeoutMs: 20 })
    expect((await failure(runner.chunk(0, big(0), 64))) instanceof PathFailed).toBe(true)
    worker.onmessage?.({ data: { id: 1, hit: big(7) } })
    expect((await failure(runner.chunk(0, big(0), 64))) instanceof PathFailed).toBe(true)
  })

  test('a worker that errors fails its chunks', async () => {
    const dying: WorkerLike = {
      postMessage: () => {},
      terminate: () => {},
      onmessage: null,
      onerror: null,
    }
    const runner = workerRunner(dying, SEED, TARGET)
    const pending = failure(runner.chunk(0, big(0), 64))
    dying.onerror!(new Error('boom'))
    expect((await pending) instanceof PathFailed).toBe(true)
    expect((await failure(runner.chunk(0, big(0), 64))) instanceof PathFailed).toBe(true)
  })
})
