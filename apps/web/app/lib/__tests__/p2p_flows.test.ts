import { describe, expect, test } from 'bun:test'
import type { AclContent } from '../p2p/acl/rules'
import { emptySummary, type MemberSum, type Summary } from '../p2p/acl/summary'
import * as flows from '../p2p/flows'
import {
  hasInviteCode,
  reachedBy,
  reachedText,
  refusalText,
  roleMoveWarns,
  syncedSince,
} from '../p2p/flows'

const NOW = 1_800_000_000_000

const m = (x: Partial<MemberSum>): MemberSum => ({
  m: 'join',
  rank: [-1, ''],
  perms: 0,
  roles: [],
  devs: [],
  profile: null,
  ...x,
})

const sum = (members: Record<string, Partial<MemberSum>>): Summary => ({
  ...emptySummary(),
  members: Object.fromEntries(Object.entries(members).map(([k, v]) => [k, m(v)])),
})

describe('P2P server flows: copy (spec 8.2)', () => {
  test('every line is plain: no em dashes, and the app never names itself', () => {
    const lines = Object.values(flows).flatMap(v =>
      typeof v === 'string'
        ? [v]
        : typeof v === 'function' && v.length <= 2
          ? [String((v as (a: string, b: number) => unknown)('Bob', 2))]
          : []
    )
    expect(lines.length).toBeGreaterThan(30)
    for (const l of lines) {
      expect(l).not.toContain('—')
      expect(l.toLowerCase()).not.toContain('rchat')
    }
  })

  test('the exact wording of the spec', () => {
    expect(flows.OWNER_TEXT).toBe('The owner is set when the server is created and never changes.')
    expect(flows.CO_OWNERS_TEXT).toBe(
      'Co-owners (optional). Co-owners can do everything the owner can. You can only add them now.'
    )
    expect(flows.hiddenRemovedText('Bob')).toBe('Hidden: sent around the time Bob was removed.')
    expect(flows.SYNC_WAIT_TEXT).toBe('Waiting to sync before applying…')
    expect(flows.APPLY_ANYWAY).toBe('Apply anyway')
    expect(reachedText('Bob', 3)).toBe(
      "Removing Bob also removed 3 people who joined through Bob's invites at the same time."
    )
    expect(reachedText('Bob', 1)).toBe(
      "Removing Bob also removed 1 person who joined through Bob's invites at the same time."
    )
    expect(flows.lostText('9:15')).toBe(
      'Remove this device and undo what it did after 9:15. People who joined through invites from this device after 9:15 lose access too.'
    )
    expect(flows.TRANSFER_CO_OWNERS_TEXT).toBe(
      'Every co-owner must approve the transfer, including co-owners who have left.'
    )
    expect(flows.transferText('Bob')).toBe(
      'Transferring ownership creates a new copy of this server owned by Bob. Members, roles, channels and bans move over automatically, and everyone switches to the new copy. Messages from before the transfer stay readable above the new ones; the old copy becomes read-only.'
    )
    expect(flows.EQUAL_ROLES_TEXT).toBe(
      'If two people with the same top role remove each other at about the same time, both removals stand. Someone with a higher role, or the owner, can add either of them back.'
    )
    expect(flows.HIGHER_ROLES_TEXT).toBe(
      "A moderator can't remove someone who, at the same moment, was given a role above theirs."
    )
    expect(flows.OFFLINE_TEXT).toBe(
      "Things you do after being removed or demoted don't count, even if your device hadn't heard about it yet."
    )
    expect(flows.ROLE_DOWN_TEXT).toBe(
      "Members with this role lose its rank at once, including for anything they're doing right now."
    )
    expect(flows.UNBAN_TEXT).toBe(
      'Only someone with a role at least as high as the person who banned them can unban.'
    )
    expect(flows.WIPE_TEXT).toBe('Also hide all their messages')
    expect(flows.DEVICES_TEXT).toBe(
      "You can use several devices at once. A browser restored from a backup becomes a new device; anything the restored copy signed before that doesn't count."
    )
    expect(flows.CONFLICT_TEXT).toBe(
      "This device's history conflicts with another copy of it. Set it up as a new device."
    )
    expect(flows.QUICK_TEXT).toBe(
      "You're changing this server too quickly. Try again in a few minutes."
    )
    expect(flows.LONE_TEXT).toBe(
      "You've made many changes while nobody else was around. Try again later."
    )
    expect(flows.CODE_RETRY_TEXT).toBe(
      "If you don't finish joining within about 10 minutes, use the code again."
    )
    expect(flows.CODE_REVOKE_TEXT).toBe(
      'A revoked code stops working everywhere as members sync. People it already let in stay unless a moderator removes them.'
    )
    expect(flows.CODE_DEATH_TEXT).toBe(
      'Codes stop working for good if the person who made them loses the right to invite.'
    )
    expect(flows.WITHDRAW_TEXT).toBe(
      'This cancels the invite. If they already received it, they can still use it to join, now or later; ask a moderator to remove them.'
    )
    expect(flows.RECOVERY_TEXT).toBe(
      "Set up a new primary with your recovery key. Devices you don't keep are signed out of every server."
    )
    expect(flows.MIGRATE_DIFF_TEXT).toBe(
      'The new owner changed the member list during the transfer'
    )
    expect(flows.DISPUTED_TEXT).toBe('Ownership transfer disputed')
  })

  test('refusals of our own events', () => {
    expect(refusalText('W3')).toBe(flows.QUICK_TEXT)
    expect(refusalText('W3b')).toBe(flows.LONE_TEXT)
    expect(refusalText('W3e')).toBe(flows.VOUCH_WAIT_TEXT)
    expect(refusalText('forked')).toBe(flows.CONFLICT_TEXT)
    for (const w of ['W3c', 'W3d', 'W3f', 'W3g', 'W5', 'W6'])
      expect(refusalText(w)).toBe(flows.TOO_OFTEN_TEXT)
    expect(refusalText('auth')).toBe(flows.CANT_TEXT)
  })
})

