import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import {
  AtSign,
  Bell,
  BellOff,
  Check,
  CheckCheck,
  ExternalLink,
  MessageCircle,
  PinOff,
  UserCheck,
  UserMinus,
  UserPlus,
  UserX,
  X,
} from 'lucide-react'
import { authorItem, banMenuItem, roleMenuItems, timeoutMenuItems } from '../actions/author'
import { ctxFor, paletteCtx } from '../actions/ctx'
import { registerAppActions } from '../actions/index'
import { roleItems } from '../actions/member'
import { menuItems, openActionMenu } from '../actions/menu'
import { paletteCommands } from '../actions/palette'
import { allActions } from '../actions/registry'
import type { MemberWhere, Target } from '../actions/types'
import { blockMenuItem } from '../../components/blocking'
import { friendMenuItem } from '../../components/friends'
import { emptyLayout } from '../nav_layout'
import { EMPTY_NOTIFY, setLevel, setMute } from '../notify'
import { setSharing, sharing } from '../platform'
import { resetSessionCaches, useStore, type ConfirmRequest, type ContextMenuItem } from '../store'
import type { RChatState } from '../store_types'
import { Perm, type DmSummary, type Member, type UserRef } from '../types'
import { drain, me, member, paged, role, serverDetail, user } from './fixtures'

const realSharing = sharing()
const g = globalThis as { window?: unknown }
const realWindow = g.window
const initial = useStore.getState()

beforeAll(registerAppActions)

afterEach(() => {
  setSharing(realSharing)
  g.window = realWindow
  useStore.setState(initial, true)
})

afterAll(resetSessionCaches)

const HOUR = 3_600_000
const bobby = user('bob', { display_name: 'Bobby' })
const bobDm: DmSummary = { id: 9, other: bobby, is_self: false }
const selfDm: DmSummary = { id: 4, other: user('alice'), is_self: true }

interface State {
  perms?: number
  siteAdmin?: boolean
  owner?: boolean
  guest?: boolean
  bob?: Partial<Member>
  timedOut?: boolean
  blocked?: string[]
  friends?: string[]
  incoming?: string[]
  outgoing?: string[]
  pinned?: number[]
  unread?: string[]
  notify?: RChatState['notifyPrefs']
}

// Alice in server s: her role r1 carries `perms`; bob holds Helper (r3); Moderator (r2) is free.
const state = (o: State = {}) => {
  const roles = [
    role(1, '#f00', o.perms ?? 0),
    { ...role(2, '#0f0', 0), name: 'Moderator' },
    { ...role(3, '#00f', 0), name: 'Helper' },
  ]
  useStore.setState({
    token: o.guest ? null : 'tok',
    guest: !!o.guest,
    me: o.guest
      ? null
      : me('alice', {
          is_site_admin: !!o.siteAdmin,
          servers: [{ name: 's', display_name: 'Space', creator: null, is_admin: !!o.owner }],
        }),
    servers: { s: serverDetail('s', { display_name: 'Space', roles }) },
    members: {
      s: paged([
        member('alice', { role_ids: [1], is_admin: !!o.owner }),
        member('bob', { display_name: 'Bobby', role_ids: [3], ...o.bob }),
      ]),
    },
    interacted: { s: paged([user('zed')]) },
    timeouts: o.timedOut ? { s: { bob: { ends: Date.now() + HOUR, reason: null } } } : {},
    blocked: Object.fromEntries((o.blocked ?? []).map(n => [n, true])),
    friends: paged((o.friends ?? []).map(n => ({ user: user(n), since: 1, online: false }))),
    incomingRequests: paged(
      (o.incoming ?? []).map(n => ({ user: user(n), created_at: 1, incoming: true }))
    ),
    outgoingRequests: paged(
      (o.outgoing ?? []).map(n => ({ user: user(n), created_at: 1, incoming: false }))
    ),
    dms: [bobDm, selfDm],
    layout: { ...emptyLayout, dmPinned: o.pinned ?? [] },
    reads: Object.fromEntries((o.unread ?? []).map(k => [k, { latest: 5, lastRead: 1 }])),
    notifyPrefs: o.notify ?? EMPTY_NOTIFY,
    view: { kind: 'channel', server: 's', channelId: 1 },
  })
}

