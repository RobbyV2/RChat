import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  allPings,
  badgePings,
  groupMentionsMe,
  groupPills,
  serverPingCount,
  useStore,
  resetSessionCaches,
} from '../store'
import {
  addGroupPing,
  dropGroupMessage,
  forgetGroupPings,
  groupBadges,
  groupKindsFor,
  groupNames,
  mergeGroupPings,
  onlineForHere,
} from '../group_pings'
import { groupSuggestions } from '../mention_suggest'
import {
  EMPTY_NOTIFY,
  groupKindsShown,
  parseNotify,
  notifyValue,
  pruneNotify,
  ruleSummary,
  setLevel,
  setMute,
  setSuppress,
  suppressedOf,
} from '../notify'
import { scopePings } from '../pings'
import { context, headline, type Piece } from '../notices'
import type { GroupMention, Message, Unread, WsEvent } from '../types'
import { me, member, msg, serverDetail, user } from './fixtures'

afterAll(resetSessionCaches)

const st = () => useStore.getState()
const dispatch = (ev: WsEvent) => st().applyWsEvent(ev)
const line = (pieces: Piece[]) => pieces.map(p => p.text).join('')
const toasts = () => st().notices.map(n => `${line(headline(n))}|${line(context(n))}`)
const realFetch = globalThis.fetch
const realWindow = (globalThis as { window?: unknown }).window

const everyone: GroupMention = { kind: 'everyone', role_id: null }
const here: GroupMention = { kind: 'here', role_id: null }
const crew: GroupMention = { kind: 'role', role_id: 7 }

const said = (id: number, group: GroupMention[], over: Partial<Message> = {}): WsEvent => ({
  type: 'message',
  server: 's',
  channel_id: 1,
  dm_id: null,
  dm_users: null,
  message: msg(id, {
    channel_id: 1,
    content: 'hey @everyone @here @crew',
    author: user('alice', { display_name: 'Alice' }),
    group_mentions: group,
    ...over,
  }),
})

beforeEach(() => {
  ;(globalThis as { window?: unknown }).window = {
    location: { pathname: '/', href: 'http://x/', origin: 'http://x', protocol: 'http:' },
    history: { state: null, pushState: () => {}, replaceState: () => {} },
  }
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch
  useStore.setState({
    me: me('bob', {
      servers: [{ name: 's', display_name: 's', creator: null, is_admin: false }],
    }),
    token: 't',
    guest: false,
    view: { kind: 'channel', server: 's', channelId: 2 },
    servers: {
      s: serverDetail('s', {
        channels: [
          { id: 1, name: 'general', kind: 'text', slowmode_seconds: 0 },
          { id: 2, name: 'random', kind: 'text', slowmode_seconds: 0 },
        ],
        roles: [
          { id: 7, name: 'Crew', color: '#22aa66', perms: 0, mentionable: true },
          { id: 8, name: 'Staff', color: '#aa2266', perms: 0 },
        ],
      }),
    },
    members: {},
    memberInfo: { s: { bob: member('bob', { role_ids: [7] }) } },
    messages: {},
    newer: {},
    reads: {},
    pings: {},
    groupPings: {},
    notifyPrefs: EMPTY_NOTIFY,
    atBottom: { c2: true },
    panel: null,
    notices: [],
  })
})

afterEach(() => {
  globalThis.fetch = realFetch
  ;(globalThis as { window?: unknown }).window = realWindow
})

