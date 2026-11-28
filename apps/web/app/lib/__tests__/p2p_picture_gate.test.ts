import { describe, expect, test } from 'bun:test'
import { b64u } from '../p2p/canonical'
import { pictureGate, type PictureFacts } from '../p2p/picture_gate'
import type { P2pPic } from '../p2p/pictures'

const h = (n: number) => b64u(new Uint8Array(32).fill(n))
const pic = (n: number, animated = false): P2pPic => ({
  s: { h: h(n), size: 10 },
  l: { h: h(n + 1), size: 20 },
  ...(animated ? { a: { h: h(n + 2), size: 30 } } : {}),
})

const mine = pic(10, true)
const inRoom = pic(40)
const bobs = pic(20)
const carols = pic(30)
// A file this device holds for another reason, such as a private attachment.
const held = h(99)

const facts: PictureFacts = {
  me: 'me',
  own: mine,
  contacts: [
    { ik: 'bob', pic: bobs },
    { ik: 'dan', pic: null },
  ],
  rooms: [
    {
      mine: inRoom,
      members: [
        { ik: 'carol', pic: carols },
        { ik: 'erin', pic: null },
        { ik: 'mallory', pic: { s: { h: held, size: 10 }, l: { h: held, size: 10 } } },
      ],
    },
    { mine: null, members: [{ ik: 'fay', pic: null }] },
  ],
}

const gate = pictureGate(() => facts)

describe('the gate of profile picture files', () => {
  test('the picture of our identity goes to our contacts', () => {
    for (const file of [mine.s.h, mine.l.h, mine.a!.h]) {
      expect(gate.entitled('bob', file)).toBe(true)
      expect(gate.entitled('dan', file)).toBe(true)
      expect(gate.entitled('carol', file)).toBe(false)
      expect(gate.entitled('stranger', file)).toBe(false)
      expect(gate.entitled('me', file)).toBe(false)
    }
  })

  test('the picture a room shows of us goes to the joined members of that room', () => {
    for (const ik of ['carol', 'erin', 'mallory']) expect(gate.entitled(ik, inRoom.s.h)).toBe(true)
    expect(gate.entitled('fay', inRoom.s.h)).toBe(false)
    expect(gate.entitled('bob', inRoom.l.h)).toBe(false)
  })

  test('a hash someone else names as their picture fetches nothing from us', () => {
    for (const ik of ['mallory', 'carol', 'erin', 'bob', 'stranger'])
      expect(gate.entitled(ik, held)).toBe(false)
    expect(gate.entitled('erin', carols.s.h)).toBe(false)
    expect(gate.entitled('carol', bobs.s.h)).toBe(false)
  })

  test('a picture is asked of the one who names it as theirs', () => {
    expect(gate.holders(bobs.s.h)).toEqual(['bob'])
    expect(gate.holders(carols.l.h)).toEqual(['carol'])
    expect(gate.holders(held)).toEqual(['mallory'])
    expect(gate.holders(mine.s.h)).toEqual([])
    expect(gate.holders(h(7))).toEqual([])
  })
})
