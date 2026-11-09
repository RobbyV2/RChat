import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import {
  AtSign,
  Check,
  Clock,
  Copy,
  ExternalLink,
  Forward,
  Hash,
  Link,
  Lock,
  LockOpen,
  MessageCircle,
  MessageSquareText,
  Pencil,
  Pin,
  PinOff,
  Reply,
  SquareCheckBig,
  Trash2,
  UserCheck,
  UserPlus,
  UserX,
  Users,
} from 'lucide-react'
import { ctxFor, paletteCtx, refreshCtx } from '../actions/ctx'
import { registerAppActions } from '../actions/index'
import { messageRights } from '../actions/message'
import { menuItems, openActionMenu } from '../actions/menu'
import { paletteCommands } from '../actions/palette'
import { allActions, runAction } from '../actions/registry'
import type { Target } from '../actions/types'
import type { InboxEntry } from '../inbox'
import { emptyLayout } from '../nav_layout'
import { EMPTY_NOTIFY } from '../notify'
import { setSharing, sharing } from '../platform'
import { resetSessionCaches, useStore, type ConfirmRequest, type ContextMenuItem } from '../store'
import type { RChatState } from '../store_types'
import { Perm, type Member, type Message, type Poll } from '../types'
import { drain, embed, me, member, msg, paged, role, serverDetail, user } from './fixtures'

const realSharing = sharing()
const g = globalThis as { window?: unknown }
const realWindow = g.window
const initial = useStore.getState()
const realFns = Object.fromEntries(
  Object.entries(initial).filter(([, v]) => typeof v === 'function')
)

beforeAll(registerAppActions)

afterEach(() => {
  setSharing(realSharing)
  g.window = realWindow
  useStore.setState(initial, true)
})

afterAll(resetSessionCaches)

const T0 = 1_700_000_000
const MOD = Perm.Kick | Perm.TimeoutMembers | Perm.DeleteMessages | Perm.ManageAdmins

const poll = (over: Partial<Poll> = {}): Poll => ({
  kind: 'single',
  question: 'Q?',
  options: [],
  anonymous: false,
  show_results: 'always',
  allow_change: true,
  allow_add: false,
  min_choices: 1,
  max_choices: 1,
  scale: null,
  closes_at: null,
  closed: false,
  voters: 2,
  results: { counts: [], rounds: [], winner: null, distribution: [], average: null },
  mine: null,
  ...over,
})

const by = (id: number, author: string, over: Partial<Message> = {}) =>
  msg(id, {
    author: user(author, author === 'bob' ? { display_name: 'Bobby' } : {}),
    created_at: T0 + id,
    content: `m${id}`,
    ...over,
  })

const own = by(10, 'alice')
const bobs = by(11, 'bob')
const zeds = by(12, 'zed')
const pinNotice = by(13, 'alice', { kind: 'pin', content: '', pin_message_id: 10 })
const join = by(14, 'carol', { kind: 'join', content: '' })
const hook = by(15, '@webhook:7', { webhook: { id: 7, embeds: [] } })
const bobPoll = by(16, 'bob', { kind: 'poll', content: '', poll: poll() })
const ownClosedPoll = by(17, 'alice', { kind: 'poll', content: '', poll: poll({ closed: true }) })
const bobPinned = by(18, 'bob', { pinned_at: T0 + 500 })
const blank = by(19, 'bob', { content: '   ' })
const anonPoll = by(21, 'bob', { kind: 'poll', content: '', poll: poll({ anonymous: true }) })
const expiredPoll = by(22, 'bob', { kind: 'poll', content: '', poll: poll({ closes_at: T0 }) })
const carols = by(23, 'carol')
const root = by(30, 'bob', { reply_count: 3 })
const ownReply = by(31, 'alice', { thread_root_id: 30 })
const bobReply = by(32, 'bob', { thread_root_id: 30 })
const pollReply = by(33, 'bob', { thread_root_id: 30, kind: 'poll', content: '', poll: poll() })
const withEmbeds = by(34, 'alice', {
  content: 'see https://e1.com and https://e2.com',
  embeds: [
    embed(1, { image_url: '/api/messages/34/embeds/1/image?v=ab' }),
    embed(2, { image_url: null }),
  ],
})
const bobEmbed = by(35, 'bob', {
  content: 'see https://e1.com',
  embeds: [embed(1, { image_url: '/api/messages/35/embeds/1/image?v=ab' })],
})
const ownRoot = by(36, 'alice')
const dmOwn = by(40, 'alice', { channel_id: null, dm_id: 9 })
const dmBob = by(41, 'bob', { channel_id: null, dm_id: 9 })
const dmPin = by(43, 'bob', { channel_id: null, dm_id: 9, kind: 'pin', content: '' })
const readOnlyBob = by(50, 'bob', { channel_id: 2 })

interface State {
  perms?: number
  owner?: boolean
  siteAdmin?: boolean
  guest?: boolean
  bob?: Partial<Member>
  bobTimedOut?: boolean
  meTimedOut?: boolean
  notMember?: boolean
  blocked?: string[]
  friends?: string[]
  view?: 'c1' | 'c2' | 'd9'
  thread?: Message
}