describe('group mention helpers', () => {
  const self = { username: 'bob', member: true, online: true, roleIds: [7] }

  test('a message addresses members, online members and role holders', () => {
    const m = msg(5, { group_mentions: [everyone, here, crew] })
    expect(groupKindsFor(m, self)).toEqual(['everyone', 'here', 'role'])
    expect(groupKindsFor(m, { ...self, online: false, roleIds: [] })).toEqual(['everyone'])
    expect(
      groupKindsFor(msg(5, { group_mentions: [here, crew] }), {
        ...self,
        online: false,
        roleIds: null,
      })
    ).toEqual([])
    expect(groupKindsFor(m, { ...self, member: false })).toEqual([])
    expect(groupKindsFor(m, { ...self, username: 'alice' })).toEqual([])
    expect(groupKindsFor(msg(5, { group_mentions: [everyone], thread_root_id: 1 }), self)).toEqual(
      []
    )
    expect(
      groupKindsFor(msg(5, { group_mentions: [everyone], channel_id: null, dm_id: 3 }), self)
    ).toEqual([])
    expect(groupKindsFor(msg(5), self)).toEqual([])
  })

  test('counts follow the read position and the suppress settings', () => {
    let g = addGroupPing({}, 'c1', 's', { message_id: 5, kinds: ['everyone'] })
    g = addGroupPing(g, 'c1', 's', { message_id: 9, kinds: ['role'] })
    g = addGroupPing(g, 'c1', 's', { message_id: 9, kinds: ['role'] })
    expect(g.c1.items.map(i => i.message_id)).toEqual([9, 5])
    const all = () => true
    expect(groupBadges(g, () => 0, all).gc1.bulk).toBe(2)
    expect(groupBadges(g, () => 5, all).gc1.bulk).toBe(1)
    expect(groupBadges(g, () => 9, all)).toEqual({})
    expect(
      groupBadges(
        g,
        () => 0,
        (_s, kinds) => !kinds.includes('role')
      ).gc1.bulk
    ).toBe(1)
    expect(dropGroupMessage(g, 9).c1.items.map(i => i.message_id)).toEqual([5])
    expect(dropGroupMessage(dropGroupMessage(g, 9), 5)).toEqual({})
    expect(forgetGroupPings(g, (_scope, server) => server === 's')).toEqual({})
  })

  test('unreads win unless the scope changed while loading', () => {
    const before = addGroupPing({}, 'c1', 's', { message_id: 5, kinds: ['everyone'] })
    const live = addGroupPing(before, 'c2', 's', { message_id: 8, kinds: ['here'] })
    const items: Unread[] = [
      {
        scope: 'c1',
        server: 's',
        last_read: 0,
        latest: 6,
        group_pings: [{ message_id: 6, kinds: ['role'] }],
      },
    ]
    const merged = mergeGroupPings(before, live, items)
    expect(merged.c1.items).toEqual([{ message_id: 6, kinds: ['role'] }])
    expect(merged.c2.items).toEqual([{ message_id: 8, kinds: ['here'] }])
    expect(mergeGroupPings(before, before, [])).toEqual({})
  })

  test('pill names use role names and skip unknown roles', () => {
    const roles = [{ id: 7, name: ' Night Owls ', color: '#fff', perms: 0 }]
    expect(groupNames([everyone, here, crew, { kind: 'role', role_id: 99 }], roles)).toEqual([
      ['everyone', 'everyone'],
      ['here', 'here'],
      ['night owls', 'r7'],
    ])
  })

  test('autocomplete offers groups only when allowed, mentionable roles always', () => {
    const roles = [
      { id: 7, name: 'Crew', color: '#22aa66', perms: 0, mentionable: true },
      { id: 8, name: 'Staff', color: '#aa2266', perms: 0 },
    ]
    expect(groupSuggestions('', false, roles).map(g => g.label)).toEqual(['@Crew'])
    expect(groupSuggestions('', true, roles).map(g => g.label)).toEqual([
      '@everyone',
      '@here',
      '@Crew',
      '@Staff',
    ])
    expect(groupSuggestions('h', true, roles).map(g => g.key)).toEqual(['here'])
    expect(groupSuggestions('st', false, roles)).toEqual([])
  })
})

