import {
  Bell,
  BookOpen,
  CircleUserRound,
  Command,
  Copy,
  Eye,
  EyeOff,
  Keyboard,
  Moon,
  Settings,
  ShieldOff,
  SlidersHorizontal,
  Sparkles,
  Type,
  UserPen,
  UserRound,
  Waypoints,
  type LucideIcon,
} from 'lucide-react'
import { AVATAR_MODES, AVATAR_MODE_LABELS, parseAvatarMode } from '../avatar_setting'
import { UNAVAILABLE } from '../capabilities'
import { DOCS_PATH, docsFor } from '../docs_link'
import { instanceLabel } from '../instance_label'
import { capabilities, docsViewer } from '../platform'
import { filterSwitch } from '../profanity'
import type { RChatState } from '../store_types'
import { canEditDisplayName } from '../display_name'
import type { AccountSession } from '../client/session'
import type { P2pApp } from '../p2p/app/runtime'
import { settingsSections, type SettingsSection } from '../settings_sections'
import { signInRowActions, ssoActions } from '../sso_actions'
import { signedIn } from './global'
import { p2pLimitActions } from './p2p_limits'
import type { Action } from './types'

// Settings that guests keep on this device too.
const local = (s: RChatState) => s.me !== null || s.guest

const filterNow = (s: RChatState) =>
  filterSwitch(capabilities().wasm, s.profanityOn, s.profanityFailed)

// The entries the settings nav shows for this account.
export const shownSections = (s: RChatState, acct: AccountSession, identity?: P2pApp | null) =>
  settingsSections({
    signedIn: signedIn(s),
    p2p:
      (s.settings.p2p && !!identity?.useP2p.getState().account) ||
      acct.identities.offlineData().length > 0,
  })

const KEYWORDS: Partial<Record<SettingsSection, string[]>> = {
  profile: ['account', 'avatar', 'password', 'instance'],
  p2p: ['peer-to-peer', 'contacts'],
  information: ['keyboard shortcuts', 'help'],
}

const section = (id: SettingsSection, title: string, icon: LucideIcon): Action => ({
  id: `settings_${id}`,
  title,
  scope: 'global',
  group: 'settings',
  icon,
  keywords: KEYWORDS[id] ?? ['preferences'],
  available: ({ acct, identity, s }) => shownSections(s, acct, identity).includes(id),
  run: ({ acct }) => acct.store.getState().openDialog({ kind: 'settings', section: id }),
})

