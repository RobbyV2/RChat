// The rows of the site administration page's Features section: every control the page changes,
// with the name of its setting in the server config.

import type { SearchRow } from './settings_search'
import type { SiteSettings } from './types'

export const ADMIN_GROUPS = [
  'Accounts',
  'Servers',
  'Privacy',
  'Messages and files',
  'Calls',
  'P2P',
  'Safety',
  'Widgets',
  'Encryption',
  "This site's app",
] as const

export type AdminGroup = (typeof ADMIN_GROUPS)[number]

export interface RowOption {
  value: string
  label: string
  // What choosing it means.
  line?: string
}

interface Base {
  // The setting's name in the settings and in the server's list of controls.
  key: string
  env: string
  group: AdminGroup
  label: string
  line: string
  // The key of the row it sits under.
  under?: string
  keywords?: string[]
}

export type AdminRow =
  | (Base & {
      kind: 'switch'
      // What off means, shown while it is off.
      off?: string
    })
  | (Base & {
      kind: 'choice'
      options: RowOption[]
      // A list with each option's line, instead of chips.
      list?: boolean
      // Shown under the choices.
      note?: string
    })
  | (Base & { kind: 'number'; min: number; max: number; unit: string })
  | (Base & { kind: 'targets' })
  // A list of usernames and server:role entries.
  | (Base & { kind: 'names' })
  // A control another section edits.
  | (Base & { kind: 'link'; to: string; action: string })
  // A control only the server config or its own editor sets.
  | (Base & { kind: 'info' })

