import { create } from 'zustand'
import { api, home, shareOrigin, writeLocal } from '../instances'
import { verifyBinding } from '../identity'
import {
  addToFolder,
  emptyLayout,
  mergeServers,
  moveFolder,
  moveIntoFolder,
  moveServer,
  newFolderId,
  parseLayout,
  renameFolder,
  toggleFolder,
  ungroupFolder,
  type Layout,
  type RailEntry,
} from '../nav_layout'
import type { AlertInput } from '../notices'
import { EMPTY_NOTIFY, resolve as resolveNotify, type NotifyPrefs } from '../notify'
import { applySed, parseSed } from '../sed'
import type { UserRef } from '../types'
import type { ConfirmRequest, MarkAllExtra } from '../store_types'
import { dbName, P2pStore, removeP2pDb, type OwnBadge, type RoomRecord } from './db'
import { BadgeKeeper, Badges, peersCanCheck, readSlots, type BadgeSlot } from './badge'
import { fingerprint, keyId } from './keys'
import { displayName, type AddResult, type Contact } from './contacts'
import { p2pAlert, p2pUnread } from './alerts'
import {
  bodyTooLong,
  clipName,
  dmRoomId,
  DmError,
  TOO_LONG_TEXT,
  Dms,
  loadAround,
  loadMessages,
  loadPins,
  PAGE,
  AUTO_DAILY,
  type Arrival,
  type AutoPause,
  type MissedCall,
  MISSED_MAX,
  type P2pMessage,
} from './dm'
import { fitContent, LIMITS as EV, type Attachment, type Fwd, type WireV2 } from './event'
import { JUMP, type PageOpts } from './jump'
import type { PingRec, PingText } from './inbox'
import { PingLog, pingAlive, pingText, readPings } from './ping_log'
import { assemble, EMPTY_VIEW, type BlobView, type Usage } from './blobs'
import type { Hashed } from './hashing'
import { LOCAL } from './limits'
import {
  checkedThumb,
  freeSpace,
  hashFile,
  imageFits,
  previewOf,
  saveName,
  storageSpace,
  UrlCache,
  type Preview,
} from './files'
import { kindOf, NEUTRAL_TYPE } from '../sniff'
import { pausesHidden, sharing } from '../platform'
import { TabLeader, webLeaderDeps } from './leader'
import {
  alreadyImported,
  applyImport,
  exportP2p,
  exportP2pWithFiles,
  filesSize,
  IMPORTED_HERE,
  importFiles,
  importKind,
  summarize,
  unlockP2p,
  unlockP2pWithFiles,
  writeFiles,
  TransferError,
  type FilesHead,
  type FilesKey,
  type Dump,
  type ImportKind,
  type Imported,
  type Kdf,
  type P2pSection,
  type Summary,
} from './transfer'
import { P2pNode, SQUATTED, type Presence, type Status, type Visibility } from './node'
import { PeerTransport } from './transport'
import { JoinAborted, RtcManager } from '../rtc'
import { hidesIp, relayBook } from '../relays'
import { Calls, type CallView, type PendingCall } from './calls'
import { RELAY_DENIED_TEXT } from './voice'
import { slowChanged } from './roles'
import {
  CODE_TTLS,
  NEEDS_INVITER,
  parseCode,
  Servers,
  ServerError,
  type ChannelPatch,
  type SearchHit,
  type SearchQuery,
  type ServerArrival,
  type ServerView,
} from './server'
import { unsentText, WIPE_TEXT } from './flows'
import { P, type HistoryVis } from './state'

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
  | { kind: 'p2p_folder'; id: string }
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

const initial: P2pState = {
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

const readOn = (username: string) => {
  try {
    return parseOn(localStorage.getItem(home.scoped(p2pKey(username))))
  } catch {
    return false
  }
}

const writeOn = (username: string, on: boolean) =>
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

const readImports = (username: string) => {
  try {
    return parseImports(localStorage.getItem(home.scoped(importsKey(username))))
  } catch {
    return []
  }
}

const rememberImport = (username: string, id: string) =>
  writeLocal(
    home.scoped(importsKey(username)),
    JSON.stringify({
      v: 1,
      ids: [...readImports(username).filter(x => x !== id), id].slice(-IMPORTS_KEPT),
    })
  )

const pageVisibility: Visibility = {
  visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  pauses: () => pausesHidden(),
  onChange: fn => {
    if (typeof document === 'undefined') return () => {}
    document.addEventListener('visibilitychange', fn)
    return () => document.removeEventListener('visibilitychange', fn)
  },
}

let node: P2pNode | null = null
let store: P2pStore | null = null
let dms: Dms | null = null
let servers: Servers | null = null
let calls: Calls | null = null
let pingLog: PingLog | null = null
let badges: Badges | null = null
let keeper: BadgeKeeper | null = null
let leader: TabLeader | null = null
let unwatch: (() => void) | null = null
let gen = 0
// Follower tabs read the database without running a node; the leader tells them what changed.
let reader: { store: P2pStore; me: string } | null = null
let data: {
  postMessage: (m: unknown) => void
  onmessage: ((e: { data: unknown }) => void) | null
  close: () => void
} | null = null

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
export const AUTO_DEFAULT = {
  dm: LOCAL.files.autoDm,
  server: LOCAL.files.autoServer,
  daily: AUTO_DAILY,
}
export const AUTO_DAILY_OPTIONS = [...LOCAL.files.autoDailyOptions]
export const AUTO_DM = [...LOCAL.files.autoDmOptions]
export const AUTO_SERVER = [...LOCAL.files.autoServerOptions]

export const parseAuto = (raw: string | null) => {
  try {
    const v = raw
      ? (JSON.parse(raw) as { v?: unknown; dm?: unknown; server?: unknown; daily?: unknown })
      : null
    if (v?.v !== 1) return AUTO_DEFAULT
    return {
      dm: AUTO_DM.includes(v.dm as number) ? (v.dm as number) : AUTO_DEFAULT.dm,
      server: AUTO_SERVER.includes(v.server as number) ? (v.server as number) : AUTO_DEFAULT.server,
      daily: AUTO_DAILY_OPTIONS.includes(v.daily as number)
        ? (v.daily as number)
        : AUTO_DEFAULT.daily,
    }
  } catch {
    return AUTO_DEFAULT
  }
}

export const readAuto = (username: string | null) => {
  if (!username) return AUTO_DEFAULT
  try {
    return parseAuto(localStorage.getItem(home.scoped(autoKey(username))))
  } catch {
    return AUTO_DEFAULT
  }
}

export const chatScope = (room: string, ch?: string | null) =>
  ch ? `p2p:${room}/${ch}` : `p2p:${room}`

export const threadScope = (t: { room: string; ch: string; root: string }) => `p2p:${threadKey(t)}`

// The open P2P home survives a reload of this tab.
const HOME_KEY = 'rchat_p2p_home'

const readHome = (username: string) => {
  try {
    return sessionStorage.getItem(home.scoped(HOME_KEY)) === username
  } catch {
    return false
  }
}

const writeHome = (username: string | null) => {
  try {
    if (username) sessionStorage.setItem(home.scoped(HOME_KEY), username)
    else sessionStorage.removeItem(home.scoped(HOME_KEY))
  } catch {
    // Private mode: the view just isn't kept.
  }
}

// Leaving the page says goodbye to every contact, so they see us go offline at once. A page
// restored from the back-forward cache starts again.
if (typeof window !== 'undefined') {
  // Frames are sealed asynchronously and a page that unloads doesn't wait for that, so what
  // pagehide sends is best effort (a contact call's `end` usually doesn't get out). A voice
  // channel's leave goes out on beforeunload instead, while there is still time; a page that
  // stays after all says it is back as soon as it is used again.
  window.addEventListener('beforeunload', () => servers?.voice.goodbye())
  const back = () => servers?.voice.back()
  window.addEventListener('pointerdown', back, true)
  window.addEventListener('keydown', back, true)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') back()
  })
  window.addEventListener('pagehide', () => {
    // Session.close still sends what was queued first, when the page lives long enough.
    calls?.stop()
    servers?.voice.leave()
    node?.stop()
  })
  window.addEventListener('pageshow', e => {
    if (e.persisted && node) void node.start()
  })
}

const dbFor = (username: string) => dbName(home.host, username)

// Test hook: `?badge=local` lets this tab check badges issued by an instance on this machine or
// the local network (only ever the one it runs on), like `?ice=relay` in ice.ts.
const localBadges = (): boolean => {
  if (typeof window === 'undefined') return false
  try {
    if (new URLSearchParams(window.location.search).get('badge') === 'local')
      sessionStorage.setItem('rchat_badge_local', '1')
    return sessionStorage.getItem('rchat_badge_local') === '1'
  } catch {
    return false
  }
}
const badgeLocal = localBadges()

// Bindings are accepted only from this client's own instance: P2P across instances isn't
// supported, and a peer can't make us fetch keys from a host it picks.
const instanceHost = () => home.info?.host ?? home.host

const checkBinding = (token: string, ik: string) =>
  verifyBinding(token, { ik, host: instanceHost(), allowLocal: badgeLocal })

// This account as the instance names it in bindings.
const accountSub = () => {
  const username = useP2p.getState().account
  return username ? `${username}@${instanceHost()}` : null
}

let badgeTimer: ReturnType<typeof setTimeout> | null = null
let expiryTimer: ReturnType<typeof setTimeout> | null = null

// The badges into the view, and again when the next one expires ("Confirmation expired").
const mirrorBadges = (all: Record<string, BadgeSlot>) => {
  useP2p.setState({ badges: all })
  if (expiryTimer !== null) clearTimeout(expiryTimer)
  expiryTimer = null
  const now = Date.now()
  const next = Math.min(
    ...Object.values(all).flatMap(b => (b.ok && b.ok.exp * 1000 > now ? [b.ok.exp * 1000] : []))
  )
  if (Number.isFinite(next))
    expiryTimer = setTimeout(
      () => mirrorBadges({ ...useP2p.getState().badges }),
      Math.min(next - now + 1000, 2 ** 31 - 1)
    )
}

const scheduleBadges = () => {
  if (badgeTimer !== null) return
  badgeTimer = setTimeout(() => {
    badgeTimer = null
    if (badges) mirrorBadges(badges.all())
  }, 30)
}

// Our own badge changed here: tabs that only read hear it (they re-read it on `badges`).
export const tellBadge = (
  was: OwnBadge | null,
  now: OwnBadge | null,
  post: (m: { badges: true }) => void
) => {
  if (JSON.stringify(was ?? null) !== JSON.stringify(now ?? null)) post({ badges: true })
}

// The node's view into the store; our own badge change is told to the reader tabs (`post`).
export const mirrorFrom = async (
  n: Pick<P2pNode, 'view' | 'paused' | 'myCard'>,
  post: (m: { badges: true }) => void
) => {
  const v = n.view()
  tellBadge(useP2p.getState().badge, v.badge, post)
  useP2p.setState({
    status: v.status,
    ik: v.ik,
    me: v.ik,
    name: v.name,
    fingerprint: fingerprint(v.ik),
    contacts: v.contacts,
    presence: v.presence,
    paused: n.paused,
    dropped: v.dropped,
    movedAt: v.movedAt,
    movingAt: v.movingAt,
    alertAt: v.alertAt,
    badge: v.badge,
    elsewhere: false,
    error: v.status === 'squatted' ? SQUATTED : null,
  })
  const card = await n.myCard().catch(() => null)
  if (node === n) useP2p.setState({ card })
}

const mirror = async () => {
  const n = node
  if (n) await mirrorFrom(n, m => data?.postMessage(m))
}

const stopNode = () => {
  unwatch?.()
  unwatch = null
  if (calls) {
    calls.stop()
    calls = null
    data?.postMessage({ call: null })
  }
  if (useP2p.getState().call) useP2p.setState({ call: null, callQuiet: false })
  servers?.stop()
  if (useP2p.getState().voice) useP2p.setState({ voice: null })
  servers = null
  pingLog?.stop()
  pingLog = null
  keeper?.stop()
  keeper = null
  badges?.stop()
  badges = null
  dms?.stop()
  dms = null
  node?.stop()
  node = null
  store?.close()
  store = null
  stopReader()
}

const stopReader = () => {
  reader?.store.close()
  reader = null
  data?.close()
  data = null
}

const dataChannel = (username: string) => webLeaderDeps().channel(`${dbFor(username)}:data`)

const shutdown = () => {
  const l = leader
  leader = null
  stopNode()
  void l?.stop()
}