export const settingsActions: Action[] = [
  {
    id: 'display_name',
    title: 'Change display name',
    scope: 'global',
    group: 'settings',
    icon: UserPen,
    keywords: ['name', 'nickname', 'profile'],
    available: ({ s }) => canEditDisplayName(s),
    run: ({ acct }) =>
      acct.store.getState().openDialog({ kind: 'settings', focus: 'display_name' }),
  },
  {
    id: 'theme',
    title: 'Theme',
    label: ({ s }) => (s.theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'),
    scope: 'global',
    group: 'settings',
    icon: Moon,
    keywords: ['theme', 'appearance', 'dark', 'light'],
    available: () => true,
    run: ({ acct }) =>
      acct.store.getState().setTheme(acct.store.getState().theme === 'light' ? 'dark' : 'light'),
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
    run: ({ acct }) => acct.store.getState().setStreamer(!acct.store.getState().streamer),
  },
  {
    id: 'avatars',
    title: 'Profile pictures',
    subtitle: ({ s }) => AVATAR_MODE_LABELS[parseAvatarMode(s.avatarMode)],
    scope: 'global',
    group: 'settings',
    icon: CircleUserRound,
    keywords: ['avatar', 'pfp', 'identicon', 'color', 'appearance'],
    args: [
      {
        kind: 'choice',
        name: 'value',
        prompt: 'On this device, show',
        choices: ({ s }) =>
          AVATAR_MODES.map(mode => ({
            value: mode,
            label: AVATAR_MODE_LABELS[mode],
            radio: true,
            checked: parseAvatarMode(s.avatarMode) === mode,
          })),
      },
    ],
    available: () => true,
    run: ({ acct }, { value }) => acct.store.getState().setAvatarMode(parseAvatarMode(value)),
  },
  {
    id: 'typing',
    title: 'Typing indicators',
    label: ({ s }) => (s.typingOn ? 'Turn off typing indicators' : 'Turn on typing indicators'),
    scope: 'global',
    group: 'settings',
    icon: Type,
    available: ({ s }) => local(s),
    run: ({ acct }) => acct.store.getState().setTypingOn(!acct.store.getState().typingOn),
  },
  {
    id: 'animations',
    title: 'Animations',
    label: ({ s }) => (s.anim.on ? 'Turn off animations' : 'Turn on animations'),
    scope: 'global',
    group: 'settings',
    icon: Sparkles,
    keywords: ['motion', 'appearance'],
    available: ({ s }) => local(s),
    run: ({ acct }) => {
      const { anim, setAnim } = acct.store.getState()
      setAnim({ ...anim, on: !anim.on })
    },
  },
  {
    id: 'animation_style',
    title: 'Animation style',
    label: ({ s }) =>
      s.anim.style === 'lively' ? 'Use subtle animations' : 'Use lively animations',
    scope: 'global',
    group: 'settings',
    icon: Sparkles,
    keywords: ['motion', 'appearance', 'subtle', 'lively'],
    available: ({ s }) => local(s) && s.anim.on,
    run: ({ acct }) => {
      const { anim, setAnim } = acct.store.getState()
      setAnim({ ...anim, style: anim.style === 'lively' ? 'subtle' : 'lively' })
    },
  },
  {
    id: 'profanity',
    title: 'Profanity filter',
    label: ({ s }) =>
      filterNow(s).on ? 'Turn off the profanity filter' : 'Turn on the profanity filter',
    subtitle: ({ s }) => (filterNow(s).note ? UNAVAILABLE : undefined),
    scope: 'global',
    group: 'settings',
    icon: EyeOff,
    keywords: ['filter', 'mask'],
    available: ({ s }) => local(s),
    run: ({ acct }) => {
      const { usable, on, note } = filterNow(acct.store.getState())
      if (usable) acct.store.getState().setProfanityOn(!on)
      else acct.store.getState().setError(note)
    },
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
    run: ({ acct }) =>
      acct.store
        .getState()
        .setShowSpoilers(acct.store.getState().showSpoilers === 'always' ? 'click' : 'always'),
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
    run: ({ acct }) =>
      void acct.store.getState().setAppearOffline(!acct.store.getState().me?.appear_offline),
  },
  ...p2pLimitActions,
  ...ssoActions,
  ...signInRowActions,
  {
    id: 'open_docs',
    title: 'Open docs',
    scope: 'global',
    group: 'settings',
    icon: BookOpen,
    keywords: ['help', 'documentation', 'manual', 'api'],
    available: ({ acct, s }) =>
      docsFor(acct.conn, s.settings, instanceLabel(s.instance, s.instanceHost || acct.conn.host))
        .kind === 'open',
    run: () => void docsViewer().open(DOCS_PATH),
  },
  {
    id: 'settings_settings',
    title: 'Open settings',
    scope: 'global',
    group: 'settings',
    icon: Settings,
    keywords: ['preferences'],
    available: () => true,
    run: ({ acct }) => acct.store.getState().openDialog({ kind: 'settings' }),
  },
  section('profile', 'Settings: Profile', UserRound),
  section('general', 'Settings: General', SlidersHorizontal),
  section('notifications', 'Settings: Notifications', Bell),
  section('privacy', 'Settings: Privacy', ShieldOff),
  section('p2p', 'Settings: P2P', Waypoints),
  section('sync', 'Settings: Sync config', Copy),
  section('palette', 'Settings: Command palette', Command),
  section('information', 'Settings: About and help', Keyboard),
]
