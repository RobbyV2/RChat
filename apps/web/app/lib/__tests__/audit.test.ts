import { describe, expect, test } from 'bun:test'
import {
  NO_FILTERS,
  auditQuery,
  dayBound,
  factsOf,
  groupOf,
  permNames,
  sentence,
  sentenceText,
  valueText,
} from '../audit'
import { Perm, type AuditEntry, type UserRef } from '../types'

const user = (username: string, display = username): UserRef => ({
  username,
  display_name: display,
  avatar_kind: 'identicon',
  avatar_color: null,
})

const entry = (over: Partial<AuditEntry>): AuditEntry => ({
  id: 1,
  action: 'member.ban',
  actor: user('alice', 'Alice'),
  staff: false,
  target: {
    kind: 'user',
    id: null,
    name: 'bob',
    user: user('bob', 'Bob'),
    staff: false,
    deleted: false,
  },
  details: {},
  hidden: false,
  created_at: 0,
  ...over,
})

const channelTarget = (name: string | null) => ({
  kind: 'channel',
  id: 5,
  name,
  user: null,
  staff: false,
  deleted: false,
})

describe('audit sentences', () => {
  test('member actions name both sides with the streamer flag', () => {
    expect(sentence(entry({}))).toEqual([
      { text: 'Alice', name: true },
      { text: ' banned ' },
      { text: 'Bob', name: true },
    ])
    expect(sentenceText(entry({ action: 'member.kick' }))).toBe('Alice kicked Bob')
    expect(sentenceText(entry({ action: 'member.admin_grant' }))).toBe('Alice made Bob an admin')
  })

  test('instance staff are never named', () => {
    const parts = sentence(entry({ staff: true, actor: null }))
    expect(parts[0]).toEqual({ text: 'Instance staff' })
    expect(sentenceText(entry({ staff: true, actor: null }))).toBe('Instance staff banned Bob')
  })

  test('staff and deleted accounts are never named', () => {
    const anon = (staff: boolean) => ({
      kind: 'user',
      id: null,
      name: null,
      user: null,
      staff,
      deleted: !staff,
    })
    expect(sentenceText(entry({ target: anon(true) }))).toBe('Alice banned Instance staff')
    expect(sentenceText(entry({ actor: null, target: anon(false) }))).toBe(
      'Deleted user banned Deleted user'
    )
    for (const [subject, who] of [
      [{ kind: 'user', staff: true }, 'Instance staff'],
      [{ kind: 'user', deleted: true }, 'Deleted user'],
    ] as const) {
      const parts = sentence(
        entry({
          action: 'channel.perm_set',
          target: channelTarget('general'),
          details: { subject },
        })
      )
      expect(parts.map(p => p.text).join('')).toBe(`Alice set permissions for ${who} in #general`)
      expect(parts.filter(p => p.name).map(p => p.text)).toEqual(['Alice'])
    }
  })

  test('moving system messages names the new channel', () => {
    const moved = (after: unknown, hidden = false) =>
      sentenceText(
        entry({
          action: 'server.system_messages',
          target: null,
          hidden,
          details: hidden ? {} : { changes: [{ field: 'system_channel', before: null, after }] },
        })
      )
    expect(moved({ id: 4, name: 'lobby', private: false })).toBe(
      'Alice moved system messages to #lobby'
    )
    expect(moved(null)).toBe('Alice moved system messages to the default channel')
    expect(moved(null, true)).toBe('Alice changed the join and leave messages')
  })

  test('a single channel change reads as a sentence', () => {
    const slow = entry({
      action: 'channel.update',
      target: channelTarget('general'),
      details: {
        channel: { id: 5, name: 'general', private: false },
        changes: [{ field: 'slowmode_seconds', before: 0, after: 30 }],
      },
    })
    expect(sentenceText(slow)).toBe('Alice changed slow mode in #general from Off to 30s')
    const both = entry({
      ...slow,
      details: {
        changes: [
          { field: 'slowmode_seconds', before: 0, after: 30 },
          { field: 'topic', before: null, after: 'Hi' },
        ],
      },
    })
    expect(sentenceText(both)).toBe('Alice updated #general')
    const renamed = entry({
      ...slow,
      details: { changes: [{ field: 'name', before: 'old', after: 'new' }] },
    })
    expect(sentenceText(renamed)).toBe('Alice renamed #old to #new')
  })

  test('hidden entries leave the channel out', () => {
    const hidden = entry({
      action: 'message.delete',
      hidden: true,
      target: { kind: 'message', id: 9, name: null, user: null, staff: false, deleted: false },
    })
    expect(sentenceText(hidden)).toBe('Alice deleted a message by someone in a private channel')
  })

  test('messages, roles, access and unknown actions', () => {
    const msg = entry({
      action: 'message.pin',
      target: {
        kind: 'message',
        id: 9,
        name: 'bob',
        user: user('bob', 'Bob'),
        staff: false,
        deleted: false,
      },
      details: { channel: { id: 5, name: 'general', private: false } },
    })
    expect(sentenceText(msg)).toBe('Alice pinned a message by Bob in #general')
    expect(
      sentenceText(entry({ action: 'role.assign', details: { role: { id: 2, name: 'Mods' } } }))
    ).toBe('Alice gave Bob the role "Mods"')
    expect(
      sentenceText(
        entry({
          action: 'access.mode',
          target: null,
          details: { changes: [{ field: 'protected', before: false, after: true }] },
        })
      )
    ).toBe('Alice made the server password protected')
    expect(
      sentenceText(
        entry({
          action: 'access.password_create',
          target: { kind: 'password', id: 3, name: null, user: null, staff: false, deleted: false },
        })
      )
    ).toBe('Alice created an extra password')
    expect(sentenceText(entry({ action: 'member.nope' }))).toBe('Alice did member.nope')
  })
})