// The view fields a node fills in; cleared when this tab hands P2P to another one.
const nodeless = () => {
  const { account, enabled, home: h, dialog, chat, drafts, server, layout } = useP2p.getState()
  return {
    ...initial,
    account,
    enabled,
    home: h,
    dialog,
    drafts,
    server,
    layout,
    chat: chat && { ...chat, messages: [], loading: true },
  }
}

// Another tab runs P2P: this one opens the database to show what is stored, and reloads when
// the leader says something changed.
const read = async (username: string, live: () => boolean) => {
  try {
    const s = await P2pStore.open(dbFor(username), () => {
      if (reader?.store === s) stopReader()
    })
    const self = await s.self()
    if (!live() || !self) return s.close()
    stopReader()
    reader = { store: s, me: keyId(self.ik.pk) }
    const ch = dataChannel(username)
    if (ch) {
      ch.onmessage = e => {
        const msg = e.data as {
          room?: unknown
          call?: unknown
          badges?: unknown
          inbox?: unknown
        } | null
        if (msg && 'call' in msg) return useP2p.setState({ callElsewhere: elsewhereCall(msg.call) })
        if (msg && 'inbox' in msg) return useP2p.setState(st => ({ pingLog: st.pingLog + 1 }))
        if (msg && 'badges' in msg)
          return void Promise.all([readSlots(s), s.self()]).then(
            ([slots, me]) => {
              if (reader?.store !== s) return
              mirrorBadges(Object.fromEntries(slots))
              // Our own badge changed in the leading tab too.
              if (me) useP2p.setState({ badge: me.badge ?? null })
            },
            () => {}
          )
        const room = msg?.room
        if (typeof room !== 'string') return
        void refreshRoom(room)
        void s.contacts().then(
          contacts => reader?.store === s && useP2p.setState({ contacts }),
          () => {}
        )
      }
      data = ch
      ch.postMessage({ ask: 'call' })
    }
    const contacts = await s.contacts()
    useP2p.setState({
      reader: true,
      me: reader.me,
      contacts,
      ik: reader.me,
      name: self.profile.name,
      fingerprint: fingerprint(reader.me),
      badge: self.badge ?? null,
    })
    mirrorBadges(Object.fromEntries(await readSlots(s)))
    await refreshRooms()
    const chat = useP2p.getState().chat
    if (chat) await loadChat(chat.room, chat.peer)
  } catch {
    // The leader's copy is all there is; this tab just shows the notice.
  }
}

// Runs P2P in this tab once it holds the account's lock; until then the tab shows a notice.
// `create` is the name for a new identity, when one should be made.
const run = (username: string, create: string | null) => {
  const mine = gen
  // Bumped on every resign, so a boot still in flight stops instead of starting a second node.
  let term = 0
  const l: TabLeader = new TabLeader(dbFor(username), {
    lead: (): Promise<void> => {
      const t = ++term
      return mine === gen
        ? boot(username, create, l, () => mine === gen && t === term)
        : Promise.resolve()
    },
    resign: async () => {
      term++
      stopNode()
      if (mine === gen) useP2p.setState(nodeless())
    },
    follow: () => {
      if (mine !== gen) return
      useP2p.setState({ ...nodeless(), elsewhere: true })
      void read(username, () => mine === gen && l.state !== 'leading')
    },
  })
  leader = l
  useP2p.setState({ loading: true })
  l.start()
}

const boot = async (username: string, create: string | null, l: TabLeader, live: () => boolean) => {
  useP2p.setState({ loading: true, elsewhere: false })
  try {
    const s = await P2pStore.open(dbFor(username), () => {
      // Another tab removed the data or upgraded the schema: start over from what is stored.
      if (store !== s) return
      gen++
      shutdown()
      useP2p.setState({ loading: false })
      void p2pAccount(useP2p.getState().account)
    })
    if (!live()) return s.close()
    const n = await P2pNode.open(
      { store: s, transport: new PeerTransport(), host: home.host, visibility: pageVisibility },
      create !== null ? { name: create } : undefined
    )
    if (!live()) {
      n?.stop()
      return s.close()
    }
    if (!n) {
      s.close()
      writeOn(username, false)
      if (leader === l) leader = null
      void l.stop()
      useP2p.setState({ ...initial, account: username })
      return
    }
    store = s
    node = n
    stopReader()
    const d = new Dms({
      node: n,
      store: s,
      attachments: () => !p2pHost.textOnly(),
      room: freeSpace,
      space: storageSpace,
      autoMax: () => readAuto(username).dm,
      autoDaily: () => readAuto(username).daily,
    })
    dms = d
    const sv = new Servers({
      node: n,
      store: s,
      dms: d,
      autoMax: () => readAuto(username).server,
      attachments: () => !p2pHost.textOnly(),
    })
    servers = sv
    sv.voice.media = callRtc
    sv.voice.consent = (hosts, ik) => relayBook.consent(hosts, ik)
    sv.voice.denied = ik => {
      const at = sv.voice.current()
      p2pHost.toast(RELAY_DENIED_TEXT, at ? memberName(at.room, ik) : 'a member')
    }
    sv.voice.onChange(() => {
      const cur = sv.voice.current()
      const was = useP2p.getState().voice
      if (cur?.room !== was?.room || cur?.ch !== was?.ch) useP2p.setState({ voice: cur })
    })
    pingLog = new PingLog({ store: s, dms: d, servers: sv, onWrite: pingLogged })
    sv.onChange(room => {
      data?.postMessage({ room })
      scheduleServer(room)
    })
    sv.onArrive(a => serverArrived(a))
    sv.onTyping(room => scheduleServer(room))
    const c = new Calls({
      me: () => n.ik,
      sessions: ik => n.readySessions(ik),
      mutual: ik => n.contact(ik)?.state === 'mutual',
      roomOf: ik => dmRoomId(n.ik, ik),
      name: ik => contactName(ik),
      media: callRtc,
      plan: choice => relayBook.check(choice ?? relayBook.prefs.choice),
      hidesIp,
      consent: hosts => relayBook.consent(hosts),
      log: async (room, call) => {
        if (await s.room(room)) await d.logCall(room, call)
      },
      missed: (room, m) => void noteMissed(s, room, m).catch(() => {}),
      busy: () => p2pHost.inCall() || sv.voice.current() !== null,
      muted: () => p2pHost.muted(),
      save: p => void s.setMeta(PENDING_CALL, p).catch(() => {}),
      notice: text => p2pHost.toast(text),
      leaveOthers: () => {
        p2pHost.leaveInstanceCalls()
        sv.voice.leave()
      },
    })
    calls = c
    n.use({
      attach: x => c.attach(x),
      ready: x => c.ready(x),
      keep: x => c.keeps(x),
      awake: () => c.awake() || sv.voice.current() !== null,
    })
    const bs = new Badges({
      store: s,
      verify: checkBinding,
      contacts: () => n.contactList(),
      warn: (ik, other) => n.warnAccount(ik, other),
    })
    badges = bs
    n.onBinding((ik, token) => bs.offer(ik, token))
    bs.onChange(() => {
      data?.postMessage({ badges: true })
      scheduleBadges()
    })
    const k = new BadgeKeeper({
      node: n,
      checkable: () => peersCanCheck(shareOrigin(null), badgeLocal),
      request: (ik, ts, proof) => api.p2pBinding(ik, ts, proof),
      sub: accountSub,
      onIssued: () => void sv.refreshBadge().catch(() => {}),
    })
    keeper = k
    c.onChange(() => publishCall(c))
    c.onRing(v => ringing(v))
    d.blobs.onChange(h => scheduleFile(h))
    data = dataChannel(username)
    if (data)
      data.onmessage = e => {
        if ((e.data as { ask?: unknown } | null)?.ask === 'call' && calls === c) publishCall(c)
      }
    d.onChange(room => {
      data?.postMessage({ room })
      scheduleRefresh(room)
    })
    d.onArrive(a => arrived(a))
    void d.recheckOutbox().catch(() => {})
    void s
      .meta<PendingCall>(PENDING_CALL)
      .then(p => c.recover(p && typeof p === 'object' && typeof p.id === 'string' ? p : null))
      .catch(() => {})
    unwatch = n.onChange(() => void mirror())
    useP2p.setState({ enabled: true, loading: false, reader: false, me: n.ik })
    await mirror()
    if (node !== n) return
    await bs.start()
    mirrorBadges(bs.all())
    if (node !== n) return
    await sv.start()
    if (node !== n) return
    await refreshRooms()
    refreshServers()
    const chat = useP2p.getState().chat
    if (chat) await loadChat(chat.room, chat.peer)
    await n.start()
    k.start()
    void d.blobs.resume().catch(() => {})
  } catch {
    if (live())
      useP2p.setState({ loading: false, error: "Couldn't open P2P storage in this browser" })
  }
}

// Called on every sign in and out (null): one node per account, none for guests.
export const p2pAccount = async (username: string | null) => {
  const cur = useP2p.getState()
  if (username !== null && cur.account === username && (node || leader || cur.loading)) return
  gen++
  shutdown()
  const was = useP2p.getState()
  const keepHome =
    username !== null && ((was.account === username && was.home) || readHome(username))
  useP2p.setState({ ...initial, account: username, home: keepHome, layout: readLayout(username) })
  if (username === null || !readOn(username)) return
  useP2p.setState({ enabled: true })
  run(username, null)
}

// ----- Direct messages -----

const dbNow = () => store ?? reader?.store ?? null
const meNow = () => node?.ik ?? reader?.me ?? null

const summary = (r: RoomRecord): RoomSummary => ({
  id: r.id,
  peer: r.peer,
  seq: r.lastSeq,
  unread: r.unread,
  pings: r.pings,
  lastTs: r.lastTs,
  full: r.full,
  fullWhy: r.fullWhy,
  peerFull: !!r.peerFull,
  gap: r.missing.length > 0,
})

const refreshRooms = async () => {
  const s = dbNow()
  if (!s) return
  const list = await s.rooms().catch(() => [])
  useP2p.setState({
    rooms: Object.fromEntries(list.filter(r => r.kind !== 'server').map(r => [r.id, summary(r)])),
  })
  if (!servers) {
    // A tab that only reads lists the servers stored here by name.
    const names: Record<string, ServerView> = {}
    for (const r of list) if (r.kind === 'server' && !r.invite) names[r.id] = readerView(r)
    useP2p.setState({ servers: names })
  }
}

// Moves on each jump to a message loaded around it: pages that started loading before are dropped.
let jumpGen = 0

// A page of the open conversation or channel.
const chatPage = (chat: P2pChat, o: PageOpts) => {
  const s = dbNow()
  const me = meNow()
  if (chat.ch) return servers ? servers.loadChannel(chat.room, chat.ch, o) : Promise.resolve(null)
  return s && me ? loadMessages(s.db, chat.room, me, chat.peer, o) : Promise.resolve(null)
}

// Opened at a message, the view keeps its place when the conversation changes (an old copy's
// rows above a new copy's stay as they are).
const refreshWindow = async (cur: P2pChat) => {
  const archived = cur.messages.filter(m => m.archived)
  const first = cur.messages.find(m => !m.archived)
  if (!first) return
  const gen = jumpGen
  const page = await chatPage(cur, {
    from: first.sortKey,
    limit: Math.max(PAGE, cur.messages.length),
    newer: true,
  }).catch(() => null)
  const now = useP2p.getState().chat
  if (!page || now?.room !== cur.room || now.ch !== cur.ch || gen !== jumpGen) return
  useP2p.setState({
    chat: { ...now, messages: [...archived, ...page.messages], newer: page.more, loading: false },
  })
}

const loadChat = async (room: string, peer: string, keep = false) => {
  const s = dbNow()
  const me = meNow()
  if (!s || !me) return
  const cur = useP2p.getState().chat
  if (cur?.ch && cur.room === room) return loadChannel(room, cur.ch, keep)
  if (keep && cur?.room === room && cur.newer) return refreshWindow(cur)
  const limit = keep && cur?.room === room ? Math.max(PAGE, cur.messages.length) : PAGE
  const gen = jumpGen
  try {
    const { messages, more } = await loadMessages(s.db, room, me, peer, { limit })
    const missed = readMissed(await s.meta<unknown>(missedKey(room)).catch(() => undefined))
    const now = useP2p.getState().chat
    if (now?.room !== room || gen !== jumpGen) return
    useP2p.setState({ chat: { ...now, messages, more, newer: false, loading: false, missed } })
  } catch {
    // Storage went away (sign out, Remove P2P data).
  }
}

