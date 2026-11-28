// State and UI types of the store; store.ts re-exports them.

import type { AvatarCrop } from './avatar_images'
import type { AvatarMode } from './avatar_setting'
import type { Secret as Sealed } from './secret'
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { LoginRequest, PollReq, RegisterRequest, SendOpts } from './api'
import type { PollTarget } from './polls_store'
import type { HostedScheduled } from './scheduled_store'
import type { RefusedLoads } from './own_loads'
import type { Selection } from './selection'
import type { PendingUpload } from './attachments'
import type { Decision, RelayChoice, RelayPrefs } from './relays'
import type { LinkPrefs, Site } from './link_safety'
import type { CallRoute } from './call_choice'
import type { P2pApp } from './p2p/app/runtime'
import type { ConfigDoc, SectionKey } from './config_transfer'
import type { ServerSettingsSection } from './server_settings_sections'
import type { EmojiPrefs } from './emoji'
import type { ForwardClip } from './forward'
import type { AlertInput } from './notices'
import type { OpenInvite } from './invite'
import type { OlderState, ReadMark } from './lists'
import type { DmEdge, DmListPrefs } from './dm_list'
import type { DmSections, DmZone, Layout } from './nav_layout'
import type { Blocked } from './blocks'
import type { FriendsTab, Privacy, SendResult } from './friends'
import type { Notice } from './notices'
import type { Level, MuteUntil, NotifyPrefs, NotifyScope, Suppress } from './notify'
import type { PassKind, Secret } from './password'
import type { Pings } from './pings'
import type { GroupPings } from './group_pings'
import type { Replying } from './replies'
import type { LockSecs, ResetField } from './profile_reset'
import type { SearchArgs } from './search'
import type { Sed } from './sed'
import type { SettingsAsk, SettingsFocus } from './settings_sections'
import type { ShowSpoilers } from './spoilers'
import type { SignupFailure } from './signup'
import type {
  AdminOverview,
  AvatarKind,
  BlockedUser,
  Brand,
  BulkJob,
  SealJob,
  CallKind,
  CallRelays,
  CategoryStyle,
  ChannelKind,
  ChannelPermInput,
  ConfirmChoice,
  DmSummary,
  Friend,
  FriendRequest,
  InstanceInfo,
  ExchangeRequest,
  ExchangeResponse,
  Me,
  Member,
  Message,
  MessageLocation,
  P2pAvailability,
  Ping,
  SearchResult,
  SeparatorStyle,
  ServerBan,
  ServerDetail,
  ServerProfile,
  ServerProfilePatch,
  ServerSummaryLite,
  SiteSettings,
  SiteSettingsPatch,
  Theme,
  UserRef,
  WsEvent,
  WsStatus,
} from './types'
import type { AdminSection, View, Nav } from './view'
import type { Timeout } from './timeouts'
import type { TypingMap } from './typing'
import type { AnimPrefs } from './motion/setting'
import type { SelfAudio } from './voice_layout'
import type { SeatAudio } from './voice_status'

// More that "Mark all as read" marks (P2P): whether it has anything unread, and marking it.
export interface MarkAllExtra {
  pending: boolean
  mark: () => void
}

// A menu row. `submenu` opens a nested menu (a flyout on desktop, a sheet with Back on touch)
// instead of running `action`. `checked` makes it a radio (`radio: true`) or check item.
export interface ContextMenuItem {
  label: string
  subtitle?: string
  // Lets a long subtitle wrap instead of being cut off.
  wrap?: boolean
  danger?: boolean
  // Shown dimmed; it stays focusable for keyboard moves but does nothing.
  disabled?: boolean
  icon?: LucideIcon
  // A #rrggbb dot before the label.
  swatch?: string
  checked?: boolean
  radio?: boolean
  submenu?: ContextMenuItem[]
  action?: () => void
}

export interface ContextMenuOptions {
  header?: ReactNode
  // Names the control that opened the menu, so it can show the menu as open.
  owner?: string
}

export interface ContextMenuState extends ContextMenuOptions {
  x: number
  y: number
  items: ContextMenuItem[]
}

export interface ReactPicker {
  message: Message
  anchor: HTMLElement | null
}

export interface ConfirmRequest {
  bodyName?: string
  title: string
  body: string
  confirm: string
  // `reason`: what the moderator wrote in the optional Reason field (asked when `reason` is set).
  action: (choice: string, reason?: string) => void
  choices?: ConfirmChoice[]
  reason?: boolean
}

// The member a ban or timeout dialog is about, in the hosted server or P2P room that moderates
// them. `known`: what its opener already shows of them.
export interface ModerationTarget {
  place: import('./place/moderation').ModerationPlace
  who: string
  known?: UserRef
}

export interface AdminPlace {
  section: AdminSection | null
  item: string | null
  // The row to scroll to.
  row: string | null
}

