import { create } from 'zustand'
import { home, writeLocal } from '../../instances'
import { emptyLayout, type Layout } from '../../nav_layout'
import type { AlertInput } from '../../notices'
import { EMPTY_NOTIFY, type NotifyPrefs } from '../../notify'
import type { OwnBadge, P2pStore } from '../db'
import type { BadgeKeeper, Badges, BadgeSlot } from '../badge'
import type { Contact } from '../contacts'
import type { AutoPause, Dms, MissedCall, P2pMessage } from '../dm'
import type { PingLog } from '../ping_log'
import type { BlobView, Usage } from '../blobs'
import type { Hashed } from '../hashing'
import { LOCAL, type Local } from '../limits'
import { instanceLocal, withChoice } from '../user_limits'
import type { Preview } from '../files'
import type { TabLeader } from '../leader'
import type { P2pNode, Presence, Status } from '../node'
import type { Calls, CallView } from '../calls'
import type { SearchHit, ServerView, Servers } from '../server'

// The P2P view model. IndexedDB (through the node) is the source of truth; this store only
// mirrors what the UI shows. One node per signed-in account; guests never get one.

export type P2pDialog =
  | { kind: 'add'; tab?: 'scan' | 'paste' | 'mine' }
  | { kind: 'verify'; ik: string }
  | { kind: 'rename'; ik: string }
  | { kind: 'contact'; ik: string }
  | { kind: 'enable' }
  | { kind: 'server_new'; tab?: 'create' | 'join'; code?: string }
  | { kind: 'server_invite'; room: string }
  | { kind: 'server_settings'; room: string; tab?: ServerTab }
  | { kind: 'p2p_folder'; id: string; focus?: 'color' }
  | { kind: 'lost_device'; dk: string }
  | { kind: 'recover' }

export type ServerTab =
  | 'overview'
  | 'roles'
  | 'channels'
  | 'invites'
  | 'system'
  | 'history'
  | 'members'
  | 'bans'
  | 'leave'

// One conversation in the list.
export interface RoomSummary {
  id: string
  peer: string
  // Arrival number of the newest stored event: it moves only when stored content changes.
  seq: number
  unread: number
  pings: number
  lastTs: number
  // Stored events and bytes: which limit a full conversation reached.
  count: number
  bytes: number
  full: boolean
  fullWhy: 'events' | 'bytes' | undefined
  // The other side said its storage is full.
  peerFull: boolean
  // Parents we have not received: older history is incomplete here.
  gap: boolean
}

// The open conversation: the newest messages (older pages load on scroll). A P2P server channel
// is one too: its room is the server, `ch` the channel, and `peer` is empty.
export interface P2pChat {
  room: string
  peer: string
  ch?: string
  messages: P2pMessage[]
  more: boolean
  loading: boolean
  // Opened at a message with more after what is loaded (jump.ts): a gap at the end.
  newer?: boolean
  // The read marker when the conversation was opened: the unread line goes after it.
  readSeq: number
  // Calls missed here that the caller hasn't logged (yet).
  missed: MissedCall[]
}

// The open thread of a P2P server channel: its root and the newest replies.
export interface P2pThread {
  room: string
  ch: string
  root: string
  head: P2pMessage | null
  messages: P2pMessage[]
  more: boolean
  loading: boolean
}

// Search over the P2P servers stored here: the hits so far and the cursor for more.
export interface P2pSearch {
  hits: SearchHit[]
  next: string | null
  loading: boolean
  // The index is still being built (results may be missing).
  indexing: boolean
}

export const emptySearch = (): P2pSearch => ({
  hits: [],
  next: null,
  loading: false,
  indexing: false,
})

