// Commands on the open place: its conversation (the open thread, else the channel or DM), the
// channel, the DM and the server.

import {
  AtSign,
  BarChart3,
  Bell,
  BellOff,
  Check,
  CheckCheck,
  FileClock,
  Link,
  LogOut,
  Phone,
  Pin,
  Search,
  Settings,
  SquareCheck,
  Timer,
  TimerOff,
  Video,
  Webhook,
  X,
} from 'lucide-react'
import { api, shareOrigin } from '../instances'
import {
  LEVELS,
  MUTE_CHOICES,
  muteUntilFor,
  ownRule,
  type Level,
  type NotifyScope,
} from '../notify'
import { openPollFromPalette } from '../palette_store'
import { sharing } from '../platform'
import type { PollTarget } from '../polls_store'
import { dayEndTs } from '../search'
import { myPerms, serverAdminPerms, userRefFor, useStore } from '../store'
import type { RChatState } from '../store_types'
import { Perm, hasPerm } from '../types'
import { viewKey, viewPath } from '../view'
import { signedIn, username, usernameStep } from './global'
import type { Action, ActionCtx, ArgChoice, ArgStep, Scope } from './types'

const get = () => useStore.getState()

const copy = (text: string, done: string) =>
  void sharing()
    .copyText(text)
    .then(ok => (ok ? get().showToast(done) : get().setError('Could not copy to the clipboard')))

const what = ({ channel, dm }: ActionCtx) =>
  channel ? `#${channel.name}` : dm ? 'this DM' : 'this conversation'

// The open channel or DM, as the view names it (its details may not have loaded yet).
const notifyHere = ({ s }: ActionCtx): NotifyScope | null => {
  const v = s.view
  if (!v) return null
  return v.kind === 'channel'
    ? { kind: 'channel', id: v.channelId, server: v.server }
    : { kind: 'dm', id: v.dmId }
}

const notifyServer = ({ server }: ActionCtx): NotifyScope | null =>
  server === null ? null : { kind: 'server', name: server }

const mutedNow = (s: RChatState, scope: NotifyScope) => {
  const until = ownRule(s.notifyPrefs, scope)?.muteUntil
  return until === 'forever' || (typeof until === 'number' && until > Date.now())
}

const muteChoices: ArgChoice[] = MUTE_CHOICES.map(c => ({
  value: c.ms === null ? 'forever' : String(c.ms),
  label: c.label,
}))

const levelChoices: ArgChoice[] = [
  ...LEVELS.map(l => ({ value: l.level, label: l.label })),
  { value: 'default', label: 'Default' },
]

interface NotifyPlace {
  key: string
  scope: Scope
  of(ctx: ActionCtx): NotifyScope | null
  // In titles: a fixed name, or one from the context.
  name: string | ((ctx: ActionCtx) => string)
}

const named = (p: NotifyPlace, verb: string, alone: string) => {
  const name = p.name
  return typeof name === 'string'
    ? { title: `${verb} ${name}` }
    : { title: alone, label: (ctx: ActionCtx) => `${verb} ${name(ctx)}` }
}

const notifyActions = (p: NotifyPlace): Action[] => [
  {
    id: `mute_${p.key}`,
    ...named(p, 'Mute', 'Mute'),
    scope: p.scope,
    icon: BellOff,
    keywords: ['notifications', 'silence'],
    args: [{ kind: 'choice', name: 'value', prompt: 'For how long', choices: () => muteChoices }],
    available: ctx => {
      const scope = p.of(ctx)
      return scope !== null && !mutedNow(ctx.s, scope)
    },
    run: (ctx, { value }) => {
      const scope = p.of(ctx)
      if (scope)
        get().muteScope(
          scope,
          value === 'forever' ? 'forever' : muteUntilFor(Number(value), Date.now())
        )
    },
  },
  {
    id: `unmute_${p.key}`,
    ...named(p, 'Unmute', 'Unmute'),
    scope: p.scope,
    icon: Bell,
    keywords: ['notifications'],
    available: ctx => {
      const scope = p.of(ctx)
      return scope !== null && mutedNow(ctx.s, scope)
    },
    run: ctx => {
      const scope = p.of(ctx)
      if (scope) get().muteScope(scope, null)
    },
  },
  {
    id: `level_${p.key}`,
    ...named(p, 'Notification level for', 'Notification level'),
    scope: p.scope,
    icon: Bell,
    keywords: ['notify', 'mentions', 'all messages', 'nothing'],
    args: [
      { kind: 'choice', name: 'value', prompt: 'Notify me about', choices: () => levelChoices },
    ],
    available: ctx => p.of(ctx) !== null,
    run: (ctx, { value }) => {
      const scope = p.of(ctx)
      if (scope) get().setNotifyLevel(scope, value === 'default' ? null : (value as Level))
    },
  },
]

