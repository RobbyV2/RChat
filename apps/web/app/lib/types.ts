import type { UploadExpiry } from './upload_expiry'
import type { TimeoutWire } from './timeouts'
import type { ProfileChoices, ProfileLevel } from './profile_choice'
import type { FwdPlace } from './p2p/content'
import type { ServerIconKind } from './server_about'
import { hasBit } from './perms'

export type AvatarKind = 'identicon' | 'color'

export const Perm = {
  ManageChannels: 1,
  DeleteMessages: 2,
  Kick: 4,
  DeleteServer: 8,
  ManageAdmins: 16,
  MentionEveryone: 32,
  ViewAuditLog: 64,
  TimeoutMembers: 128,
  ManageWebhooks: 256,
  ManageReports: 512,
  ManageServer: 4096,
  ManageInvites: 8192,
  ManageRoles: 16384,
  AssignRoles: 32768,
  ManageProfiles: 65536,
  PinMessages: 536870912,
  BypassSlowmode: 1073741824,
} as const

export const ALL_PERMS = 1610740735

// The permissions a channel rule can allow or deny besides Manage messages and Mention everyone.
export const ChannelPermBit = {
  ViewChannels: 131072,
  SendMessages: 262144,
  ReadHistory: 524288,
  AddReactions: 1048576,
  AttachFiles: 2097152,
  EmbedLinks: 4194304,
  CreatePolls: 8388608,
  StartThreads: 16777216,
  Connect: 33554432,
  Speak: 67108864,
  Video: 134217728,
  PinMessages: 536870912,
  BypassSlowmode: 1073741824,
} as const

export const hasPerm = (perms: number, perm: number) => hasBit(perms, perm)

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
  // How its icon is drawn. Absent on older servers: the letter.
  icon_kind?: ServerIconKind
  // your timeout's end in unix seconds; on this device's clock once loaded (see api.ts)
  timed_out_until?: number
  timed_out_remaining?: number
  // What members may set in their server profile. Absent on older servers: nothing.
  profiles_mode?: ProfilesMode
}

export interface ServerSummaryLite {
  name: string
  display_name: string
  creator: string | null
  has_password: boolean
  banner_color?: string | null
  name_color?: string | null
  // "Anyone can read this server": on, off, or null or absent to follow the site.
  public_read?: boolean | null
  // The server's guest voice and guest text choices: absent means off.
  guest_voice?: boolean
  guest_chat?: boolean
  // "Members can be seen by people outside this server". Absent on older servers: on.
  members_visible?: boolean
  // How people join. Absent on older servers: `name` without a password, else `password`.
  join_mode?: JoinMode
  // Whether search lists it. Absent on older servers: listed.
  listed?: boolean
  // What members may set in their server profile. Absent on older servers: nothing.
  profiles_mode?: ProfilesMode
  // What it is about, and how its icon is drawn. Absent on older servers: none, the letter.
  description?: string | null
  icon_kind?: ServerIconKind
}

export type JoinMode = 'name' | 'invite' | 'password' | 'closed'

// A server's invite link: the code, and the path of the link on its instance.
export interface InviteLinkInfo {
  code: string
  path: string
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
  text_only?: boolean
  sensitive?: boolean
  restrict_view?: boolean
  restrict_send?: boolean
  topic?: string | null
  category_id?: number | null
  position?: number
  // Its permission rules copy its category's.
  perm_sync?: boolean
  // What you hold in the channel (server details only; events leave it out).
  my_perms?: number
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
  // Place in the server's role order: higher ranks higher.
  position?: number
  // Place in the order roles show in; null follows `position`.
  display_position?: number | null
  // Its members show in a group of their own in the member list.
  hoist?: boolean
  // One emoji shown after its members' names.
  icon?: string | null
  // It colors its members' names (on unless false).
  color_names?: boolean
}

export interface ChannelPerm {
  subject: string
  can_view: boolean
  can_send: boolean
  can_read_history: boolean
  // The bits the rule allows and denies, and how a member's rule combines with their roles.
  allow?: number
  deny?: number
  mode?: 'override' | 'merge'
}

// What a member set for one server: each field null when they use the account's.
export interface MemberLook {
  name: string | null
  avatar_kind: AvatarKind | null
  avatar_color: string | null
}

export type ProfilesMode = 'all' | 'no_names' | 'off'

export interface ServerProfile {
  look: MemberLook
  bio: string | null
  banner_color: string | null
  effective: UserRef
  effective_banner: string | null
  effective_bio: string | null
  mode: ProfilesMode
  locked_until: number | null
}

export interface ServerProfilePatch {
  name?: string | null
  bio?: string | null
  avatar_kind?: AvatarKind | null
  avatar_color?: string | null
  banner_color?: string | null
}

// What a rule is set to: masks, the three flags, or a rule as listed with its flags changed.
export type ChannelPermInput =
  | { subject: string; allow: number; deny: number; mode?: 'override' | 'merge' }
  | Pick<ChannelPerm, 'subject' | 'can_view' | 'can_send' | 'can_read_history'>
  | ChannelPerm