// Alice in server s (#general 1, read-only #news 2): her role r1 carries `perms`; bob holds
// Helper (r3); Moderator (r2) is free; zed has left.
const state = (o: State = {}) => {
  const c1 = [own, bobs, zeds, pinNotice, join, hook, bobPoll, ownClosedPoll, bobPinned, blank]
  c1.push(anonPoll, expiredPoll, carols, root, withEmbeds, bobEmbed, ownRoot)
  const view = o.view ?? 'c1'
  useStore.setState({
    ...realFns,
    token: o.guest ? null : 'tok',
    guest: !!o.guest,
    me: o.guest
      ? null
      : me('alice', {
          is_site_admin: !!o.siteAdmin,
          servers: o.notMember
            ? []
            : [
                {
                  name: 's',
                  display_name: 'Space',
                  creator: null,
                  is_admin: !!o.owner,
                  ...(o.meTimedOut ? { timed_out_until: Date.now() / 1000 + 3600 } : {}),
                },
              ],
        }),
    servers: {
      s: serverDetail('s', {
        display_name: 'Space',
        roles: [
          role(1, '#f00', o.perms ?? 0),
          { ...role(2, '#0f0', 0), name: 'Moderator' },
          { ...role(3, '#00f', 0), name: 'Helper' },
        ],
        channels: [
          { id: 1, name: 'general', kind: 'text', slowmode_seconds: 0 },
          { id: 2, name: 'news', kind: 'text', slowmode_seconds: 0 },
        ],
        read_only: [2],
      }),
    },
    members: {
      s: paged([
        member('alice', { role_ids: [1], is_admin: !!o.owner }),
        member('bob', { display_name: 'Bobby', role_ids: [3], ...o.bob }),
        member('carol'),
      ]),
    },
    memberInfo: { s: { zed: null } },
    timeouts: o.bobTimedOut ? { s: { bob: { ends: Date.now() + 3_600_000, reason: '' } } } : {},
    blocked: Object.fromEntries((o.blocked ?? []).map(n => [n, true])),
    friends: paged((o.friends ?? []).map(n => ({ user: user(n), since: 1, online: false }))),
    onlineFriends: paged([]),
    incomingRequests: paged([]),
    outgoingRequests: paged([]),
    dms: [{ id: 9, other: user('bob', { display_name: 'Bobby' }), is_self: false }],
    layout: { ...emptyLayout },
    notifyPrefs: EMPTY_NOTIFY,
    messages: {
      c1,
      c2: [readOnlyBob],
      d9: [dmOwn, dmBob, dmPin],
      t30: [ownReply, bobReply, pollReply],
      t36: [],
    },
    newer: {},
    stale: {},
    wsStatus: 'green',
    view:
      view === 'd9'
        ? { kind: 'dm', dmId: 9 }
        : { kind: 'channel', server: 's', channelId: view === 'c2' ? 2 : 1 },
    panel: o.thread ? { kind: 'thread', root: o.thread } : null,
  } as Partial<RChatState>)
}

const listOf = (m: Message) =>
  m.thread_root_id !== null
    ? `t${m.thread_root_id}`
    : m.dm_id !== null
      ? `d${m.dm_id}`
      : `c${m.channel_id}`
const at = (m: Message, list = listOf(m)): Target => ({ kind: 'message', message: m, list })
const inThread = (m: Message, rootId = 30) => at(m, `t${rootId}`)
const items = (t: Target) => menuItems(ctxFor(useStore.getState(), t, 'menu'))
const labels = (t: Target) => items(t).map(i => i.label)
const row = (t: Target, label: string) => items(t).find(i => i.label === label)

const COPIES = ['Copy Text', 'Copy Message Link', 'Copy Timestamp', 'Copy Message ID']
const COPY_ALL = [...COPIES, 'Copy User ID']
const PERSON = ['Add friend', 'Block']

type Call = unknown[]
const recorder = () => {
  const calls: Call[] = []
  const fns: Record<string, unknown> = {}
  for (const [name, f] of Object.entries(realFns)) {
    if (typeof f !== 'function' || name === 'openContextMenu' || name === 'closeContextMenu')
      continue
    fns[name] = (...a: unknown[]) => {
      calls.push([name, ...a])
      return Promise.resolve()
    }
  }
  fns.askConfirm = (c: ConfirmRequest) => {
    calls.push(['askConfirm', c.title, c.body, c.confirm])
    c.action('')
  }
  useStore.setState(fns as Partial<RChatState>)
  setSharing({ ...realSharing, copyText: async t => (calls.push(['copy', t]), true) })
  g.window = {
    matchMedia: () => ({ matches: false }),
    location: { origin: 'https://x.test', protocol: 'https:' },
  }
  return calls
}

const effects = async (rows: ContextMenuItem[]) => {
  const out: [string, Call[]][] = []
  for (const r of rows)
    for (const leaf of r.submenu ?? [r]) {
      const calls = recorder()
      leaf.action?.()
      await drain()
      out.push([leaf.label, [...calls]])
    }
  return out
}

test('own message in #general', () => {
  state({ perms: Perm.DeleteMessages })
  expect(labels(at(own))).toEqual([
    'Edit Message',
    'Reply',
    'Forward',
    'Reply in thread',
    'Direct Message',
    'Pin Message',
    'Select Message',
    'Delete Message',
    ...COPY_ALL,
  ])
  state()
  expect(labels(at(own))).toEqual([
    'Edit Message',
    'Reply',
    'Forward',
    'Reply in thread',
    'Direct Message',
    'Select Message',
    'Delete Message',
    ...COPY_ALL,
  ])
})

