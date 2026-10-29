export type AvatarKind = 'identicon' | 'color'

export const Perm = {
  ManageChannels: 1,
  DeleteMessages: 2,
  Kick: 4,
  DeleteServer: 8,
  ManageAdmins: 16,
  MentionEveryone: 32,
  ViewAuditLog: 64,
} as const

export const ALL_PERMS = 127

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
  banner_color?: string | null
  name_color?: string | null
}

export interface ServerSummaryLite {
  name: string
  display_name: string
  creator: string | null
  has_password: boolean
  banner_color?: string | null
  name_color?: string | null
}

export type PasswordMembers = 'keep' | 'remove'

export interface ConfirmChoice {
  value: string
  label: string
  detail: string
  danger: boolean
}

export interface ServerUpdated extends ServerSummaryLite {
  removed: number
  kept: number
}

export type ChannelKind = 'text' | 'voice'

export interface Channel {
  id: number
  name: string
  kind: ChannelKind
  slowmode_seconds: number
  restrict_view?: boolean
  restrict_send?: boolean
  topic?: string | null
  category_id?: number | null
  position?: number
}

export interface Category {
  id: number
  name: string
  position: number
}

export interface ChannelLayout {
  version: number
  uncategorized: number[]
  categories: { id: number; name: string; channels: number[] }[]
}

export interface Role {
  id: number
  name: string
  color: string
  perms: number
  // anyone who can send may mention it
  mentionable?: boolean
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
  joined_via?: JoinedVia
}

export interface JoinedVia {
  id: number
  label: string | null
}

export type PasswordStatus = 'live' | 'expired' | 'used_up' | 'revoked'

export interface ServerPassword {
  id: number
  label: string | null
  created_by: string | null
  created_at: number
  expires_at: number | null
  max_uses: number | null
  uses: number
  status: PasswordStatus
}

export interface ServerPasswords {
  protected: boolean
  permanent: boolean
  closed: boolean
  passwords: ServerPassword[]
}

export interface CreatedPassword extends ServerPassword {
  password: string
}

export interface NewPassword {
  label?: string
  password?: string
  expires_in?: number
  expires_at?: number
  max_uses?: number
}

export interface AuditTarget {
  kind: string
  id: number | null
  name: string | null
  user: UserRef | null
  staff: boolean
  deleted: boolean
}

export interface AuditEntry {
  id: number
  action: string
  actor: UserRef | null
  staff: boolean
  target: AuditTarget | null
  details: Record<string, unknown>
  hidden: boolean
  created_at: number
}

export interface ServerBan extends UserRef {
  banned_at: number
}

export interface ServerDetail {
  name: string
  display_name: string
  creator: string | null
  has_password: boolean
  banner_color: string | null
  name_color: string | null
  channels: Channel[]
  categories?: Category[]
  layout_version?: number
  read_only?: number[]
  roles: Role[]
  role_limits?: RoleLimits
  member_count: number
  online_count: number
}

export interface RoleLimits {
  held_above: number[]
  channel_grants: number[]
  channel_denies: number[]
}

export type InviteStatus = 'member' | 'banned' | 'joinable'

