import { describe, expect, test } from 'bun:test'
import {
  CanvasPainter,
  SPRITE_BUCKETS,
  SPRITE_MAX,
  SPRITE_PAD,
  SpriteAtlas,
  fitSpec,
  releaseCanvas,
  sizeCanvas,
  spriteBucket,
  type CanvasLike,
  type Ctx2d,
} from '../fx/painter'
import {
  CANVAS,
  CONFETTI_COLORS,
  DESKTOP,
  FxWorld,
  canvasBytes,
  canvasScale,
  effectSpec,
  mulberry32,
  type EffectSpec,
} from '../fx/particles'

// The real canvas and its context fit the shapes the painter asks for.
const real: HTMLCanvasElement extends CanvasLike ? true : false = true
const realCtx: CanvasRenderingContext2D extends Ctx2d ? true : false = true

type Op = [string, ...unknown[]]

// A device's canvases: `color` glyphs draw colored pixels, `mono` ones draw in the fill color,
// anything else draws nothing.
const device = (
  color: string[],
  mono: string[] = [],
  opts: { blocked?: boolean; faint?: string[] } = {}
) => {
  const made: (CanvasLike & { ops: Op[] })[] = []
  let reads = 0
  const factory = () => {
    const ops: Op[] = []
    let drawn = ''
    const ctx: Ctx2d = {
      globalAlpha: 1,
      fillStyle: '',
      font: '',
      textAlign: '',
      textBaseline: '',
      setTransform: (...a) => void ops.push(['setTransform', ...a]),
      clearRect: (...a) => void ops.push(['clearRect', ...a]),
      save: () => void ops.push(['save']),
      restore: () => void ops.push(['restore']),
      translate: (...a) => void ops.push(['translate', ...a]),
      rotate: (...a) => void ops.push(['rotate', ...a]),
      scale: (...a) => void ops.push(['scale', ...a]),
      drawImage: (...a) => void ops.push(['drawImage', ctx.globalAlpha, ...a]),
      fillRect: (...a) => void ops.push(['fillRect', ctx.fillStyle, ctx.globalAlpha, ...a]),
      fillText: (text, x, y) => {
        drawn = text
        ops.push(['fillText', text, ctx.font, ctx.fillStyle, x, y])
      },
      getImageData: () => {
        reads += 1
        if (opts.blocked) throw new Error('blocked')
        const data = new Uint8ClampedArray(16)
        if (color.includes(drawn)) data.set([0, 0, 0, 255, 250, 120, 0, 255])
        else if (mono.includes(drawn)) data.set([0, 0, 0, 255, 0, 0, 0, 90])
        else if (opts.faint?.includes(drawn)) data.set([0, 0, 0, 255, 200, 40, 40, 20])
        return { data }
      },
    }
    const canvas: CanvasLike & { ops: Op[] } = {
      width: 300,
      height: 150,
      getContext: () => ctx,
      ops,
    }
    made.push(canvas)
    return canvas
  }
  return { factory, made, reads: () => reads }
}

const opsOf = (canvas: CanvasLike) => (canvas as CanvasLike & { ops: Op[] }).ops
const texts = (d: ReturnType<typeof device>) =>
  d.made.flatMap(c => c.ops.filter(op => op[0] === 'fillText').map(op => op[1]))

