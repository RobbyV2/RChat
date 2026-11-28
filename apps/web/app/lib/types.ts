import type {
  AuthInfo,
  BlockedUser,
  BulkJob,
  CallKind,
  CallPhase,
  Channel,
  ChannelLayout,
  ChannelPerm,
  DmCreation,
  Embed,
  Friend,
  FriendRequest,
  Me,
  Member,
  MemberLook,
  Message,
  Ping,
  Poll,
  ProfanityTargets,
  Registration,
  Role,
  ScheduledMessage,
  SealJob,
  ServerCreation,
  ServerJoining,
  ServerSummaryLite,
  ThreadPings,
  UserRef,
} from './api/gen'
export type {
  AuditEntry,
  AuditTarget,
  AuthInfo,
  AvatarKind,
  BlockedUser,
  Brand,
  BulkJob,
  CallKind,
  CallLog,
  CallPhase,
  Category,
  CategoryStyle,
  Channel,
  ChannelKind,
  ChannelLayout,
  ChannelPerm,
  CreatedPassword,
  DmCreation,
  DmSummary,
  Embed,
  EmbedField,
  ForwardRef,
  Friend,
  FriendRequest,
  FriendSummary,
  GroupKind,
  GroupMention,
  GroupPing,
  IceServers,
  InboxFilter,
  InboxItem,
  InboxKind,
  InboxPage,
  InboxSource,
  InboxUntil,
  Invite,
  InviteLinkInfo,
  InviteStatus,
  JoinMode,
  JoinedVia,
  LinkedProvider,
  Me,
  MediaKind,
  Member,
  MemberHit,
  MemberLook,
  Message,
  MessageLocation,
  MessageWebhook,
  NewPassword,
  OptionCount,
  PasswordMembers,
  PasswordStatus,
  Ping,
  PingKind,
  Poll,
  PollKind,
  PollOption,
  PollResults,
  PollVoter,
  ProfanityTargets,
  Profile,
  ProfileMember,
  ProfilesMode,
  ReAuthBody,
  Reaction,
  Registration,
  ReplyRef,
  RichEmbed,
  Role,
  RoleLimits,
  RunoffRound,
  ScheduledMedia,
  ScheduledMessage,
  ScheduledPage,
  ScheduledPlace,
  SealJob,
  SearchResult,
  Separator,
  SeparatorStyle,
  ServerBan,
  ServerCreation,
  ServerDetail,
  ServerJoining,
  ServerMatch,
  ServerPassword,
  ServerPasswords,
  ServerProfile,
  ServerProfilePatch,
  ServerSummary,
  ServerSummaryLite,
  ServerUpdated,
  ShowResults,
  SystemMessages,
  ThreadItem,
  ThreadPings,
  Unread,
  UserRef,
} from './api/gen'
import type { MediaRef } from './api/gen'
import type { ProfileChoices, ProfileLevel } from './profile_choice'
import { hasBit } from './perms'

export const Perm = {
  ManageChannels: 1n,
  DeleteMessages: 2n,
  Kick: 4n,
  DeleteServer: 8n,
  ManageAdmins: 16n,
  MentionEveryone: 32n,
  ViewAuditLog: 64n,
  TimeoutMembers: 128n,
  ManageWebhooks: 256n,
  ManageReports: 512n,
  ManageServer: 4096n,
  ManageInvites: 8192n,
  ManageRoles: 16384n,
  AssignRoles: 32768n,
  ManageProfiles: 65536n,
  PinMessages: 536870912n,
  BypassSlowmode: 1073741824n,
} as const

export const ALL_PERMS = 1610740735n

// The permissions a channel rule can allow or deny besides Manage messages and Mention everyone.
export const ChannelPermBit = {
  ViewChannels: 131072n,
  SendMessages: 262144n,
  ReadHistory: 524288n,
  AddReactions: 1048576n,
  AttachFiles: 2097152n,
  EmbedLinks: 4194304n,
  CreatePolls: 8388608n,
  StartThreads: 16777216n,
  Connect: 33554432n,
  Speak: 67108864n,
  Video: 134217728n,
  PinMessages: 536870912n,
  BypassSlowmode: 1073741824n,
  ViewMembers: 34359738368n,
} as const

