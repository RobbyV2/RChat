import { describe, expect, test } from 'bun:test'
import {
  PREROLL_FRAMES,
  measureRefresh,
  CANVAS,
  COMPACT,
  DESKTOP,
  canvasBytes,
  canvasScale,
  FLIP_RAD_S,
  FxThrottle,
  FxWorld,
  RAIN_S,
  effectSpec,
  mulberry32,
  type EffectSpec,
  type Painter,
} from '../fx/particles'

const rain: EffectSpec = { shape: 'rain', motion: 'fall', glyphs: ['🎃', '👻'], duration: 6 }
const frames = (w: FxWorld, seconds: number, fps = 60) => {
  for (let i = 0; i < seconds * fps; i++) w.step(1 / fps)
}
const recorder = () => {
  let glyphs = 0
  let dots = 0
  const p: Painter & { glyphs(): number; dots(): number } = {
    begin() {
      glyphs = 0
      dots = 0
    },
    glyph() {
      glyphs++
    },
    dot() {
      dots++
    },
    end() {},
    glyphs: () => glyphs,
    dots: () => dots,
  }
  return p
}

describe('engine', () => {
  test('the same seed replays exactly', () => {
    const a = new FxWorld(800, 600, DESKTOP, mulberry32(7))
    const b = new FxWorld(800, 600, DESKTOP, mulberry32(7))
    a.start(rain)
    b.start(rain)
    frames(a, 2)
    frames(b, 2)
    expect(JSON.stringify(a.snapshot())).toBe(JSON.stringify(b.snapshot()))
  })

  test('a rain never holds more than its cap, and ends by itself', () => {
    const w = new FxWorld(1200, 700, DESKTOP, mulberry32(1))
    w.start(rain)
    let peak = 0
    for (let i = 0; i < 60 * 30 && !w.idle; i++) {
      w.step(1 / 60)
      peak = Math.max(peak, w.live)
    }
    expect(peak).toBeGreaterThan(10)
    expect(peak).toBeLessThanOrEqual(DESKTOP.rain)
    expect(w.idle).toBe(true)
  })

  test('the world caps effects and particles', () => {
    const w = new FxWorld(1200, 700, COMPACT, mulberry32(2))
    expect(w.start(rain)).not.toBeNull()
    expect(w.start(effectSpec('confetti', { origin: { x: 100, y: 600 } }))).not.toBeNull()
    expect(w.start(effectSpec('fireworks', {}))).toBeNull()
    for (let i = 0; i < 600; i++) {
      w.step(1 / 60)
      expect(w.live).toBeLessThanOrEqual(COMPACT.live)
    }
  })

  test('stop fades everything out within 0.3 s', () => {
    const w = new FxWorld(800, 600, DESKTOP, mulberry32(3))
    w.start(rain)
    frames(w, 2)
    expect(w.live).toBeGreaterThan(0)
    w.stop()
    frames(w, 0.35)
    expect(w.idle).toBe(true)
  })

  test('clear ends at once', () => {
    const w = new FxWorld(800, 600, DESKTOP, mulberry32(3))
    w.start(rain)
    frames(w, 1)
    w.clear()
    expect(w.idle).toBe(true)
  })

  test('a long pause steps like one short frame', () => {
    const a = new FxWorld(800, 600, DESKTOP, mulberry32(4))
    const b = new FxWorld(800, 600, DESKTOP, mulberry32(4))
    a.start(rain)
    b.start(rain)
    frames(a, 1)
    frames(b, 1)
    a.step(10)
    b.step(0.05)
    expect(JSON.stringify(a.snapshot())).toBe(JSON.stringify(b.snapshot()))
  })

  test('reduced motion: a still scatter that never moves', () => {
    const w = new FxWorld(800, 600, DESKTOP, mulberry32(5))
    w.start({ ...rain, still: true })
    w.step(1 / 60)
    const at = w.snapshot().map(p => [p.x, p.y, p.rot])
    expect(at.length).toBeLessThanOrEqual(12)
    frames(w, 1)
    expect(w.snapshot().map(p => [p.x, p.y, p.rot])).toEqual(at)
    frames(w, 4)
    expect(w.idle).toBe(true)
  })

  test('a confetti burst leaves its origin upward and is gone in 2 s', () => {
    const w = new FxWorld(800, 600, DESKTOP, mulberry32(6))
    w.start(effectSpec('confetti', { origin: { x: 400, y: 500 } }))
    expect(w.live).toBeLessThanOrEqual(DESKTOP.burst)
    w.step(1 / 60)
    const up = w.snapshot().filter(p => p.vy < 0).length
    expect(up / w.live).toBeGreaterThan(0.9)
    frames(w, 2)
    expect(w.idle).toBe(true)
  })

  test('a slow device halves spawns, then stops after 30 slow frames', () => {
    const fast = new FxWorld(1200, 700, DESKTOP, mulberry32(8))
    const slow = new FxWorld(1200, 700, DESKTOP, mulberry32(8))
    fast.start(rain)
    slow.start(rain)
    let fastPeak = 0
    let slowPeak = 0
    for (let i = 0; i < 240; i++) {
      fast.step(1 / 60)
      slow.observe(5)
      slow.step(1 / 60)
      fastPeak = Math.max(fastPeak, fast.live)
      slowPeak = Math.max(slowPeak, slow.live)
    }
    expect(slowPeak).toBeLessThan(fastPeak * 0.75)
    for (let i = 0; i < DESKTOP.stopFrames; i++) {
      slow.observe(9)
      slow.step(1 / 60)
    }
    frames(slow, 0.4)
    expect(slow.idle).toBe(true)
  })

  test('the cat walks across once', () => {
    const w = new FxWorld(700, 400, DESKTOP, mulberry32(9))
    w.start({ shape: 'walk', motion: 'walk', glyphs: ['🐈‍⬛'], duration: 12 })
    frames(w, 1)
    expect(w.live).toBe(1)
    frames(w, RAIN_S + 0.5)
    expect(w.idle).toBe(true)
  })

  test('nothing starts in a layer with no area', () => {
    expect(new FxWorld(0, 600, DESKTOP).start(rain)).toBeNull()
  })

  test('the painter gets one call per live particle', () => {
    const w = new FxWorld(800, 600, DESKTOP, mulberry32(10))
    w.start(effectSpec('fireworks', {}))
    w.step(1 / 60)
    const p = recorder()
    w.paint(p)
    expect(p.glyphs() + p.dots()).toBe(w.live)
    expect(p.dots()).toBeGreaterThan(0)
  })

  test('particles never wander far outside the layer', () => {
    const w = new FxWorld(500, 300, DESKTOP, mulberry32(11))
    w.start(effectSpec('fireworks', {}))
    for (let i = 0; i < 120; i++) {
      w.step(1 / 60)
      for (const p of w.snapshot()) {
        expect(p.x).toBeGreaterThan(-200)
        expect(p.x).toBeLessThan(700)
        expect(p.y).toBeLessThan(500)
      }
    }
  })

  test('season specs follow the table motion', () => {
    expect(
      effectSpec('season:halloween', { season: { glyphs: ['🎃'], dots: [], motion: 'fall' } }).shape
    ).toBe('rain')
    expect(
      effectSpec('season:new_year', { season: { glyphs: ['🎆'], dots: [], motion: 'burst' } }).shape
    ).toBe('burst')
    expect(
      effectSpec('season:friday_13', { season: { glyphs: ['🐈‍⬛'], dots: [], motion: 'walk' } }).shape
    ).toBe('walk')
  })
})

