// The app's own palette commands, registered through the one registry in `palette.ts`. Each
// provider reads the current state, so the list follows the view (channel, DM, thread, Home),
// the selection, and what the viewer may do.

import {
  AtSign,
  Ban,
  Bell,
  BellOff,
  BarChart3,
  Check,
  CheckCheck,
  Command,
  Copy,
  Eye,
  EyeOff,
  FileClock,
  House,
  Inbox,
  Keyboard,
  Link,
  LogOut,
  MessageSquare,
  Moon,
  Phone,
  Pin,
  Plus,
  Search,
  Settings,
  ShieldOff,
  SquareCheck,
  Timer,
  TimerOff,
  Type,
  UserMinus,
  UserPlus,
  Users,
  Video,
  Webhook,
  X,
  type LucideIcon,
} from 'lucide-react'
import { parseAddCommand, parseNames } from './friends'
import { api, shareOrigin } from './instances'
import { LEVELS, MUTE_CHOICES, muteUntilFor, ownRule, type Level, type NotifyScope } from './notify'
import { registerCommands, type ArgChoice, type PaletteCommand } from './palette'
import { openPalette, openPollFromPalette } from './palette_store'
import { sharing } from './platform'
import type { PollTarget } from './polls_store'
import { dayEndTs } from './search'
import { selectionActions } from './selection_actions'
import { myPerms, serverAdminPerms, userRefFor, useStore } from './store'
import type { RChatState } from './store_types'
import { Perm, hasPerm, type UserRef } from './types'
import { threadKey, viewKey, viewPath } from './view'

export type SettingsSection =
  'settings' | 'notifications' | 'privacy' | 'sync' | 'information' | 'palette'

const get = () => useStore.getState()

const member = (s: RChatState) => s.me !== null && !s.guest

const copy = (text: string, done: string) =>
  void sharing()
    .copyText(text)
    .then(ok => (ok ? get().showToast(done) : get().setError('Could not copy to the clipboard')))

// The conversation the palette acts on: the open thread, else the open channel or DM.
export const currentScope = (s: RChatState): string | null =>
  s.panel?.kind === 'thread' ? threadKey(s.panel.root.id) : s.view ? viewKey(s.view) : null

const viewServer = (s: RChatState) => (s.view?.kind === 'channel' ? s.view.server : null)

const viewChannel = (s: RChatState) => {
  const v = s.view
  return v?.kind === 'channel'
    ? (s.servers[v.server]?.channels.find(c => c.id === v.channelId) ?? null)
    : null
}

const viewDm = (s: RChatState) => {
  const v = s.view
  return v?.kind === 'dm' ? (s.dms.find(d => d.id === v.dmId) ?? null) : null
}

const notifyScope = (s: RChatState): NotifyScope | null => {
  const v = s.view
  if (!v) return null
  return v.kind === 'channel'
    ? { kind: 'channel', id: v.channelId, server: v.server }
    : { kind: 'dm', id: v.dmId }
}

const scopeName = (s: RChatState) => {
  const c = viewChannel(s)
  if (c) return `#${c.name}`
  return viewDm(s) ? 'this DM' : 'this conversation'
}

const pollTarget = (s: RChatState): PollTarget | null => {
  if (!member(s)) return null
  if (s.panel?.kind === 'thread') return { kind: 'thread', id: s.panel.root.id }
  const v = s.view
  if (v?.kind === 'dm') return { kind: 'dm', id: v.dmId }
  const c = viewChannel(s)
  if (!c || c.kind !== 'text' || !v || v.kind !== 'channel') return null
  if (s.servers[v.server]?.read_only?.includes(c.id)) return null
  return { kind: 'channel', id: c.id }
}

const NAME = /^@?[^\s@,]{1,64}$/

const userArg = (placeholder = 'Username') => ({
  placeholder,
  check: (t: string) => (NAME.test(t.trim()) ? null : 'Type a username'),
})

const namesArg = {
  placeholder: 'Usernames, separated by spaces',
  check: (t: string) => (parseNames(t).length ? null : 'Type at least one username'),
}

const dateArg = {
  placeholder: 'Date, YYYY-MM-DD',
  check: (t: string) => (dayEndTs(t.trim()) === null ? 'Use a date like 2025-01-31' : null),
}

const username = (t: string) => t.trim().replace(/^@+/, '').toLowerCase()

