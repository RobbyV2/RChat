import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BadPuzzle,
  RETRY_MS,
  SOLVER_PATHS,
  Solver,
  checkPuzzle,
  pickSolver,
  solverLabel,
  threadsFor,
  webCandidates,
  type Candidate,
  type PathSolver,
  type SolverPath,
} from '../trust/pick'
import { PathFailed, SolveAborted, type WorkerLike } from '../trust/pool'
import { seedOf, type Puzzle, type Solved } from '../trust/solve_js'

const ROOT = fileURLToPath(new URL('../../../../..', import.meta.url))
const WASM = readFileSync(join(ROOT, 'apps/web/public/pow/rchat_pow.wasm'))
const v = JSON.parse(readFileSync(join(ROOT, 'crates/pow/tests/vectors.json'), 'utf8')) as {
  challenge: string
  k: number
  target: string
  nonces_wire: string
}
const ORIGIN = 'https://chat.example.com'
const OTHER = 'https://other.example.org'
const VECTOR: Puzzle = { challenge: v.challenge, k: v.k, target: v.target }
// 16 sub-puzzles at a work of 2^12.
const SMALL: Puzzle = { challenge: 'c1.1.pick-test.tag', k: 16, target: '72057594037927936' }

const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e
  )
const verified = (p: Puzzle, solved: Solved) => {
  const seed = Buffer.from(seedOf(p.challenge))
  const nonces = solved.nonces.match(/.{16}/g) ?? []
  return (
    nonces.length === p.k &&
    nonces.every((h, sub) => {
      const input = Buffer.concat([
        Buffer.from('rchat-pow1'),
        seed,
        Buffer.from([sub]),
        Buffer.from(h, 'hex'),
      ])
      return createHash('sha256').update(input).digest().readBigUInt64BE(0) < BigInt(p.target)
    })
  )
}

const SOLVED: Solved = { nonces: 'aa', tries: 10, elapsedMs: 5, threads: 1 }
const fake = (
  path: SolverPath,
  log: string[],
  how: { start?: 'null' | 'throw'; solve?: (puzzle: Puzzle) => Promise<Solved> } = {}
): Candidate => ({
  path,
  start: async () => {
    log.push(`start ${path}`)
    if (how.start === 'throw') throw new Error(`${path} blew up`)
    if (how.start === 'null') return null
    const solver: PathSolver = {
      solve: async puzzle => {
        log.push(`solve ${path}`)
        return how.solve ? how.solve(puzzle) : { ...SOLVED, nonces: path }
      },
      close: () => void log.push(`close ${path}`),
    }
    return solver
  },
})

describe('pickSolver', () => {
  test('knows the paths in the order it tries them', () => {
    expect([...SOLVER_PATHS]).toEqual(['native', 'wasm-workers', 'js-workers', 'js-main'])
  })

  test('takes the first path that starts, by trying each', async () => {
    const log: string[] = []
    const picked = await pickSolver([
      fake('native', log, { start: 'null' }),
      fake('wasm-workers', log, { start: 'throw' }),
      fake('js-workers', log),
      fake('js-main', log),
    ])
    expect(picked!.path).toBe('js-workers')
    expect(log).toEqual(['start native', 'start wasm-workers', 'start js-workers'])
  })

  test('tries them in path order however they are listed', async () => {
    const log: string[] = []
    const picked = await pickSolver([
      fake('js-main', log),
      fake('wasm-workers', log),
      fake('native', log),
    ])
    expect(picked!.path).toBe('native')
    expect(log).toEqual(['start native'])
  })

  test('skips the paths that already failed, and has none when all did', async () => {
    const log: string[] = []
    const all = [fake('wasm-workers', log), fake('js-main', log)]
    expect((await pickSolver(all, new Set<SolverPath>(['wasm-workers'])))!.path).toBe('js-main')
    expect(await pickSolver(all, new Set<SolverPath>(['wasm-workers', 'js-main']))).toBeNull()
    expect(await pickSolver([])).toBeNull()
    expect(log).toEqual(['start js-main'])
  })
})

