import { describe, expect, test } from 'bun:test'
import {
  PENDING,
  carriedOf,
  forwardPill,
  hostedPill,
  hostedPlace,
  needsLookup,
  p2pCarried,
  p2pNames,
  p2pPill,
  p2pPlace,
  textHash,
  vouchedFiles,
  vouches,
  type Carried,
  type ForwardPill,
  type HeldOriginal,
  type NamesOf,
  type PlaceNames,
} from '../forward_pill'
import type { Attachment, FwdPlace } from '../p2p/content'
import type { ForwardRef } from '../types'
import { msg, serverDetail, user } from './fixtures'

const NAMES: PlaceNames = {
  server: { key: 'club', name: 'Book Club', p2p: false },
  channel: { id: 7, name: 'reading' },
}
const resolves: NamesOf = () => NAMES
const unknown: NamesOf = () => null
const nothing: Carried = { server: null, channel: null, dm: false }
const vault: Carried = { server: 'Vault', channel: 'lobby', dm: false }
const dm: Carried = { server: null, channel: null, dm: true }
const channel = { kind: 'channel', server: 'club', channelId: 7 } as const
const lockedVault = (pending: boolean): ForwardPill => ({
  kind: 'named',
  server: 'Vault',
  channel: 'lobby',
  pending,
})

describe('forwardPill', () => {
  test('a direct message, carried or found, opens only for a participant', () => {
    expect(forwardPill(dm, PENDING, resolves)).toEqual({ kind: 'dm', open: false })
    expect(forwardPill(dm, { kind: 'none' }, resolves)).toEqual({ kind: 'dm', open: false })
    expect(forwardPill(dm, { kind: 'dm', mine: true }, resolves)).toEqual({
      kind: 'dm',
      open: true,
    })
    expect(forwardPill(nothing, { kind: 'dm', mine: true }, resolves)).toEqual({
      kind: 'dm',
      open: true,
    })
    expect(forwardPill(vault, { kind: 'dm', mine: false }, resolves)).toEqual({
      kind: 'dm',
      open: false,
    })
  })

  test('a readable place opens under the viewer’s own names, never the carried ones', () => {
    expect(forwardPill(vault, channel, resolves)).toEqual({ kind: 'open', ...NAMES })
    expect(forwardPill(nothing, channel, resolves)).toEqual({ kind: 'open', ...NAMES })
    const room = { kind: 'room', room: 'r', ch: 'c', ev: 'e' } as const
    expect(forwardPill(nothing, room, resolves)).toEqual({ kind: 'open', ...NAMES })
  })

  test('a readable place the store does not list yet waits on the carried names', () => {
    expect(forwardPill(vault, channel, unknown)).toEqual({
      kind: 'named',
      server: 'Vault',
      channel: 'lobby',
      pending: true,
    })
    expect(forwardPill(nothing, channel, unknown)).toEqual({ kind: 'none' })
  })

  test('nowhere the viewer can read: the carried names with a lock, or hidden', () => {
    expect(forwardPill(vault, { kind: 'none' }, resolves)).toEqual({
      kind: 'named',
      server: 'Vault',
      channel: 'lobby',
      pending: false,
    })
    expect(forwardPill(nothing, { kind: 'none' }, resolves)).toEqual({ kind: 'hidden' })
  })

  test('while looking: the carried names without a lock, else nothing', () => {
    expect(forwardPill(vault, PENDING, resolves)).toEqual({
      kind: 'named',
      server: 'Vault',
      channel: 'lobby',
      pending: true,
    })
    expect(forwardPill(nothing, PENDING, resolves)).toEqual({ kind: 'none' })
  })
})

