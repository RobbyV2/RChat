import { EVERYONE } from './acl/rules'
import type { Summary } from './acl/summary'
import { LOCAL } from './limits'

// The user-facing flows of P2P servers (spec p2p-acl-spec §8.2, §9): their copy, and the pure
// decisions behind them. server.ts runs the flows; the components show this copy.

export const OWNER_TEXT = 'The owner is set when the server is created and never changes.'
export const CO_OWNERS_MAX = 8
export const CO_OWNERS_MAX_TEXT = `A server can have up to ${CO_OWNERS_MAX} co-owners.`
export const CO_OWNERS_TEXT =
  'Co-owners (optional). Co-owners can do everything the owner can. You can only add them now.'
export const transferText = (name: string) =>
  `Transferring ownership creates a new copy of this server owned by ${name}. Members, roles, channels and bans move over automatically, and everyone switches to the new copy. Messages from before the transfer stay readable above the new ones; the old copy becomes read-only.`
export const TRANSFER_CO_OWNERS_TEXT =
  'Every co-owner must approve the transfer, including co-owners who have left.'
// A co-owner didn't approve (the name follows): offline (one who left is reached only as a
// contact), or declined.
export const CO_OWNER_OFFLINE_TEXT = 'A co-owner must be online to approve the transfer:'
export const CO_OWNER_DECLINED_TEXT = "A co-owner didn't approve the transfer:"
export const EQUAL_ROLES_TEXT =
  'If two people with the same top role remove each other at about the same time, both removals stand. Someone with a higher role, or the owner, can add either of them back.'
export const HIGHER_ROLES_TEXT =
  "A moderator can't remove someone who, at the same moment, was given a role above theirs."
export const OFFLINE_TEXT =
  "Things you do after being removed or demoted don't count, even if your device hadn't heard about it yet."
export const hiddenRemovedText = (name: string) =>
  `Hidden: sent around the time ${name} was removed.`
export const ROLE_DOWN_TEXT =
  "Members with this role lose its rank at once, including for anything they're doing right now."
export const SYNC_WAIT_TEXT = 'Waiting to sync before applying…'
// The instance's slow mode wording (lib/slowmode.ts slowWait reads it).
export const slowText = (ms: number) => `Slow mode: wait ${Math.ceil(ms / 1000)}s`
export const APPLY_ANYWAY = 'Apply anyway'
export const reachedText = (name: string, n: number) =>
  `Removing ${name} also removed ${n === 1 ? '1 person' : `${n} people`} who joined through ${name}'s invites at the same time.`
export const INVITE_AGAIN = 'Invite them again'
export const UNBAN_TEXT =
  'Only someone with a role at least as high as the person who banned them can unban.'
export const WIPE_TEXT = 'Also hide all their messages'
export const DEVICES_TEXT =
  "You can use several devices at once. A browser restored from a backup becomes a new device; anything the restored copy signed before that doesn't count."
export const CONFLICT_TEXT =
  "This device's history conflicts with another copy of it. Set it up as a new device."
export const QUICK_TEXT = "You're changing this server too quickly. Try again in a few minutes."
export const LONE_TEXT = "You've made many changes while nobody else was around. Try again later."
export const CODE_RETRY_TEXT =
  "If you don't finish joining within about 10 minutes, use the code again."
export const CODE_REVOKE_TEXT =
  'A revoked code stops working everywhere as members sync. People it already let in stay unless a moderator removes them.'
export const CODE_PAUSED_TEXT =
  'Paused on this device: several people used it without joining. Revoke it if it leaked.'
export const CODE_DEATH_TEXT =
  'Codes stop working for good if the person who made them loses the right to invite.'
export const WITHDRAW_TEXT =
  'This cancels the invite. If they already received it, they can still use it to join, now or later; ask a moderator to remove them.'
export const lostText = (time: string) =>
  `Remove this device and undo what it did after ${time}. People who joined through invites from this device after ${time} lose access too.`
export const RECOVERY_TEXT =
  "Set up a new primary with your recovery key. Devices you don't keep are signed out of every server."
export const REAPPLY_TEXT = 'Re-apply these moderation actions'
export const VOUCH_WAIT_TEXT =
  'Waiting for another member to come online. Someone besides the person who invited you must be around before you can join.'
export const VOUCH_INVITER_TEXT = 'Waiting for another member to come online'
export const SYNCING_TEXT = (n: number) =>
  `Syncing the server, ${n} ${n === 1 ? 'change' : 'changes'} so far. Messages show as they arrive.`