describe('Solver', () => {
  test('decides once and keeps its path', async () => {
    const log: string[] = []
    const picks: SolverPath[] = []
    const solver = new Solver([fake('wasm-workers', log), fake('js-main', log)], p => picks.push(p))
    expect(solver.path(ORIGIN)).toBeNull()
    expect((await solver.solve(ORIGIN, VECTOR, {})).nonces).toBe('wasm-workers')
    expect((await solver.solve(ORIGIN, VECTOR, {})).nonces).toBe('wasm-workers')
    expect(solver.path(ORIGIN)).toBe('wasm-workers')
    expect(picks).toEqual(['wasm-workers'])
    expect(log).toEqual(['start wasm-workers', 'solve wasm-workers', 'solve wasm-workers'])
  })

  test('decides again when its path fails in the middle of a solve', async () => {
    const log: string[] = []
    const picks: SolverPath[] = []
    let healthy = true
    const solver = new Solver(
      [
        fake('native', log, {
          solve: async () => {
            if (!healthy) throw new PathFailed('the command went away')
            return { ...SOLVED, nonces: 'native' }
          },
        }),
        fake('wasm-workers', log, { start: 'null' }),
        fake('js-workers', log),
        fake('js-main', log),
      ],
      p => picks.push(p)
    )
    expect((await solver.solve(ORIGIN, VECTOR, {})).nonces).toBe('native')
    healthy = false
    expect((await solver.solve(ORIGIN, VECTOR, {})).nonces).toBe('js-workers')
    expect(solver.path(ORIGIN)).toBe('js-workers')
    expect(picks).toEqual(['native', 'js-workers'])
    expect(log).toEqual([
      'start native',
      'solve native',
      'solve native',
      'close native',
      'start wasm-workers',
      'start js-workers',
      'solve js-workers',
    ])
    healthy = true
    expect((await solver.solve(ORIGIN, VECTOR, {})).nonces).toBe('js-workers')
  })

  test('a cancelled solve is not a failed path', async () => {
    const log: string[] = []
    const abort = new AbortController()
    const solver = new Solver([
      fake('wasm-workers', log, {
        solve: async () => {
          abort.abort()
          throw new SolveAborted()
        },
      }),
      fake('js-main', log),
    ])
    expect(
      (await failure(solver.solve(ORIGIN, VECTOR, { signal: abort.signal }))) instanceof
        SolveAborted
    ).toBe(true)
    expect(solver.path(ORIGIN)).toBe('wasm-workers')
    expect(log).toEqual(['start wasm-workers', 'solve wasm-workers'])
  })

  test('with every path failed there is nothing to solve with', async () => {
    const broken = () => Promise.reject(new PathFailed('no'))
    const solver = new Solver([
      fake('js-workers', [], { solve: broken }),
      fake('js-main', [], { solve: broken }),
    ])
    expect(((await failure(solver.solve(ORIGIN, VECTOR, {}))) as Error).message).toBe(
      'No solver works on this device'
    )
    expect(solver.path(ORIGIN)).toBeNull()
  })

  test('keeps the rate of its last solve, per thread', async () => {
    let threads = 4
    const solver = new Solver([
      fake('js-main', [], {
        solve: async () => ({ nonces: 'x', tries: 3_000_000, elapsedMs: 500, threads }),
      }),
    ])
    expect(solver.rate()).toBeNull()
    await solver.solve(ORIGIN, VECTOR, {})
    expect(solver.rate()).toBe(1_500_000)
    threads = 1
    await solver.solve(ORIGIN, VECTOR, {})
    expect(solver.rate()).toBe(6_000_000)
  })

  test('close closes the path it holds', async () => {
    const log: string[] = []
    const solver = new Solver([fake('js-main', log)])
    await solver.solve(ORIGIN, VECTOR, {})
    solver.close()
    expect(log).toEqual(['start js-main', 'solve js-main', 'close js-main'])
    expect(solver.path(ORIGIN)).toBeNull()
  })
})