describe('budget', () => {
  test('stepping a full world costs well under the 4 ms frame budget', () => {
    const w = new FxWorld(1920, 1080, { ...DESKTOP, effects: 3 }, mulberry32(12))
    w.start(rain)
    w.start(effectSpec('fireworks', {}))
    w.start(effectSpec('confetti', { origin: { x: 900, y: 900 } }))
    const p = recorder()
    frames(w, 1)
    const t = performance.now()
    for (let i = 0; i < 1000; i++) {
      w.step(1 / 60)
      w.paint(p)
      if (w.idle) w.start(rain)
    }
    expect((performance.now() - t) / 1000).toBeLessThan(0.5)
  })
})

describe('accessibility limits', () => {
  test('every rain is gone within 5 s plus the fade', () => {
    const w = new FxWorld(800, 1600, DESKTOP, mulberry32(21))
    w.start({ ...rain, duration: undefined })
    frames(w, RAIN_S + 0.35)
    expect(w.idle).toBe(true)
  })
  test('paper confetti turns at most 3 times a second', () => {
    expect(FLIP_RAD_S / Math.PI).toBeLessThanOrEqual(3)
  })
})

describe('the shared throttle', () => {
  test('late frames step it down and fade what plays, even when the script is fast', () => {
    const t = new FxThrottle(DESKTOP)
    const w = new FxWorld(800, 600, DESKTOP, mulberry32(30), t)
    w.start(rain)
    frames(w, 1)
    for (let i = 0; i < DESKTOP.lateFrames; i++) {
      w.observe(0.5, 40)
      w.step(1 / 60)
    }
    expect(t.step).toBe(1)
    frames(w, 0.4)
    expect(w.idle).toBe(true)
  })
  test('the next effect starts at the lower step, in a new world too', () => {
    const t = new FxThrottle(DESKTOP)
    for (let i = 0; i < DESKTOP.lateFrames; i++) t.observe(0.5, 40)
    const saved = JSON.parse(JSON.stringify(t))
    const again = new FxThrottle(DESKTOP, saved)
    expect(again.step).toBe(1)
    const full = new FxWorld(1200, 700, DESKTOP, mulberry32(31))
    const half = new FxWorld(1200, 700, DESKTOP, mulberry32(31), again)
    full.start(rain)
    half.start(rain)
    let a = 0
    let b = 0
    for (let i = 0; i < 240; i++) {
      full.step(1 / 60)
      half.step(1 / 60)
      a = Math.max(a, full.live)
      b = Math.max(b, half.live)
    }
    expect(b).toBeLessThanOrEqual(Math.ceil(a / 2))
  })
  test('step 2 allows bursts only; step 3 plays nothing', () => {
    const t = new FxThrottle(DESKTOP, { step: 2 })
    const w = new FxWorld(800, 600, DESKTOP, mulberry32(32), t)
    expect(w.start(rain)).toBeNull()
    expect(w.start(effectSpec('confetti', { origin: { x: 1, y: 1 } }))).not.toBeNull()
    expect(w.live).toBeLessThanOrEqual(Math.ceil(DESKTOP.burst / 4))
    const off = new FxWorld(800, 600, DESKTOP, mulberry32(33), new FxThrottle(DESKTOP, { step: 3 }))
    expect(off.start(effectSpec('confetti', { origin: { x: 1, y: 1 } }))).toBeNull()
  })
  test('five minutes of good frames step back up one; bad saved state reads as full', () => {
    const t = new FxThrottle(DESKTOP, { step: 2 })
    for (let i = 0; i < 18_001; i++) t.observe(0.5, 1000 / 60)
    expect(t.step).toBe(1)
    expect(new FxThrottle(DESKTOP, { step: 'x' }).step).toBe(0)
    expect(new FxThrottle(DESKTOP, null).step).toBe(0)
  })
  test('slow script work alone also steps it down: soft once the average is over, hard when it lasts', () => {
    const t = new FxThrottle(DESKTOP)
    for (let i = 0; i < 5; i++) t.observe(9, 16)
    expect(t.step).toBe(0)
    t.observe(9, 16)
    expect(t.step).toBe(1)
    for (let i = 6; i < DESKTOP.stopFrames; i++) t.observe(9, 16)
    expect(t.step).toBe(2)
  })
  test('the average starts from 0: one 15 ms frame then fast ones stay at the full budget', () => {
    const t = new FxThrottle(DESKTOP)
    t.observe(15, 16.7)
    for (let i = 0; i < 100; i++) t.observe(0.4, 16.7)
    expect(t.step).toBe(0)
  })
  test('a steady 5 ms device steps to 1 within 20 frames', () => {
    const t = new FxThrottle(DESKTOP)
    let n = 0
    while (t.step === 0 && n < 100) {
      t.observe(5, 16.7)
      n++
    }
    expect(t.step).toBe(1)
    expect(n).toBe(16)
  })
  test('the frame an effect starts in is not counted in the average', () => {
    const t = new FxThrottle(DESKTOP)
    const w = new FxWorld(800, 600, DESKTOP, mulberry32(34), t)
    w.start(rain)
    w.step(1 / 60)
    w.observe(45, 50)
    expect(t.step).toBe(0)
    w.step(1 / 60)
    w.observe(0.4, 16.7)
    expect(t.step).toBe(0)
    w.start(effectSpec('fireworks', {}))
    w.step(1 / 60)
    w.observe(45, 50)
    expect(t.step).toBe(0)
    w.step(1 / 60)
    w.observe(45, 50)
    expect(t.step).toBe(1)
  })
})

