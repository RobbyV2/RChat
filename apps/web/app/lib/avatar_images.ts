// Uploaded profile pictures, the same for hosted accounts and P2P identities
// (assets/avatar_images.json): the sizes a picture is kept at, what a source image may be, and
// the square of it that is kept.
export const AVATAR_IMAGES = {
  sizes: [64, 128, 512],
  types: ['image/png', 'image/jpeg'],
  max_pixels: 40_000_000,
  min_crop: 16,
  p2p_sizes: [128, 512],
  p2p_max_bytes: 262_144,
} as const

export type AvatarSize = (typeof AVATAR_IMAGES.sizes)[number]

// The square to keep, in pixels of the image as it shows, from its top left corner.
export interface AvatarCrop {
  x: number
  y: number
  size: number
}

// The file types a picture can be made from.
export const AVATAR_SOURCES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export const AVATAR_ACCEPT = AVATAR_SOURCES.join(',')

// The smallest stored size that fills `px` CSS pixels at `ratio` device pixels each.
export const sizeFor = (px: number, ratio = 1): AvatarSize =>
  AVATAR_IMAGES.sizes.find(s => s >= px * ratio) ?? AVATAR_IMAGES.sizes[2]

const mib = (bytes: number) => Math.max(1, Math.floor(bytes / (1024 * 1024)))

// Why a chosen file can't become a picture, before it is read; null when it may.
export const sourceError = (file: { size: number; type: string }, maxBytes: number) => {
  if (!(AVATAR_SOURCES as readonly string[]).includes(file.type))
    return 'Choose a PNG, JPEG, GIF or WebP image'
  if (file.size > maxBytes) return `Pictures can be up to ${mib(maxBytes)} MB`
  return null
}

// Why a decoded image can't become a picture; null when it may.
export const imageError = (width: number, height: number) => {
  if (Math.min(width, height) < AVATAR_IMAGES.min_crop)
    return `The picture must be at least ${AVATAR_IMAGES.min_crop} pixels wide and tall`
  if (width * height > AVATAR_IMAGES.max_pixels) return 'The picture has too many pixels'
  return null
}

// The side below which zooming in stops: a crop is never enlarged past twice the largest
// stored size's worth of detail, and never under `min_crop`.
const smallest = (width: number, height: number) =>
  Math.min(Math.min(width, height), Math.max(AVATAR_IMAGES.min_crop, AVATAR_IMAGES.sizes[0]))

// How far the crop of an image zooms in: 1 is its largest square.
export const maxZoom = (width: number, height: number) =>
  Math.min(width, height) / smallest(width, height)

const clamp = (v: number, low: number, high: number) => Math.min(high, Math.max(low, v))

const within = (width: number, height: number, crop: AvatarCrop): AvatarCrop => {
  const size = Math.round(clamp(crop.size, smallest(width, height), Math.min(width, height)))
  return {
    size,
    x: Math.round(clamp(crop.x, 0, width - size)),
    y: Math.round(clamp(crop.y, 0, height - size)),
  }
}

// The centered largest square.
export const startCrop = (width: number, height: number): AvatarCrop => {
  const size = Math.min(width, height)
  return within(width, height, { size, x: (width - size) / 2, y: (height - size) / 2 })
}

// The zoom a crop is at.
export const zoomOf = (width: number, height: number, crop: AvatarCrop) =>
  Math.min(width, height) / crop.size

// `crop` at `zoom`, around the same center.
export const zoomed = (width: number, height: number, crop: AvatarCrop, zoom: number) => {
  const size = Math.min(width, height) / clamp(zoom, 1, maxZoom(width, height))
  const half = (crop.size - size) / 2
  return within(width, height, { size, x: crop.x + half, y: crop.y + half })
}

// `crop` moved by `dx`, `dy` pixels of the image, kept inside it.
export const moved = (width: number, height: number, crop: AvatarCrop, dx: number, dy: number) =>
  within(width, height, { size: crop.size, x: crop.x + dx, y: crop.y + dy })
