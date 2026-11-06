import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { Copy, Trash2 } from 'lucide-react'
import { ctxFor, paletteCtx } from '../actions/ctx'
import { registerAppActions } from '../actions/index'
import { menuItems } from '../actions/menu'
import { paletteCommands } from '../actions/palette'
import { actionById, allActions, defineAction, runAction } from '../actions/registry'
import type { Args, Target } from '../actions/types'
import { api, shareOrigin } from '../instances'
import { EMPTY_NOTIFY } from '../notify'
import type { PaletteCommand } from '../palette'
import { buildSections, flatItems, type ResultCtx } from '../palette_results'
import { closePalette, usePaletteUi } from '../palette_store'
import { setSharing, sharing } from '../platform'
import { emptySelection, toggle } from '../selection'
import { resetSessionCaches, useStore, type ConfirmRequest } from '../store'
import type { RChatState } from '../store_types'
import { Perm } from '../types'
import { drain, me, member, msg, paged, role, serverDetail, user } from './fixtures'

const real = Object.fromEntries(
  Object.entries(useStore.getState()).filter(([, v]) => typeof v === 'function')
)
const realSharing = sharing()
const realSearch = api.search

beforeAll(registerAppActions)

afterEach(() => {
  setSharing(realSharing)
  api.search = realSearch
  closePalette()
  usePaletteUi.setState({ poll: null })
  useStore.setState({
    ...real,
    token: null,
    me: null,
    guest: false,
    servers: {},
    members: {},
    dms: [],
    view: null,
    panel: null,
    selection: null,
    messages: {},
    timeouts: {},
    friends: paged([]),
    incomingRequests: paged([]),
    blockList: paged([]),
    blocked: {},
    notifyPrefs: EMPTY_NOTIFY,
    call: null,
    voice: null,
    toast: null,
    confirm: null,
    contextMenu: null,
    streamer: false,
  })
})

afterAll(resetSessionCaches)

const MOD = Perm.ViewAuditLog | Perm.ManageWebhooks | Perm.TimeoutMembers
const HOUR = 3_600_000
const general = [msg(1, { author: user('bob') }), msg(2), msg(3)]
const bobby = user('bob', { display_name: 'Bobby' })

// Alice moderates server s (ViewAuditLog | ManageWebhooks | TimeoutMembers) and views #general;
// bob is timed out, carol asked to be friends, dave is a friend and erin is blocked.
const reset = (over: Partial<RChatState> = {}) => {
  useStore.setState({
    token: 'tok',
    guest: false,
    me: me('alice', {
      servers: [
        { name: 's', display_name: 'Space', creator: null, is_admin: false },
        { name: 'rchat', display_name: 'Lobby', creator: null, is_admin: false },
      ],
    }),
    servers: {
      s: serverDetail('s', {
        display_name: 'Space',
        channels: [
          { id: 1, name: 'general', kind: 'text', slowmode_seconds: 0 },
          { id: 2, name: 'Lounge', kind: 'voice', slowmode_seconds: 0 },
          { id: 3, name: 'news', kind: 'text', slowmode_seconds: 0 },
        ],
        roles: [role(1, '#f00', MOD)],
        read_only: [3],
      }),
      rchat: serverDetail('rchat', {
        channels: [{ id: 10, name: 'lobby', kind: 'text', slowmode_seconds: 0 }],
      }),
    },
    members: {
      s: paged([member('alice', { role_ids: [1] }), member('bob', { display_name: 'Bob' })]),
    },
    memberInfo: {},
    interacted: {},
    dms: [],
    view: { kind: 'channel', server: 's', channelId: 1 },
    panel: null,
    profile: null,
    selection: null,
    messages: { c1: general },
    timeouts: { s: { bob: { ends: Date.now() + HOUR, reason: null } } },
    friends: paged([{ user: user('dave', { display_name: 'Dave' }), since: 1, online: false }]),
    onlineFriends: paged([]),
    incomingRequests: paged([
      { user: user('carol', { display_name: 'Carol' }), created_at: 1, incoming: true },
    ]),
    blockList: paged([{ user: user('erin', { display_name: 'Erin' }), blocked_at: 1 }]),
    blocked: { erin: true },
    notifyPrefs: EMPTY_NOTIFY,
    call: null,
    voice: null,
    home: false,
    theme: 'dark',
    streamer: false,
    typingOn: true,
    profanityOn: true,
    showSpoilers: 'click',
    ...over,
  })
  return useStore.getState()
}

const channelState = () => reset()

const dmState = () =>
  reset({ dms: [{ id: 9, other: bobby, is_self: false }], view: { kind: 'dm', dmId: 9 } })

const voiceState = () =>
  reset({
    dms: [{ id: 9, other: bobby, is_self: false }],
    call: {
      dmId: 9,
      dmUsers: ['alice', 'bob'],
      state: 'active',
      from: 'alice',
      kind: 'rtc',
      video: false,
      since: 1,
    },
    voice: { server: 's', channelId: 2 },
  })

const mutedState = () =>
  reset({
    notifyPrefs: {
      ...EMPTY_NOTIFY,
      servers: Object.assign(Object.create(null), { s: { muteUntil: 'forever' } }),
      channels: Object.assign(Object.create(null), { 1: { muteUntil: Date.now() + HOUR } }),
    },
    theme: 'light',
    streamer: true,
    typingOn: false,
    profanityOn: false,
    showSpoilers: 'always',
    me: { ...me('alice'), appear_offline: true, servers: [] },
  })