// Change server profile: everyone starts with it, and a role can hold it. No channel rule does.
export const CHANGE_PROFILE = 268435456n

// Every bit a role may hold: the management bits and the ones everyone starts with.
export const ROLE_BITS = 36507218943n

export const hasPerm = (perms: bigint, perm: bigint) => hasBit(perms, perm)

export interface ConfirmChoice {
  value: string
  label: string
  detail: string
  danger: boolean
}

// What a rule is set to: masks, the three flags, or a rule as listed with its flags changed.
export type ChannelPermInput =
  | { subject: string; allow: bigint; deny: bigint; mode?: 'override' | 'merge' }
  | Pick<ChannelPerm, 'subject' | 'can_view' | 'can_send' | 'can_read_history'>
  | ChannelPerm

export interface BanResult {
  ok: boolean
  expires_at: number | null
  purge_places: number
  purge_skipped: number
  purge_busy: number
}

// Whether a server or DM stores new messages encrypted with a key the site keeps, and whether
// the site requires it. `own` is the place's own switch, `server_forced` the site's requirement
// of this server alone; absent on older servers.
export interface StoredSeal {
  on: boolean
  forced: boolean
  own?: boolean
  server_forced?: boolean
}

export type MessageMedia = MediaRef

export type MessageKind = 'user' | 'poll' | 'call' | 'pin' | 'join' | 'leave' | 'storage'

export type CallOutcome = 'missed' | 'declined' | 'completed'

export interface AuthResponse {
  token: string
  user: Me
}

export type ProfanityTarget = keyof ProfanityTargets

export interface SiteSettings {
  profanity_filter: boolean
  profanity_targets: ProfanityTargets
  // File names and link paths read like message text. Absent on older servers: off.
  profanity_strict_file_names?: boolean
  asset_previews: boolean
  asset_uploads: boolean
  // A server that doesn't send it has P2P attachments on.
  p2p_attachments: boolean
  guests_enabled: boolean
  // Absent on servers before webhooks: off.
  outgoing_webhooks?: boolean
  // The feature switches; siteSettings fills them in for older servers.
  server_reports: boolean
  instance_reports: boolean
  widgets: boolean
  widget_chat: boolean
  guest_chat_enabled: boolean
  guest_voice_enabled: boolean
  widget_read_links: boolean
  widget_bridge: boolean
  e2ee: boolean
  e2ee_compliance: boolean
  backup_phrase: boolean
  p2p_backup: boolean
  display_names: boolean
  onboarding: boolean
  password_login: boolean
  sfu: boolean
  p2p: boolean
  client_other_instances: boolean
  server_profiles: boolean
  docs: boolean
  scheduled_messages: boolean
  interactive_docs: boolean
  // Who is in each server, their presence and mention suggestions.
  member_lists: boolean
  profile_pictures: boolean
  animated_profile_pictures: boolean
  registration: Registration
  // Days; 0 or absent: no cap.
  upload_expiry_max_days?: number
  // How people get into servers by themselves. Absent on older servers: everyone.
  server_joining?: ServerJoining
  // Whether server owners can make servers publicly readable. Absent on older servers: on.
  public_reading?: boolean
  // Who can create servers. `some` is a list only the site admin reads. Absent on older
  // servers: everyone.
  server_creation?: ServerCreation
  // Absent on older servers: on.
  server_search?: boolean
  // Who can start a direct conversation. Absent on older servers: everyone.
  dm_creation?: DmCreation
  // Absent on older servers: on.
  friend_requests?: boolean
  calls?: boolean
  incoming_webhooks?: boolean
  // The default servers anyone can read, where guests start.
  guest_servers?: string[]
  // The site requires encrypted storage, also of what the app stores of P2P rooms and DMs on
  // this device. Absent on older servers: off.
  encryption_required?: boolean
  // Whether encrypted storage can be turned on here. Absent on older servers.
  encryption_ready?: 'ready' | 'first_need' | 'keys' | 'updating'
  // Whether the server every instance starts with is still there. Absent on older servers:
  // kept.
  builtin_server?: 'kept' | 'removed'
  // Who can see profiles. Absent on servers before it, which have no profile choice.
  profile_visibility?: ProfileLevel
  // What accounts may choose for their own profile; siteSettings fills it in once the level
  // is there.
  profile_choices?: ProfileChoices
  // What an account that signed in with a temporary password must do. Absent on older
  // servers, which issue none.
  password_change?: PasswordChangeMode
  // Hours a new temporary password signs in for; 0: no expiry.
  temp_password_hours?: number
}

