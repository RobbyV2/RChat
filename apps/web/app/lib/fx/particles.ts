// The effect engine: a pure particle world the app steps on one shared animation frame and
// paints through a Painter (a canvas in the app, a recorder in tests). Seeded, so a test replays
// exactly.
import type { Motion } from './seasons'

export const mulberry32 = (seed: number) => () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export interface Budget {
  // Live particles per rain, per burst, and in the whole world.
  rain: number
  burst: number
  live: number
  // At most this many effects at once (a new one past it is dropped, not queued).
  effects: number
  // Average frame work (step + paint) above this steps the throttle down; above `stopMs` for
  // `stopFrames` frames in a row, or frames arriving late (past `FxThrottle.lateMs`, against the
  // pre-roll's refresh) for `lateFrames` in a row (raster and compositing the work time can't
  // see), it steps down and every effect fades out.
  slowMs: number
  stopMs: number
  stopFrames: number
  lateFrames: number
}

export const DESKTOP: Budget = {
  rain: 48,
  burst: 60,
  live: 160,
  effects: 3,
  slowMs: 4,
  stopMs: 8,
  stopFrames: 15,
  lateFrames: 10,
}
// Phones and small or coarse-pointer screens.
export const COMPACT: Budget = {
  rain: 24,
  burst: 30,
  live: 80,
  effects: 2,
  slowMs: 4,
  stopMs: 8,
  stopFrames: 15,
  lateFrames: 10,
}

// The throttle: one per tab, shared by every world and kept across effects (the runtime saves
// it in sessionStorage), so a slow device janks once, not on every rain.
// Step 0 is the full budget, 1 halves it, 2 quarters it and allows bursts only, 3 plays nothing
// for the rest of the tab's session. Five minutes of effect frames without a late one step back.
export const THROTTLE_SCALE = [1, 0.5, 0.25, 0] as const
const RECOVER_MS = 300_000
const NOMINAL_MS = 1000 / 60

// The refresh baseline: a short pre-roll of empty animation frames (no canvas, no
// drawing) before the tab's first effect, so a device that is slow from an effect's first frame
// still reads as late. The first gap is dropped (it includes scheduling), gaps under 4 ms are
// noise, and the smallest of the rest is the refresh interval. A pre-roll already at 30 fps or
// slower means the display or the OS caps animation (iOS Low Power Mode, a 30 Hz panel): the tab
// is `capped` and treated as low power (still pictures), instead of stepping down to nothing.
export const PREROLL_FRAMES = 8
export function measureRefresh(
  gaps: readonly number[]
): { displayMs: number; capped: boolean } | null {
  const usable = gaps.slice(1).filter(g => g >= 4 && Number.isFinite(g))
  if (usable.length < 4) return null
  const displayMs = Math.min(...usable)
  return { displayMs, capped: displayMs > 1.5 * NOMINAL_MS }
}

export class FxThrottle {
  step: 0 | 1 | 2 | 3
  displayMs = NOMINAL_MS
  calibrated = false
  capped = false
  private ema = 0
  private slowRun = 0
  private lateRun = 0
  private goodMs = 0

  constructor(
    readonly budget: Budget,
    saved?: unknown
  ) {
    const o = (saved ?? {}) as { step?: unknown; displayMs?: unknown; capped?: unknown }
    const n = o.step
    this.step = n === 1 || n === 2 || n === 3 ? n : 0
    if (typeof o.displayMs === 'number' && o.displayMs >= 4 && o.displayMs <= 100) {
      this.displayMs = o.displayMs
      this.calibrated = true
      this.capped = o.capped === true
    }
  }

  get scale() {
    return THROTTLE_SCALE[this.step]
  }
  get rains() {
    return this.step < 2
  }
  get off() {
    return this.step === 3
  }
  // A frame is late past 1.5 refresh intervals, and never under 20 ms (so a 120 Hz screen
  // running an effect at 60 fps is not late).
  get lateMs() {
    return Math.max(1.5 * this.displayMs, 20)
  }

  // From the pre-roll's frame gaps; false when there were too few to tell (try again later).
  calibrate(gaps: readonly number[]): boolean {
    const m = measureRefresh(gaps)
    if (!m) return false
    this.displayMs = m.displayMs
    this.capped = m.capped
    this.calibrated = true
    return true
  }