describe('a challenge is checked before any solver is tried', () => {
  const big = (n: number) => BigInt(n)
  const most = ((big(1) << big(64)) - big(1)).toString()

  test('what an instance may ask passes', () => {
    for (const puzzle of [
      VECTOR,
      { challenge: 'c1.1.e30.AAAA', k: 0, target: '1' },
      { challenge: 'c1.12345678.e30.AAAA', k: 64, target: most },
      { challenge: 'c'.repeat(4096), k: 16, target: '281474976710656' },
    ])
      checkPuzzle(puzzle)
  })

  test('anything else is refused with its own error, and no path is started or blamed', async () => {
    const log: string[] = []
    const solver = new Solver([fake('wasm-workers', log), fake('js-main', log)])
    const bad: unknown[] = [
      { ...VECTOR, target: 'not-a-number' },
      { ...VECTOR, target: '' },
      { ...VECTOR, target: '0' },
      { ...VECTOR, target: '-5' },
      { ...VECTOR, target: '1e3' },
      { ...VECTOR, target: ' 12' },
      { ...VECTOR, target: '0x10' },
      { ...VECTOR, target: '18446744073709551616' },
      { ...VECTOR, target: '100000000000000000000000' },
      { ...VECTOR, target: 12 },
      { ...VECTOR, target: undefined },
      { ...VECTOR, k: -1 },
      { ...VECTOR, k: 65 },
      { ...VECTOR, k: 1.5 },
      { ...VECTOR, k: NaN },
      { ...VECTOR, k: '4' },
      { ...VECTOR, challenge: '' },
      { ...VECTOR, challenge: 'c1.1.é.AAAA' },
      { ...VECTOR, challenge: 'c1.1.e30.AAAA\n' },
      { ...VECTOR, challenge: 'c'.repeat(4097) },
      { ...VECTOR, challenge: 7 },
      null,
      'c1.1.e30.AAAA',
    ]
    for (const puzzle of bad) {
      const e = await failure(solver.solve(ORIGIN, puzzle as Puzzle, {}))
      expect(e instanceof BadPuzzle).toBe(true)
      expect((e as Error).message).toBe('This challenge is not one this app can solve')
    }
    expect(log).toEqual([])
    expect(solver.path(ORIGIN)).toBeNull()
    expect((await solver.solve(ORIGIN, VECTOR, {})).nonces).toBe('wasm-workers')
  })

  test('one malformed challenge leaves the device its solvers', async () => {
    const picks: string[] = []
    const solver = new Solver(webCandidates(env().env), (path, origin) =>
      picks.push(`${path} for ${origin}`)
    )
    try {
      const e = await failure(solver.solve(ORIGIN, { ...VECTOR, target: 'not-a-number' }, {}))
      expect(e instanceof BadPuzzle).toBe(true)
      expect(verified(VECTOR, await solver.solve(ORIGIN, VECTOR, {}))).toBe(true)
      expect(solver.path(ORIGIN)).toBe('wasm-workers')
      expect(verified(VECTOR, await solver.solve(OTHER, VECTOR, {}))).toBe(true)
      expect(picks).toEqual([`wasm-workers for ${ORIGIN}`, `wasm-workers for ${OTHER}`])
    } finally {
      solver.close()
    }
  })
})