// required: the session can only choose a password. encouraged: it is asked to.
export type PasswordChangeMode = 'required' | 'encouraged'

export type SiteSettingsPatch = Partial<Omit<SiteSettings, 'profanity_targets'>> & {
  profanity_targets?: Partial<ProfanityTargets>
  // Lists only the site admin reads, in the config view: who "some" means for creating
  // servers (usernames and server:role entries), and the servers new accounts join.
  server_creators?: string[]
  default_servers?: string[]
  // The brand, which everyone reads in `Brand`.
  instance_name?: string
  app_name?: string
  app_short_name?: string
  brand_about?: string
  brand_links?: BrandLink[]
  login_note?: string
  instance_suggestions?: InstanceSuggestions
}

export interface BrandLink {
  label: string
  url: string
}

export interface InstanceSuggestion {
  url: string
  label: string
}

// `add`: after the list the app was built with. `replace`: instead of it.
export interface InstanceSuggestions {
  mode: 'add' | 'replace'
  list: InstanceSuggestion[]
}

export type BrandAsset = 'logo' | 'mark-32' | 'mark-180' | 'mark-192' | 'mark-512' | 'mark-maskable'

// One row of the instance audit log, which only the site admin's panel lists.
export interface InstanceAuditEntry {
  id: number
  at: number
  // Null once the account is deleted.
  actor: string | null
  action: string
  target: string | null
  detail: unknown
}

export interface RelayStatus {
  enabled: boolean
  turn: boolean
  port: number | null
  // Null when the relay runs in another process.
  allocations: number | null
}

// One control in the site admin's config view: its value, what the server config said at the
// last start that set it (null when it does not set it), and whether the config pins it. Values
// are written as the server config writes them.
export interface ConfigControl {
  key: string
  env: string
  value: string
  config: string | null
  // Whether the stored value says what the config says; an older server leaves it out.
  same?: boolean
  pinned: boolean
}

// One limit of the server config; limits change only there, at a start.
export interface ConfigLimit {
  env: string
  value: number | null
  default: number | null
  // "low-high", or empty.
  range: string
}

export interface DatabasePool {
  max: number
  in_use: number
  idle: number
}

export interface DatabaseStatus {
  kind: 'sqlite' | 'postgres'
  version: string
  schema_version: number
  pool: DatabasePool
  reader: DatabasePool | null
  connections: { used: number; allowed: number } | null
  light_commits: 'async' | 'sync' | null
  statement_timeout_secs: number | null
  replicas: { host: string; healthy: boolean; lag_ms: number | null }[]
  online_indexes: { name: string; state: string; percent: number | null; size_mib: number }[]
}

export interface AdminConfig {
  database?: DatabaseStatus
  controls: ConfigControl[]
  limits: ConfigLimit[]
}

export interface AdminOverview {
  server_count: number
  user_count: number
  // Accounts whose password is still a temporary one. Absent on older servers.
  temporary_count?: number
  relay?: RelayStatus
}

// A temporary password as the server returns it once.
export interface IssuedPassword {
  temp_password: string
  // Unix seconds; null for never.
  expires_at: number | null
}

// What became of one server an account was to join.
export interface AddedServer {
  server: string
  ok: boolean
  error?: string
}

export interface CreatedAccount extends IssuedPassword {
  user: UserRef
  servers: AddedServer[]
}

