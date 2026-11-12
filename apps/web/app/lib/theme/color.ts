export type Rgb = [number, number, number]

export const hex = (h: string): Rgb => {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim())
  if (!m) throw new Error(`bad color ${h}`)
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export const toHex = ([r, g, b]: Rgb) =>
  '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')

// sRGB channels (0..255) to linear light (0..100) and back.
const linear = (c: number) => {
  const n = c / 255
  return (n <= 0.040449936 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4)) * 100
}
const delinear = (c: number) => {
  const n = c / 100
  const v = n <= 0.0031308 ? n * 12.92 : 1.055 * Math.pow(n, 1 / 2.4) - 0.055
  return Math.max(0, Math.min(255, Math.round(v * 255)))
}

export const SRGB_TO_XYZ = [
  [0.41233895, 0.35762064, 0.18051042],
  [0.2126, 0.7152, 0.0722],
  [0.01932141, 0.11916382, 0.95034478],
]
export const XYZ_TO_SRGB = [
  [3.2413774792388685, -1.5376652402851851, -0.49885366846268053],
  [-0.9691452513005321, 1.8758853451067872, 0.04156585616912061],
  [0.05562093689691305, -0.20395524564742123, 1.0571799111220335],
]

const mul = (m: number[][], v: number[]) => m.map(r => r[0] * v[0] + r[1] * v[1] + r[2] * v[2])

export const xyzOf = (c: Rgb) => mul(SRGB_TO_XYZ, c.map(linear))
export const linearRgbOf = (xyz: number[]) => mul(XYZ_TO_SRGB, xyz)
export const rgbOfLinear = (lin: number[]): Rgb => lin.map(delinear) as Rgb

const E = 216 / 24389
const K = 24389 / 27

export const lstarOfY = (y: number) => {
  const n = y / 100
  return n <= E ? K * n : 116 * Math.cbrt(n) - 16
}
export const yOfLstar = (l: number) => {
  const ft = (l + 16) / 116
  const ft3 = ft * ft * ft
  return 100 * (ft3 > E ? ft3 : (116 * ft - 16) / K)
}
export const lstar = (c: Rgb) => lstarOfY(xyzOf(c)[1])
export const gray = (tone: number): Rgb => {
  const v = delinear(yOfLstar(tone))
  return [v, v, v]
}

// CIE Lab (D65) and the CIE76 color difference.
const WHITE = [95.047, 100, 108.883]
const f = (t: number) => (t > E ? Math.cbrt(t) : (K * t + 16) / 116)
export const lab = (c: Rgb) => {
  const [x, y, z] = xyzOf(c)
  const fx = f(x / WHITE[0])
  const fy = f(y / WHITE[1])
  const fz = f(z / WHITE[2])
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}
export const deltaE = (a: Rgb, b: Rgb) => {
  const [l1, a1, b1] = lab(a)
  const [l2, a2, b2] = lab(b)
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2)
}
export const channelDiff = (a: Rgb, b: Rgb) => Math.max(...a.map((v, i) => Math.abs(v - b[i])))

// WCAG 2.x contrast ratio.
const rel = (c: Rgb) => xyzOf(c)[1] / 100
export const contrast = (a: Rgb, b: Rgb) => {
  const la = rel(a)
  const lb = rel(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}
