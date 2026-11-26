// The favicon with a dot in its lower right corner: a red dot for unread messages, and a red dot
// with a white ring and center for notifications. Drawn once per icon and mark.
import type { TabMark } from './platform/notifications'

const SIZE = 64

// Where the dot goes on a square icon of `size` pixels: its center, radius and ring width, so the
// ring stays inside the icon.
export const dotGeometry = (size: number) => {
  const ring = Math.max(2, Math.round(size / 24))
  const r = Math.round(size * 0.2)
  const at = size - r - ring
  return { x: at, y: at, r, ring }
}

// Drawn icons by mark and source; null for a source that can't be drawn.
const drawn = new Map<string, string | null>()

const load = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })

const draw = async (src: string, mark: Exclude<TabMark, 'none'>) => {
  try {
    const img = await load(src)
    const canvas = document.createElement('canvas')
    canvas.width = SIZE
    canvas.height = SIZE
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, SIZE, SIZE)
    const { x, y, r, ring } = dotGeometry(SIZE)
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fillStyle = '#dc362e'
    ctx.fill()
    if (mark === 'pings') {
      ctx.lineWidth = ring * 2
      ctx.strokeStyle = '#ffffff'
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(x, y, Math.round(r / 3), 0, Math.PI * 2)
      ctx.fillStyle = '#ffffff'
      ctx.fill()
    }
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

// The icon at `src` as a data URL with the dot for `mark`, or null where canvas can't draw it.
export async function badgedIcon(src: string, mark: Exclude<TabMark, 'none'>) {
  const key = `${mark}\n${src}`
  if (drawn.has(key)) return drawn.get(key) ?? null
  const url = await draw(src, mark)
  drawn.set(key, url)
  return url
}
