import { describe, expect, test } from 'bun:test'
import {
  BAN_DURATIONS,
  BAN_MAX,
  BAN_MIN,
  PURGE_ALL,
  PURGE_HOURS_MAX,
  PURGE_WINDOWS,
  banSeconds,
  cleanReason,
  endsText,
  fitBan,
  purgeChoices,
  purgeHours,
} from '../durations'

describe('ban durations', () => {
  test('presets are within the range the server takes', () => {
    for (const d of BAN_DURATIONS) if (d.value !== null) expect(banSeconds(d.value)).toBe(d.value)
    expect(BAN_DURATIONS.map(d => d.label)).toEqual([
      '1 hour',
      '1 day',
      '7 days',
      '30 days',
      'Permanent',
    ])
    for (const w of PURGE_WINDOWS) expect(purgeHours(w.value)).toBe(w.value)
    expect(PURGE_WINDOWS.map(w => w.value)).toEqual([0, 1, 24, 168])
  })

  test('bounds', () => {
    expect(banSeconds(BAN_MIN)).toBe(60)
    expect(banSeconds(BAN_MAX)).toBe(63_072_000)
    expect(banSeconds(BAN_MIN - 1)).toBeNull()
    expect(banSeconds(BAN_MAX + 1)).toBeNull()
    expect(banSeconds(90.5)).toBeNull()
    expect(banSeconds('3600')).toBeNull()
    expect(purgeHours(0)).toBe(0)
    expect(purgeHours(PURGE_HOURS_MAX)).toBe(168)
    expect(purgeHours(169)).toBeNull()
    expect(purgeHours(-1)).toBeNull()
  })

  test('a reason is trimmed, capped by code points, and blank is none', () => {
    expect(cleanReason('  spam  ')).toBe('spam')
    expect(cleanReason('   ')).toBeNull()
    expect([...cleanReason('😀'.repeat(400))!].length).toBe(300)
  })

  test('a choice is fitted to what the side supports', () => {
    const choice = { seconds: 3600, reason: 'spam', purgeHours: 24 }
    expect(fitBan(choice, { timed: true, purge: 'window' })).toEqual(choice)
    expect(fitBan(choice, { timed: false, purge: 'all' })).toEqual({
      seconds: null,
      reason: 'spam',
      purgeHours: 0,
    })
    expect(
      fitBan({ ...choice, purgeHours: PURGE_ALL }, { timed: false, purge: 'all' }).purgeHours
    ).toBe(PURGE_ALL)
    expect(
      fitBan({ ...choice, purgeHours: PURGE_ALL }, { timed: true, purge: 'window' }).purgeHours
    ).toBe(0)
    expect(fitBan(choice, { timed: true, purge: 'none' }).purgeHours).toBe(0)
    expect(purgeChoices('none')).toEqual([])
    expect(purgeChoices('all').map(c => c.value)).toEqual([0, PURGE_ALL])
    expect(purgeChoices('window')).toBe(PURGE_WINDOWS)
  })

  test('an end today shows the time, another day the date too', () => {
    const now = new Date(2026, 0, 5, 9, 0).getTime()
    const today = endsText(new Date(2026, 0, 5, 17, 30).getTime(), now, 'en-US')
    expect(today).toContain('5:30')
    expect(today).not.toContain('2026')
    expect(endsText(new Date(2026, 0, 9, 17, 30).getTime(), now, 'en-US')).toContain('Jan 9, 2026')
  })
})
