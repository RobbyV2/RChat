// The entries of the settings nav, the rows search finds in them, and which entry a request to
// open settings lands on.

import { SLOTS } from './motion/slots'
import type { SearchRow } from './settings_search'

// What the Customize rows of the Animations setting are called, so search finds them.
const SLOT_WORDS = SLOTS.map(s => s.label.toLowerCase())

export type SettingsSection =
  'profile' | 'general' | 'notifications' | 'privacy' | 'p2p' | 'sync' | 'palette' | 'information'

// What a caller may ask for: a section, or `settings`, which stands for General.
export type SettingsAsk = SettingsSection | 'settings'

export type SettingsFocus = 'bio' | 'display_name' | 'p2p_limits'

export const SECTION_LABELS: Record<SettingsSection, string> = {
  profile: 'Profile',
  general: 'General',
  notifications: 'Notifications',
  privacy: 'Privacy',
  p2p: 'P2P',
  sync: 'Sync config',
  palette: 'Command palette',
  information: 'About and help',
}

// The heading each entry sits under in the nav.
export const SECTION_GROUPS: Record<SettingsSection, string> = {
  profile: 'Your account',
  privacy: 'Your account',
  general: 'App settings',
  notifications: 'App settings',
  palette: 'App settings',
  sync: 'App settings',
  p2p: 'Peer-to-peer',
  information: 'About',
}

// `p2p`: P2P is on for this account, or this device still holds its P2P data.
export const settingsSections = ({
  signedIn,
  p2p,
}: {
  signedIn: boolean
  p2p: boolean
}): SettingsSection[] => [
  'profile',
  ...(signedIn ? (['privacy'] as const) : []),
  'general',
  'notifications',
  'palette',
  'sync',
  ...(signedIn && p2p ? (['p2p'] as const) : []),
  'information',
]

interface SettingsRow extends Omit<SearchRow, 'section'> {
  // Shown only to a signed-in account.
  account?: boolean
  // Shown only in the desktop app.
  desktop?: boolean
  // What the row is for a guest, who sees less of it.
  guest?: Pick<SearchRow, 'label' | 'line' | 'keywords'>
}

