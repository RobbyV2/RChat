import { describe, expect, test } from 'bun:test'
import {
  FILTERS,
  SERVICE_FILTERS,
  attentionCount,
  attentionLabel,
  filterCounts,
  keyLabel,
  localNotice,
  matches,
  needsAttention,
  shortKid,
  sortRows,
  stateChip,
  trustChoices,
  trustConfirm,
  type HostKey,
  type HostRow,
  type LinkState,
} from '../fed/admin'

const NOW = 1_800_000_000

const row = (host: string, state: LinkState, over: Partial<HostRow> = {}): HostRow => ({
  host,
  name: null,
  version: '0.9.0',
  state,
  notice: '',
  last_contact: NOW,
  calls_in: 0,
  calls_out: 0,
  ours_old: false,
  services: ['letters', 'invites', 'profiles', 'reports', 'directory'],
  ...over,
})

const STATES: LinkState[] = [
  'unknown',
  'ok',
  'degraded',
  'unreachable',
  'refused_by_them',
  'paused',
  'halted',
  'version',
  'unsupported',
  'identity',
  'blocked',
]

describe('the list filters', () => {
  test('the chips are the ones of the page, in order', () => {
    expect(FILTERS.map(f => f.label)).toEqual([
      'All',
      'Needs attention',
      'Blocked',
      'Halted',
      'Paused',
      'Version',
      'Unreachable',
      'Unsupported',
    ])
    expect(SERVICE_FILTERS.map(f => f.label)).toEqual([
      'All',
      'Letters',
      'Invites',
      'Profiles',
      'Reports',
      'Directory',
    ])
  })

  test('a host needs attention for identity, halted, paused, or a version where this instance is the old one', () => {
    expect(STATES.filter(state => needsAttention(row('h', state)))).toEqual([
      'paused',
      'halted',
      'identity',
    ])
    expect(needsAttention(row('h', 'version', { ours_old: true }))).toBe(true)
    expect(needsAttention(row('h', 'ok', { ours_old: true }))).toBe(false)
  })

  test('each chip keeps its own states, and the service filter keeps hosts that speak it', () => {
    const rows = [
      row('a.example', 'ok'),
      row('b.example', 'halted'),
      row('c.example', 'paused', { services: ['letters'] }),
      row('d.example', 'version', { ours_old: true }),
      row('e.example', 'version'),
      row('f.example', 'blocked'),
      row('g.example', 'unreachable'),
      row('h.example', 'unsupported', { services: [] }),
      row('i.example', 'identity'),
    ]
    const hosts = (
      filter: Parameters<typeof matches>[1],
      service?: Parameters<typeof matches>[2]
    ) => rows.filter(r => matches(r, filter, service)).map(r => r.host[0])
    expect(hosts('all')).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'])
    expect(hosts('attention')).toEqual(['b', 'c', 'd', 'i'])
    expect(hosts('blocked')).toEqual(['f'])
    expect(hosts('halted')).toEqual(['b'])
    expect(hosts('paused')).toEqual(['c'])
    expect(hosts('version')).toEqual(['d', 'e'])
    expect(hosts('unreachable')).toEqual(['g'])
    expect(hosts('unsupported')).toEqual(['h'])
    expect(hosts('all', 'invites')).toEqual(['a', 'b', 'd', 'e', 'f', 'g', 'i'])
    expect(hosts('attention', 'letters')).toEqual(['b', 'c', 'd', 'i'])
    expect(hosts('attention', 'invites')).toEqual(['b', 'd', 'i'])
    expect(filterCounts(rows)).toEqual({
      all: 9,
      attention: 4,
      blocked: 1,
      halted: 1,
      paused: 1,
      version: 2,
      unreachable: 1,
      unsupported: 1,
    })
    expect(filterCounts([])).toEqual({
      all: 0,
      attention: 0,
      blocked: 0,
      halted: 0,
      paused: 0,
      version: 0,
      unreachable: 0,
      unsupported: 0,
    })
  })

  test('hosts that need attention come first, then the latest contact, then the name', () => {
    const rows = [
      row('old.example', 'ok', { last_contact: NOW - 500 }),
      row('never.example', 'unknown', { last_contact: null }),
      row('b.example', 'ok', { last_contact: NOW }),
      row('a.example', 'ok', { last_contact: NOW }),
      row('paused.example', 'paused', { last_contact: NOW - 900 }),
      row('identity.example', 'identity', { last_contact: NOW - 100 }),
    ]
    const before = rows.map(r => r.host)
    expect(sortRows(rows).map(r => r.host)).toEqual([
      'identity.example',
      'paused.example',
      'a.example',
      'b.example',
      'old.example',
      'never.example',
    ])
    expect(rows.map(r => r.host)).toEqual(before)
  })

  test('the nav badge counts what needs attention and says it in words', () => {
    const counts = {
      blocked: 4,
      identity: 1,
      version: 5,
      halted: 2,
      paused: 3,
      refused_by_them: 7,
      unreachable: 8,
      degraded: 9,
    }
    expect(attentionCount(counts)).toBe(6)
    expect(attentionCount({ ...counts, version_ours_old: 2 })).toBe(8)
    expect(attentionCount({})).toBe(0)
    expect(attentionLabel(0)).toBeNull()
    expect(attentionLabel(1)).toBe('1 instance needs attention')
    expect(attentionLabel(6)).toBe('6 instances need attention')
  })
})

