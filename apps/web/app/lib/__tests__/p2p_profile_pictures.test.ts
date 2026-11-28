import { describe, expect, test } from 'bun:test'
import { AVATAR_IMAGES } from '../avatar_images'
import { b64u } from '../p2p/canonical'
import {
  P2P_NOT_RUNNING,
  PICTURE_TOO_DETAILED,
  identityPicOf,
  keptPic,
  pictureFacts,
} from '../p2p/app/pictures'
import type { P2pState } from '../p2p/app/store'
import { PIC_LIMITS, parsePic, picWire, type P2pPic, type PicWire } from '../p2p/pictures'
import { shownUser } from '../people'
import { NO_PICTURE_MODULE, PICTURE_REFUSALS, pictureFiles } from '../picture_files'
import { identityPic, roomExtras, roomProfile, sameExtras } from '../profile_fields'
import { partOf, settleIntent, withoutFields } from '../profile_reset'
import { roomLookOf, roomLooksKey } from '../server_profile'

const h = (n: number) => b64u(new Uint8Array(32).fill(n))
const wire = (n: number): PicWire => ({ s: [h(n), 10], l: [h(n + 1), 20] })
const pic = (n: number) => parsePic(wire(n)) as P2pPic

describe('a room profile with a picture', () => {
  test('the room picture is read beside the other extras and a malformed one is left out', () => {
    const extras = roomExtras({ nick: 'Bo', rpic: wire(1), later: 1 })
    expect(extras).toEqual({ nick: 'Bo', rpic: wire(1) })
    expect(roomExtras({ nick: 'Bo', rpic: { s: 'x' } })).toEqual({ nick: 'Bo' })
    expect(roomProfile(extras, 'all').look).toEqual({
      name: 'Bo',
      avatar_kind: null,
      avatar_color: null,
      avatar_pic: pic(1),
    })
    expect(roomProfile({ rpic: wire(1) }, 'no_names').look?.avatar_pic).toEqual(pic(1))
    expect(roomProfile({ rpic: wire(1) }, 'off').look).toBeNull()
    expect(sameExtras({ rpic: wire(1) }, { rpic: wire(1) })).toBe(true)
    expect(sameExtras({ rpic: wire(1) }, { rpic: wire(3) })).toBe(false)
    expect(sameExtras({ rpic: wire(1) }, {})).toBe(false)
  })

  test('the picture of the identity rides beside the name in a profile write', () => {
    expect(identityPic({ name: 'Bob', pic: wire(5) })).toEqual(pic(5))
    expect(identityPic({ name: 'Bob', pic: 'x' })).toBeUndefined()
    expect(identityPic({ name: 'Bob' })).toBeUndefined()
    expect(identityPic(null)).toBeUndefined()
  })

  test('a reset of the avatar takes the room picture with the avatar kind', () => {
    const extras = roomExtras({ nick: 'Bo', av: { kind: 'identicon' }, rpic: wire(1) })
    expect(withoutFields(extras, ['avatar'])).toEqual({ nick: 'Bo' })
    expect(withoutFields(extras, ['name'])).toEqual({ av: { kind: 'identicon' }, rpic: wire(1) })
    expect(partOf({ rpic: wire(1) }, 'avatar')).not.toBe(partOf({ rpic: wire(3) }, 'avatar'))
    expect(partOf({ av: { kind: 'identicon' } }, 'avatar')).not.toBe(partOf(extras, 'avatar'))
    expect(partOf({ nick: 'Bo' }, 'avatar')).toBeUndefined()
    const settled = settleIntent(extras, {}, extras, { last: 'e1', hide: ['avatar'] })
    expect(settled).toEqual({
      intent: { nick: 'Bo' },
      gone: { av: { kind: 'identicon' }, rpic: wire(1) },
    })
  })

  test('a member row shows the room picture, and its key changes with the picture', () => {
    const plain = { ik: 'k1', name: 'Bob' }
    expect(roomLookOf(plain)).toBeNull()
    expect(roomLookOf({ ...plain, pic: pic(1) })).toEqual({
      name: null,
      avatar_kind: null,
      avatar_color: null,
      avatar_pic: pic(1),
    })
    expect(roomLooksKey([{ ...plain, pic: pic(1) }])).not.toBe(roomLooksKey([plain]))
    expect(roomLooksKey([{ ...plain, pic: pic(1) }])).not.toBe(
      roomLooksKey([{ ...plain, pic: pic(3) }])
    )
  })
})