const memberRow = (name: string) =>
  useStore.getState().members.s.list.find(m => m.username === name) ?? user(name)
const at = (name: string, where: MemberWhere = 'list', server: string | null = 's'): Target => ({
  kind: 'member',
  user: memberRow(name),
  server,
  where,
})
const dmAt = (dm: DmSummary, where: 'sidebar' | 'home' = 'sidebar'): Target => ({
  kind: 'dm',
  dm,
  where,
})
const items = (t: Target) => menuItems(ctxFor(useStore.getState(), t, 'menu'))
const labels = (t: Target) => items(t).map(i => i.label)
const row = (t: Target, label: string) => items(t).find(i => i.label === label)

const DM = 'Direct Message'
const COPY = 'Copy User ID'

test('member list, plain member', () => {
  state()
  expect(labels(at('bob'))).toEqual([DM, 'Add friend', 'Block', COPY])
})

test('member list, moderator: kick, ban and time out after DM', () => {
  state({ perms: Perm.Kick | Perm.TimeoutMembers })
  expect(labels(at('bob'))).toEqual([
    DM,
    'Kick',
    'Ban from server',
    'Time Out',
    'Add friend',
    'Block',
    COPY,
  ])
  state({ perms: Perm.Kick, bob: { role_ids: [1] } })
  expect(labels(at('bob'))).toEqual([DM, 'Add friend', 'Block', COPY])
})

test('member list, admin actions', () => {
  state({ perms: Perm.ManageAdmins | Perm.Kick, bob: { is_admin: true, perms: Perm.Kick } })
  expect(labels(at('bob'))).toEqual([
    DM,
    'Kick',
    'Ban from server',
    'Revoke Admin',
    'Transfer Admin',
    'Assign Role',
    'Add friend',
    'Block',
    COPY,
  ])
  state({ owner: true, bob: { is_admin: true, perms: Perm.Kick } })
  expect(labels(at('bob'))).toEqual([
    DM,
    'Kick',
    'Ban from server',
    'Time Out',
    'Revoke Admin',
    'Transfer Admin',
    'Assign Role',
    'Add friend',
    'Block',
    COPY,
  ])
  state({ owner: true })
  expect(labels(at('bob'))).toEqual([
    DM,
    'Kick',
    'Ban from server',
    'Time Out',
    'Promote to Admin',
    'Transfer Admin',
    'Assign Role',
    'Add friend',
    'Block',
    COPY,
  ])
})

test('member list, a timed-out member: Change Timeout, then Remove Timeout', () => {
  state({ perms: Perm.TimeoutMembers, timedOut: true })
  expect(items(at('bob')).map(i => [i.label, !!i.danger])).toEqual([
    [DM, false],
    ['Change Timeout', false],
    ['Remove Timeout', true],
    ['Add friend', false],
    ['Block', true],
    [COPY, false],
  ])
  state({ perms: Perm.TimeoutMembers })
  expect(row(at('bob'), 'Time Out')?.danger).toBe(true)
})

test('member list, yourself', () => {
  state()
  expect(labels(at('alice'))).toEqual([DM, COPY])
  state({ owner: true })
  expect(labels(at('alice'))).toEqual([DM, 'Revoke Admin', 'Assign Role', COPY])
  state({ perms: Perm.ManageAdmins | Perm.Kick | Perm.TimeoutMembers })
  expect(labels(at('alice'))).toEqual([DM, 'Assign Role', COPY])
})

test('member list, the hidden site admin', () => {
  state({ siteAdmin: true })
  expect(labels(at('bob'))).toEqual([
    DM,
    'Kick',
    'Ban from server',
    'Time Out',
    'Promote to Admin',
    'Transfer Admin',
    'Assign Role',
    'Add friend',
    'Block',
    'Ban site-wide',
    COPY,
  ])
  expect(labels(at('alice'))).toEqual([DM, 'Promote to Admin', 'Assign Role', COPY])
})