describe('sprites', () => {
  test('the real canvas types fit', () => {
    expect([real, realCtx]).toEqual([true, true])
  })

  test('a size uses the smallest bucket that holds it', () => {
    expect([...SPRITE_BUCKETS]).toEqual([16, 22, 28, 32])
    expect([10, 16, 16.1, 22, 23, 28, 28.6, 32, 40].map(spriteBucket)).toEqual([
      16, 16, 22, 22, 28, 28, 32, 32, 32,
    ])
  })

  test('one sprite per glyph and bucket', () => {
    const d = device(['🎃', '👻'])
    const atlas = new SpriteAtlas(d.factory, 2, '#ffffff')
    const a = atlas.sprite('🎃', 20)
    expect(atlas.sprite('🎃', 22)).toBe(a)
    expect(atlas.sprite('🎃', 17)).toBe(a)
    const b = atlas.sprite('🎃', 30)
    expect(b).not.toBe(a)
    const c = atlas.sprite('👻', 20)
    expect(c).not.toBe(a)
    expect(atlas.size).toBe(3)
    expect(texts(d)).toEqual(['🎃', '🎃', '👻'])
  })

  test('a sprite is drawn once, centred, at the bucket size times the scale', () => {
    const d = device(['🎃'])
    const atlas = new SpriteAtlas(d.factory, 2, '#102030')
    const sprite = atlas.sprite('🎃', 20)
    const side = Math.ceil(22 * SPRITE_PAD * 2)
    expect([sprite.width, sprite.height]).toEqual([side, side])
    const [, text, font, ink, x, y] = opsOf(sprite).find(op => op[0] === 'fillText')!
    expect([text, ink, x, y]).toEqual(['🎃', '#102030', side / 2, side / 2])
    expect(String(font).startsWith('44px ')).toBe(true)
    expect(String(font)).toContain('Noto Color Emoji')
  })

  test(`at most ${SPRITE_MAX} sprites: the one unused the longest goes, and gives its memory back`, () => {
    expect(SPRITE_MAX).toBe(64)
    const d = device([])
    const atlas = new SpriteAtlas(d.factory, 1, '#fff')
    const glyph = (i: number) => String.fromCodePoint(0x4e00 + i)
    const first = atlas.sprite(glyph(0), 16)
    const second = atlas.sprite(glyph(1), 16)
    for (let i = 2; i < SPRITE_MAX; i++) atlas.sprite(glyph(i), 16)
    expect(atlas.size).toBe(SPRITE_MAX)
    expect(atlas.sprite(glyph(0), 16)).toBe(first)
    atlas.sprite(glyph(SPRITE_MAX), 16)
    expect(atlas.size).toBe(SPRITE_MAX)
    expect(atlas.sprite(glyph(0), 16)).toBe(first)
    expect([second.width, second.height]).toEqual([0, 0])
    expect(atlas.sprite(glyph(1), 16)).not.toBe(second)
    expect(atlas.size).toBe(SPRITE_MAX)
  })

  test('a full atlas at the largest size and scale stays under 4 MB', () => {
    const d = device([])
    const atlas = new SpriteAtlas(d.factory, CANVAS.desktop.dprMax, '#fff')
    for (let i = 0; i < SPRITE_MAX + 10; i++) atlas.sprite(String.fromCodePoint(0x4e00 + i), 32)
    expect(atlas.size).toBe(SPRITE_MAX)
    expect(atlas.bytes).toBe(SPRITE_MAX * 4 * 96 * 96)
    expect(atlas.bytes).toBeLessThan(4 * 1024 * 1024)
  })

  test('clear gives every sprite back', () => {
    const d = device(['🎃'])
    const atlas = new SpriteAtlas(d.factory, 1, '#fff')
    const sprite = atlas.sprite('🎃', 20)
    atlas.clear()
    expect([atlas.size, atlas.bytes, sprite.width]).toEqual([0, 0, 0])
    expect(atlas.sprite('🎃', 20)).not.toBe(sprite)
  })
})