export type ActiveDialog =
  | { kind: 'peer_code'; request: import('./client/peer_links').PeerLinkRequest }
  | import('./client/instance_links').InstanceLinkDialog
  | { kind: 'add_instance'; origin?: string; username?: string }
  | { kind: 'account_switcher'; manage?: boolean }
  | { kind: 'add_server'; join?: string; locked?: boolean; tab?: 'create' | 'join' }
  | { kind: 'app_preview'; server: string }
  | { kind: 'server_settings'; server: string; section?: ServerSettingsSection }
  | { kind: 'audit_log'; server: string }
  | { kind: 'perms'; server: string; channel?: number; category?: number }
  | { kind: 'webhooks'; server: string }
  | ({ kind: 'timeout' } & ModerationTarget)
  | { kind: 'server_profile'; server: string }
  | { kind: 'profile_reset'; server: string; user: UserRef }
  | ({ kind: 'ban' } & ModerationTarget)
  // The warning before a message's link opens another site; `label`: the link's own text.
  | { kind: 'external_link'; href: string; label: string | null }
  | { kind: 'ban_confirm'; username: string }
  | { kind: 'delete_user_confirm'; username: string }
  | { kind: 'remove_phrase_confirm'; username: string }
  | { kind: 'admin_create_account' }
  | { kind: 'new_password_confirm'; username: string }
  | { kind: 'sign_out_confirm'; username: string }
  | { kind: 'admin_add_to_server'; username: string }
  | {
      kind: 'settings'
      sso?: { type: 'link' | 'unlink'; p: { id: string; name: string } }
      focus?: SettingsFocus
      section?: SettingsAsk
    }
  | { kind: 'rename_folder'; id: string; focus?: 'color' }
  | { kind: 'category'; server: string; id?: number }
  // A new separator at the end of `category` (null: of the channels without one), or separator `id`.
  | { kind: 'separator'; server: string; id?: number; category?: number | null }
  | { kind: 'add_friends'; names: string[]; id: number }
  | { kind: 'poll_voters'; message: Message }
  // This account's scheduled messages, hosted and P2P; `focus`: a row to edit.
  | { kind: 'scheduled'; focus?: string }
  | { kind: 'seal_earlier'; place: string }

export type Panel =
  { kind: 'thread'; root: Message } | { kind: 'search' } | { kind: 'friends'; tab: FriendsTab }

// The message being edited inline: the list it was started from and the text so far.
export interface Editing {
  key: string
  id: number
  text: string
  focus?: number
  // The description of the message's image as edited; absent without an image.
  alt?: string
}

export interface Focus {
  id: number | null
  flash: boolean
}

export interface ProfileTarget {
  user: UserRef
  server: string | null
  x: number
  y: number
  instance?: string | null
  rev?: number
}

export type OutgoingStatus = 'queued' | 'sending' | 'failed'

export interface Outgoing {
  tempId: number
  key: string
  status: OutgoingStatus
  msg: Message
  pending: PendingUpload | null
  p2pExpiresIn: number | null
  send: (opts: SendOpts) => Promise<Message>
}

// A short neutral message at the top; `name` is shown after `text` with the streamer blur.
export interface Toast {
  peer?: { local: string; name: string | null; ik: string | null }
  id: number
  text: string
  name?: string
}

// The pinned-messages window of one scope; `list` is null until it loads.
export interface PinsView {
  key: string
  list: Message[] | null
  failed: boolean
}

export interface SearchState {
  // What the search box starts with when the panel opens, and which request set it (a new
  // "Search the server for ..." replaces the query even while the panel is open).
  seed?: string
  seedN?: number
  results: SearchResult[]
  hasMore: boolean
  loading: boolean
  cursor?: string | null
  // What the last page failed with; the page can be asked for again.
  failed?: unknown
}

export interface VoiceSession {
  server: string
  channelId: number
}

export interface CallSession {
  dmId: number
  dmUsers: string[]
  state: 'ringing' | 'active'
  from: string
  kind: CallKind
  video: boolean
  // Unix seconds when the call was answered, from the server (this tab's first sight of it on older servers).
  since: number | null
  // P2P calls: relay hosts each side declared.
  relays?: CallRelays[]
}

export interface Paged<T> {
  list: T[]
  hasMore: boolean
  loading: boolean
  q: string
  cursor?: string | null
}

