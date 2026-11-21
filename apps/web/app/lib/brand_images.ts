// The sizes a brand's images are made in before they are uploaded. The drawing itself is the
// component's; this is the arithmetic.

import type { BrandAsset } from './types'

// The most bytes one image may have, and the largest logo, as the instance takes them.
export const IMAGE_MAX_BYTES = 1024 * 1024
export const LOGO_MAX_WIDTH = 2048
export const LOGO_MAX_HEIGHT = 1024
// The smallest mark worth scaling down to every size.
export const MARK_MIN = 512

// The share of a maskable icon's side kept clear on each edge, so a round mask cuts nothing.
export const SAFE_ZONE = 0.1

export interface MarkSize {
  kind: BrandAsset
  size: number
  // Drawn on the theme's background inside the safe zone.
  maskable: boolean
}

// Every size a mark is uploaded in: the tab icon, the touch icon, the installed app's icons.
export const MARK_SIZES: MarkSize[] = [
  { kind: 'mark-32', size: 32, maskable: false },
  { kind: 'mark-180', size: 180, maskable: false },
  { kind: 'mark-192', size: 192, maskable: false },
  { kind: 'mark-512', size: 512, maskable: false },
  { kind: 'mark-maskable', size: 512, maskable: true },
]

const whole = (n: number) => Number.isFinite(n) && n > 0

// What is wrong with an image picked as the mark, or null.
export const markError = (width: number, height: number): string | null => {
  if (!whole(width) || !whole(height)) return "That file can't be read as an image."
  if (width !== height) return 'Use a square image.'
  return width < MARK_MIN ? `Use an image of ${MARK_MIN} by ${MARK_MIN} pixels or more.` : null
}

// What is wrong with an image picked as the logo, or null.
export const logoError = (width: number, height: number): string | null =>
  whole(width) && whole(height) ? null : "That file can't be read as an image."

// The size the logo is uploaded in: its own, or scaled down to fit the largest logo, keeping
// its shape.
export const logoSize = (width: number, height: number) => {
  const scale = Math.min(1, LOGO_MAX_WIDTH / width, LOGO_MAX_HEIGHT / height)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

// Where the mark sits in an icon of `size`: the whole icon, or inside the safe zone of a
// maskable one.
export const markRect = ({ size, maskable }: Pick<MarkSize, 'size' | 'maskable'>) => {
  const inset = maskable ? Math.round(size * SAFE_ZONE) : 0
  return { x: inset, y: inset, side: size - 2 * inset }
}

// What to say about an image that is still too large after it was drawn.
export const sizeError = (bytes: number): string | null =>
  bytes > IMAGE_MAX_BYTES ? 'The image is over 1 MiB. Use a simpler one.' : null
