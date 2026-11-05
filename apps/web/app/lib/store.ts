import { create } from 'zustand'
import { ApiError, type LoginRequest, type RegisterRequest } from './api'
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
} from './instances'
import { JoinAborted, rtc } from './rtc'
import { JoinTracker } from './negotiation'
import { p2p } from './p2p'
import { ice, iceKey, iceValue, parseIce } from './ice'
import { callRtc, p2pAccount, p2pCall, p2pRail, p2pVoice } from './p2p/app'
import { DENIED_CALL, hidesIp, mergeRelays, relayBook, relaysKey, type Decision } from './relays'
import { NO_PINGS } from './pings'
import { NO_GROUP_PINGS } from './group_pings'
import {
  EMPTY_NOTIFY,
  extendMute,
  keepScopes,
  nextExpiry,
  notifyKey,
  notifyValue,
  parseNotify,
  pruneNotify,
  resetAll as resetAllNotify,
  resetScope,
  setDesktop,
  setLevel,
  setMute,
  setSuppress,
  type NotifyPrefs,
} from './notify'
import { notifications } from './platform'
import {
  maskOutsideCode,
  maskProfanity,
  parseProfanity,
  profanityKey,
  profanityValue,
  setMasking,
  showText,
} from './profanity'
import { parseSpoilers, spoilersKey, spoilersValue, type ShowSpoilers } from './spoilers'
import { hideTypers, parseTyping, typingKey, typingValue } from './typing'
import { forgetGuestMedia } from './media_src'
import {
  addNotice,
  desktopText,
  liveNotices,
  nextNoticeEnd,
  pauseNotices,
  type AlertInput,
  type Notice,
} from './notices'
import { EMPTY_PREFS, emojiKey, noteUse, parseEmojiPrefs, setTone, type EmojiPrefs } from './emoji'
import {
  DEFAULT_ROUTE,
  callRouteKey,
  callRouteValue,
  parseCallRoute,
  type CallRoute,
} from './call_choice'
import { forwardKey, forwardValue, parseForward, type ForwardClip } from './forward'
import { catchUpDelay, due } from './backoff'
import { endsSession, meRetryIn } from './session'
import { trimWindow } from './window'
import { keyed, mergeHead, refreshTail, samePrefix, type Key, type Page } from './lists'
import {
  addToFolder as addIn,
  autoPinSelf,
  bootDms,
  emptyLayout,
  knownDms,
  layoutKey,
  layoutServers,
  mergeServers as mergeIn,
  moveFolder as moveFolderIn,
  moveIntoFolder as moveIntoIn,
  moveServer as moveServerIn,
  newFolderId,
  noteSelfPin,
  parseLayout,
  pinDm as pinIn,
  placeDm as placeIn,
  pruneLayout,
  renameFolder as renameFolderIn,
  toggleFolder as toggleIn,
  ungroupFolder as ungroupIn,
  unpinDm as unpinIn,
  type Layout,
} from './nav_layout'
import { cleanBio } from './rules'
import {
  dropStashedInvite,
  entryState,
  inviteEntry,
  invitePath,
  parseInvite,
  takeStashedInvite,
  type InviteEntry,
  type OpenInvite,
} from './invite'
import {
  parseConfigPath,
  sectionOf,
  stashConfig,
  takeStashedConfig,
  type ConfigDoc,
  type SectionKey,
} from './config_transfer'
import { clearProfiles } from './profile'
import { SELF_AUDIO_IDLE, toggleDeafenAudio, toggleMicAudio, type SelfAudio } from './voice_layout'
import { retrySeconds, tooManyText } from './rate_limit'
import {
  fromWire,
  timedOutLine,
  TIMED_OUT_CAMERA,
  TIMED_OUT_SHARE,
  type TimeoutWire,
} from './timeouts'
import { deniedAccess } from './join_flow'
import { secretsKey } from './passwords'
import { historyKey } from './openapi'
import { siteSettings } from './attachments'
import {
  changeableRoles,
  dmView,
  memberOf,
  memberTimeout,
  myTimeoutEnds,
  serverNames,
  voiceMutedIn,
} from './selectors'
import type { ContextMenuItem, Paged, RChatState, SearchState } from './store_types'
import { parsePath, threadKey, viewKey, viewPath, type Nav, type View } from './view'
import {
  Banned,
  PAGE,
  emptyPage,
  errorText,
  routeEvent,
  serverKey,
  type Handlers,
} from './slices/ctx'
import { presenceSlice } from './slices/presence'
import { readsSlice } from './slices/reads'
import { applyEmbeds, dmKey, isSelfDm, messagesSlice } from './slices/messages'
import { serversSlice } from './slices/servers'

import { blockedSet, matchesBlockQuery, withoutTypers, type Blocked } from './blocks'
import { friendsInitial, friendsSlice } from './friends_store'
import { pollsSlice } from './polls_store'
import { selectionInitial, selectionSlice } from './selection_store'
import type {
  AuthResponse,
  BlockedUser,
  CallKind,
  Me,
  ServerDetail,
  ServerSummaryLite,
  Theme,
  UserRef,
  VoiceMsg,
  WsEvent,
} from './types'

export * from './attachments'
export * from './selectors'
export * from './store_types'
export * from './view'
export { errorText }

const emptySearch = (): SearchState => ({ results: [], hasMore: false, loading: false })

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

// Reads a per-account value; storage that throws (no window, privacy mode) gives the fallback.
const readScoped = <T>(key: string, parse: (raw: string | null) => T, fallback: T): T => {
  try {
    return parse(localStorage.getItem(home.scoped(key)))
  } catch {
    return fallback
  }
}

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

export const roleMenuItems = (server: string, username: string): ContextMenuItem[] => {
  const s = useStore.getState()
  const roleIds = memberOf(s, server, username)?.role_ids ?? []
  return changeableRoles(s, server, username).map(r => {
    const assigned = roleIds.includes(r.id)
    return {
      label: `${assigned ? 'Remove' : 'Assign'} ${r.name}`,
      danger: assigned,
      action: () =>
        void (assigned
          ? s.unassignRole(server, r.id, username)
          : s.assignRole(server, r.id, username)),
    }
  })
}