export interface RChatState {
  signInChoices?: { mark: object; username: string; links: import('./types').LinkedProvider[] }
  token: Sealed | null
  me: Me | null
  guest: boolean
  guestPosting: Record<number, 'ready' | 'paused' | 'unavailable'>
  guestServers: string[]
  guestGrants: Record<string, Sealed>
  guestNames: Record<string, string>
  // The name this guest tab's connection has in voice rooms, from the server.
  guestVoiceName: string | null
  channelLabelEpoch: number
  channelLabelEpochs: Record<string, number>
  servers: Record<string, ServerDetail>
  members: Record<string, Paged<Member>>
  // The member list's groups (roles shown separately, and everyone else) of open servers.
  hoisted: import('./member_groups').GroupPages
  memberInfo: Record<string, Record<string, Member | null>>
  memberInfoTrim: Record<string, number>
  adminChanges: Record<string, number>
  interacted: Record<string, Paged<UserRef>>
  bans: Record<string, Paged<ServerBan>>
  adminUsers: Paged<UserRef>
  adminServers: Paged<ServerSummaryLite>
  // Usernames this account blocked (all of them, from GET /api/blocks/usernames).
  blocked: Blocked
  // The Settings > Privacy list: paged and searchable.
  blockList: Paged<BlockedUser>
  // Friends lists (by display name) and pending requests (newest first), lazy loaded.
  friends: Paged<Friend>
  onlineFriends: Paged<Friend>
  incomingRequests: Paged<FriendRequest>
  outgoingRequests: Paged<FriendRequest>
  friendCounts: { incoming: number; outgoing: number }
  // Settings > Privacy; null until loaded.
  privacy: Privacy | null
  // Message selection mode (one scope at a time), the anchor a plain click sets, the viewer's
  // running bulk delete jobs by scope, and what a selection action is busy with.
  selection: Selection | null
  selectAnchor: { scope: string; id: number } | null
  bulkJobs: Record<string, BulkJob>
  selectionBusy: string | null
  // This account's scheduled messages the instance sends.
  scheduled: HostedScheduled
  // The store's own loads that were refused, for the screens that show what they load.
  refusedLoads: RefusedLoads
  // The newest job over the stored messages of each place this person started, as its progress
  // arrives.
  sealJobs: Record<string, SealJob>
  dms: DmSummary[]
  dmsMore: boolean
  // While `dmsMore`, the list shows rows up to here (see `arrangeDms`).
  dmsEdge: DmEdge
  serversMore: boolean
  layout: Layout
  emoji: EmojiPrefs
  notifyPrefs: NotifyPrefs
  typingOn: boolean
  typing: TypingMap
  // Settings > Appearance > Animations and Motion.
  anim: AnimPrefs
  // Settings > Chat > Show spoilers.
  showSpoilers: ShowSpoilers
  // The personal profanity filter: on, loaded and masking, or failed to load.
  profanityOn: boolean
  profanityReady: boolean
  profanityFailed: boolean
  voice: VoiceSession | null
  call: CallSession | null
  callRoute: CallRoute
  // DMs where a P2P call could not connect because the other side can't do P2P, with the time (ms).
  p2pCallFailed: Record<number, number>
  voiceUsers: Record<number, string[]>
  // The server of each voice channel with people in it.
  voiceServers: Record<number, string>
  // users muted by a timeout in each voice channel
  voiceMuted: Record<number, string[]>
  // guests staff muted for everyone in each voice channel
  voiceHushed: Record<number, string[]>
  // what people in each voice channel say about their own mic and sound, when not the default
  voiceAudio: Record<number, Record<string, SeatAudio>>
  // running timeouts by server and username, as moderators see them
  timeouts: Record<string, Record<string, Timeout>>
  // the ends (unix seconds) of the server profile locks a moderator here has learned of, by
  // server and username
  profileLocks: Record<string, Record<string, number>>
  p2pAvailability: Record<string, P2pAvailability>
  rtcTick: number
  selfAudio: SelfAudio
  view: View | null
  // Home shows: no view is open and the address is the root
  home: boolean
  invite: OpenInvite | null
  configLink: string | null
  messages: Record<string, Message[]>
  older: Record<string, OlderState>
  newer: Record<string, OlderState>
  // Lists whose newest page is loading, unless what is cached is empty
  stale: Record<string, boolean>
  focus: Record<string, Focus>
  outbox: Record<string, Outgoing[]>
  slowUntil: Record<number, number>
  reads: Record<string, ReadMark>
  // the first /api/unreads answer arrived (Home shows skeletons until then)
  readsReady: boolean
  // the last /api/unreads answer was cut at its cap
  unreadsCut: boolean
  pings: Pings
  // unread messages that ping you through @everyone, @here or your roles, by channel scope
  groupPings: GroupPings
  unreadAnchor: Record<string, number>
  atBottom: Record<string, boolean>
  signedOut: boolean
  authExpired: boolean
  bootError: string | null
  wsStatus: WsStatus
  theme: Theme
  streamer: boolean
  // What this device draws for people: pictures, built-in avatars, or one kind for everyone.
  avatarMode: AvatarMode
  iceHelpers: boolean
  // This account's link safety choices on this device.
  linkPrefs: LinkPrefs
  iceRelay: boolean
  relayPrefs: RelayPrefs
  // The relay host the consent prompt asks about, or null.
  relayPrompt: string | null
  contextMenu: ContextMenuState | null
  reactPicker: ReactPicker | null
  profile: ProfileTarget | null
  activeDialog: ActiveDialog | null
  confirm: ConfirmRequest | null
  confirmSeq: number
  panel: Panel | null
  // The notifications inbox (popover on desktop, sheet on mobile).
  inboxOpen: boolean
  pending: Record<string, PendingUpload>
  notices: Notice[]
  noticesPaused: boolean
  drafts: Record<string, string>
  replying: Record<string, Replying>
  forwardClip: ForwardClip | null
  // "Show where it's from" for the clip in one draft (`key`), else its default. Never stored.
  forwardShowSource: { key: string; on: boolean } | null
  // Message link cards by message id; null when the viewer can't read the message.
  linkCards: Record<number, MessageLocation | null>
  toast: Toast | null
  pins: PinsView | null
  // The Threads list of a channel or DM (its key), while it is open.
  threads: string | null
  composerFocus: { key: string; n: number } | null
  editing: Editing | null
  search: SearchState
  error: string | null
  // The channel the site admin is asked to confirm before it opens; null without a question.
  staffAsk: number | null
  // The channel view a site admin has not opened as staff (not confirmed, cancelled, or its
  // confirmation ran out): it shows a button to confirm instead of its messages.
  staffShut: View | null
  // The channels the site admin opened as staff, while they are open.
  staffOpen: number[]
  adminOverview: AdminOverview | null
  // The open place of the site administration page; null while it is closed. Only the site
  // admin's session ever sets it.
  adminPage: AdminPlace | null
  settings: SiteSettings
  // The brand the account's instance sets; null until it is read, and on an instance without
  // one.
  brand: Brand | null
  instance: InstanceInfo | null
  instanceHost: string
  loadInstance: (current?: () => boolean, cache?: RequestCache) => Promise<boolean | null>
  switchInstance: (address: string) => Promise<string | null>
  bootstrap: (restorePage?: boolean) => Promise<void>
  // `background`: the app polls on its own (see `BACKGROUND` in api.ts).
  loadSettings: (background?: boolean, current?: () => boolean) => Promise<void>
  loadBrand: () => Promise<void>
  setBrand: (raw: unknown) => void
  setTheme: (theme: Theme) => void
  setStreamer: (streamer: boolean) => void
  setAvatarMode: (mode: AvatarMode) => void
  setIceHelpers: (on: boolean) => void
  setLinkPrefs: (prefs: LinkPrefs) => void
  trustLinkSite: (site: Site) => void
  setIceRelay: (on: boolean) => void
  saveRelays: (next: RelayPrefs) => void
  answerRelayPrompt: (decision: Decision) => void
  patchMe: (
    avatar_kind: AvatarKind,
    avatar_color?: string,
    banner_color?: string | null
  ) => Promise<void>
  setAppearOffline: (appearOffline: boolean) => Promise<void>
  // Sets or removes the account's uploaded picture; the text of what went wrong, or null.
  uploadAvatar: (file: Blob, crop: AvatarCrop | null) => Promise<string | null>
  removeAvatar: () => Promise<string | null>
  setBio: (bio: string) => Promise<string | null>
  setDisplayName: (name: string) => Promise<string | null>
  changePassword: (
    current: Secret | undefined,
    next: Secret,
    kind: PassKind,
    reauth?: import('./types').ReAuthBody
  ) => Promise<string | null>
  expireSession: () => void
  // Asks the instance to delete the account, optionally removes its P2P identities from this
  // device, and ends the session here.
  deleteAccount: (reauth: import('./types').ReAuthBody, removeP2p: boolean) => Promise<void>
  // Calls off a deletion that waits.
  keepAccount: () => Promise<void>
  checkSession: () => Promise<void>
  refreshAccount: () => Promise<void>
  syncFromUrl: (nav: 'replace' | 'none') => Promise<void>
  // Opens the site administration page at a section, one of its accounts or servers, or a row.
  openAdmin: (section?: AdminSection | null, item?: string | null, row?: string | null) => void
  // Goes back to where the page was opened from, or home.
  closeAdmin: () => void
  register: (body: RegisterRequest) => Promise<SignupFailure | null>
  providerConfirmation?: {
    proof: import('./types').ProviderConfirmation
    mark: object
    token: string
    username: string
    foreground: number
  }
  enterSsoSession: (
    res: Extract<ExchangeResponse, { kind: 'session' }>,
    current: () => boolean
  ) => Promise<void>
  ssoExchange: (body: ExchangeRequest, current: () => boolean) => Promise<ExchangeResponse>
  login: (body: LoginRequest) => Promise<void>
  logout: () => void
  enterGuest: () => Promise<void>
  guestJoinServer: (name: string, password?: string, nav?: Nav) => Promise<void>
  openServer: (name: string, channelId?: number, nav?: Nav, at?: number) => Promise<void>
  openChannel: (
    server: string,
    channelId: number,
    nav?: Nav,
    at?: number,
    intent?: number,
    current?: () => boolean
  ) => Promise<void>
  openDm: (dmId: number, nav?: Nav, at?: number) => Promise<void>
  openLastDm: () => void
  goHome: () => void
  openInvite: (
    server: string,
    password?: string | null,
    code?: string | null,
    requested?: string
  ) => void
  closeInvite: () => void
  syncInvite: () => boolean
  syncConfigLink: () => boolean
  closeConfigLink: () => void
  applyConfig: (
    doc: ConfigDoc,
    keys: SectionKey[],
    identity?: P2pApp | null
  ) => Promise<string | null>
  showToast: (text: string, name?: string, peer?: Toast['peer']) => void
  consumeInviteJoin: () => void
  startDm: (username: string, nav?: Nav) => Promise<void>
  messageUser: (username: string, content: string) => Promise<void>
  loadMoreDms: () => Promise<void>
  loadMoreServers: () => Promise<void>
  ensureDms: (ids: number[]) => Promise<void>
  discoverChannels: (server: string, refresh?: boolean) => Promise<void>
  ensureServers: (names: string[]) => Promise<void>
  moveServer: (name: string, index: number) => void
  moveFolder: (id: string, index: number) => void
  moveIntoFolder: (name: string, id: string, index: number) => void
  addToFolder: (name: string, id: string) => void
  mergeServers: (name: string, target: string) => void
  toggleFolder: (id: string) => void
  renameFolder: (id: string, name: string) => void
  setFolderColor: (id: string, color: string | null) => void
  ungroupFolder: (id: string) => void
  // `shown`: the rows as the list shows them (sorted, filtered or held).
  placeDm: (id: number, zone: DmZone, index: number, shown?: DmSections<number>) => void
  setDmList: (patch: Partial<DmListPrefs>) => void
  pinDm: (id: number) => void
  unpinDm: (id: number) => void
  closeDm: (id: number) => Promise<void>
  loadBlockList: (q: string, reset?: boolean) => Promise<void>
  // Resolves to an error text, or null once blocked.
  blockUser: (username: string) => Promise<string | null>
  // `name` (a display name) shows an "Unblocked" toast.
  unblockUser: (username: string, name?: string) => Promise<void>
  // A short confirm, then `blockUser` and a toast.
  askBlock: (user: UserRef) => void
  openFriends: (tab?: FriendsTab) => void
  setFriendsTab: (tab: FriendsTab) => void
  loadFriends: (q: string, reset?: boolean) => Promise<void>
  loadOnlineFriends: (q: string, reset?: boolean) => Promise<void>
  loadFriendRequests: (incoming: boolean, reset?: boolean) => Promise<void>
  loadFriendSummary: () => Promise<void>
  sendFriendRequest: (username: string) => Promise<SendResult>
  sendFriendRequests: (names: string[]) => Promise<Record<string, SendResult>>
  // Opens the confirm with mini profile previews of `names`.
  askAddFriends: (names: string[]) => void
  acceptFriend: (user: UserRef) => Promise<void>
  denyFriend: (username: string) => Promise<void>
  cancelFriendRequest: (username: string) => Promise<void>
  removeFriend: (user: UserRef) => Promise<void>
  askRemoveFriend: (user: UserRef) => void
  loadPrivacy: () => Promise<void>
  setPrivacy: (patch: Partial<Privacy>) => Promise<void>
  observeFriendsPanel: () => () => void
  markFriendsSeen: () => void
  // Sends the seen mark of friend requests again after it failed.
  resendFriendsSeen: () => void
  // Posts a poll; the error text, or null once it is sent.
  createPoll: (target: PollTarget, req: PollReq) => Promise<string | null>
  votePoll: (id: number, body: { options?: number[]; value?: number }) => Promise<void>
  retractVote: (id: number) => Promise<void>
  // The error text, or null once the option is added.
  addPollOption: (id: number, text: string, emoji: string | null) => Promise<string | null>
  closePoll: (id: number) => Promise<void>
  reopenPoll: (id: number) => Promise<void>
  startSelection: (scope: string, m?: Message) => void
  exitSelection: () => void
  setSelectAnchor: (scope: string, id: number) => void
  toggleSelect: (scope: string, m: Message) => void
  selectRangeTo: (scope: string, m: Message) => void
  // A tap on mobile: toggles, or ends a range while the range helper is on.
  tapSelect: (scope: string, m: Message) => void
  toggleSelectRange: () => void
  selectAllMessages: () => void
  selectAuthorMessages: (username: string) => void
  clearSelection: () => void
  askDeleteSelection: () => void
  pinSelection: (pin: boolean) => Promise<void>
  copySelectionText: () => void
  copySelectionLinks: () => void
  forwardSelection: () => void
  exportSelection: (format: 'text' | 'json') => Promise<void>
  cancelBulkJob: (scope: string) => Promise<void>
  loadBulkJobs: () => Promise<void>
  loadScheduled: (scope?: string, more?: boolean) => Promise<void>
  loadScheduledCounts: () => Promise<void>
  // Each answers null, or why it was refused.
  scheduleDraft: (
    key: string,
    at: number,
    shape?: (text: string) => string
  ) => Promise<string | null>
  editScheduled: (key: string, content: string) => Promise<string | null>
  removeScheduledReply: (key: string) => Promise<string | null>
  rescheduleScheduled: (key: string, at: number) => Promise<string | null>
  sendScheduledNow: (key: string) => Promise<string | null>
  deleteScheduled: (key: string) => Promise<string | null>
  reloadLayout: () => void
  noteEmoji: (base: string, picked: string) => void
  setSkinTone: (tone: number) => void
  reloadEmoji: () => void
  setDraft: (key: string, text: string) => void
  startReply: (key: string, m: Message) => void
  cancelReply: (key: string) => void
  toggleReplyMention: (key: string) => void
  copyForward: (m: Message) => void
  // A message from somewhere else (a P2P conversation) on the forward clipboard.
  copyForwardClip: (clip: ForwardClip) => void
  // A toast and desktop notification raised outside the store (P2P conversations).
  alertFrom: (alert: AlertInput) => void
  clearForward: () => void
  setForwardShowSource: (key: string, on: boolean) => void
  openPins: () => void
  closePins: () => void
  openThreads: () => void
  closeThreads: () => void
  pinMessage: (id: number) => Promise<void>
  openPinned: (key: string, id: number) => Promise<void>
  unpinMessage: (id: number) => Promise<void>
  reloadForward: () => void
  setNotifyLevel: (scope: NotifyScope, level: Level | null) => void
  // "Suppress @everyone and @here" / "Suppress role mentions" for a server
  setNotifySuppress: (server: string, which: Suppress, on: boolean) => void
  muteScope: (scope: NotifyScope, until: MuteUntil | null) => void
  muteServers: (names: string[], until: MuteUntil | null) => void
  resetNotify: (scope: NotifyScope) => void
  resetAllNotify: () => void
  setDesktopNotify: (on: boolean) => void
  reloadNotify: () => void
  pruneNotify: () => void
  setTypingOn: (on: boolean) => void
  setProfanityOn: (on: boolean) => void
  setShowSpoilers: (show: ShowSpoilers) => void
  reloadTyping: () => void
  setAnim: (prefs: AnimPrefs) => void
  reloadAnim: () => void
  noteTyping: (scope: string, active: boolean) => void
  // `showSource`: whether the copy names where the original is; omitted, the server decides.
  sendForward: (key: string, showSource?: boolean) => void
  openForward: (m: Message) => Promise<void>
  openMessage: (id: number, nav?: Nav, place?: View, thread?: number | null) => Promise<void>
  resolveLinkCard: (id: number, place?: View) => void
  startEdit: (key: string, m: Message) => void
  setEditText: (text: string) => void
  cancelEdit: (refocus?: boolean) => void
  saveEdit: (refocus?: boolean) => void
  editLast: (key: string) => boolean
  sedEdit: (key: string, sed: Sed) => Promise<boolean>
  sendMessage: (content: string, p2pExpiresIn?: number | null, p2pRelay?: RelayChoice) => void
  markRead: (scope: string, messageId: number) => void
  // Sends the read marks that are waiting after a failure, now.
  resendReadMarks: () => void
  // "Mark as read": clears unread dots and pings of the given channel, DM or thread keys (and the
  // threads with pings under a channel) here and, through POST /api/read/batch, on every device.
  markScopesRead: (scopes: string[]) => Promise<void>
  markServerRead: (name: string) => Promise<void>
  markServersRead: (names: string[]) => Promise<void>
  markDmsRead: () => Promise<void>
  // Every server channel and DM, muted ones included.
  markAllRead: () => Promise<void>
  // Asks first (a short confirm), then `markAllRead` and `extra`. Does nothing when everything
  // is read.
  askMarkAllRead: (extra?: MarkAllExtra) => void
  seeThread: (rootId: number) => void
  setAtBottom: (key: string, v: boolean) => void
  retryOutgoing: (key: string, tempId: number) => void
  cancelOutgoing: (key: string, tempId: number) => void
  loadOlder: () => Promise<void>
  loadNewer: () => Promise<void>
  jumpTo: (key: string, id: number, flash?: boolean) => Promise<void>
  jumpToUnread: () => Promise<void>
  jumpToPresent: (key: string) => Promise<void>
  confirmStaffView: (reauth: import('./types').ReAuthBody, reason: string) => Promise<void>
  closeStaffAsk: () => void
  // Asks the site admin to confirm opening `channel`.
  askStaffView: (channel: number) => void
  dismissUnread: (key: string) => void
  clearFocus: (key: string) => void
  openResult: (result: SearchResult) => Promise<void>
  openPing: (ping: Ping, switching?: boolean) => Promise<void>
  uploadFile: (key: string, file: File | null) => void
  toggleSpoiler: (key: string) => void
  setUploadAlt: (key: string, alt: string) => void
  setEditAlt: (alt: string) => void
  toggleUploadMode: (key: string) => void
  openThread: (root: Message, at?: number) => Promise<void>
  // `q` fills the search box (from the palette).
  openSearch: (q?: string) => void
  closePanel: () => void
  setInboxOpen: (open: boolean) => void
  loadOlderThread: () => Promise<void>
  loadNewerThread: () => Promise<void>
  sendThreadMessage: (content: string, p2pExpiresIn?: number | null, p2pRelay?: RelayChoice) => void
  searchRun: (args: SearchArgs, reset: boolean) => Promise<void>
  dismissNotice: (id: number) => void
  pauseNotices: (paused: boolean) => void
  deleteMessage: (id: number) => Promise<void>
  deleteMedia: (messageId: number) => Promise<void>
  deleteEmbed: (messageId: number, ord: number, banner: boolean) => Promise<void>
  createServer: (name: string, password?: string) => Promise<void>
  joinServer: (name: string, password?: string, nav?: Nav) => Promise<void>
  joinPreview: (name: string) => Promise<void>
  leaveServer: (name: string) => Promise<void>
  renameServer: (name: string, newName: string) => Promise<void>
  deleteServer: (name: string) => Promise<void>
  createChannel: (
    server: string,
    name: string,
    kind?: ChannelKind,
    category?: number | null,
    textOnly?: boolean
  ) => Promise<void>
  createCategory: (server: string, name: string) => Promise<void>
  renameCategory: (id: number, name: string, style?: CategoryStyle) => Promise<void>
  deleteCategory: (id: number) => Promise<void>
  createSeparator: (
    server: string,
    label: string,
    style: SeparatorStyle,
    category: number | null
  ) => Promise<void>
  editSeparator: (id: number, patch: { label?: string; style?: SeparatorStyle }) => Promise<void>
  deleteSeparator: (id: number) => Promise<void>
  // Moves a channel or a separator to `index` among the rows of `category` (null: none).
  moveChannel: (server: string, id: number, category: number | null, index: number) => void
  moveSeparator: (server: string, id: number, category: number | null, index: number) => void
  moveCategory: (server: string, id: number, index: number) => void
  setCategoriesCollapsed: (server: string, ids: number[], collapsed: boolean) => void
  renameChannel: (id: number, name: string) => Promise<void>
  setChannelTextOnly: (server: string, id: number, enabled: boolean) => Promise<void>
  setChannelSensitive: (server: string, id: number, sensitive: boolean) => Promise<void>
  setSlowmode: (id: number, seconds: number) => Promise<void>
  setChannelTopic: (server: string, id: number, topic: string) => Promise<string | null>
  setChannelRestrict: (
    id: number,
    patch: { restrict_view?: boolean; restrict_send?: boolean }
  ) => Promise<void>
  deleteChannel: (id: number) => Promise<void>
  kickMember: (server: string, username: string, reason?: string) => Promise<void>
  banMember: (
    server: string,
    username: string,
    choice?: import('./durations').BanChoice
  ) => Promise<boolean>
  timeoutMember: (
    server: string,
    username: string,
    seconds: number,
    reason: string
  ) => Promise<boolean>
  removeTimeout: (server: string, username: string) => Promise<void>
  // Your own server profile. Loading answers it (null when it can't be read); saving and
  // clearing answer the error text, or null when they worked.
  loadMyProfile: (server: string) => Promise<ServerProfile | null>
  saveMyProfile: (server: string, patch: ServerProfilePatch) => Promise<string | null>
  clearMyProfile: (server: string) => Promise<string | null>
  setMyProfilePicture: (
    server: string,
    file: Blob,
    crop: AvatarCrop | null
  ) => Promise<string | null>
  removeMyProfilePicture: (server: string) => Promise<string | null>
  resetMemberProfile: (
    server: string,
    username: string,
    fields: readonly ResetField[],
    secs: LockSecs,
    reason: string
  ) => Promise<string | null>
  unlockMemberProfile: (server: string, username: string) => Promise<void>
  noteProfileLock: (server: string, username: string, until: number | null | undefined) => void
  disconnectGuest: (server: string, name: string) => Promise<void>
  muteGuest: (server: string, name: string, muted: boolean) => Promise<void>
  unbanMember: (server: string, username: string) => Promise<void>
  loadBans: (server: string, reset?: boolean) => Promise<void>
  grantAdmin: (server: string, username: string) => Promise<void>
  revokeAdmin: (server: string, username: string) => Promise<void>
  transferAdmin: (server: string, username: string) => Promise<void>
  setAdminPerms: (server: string, username: string, perms: number) => Promise<void>
  createRole: (
    server: string,
    body: { name: string; color: string; perms: number }
  ) => Promise<void>
  updateRole: (server: string, id: number, patch: import('./api').RolePatch) => Promise<void>
  deleteRole: (server: string, id: number) => Promise<void>
  setRoleOrder: (server: string, order: number[], version: number) => Promise<void>
  // `order`: every role id, the one shown highest first; null shows roles in role order.
  setRoleDisplay: (server: string, order: number[] | null, version: number) => Promise<void>
  // Changes only the bits of `mask` that everyone holds.
  setEveryonePerms: (server: string, perms: number, mask: number) => Promise<void>
  confirmRoleOrder: (server: string, version: number) => Promise<void>
  assignRole: (server: string, id: number, username: string) => Promise<void>
  unassignRole: (server: string, id: number, username: string) => Promise<void>
  setChannelPerm: (id: number, perm: ChannelPermInput) => Promise<void>
  clearChannelPerm: (id: number, subject: string) => Promise<void>
  setCategoryPerm: (
    id: number,
    rule: { subject: string; allow: number; deny: number }
  ) => Promise<void>
  clearCategoryPerm: (id: number, subject: string) => Promise<void>
  // Copies the category's rules to the channel, asking first when that lets more people in.
  syncChannelPerms: (server: string, id: number) => Promise<void>
  adminDeleteUser: (username: string) => Promise<void>
  adminRemovePhrase: (username: string) => Promise<void>
  adminSignOut: (username: string) => Promise<void>
  adminDeleteMessage: (id: number) => Promise<void>
  loadMembers: (server: string, reset?: boolean) => Promise<void>
  // A page of one group of the member list; `limit` rows (50 by default).
  loadGroup: (
    server: string,
    group: import('./api').MemberGroup,
    reset?: boolean,
    limit?: number
  ) => Promise<void>
  // Forgets the loaded groups of the member list, so they load again.
  clearGroups: (server: string) => void
  // The channel the member list of `server` loads for, where only that channel shows it to us
  // (null: anywhere in the server).
  scopeMembers: (server: string, channel: number | null) => void
  loadInteracted: (server: string, reset?: boolean) => Promise<void>
  ensureMembers: (server: string, usernames: string[]) => Promise<void>
  // Asks again for the member rows of `server` that did not load.
  retryMemberRows: (server: string) => void
  loadMissingOnline: (server: string) => Promise<void>
  rememberMember: (server: string, username: string, member: Member | null) => void
  notePresence: (server: string, username: string, online: boolean) => void
  refreshMember: (server: string, username: string) => Promise<void>
  joinVoice: (server: string, channelId: number) => Promise<void>
  leaveVoice: () => void
  toggleMute: () => void
  toggleDeafen: () => void
  // Applies the mic, camera and share limits of the call you are in again, after a timeout
  // there started or ended.
  applyMic: () => void
  toggleCamera: () => Promise<void>
  toggleShare: () => Promise<void>
  canStartCall: (dmId: number) => boolean
  startCall: (dmId: number, video: boolean) => Promise<void>
  startP2pCall: (dmId: number, video: boolean, relay?: RelayChoice) => Promise<void>
  setCallRoute: (route: CallRoute) => void
  acceptCall: () => Promise<void>
  declineCall: () => void
  hangupCall: () => void
  loadAdminOverview: () => Promise<void>
  loadAdminUsers: (q: string, reset?: boolean) => Promise<void>
  loadAdminServers: (q: string, reset?: boolean) => Promise<void>
  adminDeleteServer: (name: string) => Promise<void>
  banUser: (username: string) => Promise<void>
  updateSettings: (patch: SiteSettingsPatch) => Promise<void>
  setViewing: (server: string | null) => void
  applyWsEvent: (ev: WsEvent) => void
  openContextMenu: (
    x: number,
    y: number,
    items: ContextMenuItem[],
    opts?: ContextMenuOptions
  ) => void
  closeContextMenu: () => void
  toggleReaction: (m: Message, emoji: string, note?: boolean) => void
  loadReactors: (messageId: number, emoji: string) => Promise<UserRef[]>
  openReactPicker: (m: Message, anchor: HTMLElement | null) => void
  closeReactPicker: () => void
  openProfile: (user: UserRef, server: string | null, x: number, y: number) => void
  closeProfile: () => void
  openDialog: (dialog: ActiveDialog) => void
  closeDialog: () => void
  askConfirm: (req: ConfirmRequest) => void
  closeConfirm: () => void
  setError: (message: string | null) => void
}
