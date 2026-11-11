// The page side of the effects bench (`bench.ts` bundles this file and loads it in Chromium):
// the frame loop the app's runtime will own, cut down to what the numbers need. One throttle
// per page, kept in sessionStorage; a pre-roll of empty frames before the first effect; one
// canvas per layer, made when an effect starts and released when the world is idle.
import {
  CanvasPainter,
  SpriteAtlas,
  fitSpec,
  releaseCanvas,
  sizeCanvas,
  type CanvasLike,
} from '../../apps/web/app/lib/fx/painter'
import {
  COMPACT,
  DESKTOP,
  FxThrottle,
  FxWorld,
  PREROLL_FRAMES,
  canvasBytes,
  effectSpec,
  mulberry32,
  type EffectSpec,
} from '../../apps/web/app/lib/fx/particles'

const KEY = 'fx_throttle'
const HALLOWEEN = ['🎃', '👻', '🦇', '🕷️', '🍬', '🕸️']

export interface PageRain {
  frames: number
  durationMs: number
  work: number[]
  gaps: number[]
  lateMs: number
  steps: { at: number; step: number }[]
  startStep: number
  endStep: number
  maxLive: number
  // Glyph sprites in the tab's atlas after the run.
  sprites: number
  longTasks: number[]
  canvasesDuring: number
  canvasesAfter: number
  canvasBytes: number
}

const compact = () => matchMedia('(pointer: coarse)').matches || innerWidth < 600
const budget = () => (compact() ? COMPACT : DESKTOP)
const canvases = () => document.querySelectorAll('canvas[data-fx]').length

const saved = (): unknown => {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? 'null')
  } catch {
    return null
  }
}
const throttle = new FxThrottle(budget(), saved())
const keep = () => sessionStorage.setItem(KEY, JSON.stringify(throttle))

let atlas: SpriteAtlas | null = null
const sprites = () =>
  (atlas ??= new SpriteAtlas(
    () => document.createElement('canvas') as CanvasLike,
    Math.min(devicePixelRatio, compact() ? 1.5 : 2),
    getComputedStyle(document.body).color
  ))

let requested = 0
const frame = (cb: FrameRequestCallback) => {
  requested += 1
  return requestAnimationFrame(cb)
}

const longTasks: number[] = []
try {
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) longTasks.push(entry.duration)
  }).observe({ type: 'longtask' })
} catch {
  // No long task timing in this browser.
}

// Empty frames, nothing drawn: the gaps the refresh baseline is measured from.
const preroll = () =>
  new Promise<{ gaps: number[]; displayMs: number; capped: boolean }>(done => {
    const gaps: number[] = []
    let last = performance.now()
    const tick = (now: number) => {
      gaps.push(Math.max(0, now - last))
      last = now
      if (gaps.length < PREROLL_FRAMES) frame(tick)
      else {
        throttle.calibrate(gaps)
        keep()
        done({ gaps, displayMs: throttle.displayMs, capped: throttle.capped })
      }
    }
    frame(tick)
  })

const layer = () => {
  const host = document.getElementById('host')!
  const { width, height } = host.getBoundingClientRect()
  const canvas = document.createElement('canvas')
  canvas.dataset.fx = ''
  canvas.setAttribute('aria-hidden', 'true')
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none'
  const scale = sizeCanvas(canvas as CanvasLike, width, height, devicePixelRatio, compact())
  host.append(canvas)
  const world = new FxWorld(width, height, budget(), mulberry32(7), throttle)
  const painter = new CanvasPainter((canvas as CanvasLike).getContext('2d')!, sprites(), scale)
  const start = (spec: EffectSpec) => {
    const fitted = fitSpec(spec, sprites())
    const id = world.start(fitted)
    if (id !== null) painter.bind(id, fitted.glyphs)
    return id
  }
  const release = () => {
    releaseCanvas(canvas as CanvasLike)
    canvas.remove()
  }
  return { world, painter, start, release, bytes: canvasBytes(width, height, scale) }
}

const season = (duration: number): EffectSpec => ({
  ...effectSpec('season:halloween', { season: { glyphs: HALLOWEEN, dots: [], motion: 'fall' } }),
  duration,
})

// One effect run on animation frames: a rain of `seconds`. `full` keeps the world at its caps
// for that long: two rains and a burst started again whenever there is room.
const rain = (kind: 'season' | 'full', seconds: number) =>
  new Promise<PageRain>(done => {
    const { world, painter, start, release, bytes } = layer()
    const startStep = throttle.step
    const steps = [{ at: 0, step: throttle.step }]
    const work: number[] = []
    const gaps: number[] = []
    const tasksBefore = longTasks.length
    let maxLive = 0
    let during = 0
    const began = performance.now()
    let last = began
    const feed = () => {
      if (kind === 'season') return
      if (performance.now() - began > seconds * 1000) return
      while (world.running < 2 && start(season(seconds)) !== null);
      start(effectSpec('fireworks', {}))
    }
    start(season(seconds))
    feed()
    const tick = (now: number) => {
      const gap = Math.max(0, now - last)
      last = now
      const t0 = performance.now()
      feed()
      world.step(gap / 1000)
      world.paint(painter)
      const spent = performance.now() - t0
      world.observe(spent, gap)
      work.push(spent)
      gaps.push(gap)
      maxLive = Math.max(maxLive, world.live)
      during = Math.max(during, canvases())
      if (throttle.step !== steps[steps.length - 1].step)
        steps.push({ at: Math.max(0, Math.round(now - began)), step: throttle.step })
      if (!world.idle) {
        frame(tick)
        return
      }
      release()
      keep()
      done({
        frames: work.length,
        durationMs: Math.max(0, Math.round(now - began)),
        work,
        gaps,
        lateMs: throttle.lateMs,
        steps,
        startStep,
        endStep: throttle.step,
        maxLive,
        sprites: sprites().size,
        longTasks: longTasks.slice(tasksBefore),
        canvasesDuring: during,
        canvasesAfter: canvases(),
        canvasBytes: bytes,
      })
    }
    frame(tick)
  })

// What an idle page does: no frames asked for, no canvas held.
const idle = (ms: number) =>
  new Promise<{ frames: number; canvases: number }>(done => {
    const before = requested
    setTimeout(() => done({ frames: requested - before, canvases: canvases() }), ms)
  })

// Many rains run back to back without waiting for frames (5 s of steps each), to see what stays
// in memory. The throttle is left alone.
const soak = (rains: number) => {
  for (let i = 0; i < rains; i++) {
    const { world, painter, start, release } = layer()
    start(season(5))
    for (let f = 0; f < 400 && !world.idle; f++) {
      world.step(1 / 60)
      world.paint(painter)
    }
    release()
  }
  return { rains, atlasBytes: sprites().bytes, sprites: sprites().size, canvases: canvases() }
}

const reset = () => {
  throttle.reset()
  keep()
}

const api = { preroll, rain, idle, soak, reset }
export type FxBench = typeof api
;(window as unknown as { fxBench: FxBench }).fxBench = api