export interface P2pState {
  account: string | null
  // P2P is turned on for this account on this browser.
  enabled: boolean
  loading: boolean
  status: Status | 'off'
  ik: string | null
  name: string
  fingerprint: string
  card: string | null
  contacts: Contact[]
  presence: Record<string, Presence>
  paused: boolean
  // The P2P home replaces the instance sidebar and pane while open.
  home: boolean
  // Another tab of this account runs P2P; this one only offers to take over.
  elsewhere: boolean
  // Message requests dropped to limit spam.
  dropped: number
  storage: { usage: number; quota: number } | null
  error: string | null
  dialog: P2pDialog | null
  // Direct messages. `reader`: another tab runs P2P, this one only shows what is stored.
  me: string | null
  reader: boolean
  rooms: Record<string, RoomSummary>
  chat: P2pChat | null
  typing: Record<string, string[]>
  pins: { room: string; list: P2pMessage[] | null } | null
  // The panel beside a server channel: a thread or search.
  panel: 'thread' | 'search' | null
  thread: P2pThread | null
  search: P2pSearch
  drafts: Record<string, string>
  // When we may post again in a slow-mode channel (spec 3.5), by draft key.
  slowUntil: Record<string, number>
  replying: { room: string; id: string } | null
  editing: { room: string; id: string; text: string; focus: number } | null
  focus: { room: string; id: string; n: number } | null
  pulling: boolean
  // The browser refused to store more P2P data.
  storageFull: boolean
  // This browser's identity moved to another device then.
  movedAt: number | null
  // A P2P export paused sending here then.
  movingAt: number | null
  // Signs that another device uses this identity, seen then.
  alertAt: number | null
  // Files being attached in the composer, per conversation.
  attaching: Record<string, PendingFile[]>
  // What we know about each attachment shown: stored here, downloading, who has it.
  files: Record<string, FileView>
  fileUsage: Usage | null
  // The call with a contact this tab runs, and whether its ringing stays quiet (the
  // conversation's notification level is "Nothing" or it is muted).
  call: CallView | null
  callQuiet: boolean
  // Accepting: the relay prompt or the microphone may still be pending.
  callAccepting: boolean
  // A call going on in the tab that runs P2P (this tab only reads).
  callElsewhere: { room: string; peer: string } | null
  // The voice channel of a P2P server we are in.
  voice: { room: string; ch: string } | null
  // P2P servers on this device, invites from contacts not answered yet, and the open server
  // (it replaces the instance sidebar and pane, like the P2P home).
  servers: Record<string, ServerView>
  serverInvites: { room: string; name: string; from: string; at: number }[]
  // Contacts asking to list us as co-owner of a server they are creating, and owners asking us
  // to take a server over or to approve its transfer (spec 8.2).
  coOwnerAsks: { key: string; from: string; name: string }[]
  transferAsks: {
    key: string
    kind: 'take' | 'cosign'
    from: string
    room: string
    to: string
    name: string
  }[]
  server: { room: string; ch: string | null } | null
  // Who types in each server channel ("{room}/{channel}").
  serverTyping: Record<string, string[]>
  // Order and folders of P2P servers in the rail (their own, apart from instance servers).
  layout: Layout
  // Account badges of contacts and server members, by identity key, and our own.
  badges: Record<string, BadgeSlot>
  badge: OwnBadge | null
  badgeBusy: boolean
  badgeError: string | null
  // Goes up whenever the inbox's noted pings change (in this tab or the one that runs P2P).
  pingLog: number
}

// Drafts and files being attached are kept per conversation, per server channel and per thread.
export const chatKey = (c: { room: string; ch?: string | null }) =>
  c.ch ? `${c.room}/${c.ch}` : c.room

export const threadKey = (t: { room: string; ch: string; root: string }) =>
  `${t.room}/${t.ch}#${t.root}`

export interface PendingFile {
  id: number
  file: File
  spoiler: boolean
  // Hashing progress, 0..1.
  progress: number
  hashed: Hashed | null
  preview: Preview | null
  error: string | null
}

export interface FileView extends BlobView {
  own: boolean
  // Arrived and wasn't fetched by itself (the daily limit for its sender, or storage).
  paused: AutoPause | null
  // A stored image too large to decode safely: shown as a file to save.
  tooBig?: boolean
}