describe('state chips', () => {
  test('every state has its words and one of the four tones', () => {
    expect(STATES.map(state => stateChip(state).label)).toEqual([
      'Unknown',
      'OK',
      'Degraded',
      'Unreachable',
      'Refused by them',
      'Paused',
      'Halted',
      'Version',
      'Unsupported',
      'Identity',
      'Blocked',
    ])
    const tone = (state: LinkState) => stateChip(state).tone
    for (const state of ['blocked', 'identity', 'halted'] as const)
      expect(tone(state)).toBe('bg-error-container text-on-error-container')
    for (const state of ['paused', 'version'] as const)
      expect(tone(state)).toBe('bg-tertiary-container text-on-tertiary-container')
    for (const state of ['unsupported', 'unknown'] as const)
      expect(tone(state)).toBe('bg-surface-container-high text-on-surface-variant')
    expect(tone('ok')).toBe('bg-secondary-container text-on-secondary-container')
    expect(new Set(STATES.map(tone)).size).toBe(4)
  })
})

describe('notices in the admin time zone', () => {
  test('every UTC time in a notice is shown in local time', () => {
    const notice =
      'chat.b.example sent malformed calls for letters. Calls from it are paused until 01/15 09:00 UTC.'
    expect(localNotice(notice, NOW, 'America/New_York')).toBe(
      'chat.b.example sent malformed calls for letters. Calls from it are paused until 01/15 04:00.'
    )
    expect(localNotice(notice, NOW, 'Asia/Kolkata')).toBe(
      'chat.b.example sent malformed calls for letters. Calls from it are paused until 01/15 14:30.'
    )
    expect(localNotice(notice, NOW, 'UTC')).toBe(
      'chat.b.example sent malformed calls for letters. Calls from it are paused until 01/15 09:00.'
    )
  })

  test('a time crosses the day and the year with the zone', () => {
    expect(localNotice('Blocked by you on 01/15 02:30 UTC.', NOW, 'America/Los_Angeles')).toBe(
      'Blocked by you on 01/14 18:30.'
    )
    const newYear = Date.UTC(2027, 0, 1, 0, 30) / 1000
    expect(localNotice('Next try at 12/31 23:50 UTC.', newYear, 'UTC')).toBe(
      'Next try at 12/31 23:50.'
    )
    expect(localNotice('Next try at 01/01 00:40 UTC.', newYear - 3600, 'Asia/Tokyo')).toBe(
      'Next try at 01/01 09:40.'
    )
    expect(localNotice('Since 02/29 12:00 UTC.', Date.UTC(2028, 2, 1) / 1000, 'UTC')).toBe(
      'Since 02/29 12:00.'
    )
  })

  test('two times in one notice both change, and text without a time is left alone', () => {
    expect(localNotice('From 01/15 08:00 UTC until 01/15 21:40 UTC.', NOW, 'Europe/Berlin')).toBe(
      'From 01/15 09:00 until 01/15 22:40.'
    )
    const plain = "chat.b.example doesn't offer invite previews."
    expect(localNotice(plain, NOW, 'Europe/Berlin')).toBe(plain)
    expect(localNotice('', NOW, 'Europe/Berlin')).toBe('')
    expect(localNotice('Odd 13/45 99:99 UTC.', NOW, 'UTC')).toBe('Odd 13/45 99:99 UTC.')
  })
})