describe('P2P server flows: removals that reach invitees', () => {
  test('members out with no removal of their own, let in by someone we removed', () => {
    const before = sum({ me: { m: 'join' }, bob: { m: 'join' } })
    const after = sum({
      me: { m: 'join' },
      bob: { m: 'leave', rem: 'k1', by: 'me', remTs: NOW - 1000 },
      dan: { m: 'leave', via: 'bob' },
      eve: { m: 'leave', via: 'me', code: 'bob' },
      fay: { m: 'leave', via: 'me' },
      // Removed on their own: not taken along.
      gus: { m: 'leave', via: 'bob', rem: 'k2', by: 'me' },
    })
    expect(reachedBy(before, after, 'me', NOW)).toEqual([{ by: 'bob', lost: ['dan', 'eve'] }])
    // Told once: the same state again says nothing new.
    expect(reachedBy(after, after, 'me', NOW)).toEqual([])
    // A removal of more than a day ago (an old cascade found on a start) says nothing.
    expect(reachedBy(before, after, 'me', NOW + 2 * 24 * 60 * 60_000)).toEqual([])
  })

  test('only removals of ours', () => {
    const before = sum({ bob: { m: 'join' } })
    expect(
      reachedBy(
        before,
        sum({ bob: { m: 'leave', rem: 'k', by: 'zed' }, dan: { m: 'leave', via: 'bob' } }),
        'me',
        NOW
      )
    ).toEqual([])
    // Bob left by himself.
    expect(
      reachedBy(
        before,
        sum({ bob: { m: 'leave', rem: 'l', by: 'bob' }, dan: { m: 'leave', via: 'bob' } }),
        'bob',
        NOW
      )
    ).toEqual([])
  })
})

describe('P2P server flows: moderation waits for sync', () => {
  const member = (ik: string) => ik !== 'out'
  test('a member reported its heads since we asked, and we hold them all', () => {
    expect(syncedSince(100, [], member)).toBe(false)
    expect(syncedSince(100, [{ ik: 'bob', at: 99, missing: 0 }], member)).toBe(false)
    expect(syncedSince(100, [{ ik: 'bob', at: 100, missing: 1 }], member)).toBe(false)
    expect(syncedSince(100, [{ ik: 'out', at: 120, missing: 0 }], member)).toBe(false)
    expect(
      syncedSince(
        100,
        [
          { ik: 'bob', at: 120, missing: 2 },
          { ik: 'cy', at: 101, missing: 0 },
        ],
        member
      )
    ).toBe(true)
  })
})

describe('P2P server flows: devices and roles', () => {
  test('actions in lists say what they did and to whom', () => {
    expect(flows.actParts('ban', 'bob')).toEqual({ act: 'Ban', who: 'bob' })
    expect(flows.actParts('uninvite', 'bob')).toEqual({ act: 'Withdraw the invite of', who: 'bob' })
    expect(flows.actParts('code')).toEqual({ act: 'Make an invite code' })
    expect(flows.actParts('kick')).toEqual({ act: 'Kick' })
    expect(flows.actParts('mark')).toEqual({ act: 'Sync' })
    expect(flows.actParts('role_meta')).toEqual({ act: 'Rename or recolor a role' })
  })

  test('moving a role down warns', () => {
    expect(roleMoveWarns(5, 3)).toBe(true)
    expect(roleMoveWarns(3, 5)).toBe(false)
  })
})