const refreshRoom = async (room: string) => {
  const s = dbNow()
  if (!s) return
  if (servers?.isServer(room)) return refreshServer(room)
  const r = await s.room(room).catch(() => undefined)
  // A tab that only reads gets the leader's server updates too: listed by name, never as DMs.
  if (r?.kind === 'server') {
    if (!servers && !r.invite)
      useP2p.setState(st => ({ servers: { ...st.servers, [room]: readerView(r) } }))
    return
  }
  if (r) useP2p.setState(st => ({ rooms: { ...st.rooms, [room]: summary(r) } }))
  if (dms && useP2p.getState().storageFull !== dms.storageFull)
    useP2p.setState({ storageFull: dms.storageFull })
  const st = useP2p.getState()
  const typing = dms ? dms.typingIn(room) : []
  if ((st.typing[room] ?? []).join() !== typing.join())
    useP2p.setState(x => ({ typing: { ...x.typing, [room]: typing } }))
  if (st.chat?.room === room) {
    await loadChat(room, st.chat.peer, true)
    useP2p.setState({ pulling: dms?.sync.pulling(room) ?? false })
  }
  if (st.pins?.room === room) await loadPinList(room)
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()

// ----- Servers -----

const readerView = (r: RoomRecord): ServerView => ({
  id: r.id,
  name: r.name ?? 'P2P server',
  color: null,
  me: null,
  joining: false,
  owner: null,
  owners: [],
  perms: 0,
  rank: [-Infinity, ''],
  history: 'shared',
  system: { ch: null, join: true, leave: true },
  channels: [],
  roles: [],
  everyone: 0,
  members: [],
  online: 0,
  joined: 0,
  chans: r.chans ?? {},
  seq: r.lastSeq,
  gap: false,
  full: r.full,
  readOnly: null,
  voice: {},
  mods: [],
  reached: [],
  reapply: [],
  joinWait: null,
  conflict: false,
  syncing: null,
  upgraded: false,
  disputed: false,
  next: null,
  prev: null,
  carry: null,
  migrateDiff: null,
})

const refreshServers = () => {
  const sv = servers
  if (!sv) return
  const out: Record<string, ServerView> = {}
  for (const r of sv.serverRooms()) {
    if (r.invite) continue
    const v = sv.view(r.id)
    if (v) out[r.id] = v
  }
  useP2p.setState({
    servers: out,
    coOwnerAsks: sv.coOwnerAsks(),
    transferAsks: sv.transferAsks(),
    serverInvites: sv.invites().map(r => ({
      room: r.id,
      name: r.name ?? 'P2P server',
      from: r.invite?.from ?? '',
      at: r.invite?.at ?? 0,
    })),
  })
}

const refreshServer = async (room: string) => {
  const sv = servers
  if (!sv) return
  const v = sv.view(room)
  const st = useP2p.getState()
  const servs = { ...st.servers }
  if (v && !sv.serverRooms().find(r => r.id === room)?.invite) servs[room] = v
  else delete servs[room]
  const typing = { ...st.serverTyping }
  for (const c of v?.channels ?? []) {
    const k = `${room}/${c.id}`
    const list = sv.typingIn(room, c.id)
    if (list.length) typing[k] = list
    else delete typing[k]
  }
  // The open thread's typers (`{room}/{channel}#{root}`).
  for (const k of Object.keys(typing))
    if (k.startsWith(`${room}/`) && k.includes('#')) delete typing[k]
  const th = st.thread
  if (th?.room === room) {
    const list = sv.typingIn(room, th.ch, th.root)
    if (list.length) typing[threadKey(th)] = list
  }
  useP2p.setState({
    servers: servs,
    serverTyping: typing,
    coOwnerAsks: sv.coOwnerAsks(),
    transferAsks: sv.transferAsks(),
    serverInvites: sv.invites().map(r => ({
      room: r.id,
      name: r.name ?? 'P2P server',
      from: r.invite?.from ?? '',
      at: r.invite?.at ?? 0,
    })),
    storageFull: (dms?.storageFull ?? false) || sv.storageFull,
  })
  const now = useP2p.getState()
  // The open channel went away (deleted, or we left): fall back to the first one.
  if (now.server?.room === room && v) {
    const ch = now.server.ch
    const first = v.channels.find(c => c.kind === 'text')?.id ?? null
    if (ch && !v.channels.some(c => c.id === ch)) p2pServer.openChannel(first)
    else if (!ch && first) p2pServer.openChannel(first)
  }
  if (now.chat?.ch && now.chat.room === room) {
    const ch = now.chat.ch
    await loadChannel(room, ch, true)
    useP2p.setState({ pulling: sv.pulling(room) })
    // Slow mode changed, or leaves us out now: the countdown follows.
    const was = st.servers[room]?.channels.find(c => c.id === ch)
    const is = v?.channels.find(c => c.id === ch)
    if (slowChanged(was, is)) await readSlow(room, ch)
  }
  if (now.thread?.room === room) await loadThread(true)
  if (now.pins?.room === room) await loadPinList(room)
}

const serverTimers = new Map<string, ReturnType<typeof setTimeout>>()

const scheduleServer = (room: string) => {
  if (serverTimers.has(room)) return
  serverTimers.set(
    room,
    setTimeout(() => {
      serverTimers.delete(room)
      void refreshServer(room)
    }, 30)
  )
}

const loadChannel = async (room: string, ch: string, keep = false) => {
  const sv = servers
  if (!sv) return
  const cur = useP2p.getState().chat
  const same = keep && cur?.room === room && cur.ch === ch
  if (same && cur.newer) return refreshWindow(cur)
  const limit = same ? Math.max(PAGE, cur.messages.length) : PAGE
  const gen = jumpGen
  try {
    const { messages, more } = await sv.loadChannel(room, ch, { limit })
    const now = useP2p.getState().chat
    if (now?.room !== room || now.ch !== ch || gen !== jumpGen) return
    useP2p.setState({ chat: { ...now, messages, more, newer: false, loading: false } })
    if (!keep) await readSlow(room, ch)
  } catch {
    // Storage went away.
  }
}

// The open thread's root and newest replies (`keep`: at least as many as shown).
const loadThread = async (keep = false) => {
  const sv = servers
  const t = useP2p.getState().thread
  if (!sv || !t) return
  const limit = keep ? Math.max(PAGE, t.messages.length) : PAGE
  try {
    const got = await sv.loadThread(t.room, t.root, { limit })
    const now = useP2p.getState().thread
    if (now?.room !== t.room || now.root !== t.root) return
    if (!got) return useP2p.setState({ thread: { ...now, loading: false } })
    useP2p.setState({
      thread: { ...now, head: got.root, messages: got.messages, more: got.more, loading: false },
    })
  } catch {
    // Storage went away.
  }
}

export const p2pThread = {
  // Opens the thread of a top-level message of the open channel (at one of its replies).
  async open(root: string, at?: string) {
    const st = useP2p.getState()
    const chat = st.chat
    const s = dbNow()
    if (!chat?.ch || !s) return
    const rec = await s.event(root).catch(() => undefined)
    if (!rec || rec.room !== chat.room || rec.type !== 'msg' || !rec.chan || rec.thread) return
    if (rec.chan !== chat.ch) {
      p2pServer.openChannel(rec.chan)
      await channelLoaded(chat.room, rec.chan)
    }
    const same = st.thread?.room === chat.room && st.thread.root === root
    const head = same ? (st.thread?.head ?? null) : (findMessage(root) ?? null)
    useP2p.setState({
      panel: 'thread',
      thread: {
        room: chat.room,
        ch: rec.chan,
        root,
        head,
        messages: same ? (st.thread?.messages ?? []) : [],
        more: same ? (st.thread?.more ?? false) : false,
        loading: !same,
      },
      search: emptySearch(),
    })
    if (at === undefined) return loadThread()
    await p2pThread.jumpTo(at)
  },

  close: () =>
    useP2p.setState(st => ({
      panel: st.panel === 'thread' ? null : st.panel,
      thread: null,
      editing: st.editing?.room.includes('#') ? null : st.editing,
      replying: st.replying?.room.includes('#') ? null : st.replying,
    })),

  async loadOlder() {
    const sv = servers
    const t = useP2p.getState().thread
    if (!sv || !t || !t.more || t.loading) return
    useP2p.setState({ thread: { ...t, loading: true } })
    const page = await sv
      .loadThread(t.room, t.root, { before: t.messages[0]?.sortKey })
      .catch(() => null)
    const now = useP2p.getState().thread
    if (now?.room !== t.room || now.root !== t.root) return
    useP2p.setState({
      thread: page
        ? { ...now, messages: [...page.messages, ...now.messages], more: page.more, loading: false }
        : { ...now, loading: false },
    })
  },

  // A reply of the open thread, loaded around if it isn't shown, and flashed.
  async jumpTo(id: string) {
    const sv = servers
    const t = useP2p.getState().thread
    if (!sv || !t) return
    if (id === t.root) return p2pDm.jumpTo(id)
    if (!t.messages.some(m => m.id === id)) {
      const around = await sv.loadThreadAround(t.room, t.root, id).catch(() => null)
      const now = useP2p.getState().thread
      if (now?.room !== t.room || now.root !== t.root) return
      // The reply no longer shows here (or left the thread): the thread opens as it is.
      if (!around) return loadThread()
      useP2p.setState({
        thread: {
          ...now,
          head: around.root,
          messages: around.messages,
          more: around.more,
          loading: false,
        },
      })
    }
    useP2p.setState(x => ({ focus: { room: threadKey(t), id, n: (x.focus?.n ?? 0) + 1 } }))
  },

  // Read at the bottom: the thread's pings come off the counters and the inbox.
  async markRead() {
    const t = useP2p.getState().thread
    const sv = servers
    if (!t || !sv) return
    if (!useP2p.getState().servers[t.room]?.chans[t.ch]?.threads?.[t.root]) return
    const ids = pingLog ? await pingLog.ofThread(t.room, t.ch, t.root).catch(() => []) : []
    if (ids.length) await pingLog?.mark(ids).catch(() => 0)
    await sv.markThread(t.room, t.ch, t.root).catch(() => {})
  },
}

// Messages stored here that match (search panel). `from` is matched against member names.
export interface P2pSearchArgs {
  q: string
  from: string
  ch: string | null
  hasFile: boolean
  beforeTs: number | null
  afterTs: number | null
}

const authorsNamed = (name: string) => {
  const needle = name.trim().toLowerCase()
  if (!needle) return null
  const out = new Set<string>()
  for (const v of Object.values(useP2p.getState().servers))
    for (const m of v.members)
      if (memberName(v.id, m.ik).toLowerCase().startsWith(needle)) out.add(m.ik)
  for (const c of useP2p.getState().contacts)
    if (displayName(c).toLowerCase().startsWith(needle)) out.add(c.ik)
  const me = meNow()
  if (me && 'me'.startsWith(needle)) out.add(me)
  return [...out]
}

let searchGen = 0

// While the index is rebuilt (after the upgrade or an import), the panel says results may be
// missing, until it is complete.
const watchIndex = () => {
  const sv = servers
  if (!sv || sv.indexed) return
  void sv.indexing.then(() =>
    useP2p.setState(st => (st.search.indexing ? { search: { ...st.search, indexing: false } } : {}))
  )
}

export const p2pSearch = {
  open() {
    const indexing = !!servers && !servers.indexed
    useP2p.setState({ panel: 'search', search: { ...emptySearch(), indexing }, thread: null })
    watchIndex()
  },

  close: () =>
    useP2p.setState(st => ({
      panel: st.panel === 'search' ? null : st.panel,
      search: emptySearch(),
    })),

  // A first page (`fresh`) or the next one.
  async run(args: P2pSearchArgs, fresh: boolean) {
    const sv = servers
    if (!sv) {
      useP2p.setState({ search: emptySearch() })
      return
    }
    const cur = useP2p.getState().search
    if (!fresh && (cur.loading || cur.next === null)) return
    const gen = fresh ? ++searchGen : searchGen
    const room = useP2p.getState().server?.room ?? null
    const q: SearchQuery = {
      q: args.q,
      from: authorsNamed(args.from),
      room: args.ch ? room : null,
      ch: args.ch,
      hasFile: args.hasFile,
      beforeTs: args.beforeTs,
      afterTs: args.afterTs,
    }
    useP2p.setState(st => ({
      search: fresh
        ? { ...emptySearch(), loading: true, indexing: !sv.indexed }
        : { ...st.search, loading: true },
    }))
    const page =
      q.from?.length === 0
        ? { hits: [], next: null }
        : await sv
            .search(q, fresh ? null : cur.next)
            .catch(() => ({ hits: [] as SearchHit[], next: null }))
    if (gen !== searchGen) return
    useP2p.setState(st => ({
      search: {
        hits: fresh ? page.hits : [...st.search.hits, ...page.hits],
        next: page.next,
        loading: false,
        indexing: !sv.indexed,
      },
    }))
    watchIndex()
  },

  // Opens a hit where it is (its thread for a reply); the panel closes.
  async openHit(hit: SearchHit) {
    p2pSearch.close()
    await p2pOpenAt(hit.room, hit.ch, hit.m.id)
  },
}

// How long until we may post in a slow-mode channel again.
const readSlow = async (room: string, ch: string) => {
  const left = await servers?.slowLeft(room, ch).catch(() => 0)
  if (left === undefined) return
  const key = chatKey({ room, ch })
  const until = left > 0 ? Date.now() + left : 0
  if ((useP2p.getState().slowUntil[key] ?? 0) === until) return
  useP2p.setState(st => ({ slowUntil: { ...st.slowUntil, [key]: until } }))
}

// What a member calls themselves (our petname for contacts first).
export const memberName = (room: string, ik: string) =>
  servers?.nameOf(ik, room) ??
  useP2p.getState().servers[room]?.members.find(m => m.ik === ik)?.name ??
  'Member'

// The name an author gives themselves (never our petname, never masked): a forward carries it.
export const profileName = (ik: string, room?: string) => {
  if (servers) return servers.profileName(ik, room)
  const st = useP2p.getState()
  if (ik === st.ik) return st.name || 'Member'
  return st.contacts.find(c => c.ik === ik)?.name || 'Member'
}

export const serverScope = (room: string) => ({ kind: 'p2ps', room }) as const
export const channelScope = (room: string, ch: string) => ({ kind: 'p2pc', room, ch }) as const

const SERVER_PING: Record<NonNullable<ServerArrival['ping']>, string> = {
  mention: 'mentioned you',
  reply: 'replied to you',
  reaction: 'reacted to your message',
  everyone: 'mentioned @everyone',
}

// A new message in a server channel: toasts and desktop notifications follow the channel's
// level (Only @mentions by default), like an instance server.
const serverArrived = (a: ServerArrival) => {
  if (a.ping) pingLog?.note(a.room, a.ch, a.ping, a.rec, a.thread)
  const st = useP2p.getState()
  const visible = typeof document === 'undefined' || document.visibilityState === 'visible'
  const t = st.thread
  // A thread reply is seen in its open thread, read at the bottom.
  const watched = a.thread
    ? !!t &&
      t.room === a.room &&
      t.root === a.thread &&
      p2pHost.following(threadScope(t)) &&
      visible
    : st.server?.room === a.room &&
      st.chat?.ch === a.ch &&
      p2pHost.following(chatScope(a.room, a.ch)) &&
      visible
  if (watched) {
    if (a.thread) setTimeout(() => void p2pThread.markRead(), 0)
    else void servers?.markRead(a.room, a.ch)
    return
  }
  const rule = resolveNotify(p2pHost.prefs(), channelScope(a.room, a.ch), Date.now())
  if (rule.muted || rule.level === 'nothing') return
  if (!a.ping && rule.level !== 'all') return
  const v = st.servers[a.room]
  const c = a.rec.wire.c as { body?: string; key?: string } | null
  p2pHost.alert({
    key: `p2p:${a.room}/${a.ch}`,
    actor: p2pUser(a.rec.sender, memberName(a.room, a.rec.sender)),
    action: a.ping
      ? a.ping === 'reaction' && c?.key
        ? `reacted ${c.key} to your message`
        : SERVER_PING[a.ping]
      : '',
    body: a.ping === 'reaction' ? '' : (c?.body ?? ''),
    server: v?.name ?? 'P2P server',
    channel: v?.channels.find(x => x.id === a.ch)?.name ?? null,
    dm: false,
    message: a.ping !== 'reaction',
    name: memberName(a.room, a.rec.sender),
    generic: a.ping ? 'New notification' : 'New message',
    go: () =>
      a.thread
        ? void p2pOpenAt(a.room, a.ch, a.rec.type === 'msg' ? a.rec.id : (a.rec.target ?? a.thread))
        : p2pServer.open(a.room, a.ch),
  })
}

const withServers = async <T>(fn: (s: Servers) => Promise<T>): Promise<T | null> => {
  const sv = servers
  if (!sv) {
    p2pHost.toast(ELSEWHERE_TEXT)
    return null
  }
  try {
    return await fn(sv)
  } catch (e) {
    if (e instanceof ServerError && e.who) p2pHost.toast(e.message, e.who)
    else p2pHost.toast(e instanceof Error ? e.message : String(e))
    return null
  }
}

// The channel opened last in each server, for this tab.
const lastChannel = new Map<string, string>()

// The ban confirmation: with Manage messages, "Also hide all their messages" (spec 3.5).
export const banRequest = (v: ServerView, ik: string, name: string): ConfirmRequest => {
  const wipe = (v.perms & P.ManageMessages) !== 0
  return {
    title: 'Ban Member',
    body: wipe
      ? `Ban ${name}? They can't come back.`
      : `Ban ${name}? Nothing they post from now on is shown, and they can't come back.`,
    confirm: 'Ban',
    ...(wipe
      ? {
          choices: [
            {
              value: 'keep',
              label: 'Hide what they post from now on',
              detail: 'Their earlier messages stay.',
              danger: true,
            },
            {
              value: 'wipe',
              label: WIPE_TEXT,
              detail: 'Everything they posted is hidden too.',
              danger: true,
            },
          ],
        }
      : {}),
    action: choice => void p2pServer.ban(v.id, ik, choice === 'wipe'),
  }
}

const threadPings = (c: { threads?: Record<string, number> }) =>
  Object.values(c.threads ?? {}).reduce((a, b) => a + b, 0)

// Thread counters already checked on a read, at a stored-content position (`seq`: deletions and
// hidden content move it too), so reading at the bottom again doesn't redo it.
const threadsChecked = new Map<string, string>()
type Counts = { unread: number; pings: number; threads?: Record<string, number> }
export const threadsSig = (c: Counts, seq: number) =>
  `${seq}:${c.pings}:${Object.entries(c.threads ?? {})
    .map(([t, n]) => `${t}=${n}`)
    .join()}`

// Whether reading a channel can be skipped: nothing unread, only thread pings left, and those
// checked at this position already.
export const channelReadSkips = (c: Counts, seq: number, checked: string | undefined) =>
  !c.unread && c.pings <= threadPings(c) && (!threadPings(c) || checked === threadsSig(c, seq))

// Reads a channel: thread pings whose reply or root stopped showing come off with it, and the
// log notes them as seen. The counters are taken before the log, so a ping that arrives meanwhile
// stays counted.
const readChannel = async (room: string, ch: string) => {
  const sv = servers
  if (!sv) return
  try {
    const counts = sv.threadCounts(room, ch)
    const pings = pingLog ? await pingLog.threadPings(room, ch) : []
    const dead = await sv.readChannel(room, ch, pings, counts)
    if (dead.length) await pingLog?.seen(dead)
  } catch {
    // Storage went away.
  }
  const v = useP2p.getState().servers[room]
  const c = v?.chans[ch]
  if (c) threadsChecked.set(`${room}/${ch}`, threadsSig(c, v.seq))
}

export const p2pServer = {
  // Opens a server (its last channel, or the first one); the P2P home closes.
  open(room: string, ch?: string | null) {
    const v = useP2p.getState().servers[room]
    const pick = ch ?? lastChannel.get(room) ?? v?.channels.find(c => c.kind === 'text')?.id ?? null
    writeHome(null)
    useP2p.setState({ home: false, server: { room, ch: null }, dialog: null })
    p2pServer.openChannel(pick)
  },

  // A voice channel opens its stage, without a conversation.
  openChannel(ch: string | null) {
    const cur = useP2p.getState().server
    if (!cur) return
    const kind = useP2p.getState().servers[cur.room]?.channels.find(c => c.id === ch)?.kind
    const text = !!ch && kind !== 'voice'
    if (ch && text) lastChannel.set(cur.room, ch)
    useP2p.setState(st => ({
      server: { room: cur.room, ch },
      chat:
        ch && text
          ? {
              room: cur.room,
              peer: '',
              ch,
              messages: st.chat?.room === cur.room && st.chat.ch === ch ? st.chat.messages : [],
              more: false,
              loading: !(st.chat?.room === cur.room && st.chat.ch === ch),
              readSeq: st.servers[cur.room]?.chans[ch]?.readSeq ?? 0,
              missed: [],
            }
          : null,
      pins: null,
      editing: null,
      replying: null,
      pulling: false,
      thread: st.thread?.room === cur.room && st.thread.ch === ch ? st.thread : null,
      panel:
        st.panel === 'thread' && !(st.thread?.room === cur.room && st.thread.ch === ch)
          ? null
          : st.panel,
    }))
    if (ch && text) void loadChannel(cur.room, ch)
  },

  close: () =>
    useP2p.setState(st => ({
      server: null,
      chat: st.chat?.ch ? null : st.chat,
      pins: st.chat?.ch ? null : st.pins,
      panel: null,
      thread: null,
    })),

  async create(name: string, coOwners: string[] = []) {
    const room = await withServers(s => s.create(name, coOwners))
    if (room) {
      refreshServers()
      p2pServer.open(room)
    }
    return room
  },

  async join(code: string) {
    const room = await withServers(s => s.redeem(code))
    if (room) {
      refreshServers()
      p2pServer.open(room)
    }
    return room
  },

  async acceptInvite(room: string) {
    await withServers(s => s.acceptInvite(room))
    refreshServers()
    p2pServer.open(room)
  },

  declineInvite: (room: string) => withServers(s => s.declineInvite(room)).then(refreshServers),

  async leave(room: string) {
    await withServers(s => s.leave(room))
    refreshServers()
  },

  async forget(room: string) {
    const ok = await withServers(s => s.forget(room).then(() => true))
    if (!ok) return
    if (useP2p.getState().server?.room === room) p2pServer.close()
    refreshServers()
  },

  invite: (room: string, ik: string) => withServers(s => s.invite(room, ik)),
  issueCode: (room: string, ttl: number, label = '') =>
    withServers(s => s.issueCode(room, ttl, label)),
  revokeCode: (room: string, hash: string) => withServers(s => s.revokeCodeSynced(room, hash)),
  codes: (room: string) => withServers(s => s.codes(room)),
  rename: (room: string, name: string) => withServers(s => s.setName(room, name)),
  setHistory: (room: string, vis: HistoryVis) => withServers(s => s.setHistory(room, vis)),
  setSystem: (room: string, sys: { ch: string | null; join: boolean; leave: boolean }) =>
    withServers(s => s.setSystem(room, sys)),
  addChannel: (room: string, name: string, kind: 'text' | 'voice' = 'text') =>
    withServers(s => s.addChannel(room, name, { kind })),
  editChannel: (room: string, id: string, patch: ChannelPatch) =>
    withServers(s => s.editChannel(room, id, patch)),
  setOverwrite: (room: string, ch: string, subj: string, o: { allow: number; deny: number }) =>
    withServers(s => s.setOverwrite(room, ch, subj, o.allow, o.deny)),
  // Roles (spec 1.4, 1.6). Taking a role from someone is a removal: it waits for sync too.
  createRole: (room: string, role: { name: string; color: number | null; bits: number }) =>
    withServers(s => s.createRole(room, role)),
  async moveRoles(room: string, moves: { role: string; pos: number }[]) {
    for (const m of moves)
      if ((await withServers(s => s.moveRole(room, m.role, m.pos))) === null) return
  },
  editRole: (room: string, role: string, meta: { name: string; color: number | null }) =>
    withServers(s => s.editRole(room, role, meta)),
  setRoleBit: (room: string, role: string, bit: number, on: boolean) =>
    withServers(s => s.setRoleBit(room, role, bit, on)),
  deleteRole: (room: string, role: string) => withServers(s => s.deleteRole(room, role)),
  assignRole: (room: string, ik: string, role: string) =>
    withServers(s => s.assignRole(room, ik, role)),
  revokeRole: (room: string, ik: string, role: string) =>
    withServers(s =>
      ik === useP2p.getState().me
        ? s.revokeRole(room, ik, role)
        : s.moderate(room, { act: 'Take a role from', who: ik }, () => s.revokeRole(room, ik, role))
    ),
  removeChannel: (room: string, id: string) =>
    withServers(s => s.editChannel(room, id, { gone: true })),
  // Moderation waits for sync (spec 8.2): signed after a fresh heads exchange with a member, or
  // once Apply anyway is chosen.
  kick: (room: string, ik: string) =>
    withServers(s => s.moderate(room, { act: 'Kick', who: ik }, () => s.kick(room, ik))),
  withdraw: (room: string, ik: string) =>
    withServers(s =>
      s.moderate(room, { act: 'Withdraw the invite of', who: ik }, () => s.kick(room, ik))
    ),
  ban: (room: string, ik: string, wipe = false) =>
    withServers(s =>
      s.moderate(room, { act: 'Ban', who: ik }, () => s.ban(room, ik, undefined, wipe))
    ),
  unban: (room: string, ik: string) =>
    withServers(s =>
      s.moderate(room, { act: 'Lift the ban of', who: ik }, () => s.unban(room, ik))
    ),
  applyAnyway: (room: string, id: number) => servers?.applyAnyway(room, id),
  cancelMod: (room: string, id: number) => servers?.cancelMod(room, id),
  inviteAgain: (room: string, by: string) => withServers(s => s.inviteAgain(room, by)),
  dismissReached: (room: string, by: string) => servers?.dismissReached(room, by),
  reapply: (room: string) =>
    withServers(s =>
      s.moderate(room, { act: 'Re-apply moderation actions' }, () => s.reapplyAll(room))
    ),
  answerCoOwner: (key: string, yes: boolean) => servers?.answerCoOwner(key, yes),
  retryCarry: (room: string) => servers?.retryCarry(room),
  // Transfer by upgrade (spec 3.8).
  async transfer(room: string, ik: string) {
    const co = (useP2p.getState().servers[room]?.owners.length ?? 1) > 1
    p2pHost.toast(
      co
        ? 'Waiting for them to take it, and for every co-owner to approve…'
        : 'Waiting for them to take it…'
    )
    const ok = await withServers(s => s.transfer(room, ik).then(() => true))
    if (ok) p2pHost.toast('Transferred. Everyone moves to the new copy.')
  },
  answerTransfer: (key: string, yes: boolean) => withServers(s => s.answerTransfer(key, yes)),
  successors: (room: string) => withServers(s => s.successors(room)),
  async followTo(room: string, g: WireV2) {
    await withServers(s => s.followTo(room, g))
    const next = servers?.view(room)?.next
    refreshServers()
    if (next) p2pServer.open(next)
  },
  newDevice: () => withServers(s => s.newDevice()),

  // Pings on thread replies stay until their thread is read, unless they no longer count.
  markRead(room: string, ch: string) {
    const v = useP2p.getState().servers[room]
    const c = v?.chans[ch]
    if (!c || channelReadSkips(c, v.seq, threadsChecked.get(`${room}/${ch}`))) return
    if (!threadPings(c)) void servers?.markRead(room, ch)
    else void readChannel(room, ch)
  },

  markAllRead(room: string) {
    const chans = useP2p.getState().servers[room]?.chans ?? {}
    if (!servers && Object.values(chans).some(c => c.unread || c.pings))
      return p2pHost.toast(ELSEWHERE_TEXT)
    for (const ch of Object.keys(chans)) p2pServer.markRead(room, ch)
  },

  // What a code says (the server's name), for the join screen, without joining.
  peek: (code: string) => parseCode(code),
}

export { CODE_TTLS, NEEDS_INVITER, ServerError }

// Our devices in P2P servers (spec 3.9, 8.2): the list, a lost or stolen one, and recovery.
export const p2pDevices = {
  list: () => servers?.myDevices() ?? [],
  current: () => {
    const a = node?.author()
    return a ? keyId(a.dk.pk) : null
  },
  preview: async (dk: string, t: number) => (await withServers(s => s.lostPreview(dk, t))) ?? [],
  async disown(dk: string, t: number) {
    const out = await withServers(s => s.disownDevice(dk, t))
    if (out?.failed.length) p2pHost.toast(failedText(out.failed))
    else if (out?.late.length)
      p2pHost.toast(
        'Removed. Where it made the server, what it did stays; nothing it signs from now on counts.'
      )
    else if (out?.unsent) p2pHost.toast(unsentText(out.unsent))
    refreshServers()
  },
  async recover(keep: string[]) {
    const failed = await withServers(s => s.recover(keep))
    if (failed?.length) p2pHost.toast(failedText(failed))
    refreshServers()
  },
}

// Servers where a device flow didn't go through, and why (the first reason).
const failedText = (failed: { why: string }[]) =>
  `Not done in ${failed.length === 1 ? 'one server' : `${failed.length} servers`}: ${failed[0].why}`

// ----- Rail layout -----

// P2P servers' order and folders in the rail, per account in this browser (the instance layout's
// shape, only its server list used). { v: 2, servers, ... } as nav_layout parses it.
export const p2pLayoutKey = (username: string) => `rchat_p2p_layout:${username}`

const readLayout = (username: string | null) => {
  if (!username) return emptyLayout
  try {
    return parseLayout(localStorage.getItem(home.scoped(p2pLayoutKey(username))))
  } catch {
    return emptyLayout
  }
}

const saveLayout = (layout: Layout) => {
  const user = useP2p.getState().account
  useP2p.setState({ layout })
  if (user) writeLocal(home.scoped(p2pLayoutKey(user)), JSON.stringify(layout))
}

const railRooms = () => Object.keys(useP2p.getState().servers).sort()

export const p2pRail = {
  move: (room: string, index: number) =>
    saveLayout(moveServer(useP2p.getState().layout, railRooms(), room, index)),
  moveFolder: (id: string, index: number) =>
    saveLayout(moveFolder(useP2p.getState().layout, railRooms(), id, index)),
  moveIntoFolder: (room: string, id: string, index: number) =>
    saveLayout(moveIntoFolder(useP2p.getState().layout, railRooms(), room, id, index)),
  addToFolder: (room: string, id: string) =>
    saveLayout(addToFolder(useP2p.getState().layout, railRooms(), room, id)),
  merge: (room: string, target: string) => {
    const layout = useP2p.getState().layout
    saveLayout(mergeServers(layout, railRooms(), room, target, newFolderId(layout.servers)))
  },
  toggleFolder: (id: string) => saveLayout(toggleFolder(useP2p.getState().layout, id)),
  rename: (id: string, name: string) =>
    saveLayout(renameFolder(useP2p.getState().layout, id, name)),
  ungroup: (id: string) => saveLayout(ungroupFolder(useP2p.getState().layout, id)),
  // From an imported config (its layout section).
  apply: (servers: RailEntry[]) => saveLayout({ ...useP2p.getState().layout, servers }),
  reload: () => useP2p.setState({ layout: readLayout(useP2p.getState().account) }),
}

// ----- Calls -----

const PENDING_CALL = 'call:out'
const missedKey = (room: string) => `missed:${room}`

const readMissed = (x: unknown): MissedCall[] =>
  Array.isArray(x)
    ? x.filter(
        (m): m is MissedCall =>
          typeof m === 'object' &&
          m !== null &&
          typeof (m as MissedCall).id === 'string' &&
          typeof (m as MissedCall).from === 'string' &&
          typeof (m as MissedCall).video === 'boolean' &&
          Number.isSafeInteger((m as MissedCall).at)
      )
    : []

const noteMissed = async (s: P2pStore, room: string, m: MissedCall) => {
  const list = readMissed(await s.meta<unknown>(missedKey(room))).filter(x => x.id !== m.id)
  list.push(m)
  await s.setMeta(missedKey(room), list.slice(-MISSED_MAX))
  data?.postMessage({ room })
  scheduleRefresh(room)
}

const elsewhereCall = (x: unknown): P2pState['callElsewhere'] => {
  if (typeof x !== 'object' || x === null) return null
  const { room, peer } = x as { room?: unknown; peer?: unknown }
  return typeof room === 'string' && typeof peer === 'string' ? { room, peer } : null
}

const publishCall = (c: Calls) => {
  if (calls !== c) return
  const call = c.view()
  useP2p.setState(st => ({ call, callQuiet: call ? st.callQuiet : false }))
  data?.postMessage({ call: call ? { room: call.room, peer: call.peer } : null })
}

// An incoming call rings by the conversation's notification level: "Nothing" or muted keeps it
// to the conversation itself; otherwise the call card, and a desktop notification when the tab
// is in the background.
const ringing = (v: CallView) => {
  const rule = resolveNotify(p2pHost.prefs(), { kind: 'p2p', room: v.room }, Date.now())
  const quiet = rule.muted || rule.level === 'nothing'
  useP2p.setState({ callQuiet: quiet })
  if (quiet || typeof document === 'undefined' || document.visibilityState === 'visible') return
  p2pHost.alert({
    key: `p2p-call:${v.id}`,
    actor: p2pUser(v.peer),
    action: v.video ? 'is video calling you' : 'is calling you',
    body: '',
    server: null,
    channel: null,
    dm: true,
    message: true,
    name: contactName(v.peer),
    generic: 'Incoming call',
    go: () => {
      p2p.openHome()
      void p2pDm.openDm(v.peer)
    },
  })
}

// The media of calls with contacts and of voice channels in P2P servers (one at a time): rtc.ts,
// signaled over the sessions and with the ICE plan of the call or channel (relays.ts), so relay
// only and the relay prompt work as in instance P2P calls.
export const callRtc = new RtcManager({
  signaler: {
    send: (to, target, payload) =>
      target.ch !== undefined
        ? servers?.voice.send(to, target, payload)
        : calls?.signaler.send(to, target, payload),
  },
  ice: () =>
    servers?.voice.current()
      ? servers.voice.config()
      : (calls?.config() ?? { iceServers: [], iceTransportPolicy: 'relay' }),
})

export const CALL_ELSEWHERE = 'Call in another tab.'
const ELSEWHERE_TEXT = 'P2P is open in another tab.'

const callFailed = (e: unknown) => p2pHost.toast(e instanceof Error ? e.message : String(e))

const mediaVideo = () => callRtc.videoTrack !== null || callRtc.sharing

// Voice channels of P2P servers: joining leaves any other call or voice channel first.
export const p2pVoice = {
  active: () => !!servers?.voice.current() && callRtc.active(),
  async join(room: string, ch: string) {
    const sv = servers
    if (!sv) return p2pHost.toast(ELSEWHERE_TEXT)
    const cur = sv.voice.current()
    if (cur?.room === room && cur.ch === ch) return
    try {
      // Other calls end only once this join may go ahead.
      await sv.voice.join(room, ch, {
        plan: async () => {
          const plan = await relayBook.check(relayBook.prefs.choice)
          return { config: plan.config, declared: plan.declared, hidesIp: hidesIp(plan) }
        },
        muted: () => p2pHost.muted(),
        leaveOthers: () => {
          calls?.hangup()
          p2pHost.leaveInstanceCalls()
        },
      })
    } catch (e) {
      if (!(e instanceof JoinAborted)) callFailed(e)
    }
  },
  leave: () => servers?.voice.leave(),
  // A camera or a screen share went on or off (the others show the notice for video).
  videoChanged: () => servers?.voice.setVideo(mediaVideo()),
  async camera() {
    try {
      await callRtc.camera(callRtc.videoTrack === null)
    } catch (e) {
      callFailed(e)
    }
    p2pVoice.videoChanged()
  },
  async share() {
    try {
      await callRtc.share(!callRtc.sharing)
    } catch (e) {
      callFailed(e)
    }
    p2pVoice.videoChanged()
  },
}

export const p2pCall = {
  async start(ik: string, video: boolean, choice?: string) {
    const c = calls
    if (!c) return p2pHost.toast(ELSEWHERE_TEXT)
    try {
      await c.start(ik, video, choice)
      if (video && calls === c && c.view()) await callRtc.camera(true)
    } catch (e) {
      callFailed(e)
    }
  },
  async accept() {
    const c = calls
    if (!c) return
    useP2p.setState({ callAccepting: true })
    try {
      await c.accept()
    } catch (e) {
      callFailed(e)
    } finally {
      useP2p.setState({ callAccepting: false })
    }
  },
  decline: () => calls?.decline(),
  hangup: () => calls?.hangup(),
  // Media is up: our own call, or one we answered.
  media: () => {
    const v = calls?.view()
    return !!v && (v.dir === 'out' || v.state === 'active')
  },
  async camera() {
    try {
      await callRtc.camera(callRtc.videoTrack === null)
    } catch (e) {
      callFailed(e)
    }
  },
  async share() {
    try {
      await callRtc.share(!callRtc.sharing)
    } catch (e) {
      callFailed(e)
    }
  },
}

// Bursts of changes (a backfill) reload the view once.
const scheduleRefresh = (room: string) => {
  if (timers.has(room)) return
  timers.set(
    room,
    setTimeout(() => {
      timers.delete(room)
      void refreshRoom(room)
    }, 30)
  )
}

// ----- Attachments -----

const sizes = new Map<string, number>()
const fileTimers = new Map<string, ReturnType<typeof setTimeout>>()

const recordOf = (h: string) => {
  const s = dbNow()
  return s ? s.db.get('blobs', h).catch(() => undefined) : Promise.resolve(undefined)
}

const refreshFile = async (h: string) => {
  const size = sizes.get(h)
  if (size === undefined) return
  const rec = await recordOf(h)
  const v = dms ? dms.blobs.view(h, size) : { ...EMPTY_VIEW, total: size }
  const paused = (!rec?.wanted && v.state === 'none' && dms?.paused.get(h)) || null
  const next: FileView = rec?.done
    ? {
        ...v,
        state: 'done',
        got: size,
        type: rec.type,
        own: rec.own,
        paused: null,
        tooBig: big.has(h),
      }
    : { ...v, own: false, paused }
  if (!rec?.done) dropUrl(h)
  const cur = useP2p.getState().files[h]
  if (cur && JSON.stringify(cur) === JSON.stringify(next)) return
  useP2p.setState(st => ({ files: { ...st.files, [h]: next } }))
}

const scheduleFile = (h: string) => {
  if (fileTimers.has(h)) return
  fileTimers.set(
    h,
    setTimeout(() => {
      fileTimers.delete(h)
      void refreshFile(h)
    }, 100)
  )
}

// Object URLs of stored files shown inline (only of types sniffing allows).
const urls = new UrlCache(24)
// Stored images whose header says they are too large to show inline.
const big = new Set<string>()

const dropUrl = (h: string) => urls.drop(h)

let pendingSeq = 0

const setPending = (room: string, fn: (list: PendingFile[]) => PendingFile[]) =>
  useP2p.setState(st => ({ attaching: { ...st.attaching, [room]: fn(st.attaching[room] ?? []) } }))

const patchPending = (room: string, id: number, patch: Partial<PendingFile>) =>
  setPending(room, list => list.map(p => (p.id === id ? { ...p, ...patch } : p)))

const clipText = (s: string, chars: number, bytes: number) => {
  let out = Array.from(s).slice(0, chars).join('')
  while (new TextEncoder().encode(out).length > bytes) out = Array.from(out).slice(0, -1).join('')
  return out
}

const cleanMime = (t: string) => (/^[\x21-\x7e]{1,127}$/.test(t) ? t : 'application/octet-stream')

// The attachments of a message: as many thumbnails as fit, the last ones dropped first.
export const fitAttachments = (body: string, list: Attachment[]): Attachment[] | null =>
  fitContent({ body, att: list })?.att ?? null

export const TOO_MANY_FILES = 'These files have names too long to send in one message.'
export const FILES_MAX_TEXT = `You can attach up to ${EV.att} files to a message.`
export const PREPARING_TEXT = 'Files are still being prepared.'
export const BIG_FILE = LOCAL.files.bigFile

export const p2pFiles = {
  // A tile is shown: keep its state current and ask who has it.
  watch(att: Pick<Attachment, 'h' | 'size'>) {
    sizes.set(att.h, att.size)
    void refreshFile(att.h).then(async () => {
      const d = dms
      const v = useP2p.getState().files[att.h]
      if (!d || v?.state === 'done' || p2pHost.textOnly()) return
      await d.blobs.availability(att.h).catch(() => 0)
      void refreshFile(att.h)
    })
  },

  async download(att: Attachment) {
    sizes.set(att.h, att.size)
    const d = dms
    if (!d) return
    d.paused.delete(att.h)
    try {
      await d.blobs.download(att)
    } catch (e) {
      p2pHost.toast(e instanceof Error ? e.message : String(e))
    }
    void refreshFile(att.h)
  },

  async cancel(h: string) {
    await dms?.blobs.cancel(h).catch(() => {})
    void refreshFile(h)
  },

  // The stored file as a URL, for the passive players only (by its sniffed type). Each call is
  // one tile using it until `unuse`.
  url(h: string): Promise<string | null> {
    return urls.use(h, async () => {
      const s = dbNow()
      const blob = s ? await assemble(s.db, h).catch(() => null) : null
      if (!blob || kindOf(blob.type) === null) return null
      if (kindOf(blob.type) === 'image' && !(await imageFits(blob))) {
        big.add(h)
        void refreshFile(h)
        return null
      }
      return URL.createObjectURL(blob)
    })
  },

  unuse: (h: string) => urls.unuse(h),

  thumb: checkedThumb,

  // Saves a stored file under a safe name, as plain bytes (never opened).
  async save(att: Attachment) {
    const s = dbNow()
    const blob = s ? await assemble(s.db, att.h).catch(() => null) : null
    if (!blob) return p2pHost.toast('This file is not on this device yet.')
    sharing().saveBlob(saveName(att.name), new Blob([blob], { type: NEUTRAL_TYPE }))
  },

  add(room: string, files: File[]) {
    if (p2pHost.textOnly() || files.length === 0) return
    const have = useP2p.getState().attaching[room]?.length ?? 0
    const take = files.slice(0, Math.max(0, EV.att - have))
    if (take.length < files.length) p2pHost.toast(FILES_MAX_TEXT)
    for (const file of take) {
      const id = ++pendingSeq
      setPending(room, list => [
        ...list,
        { id, file, spoiler: false, progress: 0, hashed: null, preview: null, error: null },
      ])
      let last = 0
      hashFile(file, n => {
        if (n - last < 0.02 && n < 1) return
        last = n
        patchPending(room, id, { progress: n })
      }).then(
        hashed => patchPending(room, id, { hashed, progress: 1 }),
        () => patchPending(room, id, { error: "Couldn't read this file" })
      )
      void previewOf(file).then(preview => patchPending(room, id, { preview }))
    }
  },

  remove: (room: string, id: number) => setPending(room, list => list.filter(p => p.id !== id)),

  toggleSpoiler: (room: string, id: number) =>
    setPending(room, list => list.map(p => (p.id === id ? { ...p, spoiler: !p.spoiler } : p))),

  clear: (room: string) => setPending(room, () => []),

  // Keeps the files here and returns them as message attachments; null (with a toast) when they
  // can't go yet.
  async stage(room: string, body: string): Promise<Attachment[] | null> {
    const list = useP2p.getState().attaching[room] ?? []
    const d = dms
    if (!list.length || !d) return []
    if (p2pHost.textOnly()) {
      p2pHost.toast('Attachments are turned off on this instance.')
      return null
    }
    if (list.some(p => p.error)) {
      p2pHost.toast('Remove the files that could not be read.')
      return null
    }
    if (list.some(p => !p.hashed || p.preview === null)) {
      p2pHost.toast(PREPARING_TEXT)
      return null
    }
    const seen = new Set<string>()
    const att: Attachment[] = []
    for (const p of list) {
      const hashed = p.hashed as Hashed
      if (seen.has(hashed.h)) continue
      seen.add(hashed.h)
      const a: Attachment = {
        h: hashed.h,
        size: hashed.size,
        blocks: hashed.blocks.length,
        name: clipText(p.file.name.trim() || 'file', EV.attName, EV.attNameBytes) || 'file',
        mime: cleanMime(p.file.type),
      }
      if (p.spoiler) a.spoiler = true
      const pv = p.preview ?? {}
      if (pv.w) a.w = pv.w
      if (pv.h_px) a.h_px = pv.h_px
      if (pv.dur !== undefined) a.dur = pv.dur
      if (pv.thumb) a.thumb = pv.thumb
      att.push(a)
    }
    const fitted = fitAttachments(body, att)
    if (!fitted) {
      p2pHost.toast(TOO_MANY_FILES)
      return null
    }
    try {
      for (const p of list) await d.blobs.putOwn(p.file, p.hashed as Hashed)
    } catch (e) {
      p2pHost.toast(e instanceof Error ? e.message : String(e))
      return null
    }
    return fitted
  },

  async usage() {
    const u = dms ? await dms.blobs.usage().catch(() => null) : null
    useP2p.setState({ fileUsage: u })
    return u
  },

  async clearOlder(days: number) {
    const n = (await dms?.blobs.clearOlder(days).catch(() => 0)) ?? 0
    for (const h of sizes.keys()) void refreshFile(h)
    await p2pFiles.usage()
    void p2p.refreshStorage()
    return n
  },

  readAuto: () => readAuto(useP2p.getState().account),

  writeAuto(patch: Partial<{ dm: number; server: number; daily: number }>) {
    const user = useP2p.getState().account
    if (!user) return
    writeLocal(home.scoped(autoKey(user)), JSON.stringify({ v: 1, ...readAuto(user), ...patch }))
  },
}

const loadPinList = async (room: string) => {
  const chat = useP2p.getState().chat
  if (chat?.ch && chat.room === room) {
    const list = servers ? await servers.loadPins(room, chat.ch).catch(() => null) : null
    if (useP2p.getState().pins?.room === room) useP2p.setState({ pins: { room, list } })
    return
  }
  const s = dbNow()
  const me = meNow()
  const peer = useP2p.getState().rooms[room]?.peer ?? useP2p.getState().chat?.peer
  if (!s || !me || !peer) return
  const list = await loadPins(s.db, room, me, peer).catch(() => null)
  if (useP2p.getState().pins?.room === room) useP2p.setState({ pins: { room, list } })
}

const contactName = (ik: string) => {
  const c = useP2p.getState().contacts.find(x => x.ik === ik)
  return c ? displayName(c) : 'Someone'
}

export const p2pUser = (ik: string, name = contactName(ik)): UserRef => ({
  username: ik,
  display_name: name,
  avatar_kind: 'identicon',
  avatar_color: null,
})

// A new event from the other side: toasts and desktop notifications follow the conversation's
// notification level, like an instance DM. Reading the conversation at the bottom marks it read.
const arrived = (a: Arrival) => {
  if (a.ping) pingLog?.note(a.room, null, a.ping, a.rec)
  const st = useP2p.getState()
  const watched =
    st.home &&
    st.chat?.room === a.room &&
    p2pHost.following(chatScope(a.room)) &&
    (typeof document === 'undefined' || document.visibilityState === 'visible')
  if (watched) {
    void dms?.markRead(a.room)
    return
  }
  const rule = resolveNotify(p2pHost.prefs(), { kind: 'p2p', room: a.room }, Date.now())
  const alert = p2pAlert(a, rule, p2pUser(a.peer), () => {
    p2p.openHome()
    void p2pDm.openDm(a.peer)
  })
  if (alert) p2pHost.alert(alert)
}

const withDms = async <T>(fn: (d: Dms) => Promise<T>): Promise<T | null> => {
  const d = dms
  if (!d) return null
  try {
    return await fn(d)
  } catch (e) {
    p2pHost.toast(e instanceof DmError || e instanceof Error ? e.message : String(e))
    return null
  }
}

const chatRoom = () => useP2p.getState().chat?.room ?? null

// Where a draft key ("{room}", "{room}/{channel}" or "{room}/{channel}#{root}") sends to.
type Target =
  { kind: 'dm'; room: string } | { kind: 'server'; room: string; ch: string; thread: string | null }

const targetOf = (key: string): Target => {
  const i = key.indexOf('/')
  if (i < 0) return { kind: 'dm', room: key }
  const [ch, thread] = key.slice(i + 1).split('#')
  return { kind: 'server', room: key.slice(0, i), ch, thread: thread ?? null }
}

// The open conversation or channel, as a draft key.
const openKey = () => {
  const c = useP2p.getState().chat
  return c ? chatKey(c) : null
}

// Runs a DM action or a server one for a draft key.
const onTarget = <T>(
  key: string,
  dm: (d: Dms, room: string) => Promise<T>,
  server: (s: Servers, room: string, ch: string, thread: string | null) => Promise<T>
): Promise<T | null> => {
  const t = targetOf(key)
  return t.kind === 'dm'
    ? withDms(d => dm(d, t.room))
    : withServers(s => server(s, t.room, t.ch, t.thread))
}

// The rows a draft key shows: a thread's root and replies, or the open conversation's.
const listOf = (key: string | null) => {
  const st = useP2p.getState()
  const t = st.thread
  if (t && key === threadKey(t)) return t.head ? [t.head, ...t.messages] : t.messages
  return st.chat?.messages ?? []
}

const findMessage = (id: string) => {
  const st = useP2p.getState()
  return (
    st.chat?.messages.find(m => m.id === id) ??
    (st.thread?.head?.id === id ? st.thread.head : st.thread?.messages.find(m => m.id === id))
  )
}

// The newest message of ours that can be edited (in a thread: one of its replies).
const lastEditable = (key: string | null = null) => {
  const { me, thread } = useP2p.getState()
  const list = listOf(key)
  const inThread = !!thread && key === threadKey(thread)
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i]
    if (inThread && m.id === thread.root) continue
    if (m.sender === me && !m.fwd && !m.call && !m.system && !m.unavailable) return m
  }
  return null
}

