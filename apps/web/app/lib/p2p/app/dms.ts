import { resolve as resolveNotify } from '../../notify'
import { applySed, parseSed } from '../../sed'
import type { UserRef } from '../../types'
import type { RoomRecord } from '../db'
import { displayName } from '../contacts'
import { p2pAlert } from '../alerts'
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
} from '../dm'
import type { Fwd } from '../content'
import { JUMP, type PageOpts } from '../jump'
import { Servers, type ServerView } from '../server'
import {
  store,
  reader,
  node,
  useP2p,
  servers,
  dms,
  pingLog,
  p2pHost,
  chatScope,
  chatKey,
  threadKey,
  writeHome,
  type RoomSummary,
  type P2pChat,
} from './store'
import {
  readerView,
  loadChannel,
  refreshServer,
  withServers,
  p2pThread,
  readSlow,
  p2pServer,
} from './servers'
import { readMissed, missedKey, ELSEWHERE_TEXT } from './calls'
import { p2p } from './account'
import { p2pFiles } from './attachments'

// ----- Direct messages -----

export const dbNow = () => store ?? reader?.store ?? null

export const meNow = () => node?.ik ?? reader?.me ?? null

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

export const refreshRooms = async () => {
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
export let jumpGen = 0

// A page of the open conversation or channel.
const chatPage = (chat: P2pChat, o: PageOpts) => {
  const s = dbNow()
  const me = meNow()
  if (chat.ch) return servers ? servers.loadChannel(chat.room, chat.ch, o) : Promise.resolve(null)
  return s && me ? loadMessages(s.db, chat.room, me, chat.peer, o) : Promise.resolve(null)
}

// Opened at a message, the view keeps its place when the conversation changes (an old copy's
// rows above a new copy's stay as they are).
export const refreshWindow = async (cur: P2pChat) => {
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

export const loadChat = async (room: string, peer: string, keep = false) => {
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

export const refreshRoom = async (room: string) => {
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

export const timers = new Map<string, ReturnType<typeof setTimeout>>()

export const loadPinList = async (room: string) => {
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

export const contactName = (ik: string) => {
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
export const arrived = (a: Arrival) => {
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

export const findMessage = (id: string) => {
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