test('member list, someone blocked, a friend or asking to be one', () => {
  state({ blocked: ['bob'] })
  expect(labels(at('bob'))).toEqual([DM, 'Unblock', COPY])
  state({ friends: ['bob'] })
  expect(labels(at('bob'))).toEqual([DM, 'Block', COPY])
  state({ incoming: ['bob'] })
  expect(labels(at('bob'))).toEqual([DM, 'Block', COPY])
})

test('Assign Role is a submenu now (rule 2)', () => {
  state({ owner: true })
  const roles = row(at('bob'), 'Assign Role')
  expect(roles?.action).toBeUndefined()
  expect(roles?.submenu?.map(i => [i.label, !!i.danger])).toEqual([
    ['Assign r1', false],
    ['Assign Moderator', false],
    ['Remove Helper', true],
  ])
})

test('guests get no member menu; Ban site-wide only for the site admin', () => {
  state({ guest: true })
  expect(labels(at('bob'))).toEqual([])
  expect(labels(at('zed', 'interacted', null))).toEqual([])
  let opened = 0
  useStore.setState({ openContextMenu: () => void opened++ })
  openActionMenu(1, 2, at('bob'))
  expect(opened).toBe(0)
  state()
  expect(labels(at('bob'))).not.toContain('Ban site-wide')
  state({ siteAdmin: true })
  expect(labels(at('bob'))).toContain('Ban site-wide')
  expect(labels(at('zed', 'interacted', null))).not.toContain('Ban site-wide')
})

test('interacted rows: DM, friend, block and copy, never moderation', () => {
  const zed = () => at('zed', 'interacted', null)
  state({ perms: Perm.Kick | Perm.ManageAdmins | Perm.TimeoutMembers, siteAdmin: true })
  expect(labels(zed())).toEqual([DM, 'Add friend', 'Block', COPY])
  state({ blocked: ['zed'] })
  expect(labels(zed())).toEqual([DM, 'Unblock', COPY])
  state({ friends: ['zed'] })
  expect(labels(zed())).toEqual([DM, 'Block', COPY])
})

test('friend and request rows', () => {
  state({ friends: ['dave'] })
  const dave = at('dave', 'friend', null)
  expect(items(dave).map(i => [i.label, i.icon, !!i.danger])).toEqual([
    ['Message', MessageCircle, false],
    ['Remove friend', UserMinus, true],
    ['Block', UserX, true],
    [COPY, AtSign, false],
  ])
  state({ friends: ['dave'], blocked: ['dave'] })
  expect(labels(dave)).toEqual(['Message', 'Remove friend', 'Unblock', COPY])
  state({ incoming: ['carol'] })
  expect(items(at('carol', 'request', null)).map(i => [i.label, i.icon])).toEqual([
    ['Accept', Check],
    ['Deny', X],
    ['Block', UserX],
  ])
  state({ incoming: ['carol'], blocked: ['carol'] })
  expect(labels(at('carol', 'request', null))).toEqual(['Accept', 'Deny', 'Unblock'])
  state({ outgoing: ['frank'] })
  expect(items(at('frank', 'request', null)).map(i => [i.label, i.icon])).toEqual([
    ['Cancel request', X],
    ['Block', UserX],
  ])
})