export const p2pDm = {
  async openDm(ik: string) {
    const me = meNow()
    if (!me) return
    const room = dmRoomId(me, ik)
    writeHome(useP2p.getState().account)
    if (dms) await dms.open(ik).catch(() => null)
    const r = await dbNow()
      ?.room(room)
      .catch(() => undefined)
    useP2p.setState(st => ({
      home: true,
      server: null,
      dialog: null,
      chat: {
        room,
        peer: ik,
        messages: st.chat?.room === room ? st.chat.messages : [],
        more: false,
        loading: st.chat?.room !== room,
        readSeq: r?.readSeq ?? 0,
        missed: st.chat?.room === room ? st.chat.missed : [],
      },
      pins: null,
      editing: null,
      pulling: false,
      rooms: r ? { ...st.rooms, [room]: summary(r) } : st.rooms,
    }))
    await loadChat(room, ik)
  },

  // The room with a contact, created when it is first used. Null without a running node.
  async ensureRoom(ik: string) {
    const d = dms
    if (!d) return null
    const r = await d.open(ik).catch(() => null)
    if (r) useP2p.setState(st => ({ rooms: { ...st.rooms, [r.id]: summary(r) } }))
    return r?.id ?? null
  },

  closeDm: () => useP2p.setState({ chat: null, pins: null, editing: null, replying: null }),

  async loadOlderPage() {
    const st = useP2p.getState()
    const s = dbNow()
    const me = meNow()
    const chat = st.chat
    if (!s || !me || !chat || !chat.more || chat.loading) return
    useP2p.setState({ chat: { ...chat, loading: true } })
    const first = chat.messages[0]
    const sv = servers
    const page = await (
      chat.ch
        ? sv
          ? sv.loadChannel(chat.room, chat.ch, { before: first?.sortKey })
          : Promise.resolve(null)
        : loadMessages(s.db, chat.room, me, chat.peer, { before: first?.sortKey })
    ).catch(() => null)
    const now = useP2p.getState().chat
    if (now?.room !== chat.room || now.ch !== chat.ch) return
    useP2p.setState({
      chat: page
        ? { ...now, messages: [...page.messages, ...now.messages], more: page.more, loading: false }
        : { ...now, loading: false },
    })
  },

  // Opened at a message: the next messages after the last one loaded.
  async loadNewerPage() {
    const chat = useP2p.getState().chat
    if (!chat?.newer || chat.loading) return
    useP2p.setState({ chat: { ...chat, loading: true } })
    const last = chat.messages[chat.messages.length - 1]
    const page = await chatPage(chat, {
      after: last?.sortKey,
      limit: JUMP.after,
      newer: true,
    }).catch(() => null)
    const now = useP2p.getState().chat
    if (now?.room !== chat.room || now.ch !== chat.ch) return
    const have = new Set(now.messages.map(m => m.id))
    useP2p.setState({
      chat: page
        ? {
            ...now,
            messages: [...now.messages, ...page.messages.filter(m => !have.has(m.id))],
            newer: page.more,
            loading: false,
          }
        : { ...now, loading: false },
    })
  },

  // Back to the newest messages (refreshes from now on load those too).
  async toPresent() {
    const chat = useP2p.getState().chat
    if (!chat) return
    jumpGen += 1
    useP2p.setState({ chat: { ...chat, newer: false } })
    await (chat.ch ? loadChannel(chat.room, chat.ch) : loadChat(chat.room, chat.peer))
  },

  // Older history from the other side (past the backfill horizon).
  loadOlderHistory() {
    const chat = useP2p.getState().chat
    if (!chat) return
    if (chat.ch) servers?.loadOlder(chat.room)
    else dms?.loadOlder(chat.room)
    useP2p.setState({ pulling: true })
  },

  async jumpTo(id: string) {
    const st = useP2p.getState()
    const s = dbNow()
    const me = meNow()
    const chat = st.chat
    if (!s || !me || !chat) return
    if (chat.ch) {
      const root = await servers?.threadOf(id).catch(() => null)
      if (root) return p2pThread.open(root, id)
    }
    if (!chat.messages.some(m => m.id === id)) {
      const sv = servers
      const around = await (
        chat.ch
          ? sv
            ? sv.loadAround(chat.room, chat.ch, id)
            : Promise.resolve(null)
          : loadAround(s.db, chat.room, me, chat.peer, id)
      ).catch(() => null)
      if (!around) return
      const now = useP2p.getState().chat
      if (now?.room !== chat.room || now.ch !== chat.ch) return
      // A page loading from before the jump would replace the messages around it.
      jumpGen += 1
      // It also stands in for a first page still loading, which the jump drops.
      useP2p.setState({
        chat: {
          ...now,
          messages: around.messages,
          more: around.more,
          newer: around.newer,
          loading: false,
        },
      })
    }
    useP2p.setState(x => ({ focus: { room: chat.room, id, n: (x.focus?.n ?? 0) + 1 } }))
  },

  clearFocus: () => useP2p.setState({ focus: null }),

  setDraft(room: string, text: string) {
    useP2p.setState(st => ({ drafts: { ...st.drafts, [room]: text } }))
  },

  // Sends the draft: `s/old/new` edits the last own message, otherwise a new message (a reply
  // while the reply bar is open).
  async send(room: string, text: string): Promise<boolean> {
    const body = text.trim()
    const files = useP2p.getState().attaching[room]?.length ?? 0
    if (!body && !files) return false
    const sed = files ? null : parseSed(text)
    if (sed) {
      const last = lastEditable(room)
      const next = last ? applySed(last.body, sed) : null
      if (!last || next === null) return false
      if (bodyTooLong(next)) {
        p2pHost.toast(TOO_LONG_TEXT)
        return false
      }
      return (
        (await onTarget(
          room,
          (d, r) => d.edit(r, last.id, next),
          (sv, r) => sv.edit(r, last.id, next)
        )) !== null
      )
    }
    const att = files ? await p2pFiles.stage(room, text) : []
    if (att === null) return false
    const st = useP2p.getState()
    const reply = st.replying?.room === room ? st.replying.id : undefined
    const id = await onTarget(
      room,
      (d, r) => d.send(r, { body: text, reply, att }),
      (sv, r, ch, thread) =>
        sv.send(r, { ch, body: text, reply, att, ...(thread ? { thread } : {}) })
    )
    // A failed send keeps what it replied to.
    const now = useP2p.getState().replying
    if (id !== null && reply && now?.room === room && now.id === reply)
      useP2p.setState({ replying: null })
    if (id !== null && files) p2pFiles.clear(room)
    const t = targetOf(room)
    if (t.kind === 'server') await readSlow(t.room, t.ch)
    if (id !== null && useP2p.getState().chat?.newer) void p2pDm.toPresent()
    return id !== null
  },

  // `room` is a draft key: a conversation, or a server channel.
  async forward(room: string, fwd: Fwd) {
    const clipped = { ...fwd, name: clipName(fwd.name) }
    const id = await onTarget(
      room,
      (d, r) => d.send(r, { body: '', fwd: clipped }),
      (sv, r, ch, thread) =>
        sv.send(r, { ch, body: '', fwd: clipped, ...(thread ? { thread } : {}) })
    )
    const t = targetOf(room)
    if (t.kind === 'server') await readSlow(t.room, t.ch)
    return id !== null
  },

  // A failed message: send it again, or say why it can't be.
  retry(id: string) {
    const key = openKey()
    return key
      ? onTarget(
          key,
          (d, r) => d.retry(r, id),
          (sv, r) => sv.retry(r, id)
        )
      : Promise.resolve(null)
  },

  startReply(room: string, id: string) {
    useP2p.setState({ replying: { room, id }, editing: null })
  },

  cancelReply: () => useP2p.setState({ replying: null }),

  startEdit(room: string, id: string) {
    const m = findMessage(id)
    if (!m) return
    useP2p.setState(st => ({
      editing: { room, id, text: m.body, focus: (st.editing?.focus ?? 0) + 1 },
      replying: null,
    }))
  },

  editLast(room: string) {
    const m = lastEditable(room)
    if (!m) return false
    p2pDm.startEdit(room, m.id)
    return true
  },

  setEditText: (text: string) =>
    useP2p.setState(st => (st.editing ? { editing: { ...st.editing, text } } : {})),

  cancelEdit: () => useP2p.setState({ editing: null }),

  async saveEdit() {
    const e = useP2p.getState().editing
    if (!e) return
    const m = findMessage(e.id)
    const body = e.text.trim()
    if (body && bodyTooLong(e.text)) return p2pHost.toast(TOO_LONG_TEXT)
    useP2p.setState({ editing: null })
    if (!m || !body || body === m.body.trim()) return
    await onTarget(
      e.room,
      (d, r) => d.edit(r, e.id, e.text),
      (sv, r) => sv.edit(r, e.id, e.text)
    )
  },

  remove: (id: string) => {
    const key = openKey()
    return key
      ? onTarget(
          key,
          (d, r) => d.redact(r, id),
          (sv, r) => sv.redact(r, id)
        )
      : Promise.resolve(null)
  },

  react(id: string, emoji: string, on?: boolean) {
    const key = openKey()
    const m = findMessage(id)
    if (!key || !m) return Promise.resolve(null)
    const mine = m.reactions.find(r => r.key === emoji)?.me === true
    return onTarget(
      key,
      (d, r) => d.react(r, id, emoji, on ?? !mine),
      (sv, r) => sv.react(r, id, emoji, on ?? !mine)
    )
  },

  pin(id: string, on: boolean) {
    const key = openKey()
    return key
      ? onTarget(
          key,
          (d, r) => d.pin(r, id, on),
          (sv, r) => sv.pin(r, id, on)
        )
      : Promise.resolve(null)
  },

  async openPins() {
    const room = chatRoom()
    if (!room) return
    useP2p.setState({ pins: { room, list: null } })
    await loadPinList(room)
  },

  closePins: () => useP2p.setState({ pins: null }),

  // `room` is a draft key.
  markRead(room: string) {
    const t = targetOf(room)
    if (t.kind === 'server') return p2pServer.markRead(t.room, t.ch)
    const r = useP2p.getState().rooms[room]
    if (!r || (!r.unread && !r.pings)) return
    void withDms(d => d.markRead(room))
  },

  // Every conversation with unread messages or pings. Only the tab that runs P2P can.
  markAllRead() {
    const list = Object.values(useP2p.getState().rooms).filter(r => r.unread || r.pings)
    if (list.length && !dms) return p2pHost.toast(ELSEWHERE_TEXT)
    for (const r of list) p2pDm.markRead(r.id)
  },

  typing(room: string, on: boolean) {
    if (!p2pHost.typingOn()) return
    const t = targetOf(room)
    if (t.kind === 'server') servers?.typing(t.room, t.ch, on, t.thread ?? undefined)
    else dms?.typing(room, on)
  },
}