export const initial: P2pState = {
  account: null,
  enabled: false,
  loading: false,
  status: 'off',
  ik: null,
  name: '',
  fingerprint: '',
  card: null,
  contacts: [],
  presence: {},
  paused: false,
  home: false,
  elsewhere: false,
  dropped: 0,
  storage: null,
  error: null,
  dialog: null,
  me: null,
  reader: false,
  rooms: {},
  chat: null,
  typing: {},
  pins: null,
  panel: null,
  thread: null,
  search: emptySearch(),
  drafts: {},
  slowUntil: {},
  replying: null,
  editing: null,
  focus: null,
  pulling: false,
  storageFull: false,
  movedAt: null,
  movingAt: null,
  alertAt: null,
  attaching: {},
  files: {},
  fileUsage: null,
  call: null,
  callQuiet: false,
  callAccepting: false,
  callElsewhere: null,
  voice: null,
  servers: {},
  serverInvites: [],
  coOwnerAsks: [],
  transferAsks: [],
  server: null,
  serverTyping: {},
  layout: emptyLayout,
  badges: {},
  badge: null,
  badgeBusy: false,
  badgeError: null,
  pingLog: 0,
}

export const useP2p = create<P2pState>()(() => initial)

// Stored per account: { v: 1, on }. Anything unreadable means off.
export const p2pKey = (username: string) => `rchat_p2p:${username}`

export const parseOn = (raw: string | null) => {
  try {
    const v = raw ? (JSON.parse(raw) as unknown) : null
    return typeof v === 'object' && v !== null && (v as { v?: unknown; on?: unknown }).v === 1
      ? (v as { on?: unknown }).on === true
      : false
  } catch {
    return false
  }
}

export const readOn = (username: string) => {
  try {
    return parseOn(localStorage.getItem(home.scoped(p2pKey(username))))
  } catch {
    return false
  }
}

export const writeOn = (username: string, on: boolean) =>
  writeLocal(home.scoped(p2pKey(username)), on ? JSON.stringify({ v: 1, on: true }) : null)

// Transfer files imported in this browser, kept even when its P2P data is removed: importing
// one again as a new device would make a second device of the identity. { v: 1, ids }.
export const importsKey = (username: string) => `rchat_p2p_imports:${username}`

const IMPORTS_KEPT = LOCAL.transfer.browserImportsKept

export const parseImports = (raw: string | null): string[] => {
  try {
    const v = raw ? (JSON.parse(raw) as unknown) : null
    const ids = (v as { v?: unknown; ids?: unknown } | null)?.ids
    return (v as { v?: unknown } | null)?.v === 1 && Array.isArray(ids)
      ? ids.filter((x): x is string => typeof x === 'string').slice(-IMPORTS_KEPT)
      : []
  } catch {
    return []
  }
}

export const readImports = (username: string) => {
  try {
    return parseImports(localStorage.getItem(home.scoped(importsKey(username))))
  } catch {
    return []
  }
}

export const rememberImport = (username: string, id: string) =>
  writeLocal(
    home.scoped(importsKey(username)),
    JSON.stringify({
      v: 1,
      ids: [...readImports(username).filter(x => x !== id), id].slice(-IMPORTS_KEPT),
    })
  )

export let node: P2pNode | null = null

export let store: P2pStore | null = null

export let dms: Dms | null = null

export let servers: Servers | null = null

export let calls: Calls | null = null

export let pingLog: PingLog | null = null

export let badges: Badges | null = null

export let keeper: BadgeKeeper | null = null

export let leader: TabLeader | null = null

export let unwatch: (() => void) | null = null

// The limits this account's P2P started with (user_limits.ts).
export let limits: Readonly<Local> = LOCAL

export let gen = 0

// Follower tabs read the database without running a node; the leader tells them what changed.
export let reader: { store: P2pStore; me: string } | null = null

export let data: {
  postMessage: (m: unknown) => void
  onmessage: ((e: { data: unknown }) => void) | null
  close: () => void
} | null = null

// The node's parts above are assigned only by the account's lifecycle (account.ts), through
// these; every other module reads them.
export const put = {
  node: (x: P2pNode | null) => {
    node = x
  },
  store: (x: P2pStore | null) => {
    store = x
  },
  dms: (x: Dms | null) => {
    dms = x
  },
  servers: (x: Servers | null) => {
    servers = x
  },
  calls: (x: Calls | null) => {
    calls = x
  },
  pingLog: (x: PingLog | null) => {
    pingLog = x
  },
  badges: (x: Badges | null) => {
    badges = x
  },
  keeper: (x: BadgeKeeper | null) => {
    keeper = x
  },
  leader: (x: TabLeader | null) => {
    leader = x
  },
  unwatch: (x: (() => void) | null) => {
    unwatch = x
  },
  limits: (x: Readonly<Local>) => {
    limits = x
  },
  gen: (x: number) => {
    gen = x
  },
  reader: (x: { store: P2pStore; me: string } | null) => {
    reader = x
  },
  data: (
    x: {
      postMessage: (m: unknown) => void
      onmessage: ((e: { data: unknown }) => void) | null
      close: () => void
    } | null
  ) => {
    data = x
  },
}