  // Returns true when it stepped down (callers fade what is playing). The average of work starts
  // from 0 and leaves out the frame an effect starts in (`starting`), so one slow first frame
  // does not halve the budget; a steady 5 ms device still crosses 4 ms in 16 frames.
  observe(workMs: number, gapMs = 0, starting = false): boolean {
    if (!starting) this.ema = this.ema * 0.9 + workMs * 0.1
    this.slowRun = workMs > this.budget.stopMs ? this.slowRun + 1 : 0
    const late = gapMs > this.lateMs
    this.lateRun = late ? this.lateRun + 1 : 0
    this.goodMs = late ? 0 : this.goodMs + gapMs
    if (this.slowRun >= this.budget.stopFrames || this.lateRun >= this.budget.lateFrames) {
      this.down()
      return true
    }
    if (this.step === 0 && this.ema > this.budget.slowMs) this.step = 1
    if (this.goodMs >= RECOVER_MS && this.step > 0 && this.step < 3) {
      this.step = (this.step - 1) as 0 | 1 | 2
      this.goodMs = 0
    }
    return false
  }

  // The settings line's Reset: full budget again; the refresh baseline stays.
  reset() {
    this.step = 0
    this.slowRun = 0
    this.lateRun = 0
    this.goodMs = 0
    this.ema = 0
  }

  private down() {
    this.step = Math.min(3, this.step + 1) as 0 | 1 | 2 | 3
    this.slowRun = 0
    this.lateRun = 0
    this.goodMs = 0
    this.ema = 0
  }

  toJSON() {
    return this.calibrated
      ? { step: this.step, displayMs: this.displayMs, capped: this.capped }
      : { step: this.step }
  }
}

// One step never advances more than this, so a throttled or resumed frame never jumps.
export const DT_MAX_S = 0.05

export type EffectShape = 'rain' | 'burst' | 'confetti' | 'walk'

export interface EffectSpec {
  shape: EffectShape
  motion: Motion
  glyphs: string[]
  // Plain colored pieces (confetti paper, Holi powder).
  dots?: string[]
  // Rain and walk: how long new particles keep coming (s). Bursts are instant.
  duration?: number
  // Bursts: the origin in layer pixels (a reaction chip's center), else random points.
  origin?: { x: number; y: number }
  // Bursts: how many origins (fireworks), each `burst / origins` particles.
  origins?: number
  // Reduced motion: no movement, a fade in and out of a still scatter.
  still?: boolean
  // Particle size in CSS px (default 22 for glyphs, 7 for dots).
  size?: number
}

export interface Particle {
  effect: number
  glyph: number
  dot: string | null
  x: number
  y: number
  vx: number
  vy: number
  rot: number
  vr: number
  size: number
  age: number
  life: number
  sway: number
  phase: number
  alpha: number
}

export interface Painter {
  // The glyph list is fixed per effect; the painter renders each glyph once (sprite atlas).
  begin(w: number, h: number): void
  glyph(
    effect: number,
    glyph: number,
    x: number,
    y: number,
    size: number,
    rot: number,
    alpha: number
  ): void
  dot(
    color: string,
    x: number,
    y: number,
    size: number,
    rot: number,
    flip: number,
    alpha: number
  ): void
  end(): void
}

interface Effect {
  id: number
  spec: EffectSpec
  cap: number
  spawned: number
  total: number
  age: number
  fade: number | null
  done: boolean
}

const GRAVITY = 520
// Rains stop by themselves within 5 s (WCAG 2.2.2's line for motion that starts on its own).
export const RAIN_S = 5
// Paper confetti turns front to back at FLIP_RAD_S / pi times a second: under 3 (WCAG 2.3.1).
export const FLIP_RAD_S = 6
const FADE_S = 0.3

export class FxWorld {
  private effects = new Map<number, Effect>()
  private parts: Particle[] = []
  private next = 1
  // An effect started since the last observed frame.
  private starting = false

  constructor(
    public w: number,
    public h: number,
    readonly budget: Budget,
    private rng: () => number = Math.random,
    readonly throttle: FxThrottle = new FxThrottle(budget)
  ) {}

  get live() {
    return this.parts.length
  }
  get running() {
    return this.effects.size
  }
  get idle() {
    return this.effects.size === 0 && this.parts.length === 0
  }