const selectionState = () => reset({ selection: toggle(emptySelection('c1'), general[0]) })

const threadState = () => reset({ panel: { kind: 'thread', root: msg(2, { reply_count: 1 }) } })

const homeState = () => reset({ view: null, home: true })

const awayState = () => reset({ view: null, home: false })

const voiceChannelState = () => reset({ view: { kind: 'channel', server: 's', channelId: 2 } })

const readOnlyState = () => reset({ view: { kind: 'channel', server: 's', channelId: 3 } })

const lobbyState = () => reset({ view: { kind: 'channel', server: 'rchat', channelId: 10 } })

const selfDmState = () =>
  reset({ dms: [{ id: 4, other: user('alice'), is_self: true }], view: { kind: 'dm', dmId: 4 } })

const blockedDmState = () =>
  reset({
    dms: [{ id: 5, other: user('erin', { display_name: 'Erin' }), is_self: false }],
    view: { kind: 'dm', dmId: 5 },
  })

// A channel of a server whose details haven't loaded.
const unloadedState = () => reset({ view: { kind: 'channel', server: 'x', channelId: 77 } })

const guestState = () =>
  reset({
    guest: true,
    me: null,
    token: null,
    friends: paged([]),
    incomingRequests: paged([]),
    blockList: paged([]),
    timeouts: {},
  })

const signedOutState = () => reset({ me: null, token: null, view: null })

const STATES: Record<string, () => RChatState> = {
  channelState,
  dmState,
  voiceState,
  mutedState,
  selectionState,
  threadState,
  homeState,
  guestState,
  signedOutState,
  unloadedState,
}

const rows = (st: RChatState = useStore.getState()) => paletteCommands(paletteCtx(st))
const rowsById = (st: RChatState) => Object.fromEntries(rows(st).map(r => [r.id, r]))
const ids = (st: RChatState) => rows(st).map(r => r.id)
const order = (st: RChatState) => ids(st).join(' ')

// Today's ids (palette_commands.ts), all reachable from fixture states: alice moderates
// server s with ViewAuditLog | ManageWebhooks | TimeoutMembers, views #general, has bob
// timed out, carol's incoming request, friend dave, blocked erin.
const IDS = [
  'home',
  'inbox',
  'mark_read_here',
  'jump_unread',
  'jump_present',
  'select',
  'pins',
  'copy_link_here',
  'search_channel',
  'jump_date',
  'mute_here',
  'level_here',
  'mark_server_read',
  'mute_server',
  'level_server',
  'server_settings',
  'audit_log',
  'webhooks',
  'timeout_member',
  'untimeout_s_bob',
  'leave_server',
  'poll',
  'mark_all_read',
  'mark_dms_read',
  'start_dm',
  'create_server',
  'join_server',
  'palette_help',
  'logout',
  'friends',
  'add_friends',
  'block',
  'accept_carol',
  'deny_carol',
  'unfriend_dave',
  'unblock_erin',
  'theme',
  'streamer',
  'typing',
  'profanity',
  'spoilers',
  'appear_offline',
  'settings_settings',
  'settings_notifications',
  'settings_privacy',
  'settings_sync',
  'settings_palette',
  'settings_information',
]
const DM_IDS = ['call', 'video_call', 'close_dm'] // view: DM with bob
const VOICE_IDS = ['hangup', 'leave_voice', 'mute_mic', 'deafen'] // with s.call and s.voice set
const MUTED_IDS = ['unmute_here', 'unmute_server']
const SELECTION_IDS = [
  'selection_select_all',
  'selection_clear',
  'selection_copy_text',
  'selection_copy_links',
  'selection_forward',
  'selection_export_text',
  'selection_export_json',
  'selection_select_mine',
  'selection_exit',
]

