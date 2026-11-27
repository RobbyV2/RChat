// The sections of a server's settings, which of them a viewer sees, and what search finds in them.

import type { SearchRow } from './settings_search'
import { Perm, hasPerm } from './types'
import { MEMBER_SEARCH_PERMS } from './member_filters'
import { hasBit } from './perms'

export type ServerSettingsSection =
  | 'invites'
  | 'overview'
  | 'widgets'
  | 'messages'
  | 'uploads'
  | 'profiles'
  | 'access'
  | 'roles'
  | 'channels'
  | 'members'
  | 'bans'
  | 'integrations'
  | 'audit'
  | 'delete'

export const SERVER_SECTION_LABELS: Record<ServerSettingsSection, string> = {
  invites: 'Invites',
  overview: 'Overview',
  widgets: 'Widgets',
  messages: 'System messages',
  uploads: 'Uploads',
  profiles: 'Server profiles',
  access: 'Access',
  roles: 'Roles',
  channels: 'Channels',
  members: 'Members',
  bans: 'Bans',
  integrations: 'Integrations',
  audit: 'Audit log',
  delete: 'Delete server',
}

export interface ServerSettingsViewer {
  // The viewer's permissions in the server.
  perms: number
  // The built-in server every instance starts with.
  builtin: boolean
  // The site has server profiles on.
  profiles: boolean
}

// The sections the viewer sees, in nav order. Invites shows to everyone who can open the settings.
export const serverSettingsSections = ({
  perms,
  builtin,
  profiles,
}: ServerSettingsViewer): ServerSettingsSection[] => {
  const can = (perm: number) => hasPerm(perms, perm)
  const manage = can(Perm.ManageServer)
  const shown: Record<ServerSettingsSection, boolean> = {
    invites: true,
    overview: manage,
    widgets: manage,
    messages: manage,
    uploads: manage,
    profiles: manage && profiles,
    access: manage || (!builtin && can(Perm.ManageInvites)),
    roles: can(Perm.ManageRoles),
    channels: can(Perm.ManageChannels),
    members: can(Perm.ManageAdmins) || hasBit(perms, MEMBER_SEARCH_PERMS),
    bans: can(Perm.Kick),
    integrations: can(Perm.ManageWebhooks) || can(Perm.ManageChannels),
    audit: can(Perm.ViewAuditLog),
    delete: !builtin && can(Perm.DeleteServer),
  }
  return (Object.keys(SERVER_SECTION_LABELS) as ServerSettingsSection[]).filter(s => shown[s])
}

type RowText = Omit<SearchRow, 'section' | 'id'>

const ROWS: Record<ServerSettingsSection, RowText> = {
  invites: {
    label: 'Invite link',
    line: 'The link or code people join with.',
    keywords: ['invite', 'code', 'share'],
  },
  overview: {
    label: 'Name, about and appearance',
    line: 'Rename the server, describe it and change its banner and name colors.',
    keywords: ['rename', 'server name', 'about', 'description', 'banner', 'color', 'encrypt'],
  },
  widgets: { label: 'Widgets', keywords: ['embed', 'frame'] },
  messages: {
    label: 'System messages',
    line: 'Where join and leave messages go.',
    keywords: ['welcome', 'join', 'leave'],
  },
  uploads: {
    label: 'File expiry',
    line: 'How long files posted here are kept.',
    keywords: ['uploads', 'files', 'attachments'],
  },
  profiles: {
    label: 'Server profiles',
    line: 'What members may set in their own profile here.',
    keywords: ['nickname', 'profile'],
  },
  access: {
    label: 'Access',
    line: 'Who can join and read, passwords and guests.',
    keywords: ['password', 'join', 'guests', 'public', 'member list'],
  },
  roles: { label: 'Roles', keywords: ['permissions', 'role'] },
  channels: {
    label: 'Channels',
    keywords: ['category', 'topic', 'slowmode', 'channel permissions'],
  },
  members: {
    label: 'Members and admins',
    keywords: ['admin', 'make admin', 'member roles', 'perms'],
  },
  bans: { label: 'Bans', keywords: ['banned', 'unban'] },
  integrations: { label: 'Webhooks', keywords: ['integrations', 'bots', 'events'] },
  audit: { label: 'Audit log', keywords: ['history', 'changes'] },
  delete: { label: 'Delete server', keywords: ['remove'] },
}

// Rows that read differently on the built-in server, which has no rename, and whose Access holds
// only guest participation.
const BUILTIN: Partial<Record<ServerSettingsSection, RowText>> = {
  overview: {
    label: 'Appearance',
    line: 'The banner and name colors of the server.',
    keywords: ['banner', 'color', 'encrypt'],
  },
  access: {
    label: 'Guest participation',
    line: 'Whether guests can chat or join voice here.',
    keywords: ['guests', 'guest chat', 'guest voice'],
  },
}

// Members without the admin list, for viewers who only assign roles.
const MEMBERS_ONLY: RowText = { label: 'Members', keywords: ['member roles', 'roles'] }

// The row search finds for a section, as the viewer sees the section.
export const serverSettingsRows = (
  section: ServerSettingsSection,
  { perms, builtin }: ServerSettingsViewer
): SearchRow[] => {
  const text =
    section === 'members' && !hasPerm(perms, Perm.ManageAdmins)
      ? MEMBERS_ONLY
      : ((builtin ? BUILTIN[section] : undefined) ?? ROWS[section])
  return [{ section, id: `server_${section}`, ...text }]
}

// The sections of a P2P room's settings. Every member sees them all; what someone may not
// change shows read-only inside.
export const ROOM_SECTIONS = [
  'overview',
  'roles',
  'channels',
  'invites',
  'system',
  'history',
  'members',
  'bans',
  'modlog',
  'leave',
] as const
export type RoomSettingsSection = (typeof ROOM_SECTIONS)[number]

export const ROOM_SECTION_TEXT: Record<RoomSettingsSection, { label: string; keywords: string[] }> =
  {
    overview: {
      label: 'Overview',
      keywords: ['rename', 'server name', 'server profiles', 'encrypt'],
    },
    roles: { label: 'Roles', keywords: ['permissions', 'role'] },
    channels: { label: 'Channels', keywords: ['category', 'topic', 'slowmode', 'voice'] },
    invites: { label: 'Invites', keywords: ['invite', 'code', 'link'] },
    system: { label: 'System messages', keywords: ['welcome', 'join', 'leave'] },
    history: { label: 'History', keywords: ['earlier messages', 'new members'] },
    members: { label: 'Members', keywords: ['member', 'kick', 'roles'] },
    bans: { label: 'Bans', keywords: ['banned', 'unban'] },
    modlog: { label: 'Moderation log', keywords: ['audit', 'reason', 'kick', 'ban', 'roles'] },
    leave: { label: 'Leave', keywords: ['leave server', 'remove from this device'] },
  }