describe('a path fails only by itself', () => {
  test('an error that is not the path failing goes to the caller and the path stays', async () => {
    const log: string[] = []
    let odd = true
    const solver = new Solver([
      fake('wasm-workers', log, {
        solve: async () => {
          if (odd) throw new TypeError('something else')
          return { ...SOLVED, nonces: 'wasm-workers' }
        },
      }),
      fake('js-main', log),
    ])
    const e = await failure(solver.solve(ORIGIN, VECTOR, {}))
    expect(e instanceof TypeError).toBe(true)
    expect(solver.path(ORIGIN)).toBe('wasm-workers')
    odd = false
    expect((await solver.solve(ORIGIN, VECTOR, {})).nonces).toBe('wasm-workers')
    expect(log).toEqual(['start wasm-workers', 'solve wasm-workers', 'solve wasm-workers'])
  })

  test('a path that failed for one instance is still used for the others', async () => {
    const log: string[] = []
    const solver = new Solver([
      fake('wasm-workers', log, {
        solve: async puzzle => {
          if (puzzle.challenge.includes('other')) throw new PathFailed('crashed')
          return { ...SOLVED, nonces: 'wasm-workers' }
        },
      }),
      fake('js-workers', log),
    ])
    const theirs: Puzzle = { ...VECTOR, challenge: 'c1.1.other.tag' }
    expect((await solver.solve(OTHER, theirs, {})).nonces).toBe('js-workers')
    expect(solver.path(OTHER)).toBe('js-workers')
    expect((await solver.solve(ORIGIN, VECTOR, {})).nonces).toBe('wasm-workers')
    expect(solver.path(ORIGIN)).toBe('wasm-workers')
    expect((await solver.solve(OTHER, VECTOR, {})).nonces).toBe('js-workers')
    expect(log).toEqual([
      'start wasm-workers',
      'solve wasm-workers',
      'close wasm-workers',
      'start js-workers',
      'solve js-workers',
      'start wasm-workers',
      'solve wasm-workers',
      'solve js-workers',
    ])
  })

  test('a failed path is tried again after a while', async () => {
    const log: string[] = []
    let clock = 1_000_000
    let healthy = false
    const solver = new Solver(
      [
        fake('wasm-workers', log, {
          solve: async () => {
            if (!healthy) throw new PathFailed('crashed')
            return { ...SOLVED, nonces: 'wasm-workers' }
          },
        }),
        fake('js-main', log),
      ],
      undefined,
      () => clock
    )
    expect((await solver.solve(ORIGIN, VECTOR, {})).nonces).toBe('js-main')
    healthy = true
    clock += RETRY_MS - 1
    expect((await solver.solve(ORIGIN, VECTOR, {})).nonces).toBe('js-main')
    clock += 1
    expect((await solver.solve(ORIGIN, VECTOR, {})).nonces).toBe('wasm-workers')
    expect(solver.path(ORIGIN)).toBe('wasm-workers')
    expect(RETRY_MS).toBe(300_000)
  })

  test('a path that cannot start is not started again for every solve', async () => {
    const log: string[] = []
    let clock = 0
    const solver = new Solver(
      [fake('wasm-workers', log, { start: 'throw' }), fake('js-main', log)],
      undefined,
      () => clock
    )
    await solver.solve(ORIGIN, VECTOR, {})
    await solver.solve(ORIGIN, VECTOR, {})
    expect(log.filter(l => l === 'start wasm-workers')).toHaveLength(1)
    clock += RETRY_MS
    await solver.solve(ORIGIN, VECTOR, {})
    expect(log.filter(l => l === 'start wasm-workers')).toHaveLength(2)
  })

  test('with every path failed one instance has no solver, for a while, and the others do', async () => {
    const log: string[] = []
    let clock = 0
    const crash = async (puzzle: Puzzle) => {
      if (puzzle.challenge.includes('other')) throw new PathFailed('crashed')
      return { ...SOLVED, nonces: 'ok' }
    }
    const solver = new Solver(
      [fake('wasm-workers', log, { solve: crash }), fake('js-workers', log, { solve: crash })],
      undefined,
      () => clock
    )
    const theirs: Puzzle = { ...VECTOR, challenge: 'c1.1.other.tag' }
    const none = 'No solver works on this device'
    expect(((await failure(solver.solve(OTHER, theirs, {}))) as Error).message).toBe(none)
    expect(((await failure(solver.solve(OTHER, VECTOR, {}))) as Error).message).toBe(none)
    expect((await solver.solve(ORIGIN, VECTOR, {})).nonces).toBe('ok')
    clock += RETRY_MS
    expect((await solver.solve(OTHER, VECTOR, {})).nonces).toBe('ok')
  })
})

