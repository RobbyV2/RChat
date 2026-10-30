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
  type Arrival,
  type P2pMessage,
} from './dm'
import type { Fwd } from './event'
import { TabLeader, webLeaderDeps } from './leader'
import { P2pNode, SQUATTED, type Presence, type Status, type Visibility } from './node'
import { PeerTransport } from './transport'

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
}

export const p2pHost: P2pHost = {
  prefs: () => EMPTY_NOTIFY,
  alert: () => {},
  following: () => false,
  typingOn: () => true,
  toast: () => {},
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
  window.addEventListener('pagehide', () => node?.stop())
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
    elsewhere: false,
    error: v.status === 'squatted' ? SQUATTED : null,
  })
  const card = await n.myCard().catch(() => null)
  if (node === n) useP2p.setState({ card })
}

const stopNode = () => {
  unwatch?.()
  unwatch = null
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
        const room = (e.data as { room?: unknown } | null)?.room
        if (typeof room !== 'string') return
        void refreshRoom(room)
        void s.contacts().then(
          contacts => reader?.store === s && useP2p.setState({ contacts }),
          () => {}
        )
      }
      data = ch
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
    const d = new Dms({ node: n, store: s })
    dms = d
    data = dataChannel(username)
    d.onChange(room => {
      data?.postMessage({ room })
      scheduleRefresh(room)
    })
    d.onArrive(a => arrived(a))
    void d.recheckOutbox().catch(() => {})
    unwatch = n.onChange(() => void mirror())
    useP2p.setState({ enabled: true, loading: false, reader: false, me: n.ik })
    await mirror()
    if (node !== n) return
    await refreshRooms()
    const chat = useP2p.getState().chat
    if (chat) await loadChat(chat.room, chat.peer)
    await n.start()
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
    const now = useP2p.getState().chat
    if (now?.room !== room) return
    useP2p.setState({ chat: { ...now, messages, more, loading: false } })
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
    if (m.sender === me && !m.fwd) return m
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
    if (!body) return false
    const sed = parseSed(text)
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
    const st = useP2p.getState()
    const reply = st.replying?.room === room ? st.replying.id : undefined
    useP2p.setState({ replying: null })
    const id = await withDms(d => d.send(room, { body: text, reply }))
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
