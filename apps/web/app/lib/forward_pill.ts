import { sha256 } from '@noble/hashes/sha2.js'
import type { Located } from './forward_locate'
import { b64u, utf8 } from './p2p/canonical'
import type { Attachment, FwdPlace } from './p2p/content'
import type { RChatState } from './store_types'
import type { ForwardRef, Message } from './types'

// "Forwarded from ..." under a forwarded copy: where its original is, as far as the viewer's
// own access goes.

// What the viewer's own access found.
export type PillPlace =
  | { kind: 'pending' }
  | { kind: 'channel'; server: string; channelId: number }
  | { kind: 'room'; room: string; ch: string | null; ev: string }
  | { kind: 'dm'; mine: boolean }
  | { kind: 'none' }

// What the copy names.
export interface Carried {
  server: string | null
  channel: string | null
  dm: boolean
}

export interface PlaceNames {
  server: { key: string; name: string; p2p: boolean }
  channel: { id: string | number; name: string } | null
}

// The viewer's own names of a place, from their own store; null when it doesn't list them.
export type NamesOf = (place: Extract<PillPlace, { kind: 'channel' | 'room' }>) => PlaceNames | null

export type ForwardPill =
  | { kind: 'none' }
  | ({ kind: 'open' } & PlaceNames)
  | { kind: 'dm'; open: boolean }
  | { kind: 'named'; server: string; channel: string | null; pending: boolean }
  | { kind: 'hidden' }

const named = (carried: Carried, pending: boolean): ForwardPill =>
  carried.server
    ? { kind: 'named', server: carried.server, channel: carried.channel, pending }
    : pending
      ? { kind: 'none' }
      : { kind: 'hidden' }

// A copy's names show only until the viewer's own lookup answers; a restricted channel's name
// therefore shows only to people who see that channel.
export const forwardPill = (carried: Carried, place: PillPlace, names: NamesOf): ForwardPill => {
  if (carried.dm || place.kind === 'dm')
    return { kind: 'dm', open: place.kind === 'dm' && place.mine }
  if (place.kind === 'channel' || place.kind === 'room') {
    const found = names(place)
    return found ? { kind: 'open', ...found } : named(carried, true)
  }
  return named(carried, place.kind === 'pending')
}

export const PENDING: PillPlace = { kind: 'pending' }

// Servers that only send `origin` name a channel as "#channel - Server".
const LEGACY = /^#(.+?) (?:-|·) (.+)$/

export const carriedOf = (
  fwd: Pick<
    ForwardRef,
    'origin' | 'origin_dm' | 'origin_channel' | 'origin_server' | 'origin_server_channel'
  >
): Carried => {
  if (fwd.origin_dm || fwd.origin === 'Direct message')
    return { server: null, channel: null, dm: true }
  if (fwd.origin_server === undefined && fwd.origin) {
    const legacy = LEGACY.exec(fwd.origin)
    return legacy
      ? { server: legacy[2], channel: legacy[1], dm: false }
      : { server: fwd.origin, channel: null, dm: false }
  }
  const server = fwd.origin_server ?? null
  return {
    server,
    channel: server ? (fwd.origin_channel ?? fwd.origin_server_channel ?? null) : null,
    dm: false,
  }
}

type Servers = Pick<RChatState, 'servers'>

export const hostedNames =
  (s: Servers): NamesOf =>
  place => {
    if (place.kind !== 'channel') return null
    const d = s.servers[place.server]
    const c = d?.channels.find(x => x.id === place.channelId)
    return d && c
      ? {
          server: { key: place.server, name: d.display_name, p2p: false },
          channel: { id: c.id, name: c.name },
        }
      : null
  }

const destinationOf = (s: Servers, m: Pick<Message, 'channel_id'>) =>
  m.channel_id == null
    ? undefined
    : Object.values(s.servers).find(d => d.channels.some(c => c.id === m.channel_id))?.name

// A channel the copy carries by id is one of its own server's that everyone there sees: the
// viewer's store names it without a lookup.
const carriedChannel = (s: Servers, m: Pick<Message, 'forward' | 'channel_id'>) => {
  const id = m.forward?.origin_channel_id
  const server = id == null ? undefined : destinationOf(s, m)
  if (id == null || !server) return null
  const place: PillPlace = { kind: 'channel', server, channelId: id }
  return hostedNames(s)(place) ? place : null
}