describe('what the settings show', () => {
  test('the native and wasm paths are fast, the JavaScript ones compatible', () => {
    expect(SOLVER_PATHS.map(solverLabel)).toEqual(['fast', 'fast', 'compatible', 'compatible'])
  })

  test('threads follow the cores and the puzzle speed setting', () => {
    const table: [number | undefined, 'all-but-one' | 'half' | 'one', number][] = [
      [8, 'all-but-one', 7],
      [16, 'all-but-one', 8],
      [2, 'all-but-one', 1],
      [1, 'all-but-one', 1],
      [undefined, 'all-but-one', 1],
      [8, 'half', 4],
      [3, 'half', 1],
      [32, 'half', 8],
      [1, 'half', 1],
      [8, 'one', 1],
    ]
    for (const [cores, speed, threads] of table) expect(threadsFor(cores, speed)).toBe(threads)
  })
})

const scope = globalThis as Record<string, unknown>
const KeptWorker = scope.Worker
const without = async (names: ('WebAssembly' | 'Worker')[], run: () => Promise<void>) => {
  const kept = names.map(name => [name, scope[name]] as const)
  for (const name of names) delete scope[name]
  try {
    await run()
  } finally {
    for (const [name, value] of kept) scope[name] = value
  }
}

// What the web platform will hand in: the committed module and a way to start the worker.
const env = (over: { native?: () => Promise<PathSolver | null>; threads?: number } = {}) => {
  const workers: WorkerLike[] = []
  return {
    workers,
    env: {
      native: over.native,
      wasm: async () => WASM,
      spawn: () => {
        const w = new Worker(new URL('../trust/worker.ts', import.meta.url), {
          type: 'module',
        }) as WorkerLike
        workers.push(w)
        return w
      },
      threads: over.threads ?? 2,
      bootMs: 20_000,
    },
  }
}

const realms: [string, ('WebAssembly' | 'Worker')[], SolverPath][] = [
  ['with WebAssembly and Worker', [], 'wasm-workers'],
  ['with WebAssembly removed', ['WebAssembly'], 'js-workers'],
  ['with Worker removed', ['Worker'], 'js-main'],
  ['with both removed', ['WebAssembly', 'Worker'], 'js-main'],
]

for (const [realm, missing, path] of realms)
  describe(`the web paths ${realm}`, () => {
    test(`pick ${path} and solve to the vectors' rule`, () =>
      without(missing, async () => {
        const { env: e } = env()
        const picks: SolverPath[] = []
        const solver = new Solver(webCandidates(e), p => picks.push(p))
        try {
          const first = await solver.solve(ORIGIN, VECTOR, {})
          expect(solver.path(ORIGIN)).toBe(path)
          expect(picks).toEqual([path])
          expect(verified(VECTOR, first)).toBe(true)
          const seen: number[] = []
          const second = await solver.solve(ORIGIN, SMALL, { onProgress: p => seen.push(p.solved) })
          expect(verified(SMALL, second)).toBe(true)
          expect(seen[seen.length - 1]).toBe(16)
          expect(second.tries > 0 && second.elapsedMs >= 0).toBe(true)
          expect(solver.rate()! > 0).toBe(true)
        } finally {
          solver.close()
        }
      }))

    test('one thread gives the smallest winners', () =>
      without(missing, async () => {
        const solver = new Solver(webCandidates(env({ threads: 1 }).env))
        try {
          expect((await solver.solve(ORIGIN, VECTOR, {})).nonces).toBe(v.nonces_wire)
        } finally {
          solver.close()
        }
      }))
  })