export interface Member extends UserRef {
  is_admin: boolean
  is_creator: boolean
  online: boolean
  perms: number
  role_ids: number[]
  joined_via?: JoinedVia
  timeout?: TimeoutWire
  profile?: MemberLook
}

// A member a member search found, with when they joined and when their account was made.
export interface MemberHit extends Member {
  joined_at: number
  // null for an account that shows its profile only to its friends
  created_at: number | null
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

export interface BlockedUser {
  user: UserRef
  blocked_at: number
}

export interface Friend {
  user: UserRef
  since: number
  online: boolean
}

export interface FriendRequest {
  user: UserRef
  created_at: number
  incoming: boolean
}

export interface FriendSummary {
  incoming: number
  outgoing: number
  pings: number
  pings_until: number
}

export interface ServerBan extends UserRef {
  banned_at: number
  expires_at?: number | null
  reason?: string | null
}

export interface BanResult {
  ok: boolean
  expires_at: number | null
  purge_places: number
  purge_skipped: number
  purge_busy: number
}

export interface ServerDetail {
  name: string
  display_name: string
  creator: string | null
  has_password: boolean
  banner_color: string | null
  name_color: string | null
  // "Anyone can read this server": on, off, or null or absent to follow the site.
  public_read?: boolean | null
  // The server's guest voice and guest text choices: absent means off.
  guest_voice?: boolean
  guest_chat?: boolean
  // "Members can be seen by people outside this server". Absent on older servers: on.
  members_visible?: boolean
  // What members may set in their server profile. Absent on older servers: nothing.
  profiles_mode?: ProfilesMode
  my_profile?: ServerProfile
  // How people join. Absent on older servers: `name` without a password, else `password`.
  join_mode?: JoinMode
  // Whether search lists it. Absent on older servers: listed.
  listed?: boolean
  description?: string | null
  icon_kind?: ServerIconKind
  channels: Channel[]
  categories?: Category[]
  layout_version?: number
  read_only?: number[]
  roles: Role[]
  // The version of the role order, and whether that order decides who may moderate whom.
  roles_version?: number
  roles_order_confirmed?: boolean
  // What everyone in the server holds, and what you hold.
  everyone_perms?: number
  my_perms?: number
  role_limits?: RoleLimits
  member_count: number
  online_count: number
  // Absent on servers before per-server upload expiry: the instance default.
  upload_expiry?: UploadExpiry
  upload_ttl?: number | null
}

export interface RoleLimits {
  held_above: number[]
  channel_grants: number[]
  channel_denies: number[]
}

// readable: anyone may read the server, but joining it needs a password or invite (or nobody
// new may join).
export type InviteStatus = 'member' | 'banned' | 'joinable' | 'readable'

export interface Invite {
  server: ServerSummaryLite
  member_count: number
  online_count: number
  status: InviteStatus
  preview_channel_id?: number | null
  preview_sensitive?: boolean
  preview_channel: string | null
  preview: Message[]
  password_expires_at: number | null
  password_uses_left: number | null
}

export interface DmSummary {
  id: number
  other: UserRef
  is_self: boolean
  // Closed by you: only lookups by id return it.
  closed?: boolean
  // The newest message or call log, null without messages; absent from older servers.
  last_message_id?: number | null
  // Unix seconds.
  last_message_at?: number | null
  // The other person is an accepted friend; false for the self DM.
  friend?: boolean
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
  // A description of the image for people who can't see it; absent without one.
  alt?: string
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

export type MessageKind = 'user' | 'poll' | 'call' | 'pin' | 'join' | 'leave'

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
  no_previews?: boolean
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
  // kind 'poll': the poll as you see it; on a forwarded poll, a frozen snapshot
  poll?: Poll | null
  // Posted through an incoming webhook: the author is `@webhook:<id>`
  webhook?: MessageWebhook | null
}

export interface EmbedField {
  name: string
  value: string
  inline?: boolean
}

export interface RichEmbed {
  title?: string | null
  description?: string | null
  url?: string | null
  color?: number | null
  fields?: EmbedField[]
  footer?: { text: string } | null
}

export interface MessageWebhook {
  id: number
  embeds: RichEmbed[]
}

// A background bulk delete (`all`), see `POST /api/messages/bulk_delete`.
export interface BulkJob {
  id: number
  scope: string
  status: 'running' | 'done' | 'cancelled' | 'failed'
  deleted: number
  skipped: number
  estimate: number
  created_at: number
  finished_at: number | null
  error: string | null
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

export type PollKind = 'single' | 'multiple' | 'ranked' | 'rating' | 'yes_no'
export type ShowResults = 'always' | 'after_vote' | 'after_close'

export interface PollOption {
  id: number
  text: string
  emoji: string | null
}

export interface OptionCount {
  option_id: number
  count: number
}

export interface RunoffRound {
  counts: OptionCount[]
  exhausted: number
  eliminated: number | null
}

export interface PollResults {
  // single, multiple, yes_no: picks; ranked: first choices; empty for rating
  counts: OptionCount[]
  rounds: RunoffRound[]
  winner: number | null
  // rating: voters per score from 1
  distribution: number[]
  average: number | null
}

export interface Poll {
  kind: PollKind
  question: string
  options: PollOption[]
  anonymous: boolean
  show_results: ShowResults
  allow_change: boolean
  allow_add: boolean
  min_choices: number
  max_choices: number
  scale: number | null
  closes_at: number | null
  closed: boolean
  voters: number
  // null while hidden from you
  results: PollResults | null
  // your vote: option ids (rank order for ranked) or [score]; null when you did not vote or in events
  mine: number[] | null
  snapshot?: boolean
}

// A thread in a channel's or DM's thread list: its root and its newest reply.
export interface ThreadItem {
  root: Message
  last_reply_id: number
  last_reply_at: number
}

export interface PollVoter {
  user: UserRef
  voted_at: number
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
  origin_channel_id?: number | null
  // The channel named by origin_channel_id carries the shared sensitive label
  origin_sensitive?: boolean
  origin_channel?: string | null
  origin_server?: string | null
  // The channel of origin_server, for a copy from another server whose sender showed it
  origin_server_channel?: string | null
  dropped: string | null
  // Client only: what a P2P copy says of where it's from
  p2p?: FwdPlace
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
  forward?: ForwardRef
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
  // For a quoted forward, where its original came from
  forward?: ForwardRef
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
  description?: string | null
  icon_kind?: ServerIconKind
  banner_color?: string | null
}

export interface ProfileMember {
  is_admin: boolean
  is_creator: boolean
  perms: number
  role_ids: number[]
  roles: Role[]
  joined_at: number
  online: boolean
  timeout?: TimeoutWire
  profile?: MemberLook
  // Until when (unix seconds) a moderator locked their server profile. Only for viewers who
  // can reset server profiles.
  profile_locked_until?: number
}

export interface Profile {
  user: UserRef
  banner_color: string | null
  bio: string | null
  created_at: number
  member: ProfileMember | null
  // The description and banner the account set for the server the card was opened in.
  server_bio?: string | null
  server_banner?: string | null
}

export interface Me extends UserRef {
  has_password?: boolean
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
  // Set while the password is a temporary one: when it stops signing in (unix seconds, null
  // for never), and what this session must do. Absent on older servers.
  password_temporary?: { expires_at: number | null; change: PasswordChangeMode } | null
  // Set while the account waits to be deleted at its own request: when, in unix seconds.
  delete_at?: number
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

export type Registration = 'open' | 'sso' | 'closed'

export type ServerJoining = 'everyone' | 'invites' | 'nobody'

export type ServerCreation = 'everyone' | 'nobody' | 'some'

export type DmCreation = 'everyone' | 'friends' | 'nobody'

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

// The names, texts and images an instance sets for itself and for the app it serves.
export interface Brand {
  instance_name: string
  app_name: string
  short_name: string
  about: string
  links: BrandLink[]
  login_note: string
  suggestions: InstanceSuggestions
  // The uploaded images, each as a path on the instance with its version.
  assets: Partial<Record<BrandAsset, string>>
}

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

export type PingKind = 'mention' | 'reply' | 'reaction' | 'friend_request' | 'friend_accept'

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

// GET /api/inbox: one notification. `id` is unique within `source` (a ping id, the message id of
// a group mention, a friend ping id).
export type InboxSource = 'ping' | 'group' | 'friend'

export type InboxKind =
  | 'mention'
  | 'reply'
  | 'reaction'
  | 'everyone'
  | 'here'
  | 'role'
  | 'friend_request'
  | 'friend_accept'

export type InboxFilter = 'mentions' | 'replies' | 'reactions' | 'friends'

export interface InboxItem {
  source: InboxSource
  id: number
  kind: InboxKind
  unread: boolean
  created_at: number
  actor: UserRef
  emoji: string | null
  role: string | null
  group_kinds?: GroupKind[]
  scope: string | null
  server: string | null
  server_name: string | null
  channel_name: string | null
  message_id: number | null
  thread_root_id: number | null
  content: string | null
  media_filename: string | null
  media_spoiler?: boolean
}

export interface InboxUntil {
  pings: number
  groups: number
  friends: number
}

export interface InboxPage {
  items: InboxItem[]
  next: string | null
  // only with the first page
  until: InboxUntil | null
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
  | { type: 'staff_view_opened'; username: string; channel_id: number }
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
  | { type: 'admin_changed'; server: string; username: string; is_admin: boolean; perms: number }
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

export interface LinkedProvider {
  can_unlink?: boolean
  provider: string
  name: string
  linked_at: number
}
export type ReAuthBody =
  | { password: string }
  | { words: string[] }
  | { phrase: { nonce: string; sig: string } }
  | { idp: { provider: string; code: string } }

export interface AuthInfo {
  confirm_login?: boolean
  client_return?: boolean
  password_login: boolean
  registration: 'open' | 'sso' | 'closed'
  providers: { id: string; name: string }[]
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
