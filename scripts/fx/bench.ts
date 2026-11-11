// The effects bench: bundles the engine and the painter (`bench_page.ts`) into a page held in
// memory and runs it in headless Chromium.
//   desktop  1280x800: the pre-roll, a full world for 5 s, then an idle page
//   low end  390x844 at 3 device pixels, CPU slowed 6 times, no GPU rasterization: the
//            pre-roll, a 5 s rain, then the next rain
//   soak     100 rains back to back, the heap before and after
// It prints the numbers against the budgets.
//   bun scripts/fx/bench.ts [--quick] [--strict] [--json]
// --quick: short rains, no soak. --strict: exit 1 when a budget is missed.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright-core'
import { findChrome } from '../load/lib'
import type { FxBench, PageRain } from './bench_page'

const ORIGIN = 'http://fx-bench.test'
const MB = 1024 * 1024

export interface Preroll {
  gaps: number[]
  displayMs: number
  capped: boolean
}

export interface RainRun extends Omit<PageRain, 'work'> {
  work: { p50: number; p95: number; max: number }
  // Frames later than `lateMs`.
  late: number
}

export interface BenchResult {
  browser: string
  quick: boolean
  desktop: { preroll: Preroll; full: RainRun; idleFrames: number; idleCanvases: number }
  lowEnd: { preroll: Preroll; first: RainRun; next: RainRun }
  soak: {
    rains: number
    heapBefore: number
    heapAfter: number
    atlasBytes: number
    sprites: number
  } | null
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
}

// When the throttle last changed step, and the late frames after that.
export function settle(run: Pick<RainRun, 'gaps' | 'lateMs' | 'steps'>) {
  const settledAt = run.steps[run.steps.length - 1].at
  let at = 0
  let framesAfter = 0
  let lateAfter = 0
  for (const gap of run.gaps) {
    at += gap
    if (at <= settledAt) continue
    framesAfter += 1
    if (gap > run.lateMs) lateAfter += 1
  }
  return { settledAt, framesAfter, lateAfter, lateShare: framesAfter ? lateAfter / framesAfter : 0 }
}

export interface BudgetRow {
  name: string
  value: string
  budget: string
  ok: boolean
}

const ms = (n: number) => `${n.toFixed(2)} ms`
const mb = (n: number) => `${(n / MB).toFixed(2)} MB`

// The budgets of the effects design, against a run.
export function budgetRows(r: BenchResult): BudgetRow[] {
  const { full } = r.desktop
  const { first, next } = r.lowEnd
  const settled = settle(first)
  const longest = Math.max(0, ...full.longTasks, ...first.longTasks, ...next.longTasks)
  const rows: BudgetRow[] = [
    {
      name: 'Frame work p95, full world, 1280x800',
      value: ms(full.work.p95),
      budget: '< 2 ms',
      ok: full.work.p95 < 2,
    },
    {
      name: 'Long tasks over 50 ms',
      value: longest > 50 ? `${Math.round(longest)} ms` : 'none',
      budget: 'none',
      ok: longest <= 50,
    },
    {
      name: 'Canvases while playing, desktop',
      value: String(full.canvasesDuring),
      budget: 'at most 3',
      ok: full.canvasesDuring <= 3,
    },
    {
      name: 'Canvas memory, desktop',
      value: mb(full.canvasBytes),
      budget: '<= 8 MB',
      ok: full.canvasBytes <= 8 * MB,
    },
    {
      name: 'Canvases while idle',
      value: String(Math.max(r.desktop.idleCanvases, full.canvasesAfter, first.canvasesAfter)),
      budget: '0',
      ok: r.desktop.idleCanvases === 0 && full.canvasesAfter === 0 && first.canvasesAfter === 0,
    },
    {
      name: 'Animation frames while idle',
      value: String(r.desktop.idleFrames),
      budget: '0',
      ok: r.desktop.idleFrames === 0,
    },
    {
      name: 'Low end: throttle settles',
      value: `step ${first.endStep} at ${settled.settledAt} ms`,
      budget: 'within 1000 ms',
      ok: settled.settledAt <= 1000,
    },
    {
      name: 'Low end: late frames after settling',
      value: `${(settled.lateShare * 100).toFixed(1)}% (${settled.lateAfter} of ${settled.framesAfter})`,
      budget: '< 5%',
      ok: settled.lateShare < 0.05,
    },
    {
      name: 'Low end: the next rain starts at the settled step',
      value: `step ${next.startStep} after step ${first.endStep}`,
      budget: 'the same step',
      ok: next.startStep === first.endStep,
    },
    {
      name: 'Canvas memory, compact',
      value: mb(first.canvasBytes),
      budget: '<= 3 MB',
      ok: first.canvasBytes <= 3 * MB,
    },
  ]
  if (r.soak)
    rows.push(
      {
        name: `Heap after ${r.soak.rains} rains`,
        value: `${r.soak.heapAfter >= r.soak.heapBefore ? '+' : '-'}${mb(Math.abs(r.soak.heapAfter - r.soak.heapBefore))}`,
        budget: '< 1 MB',
        ok: r.soak.heapAfter - r.soak.heapBefore < MB,
      },
      {
        name: 'Sprite atlas',
        value: `${mb(r.soak.atlasBytes)} in ${r.soak.sprites} sprites`,
        budget: '< 4 MB',
        ok: r.soak.atlasBytes < 4 * MB,
      }
    )
  return rows
}