const LOOKS = [
  ['home', 'Go home', 'navigation', 'House', '', '', ''],
  ['inbox', 'Open inbox', 'commands', 'Inbox', '', '', ''],
  ['mark_read_here', 'Mark #general as read', 'commands', 'Check', '', '', ''],
  ['jump_unread', 'Jump to first unread', 'commands', 'AtSign', '', '', ''],
  ['jump_present', 'Jump to present', 'commands', 'CheckCheck', '', '', ''],
  ['select', 'Select messages', 'commands', 'SquareCheck', '', 'Mod+Shift+S', ''],
  ['pins', 'Show pinned messages', 'commands', 'Pin', '', '', ''],
  ['copy_link_here', 'Copy link to #general', 'commands', 'Link', '', '', ''],
  ['search_channel', 'Search messages on the server', 'commands', 'Search', '', '', ''],
  ['jump_date', 'Jump to date', 'commands', 'FileClock', '', '', ''],
  ['mute_here', 'Mute #general', 'commands', 'BellOff', '', '', ''],
  ['level_here', 'Notification level for #general', 'commands', 'Bell', '', '', ''],
  ['mark_server_read', 'Mark this server as read', 'commands', 'Check', '', '', ''],
  ['mute_server', 'Mute this server', 'commands', 'BellOff', '', '', ''],
  ['level_server', 'Notification level for this server', 'commands', 'Bell', '', '', ''],
  ['server_settings', 'Server settings', 'settings', 'Settings', '', '', ''],
  ['audit_log', 'Open audit log', 'commands', 'FileClock', '', '', ''],
  ['webhooks', 'Manage webhooks', 'commands', 'Webhook', '', '', ''],
  ['timeout_member', 'Time out a member', 'commands', 'Timer', '', '', ''],
  ['untimeout_s_bob', 'Remove timeout: Bob', 'commands', 'TimerOff', '', '', 'name'],
  ['leave_server', 'Leave this server', 'commands', 'LogOut', '', '', 'danger'],
  ['poll', 'Create poll', 'commands', 'ChartColumn', '', '', ''],
  ['mark_all_read', 'Mark everything as read', 'commands', 'CheckCheck', '', 'Shift+Escape', ''],
  ['mark_dms_read', 'Mark all DMs as read', 'commands', 'Check', '', '', ''],
  ['start_dm', 'Start a DM', 'commands', 'MessageSquare', '', '', ''],
  ['create_server', 'Create a server', 'commands', 'Plus', '', '', ''],
  ['join_server', 'Join a server', 'commands', 'Plus', '', '', ''],
  ['palette_help', 'Palette help', 'help', 'Command', '', '', 'keepOpen'],
  ['logout', 'Log out', 'commands', 'LogOut', '', '', 'danger'],
  ['friends', 'Open friends', 'friends', 'Users', '', '', ''],
  ['add_friends', 'Add friends', 'friends', 'UserPlus', '', '', ''],
  ['block', 'Block someone', 'friends', 'Ban', '', '', 'danger'],
  [
    'accept_carol',
    'Accept friend request: Carol',
    'friends',
    'UserPlus',
    '@carol',
    '',
    'name subtitleName',
  ],
  [
    'deny_carol',
    'Deny friend request: Carol',
    'friends',
    'UserMinus',
    '@carol',
    '',
    'name subtitleName',
  ],
  [
    'unfriend_dave',
    'Remove friend: Dave',
    'friends',
    'UserMinus',
    '@dave',
    '',
    'danger name subtitleName',
  ],
  ['unblock_erin', 'Unblock Erin', 'friends', 'ShieldOff', '@erin', '', 'name subtitleName'],
  ['theme', 'Switch to light theme', 'settings', 'Moon', '', '', ''],
  ['streamer', 'Turn on streamer mode', 'settings', 'EyeOff', '', '', ''],
  ['typing', 'Turn off typing indicators', 'settings', 'Type', '', '', ''],
  ['profanity', 'Turn off the profanity filter', 'settings', 'EyeOff', '', '', ''],
  ['spoilers', 'Always show spoilers', 'settings', 'Eye', '', '', ''],
  ['appear_offline', 'Appear offline', 'settings', 'EyeOff', '', '', ''],
  ['settings_settings', 'Open settings', 'settings', 'Settings', '', '', ''],
  ['settings_notifications', 'Settings: Notifications', 'settings', 'Bell', '', '', ''],
  ['settings_privacy', 'Settings: Privacy', 'settings', 'ShieldOff', '', '', ''],
  ['settings_sync', 'Settings: Sync config', 'settings', 'Copy', '', '', ''],
  ['settings_palette', 'Settings: Command palette', 'settings', 'Command', '', '', ''],
  ['settings_information', 'Settings: Information', 'settings', 'Keyboard', '', '', ''],
]
const OTHER_LOOKS: Record<string, string[][]> = {
  dmState: [
    ['mark_read_here', 'Mark this DM as read', 'commands', 'Check', '', '', ''],
    ['copy_link_here', 'Copy link to this DM', 'commands', 'Link', '', '', ''],
    ['mute_here', 'Mute this DM', 'commands', 'BellOff', '', '', ''],
    ['level_here', 'Notification level for this DM', 'commands', 'Bell', '', '', ''],
    ['call', 'Call Bobby', 'commands', 'Phone', '', '', 'name'],
    ['video_call', 'Video call Bobby', 'commands', 'Video', '', '', 'name'],
    ['close_dm', 'Close this DM', 'commands', 'X', '', '', ''],
  ],
  voiceState: [
    ['untimeout_s_bob', 'Remove timeout: Bobby', 'commands', 'TimerOff', '', '', 'name'],
    ['hangup', 'Leave call', 'commands', 'Phone', '', '', 'danger'],
    ['leave_voice', 'Leave voice channel', 'commands', 'Phone', '', '', 'danger'],
    ['mute_mic', 'Toggle microphone', 'commands', 'Phone', '', '', ''],
    ['deafen', 'Toggle deafen', 'commands', 'Phone', '', '', ''],
  ],
  mutedState: [
    ['unmute_here', 'Unmute #general', 'commands', 'Bell', '', '', ''],
    ['unmute_server', 'Unmute this server', 'commands', 'Bell', '', '', ''],
    ['theme', 'Switch to dark theme', 'settings', 'Moon', '', '', ''],
    ['streamer', 'Turn off streamer mode', 'settings', 'Eye', '', '', ''],
    ['typing', 'Turn on typing indicators', 'settings', 'Type', '', '', ''],
    ['profanity', 'Turn on the profanity filter', 'settings', 'EyeOff', '', '', ''],
    ['spoilers', 'Show spoilers on click', 'settings', 'Eye', '', '', ''],
    ['appear_offline', 'Stop appearing offline', 'settings', 'EyeOff', '', '', ''],
  ],
  unloadedState: [
    ['mark_read_here', 'Mark this conversation as read', 'commands', 'Check', '', '', ''],
    ['copy_link_here', 'Copy link to this conversation', 'commands', 'Link', '', '', ''],
    ['mute_here', 'Mute this conversation', 'commands', 'BellOff', '', '', ''],
    ['level_here', 'Notification level for this conversation', 'commands', 'Bell', '', '', ''],
  ],
  selectionState: [
    ['selection_select_all', 'Select all', 'selection', 'CheckCheck', '', '', ''],
    ['selection_clear', 'Clear', 'selection', 'SquareDashed', '', '', ''],
    ['selection_copy_text', 'Copy text', 'selection', 'Copy', '', '', ''],
    ['selection_copy_links', 'Copy links', 'selection', 'Link', '', '', ''],
    ['selection_forward', 'Forward', 'selection', 'Forward', '', '', ''],
    ['selection_export_text', 'Export as text', 'selection', 'Download', '', '', ''],
    ['selection_export_json', 'Export as JSON', 'selection', 'FileBraces', '', '', ''],
    ['selection_select_mine', 'Select mine', 'selection', 'UserCheck', '', '', ''],
    ['selection_exit', 'Exit selection', 'selection', 'X', '', '', ''],
  ],
}
const KEYWORDS: Record<string, string[]> = {
  unmute_here: ['notifications'],
  unmute_server: ['notifications'],
  inbox: ['notifications', 'mentions', 'pings'],
  mark_read_here: ['read', 'unread'],
  jump_present: ['latest', 'bottom'],
  select: ['bulk', 'delete', 'export'],
  copy_link_here: ['share', 'url'],
  jump_date: ['history', 'day'],
  mute_here: ['notifications', 'silence'],
  level_here: ['notify', 'mentions', 'all messages', 'nothing'],
  mute_server: ['notifications', 'silence'],
  level_server: ['notify', 'mentions', 'all messages', 'nothing'],
  webhooks: ['integrations', 'bots'],
  timeout_member: ['mute', 'moderation'],
  poll: ['vote', 'survey'],
  start_dm: ['message', 'direct', 'chat'],
  join_server: ['invite'],
  palette_help: ['prefix', 'how'],
  logout: ['sign out'],
  add_friends: ['friend request', 'add friend'],
  theme: ['theme', 'appearance', 'dark', 'light'],
  streamer: ['blur', 'privacy'],
  profanity: ['filter', 'mask'],
  appear_offline: ['status', 'invisible', 'presence'],
  settings_settings: ['preferences'],
  settings_notifications: ['preferences'],
  settings_privacy: ['preferences'],
  settings_sync: ['preferences'],
  settings_palette: ['preferences'],
  settings_information: ['keyboard shortcuts', 'help'],
}
const ORDER: Record<string, string> = {
  channelState: [
    'home inbox mark_read_here jump_unread jump_present select pins copy_link_here',
    'search_channel jump_date mute_here level_here mark_server_read mute_server level_server server_settings',
    'audit_log webhooks timeout_member untimeout_s_bob leave_server poll mark_all_read mark_dms_read',
    'start_dm create_server join_server palette_help logout friends add_friends block',
    'accept_carol deny_carol unfriend_dave unblock_erin theme streamer typing profanity',
    'spoilers appear_offline settings_settings settings_notifications settings_privacy settings_sync settings_palette settings_information',
  ].join(' '),
  dmState: [
    'home inbox mark_read_here jump_unread jump_present select pins copy_link_here',
    'mute_here level_here poll call video_call close_dm mark_all_read mark_dms_read',
    'start_dm create_server join_server palette_help logout friends add_friends block',
    'accept_carol deny_carol unfriend_dave unblock_erin theme streamer typing profanity',
    'spoilers appear_offline settings_settings settings_notifications settings_privacy settings_sync settings_palette settings_information',
  ].join(' '),
  homeState: [
    'inbox mark_all_read mark_dms_read start_dm create_server join_server palette_help logout',
    'friends add_friends block accept_carol deny_carol unfriend_dave unblock_erin theme',
    'streamer typing profanity spoilers appear_offline settings_settings settings_notifications settings_privacy',
    'settings_sync settings_palette settings_information',
  ].join(' '),
  guestState: [
    'home mark_read_here jump_unread jump_present select pins copy_link_here search_channel',
    'jump_date mute_here level_here mark_server_read mute_server level_server join_server palette_help',
    'theme streamer typing profanity spoilers settings_settings settings_notifications settings_sync',
    'settings_palette settings_information',
  ].join(' '),
  signedOutState: [
    'home join_server palette_help theme streamer settings_settings settings_notifications settings_sync',
    'settings_palette settings_information',
  ].join(' '),
  mutedState: [
    'home inbox mark_read_here jump_unread jump_present select pins copy_link_here',
    'search_channel jump_date unmute_here level_here mark_server_read unmute_server level_server server_settings',
    'audit_log webhooks timeout_member untimeout_s_bob poll mark_all_read mark_dms_read start_dm',
    'create_server join_server palette_help logout friends add_friends block accept_carol',
    'deny_carol unfriend_dave unblock_erin theme streamer typing profanity spoilers',
    'appear_offline settings_settings settings_notifications settings_privacy settings_sync settings_palette settings_information',
  ].join(' '),
}
const RUNS: Record<string, Record<string, unknown[]>> = {
  channelState: {
    home: [['goHome']],
    inbox: [['setInboxOpen', true]],
    mark_read_here: [['markScopesRead', ['c1']]],
    jump_unread: [['jumpToUnread']],
    jump_present: [['jumpToPresent', 'c1']],
    select: [['startSelection', 'c1']],
    pins: [['openPins']],
    copy_link_here: [
      ['copyText', 'ORIGIN/s/s/1/'],
      ['showToast', 'Link copied'],
    ],
    search_channel: [['openSearch']],
    jump_date: [
      ['api.search', { server: 's', channel_id: 1, before_ts: 1738367999 }],
      ['jumpTo', 'c1', 2, true],
    ],
    mute_here: [['muteScope', { kind: 'channel', id: 1, server: 's' }, 'forever']],
    level_here: [['setNotifyLevel', { kind: 'channel', id: 1, server: 's' }, null]],
    mark_server_read: [['markServerRead', 's']],
    mute_server: [['muteScope', { kind: 'server', name: 's' }, 'forever']],
    level_server: [['setNotifyLevel', { kind: 'server', name: 's' }, null]],
    server_settings: [['openDialog', { kind: 'server_settings', server: 's' }]],
    audit_log: [['openDialog', { kind: 'audit_log', server: 's' }]],
    webhooks: [['openDialog', { kind: 'webhooks', server: 's' }]],
    timeout_member: [['openDialog', { kind: 'timeout', server: 's', user: 'user:bob:Bob' }]],
    untimeout_s_bob: [['removeTimeout', 's', 'bob']],
    leave_server: [
      [
        'askConfirm',
        {
          title: 'Leave Server',
          body: 'Leave this server? You can join it again later.',
          confirm: 'Leave',
        },
      ],
      ['leaveServer', 's'],
    ],
    poll: [['poll', { kind: 'channel', id: 1 }]],
    mark_all_read: [['askMarkAllRead', { pending: false, mark: 'fn' }]],
    mark_dms_read: [['markDmsRead']],
    start_dm: [['startDm', 'bob']],
    create_server: [['openDialog', { kind: 'add_server', tab: 'create' }]],
    join_server: [['openDialog', { kind: 'add_server', tab: 'join', join: 'foo' }]],
    palette_help: [['palette', '?']],
    logout: [
      [
        'askConfirm',
        { title: 'Log out', body: 'Log out of this account on this device?', confirm: 'Log out' },
      ],
      ['logout'],
    ],
    friends: [['openFriends']],
    add_friends: [['askAddFriends', ['carol', 'dave']]],
    block: [['askBlock', 'user:bob:Bob']],
    accept_carol: [['acceptFriend', 'user:carol:Carol']],
    deny_carol: [['denyFriend', 'carol']],
    unfriend_dave: [['askRemoveFriend', 'user:dave:Dave']],
    unblock_erin: [['unblockUser', 'erin', 'Erin']],
    theme: [['setTheme', 'light']],
    streamer: [['setStreamer', true]],
    typing: [['setTypingOn', false]],
    profanity: [['setProfanityOn', false]],
    spoilers: [['setShowSpoilers', 'always']],
    appear_offline: [['setAppearOffline', true]],
    settings_settings: [['openDialog', { kind: 'settings', section: 'settings' }]],
    settings_notifications: [['openDialog', { kind: 'settings', section: 'notifications' }]],
    settings_privacy: [['openDialog', { kind: 'settings', section: 'privacy' }]],
    settings_sync: [['openDialog', { kind: 'settings', section: 'sync' }]],
    settings_palette: [['openDialog', { kind: 'settings', section: 'palette' }]],
    settings_information: [['openDialog', { kind: 'settings', section: 'information' }]],
  },
  dmState: {
    mark_read_here: [['markScopesRead', ['d9']]],
    copy_link_here: [
      ['copyText', 'ORIGIN/dm/9/'],
      ['showToast', 'Link copied'],
    ],
    mute_here: [['muteScope', { kind: 'dm', id: 9 }, 'forever']],
    poll: [['poll', { kind: 'dm', id: 9 }]],
    call: [['startCall', 9, false]],
    video_call: [['startCall', 9, true]],
    close_dm: [['closeDm', 9]],
  },
  voiceState: {
    hangup: [['hangupCall']],
    leave_voice: [['leaveVoice']],
    mute_mic: [['toggleMute']],
    deafen: [['toggleDeafen']],
  },
  mutedState: {
    unmute_here: [['muteScope', { kind: 'channel', id: 1, server: 's' }, null]],
    unmute_server: [['muteScope', { kind: 'server', name: 's' }, null]],
    theme: [['setTheme', 'dark']],
    streamer: [['setStreamer', false]],
    typing: [['setTypingOn', true]],
    profanity: [['setProfanityOn', true]],
    spoilers: [['setShowSpoilers', 'click']],
    appear_offline: [['setAppearOffline', false]],
  },
  selectionState: {
    selection_select_all: [['selectAllMessages']],
    selection_clear: [['clearSelection']],
    selection_copy_text: [['copySelectionText']],
    selection_copy_links: [['copySelectionLinks']],
    selection_forward: [['forwardSelection']],
    selection_export_text: [['exportSelection', 'text']],
    selection_export_json: [['exportSelection', 'json']],
    selection_select_mine: [['selectAuthorMessages', 'alice']],
    selection_exit: [['exitSelection']],
  },
  threadState: {
    mark_read_here: [['markScopesRead', ['t2']]],
    jump_present: [['jumpToPresent', 't2']],
    select: [['startSelection', 't2']],
    poll: [['poll', { kind: 'thread', id: 2 }]],
  },
  unloadedState: {
    mark_read_here: [['markScopesRead', ['c77']]],
    mute_here: [['muteScope', { kind: 'channel', id: 77, server: 'x' }, 'forever']],
    level_here: [['setNotifyLevel', { kind: 'channel', id: 77, server: 'x' }, null]],
    mark_server_read: [['markServerRead', 'x']],
  },
}