// One account as the site administration page shows it.
export interface AdminAccount {
  user: UserRef
  created_at: number
  sign_in: 'text' | 'words'
  temporary: { issued_at: number; expires_at: number | null; expired: boolean } | null
  phrase: boolean
  sessions: number
  servers: number
}

export type AccountFilter = 'all' | 'temporary' | 'expired'

// A server a new account joins, with the roles it gets there.
export interface AccountServer {
  server: string
  roles: number[]
}

// Unseen pings of a scope: `pings` counts thread pings too; `pings_until` is the highest unseen
// ping id outside threads.
export interface PingSummary {
  pings?: number
  pings_until?: number
  thread_pings?: ThreadPings[]
}

interface Scoped {
  server: string | null
  channel_id: number | null
  dm_id: number | null
  dm_users: string[] | null
}

// Whether a hoster is online and which of their files we can read. Peer ids are never shared
// this way; a download asks for one with `p2p_peer`.
export interface P2pAvailability {
  ids: string[]
  online: boolean
}

export interface CallPeer {
  user: string
  peer_id: string
}

// Relay hosts one side of a P2P call declared.
export interface CallRelays {
  user: string
  hosts: string[]
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

export type VoiceMsg =
  | { type: 'voice_join'; channel_id: number; muted?: boolean; deafened?: boolean }
  | { type: 'voice_leave' }
  | { type: 'voice_audio'; muted: boolean; deafened: boolean }
  | {
      type: 'call_start'
      attempt_id?: number
      dm_id: number
      p2p?: boolean
      video?: boolean
      peer_id?: string
      relays?: string[]
    }
  | { type: 'call_accept'; attempt_id?: number; dm_id: number; peer_id?: string; relays?: string[] }
  | { type: 'call_decline' | 'call_leave'; dm_id: number }
  | {
      type: 'p2p_hosting'
      peer_id: string
      ids: string[]
      relay_sets?: { hosts: string[]; ids: string[] }[]
    }
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
  | ({ type: 'messages_deleted'; ids: number[]; thread_root_id: number | null } & Scoped)
  | { type: 'bulk_delete_progress'; username: string; job: BulkJob }
  | { type: 'scheduled_updated'; username: string; scheduled: ScheduledMessage }
  | { type: 'scheduled_removed'; username: string; id: number; sent_message_id: number | null }
  | { type: 'staff_view_opened'; username: string; channel_id: number }
  | { type: 'seal_job_progress'; username: string; job: SealJob }
  | { type: 'poll_voted'; username: string; message_id: number }
  | ({
      type: 'poll_updated'
      message_id: number
      thread_root_id: number | null
      created_at: number
      poll: Poll
    } & Scoped)
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
  | { type: 'admin_changed'; server: string; username: string; is_admin: boolean; perms: bigint }
  | { type: 'roles_changed'; server: string }
  | { type: 'role_updated'; server: string; role: Role }
  | {
      type: 'roles_reordered'
      server: string
      order: number[]
      display: (number | null)[]
      version: number
    }
  | { type: 'member_roles_changed'; server: string; username: string; role_ids: number[] }
  | { type: 'upload_expiry_changed'; server: string }
  | { type: 'channel_perms_changed'; server: string; channel_id: number }
  | { type: 'channels_perms_changed'; server: string; channel_ids: number[] }
  | { type: 'layout_changed'; server: string; layout: ChannelLayout }
  | { type: 'user_updated'; user: UserRef }
  | {
      type: 'member_profile'
      server: string
      username: string
      profile: MemberLook | null
      bio: boolean
    }
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
  | { type: 'group_pings_seen'; username: string; scope: string; message_ids: number[] }
  | {
      type: 'voice_state'
      server: string
      channel_id: number
      users: string[]
      // In a snapshot: what each of them not at the default says about their own mic and sound.
      audio?: { username: string; muted: boolean; deafened: boolean }[]
    }
  | {
      type: 'voice_muted'
      server: string
      channel_id: number
      username: string
      muted: boolean
      // A guest staff muted for everyone, not a timeout.
      staff?: boolean
    }
  | {
      // What someone in a voice channel says about their own mic and sound.
      type: 'voice_audio'
      server: string
      channel_id: number
      username: string
      muted: boolean
      deafened: boolean
    }
  | {
      type: 'member_timeout'
      server: string
      username: string
      until: number | null
      remaining: number
      reason: string | null
    }
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
      // P2P calls only: the caller's while ringing, both sides once active.
      relays?: CallRelays[]
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
  | {
      type: 'error'
      message: string
      request?:
        | { type: 'call'; attempt_id: number }
        | { type: 'voice_join'; channel_id: number }
        | { type: 'other' }
    }
  | { type: 'guest_name'; name: string }
  | { type: 'dm_created'; dm_id: number; dm_users: string[] }
  | { type: 'dm_updated'; dm_id: number; dm_users: string[]; seal: StoredSeal }
  | { type: 'dm_closed'; username: string; dm_id: number }
  | { type: 'dm_reopened'; username: string; dm_id: number }
  | { type: 'user_blocked'; username: string; blocked: BlockedUser }
  | { type: 'user_unblocked'; username: string; blocked: string }
  | { type: 'friend_request_added'; username: string; request: FriendRequest }
  | { type: 'friend_request_removed'; username: string; other: string }
  | { type: 'friend_added'; username: string; friend: Friend }
  | { type: 'friend_removed'; username: string; friend: string }
  | { type: 'friend_presence'; username: string; friend: string; online: boolean }
  | { type: 'privacy_changed'; username: string; privacy: unknown }
  | { type: 'banned'; username: string }
  | { type: 'settings_changed'; settings: SiteSettings }
  | { type: 'brand_changed'; brand: unknown }
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
      // Relay hosts the hoster declared for this file; older servers leave it out.
      relays?: string[]
    }
  | { type: 'resync' }