describe('P2P server flows: what a lost device removal signs again', () => {
  const holds = (t: string, c: Record<string, unknown>, s: Summary, id = 'e1') =>
    flows.effectHolds(t, c, id, 'me', s)
  test('our changes whose effect still holds, never cut or superseded ones', () => {
    const s: Summary = {
      ...sum({
        me: { m: 'join', profile: { name: 'Me' } as unknown as AclContent },
        bob: { m: 'leave', rem: 'e1', by: 'me' },
        cy: { m: 'invite', adds: ['e1'] },
        dan: { m: 'join', via: 'me', roles: ['r1'] },
        eve: { m: 'leave', rem: 'k9', by: 'zed' },
      }),
      roles: { r1: { pos: 2, bits: 4, name: 'Mods', color: 7 } },
      overwrites: { c1: { 'u:dan': { allow: 256, deny: 0 } } },
      everyone: 1,
      channels: { c1: { id: 'c1', name: 'general' } as unknown as AclContent },
      settings: { name: 'Club' } as unknown as AclContent,
      codes: { e1: { a: 'me', h: 'h' } },
    }
    expect(holds('kick', { to: 'bob' }, s)).toBe(true)
    // Someone else's later removal superseded ours.
    expect(holds('kick', { to: 'eve' }, s)).toBe(false)
    expect(holds('add', { to: 'cy' }, s)).toBe(true)
    expect(holds('add', { to: 'dan' }, s, 'e2')).toBe(true)
    expect(holds('add', { to: 'bob' }, s, 'e2')).toBe(false)
    expect(holds('code', {}, s)).toBe(true)
    expect(holds('code', {}, s, 'e2')).toBe(false)
    expect(holds('code_revoke', { code: 'gone' }, s)).toBe(true)
    expect(holds('assign', { to: 'dan', role: 'r1' }, s)).toBe(true)
    expect(holds('revoke', { to: 'dan', role: 'r1' }, s)).toBe(false)
    expect(holds('role_create', {}, s, 'r1')).toBe(true)
    expect(holds('role_move', { role: 'r1', pos: 3 }, s)).toBe(false)
    expect(holds('role_bits', { role: 'r1', bit: 4, on: true }, s)).toBe(true)
    expect(holds('role_bits', { role: 'everyone', bit: 1, on: false }, s)).toBe(false)
    expect(holds('channel', { id: 'c1', name: 'general' }, s)).toBe(true)
    expect(holds('channel', { id: 'c1', name: 'old name' }, s)).toBe(false)
    expect(holds('settings', { name: 'Club' }, s)).toBe(true)
    expect(holds('profile', { name: 'Me' }, s)).toBe(true)
    expect(holds('chperm', { ch: 'c1', subj: 'u:dan', allow: 256, deny: 0 }, s)).toBe(true)
    expect(holds('chperm', { ch: 'c1', subj: 'u:dan', allow: 512, deny: 0 }, s)).toBe(false)
    expect(holds('chperm', { ch: 'c1', subj: 'u:bob', allow: 0, deny: 0 }, s)).toBe(true)
    expect(holds('chperm', { ch: 'c1', subj: 'u:bob', allow: 256, deny: 0 }, s)).toBe(false)
    expect(holds('role_meta', { role: 'r1', name: 'Mods', color: 7 }, s)).toBe(true)
    expect(holds('role_meta', { role: 'r1', name: 'Staff', color: 7 }, s)).toBe(false)
    expect(holds('role_meta', { role: 'gone', name: 'Mods' }, s)).toBe(false)
    // What the summary can't show is never signed again.
    expect(holds('mark', {}, s)).toBe(false)
  })

  test('signed again: the ids it names that were signed again are mapped, its thread root too', () => {
    const ids = new Map([
      ['root', 'root2'],
      ['code', 'code2'],
    ])
    expect(
      flows.signedAgain({ body: 'x', thread: 'root', reply: 'other', code: 'code', n: 1 }, ids)
    ).toEqual({ body: 'x', thread: 'root2', reply: 'other', code: 'code2', n: 1 })
  })

  test('a waiting carry-over says what it waits for', () => {
    expect(flows.carryWaitText(flows.LONE_TEXT)).toBe(flows.CARRY_WAIT_TEXT)
    expect(flows.carryWaitText(flows.QUICK_TEXT)).toBe(flows.CARRY_HOURLY_TEXT)
    expect(flows.carryWaitText('Waiting to sync. Try again in a moment.')).toBe(
      flows.CARRY_SYNC_TEXT
    )
  })
})

describe('P2P server flows: invite codes posted to the instance', () => {
  test('a code in a message is found', () => {
    expect(hasInviteCode('join us: rci1.eyJ2IjoxLCJyb29tIjoiYWJjIn0abcdef')).toBe(true)
    expect(hasInviteCode('rci1.short')).toBe(false)
    expect(hasInviteCode('xrci1.eyJ2IjoxLCJyb29tIjoiYWJjIn0abcdef')).toBe(false)
    expect(hasInviteCode('nothing here')).toBe(false)
  })
})