  resize(w: number, h: number) {
    this.w = w
    this.h = h
  }

  // Returns the effect id, or null when the world is full or the layer has no room.
  start(spec: EffectSpec): number | null {
    if (this.effects.size >= this.budget.effects || this.w < 1 || this.h < 1) return null
    if (this.throttle.off) return null
    if ((spec.shape === 'rain' || spec.shape === 'walk') && !this.throttle.rains) return null
    const id = this.next++
    const per =
      spec.shape === 'rain' || spec.shape === 'walk' ? this.budget.rain : this.budget.burst
    const cap = spec.shape === 'walk' ? 1 : spec.still ? Math.min(12, per) : per
    const total =
      spec.shape === 'walk' || spec.still || spec.shape !== 'rain' ? cap : Math.round(cap * 1.6)
    this.effects.set(id, { id, spec, cap, spawned: 0, total, age: 0, fade: null, done: false })
    this.starting = true
    if (spec.shape !== 'rain' && spec.shape !== 'walk') this.spawnBurst(this.effects.get(id)!)
    return id
  }

  // Stops new particles and fades the live ones out (scroll, typing, the host emptying).
  stop(id?: number) {
    for (const e of this.effects.values()) if (id === undefined || e.id === id) e.fade ??= 0
  }

  // Ends at once (page hidden, call started, setting turned off).
  clear() {
    this.effects.clear()
    this.parts = []
  }

  // Frame feedback from the app: step + paint time, and the gap since the previous frame.
  observe(workMs: number, gapMs?: number) {
    const starting = this.starting
    this.starting = false
    if (this.throttle.observe(workMs, gapMs, starting)) this.stop()
  }

  step(dtIn: number) {
    const dt = Math.min(Math.max(dtIn, 0), DT_MAX_S)
    for (const e of this.effects.values()) {
      e.age += dt
      if (e.fade !== null) e.fade += dt
      if (e.spec.shape === 'rain' || e.spec.shape === 'walk') {
        this.spawnRain(e, dt)
        // Every rain is over by its duration: what is still falling fades out then.
        if (e.fade === null && e.age >= (e.spec.duration ?? RAIN_S)) e.fade = 0
      }
    }
    const keep: Particle[] = []
    for (const p of this.parts) {
      const e = this.effects.get(p.effect)
      if (!e) continue
      p.age += dt
      this.move(p, e.spec, dt)
      const fadeOut = e.fade === null ? 1 : Math.max(0, 1 - e.fade / FADE_S)
      p.alpha = Math.min(this.lifeAlpha(p, e.spec), fadeOut)
      if (p.alpha > 0 && p.age < p.life && this.inside(p)) keep.push(p)
    }
    this.parts = keep
    for (const e of this.effects.values()) {
      const left = this.parts.some(p => p.effect === e.id)
      // A burst spawns once, when it starts (fewer than its cap when throttled or short of
      // room); only a rain still has particles to come.
      const rains = e.spec.shape === 'rain' || e.spec.shape === 'walk'
      const spawning = rains && e.spawned < e.total && e.fade === null
      if (!left && (!spawning || (e.fade !== null && e.fade >= FADE_S))) this.effects.delete(e.id)
    }
  }

  paint(painter: Painter) {
    painter.begin(this.w, this.h)
    for (const p of this.parts) {
      const flip = Math.cos(p.phase + p.age * FLIP_RAD_S)
      if (p.dot !== null) painter.dot(p.dot, p.x, p.y, p.size, p.rot, flip, p.alpha)
      else painter.glyph(p.effect, p.glyph, p.x, p.y, p.size, p.rot, p.alpha)
    }
    painter.end()
  }

  snapshot(): readonly Particle[] {
    return this.parts
  }

  private room(e: Effect) {
    const mine = this.parts.reduce((n, p) => n + (p.effect === e.id ? 1 : 0), 0)
    const cap = Math.max(1, Math.floor(e.cap * this.throttle.scale))
    return Math.max(0, Math.min(cap - mine, this.budget.live - this.parts.length))
  }

  private pick(spec: EffectSpec) {
    const g = spec.glyphs.length
    const d = spec.dots?.length ?? 0
    const i = Math.floor(this.rng() * (g + d))
    return i < g ? { glyph: i, dot: null } : { glyph: -1, dot: spec.dots![i - g] }
  }