const flagsOf = (r: PaletteCommand) =>
  (['danger', 'name', 'subtitleName', 'keepOpen'] as const).filter(k => r[k]).join(' ')

const look = (r: PaletteCommand) => [
  r.id,
  r.title,
  r.group,
  r.icon?.displayName ?? '',
  r.subtitle ?? '',
  r.hint ?? '',
  flagsOf(r),
]

const SAMPLES: Record<string, string> = {
  'Date, YYYY-MM-DD': '2025-01-31',
  'Usernames, separated by spaces': 'carol @Dave',
  'Server name (or leave empty)': ' Foo ',
  Username: ' @Bob ',
}

const sample = (r: PaletteCommand) =>
  !r.arg ? undefined : r.arg.choices ? r.arg.choices.at(-1)?.value : SAMPLES[r.arg.placeholder]

const plain = (x: unknown): unknown => {
  const origin = shareOrigin()
  return JSON.parse(
    JSON.stringify(x, (_k, v: unknown) => {
      if (typeof v === 'function') return 'fn'
      if (typeof v === 'string' && origin && v.startsWith(origin))
        return `ORIGIN${v.slice(origin.length)}`
      if (v && typeof v === 'object' && 'username' in v && 'display_name' in v)
        return `user:${String(v.username)}:${String(v.display_name)}`
      return v
    })
  )
}