describe('instance copies', () => {
  const ref = (over: Partial<ForwardRef> = {}): ForwardRef => ({
    author: user('carol'),
    created_at: 3,
    source_id: 40,
    origin: null,
    dropped: null,
    ...over,
  })

  test('carriedOf reads the structured fields, and the label from servers without them', () => {
    expect(carriedOf(ref({ origin: 'Direct message', origin_dm: true }))).toEqual(dm)
    expect(
      carriedOf(
        ref({
          origin: 'Vault',
          origin_dm: false,
          origin_channel: null,
          origin_server: 'Vault',
          origin_server_channel: 'lobby',
        })
      )
    ).toEqual(vault)
    expect(
      carriedOf(
        ref({
          origin: '#general - Club',
          origin_channel: 'general',
          origin_server: 'Club',
        })
      )
    ).toEqual({ server: 'Club', channel: 'general', dm: false })
    expect(carriedOf(ref({ origin: null, origin_server: null }))).toEqual(nothing)
    expect(carriedOf(ref({ origin: '#general · Club' }))).toEqual({
      server: 'Club',
      channel: 'general',
      dm: false,
    })
    expect(carriedOf(ref({ origin: 'Pub Hall' }))).toEqual({
      server: 'Pub Hall',
      channel: null,
      dm: false,
    })
    expect(carriedOf(ref({ origin: 'Direct message' }))).toEqual(dm)
    expect(carriedOf(ref())).toEqual(nothing)
  })

  const general = { id: 1, name: 'general', kind: 'text' as const, slowmode_seconds: 0 }
  const reading = { id: 7, name: 'reading', kind: 'text' as const, slowmode_seconds: 0 }
  const s = {
    servers: {
      club: serverDetail('club', { display_name: 'Book Club', channels: [general, reading] }),
    },
  }
  const copy = (over: Partial<ForwardRef> = {}) => msg(41, { channel_id: 1, forward: ref(over) })

  test('a channel of its own server, carried by id and listed here, needs no lookup', () => {
    const m = copy({ origin_channel_id: 7, origin_channel: 'old name', origin_server: 'Club' })
    expect(needsLookup(s, m)).toBe(false)
    expect(hostedPlace(s, m, undefined)).toEqual(channel)
    expect(hostedPill(s, m, undefined)).toEqual({ kind: 'open', ...NAMES })
    const unlisted = copy({ origin_channel_id: 9, origin_channel: 'gone', origin_server: 'Club' })
    expect(needsLookup(s, unlisted)).toBe(true)
    expect(hostedPill(s, unlisted, undefined)).toEqual({
      kind: 'named',
      server: 'Club',
      channel: 'gone',
      pending: true,
    })
  })

  test('the lookup decides everything else', () => {
    const m = copy({ origin: 'Vault', origin_server: 'Vault', origin_server_channel: 'lobby' })
    expect(needsLookup(s, m)).toBe(true)
    expect(hostedPill(s, m, undefined)).toEqual(lockedVault(true))
    expect(hostedPill(s, m, { kind: 'none' })).toEqual(lockedVault(false))
    expect(hostedPill(s, m, { kind: 'channel', server: 'club', id: 7, shown: null })).toEqual({
      kind: 'open',
      ...NAMES,
    })
    expect(hostedPill(s, m, { kind: 'channel', server: 'elsewhere', id: 3, shown: null })).toEqual(
      lockedVault(true)
    )
    expect(hostedPill(s, copy(), { kind: 'none' })).toEqual({ kind: 'hidden' })
    const fromDm = copy({ origin: 'Direct message', origin_dm: true })
    expect(hostedPill(s, fromDm, undefined)).toEqual({ kind: 'dm', open: false })
    expect(hostedPill(s, fromDm, { kind: 'dm' })).toEqual({ kind: 'dm', open: true })
    expect(hostedPill(s, msg(42), { kind: 'dm' })).toEqual({ kind: 'none' })
  })
})