  private base(e: Effect, x: number, y: number): Particle {
    const { glyph, dot } = this.pick(e.spec)
    const size = (dot !== null ? 7 : (e.spec.size ?? 22)) * (0.8 + this.rng() * 0.5)
    return {
      effect: e.id,
      glyph,
      dot,
      x,
      y,
      vx: 0,
      vy: 0,
      rot: (this.rng() - 0.5) * 0.6,
      vr: (this.rng() - 0.5) * 1.6,
      size,
      age: 0,
      life: 12,
      sway: 0,
      phase: this.rng() * Math.PI * 2,
      alpha: 0,
    }
  }

  private spawnRain(e: Effect, dt: number) {
    if (e.fade !== null || e.spawned >= e.total) return
    const duration = e.spec.duration ?? RAIN_S
    const spawnFor = e.spec.shape === 'walk' || e.spec.still ? 0.01 : duration * 0.6
    const want = Math.min(
      e.total,
      Math.ceil(((e.age + dt) / spawnFor) * e.total * this.throttle.scale)
    )
    let n = Math.min(want - e.spawned, this.room(e))
    while (n-- > 0) {
      this.parts.push(this.rainParticle(e, duration))
      e.spawned++
    }
    if (this.throttle.scale < 1 && e.age > spawnFor) e.spawned = e.total
  }

  private rainParticle(e: Effect, duration: number): Particle {
    const { motion, still } = e.spec
    const x = this.rng() * this.w
    if (still) {
      const p = this.base(e, x, this.rng() * this.h)
      p.life = Math.min(duration, 3)
      p.vr = 0
      return p
    }
    if (motion === 'walk' || e.spec.shape === 'walk') {
      const p = this.base(e, -30, this.h - 24)
      p.size = 32
      p.vx = (this.w + 60) / RAIN_S
      p.life = RAIN_S
      p.rot = 0
      p.vr = 0
      return p
    }
    const rise = motion === 'rise'
    const p = this.base(e, x, rise ? this.h + 24 : -24)
    const speed = 45 + this.rng() * 55
    p.vy = rise ? -speed * 0.8 : speed
    p.sway = motion === 'drift' ? 26 + this.rng() * 20 : 8 + this.rng() * 8
    p.life = (this.h + 60) / Math.abs(p.vy)
    return p
  }

  private spawnBurst(e: Effect) {
    const origins = Math.max(1, e.spec.origins ?? 1)
    const per = Math.max(1, Math.floor(e.cap / origins))
    for (let o = 0; o < origins; o++) {
      const at = e.spec.origin ?? {
        x: this.w * (0.2 + this.rng() * 0.6),
        y: this.h * (0.2 + this.rng() * 0.4),
      }
      let n = Math.min(Math.round(per * this.throttle.scale), this.room(e))
      while (n-- > 0) {
        const p = this.base(e, at.x, at.y)
        if (e.spec.still) {
          p.x = at.x + (this.rng() - 0.5) * 120
          p.y = at.y + (this.rng() - 0.5) * 80
          p.life = 1.6
          p.vr = 0
        } else {
          const confetti = e.spec.shape === 'confetti'
          // Confetti leaves a chip upward in a cone; fireworks spread all round.
          const a = confetti ? -Math.PI / 2 + (this.rng() - 0.5) * 1.6 : this.rng() * Math.PI * 2
          const v = (confetti ? 220 : 160) + this.rng() * 200
          p.vx = Math.cos(a) * v
          p.vy = Math.sin(a) * v
          p.life = 1.2 + this.rng() * 0.6
        }
        this.parts.push(p)
        e.spawned++
      }
    }
  }

  private move(p: Particle, spec: EffectSpec, dt: number) {
    if (spec.still) return
    if (spec.shape === 'rain' || spec.shape === 'walk') {
      p.x += (p.vx + Math.cos(p.phase + p.age * 1.7) * p.sway) * dt
      p.y += p.vy * dt + (spec.shape === 'walk' ? Math.sin(p.age * 10) * 0.6 : 0)
    } else {
      const drag = Math.exp(-1.6 * dt)
      p.vx *= drag
      p.vy = p.vy * drag + GRAVITY * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
    }
    p.rot += p.vr * dt
  }

