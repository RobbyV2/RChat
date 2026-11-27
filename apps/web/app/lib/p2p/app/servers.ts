import type { ShownPerson } from '../../people'
import { resolve as resolveNotify } from '../../notify'
import type { RoomExtras } from '../../profile_fields'
import type { LockSecs, LockState, ResetField } from '../../profile_reset'
import { lookOf, roomLookOf, shownUser } from '../../server_profile'
import type { ProfilesMode, SeparatorStyle } from '../../types'
import type { CategoryPatch, SeparatorPatch } from '../server/categories'
import { BanExpiry } from '../ban_expiry'
import type { P2pStore, RoomRecord, ServerCache } from '../db'
import { loadDmThread, loadDmThreadAround, loadDmThreads, type P2pMessage } from '../dm'
import { cacheKey } from '../dag'
import { knownRules, rulesOf } from '../acl/rules'
import { cachedSummary } from '../server/load'
import { categoryViews, channelViews, separatorViews } from '../server/views'
import { keyId } from '../keys'
import { displayName } from '../contacts'
import type { WireV2 } from '../event_v2'
import { slowChanged } from '../roles'
import type { RoleMetaPatch } from '../server/roles'
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
import { unsentText } from '../flows'
import { membershipOf, roomColor, type HistoryVis } from '../state'
import { p2pAbout, type AboutChange } from '../../server_about'
import { parseP2pMemberList, type P2pMemberListChange } from '../../member_list'
import type { P2pThread } from './store'
import { sealEarlier } from '../seal_earlier'
import { replaceDeviceKey, replacing } from '../device_rekey'
import type { IdentityScope, P2pParts } from './scope'
import { time } from '../../platform/time'
import type { Cancel } from '../../clock'

// Messages stored here that match (search panel). `from` is matched against member names.
export interface P2pSearchArgs {
  q: string
  from: string
  ch: string | null
  hasFile: boolean
  beforeTs: number | null
  afterTs: number | null
}
export const serverScope = (room: string) => ({ kind: 'p2ps', room }) as const

export const channelScope = (room: string, ch: string) => ({ kind: 'p2pc', room, ch }) as const

export const threadPings = (c: { threads?: Record<string, number> }) =>
  Object.values(c.threads ?? {}).reduce((a, b) => a + b, 0)

export type Counts = { unread: number; pings: number; threads?: Record<string, number> }

export const threadsSig = (c: Counts, seq: number) =>
  `${seq}:${c.pings}:${Object.entries(c.threads ?? {})
    .map(([t, n]) => `${t}=${n}`)
    .join()}`

// Whether reading a channel can be skipped: nothing unread, only thread pings left, and those
// checked at this position already.
export const channelReadSkips = (c: Counts, seq: number, checked: string | undefined) =>
  !c.unread && c.pings <= threadPings(c) && (!threadPings(c) || checked === threadsSig(c, seq))

// Invites to servers, with the about this device holds for them (none before it syncs).
const inviteRows = (sv: Servers) =>
  sv.invites().map(r => ({
    room: r.id,
    name: r.name ?? 'P2P server',
    from: r.invite?.from ?? '',
    at: r.invite?.at ?? 0,
    about: p2pAbout(sv.sumOf(r.id).about),
    color: roomColor(sv.sumOf(r.id)),
  }))