export type WsStatus = 'green' | 'yellow' | 'red'

export type Theme = 'dark' | 'light'

export interface InstanceFeatures {
  guests: boolean
  uploads: boolean
  // A server that doesn't send it has P2P attachments on.
  p2p_attachments?: boolean
  previews: boolean
  identity_assertions: boolean
}

export interface InstanceLimits {
  message_chars: number
  name_chars: number
  upload_bytes: number
  avatar_upload_bytes?: number
  media_retention_secs: number
  page_size: number
  assertion_ttl_secs: number
  // Whether the instance limits how much is kept longer than the default lifetime. Not every
  // server sends it.
  upload_kept_limited?: boolean
  // P2P_LIMITS: `local.<section>.<key>` and `agreed.<key>` to a number. Not every server sends it.
  p2p?: Record<string, number>
  // Realtime reconnect and reload timings in milliseconds. Not every server sends them.
  reconnect_base_ms?: number
  reconnect_cap_ms?: number
  reconnect_floor_ms?: number
  resync_jitter_ms?: number
  catch_up_delay_ms?: number
}
export interface ProviderConfirmation {
  provider: string
  code: string
  expires_at: number
}
export interface ExchangeRequest {
  confirm_as?: string
  code: string
  verifier: string
  username?: string
}
export type ExchangeResponse =
  | ({ kind: 'session'; end_session: boolean; confirmation?: ProviderConfirmation } & AuthResponse)
  | { kind: 'pick_username'; suggestion: string | null; reason: 'taken' | 'invalid' }
  | { kind: 'linked'; provider: string }

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

export interface InstanceInfo {
  auth?: AuthInfo
  software: 'rchat'
  id: string
  name: string
  host: string
  version: string
  api_version: string
  // Served versions; absent on instances from before API versions (see `api_version.ts`).
  api_versions?: string[]
  public_url: string
  api_url: string
  ws_url: string
  // Absent while the instance has P2P and P2P attachments off.
  peerjs_url?: string
  instance_url: string
  jwks_uri: string
  ice?: InstanceIce
  features: InstanceFeatures
  limits: InstanceLimits
  // Not every server sends it.
  e2ee?: boolean
  sfu?: boolean
  widgets?: boolean
}