const levelChoices: ArgChoice[] = [
  ...LEVELS.map(l => ({ value: l.level, label: l.label })),
  { value: 'default', label: 'Default' },
]

const muteChoices: ArgChoice[] = MUTE_CHOICES.map(c => ({
  value: c.ms === null ? 'forever' : String(c.ms),
  label: c.label,
}))

const mutedNow = (s: RChatState, scope: NotifyScope) => {
  const until = ownRule(s.notifyPrefs, scope)?.muteUntil
  return until === 'forever' || (typeof until === 'number' && until > Date.now())
}

const muteCommands = (
  s: RChatState,
  scope: NotifyScope,
  what: string,
  id: string
): PaletteCommand[] =>
  mutedNow(s, scope)
    ? [
        {
          id: `unmute_${id}`,
          title: `Unmute ${what}`,
          group: 'commands',
          icon: Bell,
          keywords: ['notifications'],
          run: () => get().muteScope(scope, null),
        },
      ]
    : [
        {
          id: `mute_${id}`,
          title: `Mute ${what}`,
          group: 'commands',
          icon: BellOff,
          keywords: ['notifications', 'silence'],
          arg: { placeholder: 'For how long', choices: muteChoices },
          run: arg =>
            get().muteScope(
              scope,
              arg === 'forever' ? 'forever' : muteUntilFor(Number(arg), Date.now())
            ),
        },
      ]

const levelCommand = (scope: NotifyScope, what: string, id: string): PaletteCommand => ({
  id: `level_${id}`,
  title: `Notification level for ${what}`,
  group: 'commands',
  icon: Bell,
  keywords: ['notify', 'mentions', 'all messages', 'nothing'],
  arg: { placeholder: 'Notify me about', choices: levelChoices },
  run: arg =>
    get().setNotifyLevel(scope, arg === 'default' ? null : ((arg ?? null) as Level | null)),
})

// Messages a DM or channel name may be opened with.
const jumpToDate = async (date: string) => {
  const s = get()
  const v = s.view
  const end = dayEndTs(date.trim())
  if (v?.kind !== 'channel' || end === null) return
  try {
    const page = await api.search({ server: v.server, channel_id: v.channelId, before_ts: end })
    const hit = page.items[0]
    if (!hit) {
      get().showToast('No messages on or before that day')
      return
    }
    await get().jumpTo(viewKey(v), hit.message.id, true)
  } catch {
    get().setError("Couldn't search this channel")
  }
}