export function createServersPart(
  parts: Pick<P2pParts, 'viewing' | 'store' | 'dms' | 'inbox' | 'calls'>,
  scope: IdentityScope
) {
  const state = parts.store
  const { useP2p, p2pHost, chatKey, threadKey, threadScope, chatScope, emptySearch, writeHome } =
    state

  // ----- Servers -----

  const { canView, cancelViewing, leaveVisit, requestViewing, useViewing } = scope.owner.viewing

  const readerView = async (s: P2pStore, r: RoomRecord, ik: string): Promise<ServerView> => {
    const sum = r.legacy
      ? null
      : cachedSummary((await s.meta<ServerCache>(cacheKey(r.id))) ?? r.server)
    const me = sum && knownRules(sum.rules) ? membershipOf(sum, ik) : null
    return {
      id: r.id,
      name: r.name ?? 'P2P server',
      color: null,
      about: p2pAbout(sum?.about ?? null),
      memberList: parseP2pMemberList(sum?.memberList ?? null),
      awaitingAcl: !r.legacy && sum?.rules == null,
      rules: rulesOf(sum?.rules),
      me,
      joining: false,
      owner: null,
      owners: [],
      perms: 0,
      rank: [-Infinity, ''],
      history: 'shared',
      profiles: sum?.profiles ?? 'all',
      profile: r.profile ?? {},
      profileLock: { locked: false },
      store: { on: false, earlier: false },
      system: { ch: null, join: true, leave: true },
      systemPick: null,
      channels: sum && me === 'join' ? channelViews(sum, ik, me, state.limits.display) : [],
      categories: sum && me === 'join' ? categoryViews(sum, state.limits.display) : [],
      separators: sum && me === 'join' ? separatorViews(sum) : [],
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
    }
  }

  const refreshServers = () => {
    const sv = state.servers
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
      serverInvites: inviteRows(sv),
    })
  }

  const refreshServer = async (room: string) => {
    const sv = state.servers
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
    if (th?.room === room && th.ch) {
      const list = sv.typingIn(room, th.ch, th.root)
      if (list.length) typing[threadKey(th)] = list
    }
    useP2p.setState({
      servers: servs,
      serverTyping: typing,
      coOwnerAsks: sv.coOwnerAsks(),
      transferAsks: sv.transferAsks(),
      serverInvites: inviteRows(sv),
      storageFull: (state.dms?.storageFull ?? false) || sv.storageFull,
    })
    const now = useP2p.getState()
    // The open channel went away (deleted, or we left): fall back to the first one.
    if (now.server?.room === room && v) {
      const ch = now.server.ch
      const first = v.channels.find(c => c.kind === 'text')?.id ?? null
      if (ch && !v.channels.some(c => c.id === ch)) p2pServer.openChannel(first)
      else if (!ch && first && !st.servers[room]?.channels.length) void p2pServer.openChannel(first)
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
    if (now.pins?.room === room) await parts.dms.loadPinList(room)
  }

  const serverTimers = new Map<string, Cancel>()

  const scheduleServer = (room: string) => {
    if (serverTimers.has(room)) return
    serverTimers.set(
      room,
      time().after(30, () => {
        serverTimers.delete(room)
        void refreshServer(room)
      })
    )
  }

  const loadChannel = async (room: string, ch: string, keep = false) => {
    const sv = state.servers
    if (!sv) return
    if (!parts.viewing.peerVisible(useP2p.getState(), room, ch)) return
    const cur = useP2p.getState().chat
    const same = keep && cur?.room === room && cur.ch === ch
    if (same && cur.newer) return parts.dms.refreshWindow(cur)
    const page = state.limits.dm.page
    const limit = same ? Math.max(page, cur.messages.length) : page
    const gen = parts.dms.jumpGen
    try {
      const { messages, more } = await sv.loadChannel(room, ch, { limit })
      const now = useP2p.getState().chat
      if (now?.room !== room || now.ch !== ch || gen !== parts.dms.jumpGen) return
      useP2p.setState({ chat: { ...now, messages, more, newer: false, loading: false } })
      if (!keep) await readSlow(room, ch)
    } catch {
      // Storage went away: the channel stops loading.
      const now = useP2p.getState().chat
      if (now?.room === room && now.ch === ch && now.loading && gen === parts.dms.jumpGen)
        useP2p.setState({ chat: { ...now, loading: false } })
    }
  }

  // A page of a thread: a server channel's, or a conversation's.
  const threadPage = (t: P2pThread, opts: { before?: string; limit?: number }) => {
    const s = parts.dms.dbNow()
    const me = parts.dms.meNow()
    const peer = useP2p.getState().rooms[t.room]?.peer ?? useP2p.getState().chat?.peer
    if (t.ch) return state.servers ? state.servers.loadThread(t.room, t.root, opts) : null
    return s && me && peer ? loadDmThread(s.db, t.room, t.root, me, peer, opts, state.limits) : null
  }

  // The open thread's root and newest replies (`keep`: at least as many as shown).
  const loadThread = async (keep = false) => {
    const t = useP2p.getState().thread
    if (!t) return
    const page = state.limits.dm.page
    const limit = keep ? Math.max(page, t.messages.length) : page
    try {
      const got = await threadPage(t, { limit })
      const now = useP2p.getState().thread
      if (now?.room !== t.room || now.root !== t.root) return
      if (!got) return useP2p.setState({ thread: { ...now, loading: false } })
      useP2p.setState({
        thread: { ...now, head: got.root, messages: got.messages, more: got.more, loading: false },
      })
    } catch {
      // Storage went away: the thread stops loading.
      const now = useP2p.getState().thread
      if (now?.room === t.room && now.root === t.root && now.loading)
        useP2p.setState({ thread: { ...now, loading: false } })
    }
  }

  const p2pThread = {
    // Opens the thread of a top-level message of the open channel or conversation (at one of
    // its replies).
    async open(root: string, at?: string) {
      const st = useP2p.getState()
      const chat = st.chat
      const s = parts.dms.dbNow()
      if (!chat || !s) return
      const rec = await s.event(root).catch(() => undefined)
      if (!rec || rec.room !== chat.room || rec.type !== 'msg' || rec.thread) return
      if (chat.ch && !rec.chan) return
      if (chat.ch && rec.chan && rec.chan !== chat.ch) {
        if (!(await p2pServer.openChannel(rec.chan))) return
        await parts.inbox.channelLoaded(chat.room, rec.chan)
      }
      const same = st.thread?.room === chat.room && st.thread.root === root
      const head = same ? (st.thread?.head ?? null) : (parts.dms.findMessage(root) ?? null)
      useP2p.setState({
        panel: 'thread',
        threads: null,
        thread: {
          room: chat.room,
          ch: chat.ch ? (rec.chan ?? null) : null,
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
      const t = useP2p.getState().thread
      if (!t || !t.more || t.loading) return
      useP2p.setState({ thread: { ...t, loading: true } })
      const page = await Promise.resolve(threadPage(t, { before: t.messages[0]?.sortKey })).catch(
        () => null
      )
      const now = useP2p.getState().thread
      if (now?.room !== t.room || now.root !== t.root) return
      useP2p.setState({
        thread: page
          ? {
              ...now,
              messages: [...page.messages, ...now.messages],
              more: page.more,
              loading: false,
            }
          : { ...now, loading: false },
      })
    },

    // A reply of the open thread, loaded around if it isn't shown, and flashed.
    async jumpTo(id: string) {
      const t = useP2p.getState().thread
      if (!t) return
      if (id === t.root) return parts.dms.p2pDm.jumpTo(id)
      if (!t.messages.some(m => m.id === id)) {
        const s = parts.dms.dbNow()
        const me = parts.dms.meNow()
        const peer = useP2p.getState().rooms[t.room]?.peer ?? useP2p.getState().chat?.peer
        const around = await (
          t.ch
            ? state.servers?.loadThreadAround(t.room, t.root, id)
            : s && me && peer
              ? loadDmThreadAround(s.db, t.room, t.root, me, peer, id, state.limits)
              : null
        )?.catch(() => null)
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
      const sv = state.servers
      if (!t) return
      const st = useP2p.getState()
      const counted = t.ch
        ? st.servers[t.room]?.chans[t.ch]?.threads?.[t.root]
        : st.rooms[t.room]?.threads?.[t.root]
      if (!counted) return
      const ids = state.pingLog
        ? await state.pingLog.ofThread(t.room, t.ch, t.root).catch(() => [])
        : []
      if (ids.length) await state.pingLog?.mark(ids).catch(() => 0)
      if (t.ch) await sv?.markThread(t.room, t.ch, t.root).catch(() => {})
      else await state.dms?.markThread(t.room, t.root).catch(() => {})
    },

    // Every thread of the open channel or conversation that shows here, for its Threads list:
    // its root, the sort key of its newest reply, and whether it has unread pings.
    async list(): Promise<{ root: P2pMessage; last: string; pinged: boolean }[]> {
      const chat = useP2p.getState().chat
      const s = parts.dms.dbNow()
      const me = parts.dms.meNow()
      if (!chat || !s || !me) return []
      const all = chat.ch
        ? ((await state.servers?.listThreads(chat.room, chat.ch)) ?? [])
        : await loadDmThreads(s.db, chat.room, me, chat.peer, state.limits)
      const pings = state.pingLog
        ? await state.pingLog.threadPings(chat.room, chat.ch ?? null).catch(() => [])
        : []
      const pinged = new Set(pings.map(p => p.thread))
      const counts = chat.ch
        ? useP2p.getState().servers[chat.room]?.chans[chat.ch]?.threads
        : useP2p.getState().rooms[chat.room]?.threads
      return all.map(t => ({
        ...t,
        pinged: pinged.has(t.root.id) || (counts?.[t.root.id] ?? 0) > 0,
      }))
    },
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
    const me = parts.dms.meNow()
    if (me && 'me'.startsWith(needle)) out.add(me)
    return [...out]
  }

  let searchGen = 0

  let searchAccess: string | null = null

  const allowedSearchChannels = () => {
    const st = useP2p.getState()
    return JSON.stringify(
      Object.entries(st.servers)
        .flatMap(([room, server]) =>
          server.channels
            .filter(ch => parts.viewing.peerVisible(st, room, ch.id))
            .map(ch => JSON.stringify([room, ch.id]))
        )
        .sort()
    )
  }

  // While the index is rebuilt (after the upgrade or an import), the panel says results may be
  // missing, until it is complete.
  const watchIndex = () => {
    const sv = state.servers
    if (!sv || sv.indexed) return
    void sv.indexing.then(() =>
      useP2p.setState(st =>
        st.search.indexing ? { search: { ...st.search, indexing: false } } : {}
      )
    )
  }

  const p2pSearch = {
    open() {
      searchGen++
      searchAccess = null
      const indexing = !!state.servers && !state.servers.indexed
      useP2p.setState({ panel: 'search', search: { ...emptySearch(), indexing }, thread: null })
      watchIndex()
    },

    close() {
      searchGen++
      searchAccess = null
      useP2p.setState(st => ({
        panel: st.panel === 'search' ? null : st.panel,
        search: emptySearch(),
      }))
    },

    // A first page (`fresh`) or the next one.
    async run(args: P2pSearchArgs, fresh: boolean) {
      const sv = state.servers
      if (!sv) {
        useP2p.setState({ search: emptySearch() })
        return
      }
      const cur = useP2p.getState().search
      if (!fresh && (cur.loading || cur.next === null)) return
      const gen = fresh ? ++searchGen : searchGen
      const room = useP2p.getState().server?.room ?? null
      searchAccess = allowedSearchChannels()
      if (args.ch && (!room || !parts.viewing.peerVisible(useP2p.getState(), room, args.ch))) {
        useP2p.setState({ search: emptySearch() })
        return
      }
      const q: SearchQuery = {
        visible: (r, ch) =>
          gen === searchGen && parts.viewing.peerVisible(useP2p.getState(), r, ch),
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
          : await sv.search(q, fresh ? null : cur.next).catch((error: unknown) => ({ error }))
      if (gen !== searchGen) return
      if ('error' in page) {
        useP2p.setState(st => ({
          search: { ...st.search, loading: false, failed: page.error },
        }))
        return
      }
      useP2p.setState(st => ({
        search: {
          hits: (fresh ? page.hits : [...st.search.hits, ...page.hits]).filter(h =>
            parts.viewing.peerVisible(st, h.room, h.ch)
          ),
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
      await parts.inbox.p2pOpenAt(hit.room, hit.ch, hit.m.id)
    },
  }

  // How long until we may post in a slow-mode channel again.
  const readSlow = async (room: string, ch: string) => {
    const left = await state.servers?.slowLeft(room, ch).catch(() => 0)
    if (left === undefined) return
    const key = chatKey({ room, ch })
    const until = left > 0 ? time().now() + left : 0
    if ((useP2p.getState().slowUntil[key] ?? 0) === until) return
    useP2p.setState(st => ({ slowUntil: { ...st.slowUntil, [key]: until } }))
  }

  // What a member calls themselves (our petname for contacts first).
  const memberName = (room: string, ik: string) =>
    state.servers?.nameOf(ik, room) ??
    useP2p.getState().servers[room]?.members.find(m => m.ik === ik)?.name ??
    'Member'

  // A member as a server shows them: their name there, and the avatar they set for it.
  const memberUser = (room: string, ik: string): ShownPerson =>
    shownUser(
      parts.dms.p2pUser(ik, memberName(room, ik)),
      lookOf(
        {
          roomLook: (id, who) =>
            roomLookOf(useP2p.getState().servers[id]?.members.find(m => m.ik === who)),
        },
        { room },
        ik
      )
    )

  // The name an author gives themselves (never our petname, never masked): a forward carries it.
  const profileName = (ik: string, room?: string) => {
    if (state.servers) return state.servers.profileName(ik, room)
    const st = useP2p.getState()
    if (ik === st.ik) return st.name || 'Member'
    return st.contacts.find(c => c.ik === ik)?.name || 'Member'
  }

  const SERVER_PING: Record<NonNullable<ServerArrival['ping']>, string> = {
    mention: 'mentioned you',
    reply: 'replied to you',
    reaction: 'reacted to your message',
    everyone: 'mentioned @everyone',
  }

  // A new message in a server channel: toasts and desktop notifications follow the channel's
  // level (Only @mentions by default), like an instance server.
  const serverArrived = (a: ServerArrival) => {
    if (!parts.viewing.peerVisible(useP2p.getState(), a.room, a.ch)) return
    if (a.ping) state.pingLog?.note(a.room, a.ch, a.ping, a.rec, a.thread)
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
      if (a.thread) time().after(0, () => void p2pThread.markRead())
      else void state.servers?.markRead(a.room, a.ch)
      return
    }
    const rule = resolveNotify(p2pHost.prefs(), channelScope(a.room, a.ch), time().now())
    if (rule.muted || rule.level === 'nothing') return
    if (!a.ping && rule.level !== 'all') return
    const v = st.servers[a.room]
    const c = a.rec.wire.c as { body?: string; key?: string } | null
    p2pHost.alert({
      key: `p2p:${a.room}/${a.ch}`,
      actor: memberUser(a.room, a.rec.sender),
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
          ? void parts.inbox.p2pOpenAt(
              a.room,
              a.ch,
              a.rec.type === 'msg' ? a.rec.id : (a.rec.target ?? a.thread)
            )
          : p2pServer.open(a.room, a.ch),
    })
  }

  // Runs `fn` and answers why it failed (null when it worked), for a dialog that shows the
  // reason itself.
  const tryServers = async (fn: (s: Servers) => Promise<unknown>): Promise<string | null> => {
    const sv = state.servers
    if (!sv) return parts.calls.ELSEWHERE_TEXT
    try {
      await fn(sv)
      return null
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }

  const withServers = async <T>(fn: (s: Servers) => Promise<T>): Promise<T | null> => {
    const sv = state.servers
    if (!sv) {
      p2pHost.toast(parts.calls.ELSEWHERE_TEXT)
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

  // Thread counters already checked on a read, at a stored-content position (`seq`: deletions and
  // hidden content move it too), so reading at the bottom again doesn't redo it.
  const threadsChecked = new Map<string, string>()

  // Reads a channel: thread pings whose reply or root stopped showing come off with it, and the
  // log notes them as seen. The counters are taken before the log, so a ping that arrives meanwhile
  // stays counted.
  const readChannel = async (room: string, ch: string) => {
    const sv = state.servers
    if (!sv) return
    try {
      const counts = sv.threadCounts(room, ch)
      const pings = state.pingLog ? await state.pingLog.threadPings(room, ch) : []
      const dead = await sv.readChannel(room, ch, pings, counts)
      if (dead.length) await state.pingLog?.seen(dead)
    } catch {
      // Storage went away.
    }
    const v = useP2p.getState().servers[room]
    const c = v?.chans[ch]
    if (c) threadsChecked.set(`${room}/${ch}`, threadsSig(c, v.seq))
  }

  const p2pServer = {
    // Opens a server (its last channel, or the first one); the P2P home closes.
    open(room: string, ch?: string | null, current?: () => boolean) {
      const v = useP2p.getState().servers[room]
      const pick =
        ch ?? lastChannel.get(room) ?? v?.channels.find(c => c.kind === 'text')?.id ?? null
      writeHome(null)
      useP2p.setState({
        home: false,
        dmList: false,
        server: { room, ch: null },
        chat: null,
        panel: null,
        pins: null,
        threads: null,
        thread: null,
        dialog: null,
      })
      return p2pServer.openChannel(pick, current)
    },

    // A voice channel opens its stage, without a conversation.
    async openChannel(ch: string | null, current?: () => boolean): Promise<boolean> {
      cancelViewing()
      const cur = useP2p.getState().server
      if (!cur) return false
      const st = useP2p.getState()
      const channel = st.servers[cur.room]?.channels.find(c => c.id === ch)
      const target = channel && parts.viewing.peerTarget(st, cur.room, channel.id)
      if (ch && !target) return false
      if (target && !canView(target) && !(await requestViewing(target))) return false
      if (
        (current && !current()) ||
        useP2p.getState().server !== cur ||
        (ch && !parts.viewing.peerVisible(useP2p.getState(), cur.room, ch))
      )
        return false
      const kind = channel?.kind
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
                unread: st.servers[cur.room]?.chans[ch]?.unread ?? 0,
                unreadSeq: st.servers[cur.room]?.seq ?? 0,
                missed: [],
              }
            : null,
        pins: null,
        threads: null,
        editing: null,
        replying: null,
        pulling: false,
        thread: st.thread?.room === cur.room && st.thread.ch === ch ? st.thread : null,
        panel:
          st.panel === 'thread' && !(st.thread?.room === cur.room && st.thread.ch === ch)
            ? null
            : st.panel,
      }))
      leaveVisit(target?.key)
      if (ch && text) void loadChannel(cur.room, ch)
      return true
    },

    close: () =>
      useP2p.setState(st => ({
        server: null,
        chat: st.chat?.ch ? null : st.chat,
        pins: st.chat?.ch ? null : st.pins,
        threads: st.chat?.ch ? null : st.threads,
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
      if (room) refreshServers()
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
    setAbout: (room: string, change: AboutChange) => withServers(s => s.setAbout(room, change)),
    setMemberList: (room: string, change: P2pMemberListChange) =>
      withServers(s => s.setMemberList(room, change)),
    setHistory: (room: string, vis: HistoryVis) => withServers(s => s.setHistory(room, vis)),
    setStore: (room: string, on: boolean, earlier = false) =>
      withServers(s => s.setStore(room, on, earlier)),
    // Encrypts the earlier messages this device stored of `room` without changing its switch:
    // where the site requires encrypted storage and the room's own switch is off.
    sealEarlierHere: (room: string) => {
      const s = state.store
      if (s) void sealEarlier(s, room, state.limits.search).catch(() => {})
    },
    // Replaces this device's key and seals what the old one sealed again in the background;
    // false when there is nothing to replace or a replacement runs.
    async replaceDeviceKey() {
      const s = state.store
      if (!s) return false
      const started = await replaceDeviceKey(s, state.limits.search)
      if (started) useP2p.setState(st => ({ seal: { ...st.seal, replacing: true } }))
      return started
    },
    // Whether this device sealed anything, and whether a replacement of its key still runs.
    async replacingDeviceKey() {
      const s = state.store
      if (!s) return false
      const now = await replacing(s)
      const sealedAny = s.sealing.sealedAny
      if (state.store === s)
        useP2p.setState(st => ({ seal: { ...st.seal, sealedAny, replacing: now } }))
      return now
    },
    // Asks whether this device can keep a device key (making it), for the settings.
    async checkSealKey() {
      const s = state.store
      if (!s) return
      const available = await s.sealing.available()
      if (state.store === s) useP2p.setState(st => ({ seal: { ...st.seal, available } }))
    },
    setSystem: (room: string, sys: { ch: string | null; join: boolean; leave: boolean }) =>
      withServers(s => s.setSystem(room, sys)),
    addChannel: (room: string, name: string, kind: 'text' | 'voice' = 'text') =>
      withServers(s => s.addChannel(room, name, { kind })),
    editChannel: (room: string, id: string, patch: ChannelPatch) =>
      withServers(s => s.editChannel(room, id, patch)),
    setOverwrite: (room: string, ch: string, subj: string, o: { allow: number; deny: number }) =>
      withServers(s => s.setOverwrite(room, ch, subj, o.allow, o.deny)),
    // Categories: a category's overwrites reach the channels that copy them.
    addChannelIn: (room: string, name: string, cat: string, kind: 'text' | 'voice' = 'text') =>
      withServers(s => s.addChannelIn(room, name, cat, { kind })),
    createCategory: (room: string, name: string) => withServers(s => s.createCategory(room, name)),
    editCategory: (room: string, id: string, patch: CategoryPatch) =>
      withServers(s => s.editCategory(room, id, patch)),
    deleteCategory: (room: string, id: string) => withServers(s => s.deleteCategory(room, id)),
    // Separators of the channel list.
    createSeparator: (room: string, label: string, style: SeparatorStyle, cat: string | null) =>
      withServers(s => s.createSeparator(room, label, style, cat)),
    editSeparator: (room: string, id: string, patch: SeparatorPatch) =>
      withServers(s => s.editSeparator(room, id, patch)),
    deleteSeparator: (room: string, id: string) => withServers(s => s.deleteSeparator(room, id)),
    placeChannel: (room: string, ch: string, cat: string | null) =>
      withServers(s => s.placeChannel(room, ch, cat)),
    setCategoryOverwrite: (
      room: string,
      cat: string,
      subj: string,
      o: { allow: number; deny: number }
    ) => withServers(s => s.setCategoryOverwrite(room, cat, subj, o.allow, o.deny)),
    syncChannel: (room: string, ch: string) => withServers(s => s.syncChannel(room, ch)),
    syncWidens: (room: string, ch: string) => withServers(async s => s.syncWidens(room, ch)),
    moderationLog: (room: string, before: number | null = null) =>
      withServers(s => s.moderationLog(room, before)),
    // Roles. Taking a role from someone is a removal: it waits for sync too.
    createRole: (room: string, role: { name: string; color: number | null; bits: number }) =>
      withServers(s => s.createRole(room, role)),
    async moveRoles(room: string, moves: { role: string; pos: number }[]) {
      for (const m of moves)
        if ((await withServers(s => s.moveRole(room, m.role, m.pos))) === null) return
    },
    editRole: (room: string, role: string, patch: RoleMetaPatch) =>
      withServers(s => s.editRole(room, role, patch)),
    // Display positions, one `role_meta` each (null follows the role's position).
    async showRoles(room: string, moves: { role: string; dpos: number | null }[]) {
      for (const m of moves)
        if ((await withServers(s => s.editRole(room, m.role, { dpos: m.dpos }))) === null) return
    },
    setRoleBit: (room: string, role: string, bit: number, on: boolean) =>
      withServers(s => s.setRoleBit(room, role, bit, on)),
    deleteRole: (room: string, role: string) => withServers(s => s.deleteRole(room, role)),
    assignRole: (room: string, ik: string, role: string) =>
      withServers(s => s.assignRole(room, ik, role)),
    revokeRole: (room: string, ik: string, role: string) =>
      withServers(s =>
        ik === useP2p.getState().me
          ? s.revokeRole(room, ik, role)
          : s.moderate(room, { act: 'Take a role from', who: ik }, () =>
              s.revokeRole(room, ik, role)
            )
      ),
    // Our own profile in a server, and what members may set in theirs.
    setRoomProfile: (room: string, intent: RoomExtras) =>
      tryServers(s => s.setRoomProfile(room, intent)),
    profileLock: (room: string, ik: string): LockState =>
      state.servers?.roomLockOf(room, ik) ?? { locked: false },
    // Both answer why they failed (null when they worked or were cancelled), for the dialog
    // that shows it.
    setProfileMode: (room: string, mode: ProfilesMode) =>
      tryServers(s => s.setProfileMode(room, mode)),
    resetProfile: (room: string, ik: string, fields: readonly ResetField[], secs: LockSecs) =>
      tryServers(s =>
        s.moderate(room, { act: 'Reset the server profile of', who: ik }, () =>
          s.resetRoomProfile(room, ik, fields, secs)
        )
      ),
    unlockProfile: (room: string, ik: string) =>
      withServers(s =>
        s.moderate(room, { act: 'Unlock the server profile of', who: ik }, () =>
          s.unlockRoomProfile(room, ik)
        )
      ),
    removeChannel: (room: string, id: string) =>
      withServers(s => s.editChannel(room, id, { gone: true })),
    // Moderation waits for sync: signed after a fresh heads exchange with a member, or
    // once Apply anyway is chosen.
    kick: (room: string, ik: string, reason?: string) =>
      withServers(s => s.moderate(room, { act: 'Kick', who: ik }, () => s.kick(room, ik, reason))),
    withdraw: (room: string, ik: string) =>
      withServers(s =>
        s.moderate(room, { act: 'Withdraw the invite of', who: ik }, () => s.kick(room, ik))
      ),
    ban: (
      room: string,
      ik: string,
      o: { wipe?: boolean; reason?: string; seconds?: number; purgeH?: number } = {}
    ) =>
      withServers(s =>
        s.moderate(room, { act: 'Ban', who: ik }, () =>
          s.ban(room, ik, o.reason, o.wipe === true, { seconds: o.seconds, purgeH: o.purgeH })
        )
      ),
    unban: (room: string, ik: string) =>
      withServers(s =>
        s.moderate(room, { act: 'Lift the ban of', who: ik }, () => s.unban(room, ik))
      ),
    timeout: (room: string, ik: string, seconds: number, reason?: string) =>
      withServers(s =>
        s.moderate(room, { act: 'Time out', who: ik }, () => s.timeout(room, ik, seconds, reason))
      ),
    untimeout: (room: string, ik: string) =>
      withServers(s =>
        s.moderate(room, { act: 'Remove the timeout of', who: ik }, () => s.timeout(room, ik, 0))
      ),
    applyAnyway: (room: string, id: number) => state.servers?.applyAnyway(room, id),
    cancelMod: (room: string, id: number) => state.servers?.cancelMod(room, id),
    inviteAgain: (room: string, by: string) => withServers(s => s.inviteAgain(room, by)),
    dismissReached: (room: string, by: string) => state.servers?.dismissReached(room, by),
    reapply: (room: string) =>
      withServers(s =>
        s.moderate(room, { act: 'Re-apply moderation actions' }, () => s.reapplyAll(room))
      ),
    answerCoOwner: (key: string, yes: boolean) => state.servers?.answerCoOwner(key, yes),
    retryCarry: (room: string) => state.servers?.retryCarry(room),
    // Transfer by upgrade.
    async transfer(room: string, ik: string) {
      if (ik === useP2p.getState().me) {
        const ok = await withServers(s => s.transfer(room, ik).then(() => true))
        if (ok) p2pHost.toast('Server upgraded. Open the new copy to enable text-only channels.')
        return
      }
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
      const next = state.servers?.view(room)?.next
      refreshServers()
      if (next) p2pServer.open(next)
    },
    newDevice: () => withServers(s => s.newDevice()),

    // Pings on thread replies stay until their thread is read, unless they no longer count.
    markRead(room: string, ch: string) {
      const v = useP2p.getState().servers[room]
      const c = v?.chans[ch]
      if (!c || channelReadSkips(c, v.seq, threadsChecked.get(`${room}/${ch}`))) return
      if (!threadPings(c)) void state.servers?.markRead(room, ch)
      else void readChannel(room, ch)
    },

    markAllRead(room: string) {
      const chans = useP2p.getState().servers[room]?.chans ?? {}
      if (!state.servers && Object.values(chans).some(c => c.unread || c.pings))
        return p2pHost.toast(parts.calls.ELSEWHERE_TEXT)
      for (const ch of Object.keys(chans)) p2pServer.markRead(room, ch)
    },

    // What a code says (the server's name), for the join screen, without joining.
    peek: (code: string) => parseCode(code),
  }

  // Our devices in P2P servers: the list, a lost or stolen one, and recovery.
  const p2pDevices = {
    list: () => state.servers?.myDevices() ?? [],
    current: () => {
      const a = state.node?.author()
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

  const hidePeerChannel = () => {
    const st = useP2p.getState()
    if (searchAccess !== null) {
      const access = allowedSearchChannels()
      if (access !== searchAccess) {
        searchGen++
        searchAccess = access
        useP2p.setState({
          search: {
            ...st.search,
            loading: false,
            next: null,
            hits: st.search.hits.filter(h => parts.viewing.peerVisible(st, h.room, h.ch)),
          },
        })
      }
    }
    if (st.voice && !parts.viewing.peerVisible(st, st.voice.room, st.voice.ch))
      parts.calls.p2pVoice.leave()
    if (st.server?.ch && !parts.viewing.peerVisible(st, st.server.room, st.server.ch))
      void p2pServer.openChannel(null)
  }

  scope.onDispose(
    useP2p.subscribe((s, prev) => {
      if (s.servers !== prev.servers) hidePeerChannel()
      if (prev.server && !s.server) {
        cancelViewing()
        leaveVisit()
      }
    })
  )

  const banExpiry = new BanExpiry({
    now: () => time().now(),
    random: Math.random,
    setTimer: (fn, ms) => time().after(ms, fn),
    clearTimer: t => (t as Cancel)(),
    view: room => useP2p.getState().servers[room] ?? null,
    unban: (room, ik) => void state.servers?.unban(room, ik).catch(() => {}),
  })
  scope.onDispose(
    useP2p.subscribe((s, prev) => {
      if (s.servers !== prev.servers) banExpiry.sync(s.servers)
    })
  )
  scope.onDispose(() => banExpiry.stop())

  scope.onDispose(
    useViewing.subscribe((s, prev) => {
      if (s.revision !== prev.revision) hidePeerChannel()
    })
  )

  scope.onReset(() => {
    ++searchGen
    searchAccess = null
    for (const timer of serverTimers.values()) timer?.()
    serverTimers.clear()
    banExpiry.stop()
    lastChannel.clear()
    threadsChecked.clear()
  })
  return {
    readerView,
    refreshServers,
    refreshServer,
    scheduleServer,
    loadChannel,
    loadThread,
    p2pThread,
    p2pSearch,
    readSlow,
    memberName,
    memberUser,
    profileName,
    serverScope,
    channelScope,
    serverArrived,
    withServers,
    threadsSig,
    channelReadSkips,
    p2pServer,
    p2pDevices,
  }
}
