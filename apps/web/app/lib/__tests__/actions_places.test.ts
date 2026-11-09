import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { Bell, BellOff, CheckCheck, ExternalLink, LogOut, Trash2 } from 'lucide-react'
import { ctxFor, paletteCtx } from '../actions/ctx'
import { registerAppActions } from '../actions/index'
import { menuItems } from '../actions/menu'
import { paletteCommands } from '../actions/palette'
import { actionById } from '../actions/registry'
import type { Target } from '../actions/types'
import { useChannelEdit } from '../channel_edit'
import { P2P_IP_HINT } from '../call_choice'
import { emptyLayout, type Folder } from '../nav_layout'
import { EMPTY_NOTIFY, setLevel, setMute, setSuppress, type NotifyPrefs } from '../notify'
import { setSharing, sharing } from '../platform'
import { resetSessionCaches, useStore, type ConfirmRequest, type ContextMenuItem } from '../store'
import { Perm, type Channel, type DmSummary } from '../types'
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
  useChannelEdit.getState().stop()
})

afterAll(resetSessionCaches)

const general: Channel = { id: 1, name: 'general', kind: 'text', slowmode_seconds: 0 }
const random: Channel = {
  id: 2,
  name: 'random',
  kind: 'text',
  slowmode_seconds: 0,
  category_id: 7,
}
const talk: Channel = { id: 3, name: 'talk', kind: 'voice', slowmode_seconds: 0 }
const chat = { id: 7, name: 'Chat', position: 0 }

interface State {
  perms?: number
  guest?: boolean
  unread?: boolean
  notify?: NotifyPrefs
  channels?: Channel[]
}

// Alice in Space (s) and the rchat server; her role r1 carries `perms`. `unread`: #general has
// news.
const railState = (o: State = {}) => {
  const joined = [
    { name: 's', display_name: 'Space', creator: null, is_admin: false },
    { name: 'rchat', display_name: 'RChat', creator: null, is_admin: false },
    { name: 'b', display_name: 'Base', creator: null, is_admin: false },
  ]
  useStore.setState({
    token: o.guest ? null : 'tok',
    guest: !!o.guest,
    me: o.guest ? null : me('alice', { servers: joined }),
    guestServers: o.guest ? ['s', 'rchat'] : [],
    servers: {
      s: serverDetail('s', {
        display_name: 'Space',
        roles: [role(1, '#f00', o.perms ?? 0)],
        channels: o.channels ?? [general, random, talk],
        categories: [chat],
      }),
    },
    members: { s: paged([member('alice', { role_ids: [1] })]) },
    reads: o.unread ? { c1: { lastRead: 1, latest: 5, server: 's' } } : {},
    pings: {},
    notifyPrefs: o.notify ?? EMPTY_NOTIFY,
    layout: emptyLayout,
    view: { kind: 'channel', server: 's', channelId: 1 },
  })
}

const items = (t: Target) => menuItems(ctxFor(useStore.getState(), t, 'menu'))
const labels = (t: Target) => items(t).map(i => i.label)
const row = (t: Target, label: string) => items(t).find(i => i.label === label)
const serverAt = (server: string, folder: string | null = null, at = 0): Target => ({
  kind: 'server',
  server,
  folder,
  at,
})
const channelAt = (c: Channel): Target => ({ kind: 'channel', server: 's', channel: c })
const categoryAt: Target = { kind: 'category', server: 's', category: chat }
const folder: Folder = { id: 'f1', name: 'Work', servers: ['s', 'b'], open: false }
const folderAt: Target = { kind: 'folder', folder }

type Call = unknown[]

// The P2P part of mark all, and a mute end (a timestamp), as stable values.
const arg = (x: unknown) =>
  x && typeof x === 'object' && 'mark' in x
    ? 'p2p'
    : typeof x === 'number' && x > Date.now()
      ? 'later'
      : x

