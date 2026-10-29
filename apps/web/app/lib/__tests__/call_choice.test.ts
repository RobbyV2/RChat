import { describe, expect, test } from 'bun:test'
import {
  callLogInfo,
  callRouteValue,
  p2pCallable,
  parseCallRoute,
  recentlyFailed,
  routeFor,
  shortDuration,
  type P2pCallInputs,
} from '../call_choice'
import type { CallLog } from '../types'

describe('call route storage', () => {
  test('round trips and defaults to the server', () => {
    expect(parseCallRoute(callRouteValue('p2p'))).toBe('p2p')
    expect(parseCallRoute(callRouteValue('server'))).toBe('server')
    for (const bad of [null, '', '{oops', '"p2p"', '[]', '{"v":2,"route":"p2p"}', '{"v":1}'])
      expect(parseCallRoute(bad)).toBe('server')
    expect(parseCallRoute('{"v":1,"route":"lan"}')).toBe('server')
  })
})

describe('P2P call availability', () => {
  const ok: P2pCallInputs = {
    guest: false,
    signedIn: true,
    p2pOn: true,
    selfDm: false,
    failed: false,
  }

  test('needs an account, P2P on and another side that can connect', () => {
    expect(p2pCallable(ok)).toBe(true)
    expect(p2pCallable({ ...ok, guest: true })).toBe(false)
    expect(p2pCallable({ ...ok, signedIn: false })).toBe(false)
    expect(p2pCallable({ ...ok, p2pOn: false })).toBe(false)
    expect(p2pCallable({ ...ok, selfDm: true })).toBe(false)
    expect(p2pCallable({ ...ok, failed: true })).toBe(false)
  })

  test('the main button falls back to the server when P2P is out', () => {
    expect(routeFor('p2p', true)).toBe('p2p')
    expect(routeFor('p2p', false)).toBe('server')
    expect(routeFor('server', true)).toBe('server')
  })
})

describe('call log rows', () => {
  const log = (over: Partial<CallLog> = {}): CallLog => ({
    from: 'alice',
    answered_at: 100,
    ended_at: 825,
    outcome: 'completed',
    p2p: false,
    video: false,
    ...over,
  })

  test('durations read as hours, minutes and seconds', () => {
    expect(shortDuration(725)).toBe('12m 05s')
    expect(shortDuration(45)).toBe('45s')
    expect(shortDuration(0)).toBe('0s')
    expect(shortDuration(3725)).toBe('1h 02m 05s')
    expect(shortDuration(-3)).toBe('0s')
  })

  test('a finished call names its kind, connection, outcome and length', () => {
    expect(callLogInfo(log(), 'bob')).toEqual({
      label: 'Voice call',
      video: false,
      direct: false,
      outcome: 'Call ended',
      duration: '12m 05s',
      alert: false,
    })
    const direct = callLogInfo(log({ p2p: true, video: true }), 'alice')
    expect([direct.label, direct.direct, direct.video]).toEqual(['Video call', true, true])
  })

  test('a missed call is red only for the person who missed it', () => {
    const missed = log({ answered_at: null, outcome: 'missed' })
    const info = callLogInfo(missed, 'bob')
    expect([info.outcome, info.duration, info.alert]).toEqual(['Missed call', null, true])
    expect(callLogInfo(missed, 'alice').alert).toBe(false)
    const declined = callLogInfo(log({ answered_at: null, outcome: 'declined' }), 'bob')
    expect([declined.outcome, declined.alert]).toEqual(['Declined', false])
  })

  test('ringing and live calls have no outcome yet; old logs say just Call', () => {
    const ringing = callLogInfo(log({ answered_at: null, ended_at: null, outcome: null }), 'bob')
    expect([ringing.outcome, ringing.duration]).toEqual([null, null])
    const live = callLogInfo(log({ ended_at: null, outcome: null }), 'bob')
    expect([live.outcome, live.duration]).toEqual([null, null])
    const old = callLogInfo(log({ p2p: undefined, video: null }), 'bob')
    expect([old.label, old.direct]).toEqual(['Call', false])
  })
})

describe('failed P2P mark', () => {
  test('expires after ten minutes', () => {
    expect(recentlyFailed(undefined, 1000)).toBe(false)
    expect(recentlyFailed(1000, 1000 + 599_999)).toBe(true)
    expect(recentlyFailed(1000, 1000 + 600_000)).toBe(false)
  })
})
