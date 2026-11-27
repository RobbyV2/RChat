import { describe, expect, test } from 'bun:test'
import {
  NO_FILTERS,
  auditQuery,
  dayBound,
  factsOf,
  fieldLabel,
  groupOf,
  isNameValue,
  peopleIn,
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
      { text: 'Alice', name: true, by: 'alice', person: true },
      { text: ' banned ' },
      { text: 'Bob', name: true, by: 'bob', person: true },
    ])
    expect(sentenceText(entry({ action: 'member.kick' }))).toBe('Alice kicked Bob')
    expect(sentenceText(entry({ action: 'member.unban' }))).toBe('Alice unbanned Bob')
    expect(
      sentenceText(entry({ action: 'member.unban', actor: null, details: { expired: true } }))
    ).toBe('The ban of Bob ended')
    expect(sentenceText(entry({ action: 'member.admin_grant' }))).toBe('Alice made Bob an admin')
  })

  test("a person's name carries their username, so your own is never masked", () => {
    const rule = sentence(
      entry({
        action: 'channel.perm_set',
        target: channelTarget('general'),
        details: { subject: { kind: 'user', name: 'carol' } },
      })
    )
    expect(rule.filter(p => p.name)).toEqual([
      { text: 'Alice', name: true, by: 'alice', person: true },
      { text: 'carol', name: true, by: 'carol', person: true },
    ])
    const renamed = sentence(
      entry({
        action: 'server.update',
        target: null,
        details: { changes: [{ field: 'name', before: 'old', after: 'new' }] },
      })
    )
    expect(renamed.filter(p => p.name)).toEqual([
      { text: 'Alice', name: true, by: 'alice', person: true },
      { text: 'new', name: true },
    ])
  })

  test('the people entries name are looked up once each, never a name someone had', () => {
    const entries = [
      entry({}),
      entry({ action: 'member.kick' }),
      entry({
        action: 'channel.perm_set',
        target: channelTarget('general'),
        details: { subject: { kind: 'user', name: 'carol' } },
      }),
      entry({ action: 'member.profile_reset', details: { fields: ['name'], old_name: 'Robert' } }),
      entry({
        staff: true,
        actor: null,
        target: { kind: 'user', id: null, name: 'dave', user: null, staff: false, deleted: false },
      }),
    ]
    expect(peopleIn(entries)).toEqual(['alice', 'bob', 'carol'])
    expect(peopleIn([entry({ hidden: true, actor: null })])).toEqual([])
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

  test('bulk deletes give the count, the authors and the thread', () => {
    const bulk = entry({
      action: 'message.bulk_delete',
      target: channelTarget('general'),
      details: {
        channel: { id: 1, name: 'general', private: false },
        count: 3,
        total: 37,
        authors: [
          { name: 'bob', count: 2 },
          { deleted: true, count: 1 },
        ],
        more_authors: 0,
      },
    })
    expect(sentenceText(bulk)).toBe('Alice deleted 37 messages in #general')
    expect(factsOf(bulk)).toEqual([
      ['Messages deleted', '37'],
      ["Other people's messages", '3'],
      ['Authors', 'bob (2), Deleted user (1)'],
    ])
    const thread = entry({
      ...bulk,
      details: { ...bulk.details, total: 1, thread: true, more_authors: 4 },
    })
    expect(sentenceText(thread)).toBe('Alice deleted 1 message from a thread in #general')
    expect(factsOf(thread).at(-1)).toEqual(['More authors', '4'])
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
    expect(sentenceText({ ...msg, action: 'message.poll_close' })).toBe(
      'Alice closed a poll by Bob in #general'
    )
    expect(sentenceText({ ...msg, action: 'message.poll_reopen' })).toBe(
      'Alice reopened a poll by Bob in #general'
    )
    expect(
      sentenceText(entry({ action: 'role.assign', details: { role: { id: 2, name: 'Mods' } } }))
    ).toBe('Alice gave Bob the role "Mods"')
    const shown = entry({
      action: 'role.display_order',
      target: null,
      details: { roles: [{ id: 2, name: 'Mods' }], more_roles: 0, follow: false },
    })
    expect(sentenceText(shown)).toBe('Alice changed the order roles show in')
    expect(sentenceText({ ...shown, details: { ...shown.details, follow: true } })).toBe(
      'Alice showed the roles in role order'
    )
    expect(factsOf(shown)).toEqual([['Roles moved', 'Mods']])
    expect(['icon', 'hoist', 'color_names'].map(fieldLabel)).toEqual([
      'Icon',
      'Show members separately',
      'Color member names',
    ])
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

describe('join audit sentences', () => {
  const password = (name: string | null) => ({
    kind: 'password',
    id: 41,
    name,
    user: null,
    staff: false,
    deleted: false,
  })

  test('joins name the link or password by its label and number, never its code', () => {
    const join = (kind: string, name: string | null) =>
      sentenceText(entry({ action: 'member.join', target: password(name), details: { kind } }))
    expect(join('standing', null)).toBe('Alice joined with the invite link (#41)')
    expect(join('link', 'Friends')).toBe('Alice joined with the link "Friends" (#41)')
    expect(join('link', null)).toBe('Alice joined with a link (#41)')
    expect(join('password', 'Friends')).toBe('Alice joined with the extra password "Friends" (#41)')
    expect(join('password', null)).toBe('Alice joined with an extra password (#41)')
  })

  test('a change of how people join says the new way', () => {
    const mode = (before: string, after: string) =>
      sentenceText(
        entry({
          action: 'access.mode',
          target: null,
          details: {
            changes: [
              { field: 'join_mode', before, after },
              { field: 'protected', before: before !== 'name', after: after !== 'name' },
            ],
          },
        })
      )
    expect(mode('invite', 'name')).toBe('Alice let anyone join with the server name')
    expect(mode('name', 'invite')).toBe('Alice made the server invite only')
    expect(mode('invite', 'password')).toBe('Alice made the server need a password to join')
    expect(mode('invite', 'closed')).toBe('Alice closed the server to new members')
    expect(groupOf('member.join')).toBe('member')
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

  test('webhook changes say when the actor became the owner', () => {
    const hook = {
      kind: 'webhook',
      id: 3,
      name: 'Deploys',
      user: null,
      staff: false,
      deleted: false,
    }
    const owner = { changes: [{ field: 'owner', before: 'bob', after: 'alice' }] }
    expect(
      sentenceText(entry({ action: 'webhook.token_reset', target: hook, details: owner }))
    ).toBe('Alice reset the URL of the webhook "Deploys" and became its owner')
    expect(sentenceText(entry({ action: 'webhook.token_reset', target: hook }))).toBe(
      'Alice reset the URL of the webhook "Deploys"'
    )
    expect(
      sentenceText(entry({ action: 'webhook.outgoing_update', target: hook, details: owner }))
    ).toBe('Alice updated the outgoing webhook "Deploys" and became its owner')
    expect(isNameValue(entry({ action: 'webhook.outgoing_update' }), 'owner')).toBe(true)
  })

  test('groups come from the action name', () => {
    expect(groupOf('channel.category_create')).toBe('channel')
    expect(groupOf('webhook.create')).toBe('webhook')
    expect(groupOf('bot.create')).toBeNull()
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

describe('guest voice entries', () => {
  const guest = (action: string) =>
    entry({
      action,
      target: {
        kind: 'guest',
        id: null,
        name: '@guest:3f9a1c2b00000000',
        user: null,
        staff: false,
        deleted: false,
      },
      details: { channel: { id: 5, name: 'talk', private: false } },
    })

  test('sentences name the guest as the voice grid does, and the channel', () => {
    expect(sentenceText(guest('member.voice_disconnect'))).toBe(
      'Alice disconnected Guest 3f9a from voice in #talk'
    )
    expect(sentenceText(guest('member.voice_mute'))).toBe(
      'Alice muted Guest 3f9a for everyone in #talk'
    )
    expect(sentenceText(guest('member.voice_unmute'))).toBe('Alice unmuted Guest 3f9a in #talk')
    expect(sentence(guest('member.voice_mute'))[2]).toEqual({ text: 'Guest 3f9a' })
    expect(groupOf('member.voice_disconnect')).toBe('member')
  })
})

describe('the guest voice option', () => {
  test('a change says whether guests may use voice', () => {
    const turned = (before: string, after: string) =>
      sentenceText(
        entry({
          action: 'server.update',
          target: {
            kind: 'server',
            id: null,
            name: 'Club',
            user: null,
            staff: false,
            deleted: false,
          },
          details: { changes: [{ field: 'guest_voice', before, after }] },
        })
      )
    expect(turned('on', 'off')).toBe('Alice turned voice off for guests')
    expect(turned('off', 'on')).toBe('Alice turned voice on for guests')
    expect(fieldLabel('guest_voice')).toBe('Guests can use voice')
  })
})

describe('the member privacy option', () => {
  test('a change says who sees the members', () => {
    const turned = (before: boolean, after: boolean) =>
      sentenceText(
        entry({
          action: 'server.update',
          target: {
            kind: 'server',
            id: null,
            name: 'Club',
            user: null,
            staff: false,
            deleted: false,
          },
          details: { changes: [{ field: 'members_visible', before, after }] },
        })
      )
    expect(turned(true, false)).toBe('Alice hid the members from people outside the server')
    expect(turned(false, true)).toBe('Alice showed the members to people outside the server')
    expect(fieldLabel('members_visible')).toBe('Members can be seen by people outside this server')
  })

  test('server profiles: the mode a server sets, and the names members give themselves', () => {
    const mode = (before: string, after: string) =>
      sentenceText(
        entry({
          action: 'server.update',
          details: { changes: [{ field: 'profiles_mode', before, after }] },
        })
      )
    expect(mode('all', 'no_names')).toBe('Alice set server profiles to everything but names')
    expect(mode('no_names', 'off')).toBe('Alice set server profiles to off')
    expect(fieldLabel('profiles_mode')).toBe('Server profiles')
    expect(['all', 'no_names', 'off'].map(v => valueText('profiles_mode', v))).toEqual([
      'Everything',
      'Everything but names',
      'Off',
    ])
    const named = (old: string | null, next: string | null) =>
      entry({
        action: 'member.profile_name',
        target: {
          kind: 'user',
          id: null,
          name: 'alice',
          user: user('alice', 'Alice'),
          staff: false,
          deleted: false,
        },
        details: { old, new: next },
      })
    expect(sentence(named('Ali', 'Al'))).toEqual([
      { text: 'Alice', name: true, by: 'alice', person: true },
      { text: ' changed their server name from ' },
      { text: 'Ali', name: true, by: 'alice' },
      { text: ' to ' },
      { text: 'Al', name: true, by: 'alice' },
    ])
    expect(sentenceText(named(null, 'Ali'))).toBe('Alice set their server name to Ali')
    expect(sentenceText(named('Ali', null))).toBe('Alice removed their server name Ali')
    expect(sentenceText({ ...named('Ali', 'Al'), hidden: true })).toBe(
      'Alice changed their server name'
    )
    expect(factsOf(named('Ali', 'Al'))).toEqual([])
  })

  test('a reset says what was cleared, whose it was and the name that went', () => {
    const target = {
      kind: 'user' as const,
      id: null,
      name: 'bob',
      user: user('bob', 'Bob'),
      staff: false,
      deleted: false,
    }
    const reset = (details: Record<string, unknown>) =>
      entry({ action: 'member.profile_reset', target, details })
    expect(
      sentence(reset({ fields: ['name', 'avatar'], old_name: 'Robert', lock_until: null }))
    ).toEqual([
      { text: 'Alice', name: true, by: 'alice', person: true },
      { text: ' reset the server name and avatar of ' },
      { text: 'Bob', name: true, by: 'bob', person: true },
      { text: ', who was named ' },
      { text: 'Robert', name: true, by: 'bob' },
    ])
    expect(sentenceText(reset({ fields: ['bio'], old_name: null }))).toBe(
      'Alice reset the description of Bob'
    )
    expect(sentenceText(reset({ fields: ['banner', 'bio', 'name'], old_name: null }))).toBe(
      'Alice reset the server name, description and banner color of Bob'
    )
    expect(sentenceText(reset({ fields: ['name', 'bio', 'avatar', 'banner'] }))).toBe(
      'Alice reset the server profile of Bob'
    )
    expect(sentenceText(reset({ fields: [], lock_until: 1_800_000_000 }))).toBe(
      'Alice locked the server profile of Bob'
    )
    expect(sentenceText({ ...reset({}), hidden: true })).toBe(
      'Alice reset the server profile of someone'
    )
    const facts = factsOf(reset({ fields: ['name'], lock_until: 1_800_000_000, reason: 'spam' }))
    expect(facts).toEqual([
      ['Locked until', new Date(1_800_000_000_000).toLocaleString()],
      ['Reason', 'spam'],
    ])
    expect(factsOf(reset({ fields: ['name'], old_name: null, reason: 'spam' }))).toEqual([
      ['Reason', 'spam'],
    ])
    expect(valueText('lock_until', 2 ** 63)).toBe('Until unlocked')
    expect(valueText('lock_until', null)).toBe('Not locked')
    const unlock = entry({
      action: 'member.profile_unlock',
      target,
      details: { changes: [{ field: 'lock_until', before: 1_800_000_000, after: null }] },
    })
    expect(sentenceText(unlock)).toBe('Alice unlocked the server profile of Bob')
    expect(fieldLabel('lock_until')).toBe('Locked until')
  })
})

test('a server description and icon read as the editor names them', () => {
  expect(fieldLabel('description')).toBe('Description')
  expect(fieldLabel('icon_kind')).toBe('Icon')
  expect(valueText('description', null)).toBe('No description')
  expect(valueText('icon_kind', 'identicon')).toBe('Pattern')
  expect(valueText('icon_kind', 'letter')).toBe('Letter')
})