export const TRANSFERRED_TEXT = 'Ownership moved to a new copy of this server.'
export const DISPUTED_TEXT = 'Ownership transfer disputed'
export const MIGRATE_DIFF_TEXT = 'The new owner changed the member list during the transfer'
export const CARRY_WAIT_TEXT = 'Moving the old copy over. Waiting for its members to join.'
export const CARRY_HOURLY_TEXT = 'Moving the old copy over. Waiting for the hourly limit.'
export const CARRY_SYNC_TEXT = 'Moving the old copy over. Waiting to sync.'
export const CARRY_FAILED_TEXT = "Couldn't move everything from the old copy over"
export const lostOthersText = (n: number) =>
  `${n === 1 ? 'One of your other devices was' : `${n} of your other devices were`} added here after that time. ${n === 1 ? 'It is' : 'They are'} signed out too: set ${n === 1 ? 'it' : 'them'} up again afterwards.`
export const unsentText = (n: number) =>
  `Removed. ${n === 1 ? 'One of your messages was' : `${n} of your messages were`} not sent again: slow mode.`
export const SLOW_HIDDEN_TEXT = 'Hidden: sent too soon after your last message (slow mode).'
export const OWN_RESIGN_TEXT =
  'Your own messages and changes from this browser since then stay. These changes are signed again from its new key:'
export const TOO_OFTEN_TEXT = "You've done that too often. Try again later."
export const CANT_TEXT = "You can't do that here"
export const TOO_BIG_TEXT = 'Too long to send. Make it shorter.'

// What a refusal of one of our own events says (spec 4.1): W3(a) and a ban of someone who never
// joined (charged to the same window) are the hourly message; W3(b) is the lone device's; a join
// that waits for a third member (W3(e)); other limits are the generic one.
export const refusalText = (why: string) => {
  switch (why) {
    case 'W3':
      return QUICK_TEXT
    case 'W3b':
      return LONE_TEXT
    case 'W3e':
      return VOUCH_WAIT_TEXT
    case 'forked':
      return CONFLICT_TEXT
    case 'W3c':
    case 'W3d':
    case 'W3f':
    case 'W3g':
    case 'W5':
    case 'W6':
      return TOO_OFTEN_TEXT
    default:
      return CANT_TEXT
  }
}

// ----- Removals that reach invitees (§8.2) -----

export interface Reached {
  by: string
  lost: string[]
}

// Two readings of "taken along" by a cascade (spec 3.1): a member out with no removal of their
// own whose join came through an invite (or a code) of someone removed.
// - takenAlong: for the note to whoever removed them (Invite them again): someone *we* removed
//   (kick, ban or leave) within the last day.
// - cutOut: for the member themself (they keep the ACL and come back when invited again): their
//   inviter was kicked, by anyone, within the last week; a ban or a disowned device means the
//   invitees go for good.
const DAY = 24 * 60 * 60_000
export const CUT_MS = LOCAL.misc.cutMs
export const cutOut = (s: Summary, ik: string, now: number) => {
  const m = s.members[ik]
  if (!m || m.m !== 'leave' || m.rem) return false
  return [m.via, m.code].some(x => {
    const r = x === undefined ? undefined : s.members[x]
    return r?.m === 'leave' && r.remT === 'kick' && now - (r.remTs ?? -Infinity) < CUT_MS
  })
}

// Those `takenAlong` notes, new in `after`, by removed member.
const takenAlong = (s: Summary, me: string, now: number) => {
  const ours = (x: string) => {
    const r = s.members[x]
    return (
      x !== me &&
      !!r &&
      (r.m === 'leave' || r.m === 'ban') &&
      r.by === me &&
      now - (r.remTs ?? -Infinity) < DAY
    )
  }
  const out = new Map<string, string>()
  for (const [ik, x] of Object.entries(s.members)) {
    if (x.m !== 'leave' || x.rem || ik === me) continue
    const by = [x.via, x.code].find(v => v !== undefined && ours(v))
    if (by) out.set(ik, by)
  }
  return out
}

export const reachedBy = (before: Summary, after: Summary, me: string, now: number): Reached[] => {
  const was = takenAlong(before, me, now)
  const out = new Map<string, string[]>()
  for (const [ik, by] of takenAlong(after, me, now))
    if (was.get(ik) !== by) out.set(by, [...(out.get(by) ?? []), ik])
  return [...out].map(([by, lost]) => ({ by, lost: lost.sort() }))
}

// ----- Moderation waits for sync (§8.2, §9 rule 2) -----

export interface HeadsReport {
  ik: string
  at: number
  // ACL heads the peer sent that we neither hold nor refused.
  missing: number
}

// A moderation action asked for at `since` may be signed once a member sent its heads after
// that and we hold everything they named.
export const syncedSince = (
  since: number,
  reports: readonly HeadsReport[],
  member: (ik: string) => boolean
) => reports.some(r => r.at >= since && r.missing === 0 && member(r.ik))

// ----- Devices (§3.9) -----

export const LOST_TIMES = ['1 hour ago', '1 day ago', '1 week ago'].map((label, i) => ({
  label,
  ms: LOCAL.misc.lostTimes[i],
}))

