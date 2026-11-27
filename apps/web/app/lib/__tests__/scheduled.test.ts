import { afterEach, describe, expect, test } from 'bun:test'
import {
  applyHosted,
  BLOCKED,
  chipText,
  chipTitle,
  countsFor,
  DEFER_MAX_MS,
  fromHosted,
  fromLocalInput,
  isLate,
  laterBlocked,
  localInput,
  MISSED_MS,
  pickProblem,
  presetLabel,
  presetTime,
  SCHEDULE_MAX_MS,
  scheduleProblem,
  settleWait,
  SLOW_FAILED,
  sortItems,
  stateText,
  WAITING_SLOW,
  whenText,
  type ScheduledItem,
} from '../scheduled'
import type { ScheduledMessage, WsEvent } from '../types'

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
afterEach(() => {
  process.env.TZ = zone
})

const inZone = (tz: string) => {
  process.env.TZ = tz
}

// A local wall-clock time in the zone under test.
const local = (y: number, mo: number, d: number, h = 12, mi = 0) =>
  new Date(y, mo - 1, d, h, mi).getTime()

const parts = (ms: number) => {
  const d = new Date(ms)
  return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()]
}

describe('presets', () => {
  test('in an hour rounds up to the next whole minute', () => {
    inZone('America/New_York')
    const now = new Date(local(2026, 3, 4, 10, 30) + 20_000)
    expect(parts(presetTime('hour', now))).toEqual([2026, 3, 4, 11, 31])
    const exact = new Date(local(2026, 3, 4, 10, 30))
    expect(parts(presetTime('hour', exact))).toEqual([2026, 3, 4, 11, 30])
    const late = new Date(local(2026, 3, 4, 23, 30))
    expect(parts(presetTime('hour', late))).toEqual([2026, 3, 5, 0, 30])
  })

  test('tomorrow is 9:00 the next day, across midnight and month ends', () => {
    inZone('Europe/Berlin')
    expect(parts(presetTime('tomorrow', new Date(local(2026, 1, 31, 23, 59))))).toEqual([
      2026, 2, 1, 9, 0,
    ])
    expect(parts(presetTime('tomorrow', new Date(local(2026, 6, 10, 0, 5))))).toEqual([
      2026, 6, 11, 9, 0,
    ])
  })

  test('next Monday is the first Monday after today, at 9:00', () => {
    inZone('America/Chicago')
    // 2026-11-29 is a Sunday, 2026-11-30 a Monday.
    expect(parts(presetTime('monday', new Date(local(2026, 11, 29, 20))))).toEqual([
      2026, 11, 30, 9, 0,
    ])
    expect(parts(presetTime('monday', new Date(local(2026, 11, 30, 8))))).toEqual([
      2026, 12, 7, 9, 0,
    ])
    expect(parts(presetTime('monday', new Date(local(2026, 12, 2, 8))))).toEqual([
      2026, 12, 7, 9, 0,
    ])
  })

  test('presets keep the wall clock across a DST change', () => {
    inZone('America/Chicago')
    // DST ends on 2026-11-01 and starts on 2026-03-08 in Chicago.
    const before = presetTime('tomorrow', new Date(local(2026, 10, 31, 22)))
    expect(parts(before)).toEqual([2026, 11, 1, 9, 0])
    expect(before - local(2026, 10, 31, 22)).toBe(12 * 3_600_000)
    inZone('Europe/Berlin')
    // DST starts on 2026-03-29 in Berlin.
    const spring = presetTime('monday', new Date(local(2026, 3, 28, 12)))
    expect(parts(spring)).toEqual([2026, 3, 30, 9, 0])
  })

  test('labels name the time in the locale', () => {
    inZone('UTC')
    const now = new Date(Date.UTC(2026, 10, 27, 12))
    expect(presetLabel('hour', now, 'en-US')).toBe('In 1 hour')
    expect(presetLabel('tomorrow', now, 'en-US')).toBe('Tomorrow at 9:00 AM')
    expect(/^Next Monday at 0?9:00$/.test(presetLabel('monday', now, 'en-GB'))).toBe(true)
  })
})