// Runs each row once with every store action recorded instead of done; a confirm is accepted.
const runAll = async (make: () => RChatState, want: string[]) => {
  const out: Record<string, unknown> = {}
  for (const id of want) {
    make()
    const calls: unknown[][] = []
    const record =
      (k: string) =>
      (...a: unknown[]) => {
        while (a.length && a.at(-1) === undefined) a.pop()
        if (k !== 'askConfirm') return void calls.push([k, ...a])
        const { title, body, confirm, action } = a[0] as ConfirmRequest
        calls.push([k, { title, body, confirm }])
        action('')
      }
    useStore.setState(Object.fromEntries(Object.keys(real).map(k => [k, record(k)])))
    setSharing({ ...realSharing, copyText: async t => (calls.push(['copyText', t]), true) })
    api.search = (async (p: unknown) => {
      calls.push(['api.search', p])
      return { items: [{ message: msg(2) }], more: false }
    }) as unknown as typeof api.search
    usePaletteUi.setState({ open: false, text: '', poll: null })
    const row = rows().find(r => r.id === id)
    if (!row) {
      out[id] = 'missing'
      continue
    }
    await row.run(sample(row))
    await drain()
    const ui = usePaletteUi.getState()
    if (ui.poll) calls.push(['poll', ui.poll])
    if (ui.open) calls.push(['palette', ui.text])
    out[id] = plain(calls)
  }
  return out
}