describe('a burst that could not spawn in full still ends', () => {
  const burst = () => effectSpec('fireworks', {})
  for (const step of [1, 2] as const)
    test(`throttled to step ${step}: the world goes idle`, () => {
      const w = new FxWorld(800, 600, DESKTOP, mulberry32(4), new FxThrottle(DESKTOP, { step }))
      expect(w.start(burst())).not.toBeNull()
      expect(w.live).toBeGreaterThan(0)
      expect(w.live).toBeLessThan(DESKTOP.burst)
      frames(w, 4)
      expect([w.live, w.running, w.idle]).toEqual([0, 0, true])
    })

  test('short of room under the live cap: its slot is free again when its particles are gone', () => {
    const w = new FxWorld(800, 600, { ...DESKTOP, live: 70 }, mulberry32(4))
    expect(w.start(effectSpec('confetti', { origin: { x: 400, y: 300 } }))).not.toBeNull()
    expect(w.start(burst())).not.toBeNull()
    expect(w.live).toBe(70)
    frames(w, 4)
    expect([w.live, w.running, w.idle]).toEqual([0, 0, true])
  })

  test('with no room at all it is gone at the next step', () => {
    const w = new FxWorld(800, 600, { ...DESKTOP, live: 60 }, mulberry32(4))
    w.start(effectSpec('confetti', { origin: { x: 400, y: 300 } }))
    expect(w.live).toBe(60)
    expect(w.start(burst())).not.toBeNull()
    w.step(1 / 60)
    expect(w.running).toBe(1)
    frames(w, 4)
    expect(w.idle).toBe(true)
  })

  test('a throttled burst frees its slot for the next effect', () => {
    const w = new FxWorld(800, 600, DESKTOP, mulberry32(4), new FxThrottle(DESKTOP, { step: 2 }))
    for (let i = 0; i < DESKTOP.effects; i++) expect(w.start(burst())).not.toBeNull()
    expect(w.start(burst())).toBeNull()
    frames(w, 4)
    expect(w.start(burst())).not.toBeNull()
  })
})

