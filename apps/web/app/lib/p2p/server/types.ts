import { sha256 } from '@noble/hashes/sha2.js'
import { isRecord } from '../../bytes'
import type { Rank } from '../acl/rules'
import type { OverSum } from '../acl/summary'
import type { Disowned, Reapply } from '../acl_room'
import { b64u, bytesOf, canonical, fromB64u, randomBytes, utf8 } from '../canonical'
import { storedSize } from '../dag'
import { serverWire, type ChanCounts, type Carry, type EventRecord, type P2pStore } from '../db'
import type { Wire } from '../event_v1'
import type { WireV2 } from '../event_v2'
import { CO_OWNERS_MAX } from '../flows'
import type { GossipLimits } from '../gossip'
import { LOCAL } from '../limits'
import type { P2pNode } from '../node'
import type { AclHost } from '../resolve_host'
import type { Clock } from '../session'
import {
  P,
  type ChannelContent,
  type HistoryVis,
  type Membership,
  type SystemContent,
} from '../state'
import type { SyncLimits } from '../sync'
import type { VoiceLimits, VoiceUser } from '../voice'
import type { Dms, P2pMessage } from '../dm'
import { clip } from '../rate'

// P2P servers (spec p2p-acl-spec §1 to §4): groups whose membership, permissions, channels and
// messages live only on their members' devices. Every event is a signed v2 event of one of two
// layers: ACL events (membership, roles, channels, settings) form a DAG every member holds
// whole; content events (messages) hang off an ACL position. The evaluator (acl_room.ts, in a
// worker in the browser) decides every event (spec §2.1: admitted, rejected, pending, held) and
// works out the current state and what each message shows; this module stores, syncs and serves
// events, builds our own, and keeps the page's mirror of the state. Rooms sync over the same
// sessions as DMs, with their own message types (prefix `s`), on at most 8 links per room
// (gossip.ts).

export const SERVER = {
  codePeers: 4,
  // Co-owners a new server may list (its genesis must fit in one ACL event).
  coOwners: CO_OWNERS_MAX,
  ...LOCAL.server,
}

// Vouching marks (Rt.vouch): at most one per room this often, and one per inviter.
export const VOUCH = { roomMs: LOCAL.server.vouchRoomMs, inviterMs: LOCAL.server.vouchInviterMs }

export const CODE_PREFIX = 'rci1.'

// How long a joiner waits for missing ACL events before joining with what it has, and how soon
// the evaluation cache is written after a change.
export const JOIN_WAIT = LOCAL.server.joinWaitMs

export const SAVE_MS = LOCAL.server.saveMs

export const CODE_TTLS = ['1 hour', '1 day', '7 days', '30 days'].map((label, i) => ({
  label,
  ms: LOCAL.server.codeTtls[i],
}))

export const NEEDS_INVITER = 'Someone who can invite must be online'

export const NOBODY_ONLINE =
  'Nobody who can invite is online right now. Try again when one of them is.'

export const BAD_CODE = "This isn't a P2P server invite code."

export const REDEEM_TEXT: Record<string, string> = {
  expired: 'This invite has expired.',
  revoked: 'This invite was revoked.',
  unknown: "This invite isn't valid any more.",
  banned: "You can't join this server.",
  busy: 'Too many people are joining with this invite right now. Try again in a few minutes.',
}

export const LEGACY_TEXT = 'Created with an earlier test version. Recreate it.'

export const UPDATE_TEXT = 'Update the app to take part'

export const SYNC_TEXT = 'Waiting to sync. Try again in a moment.'

export const OLD_GONE_TEXT = 'The old copy was removed from this device'

// `who`: a name the message is about, shown apart (streamer mode hides it).
export class ServerError extends Error {
  constructor(
    message: string,
    readonly who?: string
  ) {
    super(message)
  }
}

export interface InviteCode {
  v: 1
  room: string
  name: string
  // The code's event id (spec 8.2: links carry the code's id and its secret).
  code?: string
  secret: string
  peers: string[]
}