export const banMenuItem = (server: string, username: string): ContextMenuItem => ({
  label: 'Ban from server',
  danger: true,
  action: () => {
    const s = useStore.getState()
    s.askConfirm({
      title: 'Ban from Server',
      body: "Ban this user? They are removed from the server and can't join again until unbanned.",
      confirm: 'Ban',
      action: () => void s.banMember(server, username),
    })
  },
})

// Records the running timeouts (or none) of members of `server`, as a moderator sees them.
export const noteMemberTimeouts = (
  server: string,
  members: { username: string; timeout?: TimeoutWire }[]
) =>
  useStore.setState(s => {
    const was = s.timeouts[server] ?? {}
    const changed = members.filter(m => m.timeout || was[m.username])
    if (!changed.length) return {}
    const list = { ...was }
    for (const m of changed) {
      if (m.timeout) list[m.username] = fromWire(m.timeout)
      else delete list[m.username]
    }
    return { timeouts: { ...s.timeouts, [server]: list } }
  })

export const noteTimeout = (server: string, username: string, timeout: TimeoutWire | undefined) =>
  noteMemberTimeouts(server, [{ username, timeout }])

// Time out a member, or change or remove their timeout (context menus).
export const timeoutMenuItems = (server: string, user: UserRef): ContextMenuItem[] => {
  const s = useStore.getState()
  const running = memberTimeout(s, server, user.username) !== null
  const open = () => s.openDialog({ kind: 'timeout', server, user: userRefOf(user) })
  return running
    ? [
        { label: 'Change Timeout', action: open },
        {
          label: 'Remove Timeout',
          danger: true,
          action: () => void s.removeTimeout(server, user.username),
        },
      ]
    : [{ label: 'Time Out', danger: true, action: open }]
}

const userRefOf = (u: UserRef): UserRef => ({
  username: u.username,
  display_name: u.display_name,
  avatar_kind: u.avatar_kind,
  avatar_color: u.avatar_color,
})

export const confirmKick = (server: string, username: string, after?: () => void) =>
  useStore.getState().askConfirm({
    title: 'Kick Member',
    body: 'Kick this member? They are removed from the server but can join again.',
    confirm: 'Kick',
    action: () => void useStore.getState().kickMember(server, username).then(after),
  })

export const confirmTransfer = (server: string, username: string) =>
  useStore.getState().askConfirm({
    title: 'Transfer Admin',
    body: 'Make this member the server admin? You lose your own admin rights and cannot take them back yourself.',
    confirm: 'Transfer',
    action: () => void useStore.getState().transferAdmin(server, username),
  })

export const revokeAdminFor = (server: string, username: string, after?: () => void) => {
  const s = useStore.getState()
  const revoke = () => void useStore.getState().revokeAdmin(server, username).then(after)
  if (s.me?.username !== username) {
    revoke()
    return
  }
  s.askConfirm({
    title: 'Revoke Admin',
    body: 'Remove your own admin rights? Another admin has to give them back.',
    confirm: 'Revoke',
    action: revoke,
  })
}

export const confirmDeleteMessage = (id: number, now = false) => {
  const s = useStore.getState()
  if (now) {
    void s.deleteMessage(id)
    return
  }
  s.askConfirm({
    title: 'Delete Message',
    body: 'Delete this message for everyone? Hold Shift while clicking the trash icon to skip this.',
    confirm: 'Delete',
    action: () => void useStore.getState().deleteMessage(id),
  })
}

export const IGNORED = [
  'bulk_delete_progress',
  'friend_added',
  'friend_presence',
  'friend_removed',
  'friend_request_added',
  'friend_request_removed',
  'poll_updated',
  'poll_voted',
  'privacy_changed',
] as const satisfies readonly WsEvent['type'][]
type Ignored = (typeof IGNORED)[number]

let routed: readonly Handlers[] = []

// The handler tables `applyWsEvent` routes through, after the friends, polls and selection hooks.
export const eventTables = () => routed

let forgetStoreSession = () => {}

// Test files share one store; each one calls this when it ends so no queued read or cached
// window reaches the next file.
export const resetSessionCaches = () => forgetStoreSession()

