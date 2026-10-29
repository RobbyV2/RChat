// State and UI types of the store; store.ts re-exports them.

import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { LoginRequest, RegisterRequest, SendOpts } from './api'
import type { PendingUpload } from './attachments'
import type { CallRoute } from './call_choice'
import type { ConfigDoc, SectionKey } from './config_transfer'
import type { EmojiPrefs } from './emoji'
import type { ForwardClip } from './forward'
import type { OpenInvite } from './invite'
import type { OlderState, ReadMark } from './lists'
import type { DmZone, Layout } from './nav_layout'
import type { Notice } from './notices'
import type { Level, MuteUntil, NotifyPrefs, NotifyScope } from './notify'
import type { PassKind, Secret } from './password'
import type { Pings } from './pings'
import type { Replying } from './replies'
import type { SearchArgs } from './search'
import type { Sed } from './sed'
import type {
  AdminOverview,
  AvatarKind,
  CallKind,
  ChannelKind,
  ChannelPerm,
  ConfirmChoice,
  DmSummary,
  InstanceInfo,
  Me,
  Member,
  Message,
  P2pAvailability,
  Ping,
  SearchResult,
  ServerBan,
  ServerDetail,
  ServerSummaryLite,
  SiteSettings,
  SiteSettingsPatch,
  Theme,
  UserRef,
  WsEvent,
  WsStatus,
} from './types'
import type { View, Nav } from './view'
import type { SelfAudio } from './voice_layout'

// A menu row. `submenu` opens a nested menu (a flyout on desktop, a sheet with Back on touch)
// instead of running `action`. `checked` makes it a radio (`radio: true`) or check item.
export interface ContextMenuItem {
  label: string
  subtitle?: string
  // Lets a long subtitle wrap instead of being cut off.
  wrap?: boolean
  danger?: boolean
  icon?: LucideIcon
  checked?: boolean
  radio?: boolean
  submenu?: ContextMenuItem[]
  action?: () => void
}

export interface ContextMenuOptions {
  header?: ReactNode
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
  title: string
  body: string
  confirm: string
  action: (choice: string) => void
  choices?: ConfirmChoice[]
}

export type ActiveDialog =
  | { kind: 'add_server'; join?: string; locked?: boolean }
  | { kind: 'server_settings'; server: string }
  | { kind: 'admin_panel' }
  | { kind: 'ban_confirm'; username: string }
  | { kind: 'delete_user_confirm'; username: string }
  | { kind: 'settings'; focus?: 'bio' }
  | { kind: 'rename_folder'; id: string }

export type Panel = { kind: 'thread'; root: Message } | { kind: 'search' }

// The message being edited inline: the list it was started from and the text so far.
export interface Editing {
  key: string
  id: number
  text: string
  focus?: number
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
  results: SearchResult[]
  hasMore: boolean
  loading: boolean
  cursor?: string | null
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
}

export interface Paged<T> {
  list: T[]
  hasMore: boolean
  loading: boolean
  q: string
  cursor?: string | null
}