test('a sidebar DM, unpinned and pinned', () => {
  state()
  expect(items(dmAt(bobDm)).map(i => [i.label, !!i.disabled])).toEqual([
    ['Mark as read', true],
    ['Mute DM', false],
    ['Notification settings', false],
    ['Pin DM', false],
    ['Close DM', false],
    ['Add friend', false],
    ['Block', false],
    ['Copy DM ID', false],
    [COPY, false],
  ])
  state({ pinned: [9], unread: ['d9'] })
  expect(items(dmAt(bobDm)).map(i => [i.label, !!i.disabled])).toEqual([
    ['Mark as read', false],
    ['Mute DM', false],
    ['Notification settings', false],
    ['Unpin DM', false],
    ['Close DM', false],
    ['Add friend', false],
    ['Block', false],
    ['Copy DM ID', false],
    [COPY, false],
  ])
  state({ friends: ['bob'] })
  expect(labels(dmAt(bobDm))).not.toContain('Add friend')
  state({ blocked: ['bob'] })
  expect(labels(dmAt(bobDm))).toContain('Unblock')
  state({ pinned: [4] })
  expect(labels(dmAt(selfDm))).toEqual([
    'Mark as read',
    'Mute DM',
    'Notification settings',
    'Unpin DM',
    'Close DM',
    'Copy DM ID',
    COPY,
  ])
})

test('a sidebar DM: mute durations, unmute, and the level radios', () => {
  state()
  const mute = row(dmAt(bobDm), 'Mute DM')
  expect([mute?.icon, mute?.subtitle]).toEqual([BellOff, undefined])
  expect(mute?.submenu?.map(i => i.label)).toEqual([
    '15 minutes',
    '1 hour',
    '3 hours',
    '8 hours',
    '24 hours',
    'Until I turn it back on',
  ])
  const scope = { kind: 'dm', id: 9 } as const
  state({ notify: setLevel(setMute(EMPTY_NOTIFY, scope, 'forever'), scope, 'mentions') })
  const unmute = row(dmAt(bobDm), 'Unmute DM')
  expect([unmute?.icon, unmute?.subtitle, unmute?.submenu]).toEqual([
    Bell,
    'Muted until you turn it back on',
    undefined,
  ])
  const level = row(dmAt(bobDm), 'Notification settings')
  expect(level?.subtitle).toBe('Only @mentions')
  expect(level?.submenu?.map(i => [i.label, i.radio, i.checked])).toEqual([
    ['All messages', true, false],
    ['Only @mentions', true, true],
    ['Nothing', true, false],
  ])
})

test('a home pinned DM', () => {
  state({ pinned: [9] })
  expect(items(dmAt(bobDm, 'home')).map(i => [i.label, i.icon, !!i.disabled])).toEqual([
    ['Open', ExternalLink, false],
    ['Mark as read', CheckCheck, true],
    ['Unpin DM', PinOff, false],
  ])
  state({ pinned: [9], unread: ['d9'] })
  expect(row(dmAt(bobDm, 'home'), 'Mark as read')?.disabled).toBe(false)
})

test('one definition per behaviour: unified icons and danger (rule 2)', () => {
  state({ owner: true, bob: { is_admin: true, perms: Perm.Kick } })
  const list = items(at('bob'))
  const byLabel = (rows: ContextMenuItem[], label: string) => rows.find(i => i.label === label)
  expect(byLabel(list, DM)?.icon).toBe(MessageCircle)
  expect(byLabel(list, COPY)?.icon).toBe(AtSign)
  expect(byLabel(list, 'Revoke Admin')?.danger).toBe(true)
  expect([byLabel(list, 'Add friend')?.icon, byLabel(list, 'Block')?.icon]).toEqual([
    UserPlus,
    UserX,
  ])
  state({ pinned: [9], blocked: ['bob'] })
  const dm = items(dmAt(bobDm))
  expect(byLabel(dm, COPY)?.icon).toBe(AtSign)
  expect(byLabel(dm, 'Unpin DM')?.icon).toBe(PinOff)
  expect(byLabel(dm, 'Close DM')?.icon).toBe(X)
  expect(byLabel(dm, 'Mark as read')?.icon).toBe(CheckCheck)
  expect(byLabel(dm, 'Unblock')?.icon).toBe(UserCheck)
  expect(byLabel(dm, 'Pin DM')).toBeUndefined()
})

type Call = unknown[]