test("another member's message, as a plain member", () => {
  state()
  expect(labels(at(bobs))).toEqual([
    'Reply',
    'Forward',
    'Reply in thread',
    'Direct Message',
    ...PERSON,
    'Select Message',
    ...COPY_ALL,
  ])
})

test('as a moderator: moderation after DM, Assign Role as a submenu (rule 2)', () => {
  state({ perms: MOD })
  expect(labels(at(bobs))).toEqual([
    'Reply',
    'Forward',
    'Reply in thread',
    'Direct Message',
    'Pin Message',
    'Kick',
    'Ban from server',
    'Time Out',
    'Assign Role',
    ...PERSON,
    'Select Message',
    'Delete Message',
    ...COPY_ALL,
  ])
  expect(row(at(bobs), 'Assign Role')?.submenu?.map(i => [i.label, !!i.danger])).toEqual([
    ['Assign r1', false],
    ['Assign Moderator', false],
    ['Remove Helper', true],
  ])
  state({ perms: MOD, bobTimedOut: true })
  expect(labels(at(bobs)).slice(5, 9)).toEqual([
    'Kick',
    'Ban from server',
    'Change Timeout',
    'Remove Timeout',
  ])
})

test('admin rows on a message: never on your own, Revoke Admin is danger (rule 2)', () => {
  state({ owner: true, bob: { is_admin: true, perms: Perm.Kick } })
  expect(
    items(at(bobs))
      .map(i => [i.label, !!i.danger])
      .slice(4, 11)
  ).toEqual([
    ['Pin Message', false],
    ['Kick', true],
    ['Ban from server', true],
    ['Time Out', true],
    ['Revoke Admin', true],
    ['Transfer Admin', false],
    ['Assign Role', false],
  ])
  state({ perms: Perm.ManageAdmins | Perm.Kick, bob: { is_admin: true, perms: Perm.Kick } })
  expect(labels(at(bobs))).toEqual([
    'Reply',
    'Forward',
    'Reply in thread',
    'Direct Message',
    'Kick',
    'Ban from server',
    'Revoke Admin',
    'Transfer Admin',
    'Assign Role',
    ...PERSON,
    'Select Message',
    ...COPY_ALL,
  ])
  state({ owner: true })
  expect(labels(at(bobs)).slice(5, 11)).toEqual([
    'Kick',
    'Ban from server',
    'Time Out',
    'Promote to Admin',
    'Transfer Admin',
    'Assign Role',
  ])
  expect(labels(at(own))).toEqual([
    'Edit Message',
    'Reply',
    'Forward',
    'Reply in thread',
    'Direct Message',
    'Pin Message',
    'Assign Role',
    'Select Message',
    'Delete Message',
    ...COPY_ALL,
  ])
  expect(row(at(own), 'Assign Role')?.submenu?.map(i => i.label)).toEqual([
    'Remove r1',
    'Assign Moderator',
    'Assign Helper',
  ])
})

test('an author who left: no Kick, Ban or Time Out', () => {
  state()
  expect(labels(at(zeds))).toEqual([
    'Reply',
    'Forward',
    'Reply in thread',
    'Direct Message',
    ...PERSON,
    'Select Message',
    ...COPY_ALL,
  ])
  state({ perms: MOD })
  expect(labels(at(zeds))).toEqual([
    'Reply',
    'Forward',
    'Reply in thread',
    'Direct Message',
    'Pin Message',
    'Assign Role',
    ...PERSON,
    'Select Message',
    'Delete Message',
    ...COPY_ALL,
  ])
  state({ owner: true })
  expect(labels(at(zeds)).slice(4, 8)).toEqual([
    'Pin Message',
    'Promote to Admin',
    'Transfer Admin',
    'Assign Role',
  ])
  state({ perms: MOD })
  useStore.setState({ memberInfo: {} })
  expect(labels(at(zeds)).slice(5, 8)).toEqual(['Kick', 'Ban from server', 'Time Out'])
})

test('an author who left: each role choice runs nothing and says so', async () => {
  state({ perms: MOD })
  const roles = row(at(zeds), 'Assign Role')!.submenu!
  expect(roles.map(i => i.label)).toEqual(['Assign r1', 'Assign Moderator', 'Assign Helper'])
  expect(await effects(roles)).toEqual(
    roles.map(r => [r.label, [['showToast', "That's no longer available"]]])
  )
})

test('a pin notice offers delete, select and its id only', () => {
  state({ perms: Perm.DeleteMessages })
  expect(labels(at(pinNotice))).toEqual(['Delete Message', 'Select Message', 'Copy Message ID'])
  state()
  expect(labels(at(pinNotice))).toEqual(['Delete Message', 'Select Message', 'Copy Message ID'])
  state({ view: 'd9' })
  expect(labels(at(dmPin))).toEqual(['Copy Message ID'])
})

test('a system notice offers its id, and delete and select to moderators', () => {
  state()
  expect(labels(at(join))).toEqual(['Copy Message ID'])
  state({ perms: Perm.DeleteMessages })
  expect(labels(at(join))).toEqual(['Delete Message', 'Select Message', 'Copy Message ID'])
  expect(items(at(join)).map(i => [i.icon, !!i.danger])).toEqual([
    [Trash2, true],
    [SquareCheckBig, false],
    [Hash, false],
  ])
})