export interface RChatState {
  token: string | null
  me: Me | null
  guest: boolean
  guestServers: string[]
  guestGrants: Record<string, string>
  guestNames: Record<string, string>
  servers: Record<string, ServerDetail>
  members: Record<string, Paged<Member>>
  memberInfo: Record<string, Record<string, Member | null>>
  memberInfoTrim: Record<string, number>
  adminChanges: Record<string, number>
  interacted: Record<string, Paged<UserRef>>
  bans: Record<string, Paged<ServerBan>>
  adminUsers: Paged<UserRef>
  adminServers: Paged<ServerSummaryLite>
  dms: DmSummary[]
  dmsMore: boolean
  serversMore: boolean
  layout: Layout
  emoji: EmojiPrefs
  notifyPrefs: NotifyPrefs
  voice: VoiceSession | null
  call: CallSession | null
  callRoute: CallRoute
  // DMs where a P2P call could not connect because the other side can't do P2P, with the time (ms).
  p2pCallFailed: Record<number, number>
  voiceUsers: Record<number, string[]>
  p2pAvailability: Record<string, P2pAvailability>
  rtcTick: number
  selfAudio: SelfAudio
  view: View | null
  invite: OpenInvite | null
  configLink: string | null
  messages: Record<string, Message[]>
  older: Record<string, OlderState>
  newer: Record<string, OlderState>
  stale: Record<string, boolean>
  focus: Record<string, Focus>
  outbox: Record<string, Outgoing[]>
  slowUntil: Record<number, number>
  reads: Record<string, ReadMark>
  pings: Pings
  unreadAnchor: Record<string, number>
  atBottom: Record<string, boolean>
  authExpired: boolean
  bootError: string | null
  wsStatus: WsStatus
  theme: Theme
  streamer: boolean
  iceHelpers: boolean
  iceRelay: boolean
  contextMenu: ContextMenuState | null
  reactPicker: ReactPicker | null
  profile: ProfileTarget | null
  activeDialog: ActiveDialog | null
  confirm: ConfirmRequest | null
  confirmSeq: number
  panel: Panel | null
  pending: Record<string, PendingUpload>
  notices: Notice[]
  noticesPaused: boolean
  drafts: Record<string, string>
  replying: Record<string, Replying>
  forwardClip: ForwardClip | null
  toast: Toast | null
  pins: PinsView | null
  composerFocus: { key: string; n: number } | null
  editing: Editing | null
  search: SearchState
  error: string | null
  adminOverview: AdminOverview | null
  settings: SiteSettings
  instance: InstanceInfo | null
  instanceHost: string
  loadInstance: () => Promise<boolean>
  switchInstance: (address: string) => Promise<string | null>
  bootstrap: () => Promise<void>
  loadSettings: () => Promise<void>
  setTheme: (theme: Theme) => void
  setStreamer: (streamer: boolean) => void
  setIceHelpers: (on: boolean) => void
  setIceRelay: (on: boolean) => void
  patchMe: (
    avatar_kind: AvatarKind,
    avatar_color?: string,
    banner_color?: string | null
  ) => Promise<void>
  setAppearOffline: (appearOffline: boolean) => Promise<void>
  setBio: (bio: string) => Promise<string | null>
  changePassword: (current: Secret, next: Secret, kind: PassKind) => Promise<string | null>
  refreshAccount: () => Promise<void>
  syncFromUrl: (nav: 'replace' | 'none') => Promise<void>
  register: (body: RegisterRequest) => Promise<void>
  login: (body: LoginRequest) => Promise<void>
  logout: () => void
  enterGuest: () => Promise<void>
  guestJoinServer: (name: string, password?: string, nav?: Nav) => Promise<void>
  openServer: (name: string, channelId?: number, nav?: Nav, at?: number) => Promise<void>
  openChannel: (server: string, channelId: number, nav?: Nav, at?: number) => Promise<void>
  openDm: (dmId: number, nav?: Nav, at?: number) => Promise<void>
  openLastDm: () => void
  openInvite: (server: string, password?: string | null) => void
  closeInvite: () => void
  syncInvite: () => boolean
  syncConfigLink: () => boolean
  closeConfigLink: () => void
  applyConfig: (doc: ConfigDoc, keys: SectionKey[]) => Promise<string | null>
  showToast: (text: string) => void
  consumeInviteJoin: () => void
  startDm: (username: string) => Promise<void>
  messageUser: (username: string, content: string) => Promise<void>
  loadMoreDms: () => Promise<void>
  loadMoreServers: () => Promise<void>
  ensureDms: (ids: number[]) => Promise<void>
  ensureServers: (names: string[]) => Promise<void>
  moveServer: (name: string, index: number) => void
  moveFolder: (id: string, index: number) => void
  moveIntoFolder: (name: string, id: string, index: number) => void
  addToFolder: (name: string, id: string) => void
  mergeServers: (name: string, target: string) => void
  toggleFolder: (id: string) => void
  renameFolder: (id: string, name: string) => void
  ungroupFolder: (id: string) => void
  placeDm: (id: number, zone: DmZone, index: number) => void
  pinDm: (id: number) => void
  unpinDm: (id: number) => void
  reloadLayout: () => void
  noteEmoji: (base: string, picked: string) => void
  setSkinTone: (tone: number) => void
  reloadEmoji: () => void
  setDraft: (key: string, text: string) => void
  startReply: (key: string, m: Message) => void
  cancelReply: (key: string) => void
  toggleReplyMention: (key: string) => void
  copyForward: (m: Message) => void
  clearForward: () => void
  openPins: () => void
  closePins: () => void
  pinMessage: (id: number) => Promise<void>
  openPinned: (key: string, id: number) => Promise<void>
  unpinMessage: (id: number) => Promise<void>
  reloadForward: () => void
  setNotifyLevel: (scope: NotifyScope, level: Level | null) => void
  muteScope: (scope: NotifyScope, until: MuteUntil | null) => void
  muteServers: (names: string[], until: MuteUntil | null) => void
  resetNotify: (scope: NotifyScope) => void
  resetAllNotify: () => void
  setDesktopNotify: (on: boolean) => void
  reloadNotify: () => void
  pruneNotify: () => void
  sendForward: (key: string) => void
  openForward: (m: Message) => Promise<void>
  startEdit: (key: string, m: Message) => void
  setEditText: (text: string) => void
  cancelEdit: (refocus?: boolean) => void
  saveEdit: (refocus?: boolean) => void
  editLast: (key: string) => boolean
  sedEdit: (key: string, sed: Sed) => Promise<boolean>
  sendMessage: (content: string, p2pExpiresIn?: number | null) => void
  markRead: (scope: string, messageId: number) => void
  seeThread: (rootId: number) => void
  setAtBottom: (key: string, v: boolean) => void
  retryOutgoing: (key: string, tempId: number) => void
  cancelOutgoing: (key: string, tempId: number) => void
  loadOlder: () => Promise<void>
  loadNewer: () => Promise<void>
  jumpTo: (key: string, id: number, flash?: boolean) => Promise<void>
  jumpToUnread: () => Promise<void>
  jumpToPresent: (key: string) => Promise<void>
  dismissUnread: (key: string) => void
  clearFocus: (key: string) => void
  openResult: (result: SearchResult) => Promise<void>
  openPing: (ping: Ping) => Promise<void>
  uploadFile: (key: string, file: File | null) => void
  toggleSpoiler: (key: string) => void
  toggleUploadMode: (key: string) => void
  openThread: (root: Message, at?: number) => Promise<void>
  openSearch: () => void
  closePanel: () => void
  loadOlderThread: () => Promise<void>
  loadNewerThread: () => Promise<void>
  sendThreadMessage: (content: string, p2pExpiresIn?: number | null) => void
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
  createChannel: (server: string, name: string, kind?: ChannelKind) => Promise<void>
  renameChannel: (id: number, name: string) => Promise<void>
  setSlowmode: (id: number, seconds: number) => Promise<void>
  setChannelRestrict: (
    id: number,
    patch: { restrict_view?: boolean; restrict_send?: boolean }
  ) => Promise<void>
  deleteChannel: (id: number) => Promise<void>
  kickMember: (server: string, username: string) => Promise<void>
  banMember: (server: string, username: string) => Promise<void>
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
  updateRole: (
    server: string,
    id: number,
    patch: { name?: string; color?: string; perms?: number }
  ) => Promise<void>
  deleteRole: (server: string, id: number) => Promise<void>
  assignRole: (server: string, id: number, username: string) => Promise<void>
  unassignRole: (server: string, id: number, username: string) => Promise<void>
  setChannelPerm: (id: number, perm: ChannelPerm) => Promise<void>
  clearChannelPerm: (id: number, subject: string) => Promise<void>
  adminDeleteUser: (username: string) => Promise<void>
  adminDeleteMessage: (id: number) => Promise<void>
  loadMembers: (server: string, reset?: boolean) => Promise<void>
  loadInteracted: (server: string, reset?: boolean) => Promise<void>
  ensureMembers: (server: string, usernames: string[]) => Promise<void>
  rememberMember: (server: string, username: string, member: Member | null) => void
  notePresence: (server: string, username: string, online: boolean) => void
  refreshMember: (server: string, username: string) => Promise<void>
  joinVoice: (server: string, channelId: number) => Promise<void>
  leaveVoice: () => void
  toggleMute: () => void
  toggleDeafen: () => void
  toggleCamera: () => Promise<void>
  toggleShare: () => Promise<void>
  startCall: (dmId: number, video: boolean) => Promise<void>
  startP2pCall: (dmId: number, video: boolean) => Promise<void>
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
