import { resetHandlers } from '../identity_scope'
import type { AccountSession } from '../../client/session'
import { create } from 'zustand'
import { home, readLocal, sessionStore, writeLocal } from '../../instances'
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
import { accountLimits, instanceLocal, userLimitsKey, withChoice } from '../user_limits'
import type { Preview } from '../files'
import type { TabLeader } from '../leader'
import type { P2pNode, Presence, Status } from '../node'
import type { Calls, CallView } from '../calls'
import type { SearchHit, ServerView, Servers } from '../server'
import type { IdentityScope } from './scope'

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
  // The open conversation shows beside the instance's DM list instead of in the P2P home.
  dmList: boolean
  // Another tab of this account runs P2P; this one only offers to take over.
  elsewhere: boolean
  // Message requests dropped to limit spam.
  dropped: number
  // This browser offers contacts no address to connect to (ice.ts probeAddress).
  addressHidden: boolean
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
  // When we may post again in a slow-mode channel, by draft key.
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
  // to take a server over or to approve its transfer.
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
  account?: AccountSession
}
export function createStorePart(scope: IdentityScope) {
  const emptySearch = (): P2pSearch => ({
    hits: [],
    next: null,
    loading: false,
    indexing: false,
  })

  // Drafts and files being attached are kept per conversation, per server channel and per thread.
  const chatKey = (c: { room: string; ch?: string | null }) => (c.ch ? `${c.room}/${c.ch}` : c.room)

  const threadKey = (t: { room: string; ch: string; root: string }) => `${t.room}/${t.ch}#${t.root}`

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
    dmList: false,
    elsewhere: false,
    dropped: 0,
    addressHidden: false,
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
    layout: structuredClone(emptyLayout),
    badges: {},
    badge: null,
    badgeBusy: false,
    badgeError: null,
    pingLog: 0,
  }

  const useP2p = create<P2pState>()(() => initial)

  // Stored per account: { v: 1, on }. Anything unreadable means off.
  const p2pKey = (username: string) => `rchat_p2p:${username}`

  // The P2P home (also a conversation of it beside the DM list) or a P2P server shows in place of
  // the instance's view.
  const coversInstance = (s: Pick<P2pState, 'home' | 'server'>) => s.home || s.server !== null

  const parseOn = (raw: string | null) => {
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
      return parseOn(readLocal(scope.scoped(p2pKey(username))))
    } catch {
      return false
    }
  }

  const writeOn = (username: string, on: boolean) =>
    scope.current(username) &&
    writeLocal(scope.scoped(p2pKey(username)), on ? JSON.stringify({ v: 1, on: true }) : null)

  // Transfer files imported in this browser, kept even when its P2P data is removed: importing
  // one again as a new device would make a second device of the identity. { v: 1, ids }.
  const importsKey = (username: string) => `rchat_p2p_imports:${username}`

  // At most `transfer.browserImportsKept`, the newest.
  const parseImports = (
    raw: string | null,
    lim: Pick<Local['transfer'], 'browserImportsKept'> = LOCAL.transfer
  ): string[] => {
    try {
      const v = raw ? (JSON.parse(raw) as unknown) : null
      const ids = (v as { v?: unknown; ids?: unknown } | null)?.ids
      return (v as { v?: unknown } | null)?.v === 1 && Array.isArray(ids)
        ? ids.filter((x): x is string => typeof x === 'string').slice(-lim.browserImportsKept)
        : []
    } catch {
      return []
    }
  }

  const identityLimits = (username: string) =>
    accountLimits(
      (scope.owner?.conn ?? home).info,
      readLocal(scope.scoped(userLimitsKey(username)))
    )

  const readImports = (username: string) => {
    try {
      const raw = readLocal(scope.scoped(importsKey(username)))
      return parseImports(raw, identityLimits(username).transfer)
    } catch {
      return []
    }
  }

  const rememberImport = (username: string, id: string) =>
    scope.current(username) &&
    writeLocal(
      scope.scoped(importsKey(username)),
      JSON.stringify({
        v: 1,
        ids: [...readImports(username).filter(x => x !== id), id].slice(
          -identityLimits(username).transfer.browserImportsKept
        ),
      })
    )

  let currentNode: P2pNode | null = null

  let currentStore: P2pStore | null = null

  let currentDms: Dms | null = null

  let currentServers: Servers | null = null

  let currentCalls: Calls | null = null

  let currentPingLog: PingLog | null = null

  let currentBadges: Badges | null = null

  let currentKeeper: BadgeKeeper | null = null

  let currentLeader: TabLeader | null = null

  let currentUnwatch: (() => void) | null = null

  // The limits this account's P2P started with (user_limits.ts).
  let currentLimits: Readonly<Local> = instanceLocal(scope.owner?.conn.info ?? null)

  let currentGen = 0

  // Follower tabs read the database without running a node; the leader tells them what changed.
  let currentReader: { store: P2pStore; me: string } | null = null

  let currentData: {
    postMessage: (m: unknown) => void
    onmessage: ((e: { data: unknown }) => void) | null
    close: () => void
  } | null = null

  // The node's parts above are assigned only by the account's lifecycle (account.ts), through
  // these; every other module reads them.
  const put = {
    node: (x: P2pNode | null) => {
      currentNode = x
      if (scope === legacyScope) node = x
    },
    store: (x: P2pStore | null) => {
      currentStore = x
      if (scope === legacyScope) store = x
    },
    dms: (x: Dms | null) => {
      currentDms = x
      if (scope === legacyScope) dms = x
    },
    servers: (x: Servers | null) => {
      currentServers = x
      if (scope === legacyScope) servers = x
    },
    calls: (x: Calls | null) => {
      currentCalls = x
      if (scope === legacyScope) calls = x
    },
    pingLog: (x: PingLog | null) => {
      currentPingLog = x
      if (scope === legacyScope) pingLog = x
    },
    badges: (x: Badges | null) => {
      currentBadges = x
      if (scope === legacyScope) badges = x
    },
    keeper: (x: BadgeKeeper | null) => {
      currentKeeper = x
      if (scope === legacyScope) keeper = x
    },
    leader: (x: TabLeader | null) => {
      currentLeader = x
      if (scope === legacyScope) leader = x
    },
    unwatch: (x: (() => void) | null) => {
      currentUnwatch = x
      if (scope === legacyScope) unwatch = x
    },
    limits: (x: Readonly<Local>) => {
      currentLimits = x
      if (scope === legacyScope) limits = x
    },
    gen: (x: number) => {
      currentGen = x
      if (scope === legacyScope) gen = x
    },
    reader: (x: { store: P2pStore; me: string } | null) => {
      currentReader = x
      if (scope === legacyScope) reader = x
    },
    data: (
      x: {
        postMessage: (m: unknown) => void
        onmessage: ((e: { data: unknown }) => void) | null
        close: () => void
      } | null
    ) => {
      currentData = x
      if (scope === legacyScope) data = x
    },
  }

  const p2pHost: P2pHost = {
    prefs: () => EMPTY_NOTIFY,
    alert: () => {},
    following: () => false,
    typingOn: () => true,
    toast: () => {},
    textOnly: () => false,
  }

  // Auto-download per account: files up to `dm` bytes in direct messages, images up to `server`
  // bytes in P2P servers, and at most `daily` bytes per contact per day. { v: 1, dm, server, daily }.
  const autoKey = (username: string) => `rchat_p2p_auto:${username}`

  const autoDefaults = (l: Readonly<Local> = LOCAL) => ({
    dm: l.files.autoDm,
    server: l.files.autoServer,
    daily: l.dm.autoDaily,
  })

  // The choices, with the defaults the instance set among them.
  const autoChoices = (l: Readonly<Local> = LOCAL) => ({
    dm: withChoice(l.files.autoDmOptions, l.files.autoDm),
    server: withChoice(l.files.autoServerOptions, l.files.autoServer),
    daily: withChoice(l.files.autoDailyOptions, l.dm.autoDaily),
  })

  const parseAuto = (raw: string | null, l: Readonly<Local> = LOCAL) => {
    const d = autoDefaults(l)
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

  const readAuto = (username: string | null) => {
    const l = instanceLocal((scope.owner?.conn ?? home).info)
    if (!username) return parseAuto(null, l)
    try {
      return parseAuto(readLocal(scope.scoped(autoKey(username))), l)
    } catch {
      return parseAuto(null, l)
    }
  }

  const chatScope = (room: string, ch?: string | null) => (ch ? `p2p:${room}/${ch}` : `p2p:${room}`)

  const threadScope = (t: { room: string; ch: string; root: string }) => `p2p:${threadKey(t)}`

  // The open P2P home survives a reload of this tab.
  const HOME_KEY = 'rchat_p2p_home'

  const readHome = (username: string) => sessionStore.getItem(scope.scoped(HOME_KEY)) === username

  const writeHome = (username: string | null) => {
    if (!scope.current(username ?? undefined)) return
    if (username) sessionStore.setItem(scope.scoped(HOME_KEY), username)
    else sessionStore.removeItem(scope.scoped(HOME_KEY))
  }
  return {
    emptySearch,
    chatKey,
    threadKey,
    initial,
    useP2p,
    p2pKey,
    coversInstance,
    parseOn,
    readOn,
    writeOn,
    identityLimits,
    importsKey,
    parseImports,
    readImports,
    rememberImport,
    put,
    p2pHost,
    autoKey,
    autoDefaults,
    autoChoices,
    parseAuto,
    readAuto,
    chatScope,
    threadScope,
    readHome,
    writeHome,
    get node() {
      return currentNode
    },
    get store() {
      return currentStore
    },
    get dms() {
      return currentDms
    },
    get servers() {
      return currentServers
    },
    get calls() {
      return currentCalls
    },
    get pingLog() {
      return currentPingLog
    },
    get badges() {
      return currentBadges
    },
    get keeper() {
      return currentKeeper
    },
    get leader() {
      return currentLeader
    },
    get unwatch() {
      return currentUnwatch
    },
    get limits() {
      return currentLimits
    },
    get gen() {
      return currentGen
    },
    get reader() {
      return currentReader
    },
    get data() {
      return currentData
    },
  }
}