test('a webhook author: no person rows, its webhook id instead of a user id', () => {
  state()
  expect(labels(at(hook))).toEqual([
    'Reply',
    'Forward',
    'Reply in thread',
    'Select Message',
    ...COPIES,
    'Copy Webhook ID',
  ])
  for (const o of [{ perms: MOD }, { siteAdmin: true }]) {
    state(o)
    expect(labels(at(hook))).toEqual([
      'Reply',
      'Forward',
      'Reply in thread',
      'Pin Message',
      'Select Message',
      'Delete Message',
      ...COPIES,
      'Copy Webhook ID',
    ])
  }
})

test('a guest sees copy items only', () => {
  state({ guest: true })
  expect(labels(at(bobs))).toEqual(COPY_ALL)
  expect(labels(at(pinNotice))).toEqual(COPY_ALL.slice(1))
  expect(labels(at(join))).toEqual(COPY_ALL.slice(1))
  expect(labels(at(hook))).toEqual([...COPIES, 'Copy Webhook ID'])
  expect(labels(at(bobPoll))).toEqual(COPY_ALL.slice(1))
  expect(labels(at(blank))).toEqual(COPY_ALL.slice(1))
  state({ guest: true, view: 'd9' })
  expect(labels(at(dmBob))).toEqual(COPY_ALL)
})

test('a guest opens no write row anywhere', () => {
  state({ guest: true, thread: root })
  const write =
    /^(Edit|Reply|Forward|Pin|Unpin|Delete|Select|Kick|Ban|Time Out|Change|Remove|Assign|Revoke|Promote|Transfer|Add|Block|Unblock|Close|Reopen)\b/
  for (const t of [at(bobs), at(own), at(bobPoll), inThread(bobReply), inThread(root)])
    expect(labels(t).filter(l => write.test(l))).toEqual([])
  expect(labels(inThread(pollReply))).toEqual(['View Votes', ...COPY_ALL.slice(1)])
})

test('polls: voters, close and reopen', () => {
  state()
  expect(labels(at(bobPoll))).toEqual([
    'Reply',
    'Forward',
    'Reply in thread',
    'Direct Message',
    'View Votes',
    ...PERSON,
    'Select Message',
    ...COPY_ALL.slice(1),
  ])
  state({ perms: Perm.DeleteMessages })
  expect(labels(at(bobPoll))).toEqual([
    'Reply',
    'Forward',
    'Reply in thread',
    'Direct Message',
    'Pin Message',
    'View Votes',
    'Close Poll',
    ...PERSON,
    'Select Message',
    'Delete Message',
    ...COPY_ALL.slice(1),
  ])
  expect(labels(at(anonPoll)).slice(4, 7)).toEqual(['Pin Message', 'Close Poll', 'Add friend'])
  expect(labels(at(expiredPoll)).slice(4, 7)).toEqual(['Pin Message', 'View Votes', 'Reopen Poll'])
  state()
  expect(labels(at(ownClosedPoll))).toEqual([
    'Reply',
    'Forward',
    'Reply in thread',
    'Direct Message',
    'View Votes',
    'Reopen Poll',
    'Select Message',
    'Delete Message',
    ...COPY_ALL.slice(1),
  ])
  expect(
    items(at(ownClosedPoll))
      .map(i => i.icon)
      .slice(4, 6)
  ).toEqual([Users, LockOpen])
  state({ perms: Perm.DeleteMessages })
  expect(row(at(bobPoll), 'Close Poll')?.icon).toBe(Lock)
})

test('pinned, empty and forwarded messages', () => {
  state({ perms: Perm.DeleteMessages })
  expect(row(at(bobPinned), 'Unpin Message')?.icon).toBe(PinOff)
  expect(labels(at(bobPinned))).not.toContain('Pin Message')
  state()
  expect(labels(at(bobPinned))).not.toContain('Unpin Message')
  expect(labels(at(blank))).toEqual([
    'Reply',
    'Forward',
    'Reply in thread',
    'Direct Message',
    ...PERSON,
    'Select Message',
    ...COPY_ALL.slice(1),
  ])
  const fwd = by(20, 'alice', {
    forward: { author: user('carol'), created_at: T0, source_id: 3, origin: null, dropped: null },
  })
  useStore.setState(s => ({ messages: { ...s.messages, c1: [...s.messages.c1, fwd] } }))
  expect(labels(at(fwd)).slice(0, 4)).toEqual([
    'Reply',
    'Forward',
    'Reply in thread',
    'Direct Message',
  ])
})

test('friends, blocked people and requests', () => {
  state({ friends: ['bob'] })
  expect(labels(at(bobs)).slice(3, 6)).toEqual(['Direct Message', 'Block', 'Select Message'])
  state({ blocked: ['bob'] })
  expect(
    items(at(bobs))
      .slice(3, 6)
      .map(i => [i.label, i.icon, !!i.danger])
  ).toEqual([
    ['Direct Message', MessageCircle, false],
    ['Unblock', UserCheck, false],
    ['Select Message', SquareCheckBig, false],
  ])
  state()
  useStore.setState({
    incomingRequests: paged([{ user: user('bob'), created_at: 1, incoming: true }]),
  })
  expect(labels(at(bobs)).slice(3, 6)).toEqual(['Direct Message', 'Block', 'Select Message'])
  state()
  expect(
    items(at(bobs))
      .slice(4, 6)
      .map(i => [i.icon, !!i.danger])
  ).toEqual([
    [UserPlus, false],
    [UserX, true],
  ])
})

