import { describe, expect, test } from 'bun:test'
import { readFileSync, statSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { AVATAR_IMAGES } from '../avatar_images'
import { PICTURE_MODULE, pictureFiles, placeholderOf, type PictureModule } from '../picture_files'
import { aspectRatio, hashBytes, placeholderUrl } from '../thumbhash'
import { built, wasmBuild } from './helpers/perms'

const crc = (bytes: Uint8Array) => {
  let c = 0xffffffff
  for (const b of bytes) {
    c ^= b
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}

const chunk = (kind: string, data: Uint8Array) => {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(new TextEncoder().encode(kind), 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)))
  return out
}

// A gray square PNG of `side` pixels.
const png = (side: number) => {
  const head = new Uint8Array(13)
  const view = new DataView(head.buffer)
  view.setUint32(0, side)
  view.setUint32(4, side)
  head.set([8, 0, 0, 0, 0], 8)
  const rows = new Uint8Array((side + 1) * side).fill(128)
  for (let y = 0; y < side; y++) rows[y * (side + 1)] = 0
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', head),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', new Uint8Array()),
  ]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const pictureBuild = async (): Promise<PictureModule> => {
  const mod = (await import(built(`${PICTURE_MODULE}.js`))) as PictureModule & {
    initSync: (init: { module: Uint8Array }) => unknown
  }
  mod.initSync({ module: readFileSync(built(`${PICTURE_MODULE}_bg.wasm`)) })
  return mod
}

describe('the picture codec is its own module', () => {
  test('the module the app starts with carries no image code', async () => {
    expect(statSync(built('rust_next_wasm_bg.wasm')).size).toBeLessThan(1_000_000)
    const shared = await wasmBuild()
    expect(Object.keys(shared).filter(name => name.startsWith('picture'))).toEqual([])
  })

  test('the picture module makes the files of every size from an image', async () => {
    const made = await pictureFiles(
      new Blob([png(96)], { type: 'image/png' }),
      { x: 0, y: 0, size: 96 },
      true,
      pictureBuild
    )
    if ('error' in made) throw new Error(made.error)
    expect(made.files.length).toBe(AVATAR_IMAGES.sizes.length)
    expect(made.files.every(file => file.size > 0 && file.type === 'image/jpeg')).toBe(true)
    expect(made.animation).toBeNull()
  })

  test('a file that is no image is refused in words', async () => {
    const made = await pictureFiles(
      new Blob(['text']),
      { x: 0, y: 0, size: 64 },
      false,
      pictureBuild
    )
    expect(made).toEqual({ error: "Couldn't read that image" })
  })
})

describe('image placeholders', () => {
  test('the picture module makes the ThumbHash the client draws', async () => {
    const square = await placeholderOf(new Blob([png(96)]), pictureBuild)
    expect(square === undefined).toBe(false)
    const bytes = hashBytes(square)
    expect(bytes).not.toBeNull()
    expect(Math.abs(aspectRatio(bytes as Uint8Array) - 1) < 0.2).toBe(true)
    expect(placeholderUrl(square)?.startsWith('data:image/png;base64,')).toBe(true)
    expect(await placeholderOf(new Blob(['text']), pictureBuild)).toBeUndefined()
  })

  test('a malformed placeholder draws nothing', () => {
    for (const bad of ['', 'a+b', 'x'.repeat(65), 7, null, 'AB'])
      expect(placeholderUrl(bad)).toBeNull()
  })
})