export const needsLookup = (s: Servers, m: Pick<Message, 'forward' | 'channel_id'>) =>
  !!m.forward && m.forward.source_id > 0 && !carriedChannel(s, m)

export const hostedPlace = (
  s: Servers,
  m: Pick<Message, 'forward' | 'channel_id'>,
  located: Located | undefined
): PillPlace => {
  const known = carriedChannel(s, m)
  if (known) return known
  switch (located?.kind) {
    case undefined:
      return PENDING
    case 'channel':
      return { kind: 'channel', server: located.server, channelId: located.id }
    case 'dm':
      return { kind: 'dm', mine: true }
    case 'none':
      return { kind: 'none' }
  }
}

export const hostedPill = (
  s: Servers,
  m: Pick<Message, 'forward' | 'channel_id'>,
  located: Located | undefined
): ForwardPill =>
  m.forward
    ? forwardPill(carriedOf(m.forward), hostedPlace(s, m, located), hostedNames(s))
    : { kind: 'none' }

// A P2P copy from an app that names neither the original nor where it's from has no pill.
export const p2pCarried = (f: FwdPlace): Carried | null =>
  f.ev || f.dm || f.rn ? { server: f.rn, channel: f.rn ? f.cn : null, dm: f.dm } : null

// What the viewer's identity holds of a P2P copy's original: where it is, who wrote it, when it
// was sent and shown (ms), the hashes of its text and of every edit of it (`textHash`), and its
// files. For an original that is itself a copy whose own original vouches for it: what that copy
// says, the first original's author and its files.
export interface HeldOriginal {
  room: string
  ch: string | null
  sender: string
  ts: number[]
  texts: string[]
  atts: Attachment[]
}

export const textHash = (text: string) => b64u(sha256(utf8(text)))

// A file as it shows: its bytes (by root hash and size) and everything said about them.
const fileKey = (a: Attachment) =>
  JSON.stringify([
    a.h,
    a.size,
    a.blocks,
    a.name,
    a.mime,
    a.spoiler === true,
    a.w ?? null,
    a.h_px ?? null,
    a.dur ?? null,
    a.thumb ?? null,
  ])

const sameFile = (o: HeldOriginal, a: Attachment) => o.atts.find(b => fileKey(b) === fileKey(a))

// A copy names its original truly: the same second and text, and only files the original has,
// described as it describes them. Its sender wrote the copy, so a link to an event alone vouches
// for nothing. The name a copy carries is a claim: once it vouches, the viewer's own name for the
// original's author shows.
export const vouches = (f: Pick<FwdPlace, 'ts' | 'body' | 'atts'>, o: HeldOriginal) =>
  o.ts.some(t => Math.floor(t / 1000) === Math.floor(f.ts / 1000)) &&
  o.texts.includes(textHash(f.body)) &&
  !!f.atts?.every(a => sameFile(o, a))

// The files of a copy its original vouches for, as the original holds them; null otherwise.
export const vouchedFiles = (f: Pick<FwdPlace, 'ts' | 'body' | 'atts'>, o: HeldOriginal) =>
  f.atts && vouches(f, o) ? f.atts.map(a => sameFile(o, a)!) : null

// `found`: what the viewer's identity holds of the original, null when it doesn't, undefined while
// it looks.
export const p2pPlace = (f: FwdPlace, found: HeldOriginal | null | undefined): PillPlace => {
  if (!f.ev || found === null) return { kind: 'none' }
  if (found === undefined) return PENDING
  if (!vouches(f, found)) return { kind: 'none' }
  return found.ch === null
    ? { kind: 'dm', mine: true }
    : { kind: 'room', room: found.room, ch: found.ch, ev: f.ev }
}

interface P2pServerNames {
  name: string
  channels: readonly { id: string; name: string }[]
}

export const p2pNames =
  (servers: Record<string, P2pServerNames>): NamesOf =>
  place => {
    if (place.kind !== 'room') return null
    const v = servers[place.room]
    const c = place.ch === null ? null : v?.channels.find(x => x.id === place.ch)
    return v && c !== undefined
      ? {
          server: { key: place.room, name: v.name, p2p: true },
          channel: c && { id: c.id, name: c.name },
        }
      : null
  }

export const p2pPill = (
  f: FwdPlace,
  found: HeldOriginal | null | undefined,
  servers: Record<string, P2pServerNames>
): ForwardPill => {
  const carried = p2pCarried(f)
  return carried ? forwardPill(carried, p2pPlace(f, found), p2pNames(servers)) : { kind: 'none' }
}