test('the hidden site admin: Ban site-wide on others, in channels and DMs, never on self', () => {
  state({ siteAdmin: true })
  expect(labels(at(carols))).toEqual([
    'Reply',
    'Forward',
    'Reply in thread',
    'Direct Message',
    'Pin Message',
    'Kick',
    'Ban from server',
    'Time Out',
    'Promote to Admin',
    'Transfer Admin',
    'Assign Role',
    ...PERSON,
    'Remove backup phrase',
    'Ban site-wide',
    'Select Message',
    'Delete Message',
    ...COPY_ALL,
  ])
  expect(labels(at(own))).not.toContain('Ban site-wide')
  expect(labels(at(own))).not.toContain('Remove backup phrase')
  state({ siteAdmin: true, view: 'd9' })
  expect(labels(at(dmBob))).toEqual([
    'Reply',
    'Forward',
    'Direct Message',
    'Pin Message',
    ...PERSON,
    'Remove backup phrase',
    'Ban site-wide',
    'Select Message',
    ...COPY_ALL,
  ])
  state()
  expect(labels(at(carols))).not.toContain('Ban site-wide')
})

test('timed out, read-only and not a member: no edit, reply or pin', () => {
  state({ meTimedOut: true, perms: Perm.DeleteMessages })
  expect(labels(at(bobs))).toEqual([
    'Forward',
    'Reply in thread',
    'Direct Message',
    ...PERSON,
    'Select Message',
    ...COPY_ALL,
  ])
  state({ meTimedOut: true, perms: MOD })
  expect(labels(at(own))).toEqual([
    'Forward',
    'Reply in thread',
    'Direct Message',
    'Select Message',
    'Delete Message',
    ...COPY_ALL,
  ])
  state({ notMember: true })
  expect(labels(at(bobs))).toEqual([
    'Forward',
    'Reply in thread',
    'Direct Message',
    ...PERSON,
    'Select Message',
    ...COPY_ALL,
  ])
  state({ view: 'c2', perms: Perm.DeleteMessages })
  expect(labels(at(readOnlyBob))).toEqual([
    'Forward',
    'Reply in thread',
    'Direct Message',
    'Pin Message',
    ...PERSON,
    'Select Message',
    'Delete Message',
    ...COPY_ALL,
  ])
})

test('in a DM: no thread and no moderation', () => {
  state({ view: 'd9' })
  expect(labels(at(dmOwn))).toEqual([
    'Edit Message',
    'Reply',
    'Forward',
    'Direct Message',
    'Pin Message',
    'Select Message',
    'Delete Message',
    ...COPY_ALL,
  ])
  const dmBobRows = [
    'Reply',
    'Forward',
    'Direct Message',
    'Pin Message',
    ...PERSON,
    'Select Message',
    ...COPY_ALL,
  ]
  expect(labels(at(dmBob))).toEqual(dmBobRows)
  state({ view: 'd9', perms: MOD })
  expect(labels(at(dmBob))).toEqual(dmBobRows)
})

test('in a thread: no DM, moderation or pin; the root has no select or delete', () => {
  state({ thread: root })
  expect(labels(inThread(ownReply))).toEqual([
    'Edit Message',
    'Reply',
    'Forward',
    'Select Message',
    'Delete Message',
    ...COPY_ALL,
  ])
  expect(labels(inThread(bobReply))).toEqual([
    'Reply',
    'Forward',
    'Select Message',
    ...PERSON,
    ...COPY_ALL,
  ])
  expect(labels(inThread(root))).toEqual(['Reply', 'Forward', ...PERSON, ...COPY_ALL])
  expect(labels(inThread(pollReply))).toEqual([
    'Reply',
    'Forward',
    'View Votes',
    'Select Message',
    ...PERSON,
    ...COPY_ALL.slice(1),
  ])
  for (const o of [{ perms: MOD }, { siteAdmin: true }]) {
    state({ ...o, thread: root })
    expect(labels(inThread(bobReply))).toEqual([
      'Reply',
      'Forward',
      'Select Message',
      'Delete Message',
      ...PERSON,
      ...COPY_ALL,
    ])
    expect(labels(inThread(root))).toEqual(['Reply', 'Forward', ...PERSON, ...COPY_ALL])
  }
  state({ thread: root, perms: Perm.DeleteMessages })
  expect(labels(inThread(pollReply)).slice(2, 6)).toEqual([
    'View Votes',
    'Close Poll',
    'Select Message',
    'Delete Message',
  ])
  state({ thread: root, blocked: ['bob'] })
  expect(labels(inThread(bobReply)).slice(3, 4)).toEqual(['Unblock'])
  state({ thread: root, meTimedOut: true })
  expect(labels(inThread(ownReply))).toEqual([
    'Forward',
    'Select Message',
    'Delete Message',
    ...COPY_ALL,
  ])
  state({ thread: ownRoot, perms: MOD })
  expect(labels(inThread(ownRoot, 36))).toEqual(['Edit Message', 'Reply', 'Forward', ...COPY_ALL])
  state({ thread: root, perms: MOD })
  expect(labels(at(root))).toEqual([
    'Reply',
    'Forward',
    'Reply in thread',
    'Direct Message',
    'Pin Message',
    'Kick',
    'Ban from server',
    'Time Out',
    'Assign Role',
    ...PERSON,
    'Select Message',
    'Delete Message',
    ...COPY_ALL,
  ])
})

