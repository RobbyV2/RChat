import { readyIdentities, runDeletion } from '../account_deletion'
import {
  clearConfirmationHint,
  confirmationLoginGuard,
  interruptProviderPopup,
} from '../provider_confirmation'
import { parseLogoutFlag, SSO_LOGOUT_KEY } from '../sso'
import { authBrowser } from '../platform'
import {
  acceptHostedPolicy,
  allowsAccountOrigin,
  hostedLockMessage,
  hostedPolicyRevision,
} from '../client/hosted_policy'
import { accountHistoryState, routeOwnerFor } from '../client/account_paths'
import { BOOK_COORDINATION_ERROR } from '../client/book_store'
import { accountAdmission, addInstance, setGuest } from '../client/book'
import {
  confirmCredential,
  forgetCredential,
  accountUpdate,
  rememberLastDm,
  instanceDescriptor,
  storedCredential,
  readToken,
} from '../client/credentials'
import { sameSecret, Secret } from '../secret'
import { accountStorage } from '../client/keys'
import { client } from '../client/client'
import type { P2pApp } from '../p2p/app/runtime'
import type { AccountSession } from '../client/session'
// The signed-in session: sign-in and sign-out, the account and its settings, the URL and what
// is open, guests, invites, the socket and catch-up after outages.

import { eventRoom, cleanupRemoval } from '../viewing'
import { ApiError, createApi, type LoginRequest, type RegisterRequest } from '../api'
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
import { NO_DM_EDGE, dmListPrefs, dmQuery, queryKey } from '../dm_list'
import { EMPTY_PREFS } from '../emoji'
import { brandOf } from '../brand'
import { accountPrompt, createP2pGate, siteSettings } from '../features'
import { forwardKey } from '../forward'
import { type FriendsDeps, friendsInitial, type friendsSlice } from '../friends_store'
import { NO_GROUP_PINGS } from '../group_pings'
import { iceKey, iceValue, parseIce } from '../ice'
import { linkPrefsKey, linkPrefsValue, parseLinkPrefs, trustSite } from '../link_safety'
import { limitsOf } from '../instance_limits'
import {
  fitsHome,
  setMediaCookie,
  noteHomeInfo,
  pageHref,
  readLocal,
  resolveInstance,
  normalizeOrigin,
  sessionStore,
  shareOrigin,
  writeLocal,
} from '../instances'
import {
  type InviteEntry,
  type OpenInvite,
  dropStashedInvite,
  entryState,
  inviteEntry,
  parseInvite,
  sameInvite,
  takeStashedInvite,
  targetPath,
  publicInvitePath,
} from '../invite'
import { deniedAccess } from '../join_flow'
import { keyed, mergeHead, refreshTail, samePrefix } from '../lists'
import { bootDms, emptyLayout, knownDms, layoutServers, pruneLayout } from '../nav_layout'
import { EMPTY_NOTIFY, keepScopes } from '../notify'
import { historyKey } from '../openapi'
import { secretsKey } from '../passwords'
import { NO_PINGS } from '../pings'
import { clearProfiles } from '../profile'
import { tooManyText } from '../rate_limit'
import { type Decision, mergeRelays, relaysKey } from '../relays'
import { cleanBio } from '../rules'
import { displayNameError } from '../display_name'
import { selectionInitial, type selectionSlice } from '../selection_store'
import { serverNames } from '../selectors'
import { endsSession, meRetryIn } from '../session'
import { signupFailure } from '../signup'
import type { RChatState } from '../store_types'
import type {
  AuthResponse,
  BlockedUser,
  Me,
  ServerDetail,
  ServerSummaryLite,
  UserRef,
  WsEvent,
} from '../types'
import {
  type Nav,
  type View,
  accountPath,
  adminPath,
  parseAccountPath,
  parsePath,
  threadKey,
  viewKey,
  viewPath,
} from '../view'
import { SELF_AUDIO_IDLE } from '../voice_layout'
import { trimWindow } from '../window'
import {
  Banned,
  Ended,
  type GetState,
  type Handlers,
  PAGE,
  type SetState,
  emptyPage,
  emptySearch,
  errorText,
  serverKey,
  shownView,
} from './ctx'
import { dmKey, type messagesSlice } from './messages'
import type { presenceSlice } from './presence'
import type { readsSlice } from './reads'
import type { rtcSlice } from './rtc'
import type { serversSlice } from './servers'
import type { uiSlice } from './ui'
import { ANIM_DEFAULT } from '../motion/setting'
import { cause, logError } from '../log'
import { sleep, type Cancel } from '../clock'

// Waits before opening the URL again after a boot left nothing open because of 429s. Exported
// so tests can shorten them.
export const BOOT_RETRY_MS = [1000, 3000, 10_000]

const SWITCHED = 'You switched accounts'

