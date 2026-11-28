import { bytesOf } from './canonical'

// A P2P profile picture: its files, each a P2P file named by its hash with its size in bytes.
// `s` and `l` are the 128 and 512 pixel stills, `a` the animation when there is one. An identity
// profile and a room profile carry it as `pic`; a room's own picture sits in its config.
export interface P2pFile {
  h: string
  size: number
}

export interface P2pPic {
  s: P2pFile
  l: P2pFile
  a?: P2pFile
}

// The most bytes a still file and an animation may have (assets/avatar_images.json).
export const PIC_LIMITS = { still: 262_144, animated: 1_048_576 } as const

const fileOf = (x: unknown, max: number): P2pFile | undefined => {
  if (!Array.isArray(x) || x.length !== 2) return undefined
  const [h, size] = x as unknown[]
  if (typeof h !== 'string' || bytesOf(h, 32) === null) return undefined
  if (!Number.isSafeInteger(size) || (size as number) < 1 || (size as number) > max)
    return undefined
  return { h, size: size as number }
}

// The picture a profile names. Anything malformed reads as no picture, and an animation that is
// malformed or past its cap is left out while the stills count. Fields this version does not
// know are not read.
export function parsePic(x: unknown): P2pPic | undefined {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return undefined
  const { s, l, a } = x as Record<string, unknown>
  const small = fileOf(s, PIC_LIMITS.still)
  const large = fileOf(l, PIC_LIMITS.still)
  if (!small || !large) return undefined
  const moving = fileOf(a, PIC_LIMITS.animated)
  return moving ? { s: small, l: large, a: moving } : { s: small, l: large }
}

// A picture as a profile carries it and as a device keeps it.
export interface PicWire {
  s: [string, number]
  l: [string, number]
  a?: [string, number]
}

export const picWire = (p: P2pPic): PicWire => ({
  s: [p.s.h, p.s.size],
  l: [p.l.h, p.l.size],
  ...(p.a ? { a: [p.a.h, p.a.size] } : {}),
})

// The wire form of what `x` names, when it names a picture.
export const cleanPic = (x: unknown): PicWire | undefined => {
  const pic = parsePic(x)
  return pic ? picWire(pic) : undefined
}

export const samePic = (a: P2pPic | undefined | null, b: P2pPic | undefined | null) =>
  (a ?? null) === (b ?? null) ||
  (!!a &&
    !!b &&
    a.s.h === b.s.h &&
    a.l.h === b.l.h &&
    a.s.size === b.s.size &&
    a.l.size === b.l.size &&
    a.a?.h === b.a?.h &&
    a.a?.size === b.a?.size)

// The files of a picture, for the gates that serve and fetch them.
export const picFiles = (p: P2pPic | undefined | null): P2pFile[] =>
  p ? [p.s, p.l, ...(p.a ? [p.a] : [])] : []

// The still file for a drawing of `px` CSS pixels at two device pixels each.
export const stillFor = (p: P2pPic, px: number): P2pFile => (px * 2 <= 128 ? p.s : p.l)
