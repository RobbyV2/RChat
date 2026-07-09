export type AvatarKind = 'identicon' | 'color'

export const Perm = {
  ManageChannels: 1,
  DeleteMessages: 2,
  Kick: 4,
  DeleteServer: 8,
  ManageAdmins: 16,
} as const

export const ALL_PERMS = 31

export const hasPerm = (perms: number, perm: number) => (perms & perm) !== 0

export interface UserRef {
  username: string
  display_name: string
  avatar_kind: AvatarKind
  avatar_color: string | null
}

export interface ServerSummary {
  name: string
  display_name: string
  creator: string | null
  is_admin: boolean
}

export interface ServerSummaryLite {
  name: string
  display_name: string
  creator: string | null
  has_password: boolean
}

export type ChannelKind = 'text' | 'voice'

export interface Channel {
  id: number
  name: string
  kind: ChannelKind
  slowmode_seconds: number
}

export interface Role {
  id: number
  name: string
  color: string
  perms: number
}

export interface ChannelPerm {
  subject: string
  can_view: boolean
  can_send: boolean
  can_read_history: boolean
}

export interface Member extends UserRef {
  is_admin: boolean
  is_creator: boolean
  online: boolean
  perms: number
  role_ids: number[]
}

export interface ServerDetail {
  name: string
  display_name: string
  creator: string | null
  has_password: boolean
  channels: Channel[]
  roles: Role[]
  member_count: number
  online_count: number
}

export interface DmSummary {
  id: number
  other: UserRef
  is_self: boolean
}

export type MediaKind = 'server' | 'p2p'

export interface MessageMedia {
  id: string
  filename: string
  kind: MediaKind
  hoster: string | null
  expires_at: number | null
  size: number | null
  mime: string | null
  removed: boolean
  removed_by_author: boolean
  spoiler: boolean
}

export interface Embed {
  ord: number
  url: string
  site_name: string | null
  title: string | null
  description: string | null
  image_url: string | null
  banner_removed: boolean
}

export interface Message {
  id: number
  channel_id: number | null
  dm_id: number | null
  thread_root_id: number | null
  author: UserRef
  content: string
  created_at: number
  reply_count: number
  media: MessageMedia | null
  embeds: Embed[]
}

export interface SearchResult {
  message: Message
  server: string
  channel_name: string
}

export interface ServerMatch {
  name: string
  display_name: string
  has_password: boolean
}

export interface Me extends UserRef {
  is_site_admin: boolean
  servers: ServerSummary[]
  dms: DmSummary[]
}

export interface AuthResponse {
  token: string
  user: Me
}

export interface SiteSettings {
  profanity_filter: boolean
  asset_previews: boolean
  asset_uploads: boolean
  guests_enabled: boolean
}

export interface AdminOverview {
  server_count: number
  user_count: number
}

export interface Unread {
  scope: string
  last_read: number
  latest: number
}

interface Scoped {
  server: string | null
  channel_id: number | null
  dm_id: number | null
  dm_users: string[] | null
}

export type CallPhase = 'ringing' | 'active' | 'ended'

export type CallKind = 'rtc' | 'p2p'

export interface P2pAvailability {
  peer_id: string | null
  ids: string[]
  online: boolean
}

export interface RtcPayload {
  description?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
  muted?: boolean
  cam?: boolean
}

export type VoiceMsg =
  | { type: 'voice_join'; channel_id: number }
  | { type: 'voice_leave' }
  | { type: 'call_start'; dm_id: number; p2p?: boolean }
  | { type: 'call_accept' | 'call_decline' | 'call_leave'; dm_id: number }
  | { type: 'p2p_hosting'; peer_id: string; ids: string[] }
  | { type: 'p2p_who'; hosters: string[] }
  | {
      type: 'rtc_signal'
      to: string
      channel_id: number | null
      dm_id: number | null
      payload: RtcPayload
    }

export type WsEvent =
  | ({ type: 'message'; message: Message } & Scoped)
  | ({ type: 'message_deleted'; id: number; thread_root_id: number | null } & Scoped)
  | ({
      type: 'media_removed'
      message_id: number
      filename: string
      removed_by_author: boolean
    } & Scoped)
  | ({ type: 'embeds_resolved'; message_id: number; embeds: Embed[] } & Scoped)
  | ({ type: 'embeds_removed'; message_id: number; ord: number; banner: boolean } & Scoped)
  | { type: 'channel_created'; server: string; channel: Channel }
  | { type: 'channel_renamed'; server: string; channel: Channel }
  | { type: 'channel_deleted'; server: string; channel_id: number }
  | { type: 'server_created'; server: ServerSummaryLite }
  | { type: 'server_renamed'; old_name: string; server: ServerSummaryLite }
  | { type: 'server_deleted'; name: string }
  | { type: 'member_joined'; server: string; member: Member }
  | { type: 'member_left'; server: string; username: string }
  | { type: 'member_kicked'; server: string; username: string }
  | { type: 'admin_changed'; server: string; username: string; is_admin: boolean; perms: number }
  | { type: 'roles_changed'; server: string }
  | { type: 'channel_perms_changed'; server: string; channel_id: number }
  | { type: 'user_updated'; user: UserRef }
  | { type: 'user_registered'; user: UserRef }
  | { type: 'presence_changed'; server: string; username: string; online: boolean }
  | { type: 'read_updated'; username: string; scope: string; last_read: number }
  | { type: 'voice_state'; server: string; channel_id: number; users: string[] }
  | {
      type: 'call_state'
      dm_id: number
      dm_users: string[]
      state: CallPhase
      from: string
      kind: CallKind
    }
  | ({ type: 'p2p_availability'; hoster: string } & P2pAvailability)
  | {
      type: 'rtc_signal'
      to: string
      from: string
      channel_id: number | null
      dm_id: number | null
      payload: RtcPayload
    }
  | ({ type: 'voice_ended'; reason: string } & Scoped)
  | { type: 'error'; message: string }
  | { type: 'dm_created'; dm_users: string[] }
  | { type: 'banned'; username: string }
  | { type: 'settings_changed'; settings: SiteSettings }

export type WsStatus = 'green' | 'yellow' | 'red'

export type Theme = 'dark' | 'light'
