export interface Frame {
  offset?: number
  opacity?: number
  transform?: string
}
export interface Timing {
  duration: number
  delay?: number
  easing?: string
  iterations?: number
}
export interface Animation {
  keyframes: Frame[]
  timing: Timing
}

export const LIMITS = {
  keyframes: 12,
  duration: 1000,
  delay: 500,
  iterations: 3,
  translatePx: 64,
  translatePct: 100,
  scaleMin: 0.5,
  scaleMax: 1.5,
  rotateDeg: 30,
  reducedMs: 150,
  text: 1024,
} as const

const FN = /^(translate[XY]?|scale[XY]?|rotate)\(([^)]*)\)$/

const okTransform = (t: string): boolean =>
  t
    .trim()
    .split(/\s+(?=[a-z])/)
    .every(part => {
      const m = FN.exec(part.trim())
      if (!m) return false
      const args = m[2].split(',').map(a => a.trim())
      if (m[1].startsWith('translate'))
        return args.every(a => {
          const px = /^(-?\d+(\.\d+)?)px$/.exec(a)
          const pct = /^(-?\d+(\.\d+)?)%$/.exec(a)
          return (
            a === '0' ||
            (px !== null && Math.abs(+px[1]) <= LIMITS.translatePx) ||
            (pct !== null && Math.abs(+pct[1]) <= LIMITS.translatePct)
          )
        })
      if (m[1].startsWith('scale'))
        return args.every(
          a => /^\d+(\.\d+)?$/.test(a) && +a >= LIMITS.scaleMin && +a <= LIMITS.scaleMax
        )
      const deg = /^(-?\d+(\.\d+)?)deg$/.exec(args[0])
      return args.length === 1 && deg !== null && Math.abs(+deg[1]) <= LIMITS.rotateDeg
    })

const EASING =
  /^(linear|ease|ease-in|ease-out|ease-in-out|cubic-bezier\((\s*-?\d+(\.\d+)?\s*,){3}\s*-?\d+(\.\d+)?\s*\)|linear\([\d.,\s%]+\))$/

const FRAME_KEYS = ['offset', 'opacity', 'transform']
const TIMING_KEYS = ['duration', 'delay', 'easing', 'iterations']

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

// What is wrong with an animation; an empty list means it may play. Only transform and opacity
// may move, within LIMITS. The input may be anything.
export const check = (a: unknown): string[] => {
  if (!record(a)) return ['animation']
  const errors: string[] = []
  const all = Array.isArray(a.keyframes) ? a.keyframes : null
  // Keyframes past the limit are counted, not read.
  const frames = (all ?? []).slice(0, LIMITS.keyframes)
  if (!all || all.length < 1 || all.length > LIMITS.keyframes || !frames.every(record))
    errors.push('keyframes')
  let last = 0
  for (const f of frames) {
    if (!record(f)) continue
    for (const k of Object.keys(f)) if (!FRAME_KEYS.includes(k)) errors.push(`property ${k}`)
    const { offset, opacity, transform } = f
    // An offset is from 0 to 1 and never before the one ahead of it.
    if (offset !== undefined) {
      if (!(num(offset) && offset >= last && offset <= 1)) errors.push('offset')
      else last = offset
    }
    if (opacity !== undefined && !(num(opacity) && opacity >= 0 && opacity <= 1))
      errors.push('opacity')
    if (transform !== undefined) {
      if (typeof transform !== 'string' || transform.length > LIMITS.text) errors.push('transform')
      else if (!okTransform(transform)) errors.push(`transform ${transform}`)
    }
  }
  const t = a.timing
  if (!record(t)) return [...errors, 'timing']
  for (const k of Object.keys(t)) if (!TIMING_KEYS.includes(k)) errors.push(`timing ${k}`)
  const { duration, delay = 0, easing, iterations = 1 } = t
  if (!(num(duration) && duration > 0 && duration <= LIMITS.duration)) errors.push('duration')
  if (!(num(delay) && delay >= 0 && delay <= LIMITS.delay)) errors.push('delay')
  const whole = num(iterations) && Number.isInteger(iterations)
  if (!(whole && iterations >= 1 && iterations <= LIMITS.iterations)) errors.push('iterations')
  const eased = typeof easing === 'string' && easing.length <= LIMITS.text && EASING.test(easing)
  if (easing !== undefined && !eased) errors.push('easing')
  return errors
}

// The reduced variant: opacity only, at most 150 ms.
export const reduced = (a: Animation): Animation => ({
  keyframes: a.keyframes.map(({ offset, opacity }) => ({
    ...(offset === undefined ? {} : { offset }),
    opacity: opacity ?? 1,
  })),
  timing: { duration: Math.min(LIMITS.reducedMs, a.timing.duration), easing: 'linear' },
})
