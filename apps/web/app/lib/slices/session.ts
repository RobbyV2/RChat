// The signed-in session: sign-in and sign-out, the account and its settings, the URL and what
// is open, guests, invites, the socket and catch-up after outages.

import { ApiError, type LoginRequest, type RegisterRequest } from '../api'
import { catchUpDelay, due } from '../backoff'
import { type Blocked, blockedSet, matchesBlockQuery, withoutTypers } from '../blocks'
import { DEFAULT_ROUTE } from '../call_choice'
import {
  type ConfigDoc,
  type SectionKey,
  parseConfigPath,
  sectionOf,
  stashConfig,
  takeStashedConfig,
} from '../config_transfer'
import { EMPTY_PREFS } from '../emoji'
import { accountPrompt, createP2pGate, siteSettings } from '../features'
import { forwardKey } from '../forward'
import { type FriendsDeps, friendsInitial, type friendsSlice } from '../friends_store'
import { NO_GROUP_PINGS } from '../group_pings'
import { ice, iceKey, iceValue, parseIce } from '../ice'
import {
  api,
  fitsHome,
  home,
  noteHomeInfo,
  pageHref,
  resolveInstance,
  selectHome,
  shareOrigin,
  writeLocal,
} from '../instances'
import {
  type InviteEntry,
  type OpenInvite,
  dropStashedInvite,
  entryState,
  inviteEntry,
  invitePath,
  parseInvite,
  takeStashedInvite,
} from '../invite'
import { deniedAccess } from '../join_flow'
import { keyed, mergeHead, refreshTail, samePrefix } from '../lists'
import { forgetGuestMedia } from '../media_src'
import { bootDms, emptyLayout, knownDms, layoutServers, pruneLayout } from '../nav_layout'
import { EMPTY_NOTIFY, keepScopes } from '../notify'
import { historyKey } from '../openapi'
import { p2p } from '../p2p'
import { p2pAccount, p2pRail } from '../p2p/app'
import { secretsKey } from '../passwords'
import { NO_PINGS } from '../pings'
import { clearProfiles } from '../profile'
import { retrySeconds, tooManyText } from '../rate_limit'
import { type Decision, mergeRelays, relayBook, relaysKey } from '../relays'
import { rtc } from '../rtc'
import { cleanBio } from '../rules'
import { selectionInitial, type selectionSlice } from '../selection_store'
import { serverNames } from '../selectors'
import { endsSession, meRetryIn } from '../session'
import type { RChatState } from '../store_types'
import type {
  AuthResponse,
  BlockedUser,
  Me,
  ServerDetail,
  ServerSummaryLite,
  Theme,
  UserRef,
  WsEvent,
} from '../types'
import { hideTypers } from '../typing'
import { type Nav, type View, parsePath, threadKey, viewKey, viewPath } from '../view'
import { SELF_AUDIO_IDLE } from '../voice_layout'
import { trimWindow } from '../window'
import {
  Banned,
  type GetState,
  type Handlers,
  PAGE,
  type SetState,
  emptyPage,
  emptySearch,
  errorText,
  serverKey,
} from './ctx'
import { applyEmbeds, dmKey, type messagesSlice } from './messages'
import type { presenceSlice } from './presence'
import type { readsSlice } from './reads'
import type { rtcSlice } from './rtc'
import type { serversSlice } from './servers'
import type { uiSlice } from './ui'

// Waits before opening the URL again after a boot left nothing open because of 429s. Exported
// so tests can shorten them.
export const BOOT_RETRY_MS = [1000, 3000, 10_000]

const SWITCHED = 'You switched accounts'

const LS = {
  get token() {
    return home.scoped('rchat_token')
  },
  get guest() {
    return home.scoped('rchat_guest')
  },
  get guestServers() {
    return home.scoped('rchat_guest_servers')
  },
  get guestGrants() {
    return home.scoped('rchat_guest_grants')
  },
  get guestNames() {
    return home.scoped('rchat_guest_names')
  },
  theme: 'rchat_theme',
  streamer: 'rchat_streamer',
  get lastDm() {
    return home.scoped('rchat_last_dm')
  },
}

const THEME_COLORS: Record<Theme, string> = { dark: '#141218', light: '#fef7ff' }

const readJson = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

const RESYNC_JITTER = 10_000
const CATCH_UP_VIEW_MAX = 5_000
const POLL_EVERY = 60_000

// P2P for the signed-in account, once the instance's settings say it is on. store.ts feeds it
// every new settings object.
export const p2pGate = createP2pGate(username => void p2pAccount(username))

// Called with every live event after the store applied it (the palette index drops what the
// viewer lost access to).
const wsTaps = new Set<(ev: WsEvent) => void>()

export const tapWs = (tap: (ev: WsEvent) => void) => {
  wsTaps.add(tap)
  return () => void wsTaps.delete(tap)
}

type Ui = ReturnType<typeof uiSlice>
type Messages = ReturnType<typeof messagesSlice>
type Reads = ReturnType<typeof readsSlice>
type Servers = ReturnType<typeof serversSlice>

export type SessionDeps = Pick<
  Ui,
  | 'act'
  | 'armExpiry'
  | 'fail'
  | 'limitedAt'
  | 'notifyOwner'
  | 'pinSelf'
  | 'readCallRoute'
  | 'readEmoji'
  | 'readForward'
  | 'readLayout'
  | 'readNotify'
  | 'readProfanity'
  | 'readSpoilers'
  | 'readTyping'
  | 'saveCallRoute'
  | 'saveEmoji'
  | 'saveLayout'
  | 'saveNotify'
  | 'saveProfanityOn'
  | 'saveShowSpoilers'
  | 'saveTypingOn'
  | 'systemNotice'
  | 'toast'
  | 'useNotify'
  | 'useProfanity'
> &
  Pick<ReturnType<typeof rtcSlice>, 'endRtc' | 'joins'> &
  Pick<Reads, 'lateAnchor' | 'loadUnreads' | 'placeAnchor' | 'readQueue'> &
  Pick<
    Messages,
    | 'askP2p'
    | 'closedDms'
    | 'detached'
    | 'dmPager'
    | 'dropLinkCards'
    | 'fetchPage'
    | 'firstPage'
    | 'headLoad'
    | 'historyGen'
    | 'loadAround'
    | 'loadPins'
    | 'loadingHead'
    | 'newHistory'
    | 'openMessageAt'
    | 'reopenDm'
    | 'views'
  > &
  Pick<
    Servers,
    | 'dropServer'
    | 'ensureMembership'
    | 'fetchServer'
    | 'leaveForSafety'
    | 'leaveServerView'
    | 'pruneServers'
    | 'putServer'
    | 'refreshMemberInfo'
    | 'serverPager'
  > &
  Pick<ReturnType<typeof presenceSlice>, 'forgetTyping'> & {
    loadPage: FriendsDeps['loadPage']
    friendsHub: ReturnType<typeof friendsSlice>
    selectionHub: ReturnType<typeof selectionSlice>
    uiHub: Pick<Ui, 'forget'>
    presenceHub: Pick<ReturnType<typeof presenceSlice>, 'forget'>
    readsHub: Pick<Reads, 'forget' | 'ready'>
    messagesHub: Pick<Messages, 'forget'>
    serversHub: Pick<Servers, 'forget'>
  }