export const isPeerId = (x: unknown) =>
  typeof x === 'string' && /^rcp-[a-z2-7]{26}(-[1-9])?$/.test(x)

export const encodeCode = (c: InviteCode) => CODE_PREFIX + b64u(utf8(canonical(c)))

export const parseCode = (text: string): InviteCode | null => {
  const t = text.trim()
  if (!t.startsWith(CODE_PREFIX)) return null
  try {
    const x = JSON.parse(new TextDecoder().decode(fromB64u(t.slice(CODE_PREFIX.length))))
    if (
      !isRecord(x) ||
      x.v !== 1 ||
      bytesOf(x.room, 32) === null ||
      typeof x.name !== 'string' ||
      Array.from(x.name).length > 100 ||
      bytesOf(x.secret, 16) === null ||
      !Array.isArray(x.peers) ||
      x.peers.length > SERVER.codePeers ||
      !x.peers.every(isPeerId) ||
      (x.code !== undefined && bytesOf(x.code, 32) === null)
    )
      return null
    return {
      v: 1,
      room: x.room as string,
      name: x.name,
      ...(x.code !== undefined ? { code: x.code as string } : {}),
      secret: x.secret as string,
      peers: x.peers as string[],
    }
  } catch {
    return null
  }
}

export const codeHash = (secret: string) => b64u(sha256(fromB64u(secret)))

export const newShortId = () => b64u(randomBytes(8))

// What @everyone may do in a new server.
export const EVERYONE_BITS = P.Invite | P.ViewChannel | P.SendMessages

export interface ServerArrival {
  room: string
  ch: string
  rec: EventRecord
  ping: 'mention' | 'reply' | 'reaction' | 'everyone' | null
  unread: boolean
  // A thread reply (or a reaction to one): the thread's root.
  thread: string | null
}

export const THREAD_ROOT_TEXT = 'Threads only start on channel messages'

export const PIN_TEXT = "You can't pin messages here"

export const PIN_THREAD_TEXT = "Messages in threads can't be pinned"

// What to search P2P servers for (search panel): words, authors, a channel, files, and times
// (unix seconds, exclusive).
export interface SearchQuery {
  q: string
  from: readonly string[] | null
  room: string | null
  ch: string | null
  hasFile: boolean
  beforeTs: number | null
  afterTs: number | null
}

export interface SearchHit {
  room: string
  ch: string
  thread: string | null
  m: P2pMessage
}

export interface MemberView {
  ik: string
  m: Membership
  name: string
  owner: boolean
  online: boolean
  contact: boolean
  // We outrank them (kick and ban need it, spec 1.6).
  below: boolean
  // Invited, and their join waits for a third member (spec 9 rule 14); invited only by us.
  waits: boolean
  myInvite: boolean
  // Banned, and our rank is at least that of every ban of them (spec 8.2 unban).
  unban: boolean
  // Their roles, the highest first, and the highest (the member list groups by it).
  roles: string[]
  top: string | null
}

// A role (spec 1.4, 1.6), and whether we outrank it: we may change, give and take it.
export interface RoleView {
  id: string
  name: string
  color: number | null
  pos: number
  bits: number
  holders: number
  below: boolean
  // A channel's overwrites hold its holders back: taking it away needs Manage channels (spec 1.4).
  held: boolean
}

// A channel we may view, what we may do there (spec 1.4, Discord order), whether slow mode leaves
// us out (spec 3.5), and its overwrites by subject.
export type ChannelView = { id: string } & ChannelContent & {
    send: boolean
    exempt: boolean
    over: Record<string, OverSum>
  }

// A moderation action waiting for a fresh heads exchange (spec 8.2).
export interface ModView {
  id: number
  // What it does ("Kick"), and to whom.
  act: string
  who: string | null
}

// Members a removal of ours took along (spec 8.2), by the member we removed.
export interface ReachedView {
  by: string
  lost: string[]
}