export const ADMIN_ROWS: AdminRow[] = [
  {
    key: 'registration',
    env: 'AUTH_REGISTRATION',
    group: 'Accounts',
    kind: 'choice',
    list: true,
    label: 'New accounts',
    line: 'Who can sign up with a password.',
    keywords: ['sign-up', 'signup', 'registration', 'register'],
    options: [
      { value: 'open', label: 'Open', line: 'Anyone can create an account.' },
      {
        value: 'sso',
        label: 'Sign-on only',
        line: 'Accounts come from your sign-in provider.',
      },
      { value: 'closed', label: 'Closed', line: 'Nobody can sign up.' },
    ],
  },
  {
    key: 'password_login',
    env: 'AUTH_PASSWORD_LOGIN',
    group: 'Accounts',
    kind: 'switch',
    label: 'Password sign-in',
    line: 'Lets people sign in and sign up with a password.',
    off: 'No new passwords. Existing ones still work.',
    keywords: ['login', 'log in'],
  },
  {
    key: 'password_change',
    env: 'TEMP_PASSWORD_CHANGE',
    group: 'Accounts',
    kind: 'choice',
    label: 'Temporary passwords',
    line: 'What people do after they sign in with a temporary password.',
    keywords: ['temp', 'reset', 'first sign-in'],
    options: [
      {
        value: 'required',
        label: 'Change required',
        line: 'They choose their own password before anything else.',
      },
      {
        value: 'encouraged',
        label: 'Change encouraged',
        line: 'They are asked to, and must once the temporary password expires.',
      },
    ],
  },
  {
    key: 'temp_password_hours',
    env: 'TEMP_PASSWORD_HOURS',
    group: 'Accounts',
    kind: 'number',
    under: 'password_change',
    min: 0,
    max: 720,
    unit: 'hours',
    label: 'Temporary passwords last',
    line: 'Hours a temporary password signs in, 1 to 720. 0: it never expires.',
    keywords: ['temp', 'expiry', 'lifetime'],
  },
  {
    key: 'guests_enabled',
    env: 'GUESTS_ENABLED',
    group: 'Accounts',
    kind: 'switch',
    label: 'Guests',
    line: 'Lets people open servers without an account.',
    off: "Guests can't read anything. Their pages show sign-in.",
  },
  {
    key: 'guest_chat_enabled',
    env: 'GUEST_CHAT_ENABLED',
    group: 'Accounts',
    kind: 'switch',
    under: 'guests_enabled',
    label: 'Guest text chat',
    line: 'Lets servers allow messages from guests.',
    off: 'No server takes guest messages. Each keeps its choice for later.',
  },
  {
    key: 'guest_voice_enabled',
    env: 'GUEST_VOICE_ENABLED',
    group: 'Accounts',
    kind: 'switch',
    under: 'guests_enabled',
    label: 'Guest voice',
    line: 'Lets servers allow guests in voice channels.',
    off: 'No server takes guests in voice, and guests in calls leave. Each keeps its choice for later.',
  },
  {
    key: 'display_names',
    env: 'FEATURE_DISPLAY_NAMES',
    group: 'Accounts',
    kind: 'switch',
    label: 'Display names',
    line: 'Lets people change their display name.',
    off: 'Display names stay as they are.',
  },
  {
    key: 'onboarding',
    env: 'FEATURE_ONBOARDING',
    group: 'Accounts',
    kind: 'switch',
    label: 'Onboarding',
    line: 'Shows new accounts a short tour.',
  },
  {
    key: 'backup_phrase',
    env: 'FEATURE_BACKUP_PHRASE',
    group: 'Accounts',
    kind: 'switch',
    label: 'Backup phrase',
    line: 'Lets people set or reset a backup phrase.',
    off: 'Existing phrases still work.',
    keywords: ['recovery'],
  },
  {
    key: 'server_creation',
    env: 'SERVER_CREATION',
    group: 'Servers',
    kind: 'choice',
    label: 'Who can create servers',
    line: 'Existing servers and their owners are untouched.',
    options: [
      { value: 'everyone', label: 'Everyone', line: 'Anyone with an account can create a server.' },
      {
        value: 'nobody',
        label: 'Nobody',
        line: 'Nobody can create a server. You can still make one for someone in Servers.',
      },
      {
        value: 'some',
        label: 'Some people',
        line: 'Only the people and holders of the roles on the list below.',
      },
    ],
  },
  {
    key: 'server_creators',
    env: 'SERVER_CREATORS',
    group: 'Servers',
    kind: 'names',
    under: 'server_creation',
    label: 'People who can create servers',
    line: 'Usernames, and roles as server:role, for example lobby:Staff. Used while only some people can create servers.',
    keywords: ['creators'],
  },
  {
    key: 'server_joining',
    env: 'SERVER_JOINING',
    group: 'Servers',
    kind: 'choice',
    label: 'How people join servers',
    line: 'Members stay whatever you choose, and leaving works.',
    keywords: ['invite', 'private'],
    options: [
      { value: 'everyone', label: 'Everyone', line: 'Anyone can join a server by its name.' },
      {
        value: 'invites',
        label: 'Only with an invite or password',
        line: "Servers can't be opened or joined by name alone.",
      },
      {
        value: 'nobody',
        label: 'Nobody',
        line: 'Only members can open servers. Nobody new can join.',
      },
    ],
  },
  {
    key: 'public_reading',
    env: 'PUBLIC_READING',
    group: 'Servers',
    kind: 'switch',
    label: 'Public reading',
    line: "Lets a server's owner let people who aren't members read it.",
    off: 'Only members read servers.',
  },
  {
    key: 'server_search',
    env: 'SERVER_SEARCH',
    group: 'Servers',
    kind: 'switch',
    label: 'Server search',
    line: 'Lets people find servers by name.',
    off: 'Browsing and join suggestions are hidden. Servers stay reachable by name or invite.',
    keywords: ['discovery', 'browse'],
  },
  {
    key: 'default_servers',
    env: 'DEFAULT_SERVERS',
    group: 'Servers',
    kind: 'link',
    to: 'servers',
    action: 'Edit in Servers',
    label: 'Default servers',
    line: 'The servers every new account joins. Guests start in the ones anyone can read.',
  },
  {
    key: 'profile_visibility',
    env: 'PROFILE_VISIBILITY',
    group: 'Privacy',
    kind: 'choice',
    list: true,
    label: 'Who can see profiles',
    line: 'Description, banner and account age.',
    options: [
      {
        value: 'everyone',
        label: 'Everyone',
        line: 'Anyone who can use the app here sees every profile.',
      },
      {
        value: 'public_servers',
        label: 'People in public servers',
        line: 'Profiles of people in a public server are open to all. Others show only to people who share a server with them.',
      },
      {
        value: 'shared',
        label: 'People who share a server',
        line: 'A profile shows only to people who share a server, a DM or a friendship with that person.',
      },
    ],
    note: 'Names next to messages and in member lists always show where people can read them.',
  },
  {
    key: 'profile_choices',
    env: 'PROFILE_CHOICES',
    group: 'Privacy',
    kind: 'choice',
    list: true,
    label: 'What accounts may choose',
    line: 'For "Who can see your profile and find you by name" in their settings.',
    options: [
      {
        value: 'any',
        label: 'Anything',
        line: 'Friends only, people who share a server, or everyone.',
      },
      {
        value: 'narrower',
        label: 'Only narrower',
        line: 'Only choices that show the profile to fewer people than the site does.',
      },
      { value: 'site', label: 'Nothing', line: 'Every account follows the site.' },
    ],
  },
  {
    key: 'dm_creation',
    env: 'DM_CREATION',
    group: 'Messages and files',
    kind: 'choice',
    label: 'Direct messages',
    line: 'Who can start a direct conversation. Existing ones keep working.',
    keywords: ['dm', 'dms'],
    options: [
      { value: 'everyone', label: 'Everyone', line: 'Anyone can start a direct conversation.' },
      {
        value: 'friends',
        label: 'Only between friends',
        line: 'Only friends can start a direct conversation.',
      },
      { value: 'nobody', label: 'Nobody', line: 'Nobody can start a new direct conversation.' },
    ],
  },
  {
    key: 'friend_requests',
    env: 'FEATURE_FRIEND_REQUESTS',
    group: 'Messages and files',
    kind: 'switch',
    label: 'Friend requests',
    line: 'Lets people send friend requests.',
    off: 'New requests are refused. Pending ones can still be answered, and friends stay.',
  },
  {
    key: 'asset_uploads',
    env: 'FEATURE_FILE_UPLOADS',
    group: 'Messages and files',
    kind: 'switch',
    label: 'File uploads',
    line: 'Lets people upload files to this instance.',
    off: 'Files already uploaded stay.',
    keywords: ['attachments'],
  },
  {
    key: 'upload_expiry_max_days',
    env: 'UPLOAD_EXPIRY_MAX_DAYS',
    group: 'Messages and files',
    kind: 'number',
    under: 'asset_uploads',
    min: 0,
    max: 365,
    unit: 'days',
    label: 'Longest file expiry',
    line: 'Days a server may keep uploaded files, 1 to 365. 0: no limit, and servers may keep files until they are removed.',
  },
  {
    key: 'p2p_attachments',
    env: 'P2P_ATTACHMENTS',
    group: 'Messages and files',
    kind: 'switch',
    label: 'P2P attachments',
    line: "Files stay in the sender's browser, with no size limit.",
  },
  {
    key: 'asset_previews',
    env: 'FEATURE_LINK_PREVIEWS',
    group: 'Messages and files',
    kind: 'switch',
    label: 'Link previews',
    line: 'Shows a preview of links in messages.',
    keywords: ['embeds'],
  },
  {
    key: 'outgoing_webhooks',
    env: 'OUTGOING_WEBHOOKS',
    group: 'Messages and files',
    kind: 'switch',
    label: 'Outgoing webhooks',
    line: 'Lets server managers send events to URLs they choose.',
  },
  {
    key: 'incoming_webhooks',
    env: 'FEATURE_INCOMING_WEBHOOKS',
    group: 'Messages and files',
    kind: 'switch',
    label: 'Incoming webhooks',
    line: 'Lets server managers post messages from other services.',
    off: 'None can be created and none post. Existing ones are kept.',
  },
  {
    key: 'calls',
    env: 'FEATURE_CALLS',
    group: 'Calls',
    kind: 'switch',
    label: 'Calls',
    line: 'Voice channels and calls through this instance.',
    off: 'Running calls end and nobody can start one. Voice channels stay. P2P calls follow Peer-to-peer.',
    keywords: ['voice'],
  },
  {
    key: 'sfu',
    env: 'FEATURE_SFU',
    group: 'Calls',
    kind: 'switch',
    label: 'Media server',
    line: 'Sends calls through the media server when it runs.',
    keywords: ['sfu'],
  },
  {
    key: 'p2p',
    env: 'FEATURE_P2P',
    group: 'P2P',
    kind: 'switch',
    label: 'Peer-to-peer',
    line: 'Shows P2P servers and conversations in the app.',
    off: 'The app hides P2P. Data stays on devices.',
  },
  {
    key: 'p2p_backup',
    env: 'FEATURE_P2P_BACKUP',
    group: 'P2P',
    kind: 'switch',
    label: 'P2P backups',
    line: 'Lets people store P2P backups here.',
    off: 'No new backups. Restores always work.',
  },
  {
    key: 'profanity_filter',
    env: 'PROFANITY_FILTER',
    group: 'Safety',
    kind: 'switch',
    label: 'Profanity filter',
    line: 'Blocks profanity in what people post.',
  },
  {
    key: 'profanity_targets',
    env: 'PROFANITY_TARGETS',
    group: 'Safety',
    kind: 'targets',
    under: 'profanity_filter',
    label: 'Profanity filter applies to',
    line: 'What the filter checks while it is on.',
  },
  {
    key: 'profanity_strict_file_names',
    env: 'PROFANITY_STRICT_FILE_NAMES',
    group: 'Safety',
    kind: 'switch',
    under: 'profanity_filter',
    label: 'Strict file names',
    line: 'Also checks file names and the paths of links like messages, extension included. Only while the filter checks file names.',
  },
  {
    key: 'server_reports',
    env: 'FEATURE_SERVER_REPORTS',
    group: 'Safety',
    kind: 'switch',
    label: 'Server reports',
    line: "Lets people report to a server's moderators.",
  },
  {
    key: 'instance_reports',
    env: 'FEATURE_INSTANCE_REPORTS',
    group: 'Safety',
    kind: 'switch',
    label: 'Instance reports',
    line: 'Lets people report to this instance.',
  },
  {
    key: 'report_forms',
    env: 'REPORT_FORMS_FILE',
    group: 'Safety',
    kind: 'info',
    label: 'Report forms',
    line: 'The report categories and their fields. The server config names a file that holds them.',
  },
  {
    key: 'widgets',
    env: 'WIDGETS',
    group: 'Widgets',
    kind: 'switch',
    label: 'Widgets',
    line: 'Lets servers embed their chat on other sites.',
  },
  {
    key: 'widget_chat',
    env: 'FEATURE_WIDGET_CHAT',
    group: 'Widgets',
    kind: 'switch',
    label: 'Widget chat',
    line: 'Lets widget visitors send messages and quick join.',
  },
  {
    key: 'widget_read_links',
    env: 'FEATURE_WIDGET_READ_LINKS',
    group: 'Widgets',
    kind: 'switch',
    label: 'Widget read links',
    line: 'Lets read-only widget links work.',
  },
  {
    key: 'widget_bridge',
    env: 'WIDGET_BRIDGE',
    group: 'Widgets',
    kind: 'switch',
    label: 'Widget bridge',
    line: 'Serves widgets for P2P servers through a bridge.',
  },
  {
    key: 'e2ee',
    env: 'E2EE',
    group: 'Encryption',
    kind: 'switch',
    label: 'Encryption',
    line: 'Lets servers and DMs turn on end-to-end encryption.',
    keywords: ['e2ee'],
  },
  {
    key: 'e2ee_compliance',
    env: 'E2EE_COMPLIANCE',
    group: 'Encryption',
    kind: 'switch',
    label: 'Encryption archive',
    line: 'Adds a compliance archive to new encrypted spaces.',
  },
  {
    key: 'client_other_instances',
    env: 'FEATURE_CLIENT_OTHER_INSTANCES',
    group: "This site's app",
    kind: 'switch',
    label: "Other instances in this site's app",
    line: "Lets people add other instances in this site's web app. Other apps ignore it.",
  },
  {
    key: 'server_profiles',
    env: 'FEATURE_SERVER_PROFILES',
    group: 'Servers',
    kind: 'switch',
    label: 'Server profiles',
    line: 'Lets members set a name, avatar, banner and description per server.',
  },
  {
    key: 'docs',
    env: 'FEATURE_DOCS',
    group: "This site's app",
    kind: 'switch',
    label: 'Documentation',
    line: 'Serves the documentation at /docs.',
  },
  {
    key: 'scheduled_messages',
    env: 'FEATURE_SCHEDULED_MESSAGES',
    group: 'Messages and files',
    kind: 'switch',
    label: 'Scheduled messages',
    line: 'Lets people schedule messages that this site sends for them later. Turning it off stops new ones; scheduled ones still send.',
  },
  {
    key: 'interactive_docs',
    env: 'FEATURE_INTERACTIVE_DOCS',
    group: "This site's app",
    kind: 'switch',
    label: 'Interactive docs',
    line: 'Lets the docs run requests as the accounts people hold on this site.',
  },
  {
    key: 'member_lists',
    env: 'FEATURE_MEMBER_LISTS',
    group: 'Servers',
    kind: 'switch',
    label: 'Member lists',
    line: 'Allow users to view server member lists. Turning this off hides member lists across all servers.',
  },
]

