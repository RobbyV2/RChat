import {
  PathFailed,
  SolveAborted,
  bootWorker,
  jsRunner,
  solveWith,
  workerRunner,
  type SolveOpts,
  type WorkerLike,
} from './pool'
import { seedOf, type Puzzle, type Solved } from './solve_js'

// Which solver a device uses. The paths, best first: the shell's native command, wasm in
// workers, JavaScript in workers, JavaScript on the main thread in short slices. The choice is
// made by trying each (never by user agent) and made again when the chosen path fails.

export type SolverPath = 'native' | 'wasm-workers' | 'js-workers' | 'js-main'

export const SOLVER_PATHS: readonly SolverPath[] = [
  'native',
  'wasm-workers',
  'js-workers',
  'js-main',
]

// What Settings shows: "Solver: fast" or "Solver: compatible".
export const solverLabel = (path: SolverPath): 'fast' | 'compatible' =>
  path === 'native' || path === 'wasm-workers' ? 'fast' : 'compatible'

export type PuzzleSpeed = 'all-but-one' | 'half' | 'one'

const THREADS_MAX = 8

// Solver threads for a device with `cores` (navigator.hardwareConcurrency) and its puzzle speed
// setting.
export const threadsFor = (cores: number | undefined, speed: PuzzleSpeed): number => {
  const all = Math.max(1, Math.floor(cores ?? 1))
  const wanted = speed === 'one' ? 1 : speed === 'half' ? Math.floor(all / 2) : all - 1
  return Math.min(THREADS_MAX, Math.max(1, wanted))
}

export interface PathSolver {
  solve(puzzle: Puzzle, opts: SolveOpts): Promise<Solved>
  close(): void
}

export interface Candidate {
  path: SolverPath
  // Brings the path up by trying it. Null, or a throw, when it can't run here.
  start(): Promise<PathSolver | null>
}

// A challenge this app can't solve: it is the challenge that is wrong, not a solver.
export class BadPuzzle extends Error {
  constructor() {
    super('This challenge is not one this app can solve')
    this.name = 'BadPuzzle'
  }
}

const CHALLENGE_MAX = 4096
const K_MAX = 64
const LAST = (BigInt(1) << BigInt(64)) - BigInt(1)

// What an instance sends as a challenge, checked before any solver sees it: the sealed string
// in printable ASCII and at most 4,096 bytes, 0 to 64 sub-puzzles, a decimal target from 1 to
// 2^64 - 1.
export const checkPuzzle = (puzzle: unknown): Puzzle => {
  const p = typeof puzzle === 'object' && puzzle !== null ? (puzzle as Record<string, unknown>) : {}
  const { challenge, k, target } = p
  if (
    typeof challenge !== 'string' ||
    challenge.length > CHALLENGE_MAX ||
    !/^[\x21-\x7e]+$/.test(challenge) ||
    typeof k !== 'number' ||
    !Number.isInteger(k) ||
    k < 0 ||
    k > K_MAX ||
    typeof target !== 'string' ||
    !/^[0-9]{1,20}$/.test(target) ||
    BigInt(target) < BigInt(1) ||
    BigInt(target) > LAST
  )
    throw new BadPuzzle()
  return { challenge, k, target }
}

// The first path, in order, that starts and isn't in `skip`. `couldNot` hears of each path that
// was tried and did not start.
export const pickSolver = async (
  candidates: readonly Candidate[],
  skip: ReadonlySet<SolverPath> = new Set(),
  couldNot?: (path: SolverPath) => void
): Promise<{ path: SolverPath; solver: PathSolver } | null> => {
  for (const path of SOLVER_PATHS) {
    const candidate = skip.has(path) ? undefined : candidates.find(c => c.path === path)
    if (!candidate) continue
    const solver = await candidate.start().catch(() => null)
    if (solver) return { path, solver }
    couldNot?.(path)
  }
  return null
}

// How long a path that failed for an instance is left alone before it is tried again. A page
// load forgets it too: nothing here is stored.
export const RETRY_MS = 5 * 60_000

// The solver of a device. For each instance origin it decides on first use and keeps its path.
// A challenge is checked first, and a bad one fails only its own solve. A path counts as failed
// only when the path itself broke (`PathFailed`: it could not start, or it stopped in a solve),
// and only for the instance it broke for: that instance moves to the next path and comes back
// to this one after `RETRY_MS`.
export class Solver {
  private started = new Map<SolverPath, PathSolver>()
  private failed = new Map<string, Map<SolverPath, number>>()
  private chosen = new Map<string, SolverPath>()
  private last: number | null = null

  constructor(
    private candidates: readonly Candidate[],
    private onPick?: (path: SolverPath, origin: string) => void,
    private now: () => number = () => Date.now()
  ) {}