const dateStep: ArgStep = {
  kind: 'text',
  name: 'value',
  prompt: 'Date, YYYY-MM-DD',
  check: t => (dayEndTs(t.trim()) === null ? 'Use a date like 2025-01-31' : null),
}

const jumpToDate = async ({ s }: ActionCtx, date: string) => {
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

const textChannel = ({ channel }: ActionCtx) => channel?.kind === 'text'

const may =
  (...perms: number[]) =>
  ({ s, server }: ActionCtx) =>
    signedIn(s) && server !== null && perms.some(p => hasPerm(myPerms(s, server), p))

const pollTarget = ({ s, server, channel }: ActionCtx): PollTarget | null => {
  if (!signedIn(s)) return null
  if (s.panel?.kind === 'thread') return { kind: 'thread', id: s.panel.root.id }
  if (s.view?.kind === 'dm') return { kind: 'dm', id: s.view.dmId }
  if (!channel || channel.kind !== 'text' || server === null) return null
  if (s.servers[server]?.read_only?.includes(channel.id)) return null
  return { kind: 'channel', id: channel.id }
}

const inDm = ({ s, dm }: ActionCtx) => signedIn(s) && dm !== null && !dm.is_self

const callable = (ctx: ActionCtx) => {
  const { s, dm } = ctx
  return inDm(ctx) && dm !== null && !Object.hasOwn(s.blocked, dm.other.username) && s.call === null
}

export const placeActions: Action[] = [
  {
    id: 'mark_read_here',
    title: 'Mark as read',
    label: ctx => `Mark ${what(ctx)} as read`,
    scope: 'channel',
    icon: Check,
    keywords: ['read', 'unread'],
    available: ({ list }) => list !== null,
    run: ({ list }) => {
      if (list) void get().markScopesRead([list])
    },
  },
  {
    id: 'jump_unread',
    title: 'Jump to first unread',
    scope: 'channel',
    icon: AtSign,
    available: ({ list }) => list !== null,
    run: () => void get().jumpToUnread(),
  },
  {
    id: 'jump_present',
    title: 'Jump to present',
    scope: 'channel',
    icon: CheckCheck,
    keywords: ['latest', 'bottom'],
    available: ({ list }) => list !== null,
    run: ({ list }) => {
      if (list) void get().jumpToPresent(list)
    },
  },
  {
    id: 'select',
    title: 'Select messages',
    scope: 'channel',
    icon: SquareCheck,
    keywords: ['bulk', 'delete', 'export'],
    hint: 'Mod+Shift+S',
    available: ({ s, list }) => list !== null && s.selection === null,
    run: ({ list }) => {
      if (list) get().startSelection(list)
    },
  },
  {
    id: 'pins',
    title: 'Show pinned messages',
    scope: 'channel',
    icon: Pin,
    available: ({ list }) => list !== null,
    run: () => get().openPins(),
  },
  {
    id: 'copy_link_here',
    title: 'Copy link',
    label: ctx => `Copy link to ${what(ctx)}`,
    scope: 'channel',
    icon: Link,
    keywords: ['share', 'url'],
    available: ({ s }) => s.view !== null,
    run: ({ s }) => {
      if (s.view) copy(`${shareOrigin()}${viewPath(s.view)}`, 'Link copied')
    },
  },
  {
    id: 'search_channel',
    title: 'Search messages on the server',
    scope: 'channel',
    icon: Search,
    available: textChannel,
    run: () => get().openSearch(),
  },
  {
    id: 'jump_date',
    title: 'Jump to date',
    scope: 'channel',
    icon: FileClock,
    keywords: ['history', 'day'],
    args: [dateStep],
    available: textChannel,
    run: (ctx, { value }) => void jumpToDate(ctx, value),
  },
  ...notifyActions({ key: 'here', scope: 'channel', of: notifyHere, name: what }),
  {
    id: 'mark_server_read',
    title: 'Mark this server as read',
    scope: 'server',
    icon: Check,
    available: ({ server }) => server !== null,
    run: ({ server }) => {
      if (server) void get().markServerRead(server)
    },
  },
  ...notifyActions({ key: 'server', scope: 'server', of: notifyServer, name: 'this server' }),
  {
    id: 'server_settings',
    title: 'Server settings',
    scope: 'server',
    group: 'settings',
    icon: Settings,
    available: ({ s, server }) =>
      signedIn(s) && server !== null && serverAdminPerms(s, server) !== 0,
    run: ({ server }) => {
      if (server) get().openDialog({ kind: 'server_settings', server })
    },
  },
  {
    id: 'audit_log',
    title: 'Open audit log',
    scope: 'server',
    icon: FileClock,
    available: may(Perm.ViewAuditLog),
    run: ({ server }) => {
      if (server) get().openDialog({ kind: 'audit_log', server })
    },
  },
  {
    id: 'webhooks',
    title: 'Manage webhooks',
    scope: 'server',
    icon: Webhook,
    keywords: ['integrations', 'bots'],
    available: may(Perm.ManageWebhooks, Perm.ManageChannels),
    run: ({ server }) => {
      if (server) get().openDialog({ kind: 'webhooks', server })
    },
  },
  {
    id: 'timeout_member',
    title: 'Time out a member',
    scope: 'server',
    icon: Timer,
    keywords: ['mute', 'moderation'],
    args: [usernameStep],
    available: may(Perm.TimeoutMembers),
    run: ({ s, server }, { value }) => {
      if (server)
        get().openDialog({ kind: 'timeout', server, user: userRefFor(s, username(value)) })
    },
  },
  {
    id: 'untimeout',
    title: 'Remove timeout',
    scope: 'server',
    icon: TimerOff,
    available: may(Perm.TimeoutMembers),
    expand: ({ s, server }) =>
      server === null
        ? []
        : Object.keys(s.timeouts[server] ?? {}).map(name => ({
            key: `${server}_${name}`,
            label: `Remove timeout: ${userRefFor(s, name).display_name}`,
            name: true,
            args: { server, user: name },
          })),
    run: ({ s, server: here }, { server, user }) => {
      if (server === here && Object.keys(s.timeouts[server] ?? {}).includes(user))
        void get().removeTimeout(server, user)
    },
  },
  {
    id: 'leave_server',
    title: 'Leave this server',
    scope: 'server',
    icon: LogOut,
    danger: true,
    args: [
      {
        kind: 'confirm',
        title: 'Leave Server',
        body: () => 'Leave this server? You can join it again later.',
        confirm: 'Leave',
      },
    ],
    available: ({ s, server }) =>
      signedIn(s) &&
      server !== null &&
      server !== 'rchat' &&
      !!s.me?.servers.some(x => x.name === server),
    run: ({ server }) => {
      if (server) void get().leaveServer(server)
    },
  },
  {
    id: 'poll',
    title: 'Create poll',
    scope: 'channel',
    icon: BarChart3,
    keywords: ['vote', 'survey'],
    slash: 'poll',
    available: ctx => pollTarget(ctx) !== null,
    run: ctx => {
      const target = pollTarget(ctx)
      if (target) openPollFromPalette(target)
    },
  },
  {
    id: 'call',
    title: 'Call',
    label: ({ dm }) => `Call ${dm?.other.display_name ?? ''}`,
    scope: 'dm',
    icon: Phone,
    name: true,
    available: callable,
    run: ({ dm }) => {
      if (dm) void get().startCall(dm.id, false)
    },
  },
  {
    id: 'video_call',
    title: 'Video call',
    label: ({ dm }) => `Video call ${dm?.other.display_name ?? ''}`,
    scope: 'dm',
    icon: Video,
    name: true,
    available: callable,
    run: ({ dm }) => {
      if (dm) void get().startCall(dm.id, true)
    },
  },
  {
    id: 'close_dm',
    title: 'Close this DM',
    scope: 'dm',
    icon: X,
    available: inDm,
    run: ({ dm }) => {
      if (dm) void get().closeDm(dm.id)
    },
  },
]