test('the embed menu: remove, the banner when it has one, all', () => {
  const embedAt = (m: Message, ord: number, banner: boolean): Target => ({
    kind: 'embed',
    message: m,
    ord,
    banner,
  })
  state()
  expect(items(embedAt(withEmbeds, 1, true)).map(i => [i.label, !!i.danger, i.icon])).toEqual([
    ['Remove embed', true, undefined],
    ['Remove banner', false, undefined],
    ['Remove all embeds', true, undefined],
  ])
  expect(labels(embedAt(withEmbeds, 2, false))).toEqual(['Remove embed', 'Remove all embeds'])
  expect(labels(embedAt(bobEmbed, 1, true))).toEqual([])
  state({ perms: Perm.DeleteMessages })
  expect(labels(embedAt(bobEmbed, 1, true))).toEqual([
    'Remove embed',
    'Remove banner',
    'Remove all embeds',
  ])
  state({ guest: true })
  expect(labels(embedAt(withEmbeds, 1, true))).toEqual([])
})

test('the timestamp menu copies the token as written, under the full date', () => {
  state({ guest: true })
  const stamp: Target = { kind: 'timestamp', ts: T0 * 1000, token: '<t:1700000000:R>' }
  expect(items(stamp).map(i => [i.label, i.icon])).toEqual([['Copy Timestamp', Clock]])
  let opened: unknown = null
  useStore.setState({
    openContextMenu: (_x, _y, rows, opts) => void (opened = [rows.length, opts]),
  })
  openActionMenu(1, 1, stamp, { header: 'full date' })
  expect(opened).toEqual([1, { header: 'full date' }])
})

const entry = (unread: boolean, friends = false): InboxEntry => ({
  key: 'n:1',
  adapter: 'instance',
  id: 1,
  created_at: T0,
  unread,
  kind: 'mention',
  actor: user('bob'),
  emoji: null,
  role: null,
  where: friends
    ? { kind: 'friends' }
    : { kind: 'channel', server: 's', serverName: 'Space', channel: 'general', thread: false },
  content: 'hi',
  media: null,
  mediaSpoiler: false,
  raw: null,
})

test('an inbox row: jump or open friends, and mark as read while unread', async () => {
  state()
  const done: string[] = []
  const at = (e: InboxEntry): Target => ({
    kind: 'inbox',
    entry: e,
    open: () => void done.push(`open ${e.key}`),
    read: () => void done.push(`read ${e.key}`),
  })
  expect(items(at(entry(true))).map(i => [i.label, i.icon])).toEqual([
    ['Jump to message', ExternalLink],
    ['Mark as read', Check],
  ])
  expect(labels(at(entry(false)))).toEqual(['Jump to message'])
  expect(labels(at(entry(true, true)))).toEqual(['Open friends', 'Mark as read'])
  for (const i of items(at(entry(true, true)))) i.action?.()
  await drain()
  expect(done).toEqual(['open n:1', 'read n:1'])
})

test('icons of the message rows', () => {
  state({ perms: Perm.DeleteMessages })
  expect(items(at(own)).map(i => [i.label, i.icon, !!i.danger])).toEqual([
    ['Edit Message', Pencil, false],
    ['Reply', Reply, false],
    ['Forward', Forward, false],
    ['Reply in thread', MessageSquareText, false],
    ['Direct Message', MessageCircle, false],
    ['Pin Message', Pin, false],
    ['Select Message', SquareCheckBig, false],
    ['Delete Message', Trash2, true],
    ['Copy Text', Copy, false],
    ['Copy Message Link', Link, false],
    ['Copy Timestamp', Clock, false],
    ['Copy Message ID', Hash, false],
    ['Copy User ID', AtSign, false],
  ])
  expect(row(at(hook), 'Copy Webhook ID')?.icon).toBe(AtSign)
})

const KICK = 'Kick this member? They are removed from the server but can join again.'
const BAN = "Ban this user? They are removed from the server and can't join again until unbanned."
const DELETE =
  'Delete this message for everyone? Hold Shift while clicking the trash icon to skip this.'
const bobRef = user('bob', { display_name: 'Bobby' })