describe('time checks', () => {
  const now = 1_000_000_000_000
  test('scheduling needs a minute ahead and at most a year', () => {
    expect(scheduleProblem(now + 59_999, now)).toBe('Pick a time at least 1 minute ahead')
    expect(scheduleProblem(now + 60_000, now)).toBeNull()
    expect(scheduleProblem(now + SCHEDULE_MAX_MS, now)).toBeNull()
    expect(scheduleProblem(now + SCHEDULE_MAX_MS + 1, now)).toBe('Pick a time within a year')
    expect(scheduleProblem(Number.NaN, now)).toBe('Pick a date and time')
  })

  test('the picker keeps two minutes of slack', () => {
    expect(pickProblem(now + 119_999, now)).toBe('Pick a time at least 2 minutes ahead')
    expect(pickProblem(now + 120_000, now)).toBeNull()
    expect(pickProblem(now + SCHEDULE_MAX_MS + 1, now)).toBe('Pick a time within a year')
  })

  test('late means more than two minutes past', () => {
    expect(isLate(now - MISSED_MS, now)).toBe(false)
    expect(isLate(now - MISSED_MS - 1, now)).toBe(true)
  })

  test('slow mode waits within an hour of the time, then fails', () => {
    expect(settleWait(now, now + 10_000, 30_000)).toEqual({
      kind: 'defer',
      next: now + 40_000,
      note: WAITING_SLOW,
    })
    expect(settleWait(now, now + DEFER_MAX_MS - 30_000, 30_000).kind).toBe('defer')
    expect(settleWait(now, now + DEFER_MAX_MS - 29_999, 30_000)).toEqual({
      kind: 'fail',
      error: SLOW_FAILED,
    })
  })
})

describe('when text', () => {
  test('today, tomorrow, this week, this year and later', () => {
    inZone('America/New_York')
    // A Friday.
    const now = local(2026, 11, 27, 10)
    const fmt = (at: number, locale = 'en-US') => whenText(at, now, locale)
    expect(fmt(local(2026, 11, 27, 16, 42))).toBe('Today at 4:42 PM')
    expect(fmt(local(2026, 11, 28, 9))).toBe('Tomorrow at 9:00 AM')
    expect(fmt(local(2026, 11, 26, 9))).toBe('Yesterday at 9:00 AM')
    expect(fmt(local(2026, 11, 30, 9))).toBe('Monday at 9:00 AM')
    expect(fmt(local(2026, 12, 3, 9))).toBe('Thursday at 9:00 AM')
    expect(fmt(local(2026, 12, 4, 9))).toBe('Fri, Dec 4 at 9:00 AM')
    expect(fmt(local(2027, 12, 1, 9))).toBe('Dec 1, 2027 at 9:00 AM')
    expect(fmt(local(2026, 11, 27, 16, 42), 'en-GB')).toBe('Today at 16:42')
    expect(/2027 at 0?9:00$/.test(fmt(local(2027, 12, 1, 9), 'de-DE'))).toBe(true)
  })
})

describe('local input', () => {
  test('round trips minutes and seconds in the local zone', () => {
    inZone('Europe/Berlin')
    const at = local(2026, 3, 29, 3, 15)
    expect(localInput(at)).toBe('2026-03-29T03:15')
    expect(fromLocalInput(localInput(at))).toBe(at)
    expect(localInput(at + 7000, true)).toBe('2026-03-29T03:15:07')
    expect(fromLocalInput('2026-03-29T03:15:07')).toBe(at + 7000)
    for (const bad of ['', 'tomorrow', '2026-02-30T10:00', '2026-13-01T10:00'])
      expect(fromLocalInput(bad)).toBeNull()
  })
})

const item = (over: Partial<ScheduledItem>): ScheduledItem => ({
  key: 'h:1',
  side: 'hosted',
  place: 'c1',
  body: 'hi',
  reply: null,
  at: 100,
  next: 100,
  state: 'waiting',
  error: null,
  deferred: false,
  label: null,
  ...over,
})

