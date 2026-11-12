import type { Registration, ServerJoining, SiteSettings } from './types'

// The site-wide feature switches (`GET /api/settings`), each a plain on or off.
export const FEATURE_KEYS = [
  'server_reports',
  'instance_reports',
  'widgets',
  'widget_chat',
  'widget_read_links',
  'widget_bridge',
  'e2ee',
  'e2ee_compliance',
  'backup_phrase',
  'p2p_backup',
  'display_names',
  'onboarding',
  'password_login',
  'sfu',
  'p2p',
  'client_other_instances',
] as const

export type FeatureKey = (typeof FEATURE_KEYS)[number]

// An instance from before the switches has P2P and password sign-up, lets its app add other
// instances, and has none of the rest.
const BEFORE_SWITCHES: Record<FeatureKey, boolean> = {
  server_reports: false,
  instance_reports: false,
  widgets: false,
  widget_chat: false,
  widget_read_links: false,
  widget_bridge: false,
  e2ee: false,
  e2ee_compliance: false,
  backup_phrase: false,
  p2p_backup: false,
  display_names: false,
  onboarding: false,
  password_login: true,
  sfu: false,
  p2p: true,
  client_other_instances: true,
}

const registrationOf = (value: unknown): Registration => {
  if (typeof value !== 'string') return 'open'
  return value === 'open' || value === 'sso' || value === 'closed' ? value : 'closed'
}

// An older instance lets everyone join. A value this app does not know reads as the strictest.
const joiningOf = (value: unknown): ServerJoining => {
  if (typeof value !== 'string') return 'everyone'
  return value === 'everyone' || value === 'invites' || value === 'nobody' ? value : 'nobody'
}

// The settings as clients use them: missing or malformed switches read as an older instance's.
// Servers before 0.3.0 send no p2p_attachments: P2P was always on there.
export const siteSettings = (s: SiteSettings): SiteSettings => {
  const sent = s as unknown as Record<string, unknown>
  const switches = Object.fromEntries(
    FEATURE_KEYS.map(key => [
      key,
      typeof sent[key] === 'boolean' ? sent[key] : BEFORE_SWITCHES[key],
    ])
  ) as Record<FeatureKey, boolean>
  return {
    ...s,
    p2p_attachments: s.p2p_attachments !== false,
    ...switches,
    registration: registrationOf(sent.registration),
    server_joining: joiningOf(sent.server_joining),
    public_reading: sent.public_reading !== false,
    upload_expiry_max_days:
      Number.isInteger(sent.upload_expiry_max_days) && (sent.upload_expiry_max_days as number) >= 0
        ? (sent.upload_expiry_max_days as number)
        : 0,
  }
}

// What the app shows before the instance's settings arrive.
export const DEFAULT_FEATURES: Record<FeatureKey, boolean> & { registration: Registration } = {
  ...BEFORE_SWITCHES,
  registration: 'open',
}

// New accounts with a password: the server answers 404 to sign-up otherwise.
export const passwordSignup = (s: SiteSettings) => s.registration === 'open' && s.password_login

// What guests are asked to do before they can post or talk.
export const accountPrompt = (s: SiteSettings) =>
  passwordSignup(s) ? 'Create an account' : 'Log in'

type SwitchKey =
  | FeatureKey
  | 'profanity_filter'
  | 'asset_previews'
  | 'asset_uploads'
  | 'p2p_attachments'
  | 'guests_enabled'
  | 'outgoing_webhooks'

export interface FeatureRow {
  key: SwitchKey | 'registration'
  label: string
  line: string
}

// The site admin panel's Features section, in order.
export const FEATURE_ROWS: FeatureRow[] = [
  {
    key: 'profanity_filter',
    label: 'Profanity filter',
    line: 'Blocks profanity in what people post.',
  },
  { key: 'asset_previews', label: 'Link previews', line: 'Shows a preview of links in messages.' },
  {
    key: 'asset_uploads',
    label: 'File uploads',
    line: 'Lets people upload files to this instance.',
  },
  {
    key: 'p2p_attachments',
    label: 'P2P attachments',
    line: "Files stay in the sender's browser, with no size limit.",
  },
  { key: 'guests_enabled', label: 'Guests', line: 'Lets people read servers without an account.' },
  {
    key: 'outgoing_webhooks',
    label: 'Outgoing webhooks',
    line: 'Lets server managers send events to URLs they choose.',
  },
  { key: 'registration', label: 'New accounts', line: 'Who can sign up with a password.' },
  {
    key: 'password_login',
    label: 'Password sign-in',
    line: 'Off stops new passwords. Existing ones still work.',
  },
  { key: 'display_names', label: 'Display names', line: 'Lets people change their display name.' },
  { key: 'onboarding', label: 'Onboarding', line: 'Shows new accounts a short tour.' },
  {
    key: 'client_other_instances',
    label: "Other instances in this site's app",
    line: "Lets people add other instances in this site's web app. Other apps ignore it.",
  },
  {
    key: 'backup_phrase',
    label: 'Backup phrase',
    line: 'Lets people set or reset a backup phrase. Existing ones still work.',
  },
  { key: 'p2p', label: 'Peer-to-peer', line: 'Shows P2P in the app. Off keeps data on devices.' },
  {
    key: 'p2p_backup',
    label: 'P2P backups',
    line: 'Lets people store P2P backups here. Restores always work.',
  },
  { key: 'sfu', label: 'Media server', line: 'Sends calls through the media server when it runs.' },
  {
    key: 'server_reports',
    label: 'Server reports',
    line: "Lets people report to a server's moderators.",
  },
  {
    key: 'instance_reports',
    label: 'Instance reports',
    line: 'Lets people report to this instance.',
  },
  { key: 'widgets', label: 'Widgets', line: 'Lets servers embed their chat on other sites.' },
  {
    key: 'widget_chat',
    label: 'Widget chat',
    line: 'Lets widget visitors send messages and quick join.',
  },
  {
    key: 'widget_read_links',
    label: 'Widget read links',
    line: 'Lets read-only widget links work.',
  },
  {
    key: 'widget_bridge',
    label: 'Widget bridge',
    line: 'Serves widgets for P2P servers through a bridge.',
  },
  { key: 'e2ee', label: 'Encryption', line: 'Lets servers and DMs turn on end-to-end encryption.' },
  {
    key: 'e2ee_compliance',
    label: 'Encryption archive',
    line: 'Adds a compliance archive to new encrypted spaces.',
  },
]

export const NEW_ACCOUNTS: { value: Registration; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'sso', label: 'Sign-on only' },
  { value: 'closed', label: 'Closed' },
]

// P2P runs for the signed-in account only once the instance's settings say P2P is on, so a
// switched-off instance never starts it. `open(null)` stops it.
export const createP2pGate = (open: (username: string | null) => void) => {
  let user: string | null = null
  let on: boolean | null = null
  return {
    account(username: string | null) {
      user = username
      open(on ? user : null)
    },
    settings(s: SiteSettings) {
      if (s.p2p === on) return
      on = s.p2p
      open(on ? user : null)
    },
  }
}