describe('the color emoji check', () => {
  test('an emoji the device draws in color is kept; a plain or missing one is dropped', () => {
    const d = device(['🎃'], ['👻'])
    const atlas = new SpriteAtlas(d.factory, 1, '#fff')
    expect(atlas.colored('🎃')).toBe(true)
    expect(atlas.colored('👻')).toBe(false)
    expect(atlas.colored('🦇')).toBe(false)
    expect(atlas.usable(['🎃', '👻', '🦇', '🕷️'])).toEqual(['🎃'])
  })

  test('a faint colored fringe on a plain glyph is not color', () => {
    const atlas = new SpriteAtlas(device([], [], { faint: ['👻'] }).factory, 1, '#fff')
    expect(atlas.colored('👻')).toBe(false)
  })

  test('each glyph is checked once, on a canvas that is not a sprite', () => {
    const d = device(['🎃'])
    const atlas = new SpriteAtlas(d.factory, 1, '#fff')
    for (let i = 0; i < 5; i++) atlas.colored('🎃')
    for (let i = 0; i < 5; i++) atlas.colored('👻')
    expect(d.reads()).toBe(2)
    expect(atlas.size).toBe(0)
    expect(d.made).toHaveLength(1)
  })

  test('text that is not emoji is never checked and always kept', () => {
    const d = device([])
    const atlas = new SpriteAtlas(d.factory, 1, '#fff')
    expect(atlas.usable(['π', '❅', '❆', '7'])).toEqual(['π', '❅', '❆', '7'])
    expect(d.reads()).toBe(0)
  })

  test('a device that will not let pixels be read keeps every glyph', () => {
    const d = device([], [], { blocked: true })
    const atlas = new SpriteAtlas(d.factory, 1, '#fff')
    expect(atlas.usable(['🎃', '👻'])).toEqual(['🎃', '👻'])
  })

  test('a plan keeps the glyphs the device can draw', () => {
    const d = device(['🎃', '🍬'])
    const atlas = new SpriteAtlas(d.factory, 1, '#fff')
    const spec: EffectSpec = { shape: 'rain', motion: 'fall', glyphs: ['🎃', '👻', '🍬'] }
    expect(fitSpec(spec, atlas)).toEqual({ ...spec, glyphs: ['🎃', '🍬'] })
  })

  test('a plan left empty falls back to colored dots', () => {
    const atlas = new SpriteAtlas(device([]).factory, 1, '#fff')
    const spec: EffectSpec = { shape: 'rain', motion: 'fall', glyphs: ['🎃', '👻'], duration: 4 }
    expect(fitSpec(spec, atlas)).toEqual({ ...spec, glyphs: [], dots: CONFETTI_COLORS })
    const holi: EffectSpec = { shape: 'burst', motion: 'burst', glyphs: ['🎨'], dots: ['#e91e63'] }
    expect(fitSpec(holi, atlas)).toEqual({ ...holi, glyphs: [] })
  })

  test('a plan the device draws in full comes back as it was', () => {
    const atlas = new SpriteAtlas(device(['🎉']).factory, 1, '#fff')
    const spec = effectSpec('confetti', { origin: { x: 5, y: 5 } })
    expect(fitSpec(spec, atlas)).toBe(spec)
  })
})

describe('canvas sizing', () => {
  test('the backing store is the layer times the fitted scale, floored', () => {
    const { factory } = device([])
    const canvas = factory()
    const scale = sizeCanvas(canvas, 1280.5, 700.25, 2, false)
    expect(scale).toBe(canvasScale(1280.5, 700.25, 2, false))
    expect([canvas.width, canvas.height]).toEqual([
      Math.floor(1280.5 * scale),
      Math.floor(700.25 * scale),
    ])
    expect(canvasBytes(1280.5, 700.25, scale)).toBeLessThanOrEqual(CANVAS.desktop.bytes)
  })

  test('a phone at three device pixels is capped and fits its budget', () => {
    const canvas = device([]).factory()
    const scale = sizeCanvas(canvas, 390, 700, 3, true)
    expect(scale).toBeLessThanOrEqual(CANVAS.compact.dprMax)
    expect(4 * canvas.width * canvas.height).toBeLessThanOrEqual(CANVAS.compact.bytes)
  })

  test('a layer with no room gets an empty canvas, and release empties one', () => {
    const canvas = device([]).factory()
    expect(sizeCanvas(canvas, 0, 200, 2, false)).toBe(0)
    expect([canvas.width, canvas.height]).toEqual([0, 0])
    sizeCanvas(canvas, 100, 100, 1, false)
    expect([canvas.width, canvas.height]).toEqual([100, 100])
    releaseCanvas(canvas)
    expect([canvas.width, canvas.height]).toEqual([0, 0])
  })
})

