// Color emoji fonts don't center their glyphs between their own ascent and descent, so a one-line
// emoji box (a reaction pill) shows the glyph a little high or low, by how much depends on the
// font and the engine. The app measures the emoji font once (the baseline from the page's own
// layout, the ink from a canvas) and moves the glyph by the difference (`--emoji-shift`, in em).

export interface EmojiBox {
  // The box: font size and line height in px (line-height 1), and its baseline from the top.
  size: number
  baseline: number
  // Where a reference glyph paints at `inkSize`: above the baseline (up) and below it (down).
  inkTop: number
  inkBottom: number
  inkSize: number
}

// Most an emoji font is moved (real fonts need up to about 0.17em), so a broken measurement can't
// throw the glyph out of its pill.
export const SHIFT_MAX = 0.2

// The move, in em (down is positive), that puts the ink's middle on the box's middle.
export const emojiShift = ({ size, baseline, inkTop, inkBottom, inkSize }: EmojiBox): number => {
  const ink = ((inkTop - inkBottom) * size) / inkSize / 2
  const shift = (size / 2 - (baseline - ink)) / size
  return Number.isFinite(shift) ? Math.max(-SHIFT_MAX, Math.min(SHIFT_MAX, shift)) : 0
}

// The first and last rows of an RGBA image with any painted pixel.
export const inkRows = (
  rgba: ArrayLike<number>,
  width: number,
  height: number
): { top: number; bottom: number } | null => {
  let top = -1
  let bottom = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] > 0) {
        if (top < 0) top = y
        bottom = y
        break
      }
    }
  }
  return top < 0 ? null : { top, bottom }
}

const SAMPLE = '\u{1F600}'
const BOX = 16
const INK = 100
const BASE = 160

// Where the page puts the baseline in a `BOX` px emoji box with line-height 1.
const layoutBaseline = (family: string): number | null => {
  const box = document.createElement('span')
  const mark = document.createElement('span')
  Object.assign(box.style, {
    position: 'absolute',
    left: '-9999px',
    top: '0',
    display: 'block',
    fontFamily: family,
    fontSize: `${BOX}px`,
    lineHeight: '1',
    whiteSpace: 'nowrap',
    visibility: 'hidden',
  })
  Object.assign(mark.style, { display: 'inline-block', width: '0', height: '0' })
  box.append(mark, SAMPLE)
  document.body.append(box)
  const base = mark.getBoundingClientRect().bottom - box.getBoundingClientRect().top
  box.remove()
  return Number.isFinite(base) ? base : null
}

// Where a glyph drawn at `size` px on the row `base` paints around its baseline. Ink at the canvas
// edge or far taller than the glyph is a canvas that hides or noises its pixels, so no measurement.
export const glyphInk = (
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  base: number,
  size: number
): { top: number; bottom: number } | null => {
  const rows = inkRows(rgba, width, height)
  if (!rows || rows.top === 0 || rows.bottom === height - 1) return null
  if (rows.bottom + 1 - rows.top > 1.5 * size) return null
  return { top: base - rows.top, bottom: rows.bottom + 1 - base }
}

// The sample glyph drawn large on a canvas.
const drawnInk = (family: string): { top: number; bottom: number } | null => {
  const canvas = document.createElement('canvas')
  canvas.width = 2 * INK
  canvas.height = 2 * INK
  const g = canvas.getContext('2d', { willReadFrequently: true })
  if (!g) return null
  g.font = `${INK}px ${family}`
  g.textBaseline = 'alphabetic'
  g.fillStyle = '#000'
  g.fillText(SAMPLE, INK / 4, BASE)
  const { data } = g.getImageData(0, 0, canvas.width, canvas.height)
  return glyphInk(data, canvas.width, canvas.height, BASE, INK)
}

export const measureEmoji = (family: string): EmojiBox | null => {
  if (typeof document === 'undefined' || !document.body || !family) return null
  const baseline = layoutBaseline(family)
  const ink = baseline === null ? null : drawnInk(family)
  if (baseline === null || !ink) return null
  return { size: BOX, baseline, inkTop: ink.top, inkBottom: ink.bottom, inkSize: INK }
}

let measured = false

// Once per page: sets `--emoji-shift` on the root for the emoji font this device shows.
export const centerEmoji = () => {
  if (measured || typeof document === 'undefined') return
  measured = true
  const root = document.documentElement
  const box = measureEmoji(getComputedStyle(root).getPropertyValue('--font-emoji').trim())
  if (box) root.style.setProperty('--emoji-shift', `${emojiShift(box).toFixed(3)}em`)
}
