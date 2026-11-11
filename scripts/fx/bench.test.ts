import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PREROLL_FRAMES } from '../../apps/web/app/lib/fx/particles'
import { findChrome } from '../load/lib'
import {
  budgetRows,
  drew,
  percentile,
  runBench,
  settle,
  type BenchResult,
  type RainRun,
} from './bench'

const rain = (over: Partial<RainRun> = {}): RainRun => ({
  frames: 300,
  durationMs: 5_000,
  work: { p50: 0.4, p95: 1.1, max: 3 },
  gaps: Array.from({ length: 300 }, () => 16.7),
  lateMs: 25,
  late: 0,
  steps: [{ at: 0, step: 0 }],
  startStep: 0,
  endStep: 0,
  maxLive: 150,
  sprites: 12,
  longTasks: [],
  canvasesDuring: 1,
  canvasesAfter: 0,
  canvasBytes: 4 * 1280 * 800,
  ...over,
})

const result = (over: Partial<BenchResult> = {}): BenchResult => ({
  browser: 'chromium 1.0',
  quick: false,
  desktop: {
    preroll: {
      gaps: [30, 16.7, 16.7, 16.6, 16.7, 16.7, 16.8, 16.7],
      displayMs: 16.6,
      capped: false,
    },
    full: rain(),
    idleFrames: 0,
    idleCanvases: 0,
  },
  lowEnd: {
    preroll: {
      gaps: [40, 16.7, 16.7, 16.7, 16.7, 16.7, 16.7, 16.7],
      displayMs: 16.7,
      capped: false,
    },
    first: rain({
      steps: [
        { at: 0, step: 0 },
        { at: 400, step: 1 },
        { at: 800, step: 2 },
      ],
      endStep: 2,
      canvasBytes: 2_900_000,
    }),
    next: rain({ startStep: 2, endStep: 2, steps: [{ at: 0, step: 2 }], canvasBytes: 2_900_000 }),
  },
  soak: {
    rains: 100,
    heapBefore: 5_000_000,
    heapAfter: 5_300_000,
    atlasBytes: 900_000,
    sprites: 24,
  },
  ...over,
})

describe('bench numbers', () => {
  test('percentiles of frame work are nearest-rank', () => {
    expect(percentile([], 95)).toBe(0)
    expect(percentile([5], 50)).toBe(5)
    const hundred = Array.from({ length: 100 }, (_, i) => 100 - i)
    expect(percentile(hundred, 50)).toBe(50)
    expect(percentile(hundred, 95)).toBe(95)
    expect(percentile([3, 1, 2], 50)).toBe(2)
    expect(percentile(hundred, 100)).toBe(100)
  })

  test('the throttle settles when it last changes step; late frames are counted after that', () => {
    const gaps = [16, 40, 40, 40, 16, 16, 40, 16, 16, 16]
    const run = rain({
      gaps,
      lateMs: 25,
      steps: [
        { at: 0, step: 0 },
        { at: 120, step: 1 },
      ],
    })
    expect(settle(run)).toEqual({ settledAt: 120, framesAfter: 7, lateAfter: 2, lateShare: 2 / 7 })
    expect(settle(rain())).toEqual({ settledAt: 0, framesAfter: 300, lateAfter: 0, lateShare: 0 })
  })
})

describe('what a run drew', () => {
  test('a run with no sprites says the machine has no color emoji font', () => {
    expect(drew(rain({ sprites: 12 }))).toBe('12 sprites')
    expect(drew(rain({ sprites: 0 }))).toBe('no sprites (no color emoji font here: dots only)')
  })
})