// Records the store calls, copies and confirms (accepted) each row makes.
const recorder = () => {
  const calls: Call[] = []
  const names = [
    'startDm',
    'openDialog',
    'grantAdmin',
    'revokeAdmin',
    'transferAdmin',
    'kickMember',
    'banMember',
    'removeTimeout',
    'assignRole',
    'unassignRole',
    'askAddFriends',
    'askBlock',
    'unblockUser',
    'askRemoveFriend',
    'acceptFriend',
    'denyFriend',
    'cancelFriendRequest',
    'closePanel',
    'pinDm',
    'unpinDm',
    'closeDm',
    'markScopesRead',
    'muteScope',
    'setNotifyLevel',
    'openDm',
    'showToast',
  ]
  const ref = (v: unknown) =>
    v && typeof v === 'object' && 'avatar_kind' in v
      ? (({ username, display_name }: UserRef) => ({ username, display_name }))(v as UserRef)
      : v
  useStore.setState({
    ...Object.fromEntries(
      names.map(n => [
        n,
        (...a: unknown[]) => {
          calls.push([n, ...a.map(ref)])
          return Promise.resolve()
        },
      ])
    ),
    askConfirm: (c: ConfirmRequest) => {
      calls.push(['askConfirm', c.title, c.body, c.confirm])
      c.action('')
    },
  })
  setSharing({ ...realSharing, copyText: async t => (calls.push(['copy', t]), true) })
  g.window = { matchMedia: () => ({ matches: false }) }
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

const bobRef = { username: 'bob', display_name: 'Bobby' }
const KICK = 'Kick this member? They are removed from the server but can join again.'
const BAN = "Ban this user? They are removed from the server and can't join again until unbanned."
const TRANSFER =
  'Make this member the server admin? You lose your own admin rights and cannot take them back yourself.'

test('each member row does what it did', async () => {
  state({ siteAdmin: true, bob: { is_admin: true, perms: Perm.Kick } })
  expect(await effects(items(at('bob')))).toEqual([
    [DM, [['startDm', 'bob']]],
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
    ['Time Out', [['openDialog', { kind: 'timeout', server: 's', user: bobby }]]],
    ['Revoke Admin', [['revokeAdmin', 's', 'bob']]],
    [
      'Transfer Admin',
      [
        ['askConfirm', 'Transfer Admin', TRANSFER, 'Transfer'],
        ['transferAdmin', 's', 'bob'],
      ],
    ],
    ['Assign r1', [['assignRole', 's', 1, 'bob']]],
    ['Assign Moderator', [['assignRole', 's', 2, 'bob']]],
    ['Remove Helper', [['unassignRole', 's', 3, 'bob']]],
    ['Add friend', [['askAddFriends', ['bob']]]],
    ['Block', [['askBlock', bobRef]]],
    ['Ban site-wide', [['openDialog', { kind: 'ban_confirm', username: 'bob' }]]],
    [COPY, [['copy', 'bob']]],
  ])
  state({ owner: true, timedOut: true })
  const timeout = items(at('bob')).filter(
    i => i.label.includes('Timeout') || i.label === 'Promote to Admin'
  )
  expect(await effects(timeout)).toEqual([
    ['Change Timeout', [['openDialog', { kind: 'timeout', server: 's', user: bobby }]]],
    ['Remove Timeout', [['removeTimeout', 's', 'bob']]],
    ['Promote to Admin', [['grantAdmin', 's', 'bob']]],
  ])
  state({ owner: true })
  expect(await effects([row(at('alice'), 'Revoke Admin')!])).toEqual([
    [
      'Revoke Admin',
      [
        [
          'askConfirm',
          'Revoke Admin',
          'Remove your own admin rights? Another admin has to give them back.',
          'Revoke',
        ],
        ['revokeAdmin', 's', 'alice'],
      ],
    ],
  ])
  state({ blocked: ['zed'] })
  expect(await effects(items(at('zed', 'interacted', null)))).toEqual([
    [DM, [['startDm', 'zed']]],
    ['Unblock', [['unblockUser', 'zed', 'zed']]],
    [COPY, [['copy', 'zed']]],
  ])
})

test('each friend, request and DM row does what it did', async () => {
  const dave = { username: 'dave', display_name: 'dave' }
  state({ friends: ['dave'] })
  expect(await effects(items(at('dave', 'friend', null)))).toEqual([
    ['Message', [['startDm', 'dave']]],
    ['Remove friend', [['askRemoveFriend', dave]]],
    ['Block', [['askBlock', dave]]],
    [COPY, [['copy', 'dave']]],
  ])
  const carol = { username: 'carol', display_name: 'carol' }
  state({ incoming: ['carol'], outgoing: ['frank'] })
  expect(await effects(items(at('carol', 'request', null)))).toEqual([
    ['Accept', [['acceptFriend', carol]]],
    ['Deny', [['denyFriend', 'carol']]],
    ['Block', [['askBlock', carol]]],
  ])
  expect(await effects(items(at('frank', 'request', null)).slice(0, 1))).toEqual([
    ['Cancel request', [['cancelFriendRequest', 'frank']]],
  ])
  const scope = { kind: 'dm', id: 9 }
  state({ unread: ['d9'] })
  const sidebar = await effects(items(dmAt(bobDm)))
  expect(sidebar.filter(([label]) => !/^\d|^Until/.test(label))).toEqual([
    ['Mark as read', [['markScopesRead', ['d9']]]],
    ['All messages', [['setNotifyLevel', scope, 'all']]],
    ['Only @mentions', [['setNotifyLevel', scope, 'mentions']]],
    ['Nothing', [['setNotifyLevel', scope, 'nothing']]],
    ['Pin DM', [['pinDm', 9]]],
    ['Close DM', [['closeDm', 9]]],
    ['Add friend', [['askAddFriends', ['bob']]]],
    ['Block', [['askBlock', bobRef]]],
    ['Copy DM ID', [['copy', '9']]],
    [COPY, [['copy', 'bob']]],
  ])
  const before = Date.now()
  const mutes = sidebar.filter(([label]) => /^\d|^Until/.test(label))
  expect(mutes.map(([label, calls]) => [label, calls.length, calls[0][0], calls[0][1]])).toEqual(
    ['15 minutes', '1 hour', '3 hours', '8 hours', '24 hours', 'Until I turn it back on'].map(l => [
      l,
      1,
      'muteScope',
      scope,
    ])
  )
  const ends = mutes.map(([, calls]) => calls[0][2])
  expect(ends.at(-1)).toBe('forever')
  expect(ends.slice(0, 5).map(t => Math.round(((t as number) - before) / 60_000 / 5) * 5)).toEqual([
    15, 60, 180, 480, 1440,
  ])
  state({ pinned: [9], notify: setMute(EMPTY_NOTIFY, { kind: 'dm', id: 9 }, 'forever') })
  expect(await effects([row(dmAt(bobDm), 'Unmute DM')!, row(dmAt(bobDm), 'Unpin DM')!])).toEqual([
    ['Unmute DM', [['muteScope', scope, null]]],
    ['Unpin DM', [['unpinDm', 9]]],
  ])
  expect(await effects(items(dmAt(bobDm, 'home')))).toEqual([
    ['Open', [['openDm', 9]]],
    ['Mark as read', [['markScopesRead', ['d9']]]],
    ['Unpin DM', [['unpinDm', 9]]],
  ])
})

test("a friend's Message closes the full screen panel on a narrow screen first", async () => {
  state({ friends: ['dave'] })
  const message = row(at('dave', 'friend', null), 'Message')!
  const calls = recorder()
  g.window = { matchMedia: (q: string) => ({ matches: q === '(max-width: 767px)' }) }
  message.action?.()
  await drain()
  expect(calls).toEqual([['closePanel'], ['startDm', 'dave']])
})

test('a member, friend, request or DM gone before its row runs runs nothing and says so', async () => {
  state({ owner: true, friends: ['dave'], incoming: ['carol'], pinned: [9] })
  const kick = row(at('bob'), 'Kick')!
  const message = row(at('dave', 'friend', null), 'Message')!
  const accept = row(at('carol', 'request', null), 'Accept')!
  const close = row(dmAt(bobDm), 'Close DM')!
  const roles = row(at('bob'), 'Assign Role')!.submenu!
  const calls = recorder()
  useStore.setState({
    members: { s: paged([member('alice', { role_ids: [1], is_admin: true })]) },
    memberInfo: { s: { bob: null } },
    friends: paged([]),
    incomingRequests: paged([]),
    dms: [selfDm],
  })
  for (const r of [kick, message, accept, close, ...roles]) {
    r.action?.()
    await drain()
  }
  expect(calls).toEqual(
    Array.from({ length: 7 }, () => ['showToast', "That's no longer available"])
  )
})

test('a role that can no longer be changed is not changed', async () => {
  state({ owner: true })
  const [assign] = row(at('bob'), 'Assign Role')!.submenu!
  const calls = recorder()
  useStore.setState({ servers: { s: serverDetail('s', { roles: [] }) } })
  assign.action?.()
  await drain()
  expect(calls).toEqual([['showToast', "That's no longer available"]])
})

test('a stale role row runs nothing, a fresh one still does', async () => {
  state({ owner: true })
  const [r1, moderator, helper] = row(at('bob'), 'Assign Role')!.submenu!
  const calls = recorder()
  useStore.setState({
    servers: {
      s: serverDetail('s', {
        roles: [role(1, '#f00', 0), { ...role(3, '#00f', 0), name: 'Helper' }],
      }),
    },
  })
  for (const r of [moderator, r1, helper]) {
    r.action?.()
    await drain()
  }
  expect(calls).toEqual([
    ['showToast', "That's no longer available"],
    ['assignRole', 's', 1, 'bob'],
    ['unassignRole', 's', 3, 'bob'],
  ])
})

test('a role row whose role was given or taken since it opened runs nothing and says so', async () => {
  const holds = (role_ids: number[]) =>
    useStore.setState({
      members: {
        s: paged([
          member('alice', { role_ids: [1], is_admin: true }),
          member('bob', { display_name: 'Bobby', role_ids }),
        ]),
      },
    })
  const surfaces = [
    () => row(at('bob'), 'Assign Role')!.submenu!,
    () => roleMenuItems('s', 'bob'),
    () => roleItems('s', bobby),
  ]
  const pick = (rows: ContextMenuItem[], label: string) => rows.find(i => i.label === label)!
  for (const surface of surfaces)
    for (const [stale, now, fresh, effect] of [
      ['Assign Moderator', [2, 3], 'Remove Moderator', ['unassignRole', 's', 2, 'bob']],
      ['Remove Helper', [], 'Assign Helper', ['assignRole', 's', 3, 'bob']],
    ] as const) {
      state({ owner: true })
      const old = pick(surface(), stale)
      const calls = recorder()
      holds([...now])
      old.action?.()
      await drain()
      pick(surface(), fresh).action?.()
      await drain()
      expect(calls).toEqual([['showToast', "That's no longer available"], [...effect]])
    }
})

test('an online member known only from memberInfo gets the rows of a listed one', async () => {
  const shape = (rows: ContextMenuItem[]) =>
    rows.map(i => [i.label, !!i.danger, i.submenu?.map(r => [r.label, !!r.danger])])
  for (const o of [
    { siteAdmin: true, bob: { is_admin: true, perms: Perm.Kick, online: true } },
    { owner: true, timedOut: true, bob: { online: true } },
    { perms: Perm.Kick | Perm.TimeoutMembers, bob: { online: true } },
  ]) {
    state(o)
    const listed = items(at('bob'))
    const did = await effects(listed)
    const bob = memberRow('bob') as Member
    useStore.setState(s => ({
      members: { s: { ...s.members.s, list: s.members.s.list.filter(m => m !== bob) } },
      memberInfo: { s: { bob } },
    }))
    const known = items({ kind: 'member', user: bob, server: 's', where: 'list' })
    expect(shape(known)).toEqual(shape(listed))
    expect(await effects(known)).toEqual(did)
  }
})

test('moderation is not offered on an author who left', () => {
  state({ owner: true })
  useStore.setState({
    members: { s: paged([member('alice', { role_ids: [1], is_admin: true })]) },
    memberInfo: { s: { bob: null } },
  })
  expect(banMenuItem('s', 'bob')).toBeNull()
  expect(timeoutMenuItems('s', bobby)).toEqual([])
  expect(authorItem('member_kick', bobby, 's')).toBeNull()
})

test('member and DM actions stay out of the palette until it has a target (rule 10)', () => {
  state({ siteAdmin: true, owner: true, friends: ['bob'], pinned: [9] })
  useStore.setState({ view: { kind: 'dm', dmId: 9 } })
  const ids = new Set(paletteCommands(paletteCtx(useStore.getState())).map(r => r.id))
  const added = allActions()
    .map(a => a.id)
    .filter(id => /^(member|friend|request|dm|admin)_/.test(id))
  expect(added.length).toBeGreaterThan(20)
  expect(added.filter(id => ids.has(id))).toEqual([])
  const rows = paletteCommands(paletteCtx(useStore.getState()))
  const pick = (id: string) => rows.find(r => r.id === id)
  expect([pick('close_dm')?.title, pick('close_dm')?.icon]).toEqual(['Close this DM', X])
  expect([pick('mark_read_here')?.title, pick('mark_read_here')?.icon]).toEqual([
    'Mark this DM as read',
    Check,
  ])
  expect(pick('mute_here')?.title).toBe('Mute this DM')
  expect(pick('mute_here')?.subtitle).toBeUndefined()
})

test('the member actions are member scope, the site ban admin scope, the DM ones dm scope', () => {
  const scopes = Object.fromEntries(allActions().map(a => [a.id, a.scope]))
  for (const id of ['member_dm', 'member_kick', 'member_roles', 'friend_message', 'request_cancel'])
    expect(scopes[id]).toBe('member')
  expect(scopes.admin_ban_site_wide).toBe('admin')
  for (const id of ['dm_open', 'dm_pin', 'dm_unpin', 'close_dm', 'dm_copy_id', 'dm_copy_user_id'])
    expect(scopes[id]).toBe('dm')
})

test('a DM target carries its list key and its other person', () => {
  state()
  const c = ctxFor(useStore.getState(), dmAt(bobDm), 'menu')
  expect([c.dm?.id, c.list, c.member?.username]).toEqual([9, 'd9', 'bob'])
})

test('the helpers the message panes still use keep their rows (until C4)', () => {
  state({ perms: Perm.Kick | Perm.TimeoutMembers | Perm.ManageAdmins })
  expect(banMenuItem('s', 'bob')?.label).toBe('Ban from server')
  expect(timeoutMenuItems('s', bobby).map(i => i.label)).toEqual(['Time Out'])
  expect(roleMenuItems('s', 'bob').map(i => i.label)).toEqual([
    'Assign r1',
    'Assign Moderator',
    'Remove Helper',
  ])
  expect(roleItems('s', bobby).map(i => i.label)).toEqual(
    roleMenuItems('s', 'bob').map(i => i.label)
  )
  expect([friendMenuItem(bobby)?.label, blockMenuItem(bobby)?.label]).toEqual([
    'Add friend',
    'Block',
  ])
  state({ owner: true, timedOut: true, blocked: ['bob'] })
  expect(timeoutMenuItems('s', bobby).map(i => i.label)).toEqual([
    'Change Timeout',
    'Remove Timeout',
  ])
  expect([friendMenuItem(bobby), blockMenuItem(bobby)?.label]).toEqual([null, 'Unblock'])
  expect([friendMenuItem(user('alice')), blockMenuItem(user('alice'))]).toEqual([null, null])
  state({ guest: true })
  expect([friendMenuItem(bobby), blockMenuItem(bobby), banMenuItem('s', 'bob')]).toEqual([
    null,
    null,
    null,
  ])
})