  path(origin: string): SolverPath | null {
    return this.chosen.get(origin) ?? null
  }

  // Tries per second per thread in the last solve.
  rate(): number | null {
    return this.last
  }

  async solve(origin: string, puzzle: Puzzle, opts: SolveOpts = {}): Promise<Solved> {
    const checked = checkPuzzle(puzzle)
    for (;;) {
      if (opts.signal?.aborted) throw new SolveAborted()
      const picked = await this.pick(origin)
      if (!picked) {
        this.chosen.delete(origin)
        throw new Error('No solver works on this device')
      }
      const { path, solver } = picked
      if (this.chosen.get(origin) !== path) {
        this.chosen.set(origin, path)
        this.onPick?.(path, origin)
      }
      try {
        const solved = await solver.solve(checked, opts)
        if (solved.elapsedMs > 0)
          this.last = Math.round(
            (solved.tries / solved.elapsedMs / Math.max(1, solved.threads)) * 1000
          )
        return solved
      } catch (e) {
        if (!(e instanceof PathFailed)) throw e
        this.fail(origin, path)
        if (this.started.get(path) === solver) this.started.delete(path)
        solver.close()
      }
    }
  }

  close(): void {
    for (const solver of this.started.values()) solver.close()
    this.started.clear()
    this.chosen.clear()
  }

  private fail(origin: string, path: SolverPath): void {
    const paths = this.failed.get(origin) ?? new Map<SolverPath, number>()
    paths.set(path, this.now() + RETRY_MS)
    this.failed.set(origin, paths)
  }

  // The first path that is not failed for this instance, started once and shared by all.
  private async pick(origin: string): Promise<{ path: SolverPath; solver: PathSolver } | null> {
    const failed = this.failed.get(origin)
    const now = this.now()
    const skip = new Set(SOLVER_PATHS.filter(path => (failed?.get(path) ?? 0) > now))
    const shared = this.candidates.map(c => ({
      path: c.path,
      start: async () => this.started.get(c.path) ?? c.start(),
    }))
    const picked = await pickSolver(shared, skip, path => this.fail(origin, path))
    if (picked) this.started.set(picked.path, picked.solver)
    return picked
  }
}

export interface WebEnv {
  // The shell's native solver, where there is a shell; null when the command is missing.
  native?: () => Promise<PathSolver | null>
  // The bytes of the committed module (/pow/rchat_pow.wasm).
  wasm: () => Promise<Uint8Array>
  // A new solver worker (lib/trust/worker.ts).
  spawn: () => WorkerLike
  threads: number
  bootMs?: number
}

const EXPORTS = ['memory', 'pow_chunk', 'seed_ptr']
const BOOT_MS = 5000
const SLICE_MS = 12

// Compiles the module here, to learn whether this device runs it at all.
const solverModule = async (load: () => Promise<Uint8Array>): Promise<Uint8Array> => {
  const bytes = Uint8Array.from(await load())
  const module = await WebAssembly.compile(bytes)
  const names = WebAssembly.Module.exports(module).map(e => e.name)
  if (WebAssembly.Module.imports(module).length > 0 || EXPORTS.some(n => !names.includes(n)))
    throw new Error('Not the solver module')
  return bytes
}

const workers = async (env: WebEnv, wasm: Uint8Array | null): Promise<PathSolver> => {
  const started: WorkerLike[] = []
  const close = () => {
    for (const worker of started) worker.terminate()
  }
  try {
    for (let i = 0; i < Math.max(1, env.threads); i += 1) started.push(env.spawn())
    await Promise.all(started.map(w => bootWorker(w, wasm, env.bootMs ?? BOOT_MS)))
  } catch (e) {
    close()
    throw e
  }
  return {
    solve: (puzzle, opts) => {
      const seed = seedOf(puzzle.challenge)
      const target = BigInt(puzzle.target)
      return solveWith(
        started.map(w => workerRunner(w, seed, target, { signal: opts.signal })),
        puzzle.k,
        opts
      )
    },
    close,
  }
}

const mainThread: PathSolver = {
  solve: (puzzle, opts) => {
    const runner = jsRunner(seedOf(puzzle.challenge), BigInt(puzzle.target), {
      sliceMs: SLICE_MS,
      signal: opts.signal,
    })
    return solveWith([runner], puzzle.k, opts)
  },
  close: () => {},
}

// The four paths of the web app and the shells.
export const webCandidates = (env: WebEnv): Candidate[] => [
  { path: 'native', start: async () => (env.native ? env.native() : null) },
  { path: 'wasm-workers', start: async () => workers(env, await solverModule(env.wasm)) },
  { path: 'js-workers', start: () => workers(env, null) },
  { path: 'js-main', start: async () => mainThread },
]