export const useStore = create<RChatState>()((set, get) => {
  const epochs: Record<string, number> = {}

  // When the last 429 was seen; a boot that hit one and opened nothing is retried.
  let limitedAt = 0

  const fail = (e: unknown) => {
    if (e instanceof Banned) return
    if (e instanceof ApiError && e.status === 429) limitedAt = Date.now()
    const message = errorText(e)
    set({ error: message })
    setTimeout(() => {
      if (get().error === message) set({ error: null })
    }, 5000)
  }

  const act = async (fn: () => Promise<void>) => {
    try {
      await fn()
    } catch (e) {
      fail(e)
    }
  }

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
    void p2pAccount(signedIn ? username : null)
  }

  const expireSession = () => {
    if (get().authExpired) return
    set({ authExpired: true })
    get().logout()
  }

  const readLayout = (username: string | null) =>
    readScoped(layoutKey(username), parseLayout, emptyLayout)

  const readEmoji = (username: string) =>
    readScoped(emojiKey(username), parseEmojiPrefs, EMPTY_PREFS)

  const readCallRoute = (username: string) =>
    readScoped(callRouteKey(username), parseCallRoute, DEFAULT_ROUTE)

  const saveCallRoute = (route: CallRoute) => {
    const username = get().me?.username
    if (!username || route === get().callRoute) return
    set({ callRoute: route })
    writeLocal(home.scoped(callRouteKey(username)), callRouteValue(route))
  }

  const readForward = (username: string) => readScoped(forwardKey(username), parseForward, null)

  const notifyOwner = () => {
    const { me, guest } = get()
    return me ? me.username : guest ? null : undefined
  }

  const readNotify = (username: string | null) =>
    readScoped(notifyKey(username), parseNotify, EMPTY_NOTIFY)

  const readTyping = (owner: string | null) => readScoped(typingKey(owner), parseTyping, true)

  const readSpoilers = (owner: string | null) =>
    readScoped(spoilersKey(owner), parseSpoilers, 'click' as ShowSpoilers)

  const saveShowSpoilers = (show: ShowSpoilers) => {
    const owner = notifyOwner()
    if (owner === undefined) return
    if (show !== get().showSpoilers) set({ showSpoilers: show })
    writeLocal(home.scoped(spoilersKey(owner)), spoilersValue(show))
  }

  const readProfanity = (owner: string | null) =>
    readScoped(profanityKey(owner), parseProfanity, false)

  const useProfanity = (on: boolean) => {
    const s = get()
    if (on !== s.profanityOn || (!on && (s.profanityReady || s.profanityFailed)))
      set({ profanityOn: on, profanityReady: false, profanityFailed: false })
    void setMasking(on).then(ok => {
      if (!on || !get().profanityOn) return
      set({ profanityReady: ok, profanityFailed: !ok })
    })
  }

  const saveProfanityOn = (on: boolean) => {
    const owner = notifyOwner()
    if (owner === undefined) return
    useProfanity(on)
    writeLocal(home.scoped(profanityKey(owner)), profanityValue(on))
  }

  const presenceHub = presenceSlice(set, get)
  const { forgetTyping, noteTyper } = presenceHub

  const saveTypingOn = (on: boolean) => {
    const owner = notifyOwner()
    if (owner === undefined) return
    if (on !== get().typingOn) set({ typingOn: on })
    writeLocal(home.scoped(typingKey(owner)), typingValue(on))
    if (!on) forgetTyping(true)
  }

  let expiryTimer: ReturnType<typeof setTimeout> | null = null

  // One timer, set for the next mute to end; it prunes and sets itself for the one after.
  const armExpiry = () => {
    if (expiryTimer !== null) clearTimeout(expiryTimer)
    expiryTimer = null
    const now = Date.now()
    const next = nextExpiry(get().notifyPrefs, now)
    if (next === null) return
    expiryTimer = setTimeout(
      () => {
        expiryTimer = null
        get().pruneNotify()
      },
      Math.min(next - now + 50, 2 ** 31 - 1)
    )
  }

  const useNotify = (prefs: NotifyPrefs) => {
    set({ notifyPrefs: prefs })
    armExpiry()
  }

  const saveNotify = (next: NotifyPrefs) => {
    const pruned = pruneNotify(next, Date.now())
    if (pruned === get().notifyPrefs) return
    useNotify(pruned)
    const owner = notifyOwner()
    if (owner !== undefined) writeLocal(home.scoped(notifyKey(owner)), notifyValue(pruned))
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

  const forgetServerRules = (name: string) => {
    const channels = new Set((get().servers[name]?.channels ?? []).map(c => c.id))
    for (const [scope, mark] of Object.entries(get().reads))
      if (mark.server === name && scope[0] === 'c') channels.add(Number(scope.slice(1)))
    saveNotify(
      keepScopes(get().notifyPrefs, {
        server: n => n !== name,
        channel: id => !channels.has(id),
        dm: () => true,
      })
    )
  }

  const saveForward = (clip: ForwardClip | null) => {
    const username = get().me?.username
    if (!username) return
    set({ forwardClip: clip })
    writeLocal(home.scoped(forwardKey(username)), forwardValue(clip))
  }

  let toastSeq = 0
  const toast = (text: string, name?: string) => {
    toastSeq += 1
    const id = toastSeq
    set({ toast: { id, text, name } })
    setTimeout(() => {
      if (get().toast?.id === id) set({ toast: null })
    }, 4000)
  }

  const saveEmoji = (next: EmojiPrefs) => {
    const username = get().me?.username
    if (!username || next === get().emoji) return
    set({ emoji: next })
    writeLocal(home.scoped(emojiKey(username)), JSON.stringify(next))
  }

  const saveLayout = (next: Layout) => {
    if (next === get().layout) return
    set({ layout: next })
    const { me, guest } = get()
    if (me || guest) writeLocal(home.scoped(layoutKey(me?.username ?? null)), JSON.stringify(next))
  }

  const selfDmId = () => get().dms.find(isSelfDm)?.id

  const pinSelf = () => {
    if (get().me) saveLayout(autoPinSelf(get().layout, selfDmId()))
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

  // The P2P call whose relays the caller is asking about, so a repeated state asks once.
  let dialing: string | null = null

  // An active P2P call names its id and the peer id of both tabs. The tab that started or
  // accepted it binds to the other side: the caller dials, the callee answers only that peer.
  const bindP2pCall = (me: string, ev: Extract<WsEvent, { type: 'call_state' }>) => {
    const mine = ev.peers?.find(p => p.user === me)
    if (!p2p.mediaActive() || !mine || mine.peer_id !== p2p.peerId()) return
    const other = ev.peers?.find(p => p.user !== me)
    if (!other || !ev.call_id) {
      set(s => ({ p2pCallFailed: { ...s.p2pCallFailed, [ev.dm_id]: Date.now() } }))
      fail(new Error('This P2P call cannot connect: the other side uses an older app'))
      return
    }
    if (get().p2pCallFailed[ev.dm_id] !== undefined)
      set(s => {
        const { [ev.dm_id]: _gone, ...rest } = s.p2pCallFailed
        return { p2pCallFailed: rest }
      })
    const dial = ev.from === me
    const binding = { callId: ev.call_id, peer: other.peer_id, dial }
    if (!dial) {
      p2p.bind(binding)
      return
    }
    // The caller asks about the callee's relays before it connects; the callee asked about the
    // caller's when it accepted.
    if (dialing === binding.callId) return
    dialing = binding.callId
    const theirs = (ev.relays ?? []).filter(r => r.user !== me).flatMap(r => r.hosts)
    const plan = p2p.callPlan()
    const asked = plan && hidesIp(plan) ? Promise.resolve(null) : relayBook.consent(theirs)
    void asked.then(denied => {
      dialing = null
      const call = get().call
      if (call?.dmId !== ev.dm_id || call.state !== 'active' || !p2p.mediaActive()) return
      if (denied !== null) {
        get().hangupCall()
        fail(new Error(DENIED_CALL))
        return
      }
      if (p2p.bind(binding)) p2p.dial()
    })
  }
  const joins = new JoinTracker()

  // Muted by a timeout in the voice channel you are in: by the server, or by your own clock.
  const forcedMute = () => {
    const s = get()
    if (!s.voice || !s.me) return false
    return (
      voiceMutedIn(s, s.voice.channelId).includes(s.me.username) ||
      myTimeoutEnds(s, s.voice.server) !== null
    )
  }

  // Also stops your camera and screen share while a timeout mutes you in voice.
  const applyMic = () => {
    const forced = forcedMute()
    const muted = get().selfAudio.muted || forced
    if (rtc.active() && rtc.muted !== muted) rtc.setMuted(muted)
    if (p2p.mediaActive() && p2p.muted !== muted) p2p.setMuted(muted)
    if (callRtc.active() && callRtc.muted !== muted) callRtc.setMuted(muted)
    if (forced && rtc.active()) {
      if (rtc.videoTrack) void rtc.camera(false)
      if (rtc.sharing) void rtc.share(false)
    }
  }

  const setSelfAudio = (selfAudio: SelfAudio) => {
    set({ selfAudio })
    applyMic()
  }

  const endRtc = () => {
    rtc.leave()
    joins.reset()
    p2p.endMedia()
    set(s => ({
      selfAudio: SELF_AUDIO_IDLE,
      ...(s.voice || s.call ? { voice: null, call: null } : {}),
    }))
  }

  const endVoiceMedia = () => {
    rtc.leave()
    set({ voice: null, selfAudio: SELF_AUDIO_IDLE })
  }

  const endCallMedia = (kind: CallKind) => {
    if (get().voice) return
    if (kind === 'p2p') p2p.endMedia()
    else rtc.leave()
    set({ selfAudio: SELF_AUDIO_IDLE })
  }

  const abandonMedia = () => {
    const { voice, call, me } = get()
    const ours = call !== null && (call.state === 'active' || call.from === me?.username)
    if (voice && home.ws.sendVoice({ type: 'voice_leave' })) joins.left()
    if (ours) home.ws.sendVoice({ type: 'call_leave', dm_id: call.dmId })
    rtc.leave()
    p2p.endMedia()
    set({ voice: null, selfAudio: SELF_AUDIO_IDLE, ...(ours ? { call: null } : {}) })
  }

  // Sends a voice or call message once the media is up; when the socket is down it drops it again.
  const sendOrAbandon = (msg: VoiceMsg) => {
    if (home.ws.sendVoice(msg)) return
    abandonMedia()
    throw new Error('Not connected')
  }

  const caller = () => {
    const { me, guest, call } = get()
    if (guest || !me) throw new Error('Create an account to start calls')
    if (call) throw new Error('Already in a call')
    return me
  }

  const endCall = (type: 'call_decline' | 'call_leave') => {
    const { call } = get()
    if (call) {
      home.ws.sendVoice({ type, dm_id: call.dmId })
      endCallMedia(call.kind)
    }
    set({ call: null })
  }

  // Reloads the unread counts, drops servers we were removed from, and reloads the open member list.
  const catchUpLists = () => {
    if (get().me) void loadUnreads()
    void pruneServers()
      .catch(() => {})
      .then(() => {
        const { view, members } = get()
        if (view?.kind === 'channel' && members[view.server])
          void get().loadMembers(view.server, true)
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
    if (!stuck || limitedAt < started || attempt >= BOOT_RETRY_MS.length) return
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

  const pageKeys = new WeakMap<unknown[], Set<Key>>()

  const loadPage = async <T>(
    id: string,
    read: () => Paged<T>,
    write: (page: Paged<T>) => void,
    fetchPage: (cursor: string | null) => Promise<Page<T>>,
    keyOf: (item: T) => string,
    q: string,
    reset: boolean
  ) => {
    const cur = read()
    const fresh = reset || q !== cur.q
    if (!fresh && (cur.loading || !cur.hasMore)) return
    if (fresh) epochs[id] = (epochs[id] ?? 0) + 1
    const epoch = epochs[id] ?? 0
    const base: Paged<T> = fresh
      ? { list: [], hasMore: true, loading: true, q, cursor: null }
      : { ...cur, loading: true }
    write(base)
    let page: Page<T>
    try {
      page = await fetchPage(base.cursor ?? null)
    } catch (e) {
      if ((epochs[id] ?? 0) === epoch) write({ ...base, loading: false })
      throw e
    }
    if ((epochs[id] ?? 0) !== epoch) return
    const seen = pageKeys.get(base.list) ?? new Set<Key>(base.list.map(keyOf))
    const added = page.items.filter(item => {
      const key = keyOf(item)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    const list = added.length ? [...base.list, ...added] : base.list
    pageKeys.set(list, seen)
    write({ ...base, list, hasMore: page.next !== null, cursor: page.next, loading: false })
  }

  const friendsHub = friendsSlice({ set, get, act, loadPage, toast, fail, errorText })
  const selectionHub = selectionSlice({
    set,
    get,
    toast,
    fail,
    dropDeleted: (ids, threadRootId, server) => {
      for (const id of ids) if (findMessage(id)) dropDeleted(id, threadRootId, server, false)
    },
  })
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

  let noticeId = 0
  let noticeTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleNotices = () => {
    if (noticeTimer !== null) clearTimeout(noticeTimer)
    noticeTimer = null
    const wait = nextNoticeEnd(get().notices, Date.now())
    if (wait === null) return
    noticeTimer = setTimeout(() => {
      noticeTimer = null
      set(s => ({ notices: liveNotices(s.notices, Date.now()) }))
      scheduleNotices()
    }, wait + 20)
  }

  const notify = (alert: AlertInput) => {
    noticeId += 1
    const id = noticeId
    set(s => ({ notices: addNotice(s.notices, alert, id, Date.now(), s.noticesPaused) }))
    scheduleNotices()
    return get().notices.find(n => n.key === alert.key && (alert.lead === undefined || n.id === id))
  }

  const systemNotice = (lead: string, name: string) =>
    void notify({
      key: '!',
      actor: null,
      action: '',
      body: '',
      server: null,
      channel: null,
      dm: false,
      message: false,
      lead,
      name,
      generic: '',
      go: () => {},
    })

  // A system notification for the same events that toast, only while the tab is in the
  // background. It shows what the toast shows (see `desktopText`), so streamer mode leaves out
  // names and message text.
  const desktopAlert = (notice: Notice) => {
    const system = notifications()
    if (!get().notifyPrefs.desktop || system.permission() !== 'granted') return
    if (typeof document === 'undefined') return
    if (document.visibilityState === 'visible' && document.hasFocus()) return
    const { title, body } = desktopText(notice, get().streamer)
    system.show({
      title: maskProfanity(title),
      body: maskOutsideCode(body, maskProfanity),
      tag: notice.key,
      renotify: true,
      onClick: notice.go,
    })
  }

  const alertUser = (alert: AlertInput) => {
    const notice = notify(alert)
    if (notice) desktopAlert(notice)
  }

  const readsHub = readsSlice(set, get, {
    alertUser,
    detached: key => detached(key),
    friendsHub,
  })
  const { clearAnchor, forgetReads, groupAlert, lateAnchor, loadUnreads, placeAnchor, readQueue } =
    readsHub

  const messagesHub = messagesSlice(set, get, {
    act,
    alertUser,
    banCheck: (e, server) => banCheck(e, server),
    clearAnchor,
    clearView,
    confirmDeleteMessage,
    epochs,
    fail,
    groupAlert,
    lateAnchor,
    noteBlocked,
    noteTyper,
    noteUnblocked,
    openChannelAt,
    persistGuestServers,
    pinSelf,
    readsHub,
    sameUser,
    saveForward,
    saveLayout,
    selfDmId,
    toast,
  })
  const {
    askP2p,
    closedDms,
    detached,
    dmPager,
    dropDeleted,
    dropEditIn,
    dropLinkCards,
    fetchPage,
    findMessage,
    firstPage,
    forgetPending,
    forgetViews,
    headLoad,
    historyGen,
    liveKey,
    loadAround,
    loadPins,
    loadingHead,
    mapTails,
    newHistory,
    openMessageAt,
    patchReactions,
    reauthorLinkCards,
    reopenDm,
    tails,
    views,
    mapLists,
  } = messagesHub

  const pollsHub = pollsSlice({
    get,
    act,
    patch: patchReactions,
    find: findMessage,
    errorText,
  })

  const serversHub = serversSlice(set, get, {
    act,
    noteMemberTimeouts,
    noteTimeout,
    applyMic,
    askP2p,
    atHome,
    bumpDmGen: messagesHub.bumpDmGen,
    clearView,
    dmPager,
    dropEditIn,
    dropGrant,
    dropLinkCards,
    endVoiceMedia,
    epochs,
    expireSession,
    fail,
    forgetPending,
    forgetReads,
    forgetServerRules,
    forgetViews,
    guestLocked,
    liveKey,
    loadPage,
    loadUnreads,
    lockedOut,
    mapLists,
    mapTails,
    persistGrants,
    persistGuestNames,
    persistGuestServers,
    presenceHub,
    reauthorLinkCards,
    refetchMe,
    rememberGuestName,
    sameUser,
    saveLayout,
    saveNotify,
    syncUrl,
    systemNotice,
    tails,
    views,
  })
  const {
    banCheck,
    dropServer,
    ensureMembership,
    fetchServer,
    leaveForSafety,
    leaveServerView,
    pruneServers,
    putServer,
    refreshMemberInfo,
    serverPager,
  } = serversHub

  let endedVoice: number | null = null
  // Whether the server has listed us in the room we last joined. Until it has,
  // a voice_state without us predates our join and is not a removal.
  let voiceListed = false
  rtc.onChange = () => set(s => ({ rtcTick: s.rtcTick + 1 }))
  callRtc.onChange = () => {
    set(s => ({ rtcTick: s.rtcTick + 1 }))
    p2pVoice.videoChanged()
  }
  p2p.onChange = () => set(s => ({ rtcTick: s.rtcTick + 1 }))
  p2p.onError = message => fail(new Error(message))

  // Drops the timers, queues and caches of the signed-in session.
  const forgetSession = () => {
    dropLinkCards()
    hideTypers([])
    if (noticeTimer !== null) clearTimeout(noticeTimer)
    noticeTimer = null
    if (meRetry) clearTimeout(meRetry)
    meRetry = null
    meAttempt = 0
    if (expiryTimer !== null) clearTimeout(expiryTimer)
    expiryTimer = null
    notifySynced = false
    readsHub.forget()
    stopCatchUp()
    joins.reset()
    messagesHub.forget()
    serverPager.reset(null)
    presenceHub.forget()
    serversHub.forget()
  }
  forgetStoreSession = forgetSession

  const events = {
    voice_state: ev => {
      set(s => {
        const voiceUsers = { ...s.voiceUsers }
        if (ev.users.length) voiceUsers[ev.channel_id] = ev.users
        else delete voiceUsers[ev.channel_id]
        const muted = s.voiceMuted[ev.channel_id]
        const kept = muted?.filter(u => ev.users.includes(u))
        if (!muted || kept?.length === muted.length) return { voiceUsers }
        const voiceMuted = { ...s.voiceMuted }
        if (kept?.length) voiceMuted[ev.channel_id] = kept
        else delete voiceMuted[ev.channel_id]
        return { voiceUsers, voiceMuted }
      })
      const { me, voice } = get()
      if (!me) return
      const listing = joins.state(ev.channel_id, ev.users.includes(me.username))
      if (voice?.channelId === ev.channel_id) {
        if (listing === 'listed') {
          voiceListed = true
          rtc.sync(ev.users)
        } else if (listing === 'absent' && voiceListed) {
          endedVoice = ev.channel_id
          endVoiceMedia()
        }
      }
    },
    voice_muted: ev => {
      set(s => {
        const was = s.voiceMuted[ev.channel_id] ?? []
        const list = was.filter(u => u !== ev.username)
        if (ev.muted) list.push(ev.username)
        const voiceMuted = { ...s.voiceMuted }
        if (list.length) voiceMuted[ev.channel_id] = list
        else delete voiceMuted[ev.channel_id]
        return { voiceMuted }
      })
      applyMic()
    },
    call_state: ev => {
      const { me } = get()
      if (!me) return
      if (ev.state === 'ended') {
        if (get().call?.dmId === ev.dm_id) {
          endCallMedia(ev.kind)
          set({ call: null })
        }
        return
      }
      if (!get().dms.some(d => d.id === ev.dm_id))
        void get()
          .ensureDms([ev.dm_id])
          .catch(() => {})
      const prev = get().call
      const since =
        ev.state !== 'active'
          ? null
          : typeof ev.answered_at === 'number'
            ? ev.answered_at
            : prev?.dmId === ev.dm_id && prev.since !== null
              ? prev.since
              : Math.floor(Date.now() / 1000)
      set({
        call: {
          dmId: ev.dm_id,
          dmUsers: ev.dm_users,
          state: ev.state,
          from: ev.from,
          kind: ev.kind,
          video: ev.video === true,
          since,
          relays: Array.isArray(ev.relays) ? ev.relays : [],
        },
      })
      if (ev.state !== 'active') return
      if (ev.kind === 'rtc') {
        rtc.sync(ev.dm_users)
        return
      }
      bindP2pCall(me.username, ev)
    },
    rtc_signal: ev => {
      if (get().me?.username === ev.to)
        rtc
          .onSignal(ev.from, ev.payload, { channelId: ev.channel_id, dmId: ev.dm_id })
          .catch((e: unknown) => console.error('rtc signal', e))
    },
    voice_ended: ev => {
      const { me, voice } = get()
      const mine = me !== null && (ev.dm_users?.includes(me.username) ?? false)
      if (mine && ev.channel_id !== null && voice?.channelId === ev.channel_id) endVoiceMedia()
      const endedChannel = ev.channel_id !== null && ev.channel_id === endedVoice
      if (endedChannel) endedVoice = null
      if (endedChannel || mine) fail(new Error(ev.reason))
    },
    error: ev => {
      fail(new Error(ev.message))
      const { me, voice, call, voiceUsers } = get()
      const confirmed =
        call !== null ||
        (voice !== null && me !== null && (voiceUsers[voice.channelId] ?? []).includes(me.username))
      if (confirmed) return
      if (voice) joins.refused()
      if (rtc.active() || voice) endVoiceMedia()
      if (p2p.mediaActive()) p2p.endMedia()
      set({ selfAudio: SELF_AUDIO_IDLE })
    },
    resync: () => {
      dropLinkCards()
      resync()
    },
  } satisfies Handlers

  const tables = [
    presenceHub.handlers,
    readsHub.handlers,
    serversHub.handlers,
    messagesHub.handlers,
    events,
  ]
  type Routed =
    | keyof typeof presenceHub.handlers
    | keyof typeof readsHub.handlers
    | keyof typeof serversHub.handlers
    | keyof typeof messagesHub.handlers
    | keyof typeof events
  const unrouted: Record<Exclude<WsEvent['type'], Routed | Ignored>, never> = {}
  void unrouted
  routed = tables

  return {
    token: null,
    me: null,
    guest: false,
    guestServers: ['rchat'],
    guestGrants: {},
    guestNames: {},
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
    notifyPrefs: EMPTY_NOTIFY,
    typingOn: true,
    typing: {},
    showSpoilers: 'click',
    profanityOn: false,
    profanityReady: false,
    profanityFailed: false,
    voice: null,
    call: null,
    callRoute: DEFAULT_ROUTE,
    p2pCallFailed: {},
    voiceUsers: {},
    voiceMuted: {},
    timeouts: {},
    p2pAvailability: {},
    rtcTick: 0,
    selfAudio: SELF_AUDIO_IDLE,
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
    authExpired: false,
    bootError: null,
    wsStatus: 'red',
    theme: 'dark',
    streamer: false,
    iceHelpers: true,
    iceRelay: false,
    relayPrefs: relayBook.prefs,
    relayPrompt: null,
    contextMenu: null,
    reactPicker: null,
    profile: null,
    activeDialog: null,
    confirm: null,
    confirmSeq: 0,
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
    search: emptySearch(),
    error: null,
    adminOverview: null,
    settings: {
      profanity_filter: true,
      profanity_targets: {
        messages: true,
        links: true,
        usernames: true,
        server_names: true,
        channel_names: true,
        role_names: true,
        file_names: true,
        bios: true,
        channel_topics: true,
        category_names: true,
      },
      asset_previews: true,
      asset_uploads: true,
      p2p_attachments: true,
      guests_enabled: true,
    },

    instance: null,
    instanceHost: '',

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
      const me = get().me
      if (!me) return 'Create an account to add a description'
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
      void get().loadSettings()
      void get().loadInstance()
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

    showToast: (text, name) => toast(text, name),

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

    moveServer: (name, index) => {
      const s = get()
      saveLayout(moveServerIn(s.layout, serverNames(s), name, index))
    },

    moveFolder: (id, index) => {
      const s = get()
      saveLayout(moveFolderIn(s.layout, serverNames(s), id, index))
    },

    moveIntoFolder: (name, id, index) => {
      const s = get()
      saveLayout(moveIntoIn(s.layout, serverNames(s), name, id, index))
    },

    addToFolder: (name, id) => {
      const s = get()
      saveLayout(addIn(s.layout, serverNames(s), name, id))
    },

    mergeServers: (name, target) => {
      const s = get()
      const id = newFolderId(s.layout.servers)
      saveLayout(mergeIn(s.layout, serverNames(s), name, target, id))
    },

    toggleFolder: id => saveLayout(toggleIn(get().layout, id)),
    renameFolder: (id, name) => saveLayout(renameFolderIn(get().layout, id, name)),
    ungroupFolder: id => saveLayout(ungroupIn(get().layout, id)),

    placeDm: (id, zone, index) => {
      const s = get()
      const { pinned, recent } = dmView(s)
      const shown = { pinned: pinned.map(d => d.id), recent: recent.map(d => d.id) }
      const maxId = s.dms.reduce((m, d) => Math.max(m, d.id), 0)
      saveLayout(noteSelfPin(placeIn(s.layout, shown, id, zone, index, maxId), selfDmId(), id))
    },

    pinDm: id => saveLayout(noteSelfPin(pinIn(get().layout, id), selfDmId(), id)),
    unpinDm: id => saveLayout(noteSelfPin(unpinIn(get().layout, id), selfDmId(), id)),

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

    ...friendsHub.actions,
    ...pollsHub.actions,
    ...selectionHub.actions,

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

    reloadLayout: () => {
      const { me, guest } = get()
      if (me || guest) set({ layout: readLayout(me?.username ?? null) })
    },

    noteEmoji: (base, picked) => saveEmoji(noteUse(get().emoji, base, picked, Date.now())),
    setSkinTone: tone => saveEmoji(setTone(get().emoji, tone)),
    reloadEmoji: () => {
      const username = get().me?.username
      if (username) set({ emoji: readEmoji(username) })
    },

    reloadForward: () => {
      const username = get().me?.username
      if (username) set({ forwardClip: readForward(username) })
    },

    setNotifyLevel: (scope, level) => saveNotify(setLevel(get().notifyPrefs, scope, level)),
    setNotifySuppress: (server, which, on) =>
      saveNotify(setSuppress(get().notifyPrefs, server, which, on)),
    muteScope: (scope, until) => saveNotify(setMute(get().notifyPrefs, scope, until)),
    muteServers: (names, until) =>
      saveNotify(
        names.reduce((p, name) => {
          const scope = { kind: 'server', name } as const
          return until === null ? setMute(p, scope, null) : extendMute(p, scope, until, Date.now())
        }, get().notifyPrefs)
      ),
    resetNotify: scope => saveNotify(resetScope(get().notifyPrefs, scope)),
    resetAllNotify: () => saveNotify(resetAllNotify(get().notifyPrefs)),
    setDesktopNotify: on => saveNotify(setDesktop(get().notifyPrefs, on)),
    reloadNotify: () => {
      const owner = notifyOwner()
      if (owner !== undefined) useNotify(readNotify(owner))
    },
    pruneNotify: () => {
      saveNotify(get().notifyPrefs)
      armExpiry()
    },
    setTypingOn: saveTypingOn,
    setProfanityOn: saveProfanityOn,
    setShowSpoilers: saveShowSpoilers,
    reloadTyping: () => {
      const owner = notifyOwner()
      if (owner === undefined) return
      const on = readTyping(owner)
      if (on !== get().typingOn) set({ typingOn: on })
      if (!on) forgetTyping(true)
    },
    noteTyping: presenceHub.noteTyping,

    ...readsHub.actions,
    ...messagesHub.actions,

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

    openSearch: q =>
      set({
        panel: { kind: 'search' },
        search:
          typeof q === 'string' && q.trim()
            ? { ...emptySearch(), seed: q.trim(), seedN: (get().search.seedN ?? 0) + 1 }
            : emptySearch(),
      }),

    closePanel: () => set({ panel: null }),
    setInboxOpen: open => set({ inboxOpen: open }),

    dismissNotice: id => {
      set(s => ({ notices: s.notices.filter(n => n.id !== id) }))
      scheduleNotices()
    },

    pauseNotices: paused => {
      if (get().noticesPaused === paused) return
      set(s => ({ noticesPaused: paused, notices: pauseNotices(s.notices, paused, Date.now()) }))
      scheduleNotices()
    },

    ...serversHub.actions,

    joinVoice: (server, channelId) =>
      act(async () => {
        const { me, guest, voice } = get()
        if (guest || !me) throw new Error('Create an account to join voice')
        const ends = myTimeoutEnds(get(), server)
        if (ends !== null) throw new Error(timedOutLine(ends))
        home.ws.ensureConnected()
        await get().openChannel(server, channelId)
        if (voice?.channelId === channelId) return
        try {
          p2pCall.hangup()
          p2pVoice.leave()
          p2p.endMedia()
          await rtc.join(me.username, { channelId }, get().selfAudio.muted)
          applyMic()
        } catch (e) {
          if (e instanceof JoinAborted) return
          abandonMedia()
          throw e
        }
        sendOrAbandon({ type: 'voice_join', channel_id: channelId })
        joins.joined(channelId, (get().voiceUsers[channelId] ?? []).includes(me.username))
        voiceListed = false
        set({ voice: { server, channelId }, call: null })
      }),

    leaveVoice: () => {
      if (home.ws.sendVoice({ type: 'voice_leave' })) joins.left()
      endVoiceMedia()
    },

    toggleMute: () => setSelfAudio(toggleMicAudio(get().selfAudio)),

    toggleDeafen: () => setSelfAudio(toggleDeafenAudio(get().selfAudio)),
    toggleCamera: () =>
      act(async () => {
        const { call, voice } = get()
        if (!voice && !call && p2pVoice.active()) return await p2pVoice.camera()
        if (!voice && !call && p2pCall.media()) return await p2pCall.camera()
        if (!voice && call?.kind === 'p2p') return await p2p.toggleCamera()
        const on = rtc.videoTrack === null
        if (on && forcedMute()) throw new Error(TIMED_OUT_CAMERA)
        await rtc.camera(on)
      }),
    toggleShare: () =>
      act(async () => {
        const { call, voice } = get()
        if (!voice && !call && p2pVoice.active()) return await p2pVoice.share()
        if (!voice && !call && p2pCall.media()) return await p2pCall.share()
        if (!voice && call?.kind === 'p2p') return await p2p.toggleShare()
        const on = !rtc.sharing
        if (on && forcedMute()) throw new Error(TIMED_OUT_SHARE)
        await rtc.share(on)
      }),

    startCall: (dmId, video) =>
      act(async () => {
        const me = caller()
        try {
          p2pCall.hangup()
          p2pVoice.leave()
          p2p.endMedia()
          await rtc.join(me.username, { dmId }, get().selfAudio.muted)
          applyMic()
          if (video) await rtc.camera(true)
        } catch (e) {
          if (e instanceof JoinAborted) return
          abandonMedia()
          throw e
        }
        sendOrAbandon({ type: 'call_start', dm_id: dmId, video })
        set({ voice: null })
      }),

    startP2pCall: (dmId, video, relay) =>
      act(async () => {
        caller()
        const plan = await relayBook.check(relay ?? relayBook.prefs.choice)
        try {
          p2pCall.hangup()
          p2pVoice.leave()
          rtc.leave()
          await p2p.startMedia(get().selfAudio.muted)
          p2p.setCallIce(plan)
          applyMic()
          if (video) await p2p.toggleCamera()
        } catch (e) {
          abandonMedia()
          throw e
        }
        sendOrAbandon({
          type: 'call_start',
          dm_id: dmId,
          p2p: true,
          video,
          peer_id: p2p.peerId(),
          ...(plan.declared.length ? { relays: plan.declared } : {}),
        })
        set({ voice: null })
      }),

    setCallRoute: saveCallRoute,

    acceptCall: () =>
      act(async () => {
        const { me, call } = get()
        if (!me || !call || call.state !== 'ringing') return
        let plan: Awaited<ReturnType<typeof relayBook.check>> | null = null
        if (call.kind === 'p2p') {
          const theirs = (call.relays ?? [])
            .filter(r => r.user !== me.username)
            .flatMap(r => r.hosts)
          const mine = await relayBook.check(relayBook.prefs.choice)
          plan = mine
          if (!hidesIp(mine) && (await relayBook.consent(theirs)) !== null) {
            if (get().call?.dmId === call.dmId) get().declineCall()
            throw new Error(DENIED_CALL)
          }
          const still = get().call
          if (still?.dmId !== call.dmId || still.state !== 'ringing') return
        }
        try {
          p2pCall.hangup()
          p2pVoice.leave()
          if (call.kind === 'p2p') {
            rtc.leave()
            await p2p.startMedia(get().selfAudio.muted)
            p2p.setCallIce(plan)
          } else {
            p2p.endMedia()
            await rtc.join(me.username, { dmId: call.dmId }, get().selfAudio.muted)
          }
          applyMic()
        } catch (e) {
          if (e instanceof JoinAborted) return
          abandonMedia()
          throw e
        }
        const ringing = get().call
        if (ringing?.dmId !== call.dmId || ringing.state !== 'ringing') {
          abandonMedia()
          return
        }
        if (call.kind === 'p2p') p2p.expectCall()
        sendOrAbandon(
          call.kind === 'p2p'
            ? {
                type: 'call_accept',
                dm_id: call.dmId,
                peer_id: p2p.peerId(),
                ...(plan?.declared.length ? { relays: plan.declared } : {}),
              }
            : { type: 'call_accept', dm_id: call.dmId }
        )
        set({ voice: null })
      }),

    declineCall: () => endCall('call_decline'),

    hangupCall: () => endCall('call_leave'),

    setViewing: server => {
      if (get().token) home.ws.setViewing(server)
    },

    applyWsEvent: ev => {
      if (friendsHub.onEvent(ev)) return
      if (pollsHub.onEvent(ev)) return
      if (selectionHub.onEvent(ev)) return
      routeEvent(ev, tables)
    },

    openContextMenu: (x, y, items, opts = {}) => set({ contextMenu: { ...opts, x, y, items } }),
    closeContextMenu: () => set({ contextMenu: null }),

    openReactPicker: (message, anchor) => set({ reactPicker: { message, anchor } }),
    closeReactPicker: () => set({ reactPicker: null }),
    openProfile: (user, server, x, y) => set({ profile: { user, server, x, y } }),
    closeProfile: () => set(s => (s.profile ? { profile: null } : {})),
    openDialog: dialog => set({ activeDialog: dialog }),
    closeDialog: () => set({ activeDialog: null }),
    askConfirm: req =>
      set(s => ({ confirm: req, confirmSeq: s.confirmSeq + 1, contextMenu: null })),
    closeConfirm: () => set(s => (s.confirm ? { confirm: null } : {})),
    setError: message => set({ error: message }),
  }
})

// Called with every live event after the store applied it (the palette index drops what the
// viewer lost access to).
const wsTaps = new Set<(ev: WsEvent) => void>()

export const tapWs = (tap: (ev: WsEvent) => void) => {
  wsTaps.add(tap)
  return () => void wsTaps.delete(tap)
}

// What every display path masks names and text with: the personal profanity filter once it is
// on and loaded, else the text as it is.
export const maskOf = (s: RChatState) => (s.profanityReady ? maskProfanity : showText)

export const useMask = () => useStore(maskOf)