const coreCommands = (s: RChatState): PaletteCommand[] => {
  const out: PaletteCommand[] = []
  const add = (c: PaletteCommand) => out.push(c)
  const signedIn = member(s)
  const scope = currentScope(s)
  const nScope = notifyScope(s)
  const server = viewServer(s)
  const dm = viewDm(s)
  const channel = viewChannel(s)
  const what = scopeName(s)

  add({
    id: 'home',
    title: 'Go home',
    group: 'navigation',
    icon: House,
    when: st => st.view !== null || !st.home,
    run: () => get().goHome(),
  })
  if (signedIn)
    add({
      id: 'inbox',
      title: 'Open inbox',
      group: 'commands',
      icon: Inbox,
      keywords: ['notifications', 'mentions', 'pings'],
      run: () => get().setInboxOpen(true),
    })
  if (scope) {
    add({
      id: 'mark_read_here',
      title: `Mark ${what} as read`,
      group: 'commands',
      icon: Check,
      keywords: ['read', 'unread'],
      run: () => void get().markScopesRead([scope]),
    })
    add({
      id: 'jump_unread',
      title: 'Jump to first unread',
      group: 'commands',
      icon: AtSign,
      run: () => void get().jumpToUnread(),
    })
    add({
      id: 'jump_present',
      title: 'Jump to present',
      group: 'commands',
      icon: CheckCheck,
      keywords: ['latest', 'bottom'],
      run: () => void get().jumpToPresent(scope),
    })
    add({
      id: 'select',
      title: 'Select messages',
      group: 'commands',
      icon: SquareCheck,
      keywords: ['bulk', 'delete', 'export'],
      hint: 'Mod+Shift+S',
      when: st => st.selection === null,
      run: () => get().startSelection(scope),
    })
    add({
      id: 'pins',
      title: 'Show pinned messages',
      group: 'commands',
      icon: Pin,
      run: () => get().openPins(),
    })
  }
  if (s.view)
    add({
      id: 'copy_link_here',
      title: `Copy link to ${what}`,
      group: 'commands',
      icon: Link,
      keywords: ['share', 'url'],
      run: () => {
        const v = get().view
        if (v) copy(`${shareOrigin()}${viewPath(v)}`, 'Link copied')
      },
    })
  if (channel && channel.kind === 'text') {
    add({
      id: 'search_channel',
      title: 'Search messages on the server',
      group: 'commands',
      icon: Search,
      run: () => get().openSearch(),
    })
    add({
      id: 'jump_date',
      title: 'Jump to date',
      group: 'commands',
      icon: FileClock,
      keywords: ['history', 'day'],
      arg: dateArg,
      run: arg => void jumpToDate(arg ?? ''),
    })
  }
  if (nScope) {
    out.push(...muteCommands(s, nScope, what, 'here'))
    add(levelCommand(nScope, what, 'here'))
  }
  if (server) {
    const sScope: NotifyScope = { kind: 'server', name: server }
    add({
      id: 'mark_server_read',
      title: 'Mark this server as read',
      group: 'commands',
      icon: Check,
      run: () => void get().markServerRead(server),
    })
    out.push(...muteCommands(s, sScope, 'this server', 'server'))
    add(levelCommand(sScope, 'this server', 'server'))
    const perms = myPerms(s, server)
    if (signedIn && serverAdminPerms(s, server) !== 0)
      add({
        id: 'server_settings',
        title: 'Server settings',
        group: 'settings',
        icon: Settings,
        run: () => get().openDialog({ kind: 'server_settings', server }),
      })
    if (signedIn && hasPerm(perms, Perm.ViewAuditLog))
      add({
        id: 'audit_log',
        title: 'Open audit log',
        group: 'commands',
        icon: FileClock,
        run: () => get().openDialog({ kind: 'audit_log', server }),
      })
    if (signedIn && (hasPerm(perms, Perm.ManageWebhooks) || hasPerm(perms, Perm.ManageChannels)))
      add({
        id: 'webhooks',
        title: 'Manage webhooks',
        group: 'commands',
        icon: Webhook,
        keywords: ['integrations', 'bots'],
        run: () => get().openDialog({ kind: 'webhooks', server }),
      })
    if (signedIn && hasPerm(perms, Perm.TimeoutMembers)) {
      add({
        id: 'timeout_member',
        title: 'Time out a member',
        group: 'commands',
        icon: Timer,
        keywords: ['mute', 'moderation'],
        arg: userArg(),
        run: arg => {
          const user = userRefFor(get(), username(arg ?? ''))
          get().openDialog({ kind: 'timeout', server, user })
        },
      })
      for (const name of Object.keys(s.timeouts[server] ?? {}))
        add({
          id: `untimeout_${server}_${name}`,
          title: `Remove timeout: ${userRefFor(s, name).display_name}`,
          group: 'commands',
          icon: TimerOff,
          name: true,
          run: () => void get().removeTimeout(server, name),
        })
    }
    if (signedIn && server !== 'rchat' && s.me?.servers.some(x => x.name === server))
      add({
        id: 'leave_server',
        title: 'Leave this server',
        group: 'commands',
        icon: LogOut,
        danger: true,
        run: () =>
          get().askConfirm({
            title: 'Leave Server',
            body: 'Leave this server? You can join it again later.',
            confirm: 'Leave',
            action: () => void get().leaveServer(server),
          }),
      })
  }
  const target = pollTarget(s)
  if (target)
    add({
      id: 'poll',
      title: 'Create poll',
      group: 'commands',
      icon: BarChart3,
      keywords: ['vote', 'survey'],
      slash: 'poll',
      run: () => openPollFromPalette(target),
    })
  if (dm && signedIn && !dm.is_self) {
    if (!Object.hasOwn(s.blocked, dm.other.username)) {
      add({
        id: 'call',
        title: `Call ${dm.other.display_name}`,
        group: 'commands',
        icon: Phone,
        name: true,
        when: st => st.call === null,
        run: () => void get().startCall(dm.id, false),
      })
      add({
        id: 'video_call',
        title: `Video call ${dm.other.display_name}`,
        group: 'commands',
        icon: Video,
        name: true,
        when: st => st.call === null,
        run: () => void get().startCall(dm.id, true),
      })
    }
    add({
      id: 'close_dm',
      title: 'Close this DM',
      group: 'commands',
      icon: X,
      run: () => void get().closeDm(dm.id),
    })
  }
  if (s.call)
    add({
      id: 'hangup',
      title: 'Leave call',
      group: 'commands',
      icon: Phone,
      danger: true,
      run: () => get().hangupCall(),
    })
  if (s.voice)
    add({
      id: 'leave_voice',
      title: 'Leave voice channel',
      group: 'commands',
      icon: Phone,
      danger: true,
      run: () => get().leaveVoice(),
    })
  if (s.voice || s.call) {
    add({
      id: 'mute_mic',
      title: 'Toggle microphone',
      group: 'commands',
      icon: Phone,
      run: () => get().toggleMute(),
    })
    add({
      id: 'deafen',
      title: 'Toggle deafen',
      group: 'commands',
      icon: Phone,
      run: () => get().toggleDeafen(),
    })
  }
  if (signedIn) {
    add({
      id: 'mark_all_read',
      title: 'Mark everything as read',
      group: 'commands',
      icon: CheckCheck,
      hint: 'Shift+Escape',
      run: () => get().askMarkAllRead(),
    })
    add({
      id: 'mark_dms_read',
      title: 'Mark all DMs as read',
      group: 'commands',
      icon: Check,
      run: () => void get().markDmsRead(),
    })
    add({
      id: 'start_dm',
      title: 'Start a DM',
      group: 'commands',
      icon: MessageSquare,
      keywords: ['message', 'direct', 'chat'],
      arg: userArg(),
      parse: t => {
        const m = /^\s*(?:dm|message|msg)\s+@?(\S+)\s*$/i.exec(t)
        return m ? m[1] : null
      },
      run: arg => void get().startDm(username(arg ?? '')),
    })
    add({
      id: 'create_server',
      title: 'Create a server',
      group: 'commands',
      icon: Plus,
      run: () => get().openDialog({ kind: 'add_server', tab: 'create' }),
    })
  }
  add({
    id: 'join_server',
    title: 'Join a server',
    group: 'commands',
    icon: Plus,
    keywords: ['invite'],
    arg: { placeholder: 'Server name (or leave empty)' },
    parse: t => {
      const m = /^\s*join\s+(\S+)\s*$/i.exec(t)
      return m ? m[1] : null
    },
    run: arg => {
      const name = (arg ?? '').trim().toLowerCase()
      get().openDialog({ kind: 'add_server', tab: 'join', ...(name ? { join: name } : {}) })
    },
  })
  add({
    id: 'palette_help',
    title: 'Palette help',
    group: 'help',
    icon: Command,
    keywords: ['prefix', 'how'],
    keepOpen: true,
    run: () => openPalette('?'),
  })
  if (signedIn)
    add({
      id: 'logout',
      title: 'Log out',
      group: 'commands',
      icon: LogOut,
      danger: true,
      keywords: ['sign out'],
      run: () =>
        get().askConfirm({
          title: 'Log out',
          body: 'Log out of this account on this device?',
          confirm: 'Log out',
          action: () => get().logout(),
        }),
    })
  return out
}