const ROWS: Record<SettingsSection, SettingsRow[]> = {
  profile: [
    {
      id: 'user_account',
      label: 'Account',
      line: 'Who is signed in, on which instance, and the accounts on this device.',
      keywords: ['switch account', 'accounts on this device', 'instance'],
    },
    {
      id: 'user_profile',
      label: 'Your profile',
      line: 'Display name, avatar, banner and about me.',
      keywords: ['display name', 'avatar', 'banner', 'about me', 'bio', 'server profiles'],
      account: true,
    },
    {
      id: 'user_sign_in',
      label: 'Sign-in',
      line: 'Password, sign-in methods and logging out.',
      keywords: ['password', 'log out', 'sign out', 'backup phrase', 'sign-in methods'],
      guest: {
        label: 'Exit guest mode',
        line: 'Leave guest mode on this device.',
        keywords: ['sign in', 'log out', 'account'],
      },
    },
    {
      id: 'user_instance',
      label: 'Instance details',
      line: 'The instance this account is on.',
      keywords: ['about', 'version', 'instance id'],
    },
  ],
  privacy: [
    {
      id: 'user_privacy',
      label: 'Who can contact you',
      line: 'Who can DM you and who can send you friend requests.',
      keywords: ['direct messages', 'dm', 'friend requests'],
    },
    {
      id: 'user_links',
      label: 'Links',
      line: 'Warnings before outside links, tracking removal and trusted domains.',
      keywords: ['external links', 'warning', 'tracking', 'trusted domains', 'utm'],
    },
    {
      id: 'user_blocked',
      label: 'Blocked users',
      keywords: ['block', 'unblock'],
    },
  ],
  general: [
    {
      id: 'user_status',
      label: 'Appear offline',
      line: 'You never appear online to others.',
      keywords: ['status', 'invisible', 'online'],
      account: true,
    },
    {
      id: 'user_typing',
      label: 'Typing indicators',
      line: 'Show when others are typing and let them see when you type.',
      keywords: ['chat'],
    },
    {
      id: 'user_profanity',
      label: 'Filter profanity',
      line: 'Masks profanity in messages and names you see.',
      keywords: ['swearing', 'mask', 'chat'],
    },
    {
      id: 'user_spoilers',
      label: 'Show spoilers',
      keywords: ['spoiler', 'chat'],
    },
    {
      id: 'user_connection',
      label: 'Connection helpers',
      line: 'How calls, voice and P2P files connect.',
      keywords: ['voice and p2p', 'relay only', 'ip address', 'stun', 'turn'],
    },
    {
      id: 'user_relays',
      label: 'Your relays',
      line: 'Your own STUN or TURN servers.',
      keywords: ['relay', 'stun', 'turn'],
      account: true,
    },
    {
      id: 'user_announcements',
      label: 'Instance announcements',
      keywords: ['announcement', 'banner', 'appearance'],
    },
    {
      id: 'user_theme',
      label: 'Light theme',
      keywords: ['dark', 'theme', 'appearance'],
    },
    {
      id: 'user_animations',
      label: 'Animations',
      line: 'Things fade and move when they open, arrive or change.',
      keywords: [
        'motion',
        'reduced motion',
        'appearance',
        'subtle',
        'lively',
        'custom',
        ...SLOT_WORDS,
      ],
    },
    {
      id: 'user_streamer',
      label: 'Streamer mode',
      line: 'Blurs server names, usernames, and DM names until hovered.',
      keywords: ['blur', 'hide names'],
    },
    {
      id: 'user_desktop',
      label: 'Desktop app',
      keywords: ['close to tray', 'start on login', 'updates', 'weekly builds'],
      desktop: true,
    },
  ],
  notifications: [
    {
      id: 'user_notifications',
      label: 'Notifications',
      line: 'Desktop notifications and custom settings for servers and DMs.',
      keywords: ['desktop notifications', 'sound', 'mute'],
    },
  ],
  palette: [
    {
      id: 'user_palette',
      label: 'Command palette',
      keywords: ['search index', 'history'],
    },
  ],
  sync: [
    {
      id: 'user_sync',
      label: 'Sync config',
      line: 'Export, import or share your settings.',
      keywords: ['export', 'import', 'share link', 'config link'],
    },
  ],
  p2p: [
    {
      id: 'user_p2p',
      label: 'Peer-to-peer',
      line: 'Your P2P identity, files, devices and storage on this device.',
      keywords: [
        'p2p',
        'identity',
        'peers',
        'contacts',
        'advanced',
        'limits',
        'storage limits',
        'background sync',
        'automatic downloads',
        'devices',
        'account badge',
        'pause p2p',
      ],
    },
  ],
  information: [
    { id: 'user_info_about', label: 'About' },
    {
      id: 'user_info_docs',
      label: 'Docs',
      line: 'Using the app, running an instance, the API and the P2P protocol.',
      keywords: ['help', 'documentation', 'manual', 'api'],
    },
    {
      id: 'user_info_accounts',
      label: 'Accounts and passwords',
      keywords: ['login', 'word passwords'],
    },
    {
      id: 'user_info_files',
      label: 'Files and attachments',
      keywords: ['uploads', 'expiry'],
    },
    { id: 'user_info_voice', label: 'Voice and video', keywords: ['calls', 'webrtc'] },
    { id: 'user_info_servers', label: 'Servers and identity', keywords: ['guests', 'invites'] },
    {
      id: 'user_info_shortcuts',
      label: 'Keyboard shortcuts',
      keywords: ['keys', 'formatting'],
    },
    { id: 'user_info_moderation', label: 'Moderation', keywords: ['profanity', 'rate limits'] },
  ],
}

// The rows of a section that show for this account on this device, for search and the nav.
export const settingsRows = (
  section: SettingsSection,
  { signedIn, desktop }: { signedIn: boolean; desktop: boolean }
): SearchRow[] =>
  ROWS[section]
    .filter(r => (signedIn || !r.account) && (desktop || !r.desktop))
    .map(({ account: _account, desktop: _desktop, guest, ...row }) => ({
      section,
      ...row,
      ...(signedIn ? {} : guest),
    }))

const FOCUS_SECTION: Record<SettingsFocus, SettingsSection> = {
  bio: 'profile',
  display_name: 'profile',
  p2p_limits: 'p2p',
}

export const sectionFor = (
  ask: SettingsAsk | null | undefined,
  focus: SettingsFocus | null | undefined,
  shown: readonly SettingsSection[]
): SettingsSection => {
  const want = focus ? FOCUS_SECTION[focus] : ask === 'settings' ? 'general' : ask
  return want && shown.includes(want) ? want : (shown[0] ?? 'profile')
}