test('every palette command id of 0.3 is still offered (usage counts key on them)', () => {
  expect(IDS.filter(id => !ids(channelState()).includes(id))).toEqual([])
  expect(DM_IDS.filter(id => !ids(dmState()).includes(id))).toEqual([])
  expect(VOICE_IDS.filter(id => !ids(voiceState()).includes(id))).toEqual([])
  expect(MUTED_IDS.filter(id => !ids(mutedState()).includes(id))).toEqual([])
  expect(SELECTION_IDS.filter(id => !ids(selectionState()).includes(id))).toEqual([])
})

test('titles, hints and danger are unchanged', () => {
  const byId = rowsById(channelState())
  expect(byId.mark_read_here.title).toBe('Mark #general as read')
  expect(byId.select.hint).toBe('Mod+Shift+S')
  expect(byId.mark_all_read.hint).toBe('Shift+Escape')
  expect(byId.untimeout_s_bob).toMatchObject({ title: 'Remove timeout: Bob', name: true })
  expect(byId.leave_server.danger).toBe(true)
  expect(rowsById(dmState()).call.title).toBe('Call Bobby')
})

test('rows keep their 0.3 order in each state', () => {
  for (const [name, want] of Object.entries(ORDER))
    expect([name, order(STATES[name]())]).toEqual([name, want])
  const channel = ORDER.channelState.split(' ')
  const dm = ORDER.dmState.split(' ')
  const without = (list: string[], ...drop: string[]) =>
    list.filter(id => !drop.includes(id)).join(' ')
  const mod = ['server_settings', 'audit_log', 'webhooks', 'timeout_member', 'untimeout_s_bob']
  expect(order(threadState())).toBe(ORDER.channelState)
  expect(order(voiceChannelState())).toBe(without(channel, 'search_channel', 'jump_date', 'poll'))
  expect(order(readOnlyState())).toBe(without(channel, 'poll'))
  expect(order(lobbyState())).toBe(without(channel, ...mod, 'leave_server'))
  expect(order(unloadedState())).toBe(
    without(channel, 'search_channel', 'jump_date', ...mod, 'leave_server', 'poll')
  )
  expect(order(selfDmState())).toBe(without(dm, 'call', 'video_call', 'close_dm'))
  expect(order(blockedDmState())).toBe(without(dm, 'call', 'video_call'))
  expect(order(awayState())).toBe(`home ${ORDER.homeState}`)
  expect(order(selectionState())).toBe([...SELECTION_IDS, without(channel, 'select')].join(' '))
  expect(order(voiceState())).toBe(
    channel.flatMap(id => (id === 'poll' ? [id, ...VOICE_IDS] : [id])).join(' ')
  )
})