export interface Invite {
  server: ServerSummaryLite
  member_count: number
  online_count: number
  status: InviteStatus
  preview_channel: string | null
  preview: Message[]
  password_expires_at: number | null
  password_uses_left: number | null
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
  // SHA-256 of a P2P file, from the sender; absent or null from older senders and servers.
  sha256?: string | null
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

export type MessageKind = 'user' | 'call' | 'pin' | 'join' | 'leave'

export type CallOutcome = 'missed' | 'declined' | 'completed'

export interface CallLog {
  from: string
  answered_at: number | null
  ended_at: number | null
  outcome: CallOutcome | null
  // Null or missing for calls logged before these were recorded.
  p2p?: boolean | null
  video?: boolean | null
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
  kind: MessageKind
  call: CallLog | null
  reactions?: Reaction[]
  reply_to?: ReplyRef | null
  edited_at?: number | null
  forward?: ForwardRef | null
  // unix seconds; null when not pinned
  pinned_at?: number | null
  // kind 'pin': the pinned message, null once it is deleted or older than your history
  pin_message_id?: number | null
  // @everyone, @here and role mentions that pinged when it was sent
  group_mentions?: GroupMention[]
}

export type GroupKind = 'everyone' | 'here' | 'role'

export interface GroupMention {
  kind: GroupKind
  role_id: number | null
}

// An unread message that pings you through group mentions.
export interface GroupPing {
  message_id: number
  kinds: GroupKind[]
}

export interface SystemMessages {
  // null: the default channel (the server's first text channel)
  channel_id: number | null
  join_messages: boolean
  leave_messages: boolean
}

export interface ForwardRef {
  // null once the original author's account is deleted or banned
  author: UserRef | null
  created_at: number
  source_id: number
  // ASCII fallback label for older servers
  origin: string | null
  origin_dm?: boolean
  origin_channel?: string | null
  origin_server?: string | null
  dropped: string | null
}

export interface MessageLocation {
  id: number
  server: string | null
  channel_id: number | null
  dm_id: number | null
  thread_root_id: number | null
  author: UserRef
  created_at: number
  content: string
  has_media: boolean
  kind: string
  forwarded: boolean
}

export interface ReplyRef {
  id: number
  author: UserRef | null
  content: string
  has_media: boolean
  deleted: boolean
  mention: boolean
  partial?: boolean
  forwarded?: boolean
}

export interface Reaction {
  emoji: string
  count: number
  me: boolean
  first_at: number
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

export interface ProfileMember {
  is_admin: boolean
  is_creator: boolean
  perms: number
  role_ids: number[]
  roles: Role[]
  joined_at: number
  online: boolean
}

export interface Profile {
  user: UserRef
  banner_color: string | null
  bio: string | null
  created_at: number
  member: ProfileMember | null
}

export interface Me extends UserRef {
  banner_color: string | null
  bio: string | null
  is_site_admin: boolean
  appear_offline: boolean
  password_kind: 'text' | 'words'
  servers: ServerSummary[]
  servers_more: boolean
  servers_cursor: string | null
  dms: DmSummary[]
  dms_more: boolean
  dms_cursor: string | null
}

export interface AuthResponse {
  token: string
  user: Me
}

export interface ProfanityTargets {
  messages: boolean
  links: boolean
  usernames: boolean
  server_names: boolean
  channel_names: boolean
  role_names: boolean
  file_names: boolean
  bios: boolean
  channel_topics: boolean
  category_names: boolean
}

export type ProfanityTarget = keyof ProfanityTargets

export interface SiteSettings {
  profanity_filter: boolean
  profanity_targets: ProfanityTargets
  asset_previews: boolean
  asset_uploads: boolean
  // Absent on servers before 0.3.0, where P2P attachments are always on.
  p2p_attachments: boolean
  guests_enabled: boolean
}

export type SiteSettingsPatch = Partial<Omit<SiteSettings, 'profanity_targets'>> & {
  profanity_targets?: Partial<ProfanityTargets>
}

export interface RelayStatus {
  enabled: boolean
  turn: boolean
  port: number | null
  // Null when the relay runs in another process.
  allocations: number | null
}

export interface AdminOverview {
  server_count: number
  user_count: number
  relay?: RelayStatus
}

export interface ThreadPings {
  root_id: number
  pings: number
  pings_until: number
}

// Unseen pings of a scope: `pings` counts thread pings too; `pings_until` is the highest unseen
// ping id outside threads.
export interface PingSummary {
  pings?: number
  pings_until?: number
  thread_pings?: ThreadPings[]
}

export interface Unread extends PingSummary {
  scope: string
  server: string | null
  last_read: number
  latest: number
  group_pings?: GroupPing[]
}

interface Scoped {
  server: string | null
  channel_id: number | null
  dm_id: number | null
  dm_users: string[] | null
}

export type CallPhase = 'ringing' | 'active' | 'ended'

export type CallKind = 'rtc' | 'p2p'

// Whether a hoster is online and which of their files we can read. Peer ids are never shared
// this way any more; a download asks for one with `p2p_peer`.
export interface P2pAvailability {
  ids: string[]
  online: boolean
}

export interface CallPeer {
  user: string
  peer_id: string
}

export interface RtcPayload {
  description?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
  muted?: boolean
  cam?: boolean
  // A screen share goes out on its own slot; old clients ignore this.
  screen?: boolean
  // Asks the impolite side for an ICE restart.
  restart?: boolean
  // The sender's session, and the session of ours it is meant for.
  sid?: string
  rsid?: string
}

export type PingKind = 'mention' | 'reply' | 'reaction'

export interface Ping {
  id: number
  kind: PingKind
  scope: string
  server: string | null
  message_id: number
  thread_root_id: number | null
  actor: UserRef
  emoji: string | null
  excerpt: string
  created_at: number
}

export type VoiceMsg =
  | { type: 'voice_join'; channel_id: number }
  | { type: 'voice_leave' }
  | { type: 'call_start'; dm_id: number; p2p?: boolean; video?: boolean; peer_id?: string }
  | { type: 'call_accept'; dm_id: number; peer_id?: string }
  | { type: 'call_decline' | 'call_leave'; dm_id: number }
  | { type: 'p2p_hosting'; peer_id: string; ids: string[] }
  | { type: 'p2p_who'; hosters: string[] }
  | { type: 'p2p_peer'; message_id: number; peer_id: string }
  | {
      type: 'rtc_signal'
      to: string
      channel_id: number | null
      dm_id: number | null
      payload: RtcPayload
    }

// An edit in a server channel: only which message changed; holders re-read it.
export interface EditStub {
  type: 'message_updated'
  stub: true
  id: number
  server: string
  channel_id: number
  thread_root_id: number | null
  edited_at: number | null
}

export type WsEvent =
  | ({ type: 'message'; message: Message } & Scoped)
  | ({
      type: 'typing'
      // `c{channel}`, `t{thread root}` or `d{dm}`.
      scope: string
      username: string
      display_name: string
      // Unix seconds; 0 when they stopped.
      until: number
    } & Scoped)
  | { type: 'message_updated'; message: Message; stub?: false }
  | EditStub
  | ({
      type: 'reaction_added' | 'reaction_removed'
      message_id: number
      thread_root_id: number | null
      emoji: string
      username: string
      count?: number
    } & Scoped)
  | ({ type: 'message_deleted'; id: number; thread_root_id: number | null } & Scoped)
  | ({
      type: 'message_pinned'
      message_id: number
      pinned_at: number
      pinned_by: string
    } & Scoped)
  | ({ type: 'message_unpinned'; message_id: number } & Scoped)
  | ({
      type: 'media_removed'
      message_id: number
      removed_by_author: boolean
    } & Scoped)
  | ({ type: 'embeds_resolved'; message_id: number; embeds: Embed[] } & Scoped)
  | ({ type: 'embeds_removed'; message_id: number; ord: number; banner: boolean } & Scoped)
  | { type: 'channel_created'; server: string; channel: Channel }
  | { type: 'channel_renamed'; server: string; channel: Channel }
  | { type: 'channel_updated'; server: string; channel: Channel }
  | { type: 'channel_deleted'; server: string; channel_id: number }
  | { type: 'server_created'; server: ServerSummaryLite }
  | { type: 'server_renamed'; old_name: string; server: ServerSummaryLite }
  | { type: 'server_updated'; server: ServerSummaryLite }
  | { type: 'server_deleted'; name: string }
  | { type: 'member_joined'; server: string; member: Member }
  | { type: 'member_left'; server: string; username: string }
  | { type: 'member_kicked'; server: string; username: string; banned: boolean }
  | { type: 'admin_changed'; server: string; username: string; is_admin: boolean; perms: number }
  | { type: 'roles_changed'; server: string }
  | { type: 'channel_perms_changed'; server: string; channel_id: number }
  | { type: 'layout_changed'; server: string; layout: ChannelLayout }
  | { type: 'user_updated'; user: UserRef }
  | { type: 'user_registered'; user: UserRef }
  | {
      type: 'presence_changed'
      server: string
      username: string
      online: boolean
      online_count?: number
    }
  | { type: 'presence_snapshot'; server: string; online: string[]; online_count: number }
  | { type: 'server_banned'; server: string; username: string }
  | { type: 'presence_mode'; username: string; appear_offline: boolean }
  | {
      type: 'read_updated'
      username: string
      scope: string
      last_read: number
      pings_until?: number
    }
  | { type: 'ping'; username: string; ping: Ping }
  | ({ type: 'ping_count'; username: string; scope: string } & PingSummary)
  | { type: 'voice_state'; server: string; channel_id: number; users: string[] }
  | {
      type: 'call_state'
      dm_id: number
      dm_users: string[]
      state: CallPhase
      from: string
      kind: CallKind
      // Older servers leave it out.
      video?: boolean
      // Active calls only; older servers leave it out.
      answered_at?: number
      // Active P2P calls only.
      call_id?: string
      peers?: CallPeer[]
    }
  | ({ type: 'p2p_availability'; hoster: string; peer_id: string | null } & P2pAvailability)
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
  | { type: 'dm_created'; dm_id: number; dm_users: string[] }
  | { type: 'banned'; username: string }
  | { type: 'settings_changed'; settings: SiteSettings }
  | {
      type: 'p2p_hosted'
      live: string[]
      checked: string[]
      // Older servers send none of these.
      key?: string
      peer_id?: string
      now?: number
    }
  | {
      type: 'p2p_peer'
      message_id: number
      peer_id: string | null
      token: string | null
      expires_at: number | null
      error: string | null
    }
  | { type: 'resync' }

export type WsStatus = 'green' | 'yellow' | 'red'

export type Theme = 'dark' | 'light'

export interface InstanceFeatures {
  guests: boolean
  uploads: boolean
  // Absent before 0.3.0.
  p2p_attachments?: boolean
  previews: boolean
  identity_assertions: boolean
}

export interface InstanceLimits {
  message_chars: number
  name_chars: number
  upload_bytes: number
  media_retention_secs: number
  page_size: number
  assertion_ttl_secs: number
}

export interface InstanceInfo {
  software: 'rchat'
  id: string
  name: string
  host: string
  version: string
  api_version: string
  public_url: string
  api_url: string
  ws_url: string
  peerjs_url: string
  instance_url: string
  jwks_uri: string
  ice?: InstanceIce
  features: InstanceFeatures
  limits: InstanceLimits
}

// ICE servers the instance offers for P2P connections; absent on instances before API 1.1.
export interface InstanceIce {
  stun: string[]
  turn: boolean
  relay: boolean
}

export interface IceServerEntry {
  urls: string[]
  username?: string
  credential?: string
}

export interface IceServers {
  ice_servers: IceServerEntry[]
  expires_at: number
}