const friendCommands = (s: RChatState): PaletteCommand[] => {
  if (!member(s)) return []
  const out: PaletteCommand[] = [
    {
      id: 'friends',
      title: 'Open friends',
      group: 'friends',
      icon: Users,
      run: () => get().openFriends(),
    },
    {
      id: 'add_friends',
      title: 'Add friends',
      group: 'friends',
      icon: UserPlus,
      keywords: ['friend request', 'add friend'],
      arg: namesArg,
      parse: t => parseAddCommand(t)?.join(' ') ?? null,
      run: arg => get().askAddFriends(parseNames(arg ?? '')),
    },
    {
      id: 'block',
      title: 'Block someone',
      group: 'friends',
      icon: Ban,
      danger: true,
      arg: userArg(),
      parse: t => {
        const m = /^\s*block\s+@?(\S+)\s*$/i.exec(t)
        return m ? m[1] : null
      },
      run: arg => get().askBlock(userRefFor(get(), username(arg ?? ''))),
    },
  ]
  for (const r of s.incomingRequests.list) {
    const u = r.user
    out.push(
      {
        id: `accept_${u.username}`,
        title: `Accept friend request: ${u.display_name}`,
        subtitle: `@${u.username}`,
        subtitleName: true,
        group: 'friends',
        icon: UserPlus,
        name: true,
        run: () => void get().acceptFriend(u),
      },
      {
        id: `deny_${u.username}`,
        title: `Deny friend request: ${u.display_name}`,
        subtitle: `@${u.username}`,
        subtitleName: true,
        group: 'friends',
        icon: UserMinus,
        name: true,
        run: () => void get().denyFriend(u.username),
      }
    )
  }
  for (const f of s.friends.list) {
    const u: UserRef = f.user
    out.push({
      id: `unfriend_${u.username}`,
      title: `Remove friend: ${u.display_name}`,
      subtitle: `@${u.username}`,
      subtitleName: true,
      group: 'friends',
      icon: UserMinus,
      name: true,
      danger: true,
      run: () => get().askRemoveFriend(u),
    })
  }
  for (const b of s.blockList.list)
    out.push({
      id: `unblock_${b.user.username}`,
      title: `Unblock ${b.user.display_name}`,
      subtitle: `@${b.user.username}`,
      subtitleName: true,
      group: 'friends',
      icon: ShieldOff,
      name: true,
      run: () => void get().unblockUser(b.user.username, b.user.display_name),
    })
  return out
}