describe('the web paths', () => {
  test('the native command comes first where there is one', async () => {
    const native: PathSolver = {
      solve: async () => ({ ...SOLVED, nonces: 'native' }),
      close: () => {},
    }
    const solver = new Solver(webCandidates(env({ native: async () => native }).env))
    expect((await solver.solve(ORIGIN, VECTOR, {})).nonces).toBe('native')
    expect(solver.path(ORIGIN)).toBe('native')
    solver.close()
  })

  test('a shell without the command falls to the wasm workers', async () => {
    const solver = new Solver(webCandidates(env({ native: async () => null }).env))
    try {
      expect(verified(VECTOR, await solver.solve(ORIGIN, VECTOR, {}))).toBe(true)
      expect(solver.path(ORIGIN)).toBe('wasm-workers')
    } finally {
      solver.close()
    }
  })

  test('a module that does not load falls to JavaScript in workers', async () => {
    const { env: e } = env()
    const solver = new Solver(
      webCandidates({
        ...e,
        wasm: async () => {
          throw new Error('blocked')
        },
      })
    )
    try {
      expect(verified(VECTOR, await solver.solve(ORIGIN, VECTOR, {}))).toBe(true)
      expect(solver.path(ORIGIN)).toBe('js-workers')
    } finally {
      solver.close()
    }
  })

  test('a module that is not the solver falls to JavaScript in workers', async () => {
    const { env: e } = env()
    const empty = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])
    const solver = new Solver(webCandidates({ ...e, wasm: async () => empty }))
    try {
      expect(verified(VECTOR, await solver.solve(ORIGIN, VECTOR, {}))).toBe(true)
      expect(solver.path(ORIGIN)).toBe('js-workers')
    } finally {
      solver.close()
    }
  })

  test('workers that die in the middle of a solve hand it to the main thread', async () => {
    const { env: e, workers } = env()
    const solver = new Solver(webCandidates(e))
    try {
      await solver.solve(ORIGIN, VECTOR, {})
      expect(solver.path(ORIGIN)).toBe('wasm-workers')
      const hard: Puzzle = { challenge: 'c1.1.pick-hard.tag', k: 4, target: '4503599627370496' }
      let killed = false
      const solved = await solver.solve(ORIGIN, hard, {
        onProgress: () => {
          if (killed) return
          killed = true
          delete scope.Worker
          for (const w of workers) w.onerror?.(new Error('terminated'))
        },
      })
      expect(killed).toBe(true)
      expect(solver.path(ORIGIN)).toBe('js-main')
      expect(verified(hard, solved)).toBe(true)
    } finally {
      scope.Worker = KeptWorker
      solver.close()
    }
  })

  test('a cancelled solve stops and leaves the path chosen', async () => {
    const solver = new Solver(webCandidates(env().env))
    try {
      const abort = new AbortController()
      const never: Puzzle = { challenge: 'c1.1.pick-never.tag', k: 2, target: '1' }
      const solving = solver.solve(ORIGIN, never, {
        onProgress: () => abort.abort(),
        signal: abort.signal,
      })
      expect((await failure(solving)) instanceof SolveAborted).toBe(true)
      expect(solver.path(ORIGIN)).toBe('wasm-workers')
      expect(verified(VECTOR, await solver.solve(ORIGIN, VECTOR, {}))).toBe(true)
    } finally {
      solver.close()
    }
  })

  test('closing the solver ends its workers', async () => {
    const { env: e, workers } = env({ threads: 3 })
    const ended: number[] = []
    const solver = new Solver(
      webCandidates({
        ...e,
        spawn: () => {
          const w = e.spawn()
          const terminate = w.terminate.bind(w)
          w.terminate = () => {
            ended.push(workers.indexOf(w))
            terminate()
          }
          return w
        },
      })
    )
    await solver.solve(ORIGIN, VECTOR, {})
    expect(workers).toHaveLength(3)
    solver.close()
    expect(ended.sort()).toEqual([0, 1, 2])
  })
})