describe('season rain without a season', () => {
  test('confetti rain', () => {
    const s = effectSpec('season_rain', {})
    expect(s.shape).toBe('rain')
    expect(s.dots?.length).toBeGreaterThan(0)
  })
})

describe('canvas memory', () => {
  test('a phone list host stays under 3 MB, a desktop one under 8 MB', () => {
    const phone = canvasScale(390, 700, 3, true)
    expect(phone).toBeLessThanOrEqual(1.5)
    expect(canvasBytes(390, 700, phone)).toBeLessThanOrEqual(CANVAS.compact.bytes)
    const desk = canvasScale(900, 700, 2, false)
    expect(canvasBytes(900, 700, desk)).toBeLessThanOrEqual(CANVAS.desktop.bytes)
    const wide = canvasScale(2560, 1400, 2, false)
    expect(canvasBytes(2560, 1400, wide)).toBeLessThanOrEqual(CANVAS.desktop.bytes)
  })
  test('the live total stays bounded: 6 MB on phones, 24 MB on desktops', () => {
    expect(CANVAS.compact.live * CANVAS.compact.bytes).toBeLessThanOrEqual(6 * 1024 * 1024)
    expect(CANVAS.desktop.live * CANVAS.desktop.bytes).toBeLessThanOrEqual(24 * 1024 * 1024)
  })
  test('no area, no canvas', () => {
    expect(canvasScale(0, 500, 2, false)).toBe(0)
  })
})

