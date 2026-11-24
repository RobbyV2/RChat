import { submittedLinkTarget, routeInstanceLink } from '../client/instance_links'
import { liveSwitcherRows } from '../client/switcher_rows'
import { switchActor } from '../client/switch_actor'
import { canAddInstance } from '../client/adding'
import { instanceLabel } from '../instance_label'
import { ownInstance } from '../instances'
import {
  Check,
  CheckCheck,
  Command,
  House,
  Inbox,
  LogOut,
  MessageSquare,
  Phone,
  Plus,
} from 'lucide-react'
import { openPalette } from '../palette_store'
import { allMarkTargets } from '../store'
import type { RChatState } from '../store_types'
import type { Action, ArgStep } from './types'

export const signedIn = (s: RChatState) => s.me !== null && !s.guest

const NAME = /^@?[^\s@,]{1,64}$/

export const usernameStep: ArgStep = {
  kind: 'text',
  name: 'value',
  prompt: 'Username',
  check: t => (NAME.test(t.trim()) ? null : 'Type a username'),
}

export const username = (t: string) => t.trim().replace(/^@+/, '').toLowerCase()

// Where to go; the palette lists these before the open place's commands.
export const goActions: Action[] = [
  {
    id: 'home',
    title: 'Go home',
    scope: 'global',
    group: 'navigation',
    icon: House,
    available: ({ s }) => s.view !== null || !s.home,
    run: ({ acct }) => acct.store.getState().goHome(),
  },
  {
    id: 'inbox',
    title: 'Open inbox',
    scope: 'global',
    icon: Inbox,
    keywords: ['notifications', 'mentions', 'pings'],
    available: ({ s }) => signedIn(s),
    run: ({ acct }) => acct.store.getState().setInboxOpen(true),
  },
]

const switchGroups = () =>
  liveSwitcherRows().groups.filter(g => canAddInstance() || g.origin === ownInstance()?.origin)