describe('audit values and filters', () => {
  test('values read naturally', () => {
    expect(valueText('perms', Perm.Kick | Perm.ViewAuditLog)).toBe('Kick, View audit log')
    expect(permNames(0)).toBe('None')
    expect(valueText('can_send', false)).toBe('Denied')
    expect(valueText('join_messages', true)).toBe('On')
    expect(valueText('topic', null)).toBe('No topic')
    expect(valueText('system_channel', { id: 1, name: 'general' })).toBe('#general')
    expect(valueText('kind', 'voice')).toBe('Voice')
    expect(factsOf(entry({ details: { was_member: true, channel: {} } }))).toEqual([
      ['Was a member', 'On'],
    ])
  })

  test('groups come from the action name', () => {
    expect(groupOf('channel.category_create')).toBe('channel')
    expect(groupOf('webhook.create')).toBeNull()
  })

  test('filters become query parameters', () => {
    expect(auditQuery(NO_FILTERS)).toEqual({})
    const from = dayBound('2026-10-01', false)
    const to = dayBound('2026-10-01', true)
    expect(from === null).toBe(false)
    expect((to ?? 0) - (from ?? 0) + 1 >= 82800).toBe(true)
    expect(dayBound('nope', false)).toBeNull()
    expect(
      auditQuery({ group: 'role', actor: ' Bob ', target: ' gen ', from: '2026-10-01', to: '' })
    ).toEqual({ action: 'role', actor: 'bob', target: 'gen', from: String(from) })
  })
})

describe('timeout entries', () => {
  test('sentences say what happened and for how long', () => {
    const set = (details: Record<string, unknown>) =>
      sentenceText(entry({ action: 'member.timeout', details }))
    expect(set({ duration: 600, changes: [{ field: 'until', before: null, after: 9 }] })).toBe(
      'Alice timed out Bob for 10 minutes'
    )
    expect(set({ duration: 86400, changes: [{ field: 'until', before: 5, after: 9 }] })).toBe(
      'Alice changed the timeout of Bob to 1 day'
    )
    expect(set({})).toBe('Alice timed out Bob')
    expect(sentenceText(entry({ action: 'member.untimeout' }))).toBe(
      'Alice removed the timeout of Bob'
    )
    expect(sentenceText(entry({ action: 'member.timeout', staff: true, actor: null }))).toBe(
      'Instance staff timed out Bob'
    )
  })

  test('details show the duration, time left and reason', () => {
    const e = entry({
      action: 'member.untimeout',
      details: { remaining: 3599, reason: 'spam', changes: [] },
    })
    expect(factsOf(e)).toEqual([
      ['Time left', '59 minutes 59 seconds'],
      ['Reason', 'spam'],
    ])
    expect(
      factsOf(entry({ action: 'member.timeout', details: { duration: 90, reason: null } }))
    ).toEqual([
      ['Duration', '1 minute 30 seconds'],
      ['Reason', 'None'],
    ])
    expect(valueText('until', null)).toBe('Not timed out')
    expect(valueText('until', 0)).toBe(new Date(0).toLocaleString())
  })
})