describe('suppress settings', () => {
  test('are per server, survive level changes, expiry and a round trip', () => {
    let p = setSuppress(EMPTY_NOTIFY, 's', 'everyone', true)
    expect(suppressedOf(p, 's', 'everyone')).toBe(true)
    expect(suppressedOf(p, 's', 'roles')).toBe(false)
    expect(groupKindsShown(p, 's', ['everyone', 'here', 'role'])).toEqual(['role'])
    expect(groupKindsShown(p, 'other', ['everyone'])).toEqual(['everyone'])
    p = setSuppress(p, 's', 'roles', true)
    expect(groupKindsShown(p, 's', ['everyone', 'role'])).toEqual([])
    p = setLevel(p, { kind: 'server', name: 's' }, 'all')
    p = setMute(p, { kind: 'server', name: 's' }, 5)
    expect(ruleSummary(p.servers.s, 0)).toBe(
      'All messages, muted until ' +
        new Date(5).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) +
        ', no @everyone, no role mentions'
    )
    p = pruneNotify(p, 10)
    expect(p.servers.s).toEqual({ level: 'all', suppressEveryone: true, suppressRoles: true })
    const back = parseNotify(notifyValue(p))
    expect(back.servers.s).toEqual(p.servers.s)
    expect(parseNotify('{"v":1,"servers":{"s":{"suppressRoles":"yes"}}}').servers.s).toBeUndefined()
    p = setSuppress(
      setSuppress(setLevel(p, { kind: 'server', name: 's' }, null), 's', 'everyone', false),
      's',
      'roles',
      false
    )
    expect(p.servers.s).toBeUndefined()
  })
})

