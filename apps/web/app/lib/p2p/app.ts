import { create } from 'zustand'
import { home, writeLocal } from '../instances'
import type { AlertInput } from '../notices'
import { EMPTY_NOTIFY, resolve as resolveNotify, type NotifyPrefs } from '../notify'
import { applySed, parseSed } from '../sed'
import type { UserRef } from '../types'
import { dbName, P2pStore, removeP2pDb, type RoomRecord } from './db'
import { fingerprint, keyId } from './keys'
import { displayName, type AddResult, type Contact } from './contacts'
import { p2pAlert } from './alerts'
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
import { contentMax, LIMITS as EV, sizeOf, type Attachment, type Fwd } from './event'
import { assemble, EMPTY_VIEW, type BlobView, type Usage } from './blobs'
import type { Hashed } from './hashing'
import {
  checkedThumb,
  freeSpace,
  hashFile,
  imageFits,
  previewOf,
  saveName,
  storageSpace,
  type Preview,
} from './files'
import { kindOf, NEUTRAL_TYPE } from '../sniff'
import { sharing } from '../platform'
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
import { RtcManager } from '../rtc'
import { hidesIp, relayBook } from '../relays'
import { Calls, type CallView, type PendingCall } from './calls'

// The P2P view model. IndexedDB (through the node) is the source of truth; this store only
// mirrors what the UI shows. One node per signed-in account; guests never get one.

export type P2pDialog =
  | { kind: 'add'; tab?: 'scan' | 'paste' | 'mine' }
  | { kind: 'verify'; ik: string }
  | { kind: 'rename'; ik: string }
  | { kind: 'contact'; ik: string }
  | { kind: 'enable' }

// One conversation in the list.
export interface RoomSummary {
  id: string
  peer: string
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

// The open conversation: the newest messages (older pages load on scroll).
export interface P2pChat {
  room: string
  peer: string
  messages: P2pMessage[]
  more: boolean
  loading: boolean
  // The read marker when the conversation was opened: the unread line goes after it.
  readSeq: number
  // Calls missed here that the caller hasn't logged (yet).
  missed: MissedCall[]
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
  drafts: Record<string, string>
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
  drafts: {},
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
const IMPORTS_KEPT = 50

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
  onChange: fn => {
    if (typeof document === 'undefined') return () => {}
    document.addEventListener('visibilitychange', fn)
    return () => document.removeEventListener('visibilitychange', fn)
  },
}

let node: P2pNode | null = null
let store: P2pStore | null = null
let dms: Dms | null = null
let calls: Calls | null = null
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
  toast: (text: string) => void
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
export const AUTO_DEFAULT = { dm: 10 * 1024 * 1024, server: 5 * 1024 * 1024, daily: AUTO_DAILY }
export const AUTO_DAILY_OPTIONS = [256 * 1024 ** 2, 1024 ** 3, 4 * 1024 ** 3, 16 * 1024 ** 3]
export const AUTO_DM = [0, 1, 10, 25, 100].map(n => n * 1024 * 1024)
export const AUTO_SERVER = [0, 1, 5, 10].map(n => n * 1024 * 1024)

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

export const chatScope = (room: string) => `p2p:${room}`

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
  window.addEventListener('pagehide', () => {
    // The other side of a call hears `end` before the sessions close.
    calls?.stop()
    node?.stop()
  })
  window.addEventListener('pageshow', e => {
    if (e.persisted && node) void node.start()
  })
}

const dbFor = (username: string) => dbName(home.host, username)

const mirror = async () => {
  const n = node
  if (!n) return
  const v = n.view()
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
    elsewhere: false,
    error: v.status === 'squatted' ? SQUATTED : null,
  })
  const card = await n.myCard().catch(() => null)
  if (node === n) useP2p.setState({ card })
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
  const { account, enabled, home: h, dialog, chat, drafts } = useP2p.getState()
  return {
    ...initial,
    account,
    enabled,
    home: h,
    dialog,
    drafts,
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
        const msg = e.data as { room?: unknown; call?: unknown } | null
        if (msg && 'call' in msg) return useP2p.setState({ callElsewhere: elsewhereCall(msg.call) })
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
    })
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
      busy: () => p2pHost.inCall(),
      muted: () => p2pHost.muted(),
      save: p => void s.setMeta(PENDING_CALL, p).catch(() => {}),
      notice: text => p2pHost.toast(text),
      leaveOthers: () => p2pHost.leaveInstanceCalls(),
    })
    calls = c
    n.use({ attach: x => c.attach(x), ready: x => c.ready(x) })
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
    await refreshRooms()
    const chat = useP2p.getState().chat
    if (chat) await loadChat(chat.room, chat.peer)
    await n.start()
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
  useP2p.setState({ ...initial, account: username, home: keepHome })
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
  useP2p.setState({ rooms: Object.fromEntries(list.map(r => [r.id, summary(r)])) })
}