describe('painting', () => {
  const rig = (scale = 2) => {
    const d = device(['🎃', '👻'])
    const atlas = new SpriteAtlas(d.factory, scale, '#fff')
    const canvas = d.factory()
    const painter = new CanvasPainter(canvas.getContext('2d')!, atlas, scale)
    return { d, atlas, canvas, painter, ops: () => opsOf(canvas) }
  }

  test('begin scales to the backing store and clears the layer', () => {
    const { painter, ops } = rig(1.5)
    painter.begin(400, 300)
    expect(ops()).toEqual([
      ['setTransform', 1.5, 0, 0, 1.5, 0, 0],
      ['clearRect', 0, 0, 400, 300],
    ])
  })

  test('a glyph is its sprite, centred at the particle, at its size and alpha', () => {
    const { painter, atlas, ops } = rig()
    painter.bind(7, ['🎃', '👻'])
    painter.glyph(7, 1, 100, 50, 20, 0, 0.5)
    const d = 20 * SPRITE_PAD
    expect(ops()).toEqual([
      ['drawImage', 0.5, atlas.sprite('👻', 20), 100 - d / 2, 50 - d / 2, d, d],
    ])
  })

  test('a turned glyph is drawn about its own centre', () => {
    const { painter, atlas, ops } = rig()
    painter.bind(7, ['🎃'])
    painter.glyph(7, 0, 100, 50, 20, 0.3, 1)
    const d = 20 * SPRITE_PAD
    expect(ops()).toEqual([
      ['save'],
      ['translate', 100, 50],
      ['rotate', 0.3],
      ['drawImage', 1, atlas.sprite('🎃', 20), -d / 2, -d / 2, d, d],
      ['restore'],
    ])
  })

  test('nothing is drawn for a glyph it does not know, or one that is invisible', () => {
    const { painter, ops } = rig()
    painter.bind(7, ['🎃'])
    painter.glyph(8, 0, 1, 1, 20, 0, 1)
    painter.glyph(7, 3, 1, 1, 20, 0, 1)
    painter.glyph(7, -1, 1, 1, 20, 0, 1)
    painter.glyph(7, 0, 1, 1, 20, 0, 0)
    painter.dot('#f00', 1, 1, 7, 0, 1, 0)
    painter.unbind(7)
    painter.glyph(7, 0, 1, 1, 20, 0, 1)
    expect(ops()).toEqual([])
  })

  test('a dot is a 7 by 4 rectangle in its color, turned and scaled by the flip', () => {
    const { painter, ops } = rig()
    painter.dot('#2196f3', 30, 40, 7, 0.2, -0.5, 0.8)
    expect(ops()).toEqual([
      ['save'],
      ['translate', 30, 40],
      ['rotate', 0.2],
      ['scale', 1, -0.5],
      ['fillRect', '#2196f3', 0.8, -3.5, -2, 7, 4],
      ['restore'],
    ])
  })

  test('end leaves the alpha as it found it', () => {
    const { painter, canvas } = rig()
    painter.bind(1, ['🎃'])
    painter.glyph(1, 0, 1, 1, 20, 0, 0.25)
    painter.end()
    expect(canvas.getContext('2d')!.globalAlpha).toBe(1)
  })

  test('a world paints through it: one draw per live particle, a few sprites', () => {
    const { painter, atlas, ops } = rig()
    const world = new FxWorld(800, 600, DESKTOP, mulberry32(3))
    const spec = fitSpec(
      { shape: 'rain', motion: 'fall', glyphs: ['🎃', '👻', '🦇'], dots: ['#f44336'] },
      atlas
    )
    expect(spec.glyphs).toEqual(['🎃', '👻'])
    const id = world.start(spec)!
    painter.bind(id, spec.glyphs)
    for (let i = 0; i < 90; i++) world.step(1 / 60)
    world.paint(painter)
    const draws = ops().filter(op => op[0] === 'drawImage' || op[0] === 'fillRect')
    expect(world.live).toBeGreaterThan(10)
    expect(draws).toHaveLength(world.live)
    expect(ops()[0]).toEqual(['setTransform', 2, 0, 0, 2, 0, 0])
    expect(atlas.size).toBeGreaterThan(0)
    expect(atlas.size).toBeLessThanOrEqual(2 * SPRITE_BUCKETS.length)
  })
})