describe('list state', () => {
  test('unsent ones come first, then by time', () => {
    const list = [
      item({ key: 'h:1', at: 300 }),
      item({ key: 'd:2', at: 500, state: 'missed' }),
      item({ key: 'h:3', at: 100 }),
      item({ key: 'h:4', at: 900, state: 'failed' }),
    ]
    expect(sortItems(list).map(i => i.key)).toEqual(['d:2', 'h:4', 'h:3', 'h:1'])
  })

  test('the chip counts one place', () => {
    const list = [
      item({ key: 'h:1' }),
      item({ key: 'h:2', state: 'sending' }),
      item({ key: 'h:3', state: 'failed' }),
      item({ key: 'h:4', place: 'c2' }),
    ]
    const c = countsFor(list, 'c1')
    expect(c).toEqual({ waiting: 2, unsent: 1 })
    expect(chipText(c)).toBe('2 scheduled, 1 not sent')
    expect(chipText({ waiting: 2, unsent: 0 })).toBe('2 scheduled')
    expect(chipText({ waiting: 0, unsent: 1 })).toBe('1 not sent')
    expect(chipText({ waiting: 0, unsent: 0 })).toBeNull()
    expect(chipTitle(c)).toBe('3 scheduled messages here')
    expect(chipTitle({ waiting: 1, unsent: 0 })).toBe('1 scheduled message here')
  })

  test('each state says what it is', () => {
    expect(stateText(item({}))).toBeNull()
    expect(stateText(item({ deferred: true }))).toBe('Waiting for slow mode')
    expect(stateText(item({ state: 'sending' }))).toBe('Sending')
    expect(stateText(item({ state: 'failed', error: 'Nope' }))).toBe('Not sent: Nope')
    expect(stateText(item({ state: 'missed' }))).toBe('Not sent while the app was closed')
  })
})

const row = (over: Partial<ScheduledMessage> = {}): ScheduledMessage => ({
  id: 7,
  scope: 'c3',
  channel_id: 3,
  dm_id: null,
  thread_root_id: null,
  reply_to: null,
  mention_reply: true,
  content: 'later',
  at: 2000,
  next_at: 2000,
  status: 'waiting',
  error: null,
  place: {
    server: 'club',
    server_name: 'Club',
    channel_name: 'general',
    dm_user: null,
  },
  created_at: 1,
  updated_at: 1,
  ...over,
})

describe('hosted rows', () => {
  test('rows become items in milliseconds at their draft key', () => {
    expect(fromHosted(row())).toEqual({
      key: 'h:7',
      side: 'hosted',
      place: 'c3',
      body: 'later',
      reply: null,
      at: 2_000_000,
      next: 2_000_000,
      state: 'waiting',
      error: null,
      deferred: false,
      label: { server: 'Club', channel: 'general', person: null, by: null, thread: false },
    })
    expect(fromHosted(row({ thread_root_id: 9, reply_to: 4 })).place).toBe('t9')
    expect(fromHosted(row({ thread_root_id: 9, reply_to: 4 })).reply).toBe('4')
    expect(fromHosted(row({ channel_id: null, dm_id: 5, place: null })).place).toBe('d5')
    const slow = fromHosted(row({ error: WAITING_SLOW, next_at: 2030 }))
    expect([slow.deferred, slow.error, slow.next]).toEqual([true, null, 2_030_000])
    const failed = fromHosted(row({ status: 'failed', error: 'Gone' }))
    expect([failed.state, failed.error, failed.deferred]).toEqual(['failed', 'Gone', false])
  })

  test('events update and remove rows, keeping labels', () => {
    const start = { 'h:7': fromHosted(row()) }
    const updated: WsEvent = {
      type: 'scheduled_updated',
      username: 'alice',
      scheduled: row({ status: 'failed', error: 'Gone', place: null }),
    }
    const after = applyHosted(start, updated)
    expect(after['h:7'].state).toBe('failed')
    expect(after['h:7'].label?.channel).toBe('general')
    const fresh = applyHosted({}, { ...updated, scheduled: row({ id: 8, place: null }) })
    expect(fresh['h:8'].label).toBeNull()
    const removed: WsEvent = {
      type: 'scheduled_removed',
      username: 'alice',
      id: 7,
      sent_message_id: 99,
    }
    expect(applyHosted(after, removed)).toEqual({})
    expect(applyHosted(start, { ...removed, id: 1 })).toBe(start)
  })
})

describe('send later on a draft', () => {
  const base = { text: 'hi', rich: false, tooLong: false, on: true, cap: 100, waiting: 0 }
  test('each reason, in order', () => {
    expect(laterBlocked(base)).toBeNull()
    expect(laterBlocked({ ...base, rich: true, text: '' })).toBe(BLOCKED.text)
    expect(laterBlocked({ ...base, text: '  ' })).toBe(BLOCKED.empty)
    expect(laterBlocked({ ...base, tooLong: true })).toBe(BLOCKED.long)
    expect(laterBlocked({ ...base, on: false })).toBe(BLOCKED.off)
    expect(laterBlocked({ ...base, waiting: 100 })).toBe('You have 100 waiting')
    expect(laterBlocked({ ...base, cap: 0, waiting: 5000 })).toBeNull()
  })
})
