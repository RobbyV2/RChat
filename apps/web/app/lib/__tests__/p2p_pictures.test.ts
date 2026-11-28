import { describe, expect, test } from 'bun:test'
import { b64u } from '../p2p/canonical'
import {
  PIC_LIMITS,
  parsePic,
  picFiles,
  picWire,
  samePic,
  stillFor,
  type PicWire,
} from '../p2p/pictures'

const h = (n: number) => b64u(new Uint8Array(32).fill(n))

const wire: PicWire = { s: [h(1), 4000], l: [h(2), 60_000] }

describe('a P2P profile picture', () => {
  test('a well formed picture is read, with fields this version does not know left unread', () => {
    const pic = parsePic({ ...wire, later: { anything: true } })
    expect(pic).toEqual({ s: { h: h(1), size: 4000 }, l: { h: h(2), size: 60_000 } })
    expect(picWire(pic!)).toEqual(wire)
  })

  test('an animation is kept when it is well formed and within its cap', () => {
    const moving = parsePic({ ...wire, a: [h(3), PIC_LIMITS.animated] })
    expect(moving?.a).toEqual({ h: h(3), size: PIC_LIMITS.animated })
    expect(picWire(moving!)).toEqual({ ...wire, a: [h(3), PIC_LIMITS.animated] })
    for (const a of [[h(3), PIC_LIMITS.animated + 1], [h(3)], 'x', [h(3), 0], ['short', 10]])
      expect(parsePic({ ...wire, a } as unknown)).toEqual(parsePic(wire))
  })

  test('a malformed or oversized frame reads as no picture', () => {
    for (const bad of [
      null,
      undefined,
      'pic',
      [],
      {},
      { s: wire.s },
      { ...wire, s: [h(1), PIC_LIMITS.still + 1] },
      { ...wire, l: [h(2), 0] },
      { ...wire, l: [h(2), 1.5] },
      { ...wire, s: ['not-a-hash', 10] },
      { ...wire, s: [h(1), 10, 'more'] },
      { ...wire, l: { h: h(2), size: 10 } },
    ])
      expect(parsePic(bad)).toBeUndefined()
  })

  test('pictures compare by their files', () => {
    const a = parsePic(wire)
    expect(samePic(a, parsePic(wire))).toBe(true)
    expect(samePic(a, parsePic({ ...wire, a: [h(3), 9] }))).toBe(false)
    expect(samePic(a, parsePic({ ...wire, l: [h(4), 60_000] }))).toBe(false)
    expect(samePic(undefined, null)).toBe(true)
    expect(samePic(a, undefined)).toBe(false)
  })

  test('its files are listed for the gates, and a drawing takes the frame that fills it', () => {
    const pic = parsePic({ ...wire, a: [h(3), 9] })!
    expect(picFiles(pic).map(f => f.h)).toEqual([h(1), h(2), h(3)])
    expect(picFiles(null)).toEqual([])
    expect(stillFor(pic, 32)).toBe(pic.s)
    expect(stillFor(pic, 64)).toBe(pic.s)
    expect(stillFor(pic, 80)).toBe(pic.l)
  })
})
