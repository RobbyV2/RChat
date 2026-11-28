import { describe, expect, test } from 'bun:test'
import { b64u } from '../p2p/canonical'
import { pictureGate, type PictureFacts, type PictureScope } from '../p2p/picture_gate'
import type { P2pPic } from '../p2p/pictures'

const h = (n: number) => b64u(new Uint8Array(32).fill(n))
const pic = (n: number, animated = false): P2pPic => ({
  s: { h: h(n), size: 10 },
  l: { h: h(n + 1), size: 20 },
  ...(animated ? { a: { h: h(n + 2), size: 30 } } : {}),
})

const mine = pic(10, true)
const inRoom = pic(40)
const roomPic = pic(50)
const theirRoomPic = pic(60)
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
      id: 'r1',
      mine: inRoom,
      identity: false,
      about: roomPic,
      members: [
        { ik: 'carol', pic: carols },
        { ik: 'erin', pic: null },
        { ik: 'mallory', pic: { s: { h: held, size: 10 }, l: { h: held, size: 10 } } },
      ],
    },
    {
      id: 'r2',
      mine: null,
      identity: true,
      about: theirRoomPic,
      members: [{ ik: 'fay', pic: null }],
    },
    // A room whose manager names our own pictures as the room's.
    { id: 'r3', mine: null, identity: false, about: mine, members: [{ ik: 'gus', pic: null }] },
    { id: 'r4', mine: null, identity: false, about: inRoom, members: [{ ik: 'gus', pic: null }] },
  ],
}

// What this device made each file for.
const madeFor = new Map<string, PictureScope>([
  ...[mine.s.h, mine.l.h, mine.a!.h].map(file => [file, 'identity'] as [string, PictureScope]),
  ...[inRoom.s.h, inRoom.l.h].map(file => [file, 'profile:r1'] as [string, PictureScope]),
  ...[roomPic.s.h, roomPic.l.h].map(file => [file, 'about:r1'] as [string, PictureScope]),
])
const made = async (file: string, scope: PictureScope) => madeFor.get(file) === scope
const gate = pictureGate(() => facts, made)

describe('the gate of picture files', () => {
  test('the picture of our identity goes to our contacts and to rooms that show it', async () => {
    for (const file of [mine.s.h, mine.l.h, mine.a!.h]) {
      expect(await gate.entitled('bob', file)).toBe(true)
      expect(await gate.entitled('dan', file)).toBe(true)
      expect(await gate.entitled('fay', file)).toBe(true)
      expect(await gate.entitled('carol', file)).toBe(false)
      expect(await gate.entitled('stranger', file)).toBe(false)
      expect(await gate.entitled('me', file)).toBe(false)
    }
  })

  test('our picture in a room, and the room picture we made, go to its joined members', async () => {
    for (const ik of ['carol', 'erin', 'mallory']) {
      expect(await gate.entitled(ik, inRoom.s.h)).toBe(true)
      expect(await gate.entitled(ik, roomPic.l.h)).toBe(true)
    }
    expect(await gate.entitled('fay', inRoom.s.h)).toBe(false)
    expect(await gate.entitled('fay', roomPic.s.h)).toBe(false)
    expect(await gate.entitled('bob', inRoom.l.h)).toBe(false)
  })

  test('a hash someone else names as a picture fetches nothing from us', async () => {
    for (const ik of ['mallory', 'carol', 'erin', 'bob', 'stranger'])
      expect(await gate.entitled(ik, held)).toBe(false)
    expect(await gate.entitled('erin', carols.s.h)).toBe(false)
    expect(await gate.entitled('carol', bobs.s.h)).toBe(false)
    expect(await gate.entitled('fay', theirRoomPic.s.h)).toBe(false)
  })

  test('a file made for one picture never answers for another', async () => {
    // The pictures a manager of another room names as that room's stay with whom they were
    // made for.
    expect(await gate.entitled('gus', mine.s.h)).toBe(false)
    expect(await gate.entitled('gus', inRoom.s.h)).toBe(false)
    const naming = pictureGate(
      () => ({ ...facts, own: { s: { h: held, size: 10 }, l: { h: held, size: 10 } } }),
      made
    )
    expect(await naming.entitled('bob', held)).toBe(false)
  })

  test('a picture is asked of the one who names it, and a room picture of its members', () => {
    expect(gate.holders(bobs.s.h)).toEqual(['bob'])
    expect(gate.holders(carols.l.h)).toEqual(['carol'])
    expect(gate.holders(held)).toEqual(['mallory'])
    expect(gate.holders(theirRoomPic.s.h)).toEqual(['fay'])
    expect(gate.holders(mine.s.h)).toEqual(['gus'])
    expect(gate.holders(h(7))).toEqual([])
  })
})