test('rows keep their 0.3 titles, groups, icons, subtitles, hints and flags', () => {
  expect(rows(channelState()).map(look)).toEqual(LOOKS)
  for (const [name, want] of Object.entries(OTHER_LOOKS)) {
    const got = rowsById(STATES[name]())
    expect([name, want.map(w => look(got[w[0]]))]).toEqual([name, want])
  }
})

test('keywords keep their 0.3 terms; a contextual title adds only its static name', () => {
  for (const make of Object.values(STATES))
    for (const r of rows(make())) {
      const a = actionById(r.action ?? '')
      const old = KEYWORDS[r.id] ?? (r.group === 'selection' ? ['selected', 'messages'] : [])
      const extra = r.id === r.action && a && a.title !== r.title ? [a.title] : []
      expect([r.id, r.keywords ?? []]).toEqual([r.id, [...old, ...extra]])
    }
})

test('arguments are unchanged: choices, checks and typed forms', () => {
  const byId = rowsById(channelState())
  const choices = (id: string) => byId[id].arg?.choices?.map(c => [c.value, c.label])
  const checks = (id: string) =>
    ['', 'bob', '@bob', 'a b', '2025-01-31', '2025-02-30'].map(t => byId[id].arg?.check?.(t))
  const parses = (id: string) =>
    ['add friends ann bob', 'dm @bob', 'join foo', 'block @erin', 'x'].map(t => byId[id].parse?.(t))
  const mute = [
    ['900000', '15 minutes'],
    ['3600000', '1 hour'],
    ['10800000', '3 hours'],
    ['28800000', '8 hours'],
    ['86400000', '24 hours'],
    ['forever', 'Until I turn it back on'],
  ]
  const level = [
    ['all', 'All messages'],
    ['mentions', 'Only @mentions'],
    ['nothing', 'Nothing'],
    ['default', 'Default'],
  ]
  expect([choices('mute_here'), choices('mute_server')]).toEqual([mute, mute])
  expect([choices('level_here'), choices('level_server')]).toEqual([level, level])
  expect(byId.mute_here.arg?.placeholder).toBe('For how long')
  expect(byId.level_here.arg?.placeholder).toBe('Notify me about')
  const name = ['Type a username', null, null, 'Type a username', null, null]
  expect([checks('timeout_member'), checks('start_dm'), checks('block')]).toEqual([
    name,
    name,
    name,
  ])
  expect(checks('add_friends')).toEqual([
    'Type at least one username',
    null,
    null,
    null,
    null,
    null,
  ])
  const date = 'Use a date like 2025-01-31'
  expect(checks('jump_date')).toEqual([date, date, date, date, null, null])
  expect(byId.join_server.arg).toEqual({ placeholder: 'Server name (or leave empty)' })
  expect([parses('start_dm'), parses('join_server'), parses('block')]).toEqual([
    [null, 'bob', null, null, null],
    [null, null, 'foo', null, null],
    [null, null, null, 'erin', null],
  ])
  expect(parses('add_friends')).toEqual(['ann bob', null, null, null, null])
  expect(byId.poll.slash).toBe('poll')
})

test('each row does what it did in 0.3, confirms included', async () => {
  for (const [name, want] of Object.entries(RUNS))
    expect([name, await runAll(STATES[name], Object.keys(want))]).toEqual([name, want])
})

test('the palette lists the registry: > shows the same commands', () => {
  const ctx: ResultCtx = {
    usage: {},
    now: 1,
    index: null,
    visible: () => true,
    ops: null,
    history: [],
    recents: [],
    mask: t => t,
  }
  const shown = flatItems(buildSections(selectionState(), '>', ctx)).map(i => i.id)
  expect(shown).toEqual(ids(selectionState()))
})

test('registerAppActions is idempotent', () => {
  const before = allActions().length
  const err = console.error
  const logged: unknown[] = []
  console.error = (...a: unknown[]) => void logged.push(a)
  registerAppActions()
  console.error = err
  expect([allActions().length, logged]).toEqual([before, []])
  expect(before).toBeGreaterThan(40)
})

const m5: Target = { kind: 'message', message: msg(5), list: 'c1' }

test('expand: a row per entry, `<id>_<key>`, in the palette and in the menus the action joins', async () => {
  const got: Args[] = []
  const off = defineAction({
    id: 't_route',
    title: 'Route',
    scope: 'voice',
    icon: Copy,
    targets: ['message'],
    available: () => true,
    run: (_c, a) => void got.push(a),
    expand: () => [
      {
        key: 'a',
        label: 'Relay A',
        subtitle: 'a.example',
        checked: true,
        radio: true,
        args: { relay: 'a' },
      },
      { key: 'b', label: 'Relay B', icon: Trash2, danger: true, name: true, args: { relay: 'b' } },
    ],
  })
  const st = useStore.getState()
  const found = paletteCommands(ctxFor(st, m5, 'palette')).filter(r => r.action === 't_route')
  expect(found.map(r => [r.id, r.title, r.subtitle, r.icon, r.danger, r.name])).toEqual([
    ['t_route_a', 'Relay A', 'a.example', Copy, undefined, undefined],
    ['t_route_b', 'Relay B', undefined, Trash2, true, true],
  ])
  const menu = menuItems(ctxFor(st, m5, 'menu'))
  expect(menu.map(i => [i.label, i.subtitle, i.checked, i.radio, i.danger, i.icon])).toEqual([
    ['Relay A', 'a.example', true, true, undefined, Copy],
    ['Relay B', undefined, undefined, undefined, true, Trash2],
  ])
  await found[1].run()
  menu[0].action?.()
  await drain()
  expect(got).toEqual([{ relay: 'b' }, { relay: 'a' }])
  off()
  expect(menuItems(ctxFor(st, m5, 'menu'))).toEqual([])
})

