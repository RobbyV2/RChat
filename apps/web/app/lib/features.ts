import { parseProfileChoices, parseProfileLevel } from './profile_choice'
import type { PublicSettings } from './api/gen'
import type { DmCreation, Registration, ServerCreation, ServerJoining, SiteSettings } from './types'

// The site-wide feature switches (`GET /api/settings`), each a plain on or off.
export const FEATURE_KEYS = [
  'server_reports',
  'instance_reports',
  'widgets',
  'widget_chat',
  'guest_chat_enabled',
  'guest_voice_enabled',
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
  'server_profiles',
  'docs',
  'scheduled_messages',
  'interactive_docs',
  'member_lists',
  'profile_pictures',
  'animated_profile_pictures',
] as const

export type FeatureKey = (typeof FEATURE_KEYS)[number]

// An instance from before the switches has P2P, password sign-up and member lists, lets its app
// add other instances, and has none of the rest.
const BEFORE_SWITCHES: Record<FeatureKey, boolean> = {
  server_reports: false,
  instance_reports: false,
  widgets: false,
  widget_chat: false,
  guest_chat_enabled: false,
  guest_voice_enabled: false,
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
  server_profiles: false,
  docs: false,
  scheduled_messages: false,
  interactive_docs: true,
  member_lists: true,
  profile_pictures: false,
  animated_profile_pictures: false,
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

// An older instance lets everyone create servers. A value this app does not know reads as the
// strictest.
const creationOf = (value: unknown): ServerCreation => {
  if (typeof value !== 'string') return 'everyone'
  return value === 'everyone' || value === 'some' ? value : 'nobody'
}

const dmCreationOf = (value: unknown): DmCreation => {
  if (typeof value !== 'string') return 'everyone'
  return value === 'everyone' || value === 'friends' ? value : 'nobody'
}

// An instance from before profile visibility has neither; one from before the choices lets
// accounts only narrow.
const profileSettings = (sent: Record<string, unknown>) => {
  const level = parseProfileLevel(sent.profile_visibility)
  return level
    ? { profile_visibility: level, profile_choices: parseProfileChoices(sent.profile_choices) }
    : { profile_visibility: undefined, profile_choices: undefined }
}

// The settings as clients use them: missing or malformed switches read as an older instance's.
// A server that sends no p2p_attachments has P2P attachments on.
export const siteSettings = (wire: PublicSettings | SiteSettings): SiteSettings => {
  const s = wire as SiteSettings
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
    server_creation: creationOf(sent.server_creation),
    server_search: sent.server_search !== false,
    dm_creation: dmCreationOf(sent.dm_creation),
    friend_requests: sent.friend_requests !== false,
    calls: sent.calls !== false,
    incoming_webhooks: sent.incoming_webhooks !== false,
    ...profileSettings(sent),
    upload_expiry_max_days:
      Number.isInteger(sent.upload_expiry_max_days) && (sent.upload_expiry_max_days as number) >= 0
        ? (sent.upload_expiry_max_days as number)
        : 0,
    password_change: sent.password_change === 'encouraged' ? 'encouraged' : 'required',
    temp_password_hours:
      Number.isInteger(sent.temp_password_hours) && (sent.temp_password_hours as number) >= 0
        ? (sent.temp_password_hours as number)
        : 72,
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