describe('the P2P picture a person carries', () => {
  const key = {
    username: 'k1',
    display_name: 'Bob',
    avatar_kind: 'identicon' as const,
    avatar_color: null,
  }

  test('without a look nothing is settled, so the picture of the identity shows', () => {
    expect('avatar_pic' in shownUser(key, null)).toBe(false)
    expect(shownUser({ ...key, avatar_pic: pic(1) }, null).avatar_pic).toEqual(pic(1))
  })

  test('a look settles it: its picture, none when it says so, else what the key had', () => {
    const named = { name: 'Bo', avatar_kind: null, avatar_color: null }
    expect(shownUser(key, { ...named, avatar_pic: pic(1) }).avatar_pic).toEqual(pic(1))
    expect('avatar_pic' in shownUser(key, named)).toBe(false)
    const kind = roomLookOf({ name: 'Bob', av: { kind: 'color', bg: '#112233' } })
    expect(kind?.avatar_pic).toBeNull()
    expect(shownUser({ ...key, avatar_pic: pic(5) }, kind).avatar_pic).toBeNull()
    const both = roomLookOf({ name: 'Bob', av: { kind: 'color', bg: '#112233' }, pic: pic(3) })
    expect(shownUser(key, both).avatar_pic).toEqual(pic(3))
  })
})

describe('what the picture gate reads from the state', () => {
  const contact = (ik: string, state: string, sent?: PicWire) => ({ ik, state, pic: sent })
  const member = (ik: string, m: string, shown?: P2pPic) => ({ ik, m, pic: shown })
  const state = {
    ik: 'me',
    pic: pic(1),
    contacts: [contact('bob', 'mutual', wire(3)), contact('eve', 'blocked', wire(5))],
    servers: {
      r1: {
        me: 'join',
        profile: {},
        members: [member('carol', 'join', pic(7)), member('gone', 'leave'), member('me', 'join')],
      },
      r2: { me: 'leave', profile: {}, members: [member('dan', 'join')] },
      r3: { me: 'join', profile: { rpic: wire(9) }, members: [] },
      r4: { me: 'join', profile: { av: { kind: 'color', bg: '#112233' } }, members: [] },
    },
  } as unknown as P2pState

  test('our contacts are the mutual ones, and each joined room has what it shows of us', () => {
    const facts = pictureFacts(state)
    expect(facts.contacts).toEqual([{ ik: 'bob', pic: pic(3) }])
    expect(facts.rooms).toEqual([
      { mine: pic(1), members: [{ ik: 'carol', pic: pic(7) }] },
      { mine: pic(9), members: [] },
      { mine: null, members: [] },
    ])
    expect(pictureFacts(state)).toBe(facts)
  })

  test('the picture of an identity is our own or the one its contact sent', () => {
    expect(identityPicOf(state, 'me')).toEqual(pic(1))
    expect(identityPicOf(state, 'bob')).toEqual(pic(3))
    expect(identityPicOf(state, 'carol')).toBeNull()
  })
})

describe('a picture made on this device', () => {
  const blob = (bytes: number) => new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' })
  const file = new Blob([new Uint8Array(4)])
  const crop = { x: 1, y: 2, size: 64 }

  test('the shared module makes one file per size, and its refusals have their text', async () => {
    const calls: number[][] = []
    const module = {
      picture_files: (bytes: Uint8Array, x: number, y: number, size: number) => {
        calls.push([bytes.length, x, y, size])
        return { mime: 'image/png', file: (at: number) => new Uint8Array(at + 1), free: () => {} }
      },
    }
    const made = await pictureFiles(file, crop, async () => module)
    expect(calls).toEqual([[4, 1, 2, 64]])
    expect('files' in made && made.files.map(f => [f.size, f.type])).toEqual([
      [1, 'image/png'],
      [2, 'image/png'],
      [3, 'image/png'],
    ])
    const refusing = {
      picture_files: () => {
        throw new Error('too_large')
      },
    }
    expect(await pictureFiles(file, crop, async () => refusing)).toEqual({
      error: PICTURE_REFUSALS.too_large,
    })
    const failing = () => Promise.reject(new Error('no module'))
    expect(await pictureFiles(file, crop, failing)).toEqual({ error: NO_PICTURE_MODULE })
  })

  test('the 128 and 512 pixel files are kept for peers, within the size a file may have', async () => {
    const kept: number[] = []
    const keeper = {
      keepPicture: async (files: readonly Blob[]) =>
        files.map((f, i) => {
          kept.push(f.size)
          return { h: h(i + 1), size: f.size }
        }),
    }
    const made = { files: [blob(5), blob(50), blob(500)] }
    expect(await keptPic(keeper, made)).toEqual({
      s: { h: h(1), size: 50 },
      l: { h: h(2), size: 500 },
    })
    expect(kept).toEqual([50, 500])
    expect(PIC_LIMITS.still).toBe(AVATAR_IMAGES.p2p_max_bytes)
    const heavy = { files: [blob(5), blob(50), blob(PIC_LIMITS.still + 1)] }
    expect(await keptPic(keeper, heavy)).toBe(PICTURE_TOO_DETAILED)
    expect(await keptPic(keeper, { error: 'why' })).toBe('why')
    expect(await keptPic({ keepPicture: async () => null }, made)).toBe(P2P_NOT_RUNNING)
    expect(picWire(pic(1))).toEqual(wire(1))
  })
})