const readJson = <T>(key: string, fallback: T): T => {
  try {
    const raw = readLocal(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

const POLL_EVERY = 60_000

type Ui = ReturnType<typeof uiSlice>
type Messages = ReturnType<typeof messagesSlice>
type Reads = ReturnType<typeof readsSlice>
type Servers = ReturnType<typeof serversSlice>

export type SessionDeps = { acct: AccountSession } & Pick<
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
  | 'readAnim'
  | 'saveCallRoute'
  | 'saveEmoji'
  | 'saveLayout'
  | 'saveNotify'
  | 'saveProfanityOn'
  | 'saveShowSpoilers'
  | 'saveTypingOn'
  | 'saveAnim'
  | 'systemNotice'
  | 'toast'
  | 'useNotify'
  | 'useProfanity'
> &
  Pick<ReturnType<typeof rtcSlice>, 'endRtc' | 'resetCallEvents' | 'recoverCallHistory' | 'joins'> &
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
    messagesHub: Pick<Messages, 'forget' | 'applyEmbeds'>
    serversHub: Pick<Servers, 'forget'>
    pollsHub: { forget: () => void }
  }

export const sessionSlice = (set: SetState, get: GetState, deps: SessionDeps) => {
  const { acct } = deps
  const { cancelViewing, canView, endViewing, instanceTarget, leaveVisit, requestViewing } =
    acct.viewing
  const { files: p2p, ice, relays: relayBook, rtc } = acct
  const home = acct.conn
  const api = acct.api
  const { endSession, inSession, live, sessionMark } = acct.lifetime
  const LS = {
    get guest() {
      return accountStorage(home).key('rchat_guest')
    },
    get guestServers() {
      return accountStorage(home).key('rchat_guest_servers')
    },
    get guestGrants() {
      return accountStorage(home).key('rchat_guest_grants')
    },
    get guestNames() {
      return accountStorage(home).key('rchat_guest_names')
    },
  }

  // P2P for the signed-in account, once the instance's settings say it is on. store.ts feeds it
  // every new settings object.
  let openP2p: (username: string | null) => void = () => {}
  const p2pGate = createP2pGate(username => openP2p(username))

  // Called with every live event after the store applied it (the palette index drops what the
  // viewer lost access to).
  const wsTaps = new Set<(ev: WsEvent) => void>()

  const tapWs = (tap: (ev: WsEvent) => void) => {
    wsTaps.add(tap)
    return () => void wsTaps.delete(tap)
  }

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
    resetCallEvents,
    recoverCallHistory,
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
    pollsHub,
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
    readAnim,
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
    saveAnim,
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

  let navigation = 0
  const beginNavigation = () => {
    navigation += 1
    cancelViewing()
    return navigation
  }

  const labelsOffline = () => get().channelLabelEpoch > 0 && get().wsStatus !== 'green'
  const admitChannel = async (server: string, id: number, intent: number) => {
    if (labelsOffline() || !instanceTarget(get(), server, id)) {
      await get().discoverChannels(server, true)
      if (intent !== navigation) return false
    }
    const target = instanceTarget(get(), server, id)
    if (!target || intent !== navigation) return false
    if (!canView(target) && !(await requestViewing(target))) return false
    const current = instanceTarget(get(), server, id)
    return intent === navigation && !!current && current.key === target.key && canView(current)
  }

  const authRequest = async (path: string, body: LoginRequest | RegisterRequest) => {
    try {
      return await api.req<AuthResponse>('POST', path, body)
    } catch (e) {
      if (e instanceof ApiError && e.status === 429)
        throw new ApiError(tooManyText(e.retryAfter), 429, e.data, e.retryAfter)
      throw e
    }
  }

  // The relay consent prompt: one host at a time, answered by answerRelayPrompt.
  let relayAnswer: ((d: Decision) => void) | null = null
  const settleRelayPrompt = (decision: Decision) => {
    const answer = relayAnswer
    relayAnswer = null
    set({ relayPrompt: null })
    answer?.(decision)
  }
  const bindSessionMedia = () => {
    openP2p = username => acct.identities.setAccount(username)
    relayBook.prompt = host =>
      new Promise<Decision>(resolve => {
        relayAnswer?.('deny')
        relayAnswer = resolve
        set({ relayPrompt: host })
      })
    const unsubscribe = relayBook.onChange(() => set({ relayPrefs: relayBook.prefs }))
    return () => {
      unsubscribe()
      openP2p = () => {}
      relayBook.prompt = async () => 'deny'
      if (relayAnswer) settleRelayPrompt('deny')
    }
  }
  const armIce = (username: string | null, signedIn: boolean) => {
    const { on, relay } = parseIce(readLocal(home.scoped(iceKey(username))))
    ice.setHelpers(on)
    ice.setRelay(relay)
    if (relayAnswer) settleRelayPrompt('deny')
    relayBook.load(signedIn && username !== null ? home.scoped(relaysKey(username)) : null)
    set({
      iceHelpers: on,
      iceRelay: relay,
      linkPrefs: parseLinkPrefs(readLocal(home.scoped(linkPrefsKey(username)))),
    })
    void ice.setSignedIn(signedIn)
    p2pGate.account(signedIn ? username : null)
  }

  // While the account's deletion runs, the session it revoked ends here, also when another tab
  // signs the account out, only once the P2P identities are done.
  let deleting = false

  const expireSession = () => {
    if (get().authExpired || deleting) return
    interruptProviderPopup(acct)
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
    const at = sessionMark()
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
    if (at !== sessionMark() || !notifySynced || notifyOwner() !== owner) return
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
  const applyConfigDoc = async (
    doc: ConfigDoc,
    keys: SectionKey[],
    identity: P2pApp | null = acct.identities.viewed() ?? null
  ): Promise<string | null> => {
    const ownsRail = () => !identity || acct.identities.get(identity.localId) === identity
    if (keys.includes('layout') && doc.layout?.p2p && !ownsRail())
      return 'The selected P2P identity is no longer available'
    const want = new Set(keys.filter(k => doc[k] !== undefined))
    if (want.has('theme') && doc.theme) get().setTheme(doc.theme)
    if (want.has('streamer') && doc.streamer !== undefined) get().setStreamer(doc.streamer)
    const { me, guest } = get()
    if (!me && !guest) {
      const rest = [...want].filter(k => !sectionOf(k).device)
      if (rest.length) stashConfig(doc, rest, acct.handoff)
      return null
    }
    const username = me?.username ?? null
    const at = sessionMark()
    const still = () =>
      at === sessionMark() &&
      (get().me?.username ?? null) === username &&
      (!!get().me || get().guest)
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
        if (l.p2p) {
          if (!ownsRail()) return 'The selected P2P identity is no longer available'
          identity?.p2pRail.apply(l.p2p)
        }
        saveLayout(
          pruneLayout(
            {
              ...s.layout,
              servers: l.servers,
              dmOrder: l.dmOrder,
              dmPinned: l.dmPinned,
              selfPin: l.selfPin,
              collapsed: l.collapsed ?? s.layout.collapsed,
              ...(l.dmList ? { dmList: l.dmList } : {}),
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
    if (want.has('animations') && doc.animations) saveAnim(doc.animations)
    if (want.has('profanity') && doc.profanity !== undefined) saveProfanityOn(doc.profanity)
    if (want.has('spoilers') && doc.spoilers !== undefined) saveShowSpoilers(doc.spoilers)
    if (want.has('relays') && doc.relays && me)
      relayBook.save(mergeRelays(relayBook.prefs, doc.relays))
    return failed.length ? `Couldn't apply: ${failed.join(', ')}` : null
  }

  const applyStashedConfig = async () => {
    const stashed = takeStashedConfig(acct.handoff)
    if (!stashed || !stashed.keys.length) return
    const at = sessionMark()
    const error = await applyConfigDoc(stashed.doc, stashed.keys)
    if (at !== sessionMark()) return
    if (error) fail(new Error(error))
    else toast('Config applied')
  }

  const syncLayout = async () => {
    const at = sessionMark()
    const { servers } = get().layout
    const asked = bootDms(get().layout, PAGE)
    try {
      await get().ensureServers(layoutServers(servers))
      await get().ensureDms(asked)
    } catch {
      return
    }
    if (at !== sessionMark()) return
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
    if (at !== sessionMark()) return
    await applyStashedConfig()
  }

  const loadGuestLayout = () => {
    set({
      layout: readLayout(null),
      typingOn: readTyping(null),
      anim: readAnim(null),
      showSpoilers: readSpoilers(null),
    })
    useProfanity(readProfanity(null))
    useNotify(readNotify(null))
    saveLayout(pruneLayout(get().layout, get().guestServers, null))
    notifySynced = true
    void pruneScopes().then(applyStashedConfig)
  }

  const setBlocked = (blocked: Blocked) => {
    set(s => ({ blocked, typing: withoutTypers(s.typing, blocked) }))
  }

  const loadBlocked = async () => {
    if (!get().me || get().guest) return
    const at = sessionMark()
    let names: unknown
    try {
      names = await api.blockedUsernames()
    } catch {
      return
    }
    if (at !== sessionMark() || !Array.isArray(names)) return
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

  const recordGuest = (guest: boolean) => {
    const instance = instanceDescriptor(home)
    client.updateBook(book => setGuest(addInstance(book, instance), instance.origin, guest))
  }
  let restoring: ReturnType<typeof storedCredential> = null
  const authenticated = async (
    me: Me,
    token: Secret,
    restore: boolean,
    currentIntent = () => true
  ) => {
    const expected = acct.credentialTarget ?? (restore ? restoring?.username : undefined)
    const mark = sessionMark()
    const changed = () =>
      (expected && expected !== me.username) ||
      (restore && restoring && !token.same(readToken(restoring.key)))
    const save = accountUpdate(home, me)
    let readOnly = false
    const current = await client.updateBook(
      book => (currentIntent() && mark === sessionMark() && !changed() ? save(book) : book),
      () => {
        readOnly = true
      }
    )
    if (!currentIntent() || mark !== sessionMark()) return false
    const admitted = current.instances
      .find(i => i.origin === home.origin)
      ?.accounts.some(a => a.username === me.username)
    if (!admitted || changed()) {
      const message = changed()
        ? 'Saved account session changed. Sign in again.'
        : readOnly
          ? BOOK_COORDINATION_ERROR
          : (accountAdmission(current, home.origin, me.username) ??
            'Could not add the saved account.')
      if (!restore && get().token) throw new Error(message)
      home.ws.stop()
      api.setToken(null)
      set({ token: null, bootError: message, error: message })
      if (!restore) {
        throw new Error(message)
      }
      return false
    }
    if (restore) confirmCredential(home, me, token, true)
    return true
  }
  const applyMe = (fresh: Me, keep: boolean) => {
    const cur = get()
    const same = keep && cur.me?.username === fresh.username
    const steady = {
      servers: same && !!cur.me && samePrefix(cur.me.servers, fresh.servers, serverKey),
      dms: same && samePrefix(cur.dms, fresh.dms, dmKey),
    }
    const dmHead = dmPager.head(fresh, same, steady.dms)
    const resume = {
      servers: serverPager.reset(fresh.servers_cursor, steady.servers) && same,
      dms: dmHead.resume && same,
    }
    set({
      guest: false,
      me: {
        ...fresh,
        servers:
          same && cur.me
            ? mergeHead(cur.me.servers, fresh.servers, fresh.servers_more, serverKey)
            : fresh.servers,
      },
      dms: same ? mergeHead(cur.dms, fresh.dms, fresh.dms_more, dmKey) : fresh.dms,
      serversMore: fresh.servers_more,
      ...dmHead.state,
      ...(same
        ? {}
        : {
            layout: readLayout(fresh.username),
            emoji: readEmoji(fresh.username),
            callRoute: readCallRoute(fresh.username),
            p2pCallFailed: {},
            forwardClip: readForward(fresh.username),
            forwardShowSource: null,
            notifyPrefs: readNotify(fresh.username),
            typingOn: readTyping(fresh.username),
            anim: readAnim(fresh.username),
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
    if (resume.dms || queryKey(dmQuery(dmListPrefs(get().layout))) !== dmPager.asking())
      void get().loadMoreDms()
    if (!same) void syncLayout()
    if (!same) void loadBlocked()
    if (!same) void friendsHub.loadSummary()
    if (!same) void selectionHub.loadJobs()
  }

  const refetchMe = (background = false) => {
    const at = sessionMark()
    const token = get().token
    const current = () => at === sessionMark() && sameSecret(token, get().token)
    return api
      .me(background)
      .then(me => {
        if (!current()) return
        const wasRestricted = get().me?.password_temporary?.change === 'required'
        applyMe(me, true)
        if (wasRestricted && me.password_temporary?.change !== 'required') startWs()
      })
      .catch(e => {
        if (!current()) return
        if (endsSession(e)) expireSession()
        else fail(e)
      })
  }

  let meRetry: Cancel | null = null
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
    meRetry = acct.time.after(wait, () => void recoverMe())
  }

  const recoverMe = async () => {
    meRetry?.()
    meRetry = null
    if (recovering || get().me || !get().token) return
    recovering = true
    const at = sessionMark()
    try {
      const me = await api.me()
      if (!get().token || at !== sessionMark()) return
      if (!(await authenticated(me, get().token!, true)) || at !== sessionMark()) return
      meAttempt = 0
      applyMe(me, false)
      set({ bootError: null })
      p2p.announce()
      void loadUnreads()
      await bootUrl()
    } catch (e) {
      if (at === sessionMark()) retryMe(e)
    } finally {
      if (at === sessionMark()) recovering = false
    }
  }

  // Refetches the account, or retries the boot when a token is saved but the account never loaded.
  const refreshMe = (background = false) => {
    if (get().me) void refetchMe(background)
    else if (get().token) void recoverMe()
  }

  const refreshView = async () => {
    if (acct.mode === 'lite' || acct.mode === 'parked') return
    const { view } = get()
    if (!view) return
    try {
      const key = viewKey(view)
      if (view.kind === 'channel') {
        const detail = await fetchServer(view.server)
        if (get().view !== view) return
        putServer(view.server, detail)
        const target = instanceTarget(get(), view.server, view.channelId)
        if (!target || !canView(target) || get().view !== view) return
      }
      if (detached(key)) {
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
        messages: { ...s.messages, [key]: messagesHub.applyEmbeds(bounded.list) },
        older: {
          ...s.older,
          [key]: {
            more: next.more || bounded.trimmed,
            loading: !replaced && (s.older[key]?.loading ?? false),
          },
        },
      }))
      askP2p(msgs)
    } catch (e) {
      if (e instanceof Ended) return
      if (view.kind === 'channel' && lockedOut(e)) guestLocked(view.server)
      else logError('degraded poll', cause(e))
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
  // member list, its groups and looked-up members.
  const catchUpLists = () => {
    if (get().me) void loadUnreads()
    void pruneServers()
      .catch(() => {})
      .then(
        inSession(() => {
          const { view, members, hoisted } = get()
          if (view?.kind !== 'channel') return
          if (members[view.server]) void get().loadMembers(view.server, true)
          if (hoisted[view.server]) get().clearGroups(view.server)
          refreshMemberInfo(view.server)
        })
      )
  }

  const catchUp = () => {
    void refreshView()
    catchUpLists()
  }

  let resyncTimer: Cancel | null = null

  const resync = () => {
    if (resyncTimer) return
    resyncTimer = acct.time.after(
      250 + Math.random() * limitsOf(get().instance).resync_jitter_ms,
      () => {
        resyncTimer = null
        set({
          p2pAvailability: {},
          voiceUsers: {},
          voiceServers: {},
          voiceMuted: {},
          voiceHushed: {},
          voiceAudio: {},
        })
        home.ws.resubscribe()
        refreshMe(true)
        void loadBlocked()
        void friendsHub.loadSummary()
        friendsHub.reloadOpenLists()
        void selectionHub.loadJobs()
        const { view } = get()
        if (view?.kind === 'channel' && !instanceTarget(get(), view.server, view.channelId)) {
          void get()
            .discoverChannels(view.server)
            .catch(() => {})
        } else if (view) askP2p(get().messages[viewKey(view)] ?? [])
        const { pins } = get()
        if (pins) loadPins(pins.key)
        catchUp()
      }
    )
  }

  let downSince: number | null = null
  let viewTimer: Cancel | null = null
  let catchUpTimer: Cancel | null = null
  let polledMe: number | null = null
  let polledSettings: number | null = null

  const stopCatchUp = () => {
    viewTimer?.()
    catchUpTimer?.()
    viewTimer = null
    catchUpTimer = null
  }

  const scheduleCatchUp = (outage: number) => {
    stopCatchUp()
    viewTimer = acct.time.after(
      catchUpDelay(outage, Math.random, limitsOf(get().instance).catch_up_delay_ms),
      () => {
        viewTimer = null
        void refreshView()
      }
    )
    catchUpTimer = acct.time.after(
      catchUpDelay(outage, Math.random, limitsOf(get().instance).reconnect_cap_ms),
      () => {
        catchUpTimer = null
        refreshMe(true)
        catchUpLists()
      }
    )
  }

  let pageListeners: AbortController | undefined
  const listenPage = () => {
    if (pageListeners || typeof document === 'undefined' || typeof window === 'undefined') return
    pageListeners = new AbortController()
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.visibilityState !== 'visible') {
          readQueue.flush()
          return
        }
        if (!acct.socketAllowed) return
        home.ws.ensureConnected()
        if (acct.mode !== 'shown') return
        const { atBottom, messages, reads, unreadAnchor, panel } = get()
        const view = shownView(acct, get().view)
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
      },
      { signal: pageListeners.signal }
    )
    window.addEventListener('pagehide', () => readQueue.flush(), { signal: pageListeners.signal })
  }

  const startWs = () => {
    if (!acct.socketAllowed) return
    let connected = false
    downSince = null
    stopCatchUp()
    listenPage()
    const dispatch = (ev: WsEvent) => {
      get().applyWsEvent(ev)
      for (const tap of wsTaps) tap(ev)
    }
    if (get().me?.password_temporary?.change === 'required') {
      home.ws.stop()
      return
    }
    home.ws.onPasswordChangeRequired = () => refreshMe(true)
    home.ws.onEvent = ev => {
      const room = eventRoom(ev)
      if (room) {
        const target = instanceTarget(get(), room.server, room.id)
        if ((!target || !canView(target)) && cleanupRemoval(ev, id => p2p.forgetMessage(id))) return
        if (!target) {
          // A subscription may deliver messages before this tab opens the server.
          void get()
            .discoverChannels(room.server)
            .then(
              inSession(() => {
                const found = instanceTarget(get(), room.server, room.id)
                if (found && canView(found)) dispatch(ev)
              })
            )
            .catch(() => {})
          return
        }
        if (!canView(target)) return
      }
      dispatch(ev)
    }
    let interrupted = false
    home.ws.onStatus = wsStatus => {
      const offline = wsStatus !== 'green'
      if (offline !== interrupted) {
        interrupted = offline
        set(s => ({ wsStatus, channelLabelEpoch: s.channelLabelEpoch + 1 }))
      } else set({ wsStatus })
      if (wsStatus !== 'green') {
        if (get().guestVoiceName !== null) set({ guestVoiceName: null })
        forgetTyping(false)
        if (downSince === null) downSince = acct.time.now()
        endRtc()
        return
      }
      const outage = downSince === null ? 0 : acct.time.now() - downSince
      downSince = null
      set({
        p2pAvailability: {},
        voiceUsers: {},
        voiceServers: {},
        voiceMuted: {},
        voiceHushed: {},
        voiceAudio: {},
      })
      if (get().me) p2p.announce()
      else if (get().token) void recoverMe()
      const { view } = get()
      if (view?.kind === 'channel' && !instanceTarget(get(), view.server, view.channelId)) {
        void get()
          .discoverChannels(view.server)
          .catch(() => {})
      } else if (view) askP2p(get().messages[viewKey(view)] ?? [])
      if (connected) scheduleCatchUp(outage)
      connected = true
    }
    home.ws.onPoll = () => {
      void refreshView()
      const now = acct.time.now()
      if (due(polledMe, now, POLL_EVERY)) {
        polledMe = now
        refreshMe(true)
      }
      if (due(polledSettings, now, POLL_EVERY)) {
        polledSettings = now
        void get().loadSettings(true)
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
    const sealed = Object.fromEntries(
      Object.entries(grants).map(([server, grant]) => [server, Secret.of(grant)])
    )
    api.setGrants(sealed)
    home.ws.setGrants(sealed)
    set({ guestGrants: grants })
  }

  const dropGrant = (server: string) => {
    if (!(server in get().guestGrants)) return
    const grants = { ...get().guestGrants }
    delete grants[server]
    persistGrants(grants)
  }

  const leaveInvite = () => {
    if (get().invite) set({ invite: null })
    if (get().configLink) set({ configLink: null })
  }

  const ownsPage = () => client.canWritePage(acct)
  const localPage = (pathname = window.location.pathname ?? '/') => {
    const route = parseAccountPath(pathname)
    if (!route) return null
    if (route.owner) {
      const { me, guest } = get()
      const user = me?.username ?? (guest || acct.credentialTarget === null ? null : undefined)
      if (route.owner.host !== home.host || route.owner.username !== user) return null
    }
    return route.path
  }
  // Session storage keeps Back and reload working in the same tab. Ending this login
  // retires its history entries, including when the next login has the same username.
  let inviteHistory: { key: string; nonce: string } | null = null
  const inviteHistoryKey = () => 'rchat_invite_history:' + JSON.stringify([home.origin, acct.id])
  const inviteHistoryOwner = () => {
    const key = inviteHistoryKey()
    if (inviteHistory?.key !== key) {
      const nonce = sessionStore.getItem(key) || crypto.randomUUID()
      inviteHistory = { key, nonce }
      sessionStore.setItem(key, nonce)
    }
    return inviteHistory.nonce
  }

  const readConfigLink = () => {
    if (!ownsPage()) return false
    const path = localPage()
    if (path === null) return false
    const id = parseConfigPath(path)
    if (get().configLink !== id) set({ configLink: id })
    return id !== null
  }

  const rememberInvite = (entry: InviteEntry) => {
    const mark = sessionMark()
    const owner = inviteHistoryOwner()
    const currentUrl = window.location.href
    queueMicrotask(() => {
      if (
        !ownsPage() ||
        mark !== sessionMark() ||
        owner !== inviteHistoryOwner() ||
        window.location.href !== currentUrl
      )
        return
      const origin = shareOrigin(undefined, undefined, home)
      const path = localPage()
      if (path === null) return
      const shown = parseInvite(pageHref(origin, path), origin)
      if (!shown || !sameInvite(shown, entry)) return
      const clean = new URL(currentUrl)
      clean.pathname = accountPath(targetPath(entry), routeOwnerFor(acct))
      window.history.replaceState(
        accountHistoryState(acct, entryState(entry, owner)),
        '',
        publicInvitePath(clean)
      )
    })
  }

  const readInvite = () => {
    if (!ownsPage()) return false
    const origin = shareOrigin(undefined, undefined, home)
    const path = localPage()
    if (path === null) return false
    const target = parseInvite(pageHref(origin, path), origin)
    const code = target?.code ?? null
    const handoff = takeStashedInvite(target?.server ?? null, code, acct.handoff)
    if (!target) {
      leaveInvite()
      return false
    }
    const { me, guest } = get()
    const join = handoff !== null && (me !== null || guest)
    if (code) {
      set({ invite: { server: '', password: null, code, join } })
      return true
    }
    const { server } = target
    const entry = inviteEntry(window.history.state, server, null, inviteHistoryOwner())
    const password = target.password ?? entry?.password ?? handoff?.password ?? null
    if (target.password !== null || password !== (entry?.password ?? null))
      rememberInvite({ server, password, pushed: entry?.pushed ?? false })
    set({ invite: { server, password, join } })
    return true
  }

  const atHome = () => localPage() === '/'

  // The history entry of the open admin page: how many entries the page has pushed, and the
  // address it was opened over, when it was opened from inside the app.
  const adminEntry = (): { depth: number; from: string | null } => {
    const held = (window.history.state as { rchatAdmin?: unknown } | null)?.rchatAdmin
    const { depth, from } = (typeof held === 'object' && held !== null ? held : {}) as {
      depth?: unknown
      from?: unknown
    }
    return typeof depth === 'number' && depth > 0 && typeof from === 'string'
      ? { depth, from }
      : { depth: 0, from: null }
  }

  const hashRow = () => {
    try {
      return decodeURIComponent((window.location.hash ?? '').slice(1)) || null
    } catch {
      return null
    }
  }

  // While the admin page is open the address is its own: only going somewhere on purpose
  // (a push) leaves it.
  const syncUrl = (view: View | null, nav: Nav) => {
    leaveInvite()
    if (get().adminPage) {
      if (nav !== 'push') return
      set({ adminPage: null })
    }
    if (nav === 'none' || !ownsPage() || (nav !== 'push' && client.noticePending(acct))) return
    const path = viewPath(view, routeOwnerFor(acct))
    if (window.location.pathname !== path || client.noticePending(acct)) {
      if (nav === 'push') window.history.pushState(accountHistoryState(acct, null), '', path)
      else window.history.replaceState(accountHistoryState(acct, null), '', path)
    }
    client.commitNotice(acct)
  }

  // `retrying`: a boot that tries again after a 429, so it must not fall back yet.
  const canOpenDm = async (id: number) => {
    if (get().guest || !get().me) return false
    const known = () => get().dms.some(dm => dm.id === id) || closedDms.has(id)
    if (!known())
      await get()
        .ensureDms([id])
        .catch(() => {})
    return known()
  }

  const resolveUrl = async (nav: 'replace' | 'none', retrying = false) => {
    if (!client.ownsHistoryEntry(acct)) return
    const intent = beginNavigation()
    const path = localPage()
    if (path === null) return
    if (readInvite() || readConfigLink() || (!get().me && !get().guest)) return
    const at = sessionMark()
    const ended = () => !ownsPage() || at !== sessionMark() || navigation !== intent
    const parsed = parsePath(path)
    // Only the site admin has admin paths. For everyone else they are paths nobody knows.
    if (parsed?.kind === 'admin' && get().me?.is_site_admin === true) {
      set({ adminPage: { section: parsed.section, item: parsed.item, row: hashRow() } })
      if (!get().view && !get().home) set({ home: true })
      return
    }
    if (get().adminPage) set({ adminPage: null })
    const target = parsed?.kind === 'admin' ? null : parsed
    const fallback = async () => {
      await readsHub.ready()
      if (ended()) return
      return leaveForSafety()
    }
    if (target?.kind === 'message') {
      await readsHub.ready()
      if (ended()) return
      const place = target.place
      if (
        place.kind === 'channel' &&
        !(await admitChannel(place.server, place.channelId, intent))
      ) {
        if (!ended()) {
          syncUrl(get().view, 'replace')
          if (!get().view) set({ home: true })
        }
        return
      }
      const opened = await openMessageAt(
        target.id,
        'replace',
        () => !ended(),
        target.place,
        target.thread
      ).catch((e: unknown) => {
        if (!ended()) fail(e)
        return true
      })
      if (ended()) return
      if (!opened) toast("You can't open this message")
      const now = get().view
      return now ? syncUrl(now, 'replace') : fallback()
    }
    const cur = get().view
    if (target && target.kind !== 'server' && cur && viewPath(target) === viewPath(cur)) return
    if (!target && atHome()) return cur ? clearView() : set({ home: true })
    if (!target) return fallback()
    if (target.kind === 'dm') {
      if (!(await canOpenDm(target.dmId))) return fallback()
      await readsHub.ready()
      if (ended()) return
      return get().openDm(target.dmId, nav)
    }
    let detail: ServerDetail
    try {
      detail = (
        await live(Promise.all([fetchServer(target.server), ensureMembership(target.server)]))
      )[0]
    } catch (e) {
      if (ended()) return
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
    if (ended()) return
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
    if (ended()) return
    return get().openChannel(target.server, channel.id, channel.id === wanted ? nav : 'replace')
  }

  // Opens what the URL asks for at load. Rate limited requests (many tabs or a busy network) can
  // leave nothing open; then it tries again a few times, unless the user went somewhere else.
  let bootRetry: Cancel | undefined
  const bootUrl = async (attempt = 0): Promise<void> => {
    const started = acct.time.now()
    const at = sessionMark()
    await resolveUrl('replace', attempt < BOOT_RETRY_MS.length)
    if (!ownsPage() || at !== sessionMark()) return
    const s = get()
    const stuck = !s.view && !s.home && !s.invite && !s.configLink && (!!s.me || s.guest)
    if (!stuck || limitedAt() < started || attempt >= BOOT_RETRY_MS.length) return
    const path = window.location.pathname
    bootRetry?.()
    bootRetry = acct.time.after(BOOT_RETRY_MS[attempt], () => {
      const now = get()
      if (window.location.pathname === path && !now.view && !now.home) void bootUrl(attempt + 1)
    })
  }

  // A session can be retargeted while its issued token waits for admission. Logout must use
  // that token explicitly and must still go to its issuer.
  const issuedTokenCleanup = () => {
    const base = api.base,
      prefix = api.prefix
    return (token: Secret) => {
      const issuer = api.base === base ? api : createApi(base, 'omit')
      if (issuer !== api) issuer.prefix = prefix
      return issuer.logout(token).catch(() => undefined)
    }
  }

  const enter = async (
    res: AuthResponse,
    currentIntent = () => true,
    endSessionEnabled = false
  ) => {
    const mark = sessionMark()
    const token = Secret.of(res.token)
    dropLinkCards()
    const revoke = issuedTokenCleanup()
    try {
      if (
        !(await authenticated(res.user, token, false, currentIntent)) ||
        mark !== sessionMark() ||
        !currentIntent()
      ) {
        revoke(token)
        return
      }
    } catch (error) {
      revoke(token)
      throw error
    }
    confirmCredential(home, res.user, token, false, endSessionEnabled)
    if (token.same(readToken(accountStorage(home).key('rchat_token')))) setMediaCookie(home, token)
    if (get().guest) {
      writeLocal(LS.guest, null)
      recordGuest(false)
    }
    clearConfirmationHint(acct)
    api.setToken(token)
    applyMe(res.user, false)
    // A fresh login gets fresh history even when the expired session ended
    // before bootstrap could recover its username.
    sessionStore.removeItem(inviteHistoryKey())
    inviteHistory = null
    set({
      token,
      providerConfirmation: undefined,
      guest: false,
      signedOut: false,
      authExpired: false,
      bootError: null,
    })
    startWs()
  }

  const authenticate = async (path: string, body: LoginRequest | RegisterRequest) => {
    const mark = sessionMark()
    if (
      typeof acct.credentialTarget === 'string' &&
      (path === '/auth/register' || body.username.toLowerCase() !== acct.credentialTarget)
    )
      throw new Error('Sign in with the saved username for this link.')
    const limit = accountAdmission(client.book.getState(), home.origin, body.username)
    if (limit) throw new Error(limit)
    const response = await authRequest(path, body)
    if (mark !== sessionMark()) throw new Ended('The session ended')
    await enter(response)
  }

  // Leaves the current view for none (home); a previewed server is forgotten on the way out.
  const clearView = (nav: Nav = 'replace') => {
    beginNavigation()
    readQueue.flush()
    leaveServerView(null)
    syncUrl(null, nav)
    set({ view: null, pins: null, threads: null, panel: null, home: true })
    leaveVisit()
    get().setViewing(null)
  }

  const enterView = (view: View) => {
    const key = viewKey(view)
    const before = get().view
    const left = before ? viewKey(before) : null
    if (left && left !== key) lateAnchor.delete(left)
    set(s => ({
      view,
      home: false,
      panel: left !== key && s.panel?.kind === 'thread' ? null : s.panel,
      atBottom: { ...s.atBottom, [key]: true },
      focus: keyed(s.focus, key, null),
      unreadAnchor: left && left !== key ? keyed(s.unreadAnchor, left, null) : s.unreadAnchor,
      pins: s.pins && s.pins.key !== key ? null : s.pins,
      threads: s.threads !== key ? null : s.threads,
    }))
    leaveVisit(
      view.kind === 'channel' ? instanceTarget(get(), view.server, view.channelId)?.key : undefined
    )
    placeAnchor(key)
  }

  const openChannelAt = async (
    server: string,
    channelId: number,
    threadRootId: number | null,
    id: number,
    nav: Nav = 'push',
    switching = false
  ) => {
    const v = shownView(acct, get().view)
    const here = v?.kind === 'channel' && v.channelId === channelId
    const at = threadRootId ?? id
    const mark = sessionMark()
    if (switching) await get().openChannel(server, channelId, nav, at, navigation)
    else if (here) {
      set({ panel: null })
      await get().jumpTo(viewKey({ kind: 'channel', server, channelId }), at)
    } else await get().openServer(server, channelId, nav, at)
    const now = get().view
    if (
      threadRootId === null ||
      mark !== sessionMark() ||
      now?.kind !== 'channel' ||
      now.server !== server ||
      now.channelId !== channelId
    )
      return
    const root = (get().messages[`c${channelId}`] ?? []).find(m => m.id === threadRootId)
    if (root) await get().openThread(root, id)
  }

  // A DM message, or a reply in one of its threads: the DM at it (or at the thread's root), then
  // the thread at the reply.
  const openDmAt = async (
    dmId: number,
    threadRootId: number | null,
    id: number,
    nav: Nav = 'push',
    switching = false
  ) => {
    const v = shownView(acct, get().view)
    const at = threadRootId ?? id
    const mark = sessionMark()
    if (!switching && v?.kind === 'dm' && v.dmId === dmId) {
      if (threadRootId === null && get().panel?.kind === 'thread') set({ panel: null })
      await get().jumpTo(`d${dmId}`, at)
    } else await get().openDm(dmId, nav, at)
    const now = get().view
    if (threadRootId === null || mark !== sessionMark() || now?.kind !== 'dm' || now.dmId !== dmId)
      return
    const root = (get().messages[`d${dmId}`] ?? []).find(m => m.id === threadRootId)
    if (root) await get().openThread(root, id)
  }

  // Drops the timers, queues and caches of the signed-in session.
  const forgetSession = () => {
    restoring = null
    recovering = false
    p2pGate.account(null)
    sessionStore.removeItem(inviteHistoryKey())
    if (inviteHistory && sessionStore.getItem(inviteHistory.key) === inviteHistory.nonce)
      sessionStore.removeItem(inviteHistory.key)
    inviteHistory = null
    client.calls.end(acct)
    resetCallEvents()
    acct.invites.clear()
    acct.media.clear()
    acct.textPreviews.clear()
    acct.apiDoc.reset()
    acct.adminConfig.setState({ config: null })
    beginNavigation()
    endViewing(get().guest)
    endSession()
    bootRetry?.()
    resyncTimer?.()
    resyncTimer = null
    downSince = polledMe = polledSettings = null
    dropLinkCards()
    uiHub.forget()
    meRetry?.()
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
    pollsHub.forget()
  }

  const actions: Pick<
    RChatState,
    | 'loadInstance'
    | 'switchInstance'
    | 'loadSettings'
    | 'loadBrand'
    | 'setBrand'
    | 'setTheme'
    | 'setStreamer'
    | 'setIceHelpers'
    | 'setLinkPrefs'
    | 'trustLinkSite'
    | 'setIceRelay'
    | 'saveRelays'
    | 'answerRelayPrompt'
    | 'patchMe'
    | 'setBio'
    | 'setDisplayName'
    | 'setAppearOffline'
    | 'refreshAccount'
    | 'expireSession'
    | 'deleteAccount'
    | 'keepAccount'
    | 'checkSession'
    | 'changePassword'
    | 'bootstrap'
    | 'syncFromUrl'
    | 'openAdmin'
    | 'closeAdmin'
    | 'register'
    | 'login'
    | 'ssoExchange'
    | 'enterSsoSession'
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
    loadInstance: async (current = () => true, cache) => {
      const mark = sessionMark()
      set({ instance: home.info, instanceHost: home.host })
      try {
        const info = await api.instance(cache)
        if (!current() || mark !== sessionMark()) return null
        if (!fitsHome(info, home)) throw new Error('instance endpoints moved to another site')
        accountStorage(home)
        noteHomeInfo(info, home)
        set({ instance: info, instanceHost: home.host })
        void ice.refresh()
        return true
      } catch {
        if (!current() || mark !== sessionMark()) return null
        set({ instanceHost: home.host })
        return false
      } finally {
        if (current() && mark === sessionMark()) acct.discovery.done()
      }
    },

    switchInstance: async address => {
      if (get().token || get().guest) return 'Log out before switching instances'
      const mark = sessionMark()
      try {
        if (!allowsAccountOrigin(normalizeOrigin(address) ?? address)) return hostedLockMessage()
        const { origin, info } = await resolveInstance(address)
        if (!allowsAccountOrigin(origin)) return hostedLockMessage()
        if (get().token || get().guest) return 'Log out before switching instances'
        if (mark !== sessionMark()) return 'Instance selection changed'
        if (origin !== home.origin || home.info?.id !== info.id) {
          forgetSession()
          home.ws.stop()
          client.selectHome(origin, info, home)
        } else noteHomeInfo(info, home)
        acct.discovery.done()
        set({ instance: info, instanceHost: home.host, error: null })
        void ice.refresh()
        await get().loadSettings()
        return null
      } catch (e) {
        return errorText(e)
      }
    },

    loadSettings: async (background = false, current = () => true) => {
      const revision = hostedPolicyRevision()
      const mark = sessionMark()
      try {
        const settings = await api.getSettings(background)
        if (current() && mark === sessionMark()) {
          set({ settings: siteSettings(settings) })
          acceptHostedPolicy(acct.conn.origin, settings.client_other_instances, revision)
        }
      } catch (e) {
        if (current() && mark === sessionMark()) fail(e)
      }
      if (current() && mark === sessionMark()) void get().loadBrand()
    },

    // An instance that sends no brand, or can't be reached, leaves the one the app has.
    loadBrand: async () => {
      const at = sessionMark()
      try {
        const raw = await api.brand()
        if (at === sessionMark()) get().setBrand(raw)
      } catch {
        return
      }
    },

    setBrand: raw => set({ brand: brandOf(raw) }),

    setTheme: client.device.setTheme,
    setStreamer: client.device.setStreamer,

    setIceHelpers: on => {
      const relay = get().iceRelay
      writeLocal(home.scoped(iceKey(get().me?.username ?? null)), iceValue({ on, relay }))
      ice.setHelpers(on)
      set({ iceHelpers: on })
    },

    setLinkPrefs: prefs => {
      writeLocal(home.scoped(linkPrefsKey(get().me?.username ?? null)), linkPrefsValue(prefs))
      set({ linkPrefs: prefs })
    },

    trustLinkSite: site => get().setLinkPrefs(trustSite(get().linkPrefs, site)),

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
        const mark = sessionMark()
        const user = await api.patchMe(avatar_kind, avatar_color, banner_color)
        if (mark !== sessionMark()) return
        set(s => (s.me ? { me: { ...s.me, ...user } } : {}))
      }),

    setBio: async bio => {
      const { me, settings } = get()
      if (!me) return `${accountPrompt(settings)} to add a description`
      try {
        const mark = sessionMark()
        const user = await api.setBio(cleanBio(bio) ? bio : null)
        if (mark !== sessionMark()) return null
        set(s => (s.me?.username === me.username ? { me: { ...s.me, ...user } } : {}))
        return null
      } catch (e) {
        return errorText(e)
      }
    },

    setDisplayName: async name => {
      const { me } = get()
      if (!me) return `${accountPrompt(get().settings)} to change your display name`
      const invalid = displayNameError(name)
      if (invalid) return invalid
      try {
        const mark = sessionMark()
        const user = await api.setDisplayName(name.trim())
        if (mark !== sessionMark()) return null
        set(s => (s.me?.username === me.username ? { me: { ...s.me, ...user } } : {}))
        return null
      } catch (e) {
        return errorText(e)
      }
    },

    setAppearOffline: appearOffline =>
      act(async () => {
        const mark = sessionMark()
        await api.setAppearOffline(appearOffline)
        if (mark !== sessionMark()) return
        set(s => (s.me ? { me: { ...s.me, appear_offline: appearOffline } } : {}))
      }),

    expireSession,
    deleteAccount: async (reauth, removeP2p) => {
      if (deleting) return
      const at = sessionMark()
      deleting = true
      const letGo = client.accounts.keep(acct)
      try {
        await runDeletion(
          {
            prepare: () => readyIdentities(acct),
            request: body => api.deleteAccount(body),
            signOut: () => {
              deleting = false
              if (at === sessionMark()) expireSession()
            },
          },
          reauth,
          removeP2p
        )
      } finally {
        deleting = false
        letGo()
      }
    },
    keepAccount: () =>
      act(async () => {
        const at = sessionMark()
        await api.keepAccount()
        const me = get().me
        if (at !== sessionMark() || !me) return
        const { delete_at: _, ...kept } = me
        set({ me: kept })
        toast('Your account is kept')
      }),
    checkSession: refetchMe,
    refreshAccount: async () => {
      if (!get().token || !get().me) return
      const before = get().me
      const mark = sessionMark()
      const fresh = await api.me().catch(() => null)
      if (mark === sessionMark() && fresh)
        set(s =>
          s.me?.username === fresh.username &&
          s.me.has_password === before?.has_password &&
          s.me.password_kind === before?.password_kind
            ? {
                me: {
                  ...s.me,
                  has_password: fresh.has_password,
                  password_kind: fresh.password_kind,
                },
              }
            : {}
        )
    },

    changePassword: async (current, next, kind, reauth) => {
      const at = sessionMark()
      try {
        await api.changePassword(current, next, reauth)
        if (at !== sessionMark()) return null
        const temporary = get().me?.password_temporary ?? null
        set(s =>
          s.me
            ? {
                me: {
                  ...s.me,
                  ...(current === undefined ? { has_password: true } : {}),
                  password_kind: kind,
                  password_temporary: null,
                },
              }
            : {}
        )
        // What the session could not load while it was held to the change loads now.
        if (temporary !== null && typeof window !== 'undefined') window.location.reload()
        return null
      } catch (e) {
        if (at !== sessionMark()) return errorText(e)
        if (e instanceof ApiError && e.status === 401 && e.message === 'Unauthorized')
          expireSession()
        return errorText(e)
      }
    },

    bootstrap: async (restorePage = true) => {
      if (get().me || get().guest) {
        if (restorePage) await bootUrl()
        return
      }
      const mark = sessionMark()
      await get().loadInstance()
      if (mark !== sessionMark()) return
      void get().loadSettings()
      restoring = storedCredential(home, client.book.getState(), acct.credentialTarget)
      const token = restoring?.token
      const guest = typeof acct.credentialTarget !== 'string' && readLocal(LS.guest) === '1'
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
          if (mark !== sessionMark()) return
        } catch (e) {
          if (mark !== sessionMark() || !restoring || !token.same(readToken(restoring.key))) return
          if (endsSession(e)) {
            fail(e)
            expireSession()
            return
          }
          if (token.same(readToken(accountStorage(home).key('rchat_token'))))
            setMediaCookie(home, token)
          set({ token, guest: false })
          startWs()
          meAttempt = 0
          retryMe(e)
          return
        }
        if (!(await authenticated(me, token, true)) || mark !== sessionMark()) return
        if (token.same(readToken(accountStorage(home).key('rchat_token'))))
          setMediaCookie(home, token)
        applyMe(me, false)
        set({ token, guest: false, bootError: null })
        startWs()
        if (restorePage) await bootUrl()
      } else if (guest) {
        recordGuest(true)
        persistGrants(readJson<Record<string, string>>(LS.guestGrants, {}))
        set({
          guest: true,
          guestServers,
          guestNames: readJson<Record<string, string>>(LS.guestNames, {}),
        })
        loadGuestLayout()
        armIce(null, false)
        startWs()
        if (restorePage) await bootUrl()
      }
    },

    syncFromUrl: nav => resolveUrl(nav),

    openAdmin: (section = null, item = null, row = null) => {
      if (!get().me?.is_site_admin) return
      beginNavigation()
      const open = get().adminPage !== null
      const entry = ownsPage() ? adminEntry() : { depth: 0, from: null }
      const path = adminPath(section, item, routeOwnerFor(acct))
      const url = row === null ? path : `${path}#${encodeURIComponent(row)}`
      leaveInvite()
      if (ownsPage()) {
        if (open && window.location.pathname === path)
          window.history.replaceState(accountHistoryState(acct, window.history.state), '', url)
        else if (open)
          window.history.pushState(
            accountHistoryState(acct, {
              rchatAdmin: entry.from === null ? null : { depth: entry.depth + 1, from: entry.from },
            }),
            '',
            url
          )
        else
          window.history.pushState(
            accountHistoryState(acct, { rchatAdmin: { depth: 1, from: window.location.pathname } }),
            '',
            url
          )
        client.commitNotice(acct)
      }
      set(
        open
          ? { adminPage: { section, item, row } }
          : { adminPage: { section, item, row }, activeDialog: null }
      )
    },

    closeAdmin: () => {
      if (!get().adminPage) return
      const { depth, from } = ownsPage() ? adminEntry() : { depth: 0, from: null }
      const view = get().view
      if (from !== null && localPage(from) === viewPath(view)) return window.history.go(-depth)
      set({ adminPage: null })
      if (ownsPage())
        window.history.replaceState(
          accountHistoryState(acct, null),
          '',
          viewPath(view, routeOwnerFor(acct))
        )
      if (!view) set({ home: true })
    },

    register: async body => {
      try {
        await authenticate('/auth/register', body)
        return null
      } catch (e) {
        return signupFailure(e)
      }
    },
    enterSsoSession: async (res, current) => {
      const mark = sessionMark()
      const previousToken = get().token
      const pending = () =>
        current() && mark === sessionMark() && sameSecret(get().token, previousToken)
      const revoke = issuedTokenCleanup()
      try {
        const pin = acct.credentialTarget ?? get().me?.username
        if (pin && pin !== res.user.username)
          throw new Error('Sign in with the saved username for this link.')
        // A callback can target a cold account that never ran the login page's bootstrap.
        if (pending()) await get().loadInstance(pending)
        if (pending()) await get().loadSettings(false, pending)
        if (!pending()) throw new Error('That sign-in expired. Try again.')
      } catch (error) {
        revoke(Secret.of(res.token))
        throw error
      }
      await enter(res, pending, res.end_session)
      if (!get().token?.same(Secret.of(res.token)))
        throw new Error(get().error || 'That sign-in expired. Try again.')
    },
    ssoExchange: async (body, current) => {
      const mark = sessionMark()
      const signedOut = body.confirm_as ? confirmationLoginGuard(acct, body.confirm_as) : undefined
      const valid = () =>
        current() &&
        mark === sessionMark() &&
        allowsAccountOrigin(home.origin) &&
        (!signedOut || signedOut())
      if (!valid()) throw new Error('That sign-in expired. Try again.')
      const revoke = issuedTokenCleanup()
      if (
        body.confirm_as &&
        (!(await get().loadInstance(valid, 'no-store')) ||
          !valid() ||
          get().instance?.auth?.confirm_login !== true)
      )
        throw new Error('Confirmation sign-in is unavailable. Sign in again.')
      const response = await api.ssoExchange(body)
      if (!valid()) {
        if (response.kind === 'session') revoke(Secret.of(response.token))
        throw new Error('That sign-in expired. Try again.')
      }
      if (response.kind === 'session') {
        const pin = acct.credentialTarget ?? get().me?.username
        if (pin && pin !== response.user.username) {
          revoke(Secret.of(response.token))
          throw new Error('Sign in with the saved username for this link.')
        }
        const target =
          client
            .live()
            .find(
              a =>
                a !== acct &&
                a.conn.origin === home.origin &&
                (a.store.getState().me?.username ?? a.credentialTarget) === response.user.username
            ) ?? acct
        await target.store.getState().enterSsoSession(response, valid)
      }
      return response
    },
    login: body => act(() => authenticate('/auth/login', body)),

    logout: async () => {
      if (!get().authExpired) clearConfirmationHint(acct)
      const token = get().authExpired ? null : get().token
      const username = get().me?.username ?? restoring?.username
      const localToken = get().token ?? restoring?.token ?? null
      const guest = get().guest
      if (
        username &&
        (!readToken(accountStorage(home).token(username)) ||
          sameSecret(readToken(accountStorage(home).token(username)), localToken))
      ) {
        writeLocal(home.scoped(secretsKey(username)), null)
        writeLocal(home.scoped(forwardKey(username)), null)
        writeLocal(home.scoped(historyKey(username)), null)
      }
      if (get().guest) {
        writeLocal(home.scoped(historyKey(null)), null)
        writeLocal(LS.guestServers, null)
        writeLocal(LS.guestNames, null)
      }
      const keys = accountStorage(home)
      const credentialKey = username && keys.token(username)
      const redirect =
        ownsPage() &&
        token &&
        credentialKey &&
        token.same(readToken(credentialKey)) &&
        parseLogoutFlag(readLocal(keys.key(SSO_LOGOUT_KEY + ':' + username)))
      const shown = client.shownVersion()
      const deadline = acct.time.now() + 3000
      const revoke = issuedTokenCleanup()
      const flushed = readQueue.flush()
      forgetSession()
      const origin = home.origin
      const timeout = token ? sleep(acct.time, 3000) : undefined
      const completed =
        token &&
        Promise.race([flushed, timeout])
          .then(() => revoke(token))
          .catch(() => undefined)
      home.ws.stop()
      forgetTyping(false)
      useProfanity(false)
      rtc.leave()
      p2p.signOut()
      if (forgetCredential(home, username, localToken)) setMediaCookie(home, null)
      if (!guest && readLocal(LS.guest) !== '1') writeLocal(LS.guestGrants, null)
      if (guest) {
        writeLocal(LS.guest, null)
        writeLocal(LS.guestGrants, null)
        recordGuest(false)
      }
      api.setToken(null)
      api.setGrants({})
      home.ws.setGrants({})
      armIce(null, false)
      clearProfiles(sessionMark())
      dropStashedInvite(acct.handoff)
      set({
        token: null,
        me: null,
        providerConfirmation: undefined,
        guest: false,
        guestGrants: {},
        guestPosting: {},
        guestNames: {},
        guestVoiceName: null,
        voice: null,
        call: null,
        selfAudio: SELF_AUDIO_IDLE,
        voiceUsers: {},
        voiceServers: {},
        voiceMuted: {},
        voiceHushed: {},
        voiceAudio: {},
        timeouts: {},
        profileLocks: {},
        channelLabelEpoch: 0,
        channelLabelEpochs: {},
        servers: {},
        members: {},
        hoisted: {},
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
        dmsEdge: NO_DM_EDGE,
        serversMore: false,
        layout: emptyLayout,
        emoji: EMPTY_PREFS,
        callRoute: DEFAULT_ROUTE,
        p2pCallFailed: {},
        notifyPrefs: EMPTY_NOTIFY,
        typingOn: true,
        typing: {},
        anim: ANIM_DEFAULT,
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
        unreadsCut: false,
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
        forwardShowSource: null,
        linkCards: {},
        toast: null,
        pins: null,
        threads: null,
        composerFocus: null,
        editing: null,
        bootError: null,
        search: emptySearch(),
        adminOverview: null,
        adminPage: null,
      })
      if (redirect && completed) {
        // Retiring this just-removed credential also ends its account-manager lifetime.
        client.accounts.reconcile()
        const mark = sessionMark()
        const result = await Promise.race([completed, timeout])
        if (
          !result?.end_session_url ||
          acct.time.now() > deadline ||
          !ownsPage() ||
          client.shownVersion() !== shown ||
          sessionMark() !== mark ||
          home.origin !== origin ||
          get().token ||
          get().guest ||
          readLocal(credentialKey)
        )
          return
        try {
          const url = new URL(result.end_session_url)
          if (url.protocol === 'https:' || url.protocol === 'http:')
            await authBrowser().navigate(url.href)
        } catch {
          // Local sign-out is complete even if the provider page cannot open.
        }
      }
    },

    enterGuest: () =>
      act(async () => {
        recordGuest(true)
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
        const { grant } = await live(api.guestAccess(id, password))
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
        const intent = beginNavigation()
        const [detail] = await live(Promise.all([fetchServer(name), ensureMembership(name)]))
        if (intent !== navigation) return
        putServer(name, detail)
        void pruneScopes()
        const target = detail.channels.find(c => c.id === channelId) ?? detail.channels[0]
        if (!target) throw new Error(`No channels you can view in ${detail.display_name}`)
        await get().openChannel(
          name,
          target.id,
          nav,
          target.id === channelId ? at : undefined,
          intent
        )
      }),

    openChannel: (server, channelId, nav = 'push', at, intent = beginNavigation(), current) =>
      act(async () => {
        const target = instanceTarget(get(), server, channelId)
        if (
          (labelsOffline() || !target || !canView(target)) &&
          !(await admitChannel(server, channelId, intent))
        ) {
          if (intent === navigation && nav !== 'push') {
            syncUrl(get().view, 'replace')
            if (!get().view) set({ home: true })
          }
          return
        }
        if (intent !== navigation || (current && !current())) return
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
        if (intent !== navigation || get().view !== view) {
          if (get().stale[key] && !loadingHead(key))
            set(s => ({ stale: keyed(s.stale, key, null) }))
          return
        }
        firstPage(key, msgs)
        askP2p(msgs)
      }),

    openDm: (dmId, nav = 'push', at) =>
      act(async () => {
        beginNavigation()
        const view: View = { kind: 'dm', dmId }
        const key = viewKey(view)
        readQueue.flush()
        leaveServerView(null)
        enterView(view)
        syncUrl(view, nav)
        get().setViewing(null)
        const username = get().me?.username
        if (username) rememberLastDm(home, username, get().token, dmId)
        if (username && !get().dms.some(d => d.id === dmId))
          void get()
            .ensureDms([dmId])
            .then(inSession(() => reopenDm(dmId)))
            .catch(() => {})
        if (at !== undefined) {
          await loadAround(key, at)
          return
        }
        const msgs = await headLoad(key, () => fetchPage(key, {}))
        firstPage(key, msgs)
        askP2p(msgs)
      }),

    openInvite: (server, password = null, code = null, requested) => {
      beginNavigation()
      const target = code ? { server: '', password: null, code } : { server, password }
      const invite: OpenInvite = { ...target, join: false }
      set({ invite, contextMenu: null, profile: null, activeDialog: null })
      if (!ownsPage()) return
      const path = accountPath(
        requested ? publicInvitePath(new URL(requested, home.origin)) : targetPath(target),
        routeOwnerFor(acct)
      )
      const owner = inviteHistoryOwner()
      if (
        client.noticePending(acct) ||
        window.location.pathname + (window.location.search ?? '') + (window.location.hash ?? '') !==
          path
      )
        window.history.pushState(
          accountHistoryState(acct, entryState({ ...target, pushed: true }, owner)),
          '',
          path
        )
      else {
        const pushed =
          inviteEntry(window.history.state, target.server, code, owner)?.pushed ?? false
        window.history.replaceState(
          accountHistoryState(acct, entryState({ ...target, pushed }, owner)),
          '',
          path
        )
      }
      client.commitNotice(acct)
    },

    closeInvite: () => {
      beginNavigation()
      const { view, invite } = get()
      const pushed =
        ownsPage() &&
        invite !== null &&
        inviteEntry(window.history.state, invite.server, invite.code ?? null, inviteHistoryOwner())
          ?.pushed
      leaveInvite()
      if (pushed) window.history.back()
      else if (view) syncUrl(view, 'push')
      else clearView('push')
    },

    syncInvite: readInvite,

    syncConfigLink: readConfigLink,

    closeConfigLink: () => {
      beginNavigation()
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
      const stored = Number(readLocal(accountStorage(home).lastDm(me.username)))
      const known = () => get().dms.some(d => d.id === stored)
      const at = sessionMark()
      const go = () => {
        const { dms } = get()
        const target = known() ? stored : (dms.find(d => d.is_self) ?? dms[0])?.id
        if (target !== undefined && at === sessionMark()) void get().openDm(target)
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
      if (!get().me || get().guest) return null
      try {
        await friendsHub.mutate(
          username,
          () => api.block(username.trim()),
          (b, claim) => {
            if (claim('block')) noteBlocked(b)
            friendsHub.reconcileBlock(b.user.username, claim)
          }
        )
        return null
      } catch (e) {
        return errorText(e)
      }
    },

    unblockUser: (username, name) =>
      act(async () => {
        if (!get().me) return
        await friendsHub.mutate(
          username,
          () => api.unblock(username),
          (_, claim) => {
            if (claim('block')) noteUnblocked(username)
            if (name) toast('Unblocked', name)
          }
        )
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
            .then(
              inSession(err => {
                if (err) fail(new Error(err))
                else toast('Blocked', user.display_name)
              })
            ),
      })
    },

    openThread: (root, at) =>
      act(async () => {
        const view = get().view
        if (root.channel_id !== null) {
          const id = root.channel_id
          const server =
            view?.kind === 'channel' && view.channelId === id
              ? view.server
              : Object.values(get().servers).find(d => d.channels.some(c => c.id === id))?.name
          if (!server) return
          const target = instanceTarget(get(), server, id)
          if (labelsOffline() || !target || !canView(target)) {
            const intent = beginNavigation()
            if (!(await admitChannel(server, id, intent))) return
            await get().openChannel(server, id)
            const now = get().view
            if (now?.kind !== 'channel' || now.channelId !== id) return
          }
        } else if (root.dm_id !== null) {
          const id = root.dm_id
          if (view?.kind !== 'dm' || view.dmId !== id) {
            await get().openDm(id)
            const now = get().view
            if (now?.kind !== 'dm' || now.dmId !== id) return
          }
        }
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
      recoverCallHistory()
      dropLinkCards()
      resync()
    },
  } satisfies Handlers

  return {
    handlers,
    actions,
    atHome,
    canOpenDm,
    clearView,
    dropGrant,
    expireSession,
    guestLocked,
    lockedOut,
    noteBlocked,
    noteUnblocked,
    navigationMark: () => navigation,
    cancelNavigation: beginNavigation,
    navigationIntent: () => {
      const intent = beginNavigation()
      return () => intent === navigation
    },
    openChannelAt,
    openDmAt,
    persistGrants,
    persistGuestNames,
    persistGuestServers,
    refetchMe,
    rememberGuestName,
    syncUrl,
    forgetSession,
    bindSessionMedia,
    setSocket(allowed: boolean) {
      if (acct.socketAllowed === allowed) return
      acct.socketAllowed = allowed
      if (allowed) {
        if (get().token || get().guest) {
          startWs()
          resync()
        }
      } else {
        stopCatchUp()
        resyncTimer?.()
        resyncTimer = null
        home.ws.stop()
        set({
          wsStatus: 'red',
          voiceUsers: {},
          voiceServers: {},
          voiceMuted: {},
          voiceHushed: {},
          voiceAudio: {},
        })
      }
    },
    resumeView() {
      const panel = get().panel
      if (panel?.kind === 'thread') void get().openThread(panel.root)
      resync()
    },
    tapWs,
    p2pGate,
    dispose: () => {
      pageListeners?.abort()
      wsTaps.clear()
      home.ws.onEvent =
        home.ws.onStatus =
        home.ws.onPoll =
        home.ws.onPasswordChangeRequired =
          () => {}
    },
  }
}