// What an ACL action did, for lists (re-apply, a lost device's actions): the act, and the member
// it names (shown as a name, masked in streamer mode).
export const actParts = (t: string, to?: string): { act: string; who?: string } => {
  const named: Record<string, string> = {
    kick: 'Kick',
    ban: 'Ban',
    unban: 'Lift the ban of',
    uninvite: 'Withdraw the invite of',
    add: 'Invite',
    assign: 'Give a role to',
    revoke: 'Take a role from',
  }
  const plain: Record<string, string> = {
    code: 'Make an invite code',
    code_revoke: 'Revoke an invite code',
    role_create: 'Make a role',
    role_move: 'Move a role',
    role_bits: 'Change what a role may do',
    role_del: 'Delete a role',
    role_meta: 'Rename or recolor a role',
    channel: 'Change a channel',
    chperm: 'Change who may use a channel',
    settings: 'Change the server settings',
    profile: 'Change their profile',
    device_add: 'Add a device',
    device_revoke: 'Remove a device',
    primary_rotate: 'Recover the account',
    leave: 'Leave',
    join: 'Join',
  }
  if (named[t] && to) return { act: named[t], who: to }
  return { act: plain[t] ?? named[t] ?? 'Sync' }
}

// What a waiting carry-over waits for (spec 3.8, 4.1): the reason the last step was refused.
export const carryWaitText = (why: string | undefined) =>
  why === QUICK_TEXT ? CARRY_HOURLY_TEXT : why === LONE_TEXT ? CARRY_WAIT_TEXT : CARRY_SYNC_TEXT

// Whether the effect of our ACL event `id` (type `t`, content `c`) holds in `s`: what signing it
// again would bring back after a lost device's removal (spec 3.9). Cut or superseded changes
// don't hold; types the summary can't show are never signed again.
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export const effectHolds = (
  t: string,
  c: Record<string, unknown>,
  id: string,
  me: string,
  s: Summary
): boolean => {
  const to = typeof c.to === 'string' ? s.members[c.to] : undefined
  const role = typeof c.role === 'string' ? c.role : ''
  switch (t) {
    case 'code':
      return !!s.codes[id]
    case 'code_revoke':
      return typeof c.code === 'string' && !s.codes[c.code]
    case 'add':
      return (
        !!to &&
        ((to.m === 'invite' && !!to.adds?.includes(id)) || (to.m === 'join' && to.via === me))
      )
    case 'kick':
    case 'ban':
    case 'uninvite':
      return !!to && to.rem === id
    case 'unban':
      return !!to && to.m !== 'ban'
    case 'assign':
      return !!to && to.roles.includes(role)
    case 'revoke':
      return !!to && !to.roles.includes(role)
    case 'role_create':
      return !!s.roles[id]
    case 'role_del':
      return !s.roles[role]
    case 'role_move':
      return s.roles[role]?.pos === c.pos
    case 'role_bits': {
      const bits = role === EVERYONE ? s.everyone : s.roles[role]?.bits
      return bits !== undefined && typeof c.bit === 'number' && ((bits & c.bit) !== 0) === !!c.on
    }
    case 'channel':
      return typeof c.id === 'string' && same(s.channels[c.id], c)
    case 'chperm': {
      if (typeof c.ch !== 'string' || typeof c.subj !== 'string') return false
      const o = s.overwrites?.[c.ch]?.[c.subj] ?? { allow: 0, deny: 0 }
      return o.allow === (c.allow ?? 0) && o.deny === (c.deny ?? 0)
    }
    case 'role_meta': {
      const r = s.roles[role]
      return (
        !!r &&
        (c.name === undefined || r.name === c.name) &&
        (c.color === undefined || r.color === c.color)
      )
    }
    case 'settings':
      return same(s.settings, c)
    case 'profile':
      return same(s.members[me]?.profile, c)
    default:
      return false
  }
}

// An event's content signed again from a new key (spec 3.9): the ids it names that were signed
// again too (its target, reply, thread root, role or code) mapped to their new ones.
export const signedAgain = (c: Record<string, unknown>, ids: ReadonlyMap<string, string>) => {
  const out: Record<string, unknown> = { ...c }
  for (const k of ['target', 'reply', 'thread', 'role', 'code'])
    if (typeof out[k] === 'string') out[k] = ids.get(out[k] as string) ?? out[k]
  return out
}

// ----- Roles (§1.6) -----

// A move that lowers a role (a deny against its holders) warns first.
export const roleMoveWarns = (from: number, to: number) => to < from

// ----- Invite codes posted to the instance (note section 6) -----

export const INVITE_CODE = /\brci1\.[A-Za-z0-9_-]{20,}/
export const hasInviteCode = (text: string) => INVITE_CODE.test(text)
export const INVITE_POST_TEXT =
  'This is a P2P server invite code. Anyone who reads it here, including the instance, can join.'