test('each message row does what it did', async () => {
  state({ perms: MOD })
  expect(await effects(items(at(bobs)))).toEqual([
    ['Reply', [['startReply', 'c1', bobs]]],
    ['Forward', [['copyForward', bobs]]],
    ['Reply in thread', [['openThread', bobs]]],
    ['Direct Message', [['startDm', 'bob']]],
    ['Pin Message', [['pinMessage', 11]]],
    [
      'Kick',
      [
        ['askConfirm', 'Kick Member', KICK, 'Kick'],
        ['kickMember', 's', 'bob'],
      ],
    ],
    [
      'Ban from server',
      [
        ['askConfirm', 'Ban from Server', BAN, 'Ban'],
        ['banMember', 's', 'bob'],
      ],
    ],
    ['Time Out', [['openDialog', { kind: 'timeout', server: 's', user: bobRef }]]],
    ['Assign r1', [['assignRole', 's', 1, 'bob']]],
    ['Assign Moderator', [['assignRole', 's', 2, 'bob']]],
    ['Remove Helper', [['unassignRole', 's', 3, 'bob']]],
    ['Add friend', [['askAddFriends', ['bob']]]],
    ['Block', [['askBlock', bobRef]]],
    ['Select Message', [['startSelection', 'c1', bobs]]],
    [
      'Delete Message',
      [
        ['askConfirm', 'Delete Message', DELETE, 'Delete'],
        ['deleteMessage', 11],
      ],
    ],
    ['Copy Text', [['copy', 'm11']]],
    ['Copy Message Link', [['copy', 'https://x.test/s/s/1/11/']]],
    ['Copy Timestamp', [['copy', `<t:${T0 + 11}:F>`]]],
    ['Copy Message ID', [['copy', '11']]],
    ['Copy User ID', [['copy', 'bob']]],
  ])
  state({ perms: MOD })
  expect(await effects(items(at(own)).slice(0, 1))).toEqual([
    ['Edit Message', [['startEdit', 'c1', own]]],
  ])
  expect(await effects([row(at(bobPinned), 'Unpin Message')!])).toEqual([
    ['Unpin Message', [['unpinMessage', 18]]],
  ])
  expect(await effects(items(at(bobPoll)).slice(5, 7))).toEqual([
    ['View Votes', [['openDialog', { kind: 'poll_voters', message: bobPoll }]]],
    ['Close Poll', [['closePoll', 16]]],
  ])
  expect(await effects([row(at(expiredPoll), 'Reopen Poll')!])).toEqual([
    ['Reopen Poll', [['reopenPoll', 22]]],
  ])
  expect(await effects([row(at(hook), 'Copy Webhook ID')!])).toEqual([
    ['Copy Webhook ID', [['copy', '7']]],
  ])
  state({ perms: MOD, bobTimedOut: true })
  expect(await effects([row(at(bobs), 'Remove Timeout')!])).toEqual([
    ['Remove Timeout', [['removeTimeout', 's', 'bob']]],
  ])
  state({ siteAdmin: true, view: 'd9', blocked: ['bob'] })
  expect(await effects(items(at(dmBob)).slice(4, 7))).toEqual([
    ['Unblock', [['unblockUser', 'bob', 'Bobby']]],
    ['Remove backup phrase', [['openDialog', { kind: 'remove_phrase_confirm', username: 'bob' }]]],
    ['Ban site-wide', [['openDialog', { kind: 'ban_confirm', username: 'bob' }]]],
  ])
  expect(await effects([row(at(dmBob), 'Copy Message Link')!])).toEqual([
    ['Copy Message Link', [['copy', 'https://x.test/dm/9/41/']]],
  ])
  state({ thread: root })
  expect(await effects(items(inThread(ownReply)).slice(0, 2))).toEqual([
    ['Edit Message', [['startEdit', 't30', ownReply]]],
    ['Reply', [['startReply', 't30', ownReply]]],
  ])
  expect(await effects([row(inThread(ownReply), 'Select Message')!])).toEqual([
    ['Select Message', [['startSelection', 't30', ownReply]]],
  ])
  expect(await effects([row(inThread(ownReply), 'Copy Message Link')!])).toEqual([
    ['Copy Message Link', [['copy', 'https://x.test/s/s/1/t/30/31/']]],
  ])
})

test('each embed and timestamp row does what it did', async () => {
  state()
  const t: Target = { kind: 'embed', message: withEmbeds, ord: 1, banner: true }
  expect(await effects(items(t))).toEqual([
    ['Remove embed', [['deleteEmbed', 34, 1, false]]],
    ['Remove banner', [['deleteEmbed', 34, 1, true]]],
    [
      'Remove all embeds',
      [
        ['deleteEmbed', 34, 1, false],
        ['deleteEmbed', 34, 2, false],
      ],
    ],
  ])
  state({ guest: true })
  expect(
    await effects(items({ kind: 'timestamp', ts: T0 * 1000, token: '<t:1700000000>' }))
  ).toEqual([['Copy Timestamp', [['copy', '<t:1700000000>']]]])
})

test('messageRights follows the panes: react, edit, quote, forward, delete, pin', () => {
  const rights = (m: Message, list = listOf(m)) => messageRights(useStore.getState(), m, list)
  state()
  expect(rights(own)).toEqual({
    react: true,
    edit: true,
    quote: true,
    forward: true,
    delete: true,
    pin: false,
  })
  expect(rights(bobs)).toMatchObject({ react: true, edit: false, delete: false, pin: false })
  expect(rights(pinNotice)).toMatchObject({ react: true, quote: false, forward: false })
  state({ perms: Perm.DeleteMessages })
  expect(rights(bobs)).toMatchObject({ delete: true, pin: true })
  expect(rights(root, 't30')).toMatchObject({ delete: true, pin: false })
  state({ meTimedOut: true, perms: Perm.DeleteMessages })
  expect(rights(own)).toMatchObject({ react: false, edit: false, forward: true, pin: false })
  state({ view: 'c2' })
  expect(rights(readOnlyBob)).toMatchObject({ react: false, quote: false, forward: true })
  state({ notMember: true })
  expect(rights(bobs)).toMatchObject({ react: false, pin: false })
  state({ view: 'd9' })
  expect(rights(dmBob)).toMatchObject({ react: true, quote: true, pin: true, delete: false })
  state({ guest: true })
  expect(rights(own)).toEqual({
    react: false,
    edit: false,
    quote: false,
    forward: false,
    delete: false,
    pin: false,
  })
})