// What the P2P view needs from the rest of the app, wired by the app shell: notification
// settings, toasts and whether a conversation is being read right now.
export interface P2pHost {
  prefs: () => NotifyPrefs
  alert: (a: AlertInput) => void
  following: (scope: string) => boolean
  typingOn: () => boolean
  toast: (text: string, name?: string) => void
  // The instance is text and emoji only: no attachments anywhere, P2P ones included.
  textOnly: () => boolean
  // In an instance call or voice channel (a P2P ring then gets "busy").
  inCall: () => boolean
  // Ends instance calls and voice before a P2P call starts.
  leaveInstanceCalls: () => void
  muted: () => boolean
}

export const p2pHost: P2pHost = {
  prefs: () => EMPTY_NOTIFY,
  alert: () => {},
  following: () => false,
  typingOn: () => true,
  toast: () => {},
  textOnly: () => false,
  inCall: () => false,
  leaveInstanceCalls: () => {},
  muted: () => false,
}

// Auto-download per account: files up to `dm` bytes in direct messages, images up to `server`
// bytes in P2P servers, and at most `daily` bytes per contact per day. { v: 1, dm, server, daily }.
export const autoKey = (username: string) => `rchat_p2p_auto:${username}`

export const autoDefaults = (l: Readonly<Local> = LOCAL) => ({
  dm: l.files.autoDm,
  server: l.files.autoServer,
  daily: l.dm.autoDaily,
})

export const AUTO_DEFAULT = autoDefaults()

export const AUTO_DAILY_OPTIONS = [...LOCAL.files.autoDailyOptions]

export const AUTO_DM = [...LOCAL.files.autoDmOptions]

export const AUTO_SERVER = [...LOCAL.files.autoServerOptions]

// The choices, with the defaults the instance set among them.
export const autoChoices = (l: Readonly<Local> = LOCAL) => ({
  dm: withChoice(l.files.autoDmOptions, l.files.autoDm),
  server: withChoice(l.files.autoServerOptions, l.files.autoServer),
  daily: withChoice(l.files.autoDailyOptions, l.dm.autoDaily),
})

export const parseAuto = (raw: string | null, l: Readonly<Local> = LOCAL) => {
  const d = l === LOCAL ? AUTO_DEFAULT : autoDefaults(l)
  try {
    const v = raw
      ? (JSON.parse(raw) as { v?: unknown; dm?: unknown; server?: unknown; daily?: unknown })
      : null
    if (v?.v !== 1) return d
    const c = autoChoices(l)
    const pick = (x: unknown, list: number[], def: number) =>
      list.includes(x as number) ? (x as number) : def
    return {
      dm: pick(v.dm, c.dm, d.dm),
      server: pick(v.server, c.server, d.server),
      daily: pick(v.daily, c.daily, d.daily),
    }
  } catch {
    return d
  }
}

export const readAuto = (username: string | null) => {
  const l = instanceLocal()
  if (!username) return parseAuto(null, l)
  try {
    return parseAuto(localStorage.getItem(home.scoped(autoKey(username))), l)
  } catch {
    return parseAuto(null, l)
  }
}

export const chatScope = (room: string, ch?: string | null) =>
  ch ? `p2p:${room}/${ch}` : `p2p:${room}`

export const threadScope = (t: { room: string; ch: string; root: string }) => `p2p:${threadKey(t)}`

// The open P2P home survives a reload of this tab.
const HOME_KEY = 'rchat_p2p_home'

export const readHome = (username: string) => {
  try {
    return sessionStorage.getItem(home.scoped(HOME_KEY)) === username
  } catch {
    return false
  }
}

export const writeHome = (username: string | null) => {
  try {
    if (username) sessionStorage.setItem(home.scoped(HOME_KEY), username)
    else sessionStorage.removeItem(home.scoped(HOME_KEY))
  } catch {
    // Private mode: the view just isn't kept.
  }
}
