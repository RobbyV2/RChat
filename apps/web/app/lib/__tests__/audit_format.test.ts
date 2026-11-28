import { notAName } from '../names'
import { beforeAll, describe, expect, test } from 'bun:test'
import {
  REASON_MAX,
  RUN_MS,
  bitNames,
  diffFacts,
  diffOf,
  logLines,
  permsDiffOf,
  reasonField,
  reasonOf,
  type LogEvent,
  type LogNames,
} from '../audit_format'
import { factsOf } from '../audit'
import { reasonHeader } from '../api'
import { permItems } from '../perm_source'
import { HOSTED } from '../perms'
import { P } from '../p2p/acl/rules'
import type { AuditEntry } from '../types'
import { Perm } from '../types'
import { loadPerms } from './helpers/perms'

beforeAll(() => loadPerms())

describe('reasons', () => {
  test('a reason is text, trimmed and cut to its limit; anything else is none', () => {
    expect(reasonOf('  spam links  ')).toBe('spam links')
    expect(reasonOf('tab\there\nline')).toBe('tab here line')
    expect(reasonOf('half \ud800 of one')).toBe('half \ufffd of one')
    expect(reasonOf('   ')).toBeNull()
    expect(reasonOf(42)).toBeNull()
    expect(reasonOf(undefined)).toBeNull()
    expect(reasonOf({ text: 'x' })).toBeNull()
    expect(reasonOf('\u{1F600}'.repeat(REASON_MAX + 5))).toBe('\u{1F600}'.repeat(REASON_MAX))
    expect(reasonOf('abcdef', 3)).toBe('abc')
    expect(reasonField(' why ')).toEqual({ reason: 'why' })
    expect(reasonField('')).toEqual({})
    expect(reasonField(undefined)).toEqual({})
    expect(reasonHeader('  spam\tlinks, again ')).toEqual({
      'X-Audit-Reason': 'spam%20links%2C%20again',
    })
    expect(reasonHeader('  ')).toEqual({})
    expect(reasonHeader(undefined)).toEqual({})
  })
})

describe('permission diffs', () => {
  test('a change names what it turns on and off', () => {
    const items = permItems(HOSTED)
    expect(diffOf(Perm.Kick, Perm.Kick + Perm.ManageRoles, items)).toEqual({
      added: ['Manage roles'],
      removed: [],
    })
    expect(diffOf(Perm.Kick + Perm.PinMessages, 0n, items).removed).toEqual([
      'Kick and ban',
      'Pin messages',
    ])
    expect(bitNames(0n, items)).toEqual([])
  })

  test('a stored diff is read defensively', () => {
    expect(permsDiffOf({ added: ['Kick'], removed: ['Unknown'] }, permItems(HOSTED))).toEqual({
      added: ['Kick and ban'],
      removed: ['Unknown'],
    })
    expect(permsDiffOf({ added: ['A', 7, null], removed: 'B' })).toEqual({
      added: ['A'],
      removed: [],
    })
    expect(permsDiffOf(null)).toBeNull()
    expect(permsDiffOf([])).toBeNull()
    expect(permsDiffOf({ other: 1 })).toBeNull()
    expect(diffFacts({ added: ['A', 'B'], removed: [] })).toEqual([['Permissions added', 'A, B']])
    expect(diffFacts({ added: [], removed: ['C'] })).toEqual([['Permissions removed', 'C']])
  })

  test('hosted entries show their reason and their permission diff', () => {
    const entry = {
      id: 1,
      action: 'role.update',
      actor: { username: 'alice', display_name: 'alice' },
      staff: false,
      created_at: 0,
      target: { kind: 'role', id: 3, name: 'Mods' },
      details: {
        changes: [{ field: 'perms', before: 0, after: 16388 }],
        perms_diff: { added: ['Kick', 'ManageRoles'], removed: [] },
        reason: 'Mods moderate',
      },
    } as unknown as AuditEntry
    expect(factsOf(entry)).toEqual([
      ['Reason', 'Mods moderate'],
      ['Permissions added', 'Kick and ban, Manage roles'],
    ])
  })
})