const withNode = async <T>(fn: (n: P2pNode) => Promise<T>): Promise<T | null> => {
  const n = node
  if (!n) return null
  try {
    return await fn(n)
  } catch (e) {
    useP2p.setState({ error: e instanceof Error ? e.message : String(e) })
    return null
  }
}

export const p2p = {
  // `name` is shown to contacts; empty means "P2P user", never the account name.
  async enable(name = '') {
    const username = useP2p.getState().account
    if (!username || node || leader) return
    writeOn(username, true)
    useP2p.setState({ enabled: true })
    try {
      await navigator.storage?.persist?.()
    } catch {
      // Best effort: the browser may still evict the data.
    }
    run(username, name)
    void p2p.refreshStorage()
  },

  // Deletes the identity, contacts and everything else P2P from this browser.
  async removeData() {
    const username = useP2p.getState().account
    if (!username) return
    gen++
    shutdown()
    writeOn(username, false)
    try {
      await removeP2pDb(dbFor(username))
    } catch {
      useP2p.setState({ error: "Couldn't remove P2P data" })
    }
    useP2p.setState({ ...initial, account: username, layout: readLayout(username) })
  },

  setPaused: (on: boolean) => withNode(n => n.setPaused(on)),
  addContact: (text: string, intro = ''): Promise<AddResult | null> =>
    withNode(n => n.addContact(text, intro)),
  readCard: (text: string) => withNode(n => n.readCard(text)),
  accept: (ik: string) => withNode(n => n.accept(ik)),
  ignore: (ik: string) => withNode(n => n.ignore(ik)),
  block: (ik: string) => withNode(n => n.block(ik)),
  remove: (ik: string) => withNode(n => n.remove(ik)),
  rename: (ik: string, name: string) => withNode(n => n.rename(ik, name)),
  markVerified: (ik: string) => withNode(n => n.markVerified(ik)),
  verifyCode: (ik: string) => node?.verifyCodeFor(ik) ?? null,
  scanVerify: (ik: string, text: string) => withNode(n => n.scanVerifyCode(ik, text)),
  setName: (name: string) => withNode(n => n.setName(name)),
  async resetIdentity() {
    await withNode(n => n.resetIdentity())
    void keeper?.refresh().catch(() => {})
  },
  resumeSending: () => withNode(n => n.resumeSending()),
  clearAlert: () => withNode(n => n.clearAlert()),
  clearDropped: () => withNode(n => n.clearDropped()),
  // Moves P2P from the tab that runs it to this one.
  useHere: () => leader?.takeOver(),

  openHome: () => {
    writeHome(useP2p.getState().account)
    useP2p.setState(st => ({
      home: true,
      server: null,
      chat: st.chat?.ch ? null : st.chat,
      pins: st.chat?.ch ? null : st.pins,
      panel: null,
      thread: null,
    }))
  },
  closeHome: () => {
    writeHome(null)
    if (useP2p.getState().server) p2pServer.close()
    useP2p.setState({ home: false })
  },
  clearError: () => useP2p.setState({ error: null }),
  openDialog: (dialog: P2pDialog) => useP2p.setState({ dialog }),
  closeDialog: () => useP2p.setState({ dialog: null }),

  async refreshStorage() {
    try {
      const e = await navigator.storage?.estimate?.()
      if (e) useP2p.setState({ storage: { usage: e.usage ?? 0, quota: e.quota ?? 0 } })
    } catch {
      useP2p.setState({ storage: null })
    }
  },
}