test('a message deleted while its menu is open runs nothing and says so', async () => {
  state({ perms: MOD })
  const rows = items(at(bobs))
  const calls = recorder()
  useStore.setState(s => ({
    messages: { ...s.messages, c1: s.messages.c1.filter(m => m !== bobs) },
  }))
  for (const label of ['Pin Message', 'Copy Text', 'Kick', 'Delete Message']) {
    rows.find(i => i.label === label)?.action?.()
    await drain()
  }
  expect(calls).toEqual(Array(4).fill(['showToast', "That's no longer available"]))
  state({ perms: MOD })
  const kick = row(at(bobs), 'Kick')!
  const later = recorder()
  useStore.setState({
    memberInfo: { s: { zed: null, bob: null } },
    members: { s: paged([member('alice', { role_ids: [1] })]) },
  })
  kick.action?.()
  await drain()
  expect(later).toEqual([['showToast', "That's no longer available"]])
})

test('a thread root carries its thread key while its panel is open, and is gone once deleted', () => {
  state({ thread: root })
  const c = ctxFor(useStore.getState(), inThread(root), 'menu')
  expect([c.list, c.server, c.channel?.id, c.member?.username]).toEqual(['t30', 's', 1, 'bob'])
  expect(refreshCtx(c)?.message?.id).toBe(30)
  useStore.setState(s => {
    const { t30: _gone, ...rest } = s.messages
    return { panel: null, messages: { ...rest, c1: rest.c1.filter(m => m.id !== 30) } }
  })
  expect(refreshCtx(c)).toBeNull()
})

test('an embed is gone with its message or once removed; its banner once removed', () => {
  state()
  const c = ctxFor(
    useStore.getState(),
    { kind: 'embed', message: withEmbeds, ord: 1, banner: true },
    'menu'
  )
  expect([c.list, c.message?.id, c.server]).toEqual(['c1', 34, 's'])
  const patch = (embeds: Message['embeds']) =>
    useStore.setState(s => ({
      messages: {
        ...s.messages,
        c1: s.messages.c1.map(m => (m.id === 34 ? { ...m, embeds } : m)),
      },
    }))
  patch([{ ...withEmbeds.embeds[0], banner_removed: true }, withEmbeds.embeds[1]])
  expect(refreshCtx(c)?.target).toMatchObject({ kind: 'embed', ord: 1, banner: false })
  patch([withEmbeds.embeds[1]])
  expect(refreshCtx(c)).toBeNull()
  state()
  useStore.setState(s => ({
    messages: { ...s.messages, c1: s.messages.c1.filter(m => m.id !== 34) },
  }))
  expect(refreshCtx(c)).toBeNull()
})

test('message, embed, timestamp and inbox actions stay out of the palette (rule 10)', () => {
  state({ siteAdmin: true, perms: MOD, thread: root })
  useStore.setState({ selection: null })
  const ids = new Set(paletteCommands(paletteCtx(useStore.getState())).map(r => r.id))
  const added = allActions()
    .map(a => a.id)
    .filter(id => /^(message|poll|embed|timestamp|inbox)_/.test(id))
  expect(added.length).toBe(22)
  expect(added.filter(id => ids.has(id))).toEqual([])
})

test('message actions are message scope; each joins its own target kind', () => {
  const byId = Object.fromEntries(allActions().map(a => [a.id, a]))
  const kinds = (prefix: RegExp) =>
    [
      ...new Set(
        allActions()
          .filter(a => prefix.test(a.id))
          .flatMap(a => [a.scope, ...(a.targets ?? [])])
      ),
    ].sort()
  expect(kinds(/^(message|poll)_/)).toEqual(['message'])
  expect(kinds(/^embed_/)).toEqual(['embed', 'message'])
  expect(kinds(/^timestamp_/)).toEqual(['message', 'timestamp'])
  expect(kinds(/^inbox_/)).toEqual(['inbox', 'message'])
  for (const id of ['member_dm', 'member_kick', 'member_roles', 'member_copy_id'])
    expect(byId[id].targets).toEqual(['member', 'message'])
  for (const id of ['member_friend_add', 'member_block', 'member_unblock'])
    expect(byId[id].targets).toEqual(['member', 'dm', 'message'])
  for (const id of ['friend_message', 'friend_remove', 'request_accept', 'request_cancel'])
    expect(byId[id].targets).toEqual(['member'])
  expect(byId.admin_ban_site_wide.targets).toEqual(['member', 'message'])
})

test('runAction on a message target re-checks on fresh state', async () => {
  state({ perms: Perm.DeleteMessages })
  const calls = recorder()
  const c = ctxFor(useStore.getState(), at(bobs), 'menu')
  useStore.setState({ me: me('alice', { servers: [] }) })
  expect(await runAction('message_pin', c)).toBe(false)
  expect(calls).toEqual([['showToast', "That's no longer available"]])
})