describe('budgets', () => {
  const row = (rows: ReturnType<typeof budgetRows>, name: string) =>
    rows.find(r => r.name === name)!

  test('a healthy run meets every budget', () => {
    const rows = budgetRows(result())
    expect(rows.map(r => r.name)).toEqual([
      'Frame work p95, full world, 1280x800',
      'Long tasks over 50 ms',
      'Canvases while playing, desktop',
      'Canvas memory, desktop',
      'Canvases while idle',
      'Animation frames while idle',
      'Low end: throttle settles',
      'Low end: late frames after settling',
      'Low end: the next rain starts at the settled step',
      'Canvas memory, compact',
      'Heap after 100 rains',
      'Sprite atlas',
    ])
    expect(rows.filter(r => !r.ok)).toEqual([])
    expect(row(rows, 'Frame work p95, full world, 1280x800')).toEqual({
      name: 'Frame work p95, full world, 1280x800',
      value: '1.10 ms',
      budget: '< 2 ms',
      ok: true,
    })
  })

  test('each budget fails on its own number', () => {
    const slow = budgetRows(
      result({
        desktop: { ...result().desktop, full: rain({ work: { p50: 1, p95: 2.4, max: 9 } }) },
      })
    )
    expect(slow.filter(r => !r.ok).map(r => r.name)).toEqual([
      'Frame work p95, full world, 1280x800',
    ])
    const long = budgetRows(
      result({ desktop: { ...result().desktop, full: rain({ longTasks: [61] }) } })
    )
    expect(long.filter(r => !r.ok).map(r => r.name)).toEqual(['Long tasks over 50 ms'])
    const leak = budgetRows(
      result({ desktop: { ...result().desktop, idleCanvases: 1, idleFrames: 3 } })
    )
    expect(leak.filter(r => !r.ok).map(r => r.name)).toEqual([
      'Canvases while idle',
      'Animation frames while idle',
    ])
    const big = budgetRows(
      result({
        desktop: {
          ...result().desktop,
          full: rain({ canvasBytes: 9 * 1024 * 1024, canvasesDuring: 4 }),
        },
      })
    )
    expect(big.filter(r => !r.ok).map(r => r.name)).toEqual([
      'Canvases while playing, desktop',
      'Canvas memory, desktop',
    ])
    const heap = budgetRows(
      result({
        soak: {
          rains: 100,
          heapBefore: 5_000_000,
          heapAfter: 6_200_000,
          atlasBytes: 5_000_000,
          sprites: 64,
        },
      })
    )
    expect(heap.filter(r => !r.ok).map(r => r.name)).toEqual([
      'Heap after 100 rains',
      'Sprite atlas',
    ])
  })

  test('the low-end budgets: settled within a second, under 5% late after, and the step kept', () => {
    const base = result().lowEnd
    const late = rain({
      gaps: Array.from({ length: 100 }, (_, i) => (i % 10 === 0 ? 60 : 16.7)),
      steps: [
        { at: 0, step: 0 },
        { at: 1_400, step: 1 },
      ],
      endStep: 1,
      canvasBytes: 2_900_000,
    })
    const rows = budgetRows(
      result({ lowEnd: { ...base, first: late, next: rain({ startStep: 0 }) } })
    )
    expect(rows.filter(r => !r.ok).map(r => r.name)).toEqual([
      'Low end: throttle settles',
      'Low end: late frames after settling',
      'Low end: the next rain starts at the settled step',
    ])
  })

  test('a quick run has no soak rows', () => {
    const rows = budgetRows(result({ quick: true, soak: null }))
    expect(rows.some(r => r.name === 'Heap after 100 rains')).toBe(false)
    expect(rows.some(r => r.name === 'Sprite atlas')).toBe(false)
  })
})

const exe = findChrome(
  process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright')
)

describe('the rig', () => {
  test.skipIf(!exe)(
    'runs in headless Chromium: a pre-roll, one canvas while playing, none and no frames when idle',
    async () => {
      const r = await runBench({ quick: true })
      expect(r.browser.length).toBeGreaterThan(0)
      for (const preroll of [r.desktop.preroll, r.lowEnd.preroll]) {
        expect(preroll.gaps).toHaveLength(PREROLL_FRAMES)
        expect(preroll.displayMs).toBeGreaterThan(0)
      }
      for (const run of [r.desktop.full, r.lowEnd.first, r.lowEnd.next]) {
        expect(run.frames).toBeGreaterThan(5)
        expect(run.gaps).toHaveLength(run.frames)
        expect(run.maxLive).toBeGreaterThan(0)
        expect(run.sprites).toBeGreaterThanOrEqual(0)
        expect(run.sprites).toBeLessThanOrEqual(64)
        expect(run.canvasesDuring).toBeGreaterThanOrEqual(1)
        expect(run.canvasesAfter).toBe(0)
        expect(run.canvasBytes).toBeGreaterThan(0)
      }
      expect(r.desktop.full.canvasBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
      expect(r.lowEnd.first.canvasBytes).toBeLessThanOrEqual(3 * 1024 * 1024)
      expect(r.lowEnd.next.startStep).toBe(r.lowEnd.first.endStep)
      expect(r.desktop.idleCanvases).toBe(0)
      expect(r.desktop.idleFrames).toBe(0)
      expect(r.soak).toBeNull()
      expect(budgetRows(r).length).toBeGreaterThan(8)
    },
    180_000
  )
})