// ----- Inbox -----

const pingLogged = () => {
  data?.postMessage({ inbox: true })
  useP2p.setState(st => ({ pingLog: st.pingLog + 1 }))
}

export const p2pPings = {
  // The noted pings and the read positions, from the running node's database or the stored one.
  async read(): Promise<{ list: PingRec[]; readSeq: Map<string, number> } | null> {
    const s = dbNow()
    if (!s) return null
    try {
      return pingLog && store === s ? await pingLog.read() : await readPings(s)
    } catch {
      return null
    }
  },

  async text(p: PingRec): Promise<PingText | null> {
    const s = dbNow()
    return s ? pingText(s, p) : null
  },

  async alive(p: PingRec) {
    const s = dbNow()
    return s ? pingAlive(s, p) : false
  },

  // Marks pings read. Only the tab that runs P2P writes.
  async mark(ids: string[]) {
    if (!ids.length) return
    if (!pingLog) {
      if (useP2p.getState().enabled) p2pHost.toast(ELSEWHERE_TEXT)
      return
    }
    await pingLog.mark(ids)
  },
}

// What "Mark all as read" adds for P2P: conversations and joined servers that show unread, as
// Home's Unread card lists them.
export const p2pMarkAll = (): MarkAllExtra => {
  const u = p2pUnread(useP2p.getState(), p2pHost.prefs(), Date.now())
  return {
    pending: u.dms.unread || u.dms.pings > 0 || u.servers.length > 0,
    mark: () => {
      p2pDm.markAllRead()
      for (const v of Object.values(useP2p.getState().servers))
        if (v.me === 'join') p2pServer.markAllRead(v.id)
    },
  }
}

