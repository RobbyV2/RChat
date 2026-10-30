import { describe, expect, test } from 'bun:test'
import {
  TIMEOUT_MAX,
  customSeconds,
  durationText,
  fromWire,
  remainingText,
  remainingWords,
  running,
  shownMedia,
  timedOutLine,
  untilText,
} from '../timeouts'
import { memberTimeout, myTimeoutEnds, voiceMutedIn } from '../selectors'
import { profileActions } from '../profile'
import { localSummary } from '../api'

describe('timeouts', () => {
  test('custom durations are positive and at most 28 days', () => {
    expect(customSeconds('10', 60)).toBe(600)
    expect(customSeconds('1.5', 3600)).toBe(5400)
    expect(customSeconds('28', 86400)).toBe(TIMEOUT_MAX)
    expect(customSeconds('29', 86400)).toBeNull()
    expect(customSeconds('0', 60)).toBeNull()
    expect(customSeconds('-2', 60)).toBeNull()
    expect(customSeconds('', 60)).toBeNull()
    expect(customSeconds('abc', 60)).toBeNull()
  })

  test('listeners never show the camera or screen of someone a timeout mutes', () => {
    const on = { camOn: true, screenOn: true }
    expect(shownMedia(on, false)).toEqual({ cam: true, screen: true })
    expect(shownMedia(on, true)).toEqual({ cam: false, screen: false })
    expect(shownMedia(undefined, false)).toEqual({ cam: false, screen: false })
  })

  test('your own timeout ends on your clock, from the seconds left', () => {
    const base = { name: 'club', display_name: 'Club', creator: null, is_admin: false }
    expect(localSummary(base, 5000)).toEqual(base)
    expect(
      localSummary({ ...base, timed_out_until: 99999, timed_out_remaining: 60 }, 5000)
        .timed_out_until
    ).toBe(65)
  })

  test('the end comes from the seconds left, not the server clock', () => {
    expect(fromWire({ until: 1, remaining: 30, reason: 'r' }, 1000)).toEqual({
      ends: 31000,
      reason: 'r',
    })
    expect(fromWire({ until: 1, remaining: -5, reason: null }, 1000).ends).toBe(1000)
    expect(running({ ends: 2000, reason: null }, 1000)).toBe(true)
    expect(running({ ends: 1000, reason: null }, 1000)).toBe(false)
    expect(running(undefined, 1000)).toBe(false)
  })

  test('countdowns', () => {
    expect(remainingText(45_000)).toBe('45s')
    expect(remainingText(44_001)).toBe('45s')
    expect(remainingText(245_000)).toBe('4:05')
    expect(remainingText(3_723_000)).toBe('1:02:03')
    expect(remainingText(3 * 86400_000 + 4 * 3600_000)).toBe('3d 4h')
    expect(remainingText(86400_000)).toBe('1d')
    expect(remainingText(-5)).toBe('0s')
    expect(remainingWords(1000)).toBe('1 second left')
    expect(remainingWords(600_000)).toBe('10 minutes left')
    expect(remainingWords(2 * 86400_000)).toBe('2 days left')
  })

  test('the end shows as a time today, with the date otherwise', () => {
    const now = new Date(2026, 9, 29, 10, 0).getTime()
    const later = new Date(2026, 9, 29, 16, 30).getTime()
    expect(untilText(later, now, 'en-US')).toBe('4:30 PM')
    expect(untilText(later, now, 'en-GB')).toBe('16:30')
    expect(timedOutLine(later, now, 'en-US')).toBe('You are timed out until 4:30 PM.')
    const tomorrow = new Date(2026, 9, 30, 9, 5).getTime()
    expect(untilText(tomorrow, now, 'en-US')).toBe('Oct 30, 2026, 9:05 AM')
  })

  test('durations in words', () => {
    expect(durationText(60)).toBe('60 seconds')
    expect(durationText(604800)).toBe('1 week')
    expect(durationText(7200)).toBe('2 hours')
    expect(durationText(90)).toBe('1 minute 30 seconds')
    expect(durationText(93600)).toBe('1 day 2 hours')
    expect(durationText(3 * 86400 + 59)).toBe('3 days')
    expect(durationText(1)).toBe('1 second')
    expect(durationText(0)).toBe('0 seconds')
  })

  test('selectors only report running timeouts', () => {
    const me = {
      username: 'bob',
      servers: [
        { name: 'club', timed_out_until: 100 },
        { name: 'old', timed_out_until: 5 },
        { name: 'free' },
      ],
    }
    const s = { me } as unknown as Parameters<typeof myTimeoutEnds>[0]
    expect(myTimeoutEnds(s, 'club', 50_000)).toBe(100_000)
    expect(myTimeoutEnds(s, 'old', 50_000)).toBeNull()
    expect(myTimeoutEnds(s, 'free', 50_000)).toBeNull()
    expect(myTimeoutEnds(s, null, 50_000)).toBeNull()
    const timeouts = { club: { bob: { ends: 2000, reason: null } } }
    expect(memberTimeout({ timeouts }, 'club', 'bob', 1000)).toEqual({ ends: 2000, reason: null })
    expect(memberTimeout({ timeouts }, 'club', 'bob', 2000)).toBeNull()
    expect(memberTimeout({ timeouts }, 'club', 'carol', 1000)).toBeNull()
    expect(voiceMutedIn({ voiceMuted: { 3: ['bob'] } }, 3)).toEqual(['bob'])
    expect(voiceMutedIn({ voiceMuted: {} }, 3)).toEqual([])
    expect(voiceMutedIn({ voiceMuted: { 3: ['bob'] } }, null)).toEqual([])
  })

  test('profile actions offer a timeout only to moderators above the member', () => {
    expect(
      profileActions({
        signedIn: true,
        self: false,
        siteAdmin: false,
        inServer: true,
        perms: 128,
        member: { is_admin: false, perms: 0 },
        targetPerms: 0,
        timedOut: true,
      })
    ).toEqual(['timeout', 'untimeout'])
  })
})
