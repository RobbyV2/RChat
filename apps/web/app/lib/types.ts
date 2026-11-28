import type {
  AuthInfo,
  ChannelPerm,
  DmCreation,
  Me,
  ProfanityTargets,
  Registration,
  ServerCreation,
  ServerJoining,
  ThreadPings,
} from './api/gen'
export type {
  AdminAccount,
  AdminConfig,
  AdminOverview,
  AuditEntry,
  AuditTarget,
  AuthInfo,
  AvatarKind,
  BlockedUser,
  Brand,
  BulkJob,
  CallKind,
  CallLog,
  CallPeer,
  CallPhase,
  CallRelays,
  Category,
  CategoryStyle,
  Channel,
  ChannelKind,
  ChannelLayout,
  ChannelPerm,
  ConfigControl,
  ConfigLimit,
  CreatedAccount,
  CreatedPassword,
  DatabasePool,
  DatabaseStatus,
  DmCreation,
  DmSummary,
  EditStub,
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
  InstanceAuditEntry,
  Invite,
  InviteLinkInfo,
  InviteStatus,
  IssuedPassword,
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
  RelayStatus,
  ReplyRef,
  RichEmbed,
  Gif,
  GifPage,
  PreviewKind,
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
  WsEvent,
} from './api/gen'
import type { MediaRef, ServerResult } from './api/gen'
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
  // The GIF picker: searches and files go through the instance.
  gifs: boolean
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

// What became of one server an account was to join.
export type AddedServer = ServerResult

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

// Whether a hoster is online and which of their files we can read. Peer ids are never shared
// this way; a download asks for one with `p2p_peer`.
export interface P2pAvailability {
  ids: string[]
  online: boolean
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
