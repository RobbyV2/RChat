import type { Summary } from '../acl/summary'
import type { Carried, Reapply } from '../acl_room'
import type { WireV2 } from '../event'
import type { Reached } from '../flows'
import type { Migrated, Parked, Mod } from './types'

// Loading and receipt (load.ts, receive.ts). Also written by: the facade (`lock`), and the
// modules that post or redeem a join (codes.ts, storage.ts, transfer.ts: `joinPosted`).
export interface SyncRt {
  sum: Summary
  lock: Promise<unknown>
  loading: Promise<void> | null
  joinPosted: boolean
  // Events waiting for ACL parents, by id, and who waits on which parent.
  pending: Map<string, Parked>
  pendingBytes: number
  waits: Map<string, Set<string>>
  // Admitted events dated in the future, until local time reaches them.
  held: Map<string, { wire: WireV2; due: number }>
  rejected: Set<string>
  // Invites (add ids, by inviter) another member posted: a tick posts a mark, so the invitee's
  // join has the acknowledgement of a third member it needs (spec 4.1 W3(e)), while the invite is
  // pending and its inviter a member; at most one per inviter per VOUCH.inviterMs and one per room
  // per VOUCH.roomMs.
  vouch: Map<string, string>
  vouchedAt: number
  // Our own ACL events we must hold before we sign again.
  need: Set<string>
}

// Storage passes, bodies wanted back, proofs and acknowledgements (storage.ts, the only writer;
// the others mark work due through it).
export interface StoreRt {
  // Storage passes (SERVER.storeMs): due when the state or the held content changed.
  storeDirty: boolean
  storeAt: number
  // Content held without its body (purged, evicted, stripped by its author), and those of them
  // that show and are wanted back from peers.
  bodiless: Set<string>
  want: Set<string>
  wantAt: number
  // Bodies evicted for space that someone viewed: wanted back (spec 4.2 step 3).
  viewed: Set<string>
  // Per sender, where the next eviction walk starts (dag.ts oldestBodies `from`).
  evictFrom: Map<string, string>
  // Proofs to post, by device: the fork point and when; the lowest one posted per device, and
  // when we posted the last ones.
  proofs: Map<string, { f: number; due: number }>
  proofed: Map<string, number>
  proofTimes: number[]
  // A mark acknowledging a moderator's redaction: when due, and the last one.
  ackDue: number | null
  ackAt: number
  joinWait: string | null
}

// Moderation waiting for sync, removals that reach invitees, and our denies to apply again
// (moderation.ts). Also written by: devices.ts (`reapply`, `conflict`) and load.ts (`reapply`).
export interface ModRt {
  // Moderation waiting for sync, and the heads each peer last sent and when.
  mods: Mod[]
  modsBusy: boolean
  reports: Map<string, { at: number; state: string[] }>
  reached: Reached[]
  reapply: Reapply[]
  conflict: boolean
}

// Following an upgrade and carrying a copy over (transfer.ts). Also written by: devices.ts
// (`upgrade`) and load.ts (`migrated`).
export interface XferRt {
  // The members a new copy's carry-over names (spec 3.8), once all of it is here; the carry-over
  // as read (undefined: read it again), and whether it is done and compared.
  carriedMembers?: Set<string>
  migrated?: Migrated | null
  migrateChecked?: boolean
  // Following an upgrade, and the new owner carrying the old copy over (spec 3.8), in flight; the
  // new copy's `migrate` content and how its member list differs from the old copy's.
  following: boolean
  carrying: boolean
  migrateDiff: { added: string[]; removed: string[] } | null
  // Acknowledging a new owner's carry-over: when, and the ACL count then.
  carryAckAt: number
  carryAckCount: number | null
  // The old copy as an upgrade carries it (spec 3.8 step 4), and whether the carry-over into this
  // copy said it is done.
  carried?: { up: string; s: Carried; set?: Set<string> }
  carryDone: boolean
  carryAckLater?: unknown
  // Acknowledgements posted (kept in the room record too), how many the carry-over can need
  // (from the old copy), and the owners' ACL count and when it last grew here (or we started).
  carryAcks: number
  carryMax?: number
  carrySeen: number | null
  carryAt: number
  checkLater?: unknown
  // The upgrade of the old copy this one follows (spec 3.8), and how often the carry-over found
  // the old copy not loaded yet.
  upgrade?: string
  carryTries?: number
  // `carryRoles` running, and asked for again meanwhile.
  givingRoles?: boolean
  giveAgain?: boolean
}

// The member lists the views read (the facade's "Rooms and members", the only writer) and who
// may be sent our content of which channel (pushes).
export interface ViewRt {
  others: { sum: Summary; list: string[] } | null
  candidates?: { sum: Summary; old: Summary; list: string[] }
  // Who may be sent our content of which channel (`ik\nch`), in the current state (pushes).
  views: Map<string, boolean>
}

// The runtime record of a server room on this device (never stored), by the module that owns
// each part: what it writes, the others read. A field written by more than one module sits with
// the one that keeps its invariant (p2p_layering.test.ts checks the writers).
export interface Rt extends SyncRt, StoreRt, ModRt, XferRt, ViewRt {}
