import { altError, altText, describableFile, editAltsFor } from '../../alt_text'
import { resolve as resolveNotify } from '../../notify'
import { applySed, parseSed } from '../../sed'
import type { UserRef } from '../../types'
import { dmRootOf, type RoomRecord } from '../db'
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
  loadStore,
  loadPins,
  threadPingTotal,
  type Arrival,
} from '../dm'
import type { Attachment, Fwd } from '../content'
import type { PageOpts } from '../jump'
import { sealEarlier } from '../seal_earlier'
import { ServerError, Servers } from '../server'
import { channelReadSkips, threadsSig } from './servers'
import { typingResendMs } from '../sync'
import type { RoomSummary, P2pChat } from './store'
import type { IdentityScope, P2pParts } from './scope'
import { time } from '../../platform/time'
import type { Cancel } from '../../clock'

export function createDmsPart(
  parts: Pick<P2pParts, 'store' | 'servers' | 'calls' | 'account' | 'attachments'>,
  scope: IdentityScope
) {
  const state = parts.store
  const { useP2p, p2pHost, chatKey, threadKey, threadScope, chatScope, writeHome } = state

  // ----- Direct messages -----

  const dbNow = () => state.store ?? state.reader?.store ?? null

  const meNow = () => state.node?.ik ?? state.reader?.me ?? null

  // The home app can be reused for another account while a storage read is pending.
  const currentSession = () => {
    const signal = scope.resetSignal()
    const store = dbNow()
    return () => !signal.aborted && scope.current() && dbNow() === store
  }

  const summary = (r: RoomRecord): RoomSummary => ({
    id: r.id,
    peer: r.peer,
    seq: r.lastSeq,
    unread: r.unread,
    pings: r.pings + threadPingTotal(r.threads),
    threads: r.threads,
    lastTs: r.lastTs,
    count: r.count,
    bytes: r.bytes ?? 0,
    full: r.full,
    fullWhy: r.fullWhy,
    peerFull: !!r.peerFull,
    gap: r.missing.length > 0,
  })

  const refreshRooms = async () => {
    const current = currentSession()
    const s = dbNow()
    if (!s) return
    const list = await s.rooms()
    if (!current()) return
    const dms = list.filter(r => r.kind !== 'server')
    const stores = await Promise.all(
      dms.map(r => loadStore(s.db, r.id, state.limits).catch(() => undefined))
    )
    if (!current()) return
    useP2p.setState({
      rooms: Object.fromEntries(dms.map((r, i) => [r.id, { ...summary(r), store: stores[i] }])),
    })
    const reader = state.reader
    if (reader?.store === s) {
      const views = await Promise.all(
        list
          .filter(r => r.kind === 'server' && !r.invite)
          .map(r => parts.servers.readerView(s, r, reader.me))
      )
      if (current()) useP2p.setState({ servers: Object.fromEntries(views.map(v => [v.id, v])) })
    }
  }

  // Moves on each jump to a message loaded around it: pages that started loading before are dropped.
  let jumpRevision = 0

  // A page of the open conversation or channel.
  const chatPage = (chat: P2pChat, o: PageOpts) => {
    const s = dbNow()
    const me = meNow()
    if (chat.ch)
      return state.servers
        ? state.servers.loadChannel(chat.room, chat.ch, o)
        : Promise.resolve(null)
    return s && me
      ? loadMessages(s.db, chat.room, me, chat.peer, o, state.limits)
      : Promise.resolve(null)
  }

  // Opened at a message, the view keeps its place when the conversation changes (an old copy's
  // rows above a new copy's stay as they are).
  const refreshWindow = async (cur: P2pChat) => {
    const current = currentSession()
    const archived = cur.messages.filter(m => m.archived)
    const first = cur.messages.find(m => !m.archived)
    if (!first) return
    const gen = jumpRevision
    const page = await chatPage(cur, {
      from: first.sortKey,
      limit: Math.max(state.limits.dm.page, cur.messages.length),
      newer: true,
    }).catch(() => null)
    const now = useP2p.getState().chat
    if (!current() || !page || now?.room !== cur.room || now.ch !== cur.ch || gen !== jumpRevision)
      return
    useP2p.setState({
      chat: { ...now, messages: [...archived, ...page.messages], newer: page.more, loading: false },
    })
  }

  const loadChat = async (room: string, peer: string, keep = false) => {
    const current = currentSession()
    const s = dbNow()
    const me = meNow()
    if (!s || !me) return
    const cur = useP2p.getState().chat
    if (cur?.ch && cur.room === room) return parts.servers.loadChannel(room, cur.ch, keep)
    if (keep && cur?.room === room && cur.newer) return refreshWindow(cur)
    const page = state.limits.dm.page
    const limit = keep && cur?.room === room ? Math.max(page, cur.messages.length) : page
    const gen = jumpRevision
    try {
      const { messages, more } = await loadMessages(s.db, room, me, peer, { limit }, state.limits)
      if (!current()) return
      const missed = parts.calls.readMissed(
        await s.meta<unknown>(parts.calls.missedKey(room)).catch(() => undefined)
      )
      const now = useP2p.getState().chat
      if (!current() || now?.room !== room || gen !== jumpRevision) return
      useP2p.setState({ chat: { ...now, messages, more, newer: false, loading: false, missed } })
    } catch {
      // Storage went away (sign out, Remove P2P data): the conversation stops loading.
      const now = useP2p.getState().chat
      if (current() && now?.room === room && !now.ch && now.loading && gen === jumpRevision)
        useP2p.setState({ chat: { ...now, loading: false } })
    }
  }

  const refreshRoom = async (room: string) => {
    const current = currentSession()
    const s = dbNow()
    if (!s) return
    if (state.servers?.isServer(room)) return parts.servers.refreshServer(room)
    const r = await s.room(room).catch(() => null)
    if (!current() || r === null) return
    const reader = state.reader
    if (reader?.store === s && (r?.kind === 'server' || useP2p.getState().servers[room])) {
      const view =
        r?.kind === 'server' && !r.invite ? await parts.servers.readerView(s, r, reader.me) : null
      if (!current()) return
      useP2p.setState(st => {
        const servers = { ...st.servers }
        if (view) servers[room] = view
        else delete servers[room]
        return { servers }
      })
      return
    }
    if (r?.kind === 'server') return
    if (r) {
      const store = await loadStore(s.db, room, state.limits).catch(() => undefined)
      if (!current()) return
      useP2p.setState(st => ({ rooms: { ...st.rooms, [room]: { ...summary(r), store } } }))
    }
    if (state.dms && useP2p.getState().storageFull !== state.dms.storageFull)
      useP2p.setState({ storageFull: state.dms.storageFull })
    const st = useP2p.getState()
    // The conversation's typers, and the open thread's (`{room}#{root}`); closed threads' go.
    const mine = (k: string) => k === room || k.startsWith(`${room}#`)
    const typing: Record<string, string[]> = Object.fromEntries(
      Object.entries(st.typing).filter(([k]) => !mine(k))
    )
    typing[room] = state.dms ? state.dms.typingIn(room) : []
    const th = st.thread
    if (th?.room === room && !th.ch) {
      const inThread = state.dms ? state.dms.typingIn(room, th.root) : []
      if (inThread.length) typing[threadKey(th)] = inThread
    }
    const sig = (x: Record<string, string[]>) =>
      JSON.stringify(
        Object.entries(x)
          .filter(([k]) => mine(k))
          .sort()
      )
    if (sig(st.typing) !== sig(typing)) useP2p.setState({ typing })
    if (st.chat?.room === room) {
      await loadChat(room, st.chat.peer, true)
      if (!current()) return
      useP2p.setState({ pulling: state.dms?.sync.pulling(room) ?? false })
    }
    if (st.pins?.room === room) await loadPinList(room)
    if (st.thread?.room === room) await parts.servers.loadThread(true)
  }

  const timers = new Map<string, Cancel>()

  const loadPinList = async (room: string) => {
    const current = currentSession()
    const chat = useP2p.getState().chat
    if (chat?.ch && chat.room === room) {
      const list = state.servers
        ? await state.servers.loadPins(room, chat.ch).catch(() => null)
        : null
      if (current() && useP2p.getState().pins?.room === room)
        useP2p.setState({ pins: { room, list } })
      return
    }
    const s = dbNow()
    const me = meNow()
    const peer = useP2p.getState().rooms[room]?.peer ?? useP2p.getState().chat?.peer
    if (!s || !me || !peer) return
    const list = await loadPins(s.db, room, me, peer, state.limits).catch(() => null)
    if (current() && useP2p.getState().pins?.room === room)
      useP2p.setState({ pins: { room, list } })
  }

  const contactName = (ik: string) => {
    const c = useP2p.getState().contacts.find(x => x.ik === ik)
    return c ? displayName(c) : 'Someone'
  }

  const p2pUser = (ik: string, name = contactName(ik)): UserRef => ({
    username: ik,
    display_name: name,
    avatar_kind: 'identicon',
    avatar_color: null,
  })

  // A new event from the other side: toasts and desktop notifications follow the conversation's
  // notification level, like an instance DM. Reading the conversation at the bottom marks it read.
  const arrived = (a: Arrival) => {
    if (a.ping) state.pingLog?.note(a.room, null, a.ping, a.rec, a.thread)
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
      : st.home && st.chat?.room === a.room && p2pHost.following(chatScope(a.room)) && visible
    if (watched) {
      if (a.thread) time().after(0, () => void parts.servers.p2pThread.markRead())
      else void state.dms?.markRead(a.room)
      return
    }
    const rule = resolveNotify(p2pHost.prefs(), { kind: 'p2p', room: a.room }, time().now())
    const current = currentSession()
    const alert = p2pAlert(a, rule, p2pUser(a.peer), () => {
      if (!current()) return
      parts.account.p2p.openHome()
      void p2pDm.openDm(a.peer).then(() => {
        if (current() && a.thread) void p2pDm.jumpTo(a.rec.id)
      })
    })
    if (alert) p2pHost.alert(alert)
  }

  // Thread counters already checked on a read, at a stored position, so reading at the bottom
  // again doesn't redo it (as for server channels).
  const readChecked = new Map<string, string>()

  // Reads a conversation: thread pings whose reply or root is gone come off with it, and the log
  // notes them as seen. The counters are taken before the log, so a ping that arrives meanwhile
  // stays counted.
  const readConversation = async (d: Dms, room: string) => {
    const counts = await d.threadCounts(room)
    const pings = state.pingLog ? await state.pingLog.threadPings(room, null) : []
    const dead = await d.readConversation(room, pings, counts)
    if (dead.length) await state.pingLog?.seen(dead)
    const after = await dbNow()
      ?.room(room)
      .catch(() => undefined)
    if (after) {
      const s = summary(after)
      readChecked.set(room, threadsSig(s, s.seq))
    }
  }

  const withDms = async <T>(fn: (d: Dms) => Promise<T>): Promise<T | null> => {
    const current = currentSession()
    const d = state.dms
    if (!d) return null
    try {
      const result = await fn(d)
      return current() ? result : null
    } catch (e) {
      if (current())
        p2pHost.toast(e instanceof DmError || e instanceof Error ? e.message : String(e))
      return null
    }
  }

  const chatRoom = () => useP2p.getState().chat?.room ?? null

  // Where a draft key ("{room}", "{room}#{root}", "{room}/{channel}" or
  // "{room}/{channel}#{root}") sends to.
  type Target =
    | { kind: 'dm'; room: string; thread: string | null }
    | { kind: 'server'; room: string; ch: string; thread: string | null }

  const targetOf = (key: string): Target => {
    const [place, thread] = key.split('#')
    const i = place.indexOf('/')
    if (i < 0) return { kind: 'dm', room: place, thread: thread ?? null }
    return {
      kind: 'server',
      room: place.slice(0, i),
      ch: place.slice(i + 1),
      thread: thread ?? null,
    }
  }

  // The open conversation or channel, as a draft key.
  const openKey = () => {
    const c = useP2p.getState().chat
    return c ? chatKey(c) : null
  }

  // Runs a DM action or a server one for a draft key.
  const onTarget = <T>(
    key: string,
    dm: (d: Dms, room: string, thread: string | null) => Promise<T>,
    server: (s: Servers, room: string, ch: string, thread: string | null) => Promise<T>
  ): Promise<T | null> => {
    const t = targetOf(key)
    return t.kind === 'dm'
      ? withDms(d => dm(d, t.room, t.thread))
      : parts.servers.withServers(s => server(s, t.room, t.ch, t.thread))
  }

  // The message a draft key's place gets: `body`, a reply to `reply`, files `att`.
  const messageFor = (t: Target, body: string, opts: { reply?: string; att?: Attachment[] }) => ({
    body,
    reply: opts.reply,
    att: opts.att ?? [],
    ...(t.thread ? { thread: t.thread } : {}),
  })

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

  const p2pDm = {
    // Opens the conversation with a contact in the P2P home, or beside the instance's DM list
    // (`dms`), which a reload doesn't bring back.
    async openDm(ik: string, where: 'home' | 'dms' = 'home', selected = () => true) {
      const current = currentSession()
      const me = meNow()
      if (!me) return
      const room = dmRoomId(me, ik)
      if (state.dms) await state.dms.open(ik).catch(() => null)
      if (!current()) return
      const r = await dbNow()
        ?.room(room)
        .catch(() => undefined)
      if (!current() || !selected()) return
      writeHome(where === 'home' ? useP2p.getState().account : null)
      useP2p.setState(st => ({
        home: true,
        dmList: where === 'dms',
        server: null,
        dialog: null,
        chat: {
          room,
          peer: ik,
          messages: st.chat?.room === room ? st.chat.messages : [],
          more: false,
          loading: st.chat?.room !== room,
          readSeq: r?.readSeq ?? 0,
          unread: r?.unread ?? 0,
          unreadSeq: r?.lastSeq ?? 0,
          missed: st.chat?.room === room ? st.chat.missed : [],
        },
        pins: null,
        threads: null,
        thread: st.thread?.room === room ? st.thread : null,
        panel: st.panel === 'thread' && st.thread?.room !== room ? null : st.panel,
        editing: null,
        pulling: false,
        rooms: r
          ? { ...st.rooms, [room]: { ...summary(r), store: st.rooms[room]?.store } }
          : st.rooms,
      }))
      await loadChat(room, ik)
    },

    // The room with a contact, created when it is first used. Null without a running node.
    async ensureRoom(ik: string) {
      const current = currentSession()
      const d = state.dms
      if (!d) return null
      const r = await d.open(ik).catch(() => null)
      if (!current()) return null
      if (r)
        useP2p.setState(st => ({
          rooms: { ...st.rooms, [r.id]: { ...summary(r), store: st.rooms[r.id]?.store } },
        }))
      return r?.id ?? null
    },

    closeDm: () =>
      useP2p.setState(st => ({
        chat: null,
        pins: null,
        threads: null,
        editing: null,
        replying: null,
        ...(st.server ? {} : { thread: null, panel: st.panel === 'thread' ? null : st.panel }),
      })),
    // Encrypts the earlier messages this device stored of `room` without changing its switch:
    // where the site requires encrypted storage and the conversation's own switch is off.
    sealEarlierHere(room: string) {
      const s = state.store
      if (s) void sealEarlier(s, room, state.limits.search).catch(() => {})
    },
    // Turns "Encrypt stored messages" of a conversation on or off; either participant may.
    async setStore(room: string, on: boolean, earlier = false) {
      const d = state.dms
      if (!d) return
      try {
        await d.setStore(room, on, earlier)
      } catch (e) {
        p2pHost.toast(e instanceof Error ? e.message : String(e))
      }
    },

    async loadOlderPage() {
      const current = currentSession()
      const st = useP2p.getState()
      const s = dbNow()
      const me = meNow()
      const chat = st.chat
      if (!s || !me || !chat || !chat.more || chat.loading) return
      useP2p.setState({ chat: { ...chat, loading: true } })
      const first = chat.messages[0]
      const sv = state.servers
      const page = await (
        chat.ch
          ? sv
            ? sv.loadChannel(chat.room, chat.ch, { before: first?.sortKey })
            : Promise.resolve(null)
          : loadMessages(s.db, chat.room, me, chat.peer, { before: first?.sortKey }, state.limits)
      ).catch(() => null)
      const now = useP2p.getState().chat
      if (!current() || now?.room !== chat.room || now.ch !== chat.ch) return
      useP2p.setState({
        chat: page
          ? {
              ...now,
              messages: [...page.messages, ...now.messages],
              more: page.more,
              loading: false,
            }
          : { ...now, loading: false },
      })
    },

    // Opened at a message: the next messages after the last one loaded.
    async loadNewerPage() {
      const current = currentSession()
      const chat = useP2p.getState().chat
      if (!chat?.newer || chat.loading) return
      useP2p.setState({ chat: { ...chat, loading: true } })
      const last = chat.messages[chat.messages.length - 1]
      const page = await chatPage(chat, {
        after: last?.sortKey,
        limit: state.limits.misc.jumpAfter,
        newer: true,
      }).catch(() => null)
      const now = useP2p.getState().chat
      if (!current() || now?.room !== chat.room || now.ch !== chat.ch) return
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
      jumpRevision += 1
      useP2p.setState({ chat: { ...chat, newer: false } })
      await (chat.ch
        ? parts.servers.loadChannel(chat.room, chat.ch)
        : loadChat(chat.room, chat.peer))
    },

    // Older history from the other side (past the backfill horizon).
    loadOlderHistory() {
      const chat = useP2p.getState().chat
      if (!chat) return
      if (chat.ch) state.servers?.loadOlder(chat.room)
      else state.dms?.loadOlder(chat.room)
      useP2p.setState({ pulling: true })
    },

    async jumpTo(id: string) {
      const current = currentSession()
      const st = useP2p.getState()
      const s = dbNow()
      const me = meNow()
      const chat = st.chat
      if (!s || !me || !chat) return
      const root = chat.ch
        ? await state.servers?.threadOf(id).catch(() => null)
        : await s
            .event(id)
            .then(r => (r ? dmRootOf(r, x => s.event(x)) : null))
            .catch(() => null)
      if (!current()) return
      if (root) return parts.servers.p2pThread.open(root, id)
      if (!chat.messages.some(m => m.id === id)) {
        const sv = state.servers
        const around = await (
          chat.ch
            ? sv
              ? sv.loadAround(chat.room, chat.ch, id)
              : Promise.resolve(null)
            : loadAround(s.db, chat.room, me, chat.peer, id, state.limits)
        ).catch(() => null)
        if (!around) return
        const now = useP2p.getState().chat
        if (!current() || now?.room !== chat.room || now.ch !== chat.ch) return
        // A page loading from before the jump would replace the messages around it.
        jumpRevision += 1
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
      const current = currentSession()
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
        const alts = editAltsFor(last.att)
        return (
          (await onTarget(
            room,
            (d, r) => d.edit(r, last.id, next, alts),
            (sv, r) => sv.edit(r, last.id, next, alts)
          )) !== null
        )
      }
      const att = files ? await parts.attachments.p2pFiles.stage(room, text) : []
      if (!current() || att === null) return false
      const st = useP2p.getState()
      const reply = st.replying?.room === room ? st.replying.id : undefined
      const msg = messageFor(targetOf(room), text, { reply, att })
      const id = await onTarget(
        room,
        (d, r) => d.send(r, msg),
        (sv, r, ch) => sv.send(r, { ch, ...msg })
      )
      // A failed send keeps what it replied to.
      if (!current()) return false
      const now = useP2p.getState().replying
      if (id !== null && reply && now?.room === room && now.id === reply)
        useP2p.setState({ replying: null })
      if (id !== null && files) parts.attachments.p2pFiles.clear(room)
      const t = targetOf(room)
      if (current() && t.kind === 'server') await parts.servers.readSlow(t.room, t.ch)
      if (current() && id !== null && useP2p.getState().chat?.newer) void p2pDm.toPresent()
      return current() && id !== null
    },

    // Sends `body` to a draft key's place now, apart from the composer: no sed, no reply bar and
    // no files being attached. The event id; throws why it can't be sent.
    async post(key: string, body: string, opts: { reply?: string; att?: Attachment[] } = {}) {
      const t = targetOf(key)
      const msg = messageFor(t, body, opts)
      if (t.kind === 'dm') {
        const d = state.dms
        if (!d) throw new DmError(parts.calls.ELSEWHERE_TEXT)
        return d.send(t.room, msg)
      }
      const sv = state.servers
      if (!sv) throw new ServerError(parts.calls.ELSEWHERE_TEXT)
      const id = await sv.send(t.room, { ch: t.ch, ...msg })
      await parts.servers.readSlow(t.room, t.ch)
      return id
    },

    // `room` is a draft key: a conversation, or a server channel.
    async forward(room: string, fwd: Fwd) {
      const current = currentSession()
      const clipped = { ...fwd, name: clipName(fwd.name) }
      const id = await onTarget(
        room,
        (d, r, thread) => d.send(r, { body: '', fwd: clipped, ...(thread ? { thread } : {}) }),
        (sv, r, ch, thread) =>
          sv.send(r, { ch, body: '', fwd: clipped, ...(thread ? { thread } : {}) })
      )
      const t = targetOf(room)
      if (current() && t.kind === 'server') await parts.servers.readSlow(t.room, t.ch)
      return current() && id !== null
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
      useP2p.setState(s => ({
        replying: { room, id },
        editing: null,
        composerFocus: { key: room, n: (s.composerFocus?.n ?? 0) + 1 },
      }))
    },

    cancelReply: () => useP2p.setState({ replying: null }),

    startEdit(room: string, id: string) {
      const m = findMessage(id)
      if (!m) return
      // An edit needs text, so a message without any can't change its description.
      const image = m.body.trim() ? m.att.find(a => describableFile(a.name, a.mime)) : undefined
      const was = image ? altText(image.alt) : null
      useP2p.setState(st => ({
        editing: {
          room,
          id,
          text: m.body,
          focus: (st.editing?.focus ?? 0) + 1,
          ...(image ? { alt: { h: image.h, text: was ?? '', was } } : {}),
        },
        replying: null,
      }))
    },

    setEditAlt: (text: string) =>
      useP2p.setState(st =>
        st.editing?.alt ? { editing: { ...st.editing, alt: { ...st.editing.alt, text } } } : {}
      ),

    editLast(room: string) {
      const m = lastEditable(room)
      if (!m) return false
      p2pDm.startEdit(room, m.id)
      return true
    },

    setEditText: (text: string) =>
      useP2p.setState(st => (st.editing ? { editing: { ...st.editing, text } } : {})),

    cancelEdit: (refocus?: boolean) =>
      useP2p.setState(s => ({
        editing: null,
        ...(refocus && s.editing
          ? { composerFocus: { key: s.editing.room, n: (s.composerFocus?.n ?? 0) + 1 } }
          : {}),
      })),

    async saveEdit(refocus?: boolean) {
      const e = useP2p.getState().editing
      if (!e) return
      const m = findMessage(e.id)
      const body = e.text.trim()
      if (body && bodyTooLong(e.text)) return p2pHost.toast(TOO_LONG_TEXT)
      const tooLong = e.alt ? altError(e.alt.text) : null
      if (tooLong) return p2pHost.toast(tooLong)
      const changed = !!e.alt && altText(e.alt.text) !== e.alt.was
      const alts = m ? editAltsFor(m.att, e.alt) : undefined
      p2pDm.cancelEdit(refocus)
      if (!m || !body || (body === m.body.trim() && !changed)) return
      await onTarget(
        e.room,
        (d, r) => d.edit(r, e.id, e.text, alts),
        (sv, r) => sv.edit(r, e.id, e.text, alts)
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
      useP2p.setState({ pins: { room, list: null }, threads: null })
      await loadPinList(room)
    },

    closePins: () => useP2p.setState({ pins: null }),

    openThreads() {
      const chat = useP2p.getState().chat
      if (chat) useP2p.setState({ threads: chatKey(chat), pins: null })
    },

    closeThreads: () => useP2p.setState({ threads: null }),

    // `room` is a draft key.
    markRead(room: string) {
      const t = targetOf(room)
      if (t.kind === 'server') return parts.servers.p2pServer.markRead(t.room, t.ch)
      if (t.thread) return
      const r = useP2p.getState().rooms[room]
      if (!r || channelReadSkips(r, r.seq, readChecked.get(room))) return
      void withDms(d => readConversation(d, room))
    },

    // The open conversation's first unread message (in storage when not loaded), for its banner.
    async firstUnread(): Promise<{ id: string; ts: number } | null> {
      const chat = useP2p.getState().chat
      const s = dbNow()
      const me = meNow()
      if (!chat || !chat.readSeq || !s || !me) return null
      const r = await s.firstMessageAfter(chat.room, chat.readSeq, me, chat.ch).catch(() => null)
      return r ? { id: r.id, ts: r.effTs } : null
    },

    // Marks the open conversation read and drops its new messages line and banner.
    dismissUnread(key: string) {
      p2pDm.markRead(key)
      useP2p.setState(st => (st.chat?.readSeq ? { chat: { ...st.chat, readSeq: 0 } } : {}))
    },

    // Every conversation with unread messages or pings. Only the tab that runs P2P can.
    markAllRead() {
      const list = Object.values(useP2p.getState().rooms).filter(r => r.unread || r.pings)
      if (list.length && !state.dms) return p2pHost.toast(parts.calls.ELSEWHERE_TEXT)
      for (const r of list) p2pDm.markRead(r.id)
    },

    // How often a composer says it is still typing, by the window of the place it types in.
    typingEvery(room: string) {
      const server = targetOf(room).kind === 'server'
      return typingResendMs(server ? state.limits.gossip.typingMs : state.limits.sync.typingMs)
    },

    typing(room: string, on: boolean) {
      if (!p2pHost.typingOn()) return
      const t = targetOf(room)
      if (t.kind === 'server') state.servers?.typing(t.room, t.ch, on, t.thread ?? undefined)
      else state.dms?.typing(t.room, on, t.thread)
    },
  }

  scope.onReset(() => {
    ++jumpRevision
    for (const timer of timers.values()) timer?.()
    timers.clear()
    readChecked.clear()
  })
  return {
    currentSession,
    dbNow,
    meNow,
    refreshRooms,
    refreshWindow,
    loadChat,
    refreshRoom,
    timers,
    loadPinList,
    contactName,
    p2pUser,
    arrived,
    findMessage,
    p2pDm,
    get jumpGen() {
      return jumpRevision
    },
  }
}