const names: LogNames = {
  member: ik => notAName({ IK_B: 'bob', IK_A: 'alice' }[ik] ?? 'someone'),
  role: id => ({ R1: 'Mods', R3: 'Greeters' })[id] ?? null,
  channel: id => ({ c1: '#general', k1: 'Team' })[id] ?? null,
  text: t => t.replace('darn', '****'),
  items: permItems(4),
}

let n = 0
const ev = (
  t: string,
  c: Record<string, unknown>,
  a = 'IK_A',
  more: Partial<LogEvent> = {}
): LogEvent => ({
  id: `e${++n}`,
  t,
  a,
  at: 1000 + n,
  c,
  aseq: n,
  ...more,
})

describe('the P2P moderation log', () => {
  test('each line says what was done, to whom, why and what changed', () => {
    const lines = logLines(
      [
        ev('kick', { to: 'IK_B', reason: '  spam\tlinks  ' }),
        ev('assign', { to: 'IK_B', role: 'R1', reason: 7 }),
        ev('chperm', { ch: 'c1', subj: 'u:IK_B', allow: P.ViewChannel, deny: P.SendMessages }),
        ev('chperm', { ch: 'k1', subj: 'r:everyone', allow: 0, deny: 0 }),
        ev('role_create', { pos: 5, bits: 0, name: 'darn crew', reason: 'helpers' }),
        ev('role_del', { role: 'R9' }),
        ev('channel', { id: 'c9', name: 'darn talk' }),
        ev('category', { id: 'k1', name: 'Old name' }),
        ev('chcat', { ch: 'c1', cat: 'k1', sync: true }),
        ev('chcat', { ch: 'c1', cat: null, sync: false }, 'IK_B'),
      ],
      names
    )
    expect(lines.map(l => [l.act, l.target, l.targetKind, l.reason, l.facts])).toEqual([
      ['Kick', 'bob', 'member', 'spam links', []],
      ['Give a role to', 'bob', 'member', null, [['Role', 'Mods']]],
      [
        'Change who may use a channel',
        '#general',
        'channel',
        null,
        [
          ['For', 'bob'],
          ['Allowed', 'View channels'],
          ['Denied', 'Send messages'],
        ],
      ],
      [
        'Change who may use a channel',
        'Team',
        'channel',
        null,
        [
          ['For', '@everyone'],
          ['Rule', 'Removed'],
        ],
      ],
      ['Make a role', '**** crew', 'role', 'helpers', []],
      ['Delete a role', 'Deleted role', 'role', null, []],
      ['Change a channel', '#**** talk', 'channel', null, []],
      ['Change a category', 'Team', 'channel', null, []],
      ['Move a channel to a category', '#general', 'channel', null, [['Category', 'Team']]],
      ['Move a channel to a category', '#general', 'channel', null, [['Category', 'None']]],
    ])
  })

  test('changes of one role by one author close together read as one, by what they leave', () => {
    const lines = logLines(
      [
        ev('role_bits', { role: 'R1', bit: P.Ban, on: false }),
        ev('role_bits', { role: 'R1', bit: P.Kick, on: true, reason: 'moderators kick' }),
        ev('role_bits', { role: 'R1', bit: P.Ban, on: true, reason: 'and ban' }),
        ev('role_bits', { role: 'R1', bit: P.ManageRoles, on: false }),
        ev('role_bits', { role: 'everyone', bit: P.SendMessages, on: false }),
        ev('role_bits', { role: 'R1', bit: P.Kick, on: true }, 'IK_B'),
        ev('role_bits', { role: 'R1', bit: P.Kick, on: false }, 'IK_B', { at: -RUN_MS }),
      ],
      names
    )
    expect(lines.map(l => [l.target, l.facts, l.run, l.reason])).toEqual([
      [
        'Mods',
        [
          ['Permissions added', 'Kick'],
          ['Permissions removed', 'Manage roles'],
        ],
        4,
        'moderators kick; and ban',
      ],
      ['@everyone', [['Permissions removed', 'Send messages']], 1, null],
      ['Mods', [['Permissions added', 'Kick']], 1, null],
      ['Mods', [['Permissions removed', 'Kick']], 1, null],
    ])
  })

  test('moves of roles read as the roles whose places changed', () => {
    const order = (before: string[], after: string[]) => ({ order: { before, after } })
    const lines = logLines(
      [
        ev(
          'role_move',
          { role: 'R2', pos: 4 },
          'IK_A',
          order(['R1', 'R3', 'R2'], ['R1', 'R3', 'R2'])
        ),
        ev(
          'role_move',
          { role: 'R3', pos: 2 },
          'IK_A',
          order(['R3', 'R1', 'R2'], ['R1', 'R3', 'R2'])
        ),
        ev(
          'role_move',
          { role: 'R1', pos: 9 },
          'IK_A',
          order(['R3', 'R1', 'R2'], ['R3', 'R1', 'R2'])
        ),
      ],
      names
    )
    expect(lines.map(l => [l.act, l.target, l.facts, l.run])).toEqual([
      ['Move a role', 'Greeters', [], 3],
    ])
    const [one] = logLines(
      [
        ev(
          'role_move',
          { role: 'R2', pos: 1 },
          'IK_A',
          order(['R2', 'R1', 'R3'], ['R1', 'R3', 'R2'])
        ),
      ],
      names
    )
    expect([one.target, one.facts]).toEqual(['Deleted role', []])
    const [two] = logLines(
      [ev('role_move', { role: 'R1', pos: 1 }, 'IK_A', order(['R1', 'R3'], ['R3', 'R1']))],
      names
    )
    expect(two.target).toBe('Mods')
  })

  test('a rule written to a category and the channels that copy it reads as one line', () => {
    const rule = { subj: 'r:R1', allow: P.ViewChannel, deny: 0 }
    const lines = logLines(
      [
        ev('chperm', { ch: 'c2', ...rule }),
        ev('chperm', { ch: 'c1', ...rule }),
        ev('chperm', { ch: 'k1', ...rule, reason: 'team only' }),
        ev('chperm', { ch: 'k1', subj: 'r:R1', allow: 0, deny: 0 }),
      ],
      names
    )
    expect(lines.map(l => [l.target, l.reason, l.facts, l.run])).toEqual([
      [
        'Team',
        'team only',
        [
          ['For', 'Mods'],
          ['Allowed', 'View channels'],
          ['Also in', '2 more channels'],
        ],
        3,
      ],
      [
        'Team',
        null,
        [
          ['For', 'Mods'],
          ['Rule', 'Removed'],
        ],
        1,
      ],
    ])
  })

  test('timeouts and bans that end say for how long, where the room reads them', () => {
    const at = 1_000_000
    const timed = { ...names, timed: true }
    const line = (t: string, c: Record<string, unknown>, n: LogNames = timed) => {
      const [l] = logLines([ev(t, { to: 'IK_B', ...c }, 'IK_A', { at })], n)
      return [l.act, l.target, l.facts, l.reason]
    }
    expect(line('timeout', { until: at + 600_000, reason: 'spam' })).toEqual([
      'Time out',
      'bob',
      [['For', '10 minutes']],
      'spam',
    ])
    expect(line('timeout', { until: at + 99 * 86_400_000 })).toEqual([
      'Time out',
      'bob',
      [['For', '28 days']],
      null,
    ])
    expect(line('timeout', { until: at })).toEqual(['Remove the timeout of', 'bob', [], null])
    expect(line('ban', { until: at + 3_600_000 })).toEqual([
      'Ban',
      'bob',
      [['For', '1 hour']],
      null,
    ])
    expect(line('ban', {})).toEqual(['Ban', 'bob', [], null])
    expect(line('ban', { until: 'soon' })).toEqual(['Ban', 'bob', [], null])
    expect(line('ban', { until: at + 3_600_000 }, names)).toEqual(['Ban', 'bob', [], null])
  })

  test('events out of force say so, and a reason longer than this device shows is cut', () => {
    const [line] = logLines(
      [ev('ban', { to: 'IK_B', reason: 'x'.repeat(50) }, 'IK_A', { undone: true })],
      { ...names, reasonMax: 10 }
    )
    expect([line.reason, line.undone]).toEqual(['x'.repeat(10), true])
  })
})
