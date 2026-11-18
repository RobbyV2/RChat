// The entries of the settings nav, and which one a request to open settings lands on.

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
  information: 'Information',
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
  'general',
  'notifications',
  ...(signedIn ? (['privacy'] as const) : []),
  ...(signedIn && p2p ? (['p2p'] as const) : []),
  'sync',
  'palette',
  'information',
]

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