export const legacyScope: IdentityScope = {
  ...resetHandlers(),
  localId: 'main',
  get host() {
    return home.host
  },
  current: () => true,
  options: {},
  scoped: key => home.scoped(key),
  onDispose: () => {},
}

export const legacyStore = createStorePart(legacyScope)
export const {
  emptySearch,
  chatKey,
  threadKey,
  initial,
  useP2p,
  p2pKey,
  coversInstance,
  parseOn,
  readOn,
  writeOn,
  identityLimits,
  importsKey,
  parseImports,
  readImports,
  rememberImport,
  put,
  p2pHost,
  autoKey,
  autoDefaults,
  autoChoices,
  parseAuto,
  readAuto,
  chatScope,
  threadScope,
  readHome,
  writeHome,
} = legacyStore
// These live exports remain available to direct callers of the home-main facade.
export let node: (typeof legacyStore)['node'] = legacyStore.node
export let store: (typeof legacyStore)['store'] = legacyStore.store
export let dms: (typeof legacyStore)['dms'] = legacyStore.dms
export let servers: (typeof legacyStore)['servers'] = legacyStore.servers
export let calls: (typeof legacyStore)['calls'] = legacyStore.calls
export let pingLog: (typeof legacyStore)['pingLog'] = legacyStore.pingLog
export let badges: (typeof legacyStore)['badges'] = legacyStore.badges
export let keeper: (typeof legacyStore)['keeper'] = legacyStore.keeper
export let leader: (typeof legacyStore)['leader'] = legacyStore.leader
export let unwatch: (typeof legacyStore)['unwatch'] = legacyStore.unwatch
export let limits: (typeof legacyStore)['limits'] = legacyStore.limits
export let gen: (typeof legacyStore)['gen'] = legacyStore.gen
export let reader: (typeof legacyStore)['reader'] = legacyStore.reader
export let data: (typeof legacyStore)['data'] = legacyStore.data