describe('live group mentions', () => {
  test('@everyone elsewhere: badge, toast, cleared by reading', () => {
    dispatch(said(10, [everyone]))
    expect(st().groupPings.c1.items).toEqual([{ message_id: 10, kinds: ['everyone'] }])
    expect(scopePings(badgePings(st()), 'c1')).toBe(1)
    expect(serverPingCount(st(), 's')).toBe(1)
    expect(allPings(st())).toBe(1)
    expect(toasts()).toEqual(['Alice mentioned @everyone|s · #general'])
    st().markRead('c1', 10)
    expect(allPings(st())).toBe(0)
  })

  test('authors you blocked neither badge nor toast', () => {
    useStore.setState({ blocked: { alice: true } })
    dispatch(said(10, [everyone, here, crew]))
    expect(st().groupPings.c1).toBeUndefined()
    expect(allPings(st())).toBe(0)
    expect(toasts()).toEqual([])
    useStore.setState({ blocked: {} })
  })

  test('a role you hold toasts with its name; one you lack stays plain', () => {
    dispatch(said(11, [crew]))
    expect(toasts()).toEqual(['Alice mentioned @Crew|s · #general'])
    useStore.setState({ notices: [] })
    dispatch(said(12, [{ kind: 'role', role_id: 8 }]))
    expect(st().groupPings.c1.items.map(i => i.message_id)).toEqual([11])
    expect(toasts()).toEqual([])
  })

  test('suppressed kinds neither toast nor badge, others still do', () => {
    useStore.setState({ notifyPrefs: setSuppress(EMPTY_NOTIFY, 's', 'everyone', true) })
    dispatch(said(13, [everyone, here]))
    expect(allPings(st())).toBe(0)
    expect(toasts()).toEqual([])
    dispatch(said(14, [everyone, crew]))
    expect(allPings(st())).toBe(1)
    expect(toasts()).toEqual(['Alice mentioned @Crew|s · #general'])
    useStore.setState({ notifyPrefs: setSuppress(st().notifyPrefs, 's', 'roles', true) })
    expect(allPings(st())).toBe(0)
  })

  test('@here counts wherever you are, unless you appear offline', () => {
    const kinds = (id: number) => st().groupPings.c1?.items.find(i => i.message_id === id)?.kinds
    useStore.setState({ view: { kind: 'channel', server: 'other', channelId: 9 } })
    dispatch(said(40, [here]))
    expect(kinds(40)).toEqual(['here'])
    expect(allPings(st())).toBe(1)
    expect(toasts()).toEqual(['Alice mentioned @here|s · #general'])
    useStore.setState({ view: { kind: 'dm', dmId: 3 }, notices: [] })
    dispatch(said(41, [here]))
    expect(kinds(41)).toEqual(['here'])
    useStore.setState({ view: null, notices: [] })
    dispatch(said(42, [everyone, here]))
    expect(kinds(42)).toEqual(['everyone', 'here'])
    expect(allPings(st())).toBe(3)
    expect(toasts()).toEqual(['Alice mentioned @everyone|s · #general'])
    useStore.setState({ me: { ...st().me!, appear_offline: true }, notices: [] })
    dispatch(said(43, [here]))
    dispatch(said(44, [everyone, here]))
    expect(kinds(43)).toBeUndefined()
    expect(kinds(44)).toEqual(['everyone'])
    expect(allPings(st())).toBe(4)
  })

  test('onlineForHere ignores the open view', () => {
    expect(onlineForHere(null)).toBe(false)
    expect(onlineForHere(undefined)).toBe(false)
    expect(onlineForHere({ appear_offline: false })).toBe(true)
    expect(onlineForHere({ appear_offline: true })).toBe(false)
  })

  test('every kind suppressed: "All messages" still alerts as a plain message', () => {
    const all = setLevel(EMPTY_NOTIFY, { kind: 'server', name: 's' }, 'all')
    useStore.setState({ notifyPrefs: setSuppress(all, 's', 'everyone', true) })
    dispatch(said(45, [everyone, here]))
    expect(allPings(st())).toBe(0)
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0].includes('mentioned')).toBe(false)
    useStore.setState({
      notifyPrefs: setSuppress(EMPTY_NOTIFY, 's', 'everyone', true),
      notices: [],
    })
    dispatch(said(46, [everyone]))
    expect(toasts()).toEqual([])
  })

  test('"Nothing" hides the badge; muted keeps it but no toast', () => {
    useStore.setState({
      notifyPrefs: setLevel(EMPTY_NOTIFY, { kind: 'server', name: 's' }, 'nothing'),
    })
    dispatch(said(15, [everyone]))
    expect(allPings(st())).toBe(0)
    expect(toasts()).toEqual([])
    useStore.setState({
      notifyPrefs: setMute(EMPTY_NOTIFY, { kind: 'server', name: 's' }, 'forever'),
    })
    dispatch(said(16, [everyone]))
    expect(allPings(st())).toBe(2)
    expect(toasts()).toEqual([])
  })

  test('watching the channel at the bottom: no toast and nothing counted', () => {
    useStore.setState({
      view: { kind: 'channel', server: 's', channelId: 1 },
      atBottom: { c1: true },
    })
    ;(globalThis as { document?: unknown }).document = { visibilityState: 'visible' }
    dispatch(said(17, [everyone]))
    delete (globalThis as { document?: unknown }).document
    expect(toasts()).toEqual([])
    expect(allPings(st())).toBe(0)
  })

  test('own messages, guests, threads and personal mentions are not group pings', () => {
    dispatch(said(18, [everyone], { author: user('bob') }))
    dispatch(said(19, [everyone], { thread_root_id: 3 }))
    dispatch(said(20, [everyone], { content: '@everyone and @bob' }))
    expect(st().groupPings).toEqual({})
    useStore.setState({ me: null, guest: true, notices: [] })
    dispatch(said(21, [everyone]))
    expect(st().groupPings).toEqual({})
  })

  test('deleting the message drops it', () => {
    dispatch(said(22, [everyone]))
    dispatch({
      type: 'message_deleted',
      server: 's',
      channel_id: 1,
      dm_id: null,
      dm_users: null,
      id: 22,
      thread_root_id: null,
    } as WsEvent)
    expect(st().groupPings).toEqual({})
  })

  test('highlight and pills', () => {
    const m = msg(30, { group_mentions: [crew, everyone] })
    expect(groupMentionsMe(st(), m)).toBe(true)
    expect(groupMentionsMe(st(), msg(31, { group_mentions: [{ kind: 'role', role_id: 8 }] }))).toBe(
      false
    )
    expect(groupMentionsMe(st(), msg(32))).toBe(false)
    expect(groupPills(st(), m)).toBe('crew\tr7\neveryone\teveryone')
  })
})
