// The canvas painter: sizes a layer's canvas, keeps one sprite per glyph and size bucket for
// the whole tab, and drops emoji the device cannot draw in color. Canvases come from a factory
// (the document in the app, a fake in tests).
import { CONFETTI_COLORS, canvasScale, type EffectSpec, type Painter } from './particles'

// The parts of a 2D context the painter uses.
export interface Ctx2d {
  globalAlpha: number
  fillStyle: unknown
  font: string
  textAlign: string
  textBaseline: string
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
  clearRect(x: number, y: number, w: number, h: number): void
  save(): void
  restore(): void
  translate(x: number, y: number): void
  rotate(angle: number): void
  scale(x: number, y: number): void
  drawImage(image: unknown, x: number, y: number, w: number, h: number): void
  fillRect(x: number, y: number, w: number, h: number): void
  fillText(text: string, x: number, y: number): void
  getImageData(x: number, y: number, w: number, h: number): { data: ArrayLike<number> }
}

export interface CanvasLike {
  width: number
  height: number
  getContext(kind: '2d', options?: { willReadFrequently?: boolean }): Ctx2d | null
}

export type CanvasFactory = () => CanvasLike

// Sizes the canvas for a layer of w by h CSS px and returns its scale (0 with no room).
export function sizeCanvas(
  canvas: CanvasLike,
  w: number,
  h: number,
  dpr: number,
  compact: boolean
): number {
  const scale = canvasScale(w, h, dpr, compact)
  canvas.width = Math.floor(w * scale)
  canvas.height = Math.floor(h * scale)
  return scale
}

// An idle layer holds no pixels.
export const releaseCanvas = (canvas: CanvasLike) => {
  canvas.width = 0
  canvas.height = 0
}

export const SPRITE_BUCKETS = [16, 22, 28, 32] as const
export const SPRITE_MAX = 64
// A sprite is this much wider than its glyph's size: emoji reach past their box.
export const SPRITE_PAD = 1.5

const FONT = "'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif"
const EMOJI = /\p{Extended_Pictographic}/u
const CHECK_PX = 24

export const spriteBucket = (size: number) =>
  SPRITE_BUCKETS.find(b => b >= size) ?? SPRITE_BUCKETS[SPRITE_BUCKETS.length - 1]

export class SpriteAtlas {
  private sprites = new Map<string, CanvasLike>()
  private color = new Map<string, boolean>()
  private probe: Ctx2d | null = null

  // `scale` is the backing-store scale sprites are drawn at; `ink` colors glyphs that are text.
  constructor(
    private factory: CanvasFactory,
    private scale: number,
    private ink: string
  ) {}

  get size() {
    return this.sprites.size
  }

  get bytes() {
    let n = 0
    for (const s of this.sprites.values()) n += 4 * s.width * s.height
    return n
  }

  // The sprite for a glyph at a particle size; the one unused the longest makes room.
  sprite(glyph: string, size: number): CanvasLike {
    const bucket = spriteBucket(size)
    const key = `${bucket} ${glyph}`
    const hit = this.sprites.get(key)
    if (hit) {
      this.sprites.delete(key)
      this.sprites.set(key, hit)
      return hit
    }
    if (this.sprites.size >= SPRITE_MAX) {
      const [oldest, canvas] = this.sprites.entries().next().value as [string, CanvasLike]
      releaseCanvas(canvas)
      this.sprites.delete(oldest)
    }
    const canvas = this.factory()
    const side = Math.ceil(bucket * SPRITE_PAD * this.scale)
    canvas.width = side
    canvas.height = side
    const ctx = canvas.getContext('2d')
    if (ctx) this.draw(ctx, glyph, bucket * this.scale, side, this.ink)
    this.sprites.set(key, canvas)
    return canvas
  }

