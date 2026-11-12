import { gray, lstarOfY, linearRgbOf, rgbOfLinear, xyzOf, yOfLstar, type Rgb } from './color'

// HCT: hue and chroma from CAM16 under Material's default viewing conditions, tone = L*.

const WP = [95.047, 100.0, 108.883]
const toCone = (x: number, y: number, z: number) => [
  0.401288 * x + 0.650173 * y - 0.051461 * z,
  -0.250268 * x + 1.204414 * y + 0.045854 * z,
  -0.002079 * x + 0.048952 * y + 0.953127 * z,
]

const vc = (() => {
  const adaptingLuminance = ((200 / Math.PI) * yOfLstar(50)) / 100
  const backgroundLstar = 50
  const surround = 2
  const [rW, gW, bW] = toCone(WP[0], WP[1], WP[2])
  const f = 0.8 + surround / 10
  const c =
    f >= 0.9 ? 0.59 + (0.69 - 0.59) * ((f - 0.9) * 10) : 0.525 + (0.59 - 0.525) * ((f - 0.8) * 10)
  let d = f * (1 - (1 / 3.6) * Math.exp((-adaptingLuminance - 42) / 92))
  d = Math.max(0, Math.min(1, d))
  const nc = f
  const rgbD = [d * (100 / rW) + 1 - d, d * (100 / gW) + 1 - d, d * (100 / bW) + 1 - d]
  const k = 1 / (5 * adaptingLuminance + 1)
  const k4 = k * k * k * k
  const k4F = 1 - k4
  const fl = k4 * adaptingLuminance + 0.1 * k4F * k4F * Math.cbrt(5 * adaptingLuminance)
  const n = yOfLstar(backgroundLstar) / WP[1]
  const z = 1.48 + Math.sqrt(n)
  const nbb = 0.725 / Math.pow(n, 0.2)
  const ncb = nbb
  const rgbAF = [rW, gW, bW].map((v, i) => Math.pow((fl * rgbD[i] * v) / 100, 0.42))
  const rgbA = rgbAF.map(v => (400 * v) / (v + 27.13))
  const aw = (2 * rgbA[0] + rgbA[1] + 0.05 * rgbA[2]) * nbb
  return { n, aw, nbb, ncb, c, nc, rgbD, fl, z }
})()

export interface Hct {
  hue: number
  chroma: number
  tone: number
}

export const hctOf = (rgb: Rgb): Hct => {
  const [x, y, z] = xyzOf(rgb)
  const [rC, gC, bC] = toCone(x, y, z)
  const [rD, gD, bD] = [rC, gC, bC].map((v, i) => vc.rgbD[i] * v)
  const [rA, gA, bA] = [rD, gD, bD].map(v => {
    const af = Math.pow((vc.fl * Math.abs(v)) / 100, 0.42)
    return (Math.sign(v) * 400 * af) / (af + 27.13)
  })
  const a = (11 * rA - 12 * gA + bA) / 11
  const b = (rA + gA - 2 * bA) / 9
  const u = (20 * rA + 20 * gA + 21 * bA) / 20
  const p2 = (40 * rA + 20 * gA + bA) / 20
  let hue = (Math.atan2(b, a) * 180) / Math.PI
  if (hue < 0) hue += 360
  const ac = p2 * vc.nbb
  const j = 100 * Math.pow(ac / vc.aw, vc.c * vc.z)
  const huePrime = hue < 20.14 ? hue + 360 : hue
  const eHue = 0.25 * (Math.cos((huePrime * Math.PI) / 180 + 2) + 3.8)
  const p1 = (50000 / 13) * eHue * vc.nc * vc.ncb
  const t = (p1 * Math.hypot(a, b)) / (u + 0.305)
  const alpha = Math.pow(t, 0.9) * Math.pow(1.64 - Math.pow(0.29, vc.n), 0.73)
  const chroma = alpha * Math.sqrt(j / 100)
  return { hue, chroma, tone: lstarOfY(y) }
}

const xyzOfJch = (j: number, chroma: number, hue: number) => {
  const alpha = chroma === 0 || j === 0 ? 0 : chroma / Math.sqrt(j / 100)
  const t = Math.pow(alpha / Math.pow(1.64 - Math.pow(0.29, vc.n), 0.73), 1 / 0.9)
  const hRad = (hue * Math.PI) / 180
  const eHue = 0.25 * (Math.cos(hRad + 2) + 3.8)
  const ac = vc.aw * Math.pow(j / 100, 1 / vc.c / vc.z)
  const p1 = eHue * (50000 / 13) * vc.nc * vc.ncb
  const p2 = ac / vc.nbb
  const hSin = Math.sin(hRad)
  const hCos = Math.cos(hRad)
  const gamma = (23 * (p2 + 0.305) * t) / (23 * p1 + 11 * t * hCos + 108 * t * hSin)
  const a = gamma * hCos
  const b = gamma * hSin
  const rA = (460 * p2 + 451 * a + 288 * b) / 1403
  const gA = (460 * p2 - 891 * a - 261 * b) / 1403
  const bA = (460 * p2 - 220 * a - 6300 * b) / 1403
  const [rF, gF, bF] = [rA, gA, bA].map((v, i) => {
    const base = Math.max(0, (27.13 * Math.abs(v)) / (400 - Math.abs(v)))
    return (Math.sign(v) * (100 / vc.fl) * Math.pow(base, 1 / 0.42)) / vc.rgbD[i]
  })
  return [
    1.86206786 * rF - 1.01125463 * gF + 0.14918677 * bF,
    0.38752654 * rF + 0.62144744 * gF - 0.00897398 * bF,
    -0.0158415 * rF - 0.03412294 * gF + 1.04996444 * bF,
  ]
}

// The linear sRGB (0..100) of a hue and chroma at the J whose L* is the tone; null out of gamut.
const atTone = (hue: number, chroma: number, tone: number): number[] | null => {
  let lo = 0
  let hi = 100
  let xyz = xyzOfJch(50, chroma, hue)
  for (let i = 0; i < 40; i++) {
    const j = (lo + hi) / 2
    xyz = xyzOfJch(j, chroma, hue)
    if (lstarOfY(xyz[1]) < tone) lo = j
    else hi = j
  }
  const lin = linearRgbOf(xyz)
  return lin.every(v => v >= -0.01 && v <= 100.01)
    ? lin.map(v => Math.max(0, Math.min(100, v)))
    : null
}

// The sRGB color of a hue and a tone, with the asked chroma or the most the gamut allows.
export const solve = (hue: number, chroma: number, tone: number): Rgb => {
  if (tone <= 0.0001) return [0, 0, 0]
  if (tone >= 99.9999) return [255, 255, 255]
  if (chroma < 0.5) return gray(tone)
  const exact = atTone(hue, chroma, tone)
  if (exact) return rgbOfLinear(exact)
  let lo = 0
  let hi = chroma
  let best: number[] | null = null
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    const got = atTone(hue, mid, tone)
    if (got) {
      best = got
      lo = mid
    } else hi = mid
  }
  return best ? rgbOfLinear(best) : gray(tone)
}