// Records the store calls, copies and confirms (accepted) each row makes.
const recorder = () => {
  const calls: Call[] = []
  const names = [
    'openDialog',
    'markServerRead',
    'markServersRead',
    'markScopesRead',
    'muteScope',
    'muteServers',
    'setNotifyLevel',
    'setNotifySuppress',
    'moveServer',
    'leaveServer',
    'joinPreview',
    'ungroupFolder',
    'deleteChannel',
    'deleteCategory',
    'setCategoriesCollapsed',
    'askMarkAllRead',
    'setCallRoute',
    'startCall',
    'startP2pCall',
  ]
  useStore.setState({
    ...Object.fromEntries(
      names.map(n => [
        n,
        (...a: unknown[]) => {
          calls.push([n, ...a.map(arg)])
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
  g.window = {
    location: { origin: 'https://chat.test', protocol: 'https:' },
    matchMedia: () => ({ matches: false }),
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

test('server icon, member', () => {
  railState({ perms: 0 })
  expect(labels(serverAt('s', null, 0))).toEqual([
    'Mark as read',
    'Mute Server',
    'Notification settings',
    'Copy invite link',
    'Copy Server ID',
    'Leave Server',
  ])
  expect(row(serverAt('s'), 'Mark as read')).toMatchObject({ icon: CheckCheck, disabled: true })
  railState({ unread: true })
  expect(row(serverAt('s'), 'Mark as read')?.disabled).toBe(false)
  const leave = row(serverAt('s'), 'Leave Server')
  expect([leave?.icon, leave?.danger]).toEqual([LogOut, true])
})

test('server icon: a channel manager, inside a folder, and the rchat server', () => {
  railState({ perms: Perm.ManageChannels })
  expect(labels(serverAt('s', 'f1', 3))).toEqual([
    'Mark as read',
    'Mute Server',
    'Notification settings',
    'Create category',
    'Copy invite link',
    'Copy Server ID',
    'Remove from folder',
    'Leave Server',
  ])
  railState()
  expect(labels(serverAt('rchat'))).toEqual([
    'Mark as read',
    'Mute Server',
    'Notification settings',
    'Copy invite link',
    'Copy Server ID',
  ])
})

test('server icon while signed out, and the previewed server', () => {
  railState({ guest: true })
  expect(labels(serverAt('s'))).toEqual([
    'Mute Server',
    'Notification settings',
    'Copy invite link',
    'Copy Server ID',
    'Leave Server',
  ])
  railState()
  useStore.setState({ view: { kind: 'channel', server: 'p', channelId: 9 } })
  expect(labels(serverAt('p'))).toEqual(['Join Server', 'Copy Server ID'])
})

test('server rows do what the old menu did', async () => {
  railState({ perms: Perm.ManageChannels })
  const out = await effects(items(serverAt('s', 'f1', 3)))
  expect(out).toEqual([
    ['Mark as read', [['markServerRead', 's']]],
    ['15 minutes', [['muteScope', { kind: 'server', name: 's' }, 'later']]],
    ['1 hour', [['muteScope', { kind: 'server', name: 's' }, 'later']]],
    ['3 hours', [['muteScope', { kind: 'server', name: 's' }, 'later']]],
    ['8 hours', [['muteScope', { kind: 'server', name: 's' }, 'later']]],
    ['24 hours', [['muteScope', { kind: 'server', name: 's' }, 'later']]],
    ['Until I turn it back on', [['muteScope', { kind: 'server', name: 's' }, 'forever']]],
    ['All messages', [['setNotifyLevel', { kind: 'server', name: 's' }, 'all']]],
    ['Only @mentions', [['setNotifyLevel', { kind: 'server', name: 's' }, 'mentions']]],
    ['Nothing', [['setNotifyLevel', { kind: 'server', name: 's' }, 'nothing']]],
    ['Suppress @everyone and @here', [['setNotifySuppress', 's', 'everyone', true]]],
    ['Suppress role mentions', [['setNotifySuppress', 's', 'roles', true]]],
    ['Create category', [['openDialog', { kind: 'category', server: 's' }]]],
    ['Copy invite link', [['copy', 'https://chat.test/invite/s/']]],
    ['Copy Server ID', [['copy', 's']]],
    ['Remove from folder', [['moveServer', 's', 4]]],
    [
      'Leave Server',
      [
        ['askConfirm', 'Leave Server', 'Leave this server? You can join it again later.', 'Leave'],
        ['leaveServer', 's'],
      ],
    ],
  ])
  railState()
  useStore.setState({ view: { kind: 'channel', server: 'p', channelId: 9 } })
  expect(await effects(items(serverAt('p')))).toEqual([
    ['Join Server', [['joinPreview', 'p']]],
    ['Copy Server ID', [['copy', 'p']]],
  ])
})

test('the notify submenu: level radios, suppress checks and mute durations', () => {
  const scope = { kind: 'server', name: 's' } as const
  railState({ notify: setSuppress(setLevel(EMPTY_NOTIFY, scope, 'nothing'), 's', 'roles', true) })
  const settings = row(serverAt('s'), 'Notification settings')
  expect(settings?.subtitle).toBe('Nothing')
  expect(settings?.submenu?.map(i => [i.label, !!i.radio, !!i.checked])).toEqual([
    ['All messages', true, false],
    ['Only @mentions', true, false],
    ['Nothing', true, true],
    ['Suppress @everyone and @here', false, false],
    ['Suppress role mentions', false, true],
  ])
  const mute = row(serverAt('s'), 'Mute Server')
  expect([mute?.icon, mute?.subtitle]).toEqual([BellOff, undefined])
  expect(mute?.submenu?.map(i => i.label)).toEqual([
    '15 minutes',
    '1 hour',
    '3 hours',
    '8 hours',
    '24 hours',
    'Until I turn it back on',
  ])

  railState({ notify: setMute(EMPTY_NOTIFY, scope, 'forever') })
  const unmute = row(serverAt('s'), 'Unmute Server')
  expect([unmute?.icon, unmute?.subtitle, unmute?.submenu]).toEqual([
    Bell,
    'Muted until you turn it back on',
    undefined,
  ])
  const channelMute = row(channelAt(general), 'Mute Channel')
  expect(channelMute?.subtitle).toBe('Server muted until you turn it back on')

  const channel = { kind: 'channel', id: 1, server: 's' } as const
  railState({ notify: setLevel(EMPTY_NOTIFY, scope, 'all') })
  const inherits = row(channelAt(general), 'Notification settings')
  expect(inherits?.subtitle).toBe('Server default (All messages)')
  expect(inherits?.submenu?.map(i => [i.label, i.subtitle, !!i.radio, !!i.checked])).toEqual([
    ['Use server default', 'All messages', true, true],
    ['All messages', undefined, true, false],
    ['Only @mentions', undefined, true, false],
    ['Nothing', undefined, true, false],
  ])
  railState({ notify: setLevel(EMPTY_NOTIFY, channel, 'nothing') })
  const own = row(channelAt(general), 'Notification settings')
  expect(own?.subtitle).toBe('Nothing')
  expect(own?.submenu?.map(i => !!i.checked)).toEqual([false, false, false, true])
  railState({ notify: setMute(EMPTY_NOTIFY, channel, 'forever') })
  expect(row(channelAt(general), 'Unmute Channel')?.subtitle).toBe(
    'Muted until you turn it back on'
  )
})

test('a folder', async () => {
  railState({ unread: true })
  expect(items(folderAt).map(i => [i.label, i.icon, !!i.disabled])).toEqual([
    ['Mark as read', CheckCheck, false],
    ['Mute folder', BellOff, false],
    ['Rename folder', undefined, false],
    ['Ungroup', undefined, false],
  ])
  const out = await effects(items(folderAt))
  expect(out[0]).toEqual(['Mark as read', [['markServersRead', ['s', 'b']]]])
  expect(out[6]).toEqual(['Until I turn it back on', [['muteServers', ['s', 'b'], 'forever']]])
  expect(out.slice(7)).toEqual([
    ['Rename folder', [['openDialog', { kind: 'rename_folder', id: 'f1' }]]],
    ['Ungroup', [['ungroupFolder', 'f1']]],
  ])
  const muted = [{ kind: 'server', name: 's' } as const, { kind: 'server', name: 'b' } as const]
  railState({ notify: muted.reduce((p, sc) => setMute(p, sc, 'forever'), EMPTY_NOTIFY) })
  const unmute = row(folderAt, 'Unmute folder')
  expect([unmute?.icon, unmute?.subtitle]).toEqual([Bell, 'Muted until you turn it back on'])
  expect(await effects([unmute!])).toEqual([['Unmute folder', [['muteServers', ['s', 'b'], null]]]])
  railState({ guest: true })
  expect(labels(folderAt)).toEqual(['Mute folder', 'Rename folder', 'Ungroup'])
  expect(labels({ kind: 'folder', folder: { ...folder, servers: [] } })).toEqual([
    'Rename folder',
    'Ungroup',
  ])
})

test('the home button offers only mark all, dimmed when nothing is unread', async () => {
  railState({ perms: 0, unread: false })
  const home = menuItems(ctxFor(useStore.getState(), { kind: 'home' }, 'menu'))
  expect(home.map(i => [i.label, i.disabled])).toEqual([['Mark all as read', true]])
  railState({ unread: true })
  const lit = menuItems(ctxFor(useStore.getState(), { kind: 'home' }, 'menu'))
  expect(lit.map(i => [i.label, i.icon, i.disabled])).toEqual([
    ['Mark all as read', CheckCheck, false],
  ])
  expect(await effects(lit)).toEqual([['Mark all as read', [['askMarkAllRead', 'p2p']]]])
  railState({ guest: true })
  expect(labels({ kind: 'home' })).toEqual([])
})

test('a text and a voice channel, as a member and as a manager', () => {
  railState({ unread: true })
  expect(items(channelAt(general)).map(i => [i.label, !!i.disabled])).toEqual([
    ['Mark as read', false],
    ['Mute Channel', false],
    ['Notification settings', false],
    ['Copy Channel ID', false],
  ])
  expect(row(channelAt(random), 'Mark as read')?.disabled).toBe(true)
  expect(labels(channelAt(talk))).toEqual(['Copy Channel ID'])
  railState({ perms: Perm.ManageChannels })
  expect(labels(channelAt(general))).toEqual([
    'Mark as read',
    'Mute Channel',
    'Notification settings',
    'Copy Channel ID',
    'Rename Channel',
    'Delete Channel',
  ])
  expect(labels(channelAt(talk))).toEqual(['Copy Channel ID', 'Rename Channel', 'Delete Channel'])
  expect(row(channelAt(talk), 'Delete Channel')?.danger).toBe(true)
  railState({ perms: Perm.ManageChannels, channels: [general, talk] })
  expect(labels(channelAt(general))).not.toContain('Delete Channel')
  expect(labels(channelAt(talk))).toContain('Delete Channel')
  railState({ guest: true })
  expect(labels(channelAt(general))).toEqual([
    'Mute Channel',
    'Notification settings',
    'Copy Channel ID',
  ])
})

test('channel rows: mark read, copy, rename and delete', async () => {
  railState({ perms: Perm.ManageChannels, unread: true })
  const rows = items(channelAt(general)).filter(i => !i.submenu)
  expect(await effects(rows)).toEqual([
    ['Mark as read', [['markScopesRead', ['c1']]]],
    ['Copy Channel ID', [['copy', '1']]],
    ['Rename Channel', []],
    [
      'Delete Channel',
      [
        [
          'askConfirm',
          'Delete Channel',
          'Delete #general? Its messages are deleted for everyone.',
          'Delete',
        ],
        ['deleteChannel', 1],
      ],
    ],
  ])
  expect(useChannelEdit.getState()).toMatchObject({
    editing: { mode: 'rename', server: 's', id: 1 },
    name: 'general',
  })
  const voice = await effects([row(channelAt(talk), 'Delete Channel')!])
  expect(voice[0][1][0]).toEqual([
    'askConfirm',
    'Delete Channel',
    'Delete the voice channel talk?',
    'Delete',
  ])
})

test('a channel row acts on its own channel, not the open one', async () => {
  railState({ perms: Perm.ManageChannels })
  useStore.setState({ reads: { c2: { lastRead: 1, latest: 5, server: 's' } } })
  const scope = { kind: 'channel', id: 2, server: 's' } as const
  const mute = (until: unknown) => [['muteScope', scope, until]]
  expect(await effects(items(channelAt(random)))).toEqual([
    ['Mark as read', [['markScopesRead', ['c2']]]],
    ['15 minutes', mute('later')],
    ['1 hour', mute('later')],
    ['3 hours', mute('later')],
    ['8 hours', mute('later')],
    ['24 hours', mute('later')],
    ['Until I turn it back on', mute('forever')],
    ['Use server default', [['setNotifyLevel', scope, null]]],
    ['All messages', [['setNotifyLevel', scope, 'all']]],
    ['Only @mentions', [['setNotifyLevel', scope, 'mentions']]],
    ['Nothing', [['setNotifyLevel', scope, 'nothing']]],
    ['Copy Channel ID', [['copy', '2']]],
    ['Rename Channel', []],
    [
      'Delete Channel',
      [
        [
          'askConfirm',
          'Delete Channel',
          'Delete #random? Its messages are deleted for everyone.',
          'Delete',
        ],
        ['deleteChannel', 2],
      ],
    ],
  ])
  expect(useChannelEdit.getState()).toMatchObject({
    editing: { mode: 'rename', server: 's', id: 2 },
    name: 'random',
  })
  useStore.setState({ notifyPrefs: setMute(EMPTY_NOTIFY, scope, 'forever') })
  const unmute = row(channelAt(random), 'Unmute Channel')
  expect(unmute?.subtitle).toBe('Muted until you turn it back on')
  expect(await effects([unmute!])).toEqual([['Unmute Channel', mute(null)]])
  expect(row(channelAt(general), 'Mute Channel')?.submenu?.length).toBe(6)
})

test('a category, as a member and as a manager', async () => {
  railState()
  expect(labels(categoryAt)).toEqual(['Collapse all', 'Expand all', 'Copy Category ID'])
  railState({ perms: Perm.ManageChannels })
  expect(labels(categoryAt)).toEqual([
    'Create channel here',
    'Rename category',
    'Delete category',
    'Collapse all',
    'Expand all',
    'Copy Category ID',
  ])
  expect(row(categoryAt, 'Delete category')?.danger).toBe(true)
  expect(await effects(items(categoryAt))).toEqual([
    ['Create channel here', [['setCategoriesCollapsed', 's', [7], false]]],
    ['Rename category', [['openDialog', { kind: 'category', server: 's', id: 7 }]]],
    [
      'Delete category',
      [
        [
          'askConfirm',
          'Delete category',
          'Delete the category Chat? Its channels are kept and move out of it.',
          'Delete',
        ],
        ['deleteCategory', 7],
      ],
    ],
    ['Collapse all', [['setCategoriesCollapsed', 's', [7], true]]],
    ['Expand all', [['setCategoriesCollapsed', 's', [7], false]]],
    ['Copy Category ID', [['copy', '7']]],
  ])
  recorder()
  row(categoryAt, 'Create channel here')?.action?.()
  expect(useChannelEdit.getState()).toMatchObject({
    editing: { mode: 'create', server: 's', kind: 'text', category: 7 },
    name: '',
  })
})

test('each home card kind', async () => {
  railState()
  const calls: string[] = []
  const card = (read: string[], forget: boolean): Target => ({
    kind: 'card',
    key: 'c1',
    open: () => calls.push('open'),
    read,
    markRead: () => calls.push('read'),
    ...(forget ? { forget: () => calls.push('forget') } : {}),
  })
  expect(items(card([], true)).map(i => [i.label, i.icon, !!i.disabled])).toEqual([
    ['Open', ExternalLink, false],
    ['Mark as read', CheckCheck, true],
    ['Remove from Jump back in', Trash2, false],
  ])
  expect(items(card(['c1'], false)).map(i => [i.label, !!i.disabled])).toEqual([
    ['Open', false],
    ['Mark as read', false],
  ])
  for (const i of items(card(['c1'], true))) i.action?.()
  await drain()
  expect(calls).toEqual(['open', 'read', 'forget'])
})

test('the call route menu', async () => {
  const dm: DmSummary = { id: 9, other: user('bob'), is_self: false }
  const call: Target = { kind: 'call', dm, video: true }
  railState()
  useStore.setState({
    dms: [dm],
    callRoute: 'p2p',
    settings: { ...useStore.getState().settings, p2p_attachments: true },
    relayPrefs: {
      relays: [
        { url: 'turn:relay.example:3478', username: 'u', credential: 'c' },
        { url: 'stun:stun.example:3478' },
      ],
      allowed: [],
      ask: false,
      choice: 'auto',
    },
    iceHelpers: true,
    iceRelay: false,
  })
  expect(items(call).map(i => [i.label, i.subtitle, !!i.radio, !!i.checked, !!i.wrap])).toEqual([
    ['Through server', undefined, true, false, false],
    ['Direct (P2P)', P2P_IP_HINT, true, true, true],
    ['Direct through relay.example', undefined, false, false, true],
  ])
  expect(await effects(items(call))).toEqual([
    [
      'Through server',
      [
        ['setCallRoute', 'server'],
        ['startCall', 9, true],
      ],
    ],
    [
      'Direct (P2P)',
      [
        ['setCallRoute', 'p2p'],
        ['startP2pCall', 9, true],
      ],
    ],
    [
      'Direct through relay.example',
      [
        ['setCallRoute', 'p2p'],
        ['startP2pCall', 9, true, 'turn:relay.example:3478'],
      ],
    ],
  ])
  useStore.setState({ settings: { ...useStore.getState().settings, p2p_attachments: false } })
  expect(items(call).map(i => [i.label, !!i.checked])).toEqual([['Through server', true]])
  useStore.setState({
    settings: { ...useStore.getState().settings, p2p_attachments: true },
    p2pCallFailed: { 9: Date.now() },
  })
  expect(labels(call)).toEqual(['Through server'])
  recorder()
  const gone = items(call)[0]
  useStore.setState({ dms: [] })
  gone.action?.()
  await drain()
  expect(useStore.getState().toast?.text).toBe("That's no longer available")
})

test('menu-only rows stay out of the palette', () => {
  railState({ perms: Perm.ManageChannels, unread: true })
  const ids = paletteCommands(paletteCtx(useStore.getState())).map(r => r.id)
  const menuOnly = [
    'server_notify',
    'server_create_category',
    'server_copy_invite',
    'server_copy_id',
    'server_remove_from_folder',
    'guest_server_join',
    'guest_server_copy_id',
    'folder_mark_read',
    'folder_rename',
    'folder_ungroup',
    'folder_mute',
    'folder_unmute',
    'channel_notify',
    'channel_copy_id',
    'channel_rename',
    'channel_delete',
    'category_create_channel',
    'category_rename',
    'category_delete',
    'category_collapse_all',
    'category_expand_all',
    'category_copy_id',
    'card_open',
    'card_mark_read',
    'card_forget',
    'call_route_server',
    'call_route_p2p',
    'call_route_relay',
  ]
  expect(ids.filter(id => menuOnly.some(m => id === m || id.startsWith(`${m}_`)))).toEqual([])
  for (const id of menuOnly) expect([id, actionById(id)?.id]).toEqual([id, id])
})