// Opens a conversation or server channel at a message.
export const p2pOpenAt = async (room: string, ch: string | null, id: string) => {
  if (ch === null) {
    const peer = useP2p.getState().rooms[room]?.peer
    if (!peer) return
    p2p.openHome()
    await p2pDm.openDm(peer)
  } else {
    p2pServer.open(room, ch)
    await channelLoaded(room, ch)
  }
  const chat = useP2p.getState().chat
  if (chat?.room !== room || (chat.ch ?? null) !== ch) return
  const root = ch === null ? null : await servers?.threadOf(id).catch(() => null)
  if (root) {
    await p2pDm.jumpTo(root)
    await p2pThread.open(root, id)
  } else await p2pDm.jumpTo(id)
}

const channelLoaded = (room: string, ch: string) =>
  new Promise<void>(resolve => {
    const done = (st: P2pState) => st.chat?.room !== room || st.chat.ch !== ch || !st.chat.loading
    if (done(useP2p.getState())) return resolve()
    const stop = () => {
      clearTimeout(timer)
      off()
      resolve()
    }
    const off = useP2p.subscribe(st => {
      if (done(st)) stop()
    })
    const timer = setTimeout(stop, 5000)
  })

// The newest page of a conversation or channel as stored here (the palette's index).
export const p2pRecent = async (room: string, ch: string | null): Promise<P2pMessage[] | null> => {
  const s = dbNow()
  const me = meNow()
  if (!s || !me) return null
  try {
    if (ch !== null)
      return servers ? (await servers.loadChannel(room, ch, { limit: PAGE })).messages : null
    const peer = useP2p.getState().rooms[room]?.peer
    return peer ? (await loadMessages(s.db, room, me, peer, { limit: PAGE })).messages : null
  } catch {
    return null
  }
}