describe('keys', () => {
  const key = (kid: string, state: HostKey['state'], over: Partial<HostKey> = {}): HostKey => ({
    kid,
    first_seen: NOW - 86_400,
    last_seen: NOW,
    call_key: state === 'current',
    state,
    proven: true,
    was: null,
    proven_hello_at: null,
    retired_at: null,
    ...over,
  })
  const KID = 'Qa71mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm0vT'

  test('a key is current, kept for old seals, retired or pending', () => {
    expect(keyLabel(key('k', 'current'))).toBe('Current')
    expect(keyLabel(key('k', 'seal_only'))).toBe('Old seals only')
    expect(keyLabel(key('k', 'retired'))).toBe('Retired')
    expect(keyLabel(key('k', 'pending'))).toBe('Pending')
  })

  test('a thumbprint is shortened to its ends', () => {
    expect(shortKid(KID)).toBe('Qa71...0vT')
    expect(shortKid('short')).toBe('short')
  })

  test('the Trust picker lists only pending keys, those that signed a checked Hello in the last hour first', () => {
    const keys = [
      key('kCurrent', 'current'),
      key('kRetired', 'retired'),
      key('kOldPending', 'pending', {
        first_seen: NOW - 500,
        was: 'retired',
        retired_at: NOW - 9000,
      }),
      key('kStale', 'pending', { first_seen: NOW - 50, proven_hello_at: NOW - 3601 }),
      key('kFresh', 'pending', { first_seen: NOW - 300, proven_hello_at: NOW - 3600 }),
      key('kSeal', 'pending', {
        first_seen: NOW - 200,
        was: 'seal_only',
        proven_hello_at: NOW - 10,
      }),
    ]
    expect(trustChoices(keys, NOW)).toEqual([
      {
        kid: 'kSeal',
        short: 'kSeal',
        first_seen: NOW - 200,
        kind: 'seal_only',
        signed: true,
        retired_at: null,
      },
      {
        kid: 'kFresh',
        short: 'kFresh',
        first_seen: NOW - 300,
        kind: 'new',
        signed: true,
        retired_at: null,
      },
      {
        kid: 'kStale',
        short: 'kStale',
        first_seen: NOW - 50,
        kind: 'new',
        signed: false,
        retired_at: null,
      },
      {
        kid: 'kOldPending',
        short: 'kOld...ing',
        first_seen: NOW - 500,
        kind: 'retired',
        signed: false,
        retired_at: NOW - 9000,
      },
    ])
    expect(trustChoices([key('kCurrent', 'current')], NOW)).toEqual([])
  })

  test('the confirmation names the host twice over and says when a key is re-admitted', () => {
    const [choice] = trustChoices([key(KID, 'pending', { proven_hello_at: NOW })], NOW)
    expect(trustConfirm('chat.b.example', choice, 'UTC')).toEqual({
      title: 'Trust the new key of chat.b.example?',
      line: 'chat.b.example signed its answer with Qa71...0vT just now.',
    })
    const [unsigned] = trustChoices([key(KID, 'pending')], NOW)
    expect(trustConfirm('chat.b.example', unsigned, 'UTC').line).toBe(
      "Qa71...0vT hasn't signed an answer from chat.b.example in the last hour. chat.b.example is asked again first."
    )
    const retiredAt = Date.UTC(2027, 2, 4, 12) / 1000
    const [retired] = trustChoices(
      [key(KID, 'pending', { was: 'retired', retired_at: retiredAt, proven_hello_at: NOW })],
      NOW
    )
    expect(trustConfirm('chat.b.example', retired, 'UTC')).toEqual({
      title: 'Trust the new key of chat.b.example?',
      line: 'Re-admit Qa71...0vT, a key chat.b.example retired on 03/04.',
    })
    const [undated] = trustChoices(
      [key(KID, 'pending', { was: 'retired', proven_hello_at: NOW })],
      NOW
    )
    expect(trustConfirm('chat.b.example', undated, 'UTC').line).toBe(
      'Re-admit Qa71...0vT, a key chat.b.example retired.'
    )
    const [seal] = trustChoices(
      [key(KID, 'pending', { was: 'seal_only', proven_hello_at: NOW })],
      NOW
    )
    expect(trustConfirm('chat.b.example', seal, 'UTC').line).toBe(
      'Re-admit Qa71...0vT, a key chat.b.example only published for old seals.'
    )
  })
})
