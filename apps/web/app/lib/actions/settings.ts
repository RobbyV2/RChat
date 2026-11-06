import {
  Bell,
  Command,
  Copy,
  Eye,
  EyeOff,
  Keyboard,
  Moon,
  Settings,
  ShieldOff,
  Type,
  type LucideIcon,
} from 'lucide-react'
import { useStore } from '../store'
import type { RChatState } from '../store_types'
import { signedIn } from './global'
import type { Action } from './types'

export type SettingsSection =
  'settings' | 'notifications' | 'privacy' | 'sync' | 'palette' | 'information'

const get = () => useStore.getState()

// Settings that guests keep on this device too.
const local = (s: RChatState) => s.me !== null || s.guest

const section = (
  id: SettingsSection,
  title: string,
  icon: LucideIcon,
  available: (s: RChatState) => boolean = () => true
): Action => ({
  id: `settings_${id}`,
  title,
  scope: 'global',
  group: 'settings',
  icon,
  keywords: id === 'information' ? ['keyboard shortcuts', 'help'] : ['preferences'],
  available: ({ s }) => available(s),
  run: () => get().openDialog({ kind: 'settings', section: id }),
})

export const settingsActions: Action[] = [
  {
    id: 'theme',
    title: 'Theme',
    label: ({ s }) => (s.theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'),
    scope: 'global',
    group: 'settings',
    icon: Moon,
    keywords: ['theme', 'appearance', 'dark', 'light'],
    available: () => true,
    run: () => get().setTheme(get().theme === 'light' ? 'dark' : 'light'),
  },
  {
    id: 'streamer',
    title: 'Streamer mode',
    label: ({ s }) => (s.streamer ? 'Turn off streamer mode' : 'Turn on streamer mode'),
    scope: 'global',
    group: 'settings',
    icon: EyeOff,
    iconFor: ({ s }) => (s.streamer ? Eye : EyeOff),
    keywords: ['blur', 'privacy'],
    available: () => true,
    run: () => get().setStreamer(!get().streamer),
  },
  {
    id: 'typing',
    title: 'Typing indicators',
    label: ({ s }) => (s.typingOn ? 'Turn off typing indicators' : 'Turn on typing indicators'),
    scope: 'global',
    group: 'settings',
    icon: Type,
    available: ({ s }) => local(s),
    run: () => get().setTypingOn(!get().typingOn),
  },
  {
    id: 'profanity',
    title: 'Profanity filter',
    label: ({ s }) =>
      s.profanityOn ? 'Turn off the profanity filter' : 'Turn on the profanity filter',
    scope: 'global',
    group: 'settings',
    icon: EyeOff,
    keywords: ['filter', 'mask'],
    available: ({ s }) => local(s),
    run: () => get().setProfanityOn(!get().profanityOn),
  },
  {
    id: 'spoilers',
    title: 'Show spoilers',
    label: ({ s }) =>
      s.showSpoilers === 'always' ? 'Show spoilers on click' : 'Always show spoilers',
    scope: 'global',
    group: 'settings',
    icon: Eye,
    available: ({ s }) => local(s),
    run: () => get().setShowSpoilers(get().showSpoilers === 'always' ? 'click' : 'always'),
  },
  {
    id: 'appear_offline',
    title: 'Appear offline',
    label: ({ s }) => (s.me?.appear_offline ? 'Stop appearing offline' : 'Appear offline'),
    scope: 'global',
    group: 'settings',
    icon: EyeOff,
    keywords: ['status', 'invisible', 'presence'],
    available: ({ s }) => signedIn(s),
    run: () => void get().setAppearOffline(!get().me?.appear_offline),
  },
  section('settings', 'Open settings', Settings),
  section('notifications', 'Settings: Notifications', Bell),
  section('privacy', 'Settings: Privacy', ShieldOff, signedIn),
  section('sync', 'Settings: Sync config', Copy),
  section('palette', 'Settings: Command palette', Command),
  section('information', 'Settings: Information', Keyboard),
]