export interface ServerView {
  id: string
  name: string
  color: number | null
  me: Membership | null
  joining: boolean
  owner: string | null
  owners: string[]
  perms: number
  rank: Rank
  history: HistoryVis
  system: SystemContent
  channels: ChannelView[]
  roles: RoleView[]
  everyone: number
  members: MemberView[]
  online: number
  joined: number
  chans: Record<string, import('../db').ChanCounts>
  // Arrival number of the newest stored event: it moves only when stored content changes.
  seq: number
  gap: boolean
  full: boolean
  // Shown read-only, with this text (a server of old or unknown rules).
  readOnly: string | null
  // Who is in each voice channel.
  voice: Record<string, VoiceUser[]>
  mods: ModView[]
  reached: ReachedView[]
  // Our denies the current state doesn't count that we may still make (spec 9 rule 18, I2).
  reapply: Reapply[]
  // Why our join waits (spec 9 rule 14), whether this device conflicts with another copy of it
  // (spec 3.9), and, while the ACL syncs, how many changes we hold (spec 9 rule 19).
  joinWait: string | null
  conflict: boolean
  syncing: number | null
  // Spec 3.8: transferred to a new copy (read-only now), more than one upgrade (the user picks),
  // the copy we followed, and the copy a new one follows.
  upgraded: boolean
  disputed: boolean
  next: string | null
  prev: string | null
  // The new owner's carry-over while it isn't done (spec 3.8), and how the member list the new
  // owner carried over differs from the old copy's.
  carry: { state: Carry['state']; why: string | null } | null
  migrateDiff: { added: string[]; removed: string[] } | null
}

export interface Parked {
  wire: WireV2
  missing: Set<string>
  size: number
}

export interface Mod {
  id: number
  act: string
  who: string | null
  at: number
  force: boolean
  run: () => Promise<unknown>
  done: (v: unknown) => void
  fail: (e: unknown) => void
}

// Someone who redeemed a code with us: they may sync the ACL until `until` to join; the invite
// we posted for them is withdrawn after that unless they joined.
export interface Redeemer {
  code: string
  until: number
  add: string
  // When its invite took one of the code's hourly slots (none: it was invited already).
  at?: number
}

export interface ServerDeps {
  node: P2pNode
  store: P2pStore
  dms: Dms
  clock?: Clock
  random?: () => number
  limits?: Partial<SyncLimits>
  gossip?: Partial<GossipLimits>
  voice?: Partial<VoiceLimits>
  roomCap?: number
  totalCap?: number
  roomBytes?: number
  totalBytes?: number
  serverCap?: number
  serverBytes?: number
  // Images in servers up to this size are fetched as soon as they arrive (0: never).
  autoMax?: () => number
  attachments?: () => boolean
  // Where the evaluator runs (a worker in the browser).
  resolver?: AclHost
}

export const MENTION_EVERYONE = /(^|[^\p{L}\p{N}\p{M}_])@everyone(?![\p{L}\p{N}\p{M}_])/iu

export interface EmitOpts {
  L?: 'a' | 'c'
  to?: string
  // A position to sign at instead of the heads (spec 3.9).
  ap?: string[]
}

export interface LockLike {
  request: (name: string, cb: () => Promise<unknown>) => Promise<unknown>
}

export const webLocks = (): LockLike | null =>
  typeof navigator !== 'undefined' && navigator.locks
    ? (navigator.locks as unknown as LockLike)
    : null

export const sizeOfWire = (w: WireV2) => storedSize(w as unknown as Wire)

// A line made from an event (join, leave, pin), about `ik`.
export const systemRow = (rec: EventRecord, ik: string): P2pMessage => ({
  id: rec.id,
  sender: ik,
  ts: rec.effTs,
  sentTs: serverWire(rec).ev.ts,
  sortKey: rec.sortKey,
  seq: rec.seq,
  body: '',
  reply: null,
  mentions: [],
  fwd: null,
  att: [],
  edited: null,
  reactions: [],
  pinned: null,
  late: false,
  pending: false,
  failed: false,
  call: null,
})