const loadChat = async (room: string, peer: string, keep = false) => {
  const s = dbNow()
  const me = meNow()
  if (!s || !me) return
  const cur = useP2p.getState().chat
  const limit = keep && cur?.room === room ? Math.max(PAGE, cur.messages.length) : PAGE
  try {
    const { messages, more } = await loadMessages(s.db, room, me, peer, { limit })
    const missed = readMissed(await s.meta<unknown>(missedKey(room)).catch(() => undefined))
    const now = useP2p.getState().chat
    if (now?.room !== room) return
    useP2p.setState({ chat: { ...now, messages, more, loading: false, missed } })
  } catch {
    // Storage went away (sign out, Remove P2P data).
  }
}

const refreshRoom = async (room: string) => {
  const s = dbNow()
  if (!s) return
  const r = await s.room(room).catch(() => undefined)
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

// The media of calls with contacts: rtc.ts, signaled over the session and with the ICE plan of
// the call (relays.ts), so relay only and the relay prompt work as in instance P2P calls.
export const callRtc = new RtcManager({
  signaler: { send: (to, target, payload) => calls?.signaler.send(to, target, payload) },
  ice: () => calls?.config() ?? { iceServers: [], iceTransportPolicy: 'relay' },
})

export const CALL_ELSEWHERE = 'Call in another tab.'
const ELSEWHERE_TEXT = 'P2P is open in another tab.'

const callFailed = (e: unknown) => p2pHost.toast(e instanceof Error ? e.message : String(e))

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

// Object URLs of stored files shown inline (only of types sniffing allows), newest last.
const urls = new Map<string, Promise<string | null>>()
// Stored images whose header says they are too large to show inline.
const big = new Set<string>()
const URLS_MAX = 24

const dropUrl = (h: string) => {
  const u = urls.get(h)
  if (!u) return
  urls.delete(h)
  void u.then(x => x && URL.revokeObjectURL(x))
}

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
export const fitAttachments = (body: string, list: Attachment[]): Attachment[] | null => {
  const out = list.map(a => ({ ...a }))
  const fits = () => sizeOf({ body, att: out }) <= contentMax({ att: out })
  for (let i = out.length - 1; i >= 0 && !fits(); i -= 1) delete out[i].thumb
  return fits() ? out : null
}

export const TOO_MANY_FILES = 'These files have names too long to send in one message.'
export const FILES_MAX_TEXT = `You can attach up to ${EV.att} files to a message.`
export const PREPARING_TEXT = 'Files are still being prepared.'
export const BIG_FILE = 1024 ** 3

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

  // The stored file as a URL, for the passive players only (by its sniffed type).
  url(h: string): Promise<string | null> {
    const hit = urls.get(h)
    if (hit) {
      urls.delete(h)
      urls.set(h, hit)
      return hit
    }
    const run = (async () => {
      const s = dbNow()
      const blob = s ? await assemble(s.db, h).catch(() => null) : null
      if (!blob || kindOf(blob.type) === null) return null
      if (kindOf(blob.type) === 'image' && !(await imageFits(blob))) {
        big.add(h)
        void refreshFile(h)
        return null
      }
      return URL.createObjectURL(blob)
    })()
    urls.set(h, run)
    while (urls.size > URLS_MAX) dropUrl(urls.keys().next().value as string)
    return run
  },

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

const findMessage = (id: string) => useP2p.getState().chat?.messages.find(m => m.id === id)

// The newest message of ours that can be edited.
const lastEditable = () => {
  const { chat, me } = useP2p.getState()
  if (!chat) return null
  for (let i = chat.messages.length - 1; i >= 0; i -= 1) {
    const m = chat.messages[i]
    if (m.sender === me && !m.fwd && !m.call) return m
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
    const page = await loadMessages(s.db, chat.room, me, chat.peer, {
      before: first?.sortKey,
    }).catch(() => null)
    const now = useP2p.getState().chat
    if (now?.room !== chat.room) return
    useP2p.setState({
      chat: page
        ? { ...now, messages: [...page.messages, ...now.messages], more: page.more, loading: false }
        : { ...now, loading: false },
    })
  },

  // Older history from the other side (past the backfill horizon).
  loadOlderHistory() {
    const room = chatRoom()
    if (room && dms) {
      dms.loadOlder(room)
      useP2p.setState({ pulling: true })
    }
  },

  async jumpTo(id: string) {
    const st = useP2p.getState()
    const s = dbNow()
    const me = meNow()
    const chat = st.chat
    if (!s || !me || !chat) return
    if (!chat.messages.some(m => m.id === id)) {
      const around = await loadAround(s.db, chat.room, me, chat.peer, id).catch(() => null)
      if (!around) return
      const now = useP2p.getState().chat
      if (now?.room !== chat.room) return
      useP2p.setState({ chat: { ...now, messages: around.messages, more: around.more } })
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
      const last = lastEditable()
      const next = last ? applySed(last.body, sed) : null
      if (!last || next === null) return false
      if (bodyTooLong(next)) {
        p2pHost.toast(TOO_LONG_TEXT)
        return false
      }
      return (await withDms(d => d.edit(room, last.id, next))) !== null
    }
    const att = files ? await p2pFiles.stage(room, text) : []
    if (att === null) return false
    const st = useP2p.getState()
    const reply = st.replying?.room === room ? st.replying.id : undefined
    useP2p.setState({ replying: null })
    const id = await withDms(d => d.send(room, { body: text, reply, att }))
    if (id !== null && files) p2pFiles.clear(room)
    return id !== null
  },

  async forward(room: string, fwd: Fwd) {
    const clipped = { ...fwd, name: clipName(fwd.name) }
    return (await withDms(d => d.send(room, { body: '', fwd: clipped }))) !== null
  },

  // A failed message: send it again, or say why it can't be.
  retry(id: string) {
    const room = chatRoom()
    return room ? withDms(d => d.retry(room, id)) : Promise.resolve(null)
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
    const m = lastEditable()
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
    await withDms(d => d.edit(e.room, e.id, e.text))
  },

  remove: (id: string) => {
    const room = chatRoom()
    return room ? withDms(d => d.redact(room, id)) : Promise.resolve(null)
  },

  react(id: string, key: string, on?: boolean) {
    const room = chatRoom()
    const m = findMessage(id)
    if (!room || !m) return Promise.resolve(null)
    const mine = m.reactions.find(r => r.key === key)?.me === true
    return withDms(d => d.react(room, id, key, on ?? !mine))
  },

  pin(id: string, on: boolean) {
    const room = chatRoom()
    return room ? withDms(d => d.pin(room, id, on)) : Promise.resolve(null)
  },

  async openPins() {
    const room = chatRoom()
    if (!room) return
    useP2p.setState({ pins: { room, list: null } })
    await loadPinList(room)
  },

  closePins: () => useP2p.setState({ pins: null }),

  markRead(room: string) {
    const r = useP2p.getState().rooms[room]
    if (!r || (!r.unread && !r.pings)) return
    void withDms(d => d.markRead(room))
  },

  typing(room: string, on: boolean) {
    if (!p2pHost.typingOn()) return
    dms?.typing(room, on)
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
    useP2p.setState({ ...initial, account: username })
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
  resetIdentity: () => withNode(n => n.resetIdentity()),
  resumeSending: () => withNode(n => n.resumeSending()),
  clearAlert: () => withNode(n => n.clearAlert()),
  clearDropped: () => withNode(n => n.clearDropped()),
  // Moves P2P from the tab that runs it to this one.
  useHere: () => leader?.takeOver(),

  openHome: () => {
    writeHome(useP2p.getState().account)
    useP2p.setState({ home: true })
  },
  closeHome: () => {
    writeHome(null)
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