const gone = "That's no longer available"

test('an entry gone by the time its row runs runs nothing and says so', async () => {
  const got: Args[] = []
  const off = defineAction({
    id: 't_entry',
    title: 'Entry',
    scope: 'global',
    available: () => true,
    run: (_c, a) => void got.push(a),
    expand: ({ s }) =>
      Object.keys(s.timeouts.s ?? {}).map(key => ({ key, label: key, args: { key } })),
  })
  const until = { ends: Date.now() + HOUR, reason: null }
  reset({ timeouts: { s: { bob: until, carol: until } } })
  const [bob, carol] = rows().filter(r => r.action === 't_entry')
  useStore.setState({ timeouts: { s: { carol: until } } })
  await bob.run()
  expect(got).toEqual([])
  expect(useStore.getState().toast?.text).toBe(gone)
  await carol.run()
  expect(got).toEqual([{ key: 'carol' }])
  off()
})

const recordPeople = () => {
  const calls: unknown[][] = []
  const record =
    (k: string) =>
    (...a: unknown[]) =>
      void calls.push([k, ...a])
  const people = ['removeTimeout', 'acceptFriend', 'denyFriend', 'askRemoveFriend', 'unblockUser']
  useStore.setState(Object.fromEntries(people.map(k => [k, record(k)])))
  return calls
}

test('a person or timeout gone before its row runs is left alone', async () => {
  const st = channelState()
  const calls = recordPeople()
  const stale = rowsById(st)
  useStore.setState({
    timeouts: {},
    incomingRequests: paged([]),
    friends: paged([]),
    blockList: paged([]),
  })
  for (const id of [
    'untimeout_s_bob',
    'accept_carol',
    'deny_carol',
    'unfriend_dave',
    'unblock_erin',
  ]) {
    useStore.setState({ toast: null })
    await stale[id].run()
    await drain()
    expect([id, useStore.getState().toast?.text]).toEqual([id, gone])
  }
  expect(calls).toEqual([])
})

test('a per-person action run by id acts only on a listed entry', async () => {
  const until = { ends: Date.now() + HOUR, reason: null }
  reset({ timeouts: { s: { bob: until }, x: { bob: until } } })
  const calls = recordPeople()
  const ctx = () => paletteCtx(useStore.getState())
  const none: Args[] = [
    {},
    { user: 'zed' },
    { server: 's' },
    { user: 'bob' },
    { server: 's', user: 'zed' },
    { server: 'x', user: 'bob' },
    { server: 's', user: 'constructor' },
  ]
  for (const id of ['untimeout', 'accept', 'deny', 'unfriend', 'unblock'])
    for (const args of none) await runAction(id, ctx(), args)
  await drain()
  expect(calls).toEqual([])
  await runAction('untimeout', ctx(), { server: 's', user: 'bob' })
  await runAction('accept', ctx(), { user: 'carol' })
  await runAction('deny', ctx(), { user: 'carol' })
  await runAction('unfriend', ctx(), { user: 'dave' })
  await runAction('unblock', ctx(), { user: 'erin' })
  await drain()
  expect(plain(calls)).toEqual([
    ['removeTimeout', 's', 'bob'],
    ['acceptFriend', 'user:carol:Carol'],
    ['denyFriend', 'carol'],
    ['askRemoveFriend', 'user:dave:Dave'],
    ['unblockUser', 'erin', 'Erin'],
  ])
})

test('an untimeout run by id in a server named like a built-in acts only on a listed entry', async () => {
  const until = { ends: Date.now() + HOUR, reason: null }
  const ctor = 'constructor'
  reset({
    me: me('alice', {
      servers: [{ name: ctor, display_name: 'Ctor', creator: null, is_admin: false }],
    }),
    servers: {
      [ctor]: serverDetail(ctor, {
        channels: [{ id: 1, name: 'general', kind: 'text', slowmode_seconds: 0 }],
        roles: [role(1, '#f00', MOD)],
      }),
    },
    members: { [ctor]: paged([member('alice', { role_ids: [1] })]) },
    view: { kind: 'channel', server: ctor, channelId: 1 },
    timeouts: {},
  })
  const calls = recordPeople()
  const ctx = () => paletteCtx(useStore.getState())
  for (const user of ['name', 'length', 'prototype', 'constructor'])
    await runAction('untimeout', ctx(), { server: ctor, user })
  await drain()
  expect(calls).toEqual([])
  useStore.setState({ timeouts: { [ctor]: { bob: until } } })
  await runAction('untimeout', ctx(), { server: ctor, user: 'bob' })
  await drain()
  expect(plain(calls)).toEqual([['removeTimeout', ctor, 'bob']])
})

test('an expansion row whose id is taken keeps the first row', () => {
  const offA = defineAction({
    id: 't_dup',
    title: 'Dup',
    scope: 'global',
    available: () => true,
    run: () => {},
    expand: () => [{ key: 'x', label: 'From expand' }],
  })
  const offB = defineAction({
    id: 't_dup_x',
    title: 'Plain',
    scope: 'global',
    available: () => true,
    run: () => {},
  })
  expect(
    rows()
      .filter(r => r.id === 't_dup_x')
      .map(r => r.title)
  ).toEqual(['From expand'])
  offA()
  offB()
})