export const globalActions: Action[] = [
  {
    id: 'switch_account',
    title: 'Switch account',
    scope: 'global',
    group: 'navigation',
    icon: Command,
    hint: 'Mod+Shift+L',
    available: () => true,
    run: ({ acct }) => acct.store.getState().openDialog({ kind: 'account_switcher' }),
  },
  {
    id: 'manage_accounts',
    title: 'Manage accounts',
    scope: 'global',
    icon: Command,
    available: () => true,
    run: ({ acct }) => acct.store.getState().openDialog({ kind: 'account_switcher', manage: true }),
  },
  {
    id: 'switch_to_actor',
    title: 'Switch to account',
    scope: 'global',
    group: 'navigation',
    icon: Command,
    available: () => true,
    expand: () => {
      const groups = switchGroups()
      return groups.flatMap(g =>
        g.rows
          .filter(r => r.status !== 'Signed out')
          .map(r => ({
            key: JSON.stringify([r.origin, r.username, r.local]),
            label: 'Switch to ' + r.display + ' on ' + instanceLabel(g, g.host, groups),
            name: true,
            subtitle: r.local ? 'P2P · ' + r.username : (r.username ?? 'Guest'),
            subtitleName: true,
            args: { key: JSON.stringify([r.origin, r.username, r.local]) },
          }))
      )
    },
    run: ({ acct }, { key }) => {
      const r = switchGroups()
        .flatMap(g => g.rows)
        .find(r => JSON.stringify([r.origin, r.username, r.local]) === key)
      if (r && r.status !== 'Signed out') void switchActor(r, acct)
    },
  },
  {
    id: 'hangup',
    title: 'Leave call',
    scope: 'voice',
    icon: Phone,
    danger: true,
    available: ({ s }) => !!s.call,
    run: ({ acct }) => acct.store.getState().hangupCall(),
  },
  {
    id: 'leave_voice',
    title: 'Leave voice channel',
    scope: 'voice',
    icon: Phone,
    danger: true,
    available: ({ s }) => !!s.voice,
    run: ({ acct }) => acct.store.getState().leaveVoice(),
  },
  {
    id: 'mute_mic',
    title: 'Toggle microphone',
    scope: 'voice',
    icon: Phone,
    available: ({ s }) => !!(s.voice || s.call),
    run: ({ acct }) => acct.store.getState().toggleMute(),
  },
  {
    id: 'deafen',
    title: 'Toggle deafen',
    scope: 'voice',
    icon: Phone,
    available: ({ s }) => !!(s.voice || s.call),
    run: ({ acct }) => acct.store.getState().toggleDeafen(),
  },
  {
    id: 'mark_all_read',
    title: 'Mark everything as read',
    label: ({ via }) => (via === 'menu' ? 'Mark all as read' : 'Mark everything as read'),
    scope: 'global',
    icon: CheckCheck,
    hint: 'Shift+Escape',
    targets: ['home'],
    disabled: ({ identity, s }) => !allMarkTargets(s).length && !identity?.p2pMarkAll().pending,
    available: ({ s }) => signedIn(s),
    run: ({ acct, identity }) => acct.store.getState().askMarkAllRead(identity?.p2pMarkAll()),
  },
  {
    id: 'mark_dms_read',
    title: 'Mark all DMs as read',
    scope: 'global',
    icon: Check,
    available: ({ s }) => signedIn(s),
    run: ({ acct }) => void acct.store.getState().markDmsRead(),
  },
  {
    id: 'start_dm',
    title: 'Start a DM',
    scope: 'global',
    icon: MessageSquare,
    keywords: ['message', 'direct', 'chat'],
    args: [usernameStep],
    parse: t => /^\s*(?:dm|message|msg)\s+@?(\S+)\s*$/i.exec(t)?.[1] ?? null,
    available: ({ s }) => signedIn(s),
    run: (_ctx, { value }) => void _ctx.acct.store.getState().startDm(username(value)),
  },
  {
    id: 'create_server',
    title: 'Create a server',
    scope: 'global',
    icon: Plus,
    available: ({ s }) => signedIn(s),
    run: ({ acct }) => acct.store.getState().openDialog({ kind: 'add_server', tab: 'create' }),
  },
  {
    id: 'add_instance',
    title: 'Add an instance',
    scope: 'global',
    icon: Plus,
    available: () => canAddInstance(),
    run: ({ acct }) => acct.store.getState().openDialog({ kind: 'add_instance' }),
  },

  {
    id: 'join_server',
    title: 'Join a server',
    scope: 'global',
    icon: Plus,
    keywords: ['invite'],
    args: [{ kind: 'text', name: 'value', prompt: 'Server name (or leave empty)' }],
    parse: t => /^\s*join\s+(\S+)\s*$/i.exec(t)?.[1] ?? null,
    available: () => true,
    run: (_ctx, { value }) => {
      const raw = value.trim()
      if (raw.includes('/')) {
        const target = submittedLinkTarget(_ctx.acct, raw)
        if (target) return routeInstanceLink(_ctx.acct, target)
      }
      const name = /^(?:rci1|rcp1)\./i.test(raw) ? raw : raw.toLowerCase()
      _ctx.acct.store
        .getState()
        .openDialog({ kind: 'add_server', tab: 'join', ...(name ? { join: name } : {}) })
    },
  },
  {
    id: 'palette_help',
    title: 'Palette help',
    scope: 'global',
    group: 'help',
    icon: Command,
    keywords: ['prefix', 'how'],
    keepOpen: true,
    available: () => true,
    run: ({ acct }) => openPalette('?', acct),
  },
  {
    id: 'logout',
    title: 'Log out',
    scope: 'global',
    icon: LogOut,
    danger: true,
    keywords: ['sign out'],
    args: [
      {
        kind: 'confirm',
        title: 'Log out',
        body: () => 'Log out of this account on this device?',
        confirm: 'Log out',
      },
    ],
    available: ({ s }) => signedIn(s),
    run: ({ acct }) => acct.store.getState().logout(),
  },
]