  private lifeAlpha(p: Particle, spec: EffectSpec) {
    const fadeIn = Math.min(1, p.age / (spec.still ? 0.3 : 0.15))
    const tail = spec.still
      ? 0.3
      : spec.shape === 'rain' || spec.shape === 'walk'
        ? 0.4
        : p.life * 0.3
    const fadeOut = Math.min(1, Math.max(0, (p.life - p.age) / tail))
    return Math.min(fadeIn, fadeOut)
  }

  private inside(p: Particle) {
    const m = p.size * 2
    return p.x > -m - 40 && p.x < this.w + m + 40 && p.y > -m - 40 && p.y < this.h + m + 40
  }
}

// The effects the triggers name, as specs (glyphs come from the trigger or the season table).
export const CONFETTI_COLORS = ['#f44336', '#ffeb3b', '#4caf50', '#2196f3', '#e040fb', '#ff9800']

export function effectSpec(
  effect: string,
  opts: {
    origin?: { x: number; y: number }
    still?: boolean
    season?: { glyphs: string[]; dots: string[]; motion: Motion }
  }
): EffectSpec {
  const still = opts.still
  switch (effect) {
    case 'confetti':
      return {
        shape: 'confetti',
        motion: 'burst',
        glyphs: ['🎉'],
        dots: CONFETTI_COLORS,
        origin: opts.origin,
        still,
      }
    case 'balloons':
      return { shape: 'rain', motion: 'rise', glyphs: ['🎈', '🎈', '🎂', '🎁'], duration: 4, still }
    case 'trophy':
      return {
        shape: 'confetti',
        motion: 'burst',
        glyphs: ['🏆', '✨', '⭐'],
        origin: opts.origin,
        still,
        size: 26,
      }
    case 'fireworks':
      return {
        shape: 'burst',
        motion: 'burst',
        glyphs: ['✨', '🎆', '🎇'],
        dots: CONFETTI_COLORS,
        origins: 3,
        still,
      }
    case 'snow':
      return {
        shape: 'rain',
        motion: 'drift',
        glyphs: ['❄️', '❄️', '❅', '❆'],
        duration: RAIN_S,
        still,
      }
    case 'hearts':
      return { shape: 'rain', motion: 'rise', glyphs: ['💖', '💕', '💗', '❤️'], duration: 3, still }
    case 'rocket':
      return { shape: 'rain', motion: 'rise', glyphs: ['🚀', '✨', '⭐'], duration: 3, still }
    case 'season_rain': {
      const s = opts.season
      if (s) return effectSpec('season:rain', opts)
      return {
        shape: 'rain',
        motion: 'fall',
        glyphs: ['🎉', '🎊'],
        dots: CONFETTI_COLORS,
        duration: RAIN_S,
        still,
      }
    }
    default: {
      const s = opts.season
      if (!s)
        return { shape: 'confetti', motion: 'burst', glyphs: ['✨'], origin: opts.origin, still }
      const shape: EffectShape =
        s.motion === 'walk' ? 'walk' : s.motion === 'burst' ? 'burst' : 'rain'
      return {
        shape,
        motion: s.motion,
        glyphs: s.glyphs,
        dots: s.dots,
        duration: RAIN_S,
        origins: shape === 'burst' ? 3 : undefined,
        still,
      }
    }
  }
}

// Canvas memory. A layer gets its canvas when an effect starts and gives it back
// (width and height 0, element removed) when the world goes idle, so an idle tab holds none.
// At most this many live at once; the backing store's scale is the device pixel ratio, capped,
// and lowered further to keep each canvas under its byte budget.
export const CANVAS = {
  desktop: { live: 3, dprMax: 2, bytes: 8 * 1024 * 1024 },
  compact: { live: 2, dprMax: 1.5, bytes: 3 * 1024 * 1024 },
} as const

export function canvasScale(w: number, h: number, dpr: number, compact: boolean) {
  const c = compact ? CANVAS.compact : CANVAS.desktop
  if (w < 1 || h < 1) return 0
  const fit = Math.sqrt(c.bytes / (4 * w * h))
  return Math.max(0.5, Math.min(dpr, c.dprMax, fit))
}

// The canvas is sized with floor, so it never exceeds the budget the scale was fitted to.
export const canvasBytes = (w: number, h: number, scale: number) =>
  4 * Math.floor(w * scale) * Math.floor(h * scale)