const summed = (rain: PageRain): RainRun => {
  const { work, ...rest } = rain
  return {
    ...rest,
    work: { p50: percentile(work, 50), p95: percentile(work, 95), max: Math.max(0, ...work) },
    late: rain.gaps.filter(gap => gap > rain.lateMs).length,
  }
}

async function bundle() {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, 'bench_page.ts')],
    target: 'browser',
    format: 'iife',
  })
  if (!built.success) throw new Error(built.logs.map(String).join('\n'))
  return built.outputs[0].text()
}

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Effects bench</title>
<style>html,body{height:100%;margin:0;background:#141218;color:#e6e0e9}#host{position:relative;height:100%;overflow:hidden}</style>
</head><body><div id="host"></div><script src="/bench.js"></script></body></html>`

async function open(browser: Browser, script: string, compact: boolean): Promise<Page> {
  const context = await browser.newContext(
    compact
      ? {
          viewport: { width: 390, height: 844 },
          deviceScaleFactor: 3,
          isMobile: true,
          hasTouch: true,
        }
      : { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 }
  )
  const page = await context.newPage()
  await page.route(`${ORIGIN}/**`, route =>
    route.request().url().endsWith('/bench.js')
      ? route.fulfill({ contentType: 'text/javascript', body: script })
      : route.fulfill({ contentType: 'text/html', body: HTML })
  )
  await page.goto(`${ORIGIN}/`)
  await page.waitForFunction(() => 'fxBench' in window)
  return page
}

// A page whose frames stop would wait for ever: every call gives up after a minute.
const STEP_MS = 60_000

const call = <K extends keyof FxBench>(page: Page, name: K, ...args: Parameters<FxBench[K]>) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`bench: ${name} did not finish in ${STEP_MS / 1000} s`)),
      STEP_MS
    )
  })
  const ran = page.evaluate(
    ([fn, rest]) =>
      (window as unknown as { fxBench: Record<string, (...a: unknown[]) => unknown> }).fxBench[fn](
        ...rest
      ),
    [name, args] as [string, unknown[]]
  ) as Promise<Awaited<ReturnType<FxBench[K]>>>
  return Promise.race([ran, stalled]).finally(() => clearTimeout(timer))
}

const heap = async (page: Page) => {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('HeapProfiler.collectGarbage')
  const { usedSize } = await cdp.send('Runtime.getHeapUsage')
  await cdp.detach()
  return usedSize
}

type Say = (step: string) => void

async function desktopRun(browser: Browser, script: string, quick: boolean, say: Say) {
  const page = await open(browser, script, false)
  say('desktop: pre-roll')
  const preroll = await call(page, 'preroll')
  say('desktop: full world')
  const full = summed(await call(page, 'rain', 'full', quick ? 1 : 5))
  say('desktop: idle')
  const idle = await call(page, 'idle', 500)
  let soak: BenchResult['soak'] = null
  if (!quick) {
    say('desktop: soak')
    await call(page, 'soak', 3)
    const heapBefore = await heap(page)
    const done = await call(page, 'soak', 100)
    const heapAfter = await heap(page)
    soak = {
      rains: done.rains,
      heapBefore,
      heapAfter,
      atlasBytes: done.atlasBytes,
      sprites: done.sprites,
    }
  }
  return { desktop: { preroll, full, idleFrames: idle.frames, idleCanvases: idle.canvases }, soak }
}

async function lowEndRun(browser: Browser, script: string, quick: boolean, say: Say) {
  const page = await open(browser, script, true)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 })
  say('low end: pre-roll')
  const preroll = await call(page, 'preroll')
  say('low end: first rain')
  const first = summed(await call(page, 'rain', 'season', quick ? 1 : 5))
  say('low end: next rain')
  const next = summed(await call(page, 'rain', 'season', quick ? 1 : 5))
  return { preroll, first, next }
}

export async function runBench(
  opts: { quick?: boolean; progress?: Say } = {}
): Promise<BenchResult> {
  const quick = opts.quick ?? false
  const say = opts.progress ?? (() => {})
  const browsers =
    process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright')
  const exe = findChrome(browsers)
  if (!exe) throw new Error(`no Chromium under ${browsers}`)
  const script = await bundle()
  const within = async <T>(args: string[], run: (browser: Browser) => Promise<T>) => {
    const browser = await chromium.launch({ headless: true, executablePath: exe, args })
    try {
      return { version: `chromium ${browser.version()}`, out: await run(browser) }
    } finally {
      await browser.close()
    }
  }
  const first = await within([], b => desktopRun(b, script, quick, say))
  const second = await within(['--disable-gpu-rasterization'], b =>
    lowEndRun(b, script, quick, say)
  )
  return { browser: first.version, quick, ...first.out, lowEnd: second.out }
}

// A machine with no color emoji font draws the fallback dots, not sprites.
export const drew = (run: Pick<RainRun, 'sprites'>) =>
  run.sprites ? `${run.sprites} sprites` : 'no sprites (no color emoji font here: dots only)'

const line = (run: RainRun) =>
  `${run.frames} frames in ${run.durationMs} ms, work p50 ${ms(run.work.p50)} p95 ${ms(run.work.p95)} max ${ms(run.work.max)}, ` +
  `${run.late} late (over ${run.lateMs.toFixed(1)} ms), steps ${run.steps.map(s => `${s.step}@${s.at}`).join(' ')}, ` +
  `up to ${run.maxLive} particles, ${drew(run)}, ${run.longTasks.length} long tasks`

async function main(args: string[]) {
  const r = await runBench({
    quick: args.includes('--quick'),
    progress: step => console.error(step),
  })
  const rows = budgetRows(r)
  if (args.includes('--json')) console.log(JSON.stringify({ ...r, budgets: rows }, null, 2))
  else {
    const pre = (p: Preroll) =>
      `refresh ${p.displayMs.toFixed(2)} ms${p.capped ? ', capped' : ''} (gaps ${p.gaps.map(g => g.toFixed(1)).join(' ')})`
    console.log(r.browser)
    console.log(`desktop pre-roll: ${pre(r.desktop.preroll)}`)
    console.log(`desktop full world: ${line(r.desktop.full)}`)
    console.log(`low end pre-roll: ${pre(r.lowEnd.preroll)}`)
    console.log(`low end first rain: ${line(r.lowEnd.first)}`)
    console.log(`low end next rain: ${line(r.lowEnd.next)}`)
    for (const row of rows)
      console.log(`${row.ok ? 'ok  ' : 'MISS'} ${row.name}: ${row.value} (budget ${row.budget})`)
  }
  if (args.includes('--strict') && rows.some(row => !row.ok)) process.exit(1)
}

if (import.meta.main) await main(process.argv.slice(2))
