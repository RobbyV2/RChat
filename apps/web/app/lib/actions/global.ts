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
import { p2pMarkAll } from '../p2p/app'
import { openPalette } from '../palette_store'
import { allMarkTargets, useStore } from '../store'
import type { RChatState } from '../store_types'
import type { Action, ArgStep } from './types'

const get = () => useStore.getState()

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
    run: () => get().goHome(),
  },
  {
    id: 'inbox',
    title: 'Open inbox',
    scope: 'global',
    icon: Inbox,
    keywords: ['notifications', 'mentions', 'pings'],
    available: ({ s }) => signedIn(s),
    run: () => get().setInboxOpen(true),
  },
]

export const globalActions: Action[] = [
  {
    id: 'hangup',
    title: 'Leave call',
    scope: 'voice',
    icon: Phone,
    danger: true,
    available: ({ s }) => !!s.call,
    run: () => get().hangupCall(),
  },
  {
    id: 'leave_voice',
    title: 'Leave voice channel',
    scope: 'voice',
    icon: Phone,
    danger: true,
    available: ({ s }) => !!s.voice,
    run: () => get().leaveVoice(),
  },
  {
    id: 'mute_mic',
    title: 'Toggle microphone',
    scope: 'voice',
    icon: Phone,
    available: ({ s }) => !!(s.voice || s.call),
    run: () => get().toggleMute(),
  },
  {
    id: 'deafen',
    title: 'Toggle deafen',
    scope: 'voice',
    icon: Phone,
    available: ({ s }) => !!(s.voice || s.call),
    run: () => get().toggleDeafen(),
  },
  {
    id: 'mark_all_read',
    title: 'Mark everything as read',
    label: ({ via }) => (via === 'menu' ? 'Mark all as read' : 'Mark everything as read'),
    scope: 'global',
    icon: CheckCheck,
    hint: 'Shift+Escape',
    targets: ['home'],
    disabled: ({ s }) => !allMarkTargets(s).length && !p2pMarkAll().pending,
    available: ({ s }) => signedIn(s),
    run: () => get().askMarkAllRead(p2pMarkAll()),
  },
  {
    id: 'mark_dms_read',
    title: 'Mark all DMs as read',
    scope: 'global',
    icon: Check,
    available: ({ s }) => signedIn(s),
    run: () => void get().markDmsRead(),
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
    run: (_ctx, { value }) => void get().startDm(username(value)),
  },
  {
    id: 'create_server',
    title: 'Create a server',
    scope: 'global',
    icon: Plus,
    available: ({ s }) => signedIn(s),
    run: () => get().openDialog({ kind: 'add_server', tab: 'create' }),
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
      const name = value.trim().toLowerCase()
      get().openDialog({ kind: 'add_server', tab: 'join', ...(name ? { join: name } : {}) })
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
    run: () => openPalette('?'),
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
    run: () => get().logout(),
  },
]