describe('the refresh baseline', () => {
  const steady = (ms: number, n = PREROLL_FRAMES) => [ms * 3, ...Array(n - 1).fill(ms)]
  test('the pre-roll measures the refresh: 60, 120 and 90 Hz', () => {
    expect(measureRefresh([40, 16.6, 16.7, 16.8, 16.7, 16.6, 16.7, 16.7])).toEqual({
      displayMs: 16.6,
      capped: false,
    })
    expect(Math.abs((measureRefresh(steady(8.33))?.displayMs ?? 0) - 8.33)).toBeLessThan(0.005)
    expect(measureRefresh(steady(11.1))?.capped).toBe(false)
    expect(measureRefresh([16, 16, 2, 1])).toBeNull()
  })
  test('a phone slow from the first effect frame steps down within the late-frame window', () => {
    const t = new FxThrottle(COMPACT)
    expect(t.calibrate(steady(16.7))).toBe(true)
    const w = new FxWorld(390, 700, COMPACT, mulberry32(40), t)
    w.start(rain)
    let frames = 0
    while (t.step === 0 && frames < 100) {
      w.observe(0.6, 40)
      w.step(0.04)
      frames++
    }
    expect(t.step).toBe(1)
    expect(frames).toBe(COMPACT.lateFrames)
  })
  test('without the pre-roll, the same phone looked fine', () => {
    const t = new FxThrottle(COMPACT)
    t.calibrate(steady(40))
    for (let i = 0; i < 100; i++) t.observe(0.6, 40)
    expect(t.step).toBe(0)
    expect(t.capped).toBe(true)
  })
  test('a capped display (iOS Low Power Mode, 30 fps) is low power, not late', () => {
    const t = new FxThrottle(COMPACT)
    t.calibrate(steady(33.3))
    expect(t.capped).toBe(true)
    for (let i = 0; i < 100; i++) t.observe(0.6, 33.3)
    expect(t.step).toBe(0)
    for (let i = 0; i < COMPACT.lateFrames; i++) t.observe(0.6, 70)
    expect(t.step).toBe(1)
  })
  test('a 120 Hz screen running an effect at 60 fps is not late; at 40 fps it is', () => {
    const t = new FxThrottle(DESKTOP)
    t.calibrate(steady(8.33))
    for (let i = 0; i < 50; i++) t.observe(0.5, 16.7)
    expect(t.step).toBe(0)
    for (let i = 0; i < DESKTOP.lateFrames; i++) t.observe(0.5, 25)
    expect(t.step).toBe(1)
  })
  test('the baseline is kept per tab with the step; bad saved values read as uncalibrated', () => {
    const t = new FxThrottle(DESKTOP)
    t.calibrate(steady(16.7))
    const again = new FxThrottle(DESKTOP, JSON.parse(JSON.stringify(t)))
    expect([again.calibrated, again.displayMs, again.capped]).toEqual([true, 16.7, false])
    expect(new FxThrottle(DESKTOP, { displayMs: 900 }).calibrated).toBe(false)
    expect(new FxThrottle(DESKTOP, { displayMs: '16' }).calibrated).toBe(false)
  })
  test('Reset restores the full budget and keeps the baseline', () => {
    const t = new FxThrottle(DESKTOP, { step: 3, displayMs: 16.7 })
    expect(t.off).toBe(true)
    t.reset()
    expect([t.step, t.displayMs]).toEqual([0, 16.7])
  })
})
