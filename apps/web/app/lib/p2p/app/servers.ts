import { resolve as resolveNotify } from '../../notify'
import type { ConfirmRequest } from '../../store_types'
import type { RoomRecord } from '../db'
import { keyId } from '../keys'
import { displayName } from '../contacts'
import { PAGE } from '../dm'
import type { WireV2 } from '../event_v2'
import { slowChanged } from '../roles'
import {
  parseCode,
  Servers,
  ServerError,
  type ChannelPatch,
  type SearchHit,
  type SearchQuery,
  type ServerArrival,
  type ServerView,
} from '../server'
import { unsentText, WIPE_TEXT } from '../flows'
import { P, type HistoryVis } from '../state'
import {
  servers,
  useP2p,
  threadKey,
  dms,
  emptySearch,
  pingLog,
  chatKey,
  p2pHost,
  threadScope,
  chatScope,
  writeHome,
  node,
} from './store'
import {
  loadPinList,
  refreshWindow,
  jumpGen,
  dbNow,
  findMessage,
  p2pDm,
  meNow,
  p2pUser,
} from './dms'
import { channelLoaded, p2pOpenAt } from './inbox'
import { ELSEWHERE_TEXT } from './calls'

// ----- Servers -----

export const readerView = (r: RoomRecord): ServerView => ({
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

export const refreshServers = () => {
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

export const refreshServer = async (room: string) => {
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

export const scheduleServer = (room: string) => {
  if (serverTimers.has(room)) return
  serverTimers.set(
    room,
    setTimeout(() => {
      serverTimers.delete(room)
      void refreshServer(room)
    }, 30)
  )
}

export const loadChannel = async (room: string, ch: string, keep = false) => {
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
export const readSlow = async (room: string, ch: string) => {
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
export const serverArrived = (a: ServerArrival) => {
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

export const withServers = async <T>(fn: (s: Servers) => Promise<T>): Promise<T | null> => {
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