// Entries per `migrate` chunk (spec 3.8: chunks within the 16 KiB of a migrate event), and the
// ACL events of a new owner's carry-over a member acknowledges with a mark.
export const MIGRATE_PER = LOCAL.server.migratePer

// A new copy links with the old copy's members this long after we joined it (spec 3.8).
export const SETTLE_MS = LOCAL.server.settleMs

export const ARCHIVE_LINKS = {
  perRoom: LOCAL.gossip.archivePerRoom,
  outTarget: LOCAL.gossip.archiveOutTarget,
}

export const SETTLE_RESAMPLE = LOCAL.server.settleResample

export const CARRY_ACK = LOCAL.server.carryAck

// Acknowledgements of a carry-over whose size isn't known here (its old copy isn't).
export const CARRY_ACKS_MAX = LOCAL.server.carryAcksMax

export interface Migrated {
  members: string[]
  bans: string[]
  marks: Record<string, number>
  done: boolean
}

export const RESIGN_ACL = [
  'add',
  'uninvite',
  'kick',
  'ban',
  'unban',
  'role_create',
  'role_move',
  'role_bits',
  'role_del',
  'assign',
  'revoke',
  'channel',
  'chperm',
  'settings',
  'role_meta',
  'code',
  'code_revoke',
]

// A server in the lost-device preview (spec 8.2): what the device did, when we received each of
// its ACL events, and whether this browser's key there came after the trusted point (what it
// signed that stops counting is signed again from the new key).
export interface LostRoom extends Disowned {
  room: string
  at: Record<string, number>
  // This browser's own ACL changes the new key signs again (its key came after the trusted point).
  resign: { id: string; t: string; to?: string }[]
  // Our other devices added since the trusted point: the rotation signs them out too.
  others: string[]
}

// A row that shows in place of a message without its content.
export const placeholder = (r: EventRecord) => systemRow(r, r.sender)

// A channel's counters with `n` pings taken off (of `thread`'s, when given).
export const lessPings = (old: ChanCounts, n: number, thread: string | null): ChanCounts => {
  const next: ChanCounts = { ...old, pings: Math.max(0, old.pings - n) }
  if (thread && old.threads?.[thread]) {
    const threads = { ...old.threads }
    const left = threads[thread] - n
    if (left > 0) threads[thread] = left
    else delete threads[thread]
    if (Object.keys(threads).length) next.threads = threads
    else delete next.threads
  }
  return next
}

export type ChannelPatch = {
  name?: string
  topic?: string
  gone?: true
  restrict_view?: boolean
  restrict_send?: boolean
  slow?: number
}

export const ROLE_NAME_MAX = LOCAL.server.roleNameMax

// Positions are absolute (spec 1.6): a new role goes below the lowest, leaving room between, else
// into a gap below `cap` (our own top role's position), else (owners) above every role; never onto a
// position a role has. Null: no room below `cap`.
export const ROLE_STEP = LOCAL.server.roleStep

export const NO_ROOM_TEXT = 'No room for a new role below your highest role. Move a role first.'

export const newRolePos = (positions: number[], cap = Infinity): number | null => {
  const s = [...new Set(positions)].sort((a, b) => a - b)
  if (!s.length) return Number.isFinite(cap) ? null : ROLE_STEP * ROLE_STEP
  if (s[0] > 0) {
    const p = s[0] > ROLE_STEP ? s[0] - ROLE_STEP : Math.floor(s[0] / 2)
    return p < cap ? p : null
  }
  for (let i = 0; i < s.length; i++) {
    const hi = Math.min(s[i + 1] ?? Infinity, cap)
    if (hi === Infinity) return s[i] + ROLE_STEP
    if (hi - s[i] >= 2) return Math.floor((s[i] + hi) / 2)
    if (hi === cap) break
  }
  return null
}

export const roleName = (x: unknown) =>
  typeof x === 'string' && x.trim() ? clip(x.trim(), ROLE_NAME_MAX) : 'Role'

export const sortRoles = (ids: string[], at: Map<string, number>) =>
  ids.filter(id => at.has(id)).sort((a, b) => at.get(a)! - at.get(b)!)