export const sessionSlice = (set: SetState, get: GetState, deps: SessionDeps) => {
  const {
    act,
    armExpiry,
    askP2p,
    closedDms,
    detached,
    dmPager,
    dropLinkCards,
    dropServer,
    endRtc,
    ensureMembership,
    fail,
    fetchPage,
    fetchServer,
    firstPage,
    forgetTyping,
    friendsHub,
    headLoad,
    historyGen,
    joins,
    lateAnchor,
    leaveForSafety,
    leaveServerView,
    limitedAt,
    loadAround,
    loadPage,
    loadPins,
    loadUnreads,
    loadingHead,
    messagesHub,
    newHistory,
    notifyOwner,
    openMessageAt,
    pinSelf,
    placeAnchor,
    presenceHub,
    pruneServers,
    putServer,
    readCallRoute,
    readEmoji,
    readForward,
    readLayout,
    readNotify,
    readProfanity,
    readQueue,
    readSpoilers,
    readTyping,
    readsHub,
    refreshMemberInfo,
    reopenDm,
    saveCallRoute,
    saveEmoji,
    saveLayout,
    saveNotify,
    saveProfanityOn,
    saveShowSpoilers,
    saveTypingOn,
    selectionHub,
    serverPager,
    serversHub,
    systemNotice,
    toast,
    uiHub,
    useNotify,
    useProfanity,
    views,
  } = deps

  const authRequest = async (path: string, body: LoginRequest | RegisterRequest) => {
    const res = await api.send('POST', path, body)
    if (res.ok) return (await res.json()) as AuthResponse
    const text = await res.text().catch(() => '')
    if (res.status === 429)
      throw new ApiError(tooManyText(retrySeconds(res.headers.get('Retry-After'), text)), 429)
    let message: string
    try {
      message = (JSON.parse(text) as { error?: string }).error || res.statusText
    } catch {
      message = res.statusText
    }
    throw new ApiError(message || `HTTP ${res.status}`, res.status)
  }

  // The relay consent prompt: one host at a time, answered by answerRelayPrompt.
  let relayAnswer: ((d: Decision) => void) | null = null
  const settleRelayPrompt = (decision: Decision) => {
    const answer = relayAnswer
    relayAnswer = null
    set({ relayPrompt: null })
    answer?.(decision)
  }
  relayBook.prompt = host =>
    new Promise<Decision>(resolve => {
      relayAnswer?.('deny')
      relayAnswer = resolve
      set({ relayPrompt: host })
    })
  relayBook.onChange(() => set({ relayPrefs: relayBook.prefs }))

  const armIce = (username: string | null, signedIn: boolean) => {
    const { on, relay } = parseIce(localStorage.getItem(home.scoped(iceKey(username))))
    ice.setHelpers(on)
    ice.setRelay(relay)
    if (relayAnswer) settleRelayPrompt('deny')
    relayBook.load(signedIn && username !== null ? home.scoped(relaysKey(username)) : null)
    set({ iceHelpers: on, iceRelay: relay })
    void ice.setSignedIn(signedIn)
    p2pGate.account(signedIn ? username : null)
  }

  const expireSession = () => {
    if (get().authExpired) return
    set({ authExpired: true })
    get().logout()
  }

  // Rules are pruned only once this account's lists have been checked against them.
  let notifySynced = false

  // Drops rules for servers, channels and DMs the account is no longer in. Servers and DMs with
  // rules are fetched first (the lists are paged); a channel whose server is unknown is kept.
  const channelServer = (s: RChatState, id: number) => {
    for (const [name, d] of Object.entries(s.servers))
      if (d.channels.some(c => c.id === id)) return name
    return s.reads[`c${id}`]?.server ?? null
  }

  const pruneScopes = async () => {
    if (!notifySynced) return
    const owner = notifyOwner()
    const start = get()
    const prefs = start.notifyPrefs
    const asked = [
      ...Object.keys(prefs.servers),
      ...Object.keys(prefs.channels).flatMap(k => channelServer(start, Number(k)) ?? []),
    ]
    try {
      await get().ensureServers(asked)
      await get().ensureDms(Object.keys(prefs.dms).map(Number))
    } catch {
      return
    }
    if (!notifySynced || notifyOwner() !== owner) return
    const s = get()
    const members = new Set(serverNames(s))
    const dms = new Set(s.dms.map(d => d.id))
    saveNotify(
      keepScopes(s.notifyPrefs, {
        server: name => members.has(name),
        channel: id => {
          const server = channelServer(s, id)
          return server === null || members.has(server)
        },
        dm: id => s.guest || dms.has(id) || closedDms.has(id),
      })
    )
  }

  // Applies the chosen sections of an imported config. Device sections (theme, streamer mode)
  // apply at once; logged out, the rest is stashed for the next login. Servers and DMs this
  // account doesn't have are dropped. Returns an error text, or null.
  const applyConfigDoc = async (doc: ConfigDoc, keys: SectionKey[]): Promise<string | null> => {
    const want = new Set(keys.filter(k => doc[k] !== undefined))
    if (want.has('theme') && doc.theme) get().setTheme(doc.theme)
    if (want.has('streamer') && doc.streamer !== undefined) get().setStreamer(doc.streamer)
    const { me, guest } = get()
    if (!me && !guest) {
      const rest = [...want].filter(k => !sectionOf(k).device)
      if (rest.length) stashConfig(doc, rest)
      return null
    }
    const username = me?.username ?? null
    const still = () => (get().me?.username ?? null) === username && (!!get().me || get().guest)
    const failed: string[] = []
    if (want.has('appearOffline') && me && doc.appearOffline !== undefined) {
      try {
        if (doc.appearOffline !== me.appear_offline) {
          await api.setAppearOffline(doc.appearOffline)
          set(s =>
            s.me?.username === me.username
              ? { me: { ...s.me, appear_offline: doc.appearOffline as boolean } }
              : {}
          )
        }
      } catch {
        failed.push(sectionOf('appearOffline').label)
      }
    }
    if (!still()) return SWITCHED
    if (want.has('layout') && doc.layout) {
      const l = doc.layout
      try {
        await get().ensureServers(layoutServers(l.servers))
        await get().ensureDms([...l.dmPinned, ...l.dmOrder])
        if (!still()) return SWITCHED
        const s = get()
        if (l.p2p) p2pRail.apply(l.p2p)
        saveLayout(
          pruneLayout(
            {
              ...s.layout,
              servers: l.servers,
              dmOrder: l.dmOrder,
              dmPinned: l.dmPinned,
              selfPin: l.selfPin,
              collapsed: l.collapsed ?? s.layout.collapsed,
            },
            serverNames(s),
            s.dms.map(d => d.id)
          )
        )
        pinSelf()
      } catch {
        failed.push(sectionOf('layout').label)
      }
    }
    if (!still()) return SWITCHED
    if (want.has('notify') && doc.notify) {
      const n = doc.notify
      try {
        await get().ensureServers(Object.keys(n.servers))
        await get().ensureDms(Object.keys(n.dms).map(Number))
        if (!still()) return SWITCHED
        const s = get()
        const members = new Set(serverNames(s))
        const dms = new Set([...s.dms.map(d => d.id), ...closedDms.keys()])
        // P2P rules add to ours (a link carries none, and must not clear them).
        const p2p = Object.assign(Object.create(null), get().notifyPrefs.p2p, n.p2p) as typeof n.p2p
        saveNotify(
          keepScopes(
            { ...n, p2p },
            {
              server: name => members.has(name),
              channel: id => {
                const server = channelServer(s, id)
                return server === null || members.has(server)
              },
              dm: id => dms.has(id),
            }
          )
        )
      } catch {
        failed.push(sectionOf('notify').label)
      }
    }
    if (want.has('emoji') && doc.emoji && me) saveEmoji(doc.emoji)
    if (want.has('calls') && doc.calls && me) saveCallRoute(doc.calls)
    if (want.has('typing') && doc.typing !== undefined) saveTypingOn(doc.typing)
    if (want.has('profanity') && doc.profanity !== undefined) saveProfanityOn(doc.profanity)
    if (want.has('spoilers') && doc.spoilers !== undefined) saveShowSpoilers(doc.spoilers)
    if (want.has('relays') && doc.relays && me)
      relayBook.save(mergeRelays(relayBook.prefs, doc.relays))
    return failed.length ? `Couldn't apply: ${failed.join(', ')}` : null
  }

  const applyStashedConfig = async () => {
    const stashed = takeStashedConfig()
    if (!stashed || !stashed.keys.length) return
    const error = await applyConfigDoc(stashed.doc, stashed.keys)
    if (error) fail(new Error(error))
    else toast('Config applied')
  }

  const syncLayout = async (username: string) => {
    const { servers } = get().layout
    const asked = bootDms(get().layout, PAGE)
    try {
      await get().ensureServers(layoutServers(servers))
      await get().ensureDms(asked)
    } catch {
      return
    }
    if (!sameUser(username)) return
    const s = get()
    const dmIds = knownDms(
      s.layout,
      s.dms.map(d => d.id),
      asked
    )
    saveLayout(pruneLayout(s.layout, serverNames(s), dmIds))
    pinSelf()
    notifySynced = true
    await pruneScopes()
    await applyStashedConfig()
  }

  const loadGuestLayout = () => {
    set({ layout: readLayout(null), typingOn: readTyping(null), showSpoilers: readSpoilers(null) })
    useProfanity(readProfanity(null))
    useNotify(readNotify(null))
    saveLayout(pruneLayout(get().layout, get().guestServers, null))
    notifySynced = true
    void pruneScopes().then(applyStashedConfig)
  }

  const setBlocked = (blocked: Blocked) => {
    hideTypers(Object.keys(blocked))
    set(s => ({ blocked, typing: withoutTypers(s.typing, blocked) }))
  }

  const loadBlocked = async () => {
    const username = get().me?.username
    if (!username || get().guest) return
    let names: unknown
    try {
      names = await api.blockedUsernames()
    } catch {
      return
    }
    if (!sameUser(username) || !Array.isArray(names)) return
    setBlocked(blockedSet(names.filter((n): n is string => typeof n === 'string')))
  }

  const noteBlocked = (b: BlockedUser) => {
    const name = b.user.username
    if (!get().blocked[name]) setBlocked({ ...get().blocked, [name]: true })
    set(s => {
      const page = s.blockList
      if (page.list.some(x => x.user.username === name) || !matchesBlockQuery(b, page.q)) return {}
      return { blockList: { ...page, list: [b, ...page.list] } }
    })
  }

  const noteUnblocked = (name: string) => {
    if (get().blocked[name]) {
      const rest = { ...get().blocked }
      delete rest[name]
      setBlocked(rest)
    }
    set(s => {
      const page = s.blockList
      if (!page.list.some(x => x.user.username === name)) return {}
      return { blockList: { ...page, list: page.list.filter(x => x.user.username !== name) } }
    })
  }

  const applyMe = (fresh: Me, keep: boolean) => {
    const cur = get()
    const same = keep && cur.me?.username === fresh.username
    const steady = {
      servers: same && !!cur.me && samePrefix(cur.me.servers, fresh.servers, serverKey),
      dms: same && samePrefix(cur.dms, fresh.dms, dmKey),
    }
    const resume = {
      servers: serverPager.reset(fresh.servers_cursor, steady.servers) && same,
      dms: dmPager.reset(fresh.dms_cursor, steady.dms) && same,
    }
    set({
      me: {
        ...fresh,
        servers:
          same && cur.me
            ? mergeHead(cur.me.servers, fresh.servers, fresh.servers_more, serverKey)
            : fresh.servers,
      },
      dms: same ? mergeHead(cur.dms, fresh.dms, fresh.dms_more, dmKey) : fresh.dms,
      serversMore: fresh.servers_more,
      dmsMore: fresh.dms_more,
      ...(same
        ? {}
        : {
            layout: readLayout(fresh.username),
            emoji: readEmoji(fresh.username),
            callRoute: readCallRoute(fresh.username),
            p2pCallFailed: {},
            forwardClip: readForward(fresh.username),
            notifyPrefs: readNotify(fresh.username),
            typingOn: readTyping(fresh.username),
            showSpoilers: readSpoilers(fresh.username),
          }),
    })
    if (!same) {
      useProfanity(readProfanity(fresh.username))
      notifySynced = false
      armExpiry()
      armIce(fresh.username, true)
      p2p.setAccount(fresh.username)
    }
    pinSelf()
    if (resume.servers) void get().loadMoreServers()
    if (resume.dms) void get().loadMoreDms()
    if (!same) void syncLayout(fresh.username)
    if (!same) void loadBlocked()
    if (!same) void friendsHub.loadSummary()
    if (!same) void selectionHub.loadJobs()
  }

  const refetchMe = () =>
    api
      .me()
      .then(me => applyMe(me, true))
      .catch(e => {
        if (endsSession(e)) expireSession()
        else fail(e)
      })

  let meRetry: ReturnType<typeof setTimeout> | null = null
  let meAttempt = 0
  let recovering = false

  const retryMe = (e: unknown) => {
    const wait = meRetryIn(e, meAttempt)
    if (wait === null) {
      expireSession()
      return
    }
    meAttempt += 1
    set({ bootError: errorText(e) })
    meRetry = setTimeout(() => void recoverMe(), wait)
  }

  const recoverMe = async () => {
    if (meRetry) clearTimeout(meRetry)
    meRetry = null
    if (recovering || get().me || !get().token) return
    recovering = true
    try {
      const me = await api.me()
      if (!get().token) return
      meAttempt = 0
      applyMe(me, false)
      set({ bootError: null })
      p2p.announce()
      void loadUnreads()
      await bootUrl()
    } catch (e) {
      retryMe(e)
    } finally {
      recovering = false
    }
  }

  // Refetches the account, or retries the boot when a token is saved but the account never loaded.
  const refreshMe = () => {
    if (get().me) void refetchMe()
    else if (get().token) void recoverMe()
  }

  const refreshView = async () => {
    const { view } = get()
    if (!view) return
    try {
      const key = viewKey(view)
      if (detached(key)) {
        if (view.kind === 'channel') {
          const detail = await api.getServer(view.server)
          putServer(view.server, detail)
        }
        return
      }
      if (loadingHead(key)) return
      const gen = historyGen.get(key)
      const msgs = await fetchPage(key, {})
      if (historyGen.get(key) !== gen || loadingHead(key)) return
      const { view: now } = get()
      if (!now || viewKey(now) !== key) return
      if (!views.has(key)) {
        firstPage(key, msgs)
        askP2p(msgs)
        return
      }
      const prev = get().messages[key] ?? []
      const next = refreshTail(prev, msgs, PAGE, get().older[key]?.more ?? true)
      const bounded = trimWindow(next.list, 'newest')
      const replaced = bounded.list[0]?.id !== prev[0]?.id
      if (replaced) newHistory(key)
      set(s => ({
        messages: { ...s.messages, [key]: applyEmbeds(bounded.list) },
        older: {
          ...s.older,
          [key]: {
            more: next.more || bounded.trimmed,
            loading: !replaced && (s.older[key]?.loading ?? false),
          },
        },
      }))
      askP2p(msgs)
      if (view.kind === 'channel') {
        const detail = await api.getServer(view.server)
        putServer(view.server, detail)
      }
    } catch (e) {
      if (view.kind === 'channel' && lockedOut(e)) guestLocked(view.server)
      else console.error('degraded poll', e)
    }
  }

  const lockedOut = (e: unknown) =>
    get().guest &&
    get().settings.guests_enabled &&
    e instanceof ApiError &&
    (e.status === 401 || deniedAccess(e))

  const guestLocked = (name: string) => {
    if (!get().guestServers.includes(name)) return
    const { servers, guestNames } = get()
    systemNotice('You were removed from', servers[name]?.display_name ?? guestNames[name] ?? name)
    dropServer(name)
  }

  // Reloads the unread counts, drops servers we were removed from, and reloads the open server's
  // member list and looked-up members.
  const catchUpLists = () => {
    if (get().me) void loadUnreads()
    void pruneServers()
      .catch(() => {})
      .then(() => {
        const { view, members } = get()
        if (view?.kind !== 'channel') return
        if (members[view.server]) void get().loadMembers(view.server, true)
        refreshMemberInfo(view.server)
      })
  }

  const catchUp = () => {
    void refreshView()
    catchUpLists()
  }

  let resyncTimer: ReturnType<typeof setTimeout> | null = null

  const resync = () => {
    if (resyncTimer) return
    resyncTimer = setTimeout(
      () => {
        resyncTimer = null
        set({ p2pAvailability: {}, voiceUsers: {}, voiceMuted: {} })
        home.ws.resubscribe()
        refreshMe()
        void loadBlocked()
        void friendsHub.loadSummary()
        friendsHub.reloadOpenLists()
        void selectionHub.loadJobs()
        const { view } = get()
        if (view) askP2p(get().messages[viewKey(view)] ?? [])
        const { pins } = get()
        if (pins) loadPins(pins.key)
        catchUp()
      },
      250 + Math.random() * RESYNC_JITTER
    )
  }

  let downSince: number | null = null
  let viewTimer: ReturnType<typeof setTimeout> | null = null
  let catchUpTimer: ReturnType<typeof setTimeout> | null = null
  let polledMe: number | null = null
  let polledSettings: number | null = null

  const stopCatchUp = () => {
    if (viewTimer) clearTimeout(viewTimer)
    if (catchUpTimer) clearTimeout(catchUpTimer)
    viewTimer = null
    catchUpTimer = null
  }

  const scheduleCatchUp = (outage: number) => {
    stopCatchUp()
    viewTimer = setTimeout(
      () => {
        viewTimer = null
        void refreshView()
      },
      catchUpDelay(outage, Math.random, CATCH_UP_VIEW_MAX)
    )
    catchUpTimer = setTimeout(() => {
      catchUpTimer = null
      refreshMe()
      catchUpLists()
    }, catchUpDelay(outage))
  }

  let listening = false
  const listenPage = () => {
    if (listening || typeof document === 'undefined' || typeof window === 'undefined') return
    listening = true
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') {
        readQueue.flush()
        return
      }
      home.ws.ensureConnected()
      const { view, atBottom, messages, reads, unreadAnchor, panel } = get()
      if (panel?.kind === 'thread') {
        const thread = threadKey(panel.root.id)
        if (atBottom[thread] === true && !detached(thread)) get().seeThread(panel.root.id)
      }
      if (!view) return
      const key = viewKey(view)
      if (atBottom[key] !== true || detached(key)) return
      const mark = reads[key]
      if (mark && mark.latest > mark.lastRead && !(unreadAnchor[key] > 0))
        set(s => ({ unreadAnchor: { ...s.unreadAnchor, [key]: mark.lastRead } }))
      const list = messages[key] ?? []
      const last = list[list.length - 1]
      if (last) get().markRead(key, last.id)
    })
    window.addEventListener('pagehide', () => readQueue.flush())
  }

  const startWs = () => {
    let connected = false
    downSince = null
    stopCatchUp()
    listenPage()
    home.ws.onEvent = ev => {
      get().applyWsEvent(ev)
      for (const tap of wsTaps) tap(ev)
    }
    home.ws.onStatus = wsStatus => {
      set({ wsStatus })
      if (wsStatus !== 'green') {
        forgetTyping(false)
        if (downSince === null) downSince = Date.now()
        if (get().voice || get().call) endRtc()
        return
      }
      const outage = downSince === null ? 0 : Date.now() - downSince
      downSince = null
      set({ p2pAvailability: {}, voiceUsers: {}, voiceMuted: {} })
      if (get().me) p2p.announce()
      else if (get().token) void recoverMe()
      const { view } = get()
      if (view) askP2p(get().messages[viewKey(view)] ?? [])
      if (connected) scheduleCatchUp(outage)
      connected = true
    }
    home.ws.onPoll = () => {
      void refreshView()
      const now = Date.now()
      if (due(polledMe, now, POLL_EVERY)) {
        polledMe = now
        refreshMe()
      }
      if (due(polledSettings, now, POLL_EVERY)) {
        polledSettings = now
        void get().loadSettings()
      }
    }
    home.ws.start(get().token)
    p2p.ensurePurge()
    if (get().me) void loadUnreads()
    if (get().guest) home.ws.subscribe(get().guestServers)
  }

  const persistGuestServers = (list: string[]) => {
    writeLocal(LS.guestServers, JSON.stringify(list))
    set({ guestServers: list })
  }

  const persistGuestNames = (names: Record<string, string>) => {
    writeLocal(LS.guestNames, JSON.stringify(names))
    set({ guestNames: names })
  }

  const rememberGuestName = (name: string, display: string) => {
    if (get().guestNames[name] !== display)
      persistGuestNames({ ...get().guestNames, [name]: display })
  }

  const persistGrants = (grants: Record<string, string>) => {
    dropLinkCards()
    writeLocal(LS.guestGrants, JSON.stringify(grants))
    api.setGrants(grants)
    home.ws.setGrants(grants)
    set({ guestGrants: grants })
  }

  const dropGrant = (server: string) => {
    if (!(server in get().guestGrants)) return
    const grants = { ...get().guestGrants }
    delete grants[server]
    persistGrants(grants)
  }

  const setTokenCookie = (value: string | null) => {
    const token = home.isDefault ? value : null
    const attrs = `path=/; SameSite=Strict${window.location.protocol === 'https:' ? '; Secure' : ''}`
    document.cookie = token
      ? `rchat_token=${token}; ${attrs}; max-age=31536000`
      : `rchat_token=; ${attrs}; max-age=0`
  }

  const leaveInvite = () => {
    if (get().invite) set({ invite: null })
    if (get().configLink) set({ configLink: null })
  }

  const readConfigLink = () => {
    const id = parseConfigPath(window.location.pathname)
    if (get().configLink !== id) set({ configLink: id })
    return id !== null
  }

  const rememberInvite = (entry: InviteEntry) =>
    queueMicrotask(() => {
      if (parseInvite(pageHref(), shareOrigin())?.server !== entry.server) return
      window.history.replaceState(entryState(entry), '', invitePath(entry.server))
    })

  const readInvite = () => {
    const target = parseInvite(pageHref(), shareOrigin())
    const handoff = takeStashedInvite(target?.server ?? null)
    if (!target) {
      leaveInvite()
      return false
    }
    const { server } = target
    const entry = inviteEntry(window.history.state, server)
    const password = target.password ?? entry?.password ?? handoff?.password ?? null
    if (target.password !== null || password !== (entry?.password ?? null))
      rememberInvite({ server, password, pushed: entry?.pushed ?? false })
    const { me, guest } = get()
    set({ invite: { server, password, join: handoff !== null && (me !== null || guest) } })
    return true
  }

  const atHome = () => window.location.pathname === viewPath(null)

  const syncUrl = (view: View | null, nav: Nav) => {
    leaveInvite()
    if (nav === 'none') return
    const path = viewPath(view)
    if (window.location.pathname === path) return
    if (nav === 'push') window.history.pushState(null, '', path)
    else window.history.replaceState(null, '', path)
  }

  // `retrying`: a boot that tries again after a 429, so it must not fall back yet.
  const resolveUrl = async (nav: 'replace' | 'none', retrying = false) => {
    if (readInvite() || readConfigLink() || (!get().me && !get().guest)) return
    const target = parsePath(window.location.pathname)
    const fallback = async () => {
      await readsHub.ready()
      return leaveForSafety()
    }
    if (target?.kind === 'message') {
      await readsHub.ready()
      const opened = await openMessageAt(target.id, 'replace').catch((e: unknown) => {
        fail(e)
        return true
      })
      if (!opened) toast("You can't open this message")
      const now = get().view
      return now ? syncUrl(now, 'replace') : fallback()
    }
    const cur = get().view
    if (target && target.kind !== 'server' && cur && viewPath(target) === viewPath(cur)) return
    if (!target && atHome()) return cur ? clearView() : set({ home: true })
    if (!target) return fallback()
    if (target.kind === 'dm') {
      if (get().guest) return fallback()
      const known = () => get().dms.some(d => d.id === target.dmId)
      if (!known())
        await get()
          .ensureDms([target.dmId])
          .catch(() => {})
      if (!known() && !closedDms.has(target.dmId)) return fallback()
      await readsHub.ready()
      return get().openDm(target.dmId, nav)
    }
    let detail: ServerDetail
    try {
      detail = (await Promise.all([fetchServer(target.server), ensureMembership(target.server)]))[0]
    } catch (e) {
      if (e instanceof Banned) {
        const now = get().view
        if (now) syncUrl(now, 'replace')
        return
      }
      if (e instanceof ApiError && e.status === 429 && !get().view && retrying) return fail(e)
      await fallback()
      if (deniedAccess(e)) get().openDialog({ kind: 'add_server', join: target.server })
      else fail(e)
      return
    }
    const { guest, guestServers } = get()
    if (guest && !guestServers.includes(target.server)) {
      persistGuestServers([...guestServers, target.server])
      home.ws.subscribe([target.server])
    }
    putServer(target.server, detail)
    void pruneScopes()
    const wanted = target.kind === 'channel' ? target.channelId : null
    const channel = detail.channels.find(c => c.id === wanted) ?? detail.channels[0]
    if (!channel) return fallback()
    if (cur?.kind === 'channel' && cur.server === target.server && cur.channelId === channel.id)
      return syncUrl(cur, 'replace')
    await readsHub.ready()
    return get().openChannel(target.server, channel.id, channel.id === wanted ? nav : 'replace')
  }

  // Opens what the URL asks for at load. Rate limited requests (many tabs or a busy network) can
  // leave nothing open; then it tries again a few times, unless the user went somewhere else.
  const bootUrl = async (attempt = 0): Promise<void> => {
    const started = Date.now()
    await resolveUrl('replace', attempt < BOOT_RETRY_MS.length)
    const s = get()
    const stuck = !s.view && !s.home && !s.invite && !s.configLink && (!!s.me || s.guest)
    if (!stuck || limitedAt() < started || attempt >= BOOT_RETRY_MS.length) return
    const path = window.location.pathname
    setTimeout(() => {
      const now = get()
      if (window.location.pathname === path && !now.view && !now.home) void bootUrl(attempt + 1)
    }, BOOT_RETRY_MS[attempt])
  }

  const enter = (res: AuthResponse) => {
    dropLinkCards()
    writeLocal(LS.token, res.token)
    setTokenCookie(res.token)
    writeLocal(LS.guest, null)
    api.setToken(res.token)
    applyMe(res.user, false)
    set({
      token: res.token,
      guest: false,
      authExpired: false,
      bootError: null,
    })
    startWs()
  }

  // Leaves the current view for none (home); a previewed server is forgotten on the way out.
  const clearView = (nav: Nav = 'replace') => {
    readQueue.flush()
    leaveServerView(null)
    syncUrl(null, nav)
    set({ view: null, pins: null, home: true })
    get().setViewing(null)
  }

  const sameUser = (username: string) => get().me?.username === username

  const enterView = (view: View) => {
    const key = viewKey(view)
    const before = get().view
    const left = before ? viewKey(before) : null
    if (left && left !== key) lateAnchor.delete(left)
    set(s => ({
      view,
      home: false,
      atBottom: { ...s.atBottom, [key]: true },
      focus: keyed(s.focus, key, null),
      unreadAnchor: left && left !== key ? keyed(s.unreadAnchor, left, null) : s.unreadAnchor,
      pins: s.pins && s.pins.key !== key ? null : s.pins,
    }))
    placeAnchor(key)
  }

  const openChannelAt = async (
    server: string,
    channelId: number,
    threadRootId: number | null,
    id: number,
    nav: Nav = 'push'
  ) => {
    const s = get()
    const here = s.view?.kind === 'channel' && s.view.channelId === channelId
    const at = threadRootId ?? id
    set({ panel: null })
    if (here) await get().jumpTo(viewKey({ kind: 'channel', server, channelId }), at)
    else await get().openServer(server, channelId, nav, at)
    if (threadRootId === null) return
    const root = (get().messages[`c${channelId}`] ?? []).find(m => m.id === threadRootId)
    if (root) await get().openThread(root, id)
  }

  // Drops the timers, queues and caches of the signed-in session.
  const forgetSession = () => {
    dropLinkCards()
    hideTypers([])
    uiHub.forget()
    if (meRetry) clearTimeout(meRetry)
    meRetry = null
    meAttempt = 0
    notifySynced = false
    readsHub.forget()
    stopCatchUp()
    joins.reset()
    messagesHub.forget()
    serverPager.reset(null)
    presenceHub.forget()
    serversHub.forget()
  }

  const actions: Pick<
    RChatState,
    | 'loadInstance'
    | 'switchInstance'
    | 'loadSettings'
    | 'setTheme'
    | 'setStreamer'
    | 'setIceHelpers'
    | 'setIceRelay'
    | 'saveRelays'
    | 'answerRelayPrompt'
    | 'patchMe'
    | 'setBio'
    | 'setAppearOffline'
    | 'refreshAccount'
    | 'changePassword'
    | 'bootstrap'
    | 'syncFromUrl'
    | 'register'
    | 'login'
    | 'logout'
    | 'enterGuest'
    | 'guestJoinServer'
    | 'openServer'
    | 'openChannel'
    | 'openDm'
    | 'openInvite'
    | 'closeInvite'
    | 'syncInvite'
    | 'syncConfigLink'
    | 'closeConfigLink'
    | 'applyConfig'
    | 'consumeInviteJoin'
    | 'goHome'
    | 'openLastDm'
    | 'loadBlockList'
    | 'blockUser'
    | 'unblockUser'
    | 'askBlock'
    | 'openThread'
    | 'setViewing'
  > = {
    loadInstance: async () => {
      set({ instance: home.info, instanceHost: home.host })
      try {
        const info = await api.instance()
        if (!fitsHome(info)) throw new Error('instance endpoints moved to another site')
        noteHomeInfo(info)
        set({ instance: info, instanceHost: home.host })
        void ice.refresh()
        return true
      } catch {
        set({ instanceHost: home.host })
        return false
      }
    },

    switchInstance: async address => {
      if (get().token || get().guest) return 'Log out before switching instances'
      try {
        const { origin, info } = await resolveInstance(address)
        if (origin !== home.origin || home.info?.id !== info.id) {
          home.ws.stop()
          selectHome(origin, info)
        } else noteHomeInfo(info)
        set({ instance: info, instanceHost: home.host, error: null })
        void ice.refresh()
        await get().loadSettings()
        return null
      } catch (e) {
        return errorText(e)
      }
    },

    loadSettings: async () => {
      try {
        set({ settings: siteSettings(await api.getSettings()) })
      } catch (e) {
        fail(e)
      }
    },

    setTheme: theme => {
      writeLocal(LS.theme, theme)
      document.documentElement.dataset.theme = theme
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', THEME_COLORS[theme])
      set({ theme })
    },

    setStreamer: streamer => {
      writeLocal(LS.streamer, streamer ? '1' : '0')
      document.body.classList.toggle('streamer-mode', streamer)
      set({ streamer })
    },

    setIceHelpers: on => {
      const relay = get().iceRelay
      writeLocal(home.scoped(iceKey(get().me?.username ?? null)), iceValue({ on, relay }))
      ice.setHelpers(on)
      set({ iceHelpers: on })
    },

    setIceRelay: relay => {
      const on = get().iceHelpers
      writeLocal(home.scoped(iceKey(get().me?.username ?? null)), iceValue({ on, relay }))
      ice.setRelay(relay)
      set({ iceRelay: relay })
    },

    saveRelays: next => relayBook.save(next),

    answerRelayPrompt: settleRelayPrompt,

    patchMe: (avatar_kind, avatar_color, banner_color) =>
      act(async () => {
        const user = await api.patchMe(avatar_kind, avatar_color, banner_color)
        set(s => (s.me ? { me: { ...s.me, ...user } } : {}))
      }),

    setBio: async bio => {
      const { me, settings } = get()
      if (!me) return `${accountPrompt(settings)} to add a description`
      try {
        const user = await api.setBio(cleanBio(bio) ? bio : null)
        set(s => (s.me?.username === me.username ? { me: { ...s.me, ...user } } : {}))
        return null
      } catch (e) {
        return errorText(e)
      }
    },

    setAppearOffline: appearOffline =>
      act(async () => {
        await api.setAppearOffline(appearOffline)
        set(s => (s.me ? { me: { ...s.me, appear_offline: appearOffline } } : {}))
      }),

    refreshAccount: async () => {
      if (!get().token || !get().me) return
      const fresh = await api.me().catch(() => null)
      if (fresh)
        set(s =>
          s.me?.username === fresh.username
            ? {
                me: { ...s.me, password_kind: fresh.password_kind },
              }
            : {}
        )
    },

    changePassword: async (current, next, kind) => {
      try {
        await api.changePassword(current, next)
        set(s => (s.me ? { me: { ...s.me, password_kind: kind } } : {}))
        return null
      } catch (e) {
        if (e instanceof ApiError && e.status === 401 && e.message === 'Unauthorized')
          expireSession()
        return errorText(e)
      }
    },

    bootstrap: async () => {
      if (get().me || get().guest) {
        await bootUrl()
        return
      }
      await get().loadInstance()
      void get().loadSettings()
      const token = localStorage.getItem(LS.token)
      const guest = localStorage.getItem(LS.guest) === '1'
      const stored = readJson<unknown>(LS.guestServers, null)
      const guestServers = Array.isArray(stored)
        ? stored.filter((n): n is string => typeof n === 'string')
        : ['rchat']
      if (!guestServers.includes('rchat')) guestServers.unshift('rchat')
      if (token) {
        api.setToken(token)
        let me: Me
        try {
          me = await api.me()
        } catch (e) {
          if (endsSession(e)) {
            fail(e)
            expireSession()
            return
          }
          setTokenCookie(token)
          set({ token, guest: false })
          startWs()
          meAttempt = 0
          retryMe(e)
          return
        }
        setTokenCookie(token)
        applyMe(me, false)
        set({ token, guest: false, bootError: null })
        startWs()
        await bootUrl()
      } else if (guest) {
        persistGrants(readJson<Record<string, string>>(LS.guestGrants, {}))
        set({
          guest: true,
          guestServers,
          guestNames: readJson<Record<string, string>>(LS.guestNames, {}),
        })
        loadGuestLayout()
        armIce(null, false)
        startWs()
        await bootUrl()
      }
    },

    syncFromUrl: nav => resolveUrl(nav),

    register: body => act(async () => enter(await authRequest('/auth/register', body))),
    login: body => act(async () => enter(await authRequest('/auth/login', body))),

    logout: () => {
      const token = get().authExpired ? null : get().token
      const username = get().me?.username
      if (username) {
        writeLocal(home.scoped(secretsKey(username)), null)
        writeLocal(home.scoped(forwardKey(username)), null)
        writeLocal(home.scoped(historyKey(username)), null)
      }
      if (get().guest) {
        writeLocal(home.scoped(historyKey(null)), null)
        writeLocal(LS.guestServers, null)
        writeLocal(LS.guestNames, null)
      }
      const flushed = readQueue.flush()
      forgetSession()
      if (token)
        void Promise.race([flushed, new Promise(r => setTimeout(r, 3000))])
          .then(() => api.logout(token))
          .catch(() => {})
      home.ws.stop()
      forgetTyping(false)
      useProfanity(false)
      rtc.leave()
      p2p.signOut()
      writeLocal(LS.token, null)
      setTokenCookie(null)
      writeLocal(LS.guest, null)
      writeLocal(LS.guestGrants, null)
      forgetGuestMedia()
      api.setToken(null)
      api.setGrants({})
      home.ws.setGrants({})
      armIce(null, false)
      clearProfiles()
      dropStashedInvite()
      closedDms.clear()
      set({
        token: null,
        me: null,
        guest: false,
        guestGrants: {},
        guestNames: {},
        voice: null,
        call: null,
        selfAudio: SELF_AUDIO_IDLE,
        voiceUsers: {},
        voiceMuted: {},
        timeouts: {},
        servers: {},
        members: {},
        memberInfo: {},
        memberInfoTrim: {},
        adminChanges: {},
        interacted: {},
        bans: {},
        adminUsers: emptyPage<UserRef>(),
        adminServers: emptyPage<ServerSummaryLite>(),
        blocked: {},
        blockList: emptyPage<BlockedUser>(),
        ...friendsInitial(),
        ...selectionInitial(),
        dms: [],
        dmsMore: false,
        serversMore: false,
        layout: emptyLayout,
        emoji: EMPTY_PREFS,
        callRoute: DEFAULT_ROUTE,
        p2pCallFailed: {},
        notifyPrefs: EMPTY_NOTIFY,
        typingOn: true,
        typing: {},
        showSpoilers: 'click',
        view: null,
        home: false,
        invite: null,
        configLink: null,
        messages: {},
        older: {},
        newer: {},
        stale: {},
        focus: {},
        outbox: {},
        slowUntil: {},
        reads: {},
        readsReady: false,
        pings: NO_PINGS,
        groupPings: NO_GROUP_PINGS,
        unreadAnchor: {},
        atBottom: {},
        p2pAvailability: {},
        wsStatus: 'red',
        contextMenu: null,
        reactPicker: null,
        profile: null,
        activeDialog: null,
        confirm: null,
        panel: null,
        inboxOpen: false,
        pending: {},
        notices: [],
        noticesPaused: false,
        drafts: {},
        replying: {},
        forwardClip: null,
        linkCards: {},
        toast: null,
        pins: null,
        composerFocus: null,
        editing: null,
        bootError: null,
        search: emptySearch(),
        adminOverview: null,
      })
    },

    enterGuest: () =>
      act(async () => {
        writeLocal(LS.guest, '1')
        writeLocal(LS.guestServers, JSON.stringify(['rchat']))
        persistGrants({})
        persistGuestNames({})
        set({ guest: true, guestServers: ['rchat'] })
        loadGuestLayout()
        armIce(null, false)
        startWs()
      }),

    guestJoinServer: async (name, password, nav) => {
      const id = name.trim().toLowerCase()
      const viaGrant = async () => {
        if (password || get().guestGrants[id] === undefined) return false
        try {
          await fetchServer(id)
          return true
        } catch (e) {
          if (deniedAccess(e)) return false
          throw e
        }
      }
      if (!(await viaGrant())) {
        const { grant } = await api.guestAccess(id, password)
        if (grant) persistGrants({ ...get().guestGrants, [id]: grant })
        await fetchServer(id)
      }
      const list = get().guestServers
      persistGuestServers(list.includes(id) ? list : [...list, id])
      home.ws.subscribe([id])
      await get().openServer(id, undefined, nav)
    },

    openServer: (name, channelId, nav = 'push', at) =>
      act(async () => {
        const [detail] = await Promise.all([fetchServer(name), ensureMembership(name)])
        putServer(name, detail)
        void pruneScopes()
        const target = detail.channels.find(c => c.id === channelId) ?? detail.channels[0]
        if (!target) throw new Error(`No channels you can view in ${detail.display_name}`)
        await get().openChannel(name, target.id, nav, target.id === channelId ? at : undefined)
      }),

    openChannel: (server, channelId, nav = 'push', at) =>
      act(async () => {
        const view: View = { kind: 'channel', server, channelId }
        const key = viewKey(view)
        const before = get().view
        const entering = before?.kind !== 'channel' || before.server !== server
        readQueue.flush()
        leaveServerView(server)
        if (entering) refreshMemberInfo(server)
        enterView(view)
        syncUrl(view, nav)
        get().setViewing(server)
        const kind = get().servers[server]?.channels.find(c => c.id === channelId)?.kind
        if (kind === 'voice') return
        if (at !== undefined) {
          await loadAround(key, at)
          return
        }
        const msgs = await headLoad(key, () => fetchPage(key, {}))
        firstPage(key, msgs)
        askP2p(msgs)
      }),

    openDm: (dmId, nav = 'push', at) =>
      act(async () => {
        const view: View = { kind: 'dm', dmId }
        const key = viewKey(view)
        readQueue.flush()
        leaveServerView(null)
        enterView(view)
        syncUrl(view, nav)
        get().setViewing(null)
        const username = get().me?.username
        if (username) writeLocal(`${LS.lastDm}:${username}`, String(dmId))
        if (username && !get().dms.some(d => d.id === dmId))
          void get()
            .ensureDms([dmId])
            .then(() => reopenDm(dmId))
            .catch(() => {})
        if (at !== undefined) {
          await loadAround(key, at)
          return
        }
        const msgs = await headLoad(key, () => fetchPage(key, {}))
        firstPage(key, msgs)
        askP2p(msgs)
      }),

    openInvite: (server, password = null) => {
      const invite: OpenInvite = { server, password, join: false }
      set({ invite, contextMenu: null, profile: null, activeDialog: null })
      const path = invitePath(server)
      if (window.location.pathname !== path)
        window.history.pushState(entryState({ server, password, pushed: true }), '', path)
    },

    closeInvite: () => {
      const { view, invite } = get()
      const pushed = invite !== null && inviteEntry(window.history.state, invite.server)?.pushed
      leaveInvite()
      if (pushed) window.history.back()
      else if (view) syncUrl(view, 'push')
      else clearView('push')
    },

    syncInvite: readInvite,

    syncConfigLink: readConfigLink,

    closeConfigLink: () => {
      const { view, me, guest } = get()
      set({ configLink: null })
      if (!me && !guest) return
      if (view) syncUrl(view, 'replace')
      else clearView('replace')
    },

    applyConfig: applyConfigDoc,

    consumeInviteJoin: () =>
      set(s => (s.invite?.join ? { invite: { ...s.invite, join: false } } : {})),

    goHome: () => clearView(get().view || !atHome() ? 'push' : 'replace'),

    openLastDm: () => {
      const { me } = get()
      if (!me) return
      const stored = Number(localStorage.getItem(`${LS.lastDm}:${me.username}`))
      const known = () => get().dms.some(d => d.id === stored)
      const go = () => {
        const { dms } = get()
        const target = known() ? stored : (dms.find(d => d.is_self) ?? dms[0])?.id
        if (target !== undefined && sameUser(me.username)) void get().openDm(target)
      }
      if (known() || !(stored > 0)) go()
      else
        void get()
          .ensureDms([stored])
          .catch(() => {})
          .then(go)
    },

    loadBlockList: (q, reset = false) =>
      act(() =>
        loadPage(
          'blocks',
          () => get().blockList,
          blockList => set({ blockList }),
          cursor => api.blocks(cursor, q),
          b => b.user.username,
          q,
          reset
        )
      ),

    blockUser: async username => {
      const me = get().me
      if (!me || get().guest) return null
      try {
        const b = await api.block(username.trim())
        if (sameUser(me.username)) noteBlocked(b)
        return null
      } catch (e) {
        return errorText(e)
      }
    },

    unblockUser: (username, name) =>
      act(async () => {
        const me = get().me
        if (!me) return
        await api.unblock(username)
        if (!sameUser(me.username)) return
        noteUnblocked(username)
        if (name) toast('Unblocked', name)
      }),

    askBlock: user => {
      const s = get()
      if (!s.me || s.guest || user.username === s.me.username) return
      s.askConfirm({
        title: 'Block',
        body: `Block ${user.display_name}? They can't message or ping you, and their messages are hidden. They are not told.`,
        confirm: 'Block',
        action: () =>
          void get()
            .blockUser(user.username)
            .then(err => {
              if (err) fail(new Error(err))
              else toast('Blocked', user.display_name)
            }),
      })
    },

    openThread: (root, at) =>
      act(async () => {
        const key = threadKey(root.id)
        set(s => ({ panel: { kind: 'thread', root }, focus: keyed(s.focus, key, null) }))
        if (at !== undefined) {
          await loadAround(key, at)
          return
        }
        const msgs = await headLoad(key, () => fetchPage(key, {}))
        firstPage(key, msgs)
        askP2p(msgs)
      }),

    setViewing: server => {
      if (get().token) home.ws.setViewing(server)
    },
  }

  const handlers = {
    resync: () => {
      dropLinkCards()
      resync()
    },
  } satisfies Handlers

  return {
    handlers,
    actions,
    atHome,
    clearView,
    dropGrant,
    expireSession,
    guestLocked,
    lockedOut,
    noteBlocked,
    noteUnblocked,
    openChannelAt,
    persistGrants,
    persistGuestNames,
    persistGuestServers,
    refetchMe,
    rememberGuestName,
    sameUser,
    syncUrl,
    forgetSession,
  }
}