  // Whether the device draws this emoji in color. Checked once per glyph, on this device;
  // glyphs that are text (pi, snow crystals) are drawn in the ink color and always kept.
  colored(glyph: string): boolean {
    if (!EMOJI.test(glyph)) return true
    const known = this.color.get(glyph)
    if (known !== undefined) return known
    const found = this.check(glyph)
    this.color.set(glyph, found)
    return found
  }

  usable(glyphs: readonly string[]) {
    return glyphs.filter(g => this.colored(g))
  }

  clear() {
    for (const canvas of this.sprites.values()) releaseCanvas(canvas)
    this.sprites.clear()
  }

  private draw(ctx: Ctx2d, glyph: string, px: number, side: number, fill: string) {
    ctx.font = `${px}px ${FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = fill
    ctx.fillText(glyph, side / 2, side / 2)
  }

  private check(glyph: string): boolean {
    try {
      if (!this.probe) {
        const canvas = this.factory()
        canvas.width = CHECK_PX
        canvas.height = CHECK_PX
        this.probe = canvas.getContext('2d', { willReadFrequently: true })
      }
      const ctx = this.probe
      if (!ctx) return true
      ctx.clearRect(0, 0, CHECK_PX, CHECK_PX)
      this.draw(ctx, glyph, CHECK_PX / SPRITE_PAD, CHECK_PX, '#000000')
      const { data } = ctx.getImageData(0, 0, CHECK_PX, CHECK_PX)
      for (let i = 0; i < data.length; i += 4)
        if (data[i + 3] > 32 && (data[i] > 24 || data[i + 1] > 24 || data[i + 2] > 24)) return true
      return false
    } catch {
      return true
    }
  }
}

// The spec with only the glyphs the device can draw; one left with nothing rains colored dots.
export function fitSpec(spec: EffectSpec, atlas: SpriteAtlas): EffectSpec {
  const glyphs = atlas.usable(spec.glyphs)
  if (glyphs.length === spec.glyphs.length) return spec
  if (glyphs.length || spec.dots?.length) return { ...spec, glyphs }
  return { ...spec, glyphs, dots: CONFETTI_COLORS }
}

export class CanvasPainter implements Painter {
  private glyphs = new Map<number, readonly string[]>()

  constructor(
    private ctx: Ctx2d,
    private atlas: SpriteAtlas,
    private scale: number
  ) {}

  // The glyph list of a started effect (`FxWorld.start`'s id and its spec's glyphs).
  bind(effect: number, glyphs: readonly string[]) {
    this.glyphs.set(effect, glyphs)
  }

  unbind(effect: number) {
    this.glyphs.delete(effect)
  }

  begin(w: number, h: number) {
    this.ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0)
    this.ctx.clearRect(0, 0, w, h)
  }

  glyph(
    effect: number,
    glyph: number,
    x: number,
    y: number,
    size: number,
    rot: number,
    alpha: number
  ) {
    const text = this.glyphs.get(effect)?.[glyph]
    if (text === undefined || alpha <= 0) return
    const { ctx } = this
    const sprite = this.atlas.sprite(text, size)
    const d = size * SPRITE_PAD
    ctx.globalAlpha = alpha
    if (rot === 0) {
      ctx.drawImage(sprite, x - d / 2, y - d / 2, d, d)
      return
    }
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(rot)
    ctx.drawImage(sprite, -d / 2, -d / 2, d, d)
    ctx.restore()
  }

  // A piece of paper, 7 by 4 at size 7, turning front to back with `flip`.
  dot(color: string, x: number, y: number, size: number, rot: number, flip: number, alpha: number) {
    if (alpha <= 0) return
    const { ctx } = this
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(rot)
    ctx.scale(1, flip)
    ctx.globalAlpha = alpha
    ctx.fillStyle = color
    ctx.fillRect(-size / 2, (-size * 2) / 7, size, (size * 4) / 7)
    ctx.restore()
  }

  end() {
    this.ctx.globalAlpha = 1
  }
}