// ----- Account badge -----

export const p2pBadge = {
  // Turns the badge on once the instance signed a binding; the error says why it didn't.
  async enable() {
    const k = keeper
    if (!k) return useP2p.setState({ badgeError: ELSEWHERE_TEXT })
    useP2p.setState({ badgeBusy: true, badgeError: null })
    try {
      await k.enable()
    } catch (e) {
      useP2p.setState({ badgeError: e instanceof Error ? e.message : String(e) })
    } finally {
      useP2p.setState({ badgeBusy: false })
    }
  },
  async disable() {
    const k = keeper
    if (!k) return useP2p.setState({ badgeError: ELSEWHERE_TEXT })
    useP2p.setState({ badgeError: null })
    try {
      await k.disable()
    } catch (e) {
      useP2p.setState({ badgeError: e instanceof Error ? e.message : String(e) })
    }
  },
  // Couldn't check: ask the issuer again now.
  recheck: (ik: string) => badges?.recheck(ik),
}

// ----- Device move -----

export const ELSEWHERE_IMPORT = 'P2P is open in another tab. Use it here first.'

const errText = (e: unknown) =>
  e instanceof TransferError || e instanceof Error ? e.message : String(e)

// The database of this account, for a moment: the running node's, or opened just for this.
const withDb = async <T>(fn: (s: P2pStore) => Promise<T>): Promise<T> => {
  const username = useP2p.getState().account
  if (!username) throw new Error('Sign in first')
  const live = store ?? reader?.store
  if (live && !live.closed) return fn(live)
  const s = await P2pStore.open(dbFor(username))
  try {
    return await fn(s)
  } finally {
    s.close()
  }
}

// Without `databases()`, opening without a version and aborting the upgrade of a database that
// didn't exist leaves nothing behind.
const probeDb = (name: string) =>
  new Promise<boolean>(resolve => {
    const req = indexedDB.open(name)
    req.onupgradeneeded = () => {
      if (req.transaction) req.transaction.abort()
      resolve(false)
    }
    req.onsuccess = () => {
      req.result.close()
      resolve(true)
    }
    req.onerror = () => resolve(false)
  })

const hasDb = async (name: string) => {
  try {
    const list = await indexedDB.databases?.()
    return list ? list.some(d => d.name === name) : await probeDb(name)
  } catch {
    return true
  }
}

export interface Unlocked {
  dump: Dump
  summary: Summary
  kind: ImportKind
  // This identity already took this file in: importing changes nothing.
  already: boolean
  // The files that follow the data in the `.rchat` file, and their key.
  files: { blob: Blob; key: FilesKey } | null
}

// A `.rchat` file's files part: everything after its first line.
export interface FilesPart {
  blob: Blob
  head: FilesHead
}

export const p2pTransfer = {
  // Bytes of the complete files here, for the export option.
  async filesSize() {
    return (await withDb(s => filesSize(s.db)).catch(() => 0)) ?? 0
  },

  // Whether there is an identity here to export (one that moved away has no keys left).
  available: () => useP2p.getState().ik !== null && useP2p.getState().movedAt === null,

  // Sending pauses here afterwards, until the user resumes. With `files`, also the key to write
  // the files into the `.rchat` file with (`writeFiles`).
  async exportSection(
    pass: string,
    kdf?: Kdf,
    files = false
  ): Promise<{ section: P2pSection; files: FilesKey | null }> {
    const out = await withDb(async s =>
      files
        ? exportP2pWithFiles(s.db, pass, kdf, Date.now())
        : { section: await exportP2p(s.db, pass, kdf, Date.now()), files: null }
    )
    const at = Date.now()
    const n = node
    if (n && !n.moved) await n.markExported(at)
    else
      await withDb(s =>
        s.updateSelf(cur => (cur && !cur.moved ? { ...cur, moving: { at }, exported: at } : null))
      )
    useP2p.setState({ movingAt: at })
    return out
  },

  // Streams the files after the config text, block by block.
  async writeFiles(
    fk: FilesKey,
    write: (part: Uint8Array) => Promise<void>,
    progress?: (done: number, total: number) => void
  ) {
    await withDb(s => writeFiles(s.db, fk, write, progress))
  },

  // Decrypts and reads the file's P2P data; nothing is written.
  async unlock(section: P2pSection, pass: string, part?: FilesPart | null): Promise<Unlocked> {
    const username = useP2p.getState().account
    if (!username) throw new Error('Sign in first')
    let dump: Dump
    let files: Unlocked['files'] = null
    if (part) {
      const got = await unlockP2pWithFiles(section, pass, part.head)
      dump = got.dump
      files = { blob: part.blob, key: got.files }
    } else dump = await unlockP2p(section, pass)
    const st = useP2p.getState()
    let kind: ImportKind = 'new'
    let already = false
    if (st.ik !== null || (await hasDb(dbFor(username)))) {
      const local = await withDb(s => s.self())
      kind = importKind(local, dump)
      already = alreadyImported(local, dump)
    }
    if (kind !== 'merge' && readImports(username).includes(dump.id))
      throw new TransferError(IMPORTED_HERE)
    return { dump, summary: summarize(dump), kind, already, files }
  },

  // Runs in the tab that holds the account's P2P lock: the node stops, the import writes in one
  // transaction, and the node starts again on what is stored. Another tab running P2P keeps it.
  // The files that came with it are read in afterwards, block by block (`progress` gets bytes).
  async apply(
    u: Unlocked,
    progress?: (done: number) => void
  ): Promise<{ ok: true; res: Imported } | { ok: false; error: string }> {
    const username = useP2p.getState().account
    if (!username) return { ok: false, error: 'Sign in first' }
    if (useP2p.getState().elsewhere) return { ok: false, error: ELSEWHERE_IMPORT }
    const job = async () => {
      const s = await P2pStore.open(dbFor(username))
      try {
        const res: Imported = await applyImport(s.db, u.dump, u.kind)
        rememberImport(username, u.dump.id)
        if (u.files) res.files = await importFiles(s.db, u.files.blob, u.files.key, progress)
        return res
      } finally {
        s.close()
      }
    }
    try {
      navigator.storage?.persist?.().catch(() => {})
    } catch {
      // Best effort.
    }
    const l = leader
    if (l && l.state === 'leading') {
      const mine = gen
      stopNode()
      let out: { ok: true; res: Imported } | { ok: false; error: string }
      try {
        out = { ok: true, res: await job() }
      } catch (e) {
        out = { ok: false, error: errText(e) }
      }
      if (mine === gen && leader === l)
        await boot(username, null, l, () => mine === gen && leader === l && l.state === 'leading')
      return out
    }
    if (l) return { ok: false, error: ELSEWHERE_IMPORT }
    // P2P is off in this browser: hold the lock just for the import, then start as usual.
    const locks = webLeaderDeps().locks
    let out: { ok: true; res: Imported } | { ok: false; error: string } = {
      ok: false,
      error: ELSEWHERE_IMPORT,
    }
    const run1 = async () => {
      try {
        out = { ok: true, res: await job() }
      } catch (e) {
        out = { ok: false, error: errText(e) }
      }
    }
    if (locks)
      await locks.request(dbFor(username), { ifAvailable: true }, lock =>
        lock ? run1() : Promise.resolve()
      )
    else await run1()
    if (out.ok && useP2p.getState().account === username) {
      writeOn(username, true)
      useP2p.setState({ enabled: true })
      run(username, null)
    }
    return out
  },
}