export const adminRow = (key: string) => ADMIN_ROWS.find(r => r.key === key)

// The rows of a group that stand on their own, in order.
export const groupRows = (group: AdminGroup) =>
  ADMIN_ROWS.filter(r => r.group === group && r.under === undefined)

// The rows that sit under `key`.
export const rowsUnder = (key: string) => ADMIN_ROWS.filter(r => r.under === key)

// What search finds in the Features section.
export const featureSearchRows = (): SearchRow[] =>
  ADMIN_ROWS.map(r => ({
    section: r.kind === 'link' ? r.to : 'features',
    group: r.kind === 'link' ? undefined : r.group,
    id: r.key,
    label: r.label,
    line: [r.line, ...(r.kind === 'choice' ? r.options.map(o => o.label) : [])].join(' '),
    keywords: r.keywords,
    env: r.env,
  }))

// The options of the New accounts row: sign-on only shows only while it is the stored value,
// since no sign-in provider can be set up.
export const registrationOptions = (stored: SiteSettings['registration']): RowOption[] => {
  const row = adminRow('registration')
  const options = row?.kind === 'choice' ? row.options : []
  return options.flatMap(o => {
    if (o.value !== 'sso') return [o]
    return stored === 'sso'
      ? [{ ...o, line: 'No sign-in provider is set up, so nobody can sign up.' }]
      : []
  })
}

// A setting's value as a row's control reads it.
export const settingOf = (settings: SiteSettings, key: string): unknown =>
  (settings as unknown as Record<string, unknown>)[key]
