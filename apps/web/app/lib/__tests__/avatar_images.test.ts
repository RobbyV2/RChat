import { describe, expect, test } from 'bun:test'
import shared from '../../../../../assets/avatar_images.json'
import {
  AVATAR_IMAGES,
  imageError,
  maxZoom,
  moved,
  sizeFor,
  sourceError,
  startCrop,
  zoomOf,
  zoomed,
} from '../avatar_images'

const MIB = 1024 * 1024

describe('profile picture images', () => {
  test('the sizes and bounds are the shared ones', () => {
    expect(JSON.parse(JSON.stringify(AVATAR_IMAGES))).toEqual(shared)
  })

  test('a drawing takes the smallest stored size that fills it', () => {
    expect(sizeFor(32)).toBe(64)
    expect(sizeFor(32, 2)).toBe(64)
    expect(sizeFor(48, 2)).toBe(128)
    expect(sizeFor(64, 2)).toBe(128)
    expect(sizeFor(80, 2)).toBe(512)
    expect(sizeFor(400, 3)).toBe(512)
  })

  test('a file of another type or over the limit is refused before it is read', () => {
    expect(sourceError({ size: 10, type: 'image/png' }, 8 * MIB)).toBeNull()
    expect(sourceError({ size: 10, type: 'image/webp' }, 8 * MIB)).toBeNull()
    expect(sourceError({ size: 10, type: 'image/svg+xml' }, 8 * MIB)).toBe(
      'Choose a PNG, JPEG, GIF or WebP image'
    )
    expect(sourceError({ size: 8 * MIB + 1, type: 'image/jpeg' }, 8 * MIB)).toBe(
      'Pictures can be up to 8 MB'
    )
    expect(sourceError({ size: 8 * MIB, type: 'image/jpeg' }, 8 * MIB)).toBeNull()
  })

  test('an image under the smallest crop or over the pixel bound is refused', () => {
    expect(imageError(16, 16)).toBeNull()
    expect(imageError(15, 400)).toBe('The picture must be at least 16 pixels wide and tall')
    expect(imageError(8000, 5000)).toBeNull()
    expect(imageError(8000, 5001)).toBe('The picture has too many pixels')
  })

  test('the first crop is the centered largest square', () => {
    expect(startCrop(400, 200)).toEqual({ x: 100, y: 0, size: 200 })
    expect(startCrop(200, 301)).toEqual({ x: 0, y: 51, size: 200 })
  })

  test('zooming keeps the center and stops at the smallest crop', () => {
    const start = startCrop(400, 400)
    const twice = zoomed(400, 400, start, 2)
    expect(twice).toEqual({ x: 100, y: 100, size: 200 })
    expect(zoomOf(400, 400, twice)).toBe(2)
    expect(maxZoom(400, 400)).toBe(400 / 64)
    expect(zoomed(400, 400, start, 1000).size).toBe(64)
    expect(zoomed(400, 400, twice, 0.1)).toEqual(start)
    expect(maxZoom(40, 20)).toBe(1)
    expect(zoomed(40, 20, startCrop(40, 20), 3)).toEqual({ x: 10, y: 0, size: 20 })
  })

  test('a moved crop stays inside the image in whole pixels', () => {
    const crop = { x: 100, y: 100, size: 200 }
    expect(moved(400, 400, crop, 30.4, -20.6)).toEqual({ x: 130, y: 79, size: 200 })
    expect(moved(400, 400, crop, 1000, 1000)).toEqual({ x: 200, y: 200, size: 200 })
    expect(moved(400, 400, crop, -1000, -1000)).toEqual({ x: 0, y: 0, size: 200 })
  })
})