const openSettings = (section: SettingsSection) => get().openDialog({ kind: 'settings', section })

const settingsCommands = (s: RChatState): PaletteCommand[] => {
  const shown = s.me !== null || s.guest
  const out: PaletteCommand[] = [
    {
      id: 'theme',
      title: s.theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme',
      group: 'settings',
      icon: Moon,
      keywords: ['theme', 'appearance', 'dark', 'light'],
      run: () => get().setTheme(get().theme === 'light' ? 'dark' : 'light'),
    },
    {
      id: 'streamer',
      title: s.streamer ? 'Turn off streamer mode' : 'Turn on streamer mode',
      group: 'settings',
      icon: s.streamer ? Eye : EyeOff,
      keywords: ['blur', 'privacy'],
      run: () => get().setStreamer(!get().streamer),
    },
  ]
  const add = (c: PaletteCommand) => out.push(c)
  if (shown) {
    add({
      id: 'typing',
      title: s.typingOn ? 'Turn off typing indicators' : 'Turn on typing indicators',
      group: 'settings',
      icon: Type,
      run: () => get().setTypingOn(!get().typingOn),
    })
    add({
      id: 'profanity',
      title: s.profanityOn ? 'Turn off the profanity filter' : 'Turn on the profanity filter',
      group: 'settings',
      icon: EyeOff,
      keywords: ['filter', 'mask'],
      run: () => get().setProfanityOn(!get().profanityOn),
    })
    add({
      id: 'spoilers',
      title: s.showSpoilers === 'always' ? 'Show spoilers on click' : 'Always show spoilers',
      group: 'settings',
      icon: Eye,
      run: () => get().setShowSpoilers(get().showSpoilers === 'always' ? 'click' : 'always'),
    })
  }
  if (member(s) && s.me)
    add({
      id: 'appear_offline',
      title: s.me.appear_offline ? 'Stop appearing offline' : 'Appear offline',
      group: 'settings',
      icon: EyeOff,
      keywords: ['status', 'invisible', 'presence'],
      run: () => void get().setAppearOffline(!get().me?.appear_offline),
    })
  const sections: [SettingsSection, string, LucideIcon][] = [
    ['settings', 'Open settings', Settings],
    ['notifications', 'Settings: Notifications', Bell],
    ...(member(s)
      ? ([['privacy', 'Settings: Privacy', ShieldOff]] as [SettingsSection, string, LucideIcon][])
      : []),
    ['sync', 'Settings: Sync config', Copy],
    ['palette', 'Settings: Command palette', Command],
    ['information', 'Settings: Information', Keyboard],
  ]
  for (const [section, title, icon] of sections)
    add({
      id: `settings_${section}`,
      title,
      group: 'settings',
      icon,
      keywords: section === 'information' ? ['keyboard shortcuts', 'help'] : ['preferences'],
      run: () => openSettings(section),
    })
  return out
}

const selectionCommands = (s: RChatState): PaletteCommand[] =>
  selectionActions(s).map(a => ({
    id: `selection_${a.id}`,
    title: a.label,
    group: 'selection',
    icon: a.icon,
    danger: a.danger,
    keywords: ['selected', 'messages'],
    run: a.run,
  }))

let registered = false

export const registerCoreCommands = () => {
  if (registered) return
  registered = true
  registerCommands('selection', selectionCommands)
  registerCommands('core', coreCommands)
  registerCommands('friends', friendCommands)
  registerCommands('settings', settingsCommands)
}