describe('P2P copies', () => {
  const file = (h: string, name: string, over: Partial<Attachment> = {}): Attachment => ({
    h,
    size: 10,
    blocks: 1,
    name,
    mime: 'image/png',
    ...over,
  })
  const PHOTO = file('photo', 'beds.png', { thumb: 'dGh1bWI', w: 4, h_px: 3 })
  const NOTES = file('notes', 'notes.txt', { mime: 'text/plain' })
  const MALLORY = file('mallory', 'beds.png')
  const EV = 'e'.repeat(43)
  const TS = 1_800_000_000_123
  const place = (over: Partial<FwdPlace> = {}): FwdPlace => ({
    ev: EV,
    dm: false,
    rn: null,
    cn: null,
    ts: TS,
    body: 'bed plans',
    atts: [],
    ...over,
  })
  const held = (over: Partial<HeldOriginal> = {}): HeldOriginal => ({
    room: 'R',
    ch: 'c1',
    sender: 'IK_ALICE',
    ts: [TS, TS + 40],
    texts: [textHash('bed plans'), textHash('bed plans, edited')],
    atts: [PHOTO, NOTES],
    ...over,
  })
  const servers = {
    R: { name: 'Garden', channels: [{ id: 'c1', name: 'beds' }] },
  }

  test('a copy that names neither its original nor its place has no pill', () => {
    expect(p2pCarried(place({ ev: null }))).toBeNull()
    expect(p2pPill(place({ ev: null }), undefined, servers)).toEqual({ kind: 'none' })
    expect(p2pCarried(place())).toEqual(nothing)
    expect(p2pCarried(place({ ev: null, dm: true }))).toEqual(dm)
    expect(p2pCarried(place({ rn: 'Garden', cn: 'beds' }))).toEqual({
      server: 'Garden',
      channel: 'beds',
      dm: false,
    })
    expect(p2pCarried(place({ cn: 'beds' }))).toEqual(nothing)
  })

  test('the identity’s own store finds the original', () => {
    expect(p2pPlace(place(), undefined)).toEqual(PENDING)
    expect(p2pPlace(place(), null)).toEqual({ kind: 'none' })
    expect(p2pPlace(place({ ev: null }), held())).toEqual({ kind: 'none' })
    expect(p2pPlace(place(), held({ room: 'D', ch: null }))).toEqual({ kind: 'dm', mine: true })
    expect(p2pPlace(place(), held())).toEqual({ kind: 'room', room: 'R', ch: 'c1', ev: EV })
  })

  test('an original vouches only for a copy with its second, text and files', () => {
    expect(vouches(place(), held())).toBe(true)
    expect(vouches(place({ body: 'bed plans, edited' }), held())).toBe(true)
    expect(vouches(place({ ts: Math.floor(TS / 1000) * 1000 }), held())).toBe(true)
    expect(vouches(place({ ts: TS + 1000 }), held())).toBe(false)
    expect(vouches(place({ body: 'bed plans (altered)' }), held())).toBe(false)
    expect(vouches(place({ atts: [{ ...PHOTO }] }), held())).toBe(true)
    expect(vouches(place({ atts: [NOTES, PHOTO] }), held())).toBe(true)
    expect(vouches(place({ atts: [PHOTO, MALLORY] }), held())).toBe(false)
    expect(vouches(place({ atts: [MALLORY] }), held({ atts: [] }))).toBe(false)
    expect(vouches(place({ atts: null }), held())).toBe(false)
  })

  test('a copy that keeps a file but says other things of it does not vouch', () => {
    for (const changed of [
      { name: 'invoice.pdf' },
      { mime: 'application/pdf' },
      { spoiler: true as const },
      { thumb: 'bWFsbG9yeQ' },
      { w: 10 },
    ])
      expect([changed, vouches(place({ atts: [{ ...PHOTO, ...changed }] }), held())]).toEqual([
        changed,
        false,
      ])
    expect(vouches(place({ atts: [{ ...NOTES, thumb: undefined }] }), held())).toBe(true)
  })

  test('a vouched copy shows its files as the original holds them', () => {
    const original = held()
    const files = vouchedFiles(place({ atts: [{ ...NOTES }, { ...PHOTO }] }), original)
    expect(files).toEqual([NOTES, PHOTO])
    expect(files?.[0]).toBe(original.atts[1])
    expect(files?.[1]).toBe(original.atts[0])
    expect(vouchedFiles(place({ atts: [{ ...PHOTO, name: 'x.png' }] }), original)).toBeNull()
    expect(vouchedFiles(place({ body: 'other' }), original)).toBeNull()
    expect(vouchedFiles(place(), original)).toEqual([])
  })

  test('the name a copy claims neither makes nor breaks the link', () => {
    // A renamed author, or a look-alike name: the copy carries no name here at all; the card
    // shows the viewer's own name for the original's sender once it vouches.
    expect(p2pPlace(place(), held({ sender: 'IK_OTHER' }))).toEqual({
      kind: 'room',
      room: 'R',
      ch: 'c1',
      ev: EV,
    })
  })

  test('a forged event id opens nothing', () => {
    const forged = place({ rn: 'Garden', cn: 'beds', body: 'give Mallory the keys' })
    expect(p2pPlace(forged, held())).toEqual({ kind: 'none' })
    expect(p2pPill(forged, held(), servers)).toEqual({
      kind: 'named',
      server: 'Garden',
      channel: 'beds',
      pending: false,
    })
    expect(p2pPill(place({ atts: [MALLORY] }), held(), servers)).toEqual({ kind: 'hidden' })
    expect(p2pPill(place({ dm: true, ts: 0 }), held({ ch: null }), servers)).toEqual({
      kind: 'dm',
      open: false,
    })
  })

  test('names come from the identity’s servers', () => {
    const names = p2pNames(servers)
    expect(names({ kind: 'room', room: 'R', ch: 'c1', ev: EV })).toEqual({
      server: { key: 'R', name: 'Garden', p2p: true },
      channel: { id: 'c1', name: 'beds' },
    })
    expect(names({ kind: 'room', room: 'R', ch: 'gone', ev: EV })).toBeNull()
    expect(names({ kind: 'room', room: 'X', ch: 'c1', ev: EV })).toBeNull()
    expect(names(channel)).toBeNull()
  })

  test('p2pPill: open, a direct message, named with a lock, hidden', () => {
    const shown = place({ rn: 'Old garden', cn: 'old beds' })
    expect(p2pPill(shown, held(), servers)).toEqual({
      kind: 'open',
      server: { key: 'R', name: 'Garden', p2p: true },
      channel: { id: 'c1', name: 'beds' },
    })
    expect(p2pPill(shown, null, servers)).toEqual({
      kind: 'named',
      server: 'Old garden',
      channel: 'old beds',
      pending: false,
    })
    expect(p2pPill(place({ dm: true }), held({ room: 'D', ch: null }), servers)).toEqual({
      kind: 'dm',
      open: true,
    })
    expect(p2pPill(place({ dm: true }), null, servers)).toEqual({ kind: 'dm', open: false })
    expect(p2pPill(place(), null, servers)).toEqual({ kind: 'hidden' })
    expect(p2pPill(place(), undefined, servers)).toEqual({ kind: 'none' })
  })
})
