import { create } from 'zustand'
import {
  ApiError,
  type LoginRequest,
  type PageOpts,
  type RegisterRequest,
  type SendOpts,
} from './api'
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
import { newP2pId, p2p } from './p2p'
import { hashBlob } from './sha256'
import { ice, iceKey, iceValue, parseIce } from './ice'
import { callRtc, p2pAccount, p2pCall, p2pRail, p2pVoice } from './p2p/app'
import { DENIED_CALL, hidesIp, mergeRelays, relayBook, relaysKey, type Decision } from './relays'
import { mentionsUser } from './mentions'
import { NO_PINGS } from './pings'
import { NO_GROUP_PINGS, dropGroupMessage } from './group_pings'
import {
  EMPTY_NOTIFY,
  extendMute,
  keepScopes,
  messageAlert,
  nextExpiry,
  notifyKey,
  notifyValue,
  parseNotify,
  pruneNotify,
  resetAll as resetAllNotify,
  resetScope,
  scopeOfKey,
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
import { canAddEmoji, emojiBase, reacted, reactorKey, withReaction } from './reactions'
import {
  editedQuote,
  fetchedQuote,
  fillQuote,
  parseReplyMention,
  quoteDeleted,
  quoteEdited,
  quoteOf,
  replyMentionKey,
  replyMentionValue,
  repliesToMe,
  sendReply,
  type Replying,
} from './replies'
import { applySed, lastEditable, type Sed } from './sed'
import { unlinkPin, withPinnedAt, withoutPin } from './pins'
import { isSystem, systemText } from './system_messages'
import {
  canForward,
  clipOf,
  forwardKey,
  forwardPending,
  forwardValue,
  parseForward,
  type ForwardClip,
} from './forward'
import { catchUpDelay, due } from './backoff'
import { endsSession, meRetryIn } from './session'
import {
  WINDOW_MAX,
  createLru,
  findById,
  indexOfId,
  mergeSorted,
  patchById,
  trimWindow,
} from './window'
import {
  appendUnique,
  bumpFront,
  createPager,
  keyed,
  mergeHead,
  refreshTail,
  samePrefix,
  windowEdges,
  type Key,
  type OlderState,
  type Page,
} from './lists'
import { SEARCH_PAGE, SEARCH_TRIES, addSearchPage, searchParams } from './search'
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
import { MESSAGE_MAX, charCount, cleanBio } from './rules'
import {
  dropStashedInvite,
  entryState,
  inviteEntry,
  invitePath,
  parseInvite,
  staleInvites,
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
import { slowExempt, slowWait } from './slowmode'
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
import {
  MAX_UPLOAD,
  attachModes,
  p2pIdTaken,
  siteSettings,
  startMode,
  type PendingUpload,
  type UploadMode,
} from './attachments'
import {
  changeableRoles,
  dmView,
  memberOf,
  memberTimeout,
  myPerms,
  myTimeoutEnds,
  scopeRule,
  serverNames,
  voiceMutedIn,
} from './selectors'
import type {
  ContextMenuItem,
  Focus,
  Outgoing,
  OutgoingStatus,
  Paged,
  RChatState,
  SearchState,
} from './store_types'
import { parsePath, threadKey, viewKey, viewPath, type Nav, type View } from './view'
import {
  Banned,
  LIST_MAX,
  PAGE,
  emptyPage,
  errorText,
  pageVisible,
  routeEvent,
  serverKey,
  settled,
  type Handlers,
} from './slices/ctx'
import { presenceSlice } from './slices/presence'
import { readsSlice } from './slices/reads'
import { serversSlice } from './slices/servers'

import { blockedSet, matchesBlockQuery, withoutTypers, type Blocked } from './blocks'
import { friendsInitial, friendsSlice } from './friends_store'
import { pollsSlice } from './polls_store'
import { selectionInitial, selectionSlice } from './selection_store'
import { mergePoll } from './polls'
import type {
  AuthResponse,
  BlockedUser,
  CallKind,
  DmSummary,
  EditStub,
  Embed,
  Me,
  Message,
  MessageLocation,
  ReplyRef,
  SearchResult,
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

const byId = (a: Message, b: Message) => a.id - b.id
const dmKey = (d: DmSummary) => d.id
const isSelfDm = (d: DmSummary) => d.is_self

const merge = mergeSorted<Message>

// Ids of optimistic messages, far above any real id.
const OPT_BASE = 1e15
let optSeq = 0
const nextTempId = () => OPT_BASE + ++optSeq
const draining = new Set<string>()

const pendingEmbeds = new Map<number, Embed[]>()
const reactorCache = new Map<string, Promise<UserRef[]>>()
const reactionQueue = new Map<string, Promise<void>>()
const REACTOR_CACHE = 200
const PENDING_EMBEDS_MAX = 256
const RESYNC_JITTER = 10_000
const CATCH_UP_VIEW_MAX = 5_000
const POLL_EVERY = 60_000
const VIEW_CACHE = 8
const DETACH_AT = WINDOW_MAX * 2
const rememberEmbeds = (id: number, embeds: Embed[]) => {
  pendingEmbeds.delete(id)
  pendingEmbeds.set(id, embeds)
  if (pendingEmbeds.size > PENDING_EMBEDS_MAX)
    pendingEmbeds.delete(pendingEmbeds.keys().next().value as number)
}
const applyEmbeds = (list: Message[]) =>
  pendingEmbeds.size === 0
    ? list
    : list.map(m => {
        const e = pendingEmbeds.get(m.id)
        return e && e !== m.embeds ? { ...m, embeds: e } : m
      })

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

  const dmPager = createPager<DmSummary>({
    read: () => get().dms,
    write: (dms, dmsMore) => {
      set({ dms, dmsMore })
      pinSelf()
    },
    fetchPage: api.listDms,
    keyOf: dmKey,
    page: PAGE,
  })

  let dmGen = 0
  // DMs this account closed that a lookup by id returned, so their settings are kept.
  const closedDms = new Map<number, DmSummary>()

  const historyGen = new Map<string, number>()
  let historySeq = 0
  const newHistory = (key: string) => historyGen.set(key, ++historySeq)

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

  const askP2p = (msgs: Message[]) => {
    const known = get().p2pAvailability
    const hosters = [
      ...new Set(
        msgs.flatMap(m =>
          m.media?.kind === 'p2p' &&
          m.media.hoster !== null &&
          !Object.hasOwn(known, m.media.hoster)
            ? [m.media.hoster]
            : []
        )
      ),
    ]
    if (hosters.length) home.ws.sendVoice({ type: 'p2p_who', hosters })
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

  const forgetPending = (keep: (key: string, upload: PendingUpload) => boolean) =>
    set(s => {
      const entries = Object.entries(s.pending)
      const kept = entries.filter(([key, upload]) => keep(key, upload))
      return kept.length === entries.length ? {} : { pending: Object.fromEntries(kept) }
    })

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

  // An edit in a channel that is gone for good can never be saved; an evicted view keeps it.
  const dropEditIn = (scopes: Set<string>) => {
    const ed = get().editing
    const channel = ed && findMessage(ed.id)?.channel_id
    if (ed && (scopes.has(ed.key) || (channel && scopes.has(`c${channel}`)))) set({ editing: null })
  }

  const messageKey = (channel_id: number | null, dm_id: number | null) => {
    if (channel_id !== null) return `c${channel_id}`
    if (dm_id !== null) return `d${dm_id}`
    return null
  }

  const TAIL_MAX = 200
  const tails = new Map<string, Message[]>()
  const holdTail = (key: string, m: Message) =>
    tails.set(key, merge(tails.get(key) ?? [], [m]).slice(-TAIL_MAX))
  const takeTail = (key: string, after: number) => {
    const held = tails.get(key) ?? []
    tails.delete(key)
    return held.filter(m => m.id > after)
  }
  const heads = new Map<string, number>()
  const loadingHead = (key: string) => (heads.get(key) ?? 0) > 0
  const holding = (key: string) => detached(key) || loadingHead(key)
  const headLoad = async <T>(key: string, run: () => Promise<T>): Promise<T> => {
    heads.set(key, (heads.get(key) ?? 0) + 1)
    if (get().messages[key]?.length) set(s => ({ stale: { ...s.stale, [key]: true } }))
    try {
      return await run()
    } catch (e) {
      if (heads.get(key) === 1) {
        const caught = detached(key) ? [] : takeTail(key, 0)
        set(s => ({
          messages:
            caught.length && s.messages[key]
              ? { ...s.messages, [key]: applyEmbeds(merge(s.messages[key], caught)) }
              : s.messages,
          stale: keyed(s.stale, key, null),
        }))
      }
      throw e
    } finally {
      const left = (heads.get(key) ?? 1) - 1
      if (left > 0) heads.set(key, left)
      else heads.delete(key)
    }
  }
  const mapTails = (fn: (list: Message[]) => Message[]) => {
    for (const [key, list] of tails) {
      const next = fn(list)
      if (next !== list) tails.set(key, next)
    }
  }

  const mapLists = (
    messages: Record<string, Message[]>,
    fn: (list: Message[], key: string) => Message[]
  ) => {
    let out: Record<string, Message[]> | null = null
    for (const [key, list] of Object.entries(messages)) {
      const next = fn(list, key)
      if (next === list) continue
      out ??= { ...messages }
      out[key] = next
    }
    return out ?? messages
  }

  const patchMessage = (id: number, fn: (m: Message) => Message) => {
    const patch = (list: Message[]) => patchById(list, id, fn)
    mapTails(patch)
    set(s => {
      const messages = mapLists(s.messages, patch)
      return messages === s.messages ? {} : { messages }
    })
  }

  const findMessage = (id: number) => {
    const { messages, panel } = get()
    for (const list of Object.values(messages)) {
      const m = findById(list, id)
      if (m) return m
    }
    return panel?.kind === 'thread' && panel.root.id === id ? panel.root : undefined
  }

  const patchReactions = (id: number, fn: (m: Message) => Message) => {
    patchMessage(id, fn)
    set(s =>
      s.panel?.kind === 'thread' && s.panel.root.id === id
        ? { panel: { ...s.panel, root: fn(s.panel.root) } }
        : {}
    )
  }

  const forgetReactors = (key: string) => void reactorCache.delete(key)

  // The pins window reads through the gated list, so it only shows what the viewer may read.
  let pinsGen = 0
  const loadPins = (key: string) => {
    pinsGen += 1
    const gen = pinsGen
    const id = Number(key.slice(1))
    const current = () => gen === pinsGen && get().pins?.key === key
    ;(key[0] === 'd' ? api.dmPins(id) : api.channelPins(id)).then(
      list => {
        if (!current()) return
        askP2p(list)
        set({ pins: { key, list, failed: false } })
      },
      () => {
        if (current()) set(s => (s.pins ? { pins: { ...s.pins, failed: true } } : {}))
      }
    )
  }

  const setPinned = (id: number, at: number | null) => {
    patchReactions(id, m => withPinnedAt(m, at))
    if (at === null)
      set(s =>
        s.pins?.list && s.pins.list.some(m => m.id === id)
          ? { pins: { ...s.pins, list: withoutPin(s.pins.list, id) } }
          : {}
      )
  }

  const refreshPins = (id: number) => {
    const pins = get().pins
    if (pins?.list?.some(m => m.id === id)) loadPins(pins.key)
  }

  const quotes = new Map<number, ReplyRef>()
  const quoteReads = new Set<number>()
  let quoteGen = 0

  const held = (id: number) =>
    findMessage(id) ?? [...tails.values()].map(list => findById(list, id)).find(Boolean)

  // A message or its attachment went away: stop serving our file and drop downloaded copies,
  // whether or not the message is loaded here.
  const unhost = (id: number) => {
    const media = held(id)?.media
    const me = get().me?.username
    if (media?.kind === 'p2p' && me !== undefined && media.hoster === me) p2p.removeFile(media.id)
    p2p.forgetMessage(id)
  }

  const readQuote = (m: Message) => {
    const ref = m.reply_to
    if (!ref?.partial || quoteReads.has(m.id) || !held(m.id)) return
    quoteReads.add(m.id)
    const gen = quoteGen
    const page = { around: m.id, limit: 1 }
    const read =
      m.thread_root_id !== null
        ? api.threadMessages(m.thread_root_id, page)
        : m.channel_id !== null
          ? api.channelMessages(m.channel_id, page)
          : m.dm_id !== null
            ? api.dmMessages(m.dm_id, page)
            : null
    if (!read) return
    read
      .then(list => {
        if (gen !== quoteGen) return
        const quote = fetchedQuote(list, m.id, ref)
        quotes.set(m.id, quote)
        patchReactions(m.id, x => (x.reply_to?.partial ? { ...x, reply_to: quote } : x))
      })
      .catch(() => {})
      .finally(() => {
        if (gen === quoteGen) quoteReads.delete(m.id)
      })
  }

  const withQuote = (m: Message): Message => {
    if (!m.reply_to?.partial) return m
    const own = findMessage(m.id)?.reply_to
    const known = own && !own.partial ? own : quotes.get(m.id)
    return fillQuote(m, known, findMessage(m.reply_to.id)) ?? m
  }

  // Does anything shown quote message `id` (a reply's quote we may refresh)?
  const quoted = (id: number) => {
    const quotes_ = (list: Message[]) =>
      list.some(m => m.reply_to?.id === id && !m.reply_to.deleted)
    const { messages, panel } = get()
    return (
      Object.values(messages).some(quotes_) ||
      [...tails.values()].some(quotes_) ||
      [...quotes.values()].some(q => q.id === id && !q.deleted) ||
      (panel?.kind === 'thread' && panel.root.reply_to?.id === id)
    )
  }

  // An edit in a server channel arrives as a stub without content: whoever shows the message
  // (or a quote of it) re-reads it through the list, which applies the read-history rules.
  const rereads = new Map<number, boolean>()
  const rereadEdited = (ev: EditStub) => {
    const { id, channel_id } = ev
    const root = ev.thread_root_id ?? null
    if (!held(id) && !quoted(id)) return
    if (rereads.has(id)) {
      rereads.set(id, true)
      return
    }
    rereads.set(id, false)
    const gen = quoteGen
    const page = { around: id, limit: 1 }
    const read =
      root !== null ? api.threadMessages(root, page) : api.channelMessages(channel_id, page)
    read
      .then(list => {
        if (gen !== quoteGen) return
        const m = list.find(x => x.id === id)
        if (m) applyUpdated(m)
      })
      .catch(() => {})
      .finally(() => {
        if (gen !== quoteGen) return
        const again = rereads.get(id)
        rereads.delete(id)
        if (again) rereadEdited(ev)
      })
  }

  // A newer copy of a message (an edit, a call log update): replaces the shown one but keeps
  // its reactions, and quotes of it take the new text.
  const applyUpdated = (m: Message) => {
    const next = withQuote(m)
    patchReactions(next.id, x => ({
      ...next,
      reactions: x.reactions,
      poll: next.poll && x.poll ? mergePoll(x.poll, next.poll) : next.poll,
    }))
    readQuote(next)
    for (const [id, q] of quotes) {
      const e = editedQuote(q, next)
      if (e !== q) quotes.set(id, e)
    }
    mapTails(list => quoteEdited(list, next))
    set(s => {
      const messages = mapLists(s.messages, list => quoteEdited(list, next))
      const root = s.panel?.kind === 'thread' ? s.panel.root : null
      const rootQuote = root?.reply_to ? editedQuote(root.reply_to, next) : undefined
      const replying = Object.entries(s.replying).some(([, r]) => r.message.id === next.id)
        ? Object.fromEntries(
            Object.entries(s.replying).map(([k, r]) => [
              k,
              r.message.id === next.id
                ? { ...r, message: { ...next, reactions: r.message.reactions } }
                : r,
            ])
          )
        : s.replying
      return {
        ...(messages === s.messages ? {} : { messages }),
        ...(root && rootQuote !== root.reply_to
          ? { panel: { kind: 'thread' as const, root: { ...root, reply_to: rootQuote } } }
          : {}),
        ...(replying === s.replying ? {} : { replying }),
      }
    })
  }

  // The message Up and `s/` edit from the composer of `key`: your newest one there.
  const editTarget = (key: string) => {
    const { messages, panel, me } = get()
    const root =
      panel?.kind === 'thread' && threadKey(panel.root.id) === key
        ? (findMessage(panel.root.id) ?? panel.root)
        : null
    return lastEditable(messages[key] ?? [], me?.username, root)
  }

  // A message still showing its attachment (not removed or expired) may have no text.
  const attached = (m: Message) => !!m.media && !m.media.removed

  // Resolves with the sent message once the outgoing `tempId` is delivered, or `null` when it
  // fails or is cancelled.
  const sentWaiters = new Map<number, ((m: Message | null) => void)[]>()
  const settleSent = (tempId: number, m: Message | null) => {
    const waiting = sentWaiters.get(tempId)
    sentWaiters.delete(tempId)
    for (const w of waiting ?? []) w(m)
  }
  const sentAs = (tempId: number) =>
    new Promise<Message | null>(resolve => {
      sentWaiters.set(tempId, [...(sentWaiters.get(tempId) ?? []), resolve])
    })

  const sedOn = async (m: Message, sed: Sed) => {
    const next = applySed(m.content, sed)
    if (next === null) {
      fail(new Error('No match in your last message'))
      return false
    }
    if (next === m.content) return true
    if (!next.trim() && !attached(m)) {
      confirmDeleteMessage(m.id)
      return true
    }
    try {
      applyUpdated(await api.editMessage(m.id, next))
      return true
    } catch (e) {
      fail(e)
      return false
    }
  }

  const liveKey = (key: string) => {
    const { view, panel } = get()
    return (
      (view !== null && viewKey(view) === key) ||
      (panel?.kind === 'thread' && threadKey(panel.root.id) === key)
    )
  }

  const views = createLru<string>(VIEW_CACHE, liveKey)

  const forgetViews = (keys: string[]) => {
    if (!keys.length) return
    for (const key of keys) {
      tails.delete(key)
      heads.delete(key)
      historyGen.delete(key)
      lateAnchor.delete(key)
      views.delete(key)
    }
    const without = <T>(map: Record<string, T>) => {
      if (!keys.some(k => k in map)) return map
      const next = { ...map }
      for (const k of keys) delete next[k]
      return next
    }
    set(s => ({
      messages: without(s.messages),
      older: without(s.older),
      newer: without(s.newer),
      stale: without(s.stale),
      focus: without(s.focus),
      unreadAnchor: without(s.unreadAnchor),
      atBottom: without(s.atBottom),
    }))
  }

  const touchView = (key: string) => forgetViews(views.touch(key))

  const appendLive = (key: string, msgs: Message[], create = false): Partial<RChatState> | null => {
    const s = get()
    const cur = s.messages[key]
    if (!cur && !(create && liveKey(key))) return {}
    const merged = merge(cur ?? [], applyEmbeds(msgs))
    const bottom = liveKey(key) && s.atBottom[key] === true
    if (!bottom && merged.length > DETACH_AT) return null
    const bounded =
      bottom && !s.older[key]?.loading
        ? trimWindow(merged, 'newest')
        : { list: merged, trimmed: false }
    if (bounded.trimmed) newHistory(key)
    const anchor = s.unreadAnchor[key]
    const cut = bounded.trimmed && anchor > 0 && anchor < (bounded.list[0]?.id ?? 0)
    return {
      messages: { ...s.messages, [key]: bounded.list },
      ...(bounded.trimmed ? { older: { ...s.older, [key]: { more: true, loading: false } } } : {}),
      ...(cut ? { unreadAnchor: { ...s.unreadAnchor, [key]: 0 } } : {}),
    }
  }

  const holdLive = (key: string, msgs: Message[]): Partial<RChatState> => {
    for (const m of msgs) holdTail(key, m)
    return { newer: { ...get().newer, [key]: { more: true, loading: false } } }
  }

  const withoutEmbed = (embeds: Embed[], ord: number, banner: boolean) =>
    banner
      ? embeds.map(e => (e.ord === ord ? { ...e, banner_removed: true } : e))
      : embeds.filter(e => e.ord !== ord)

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

  // A message is gone (deleted alone or in a bulk delete): drops it from every list, the open
  // thread, replies and edits.
  // `counted` is false when the caller already removed it and the event still follows.
  const dropDeleted = (
    id: number,
    threadRootId: number | null,
    server: string | null,
    counted = true
  ) => {
    dropLinkCards(id)
    set(s => {
      const groupPings = dropGroupMessage(s.groupPings, id)
      return groupPings === s.groupPings ? {} : { groupPings }
    })
    if (server !== null) staleInvites(server)
    const rootOf = counted ? threadRootId : null
    unhost(id)
    setPinned(id, null)
    const drop = (list: Message[]) => {
      const i = indexOfId(list, id)
      const cut = unlinkPin(
        quoteDeleted(i === -1 ? list : [...list.slice(0, i), ...list.slice(i + 1)], id),
        id
      )
      return rootOf === null
        ? cut
        : patchById(cut, rootOf, m => ({
            ...m,
            reply_count: Math.max(0, m.reply_count - 1),
          }))
    }
    tails.delete(threadKey(id))
    views.delete(threadKey(id))
    mapTails(drop)
    forgetPending(key => key !== threadKey(id))
    set(s => {
      const kept = { ...s.messages }
      delete kept[threadKey(id)]
      const messages = mapLists(kept, drop)
      const panel =
        s.panel?.kind === 'thread' && s.panel.root.id === id
          ? null
          : s.panel?.kind === 'thread' && s.panel.root.id === rootOf
            ? {
                ...s.panel,
                root: {
                  ...s.panel.root,
                  reply_count: Math.max(0, s.panel.root.reply_count - 1),
                },
              }
            : s.panel
      const replying = Object.fromEntries(
        Object.entries(s.replying).filter(
          ([key, r]) => r.message.id !== id && key !== threadKey(id)
        )
      )
      return {
        messages,
        panel:
          panel?.kind === 'thread' && panel.root.reply_to?.id === id
            ? { ...panel, root: quoteDeleted([panel.root], id)[0] }
            : panel,
        ...(Object.keys(replying).length === Object.keys(s.replying).length ? {} : { replying }),
        ...(s.editing && (s.editing.id === id || s.editing.key === threadKey(id))
          ? { editing: null }
          : {}),
      }
    })
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
  const pollsHub = pollsSlice({
    get,
    act,
    patch: patchReactions,
    find: findMessage,
    errorText,
  })

  const queueMessage = (
    view: View,
    me: Me,
    content: string,
    pending: PendingUpload | null,
    p2pExpiresIn: number | null,
    reply: Replying | null = null
  ) => {
    home.ws.ensureConnected()
    const tempId = nextTempId()
    enqueue({
      tempId,
      key: viewKey(view),
      status: 'queued',
      pending,
      p2pExpiresIn,
      msg: {
        id: tempId,
        channel_id: view.kind === 'channel' ? view.channelId : null,
        dm_id: view.kind === 'dm' ? view.dmId : null,
        thread_root_id: null,
        author: me,
        content,
        created_at: Math.floor(Date.now() / 1000),
        reply_count: 0,
        media: null,
        embeds: [],
        kind: 'user',
        call: null,
        reply_to: reply ? quoteOf(reply, me.username) : null,
      },
      send: opts =>
        view.kind === 'channel'
          ? api.sendChannelMessage(view.channelId, content, { ...opts, ...sendReply(reply) })
          : api.sendDmMessage(view.dmId, content, { ...opts, ...sendReply(reply) }),
    })
  }

  const sameUser = (username: string) => get().me?.username === username

  const moveDmUp = (id: number) => {
    set(s => {
      const dm = s.dms.find(d => d.id === id)
      return dm ? { dms: bumpFront(s.dms, dm, dmKey, isSelfDm) } : {}
    })
    pinSelf()
  }

  // Takes a closed DM out of the list and its pin, and leaves it if it is open here.
  const hideDm = (id: number) => {
    const dm = get().dms.find(d => d.id === id)
    if (dm) closedDms.set(id, { ...dm, closed: true })
    const layout = get().layout
    if (layout.dmPinned.includes(id)) saveLayout(noteSelfPin(unpinIn(layout, id), selfDmId(), id))
    dmGen += 1
    const reload = dmPager.removed()
    set(s => ({ dms: s.dms.filter(d => d.id !== id) }))
    if (reload) void get().loadMoreDms()
    const { view, dms } = get()
    if (view?.kind !== 'dm' || view.dmId !== id) return
    const next = dms.find(d => d.is_self) ?? dms[0]
    if (next) void get().openDm(next.id, 'replace')
    else clearView()
  }

  const reopenDm = async (id: number) => {
    const closed = closedDms.get(id)
    const me = get().me
    if (!closed || !me) return
    const dm = await api.openDm(closed.other.username)
    if (!sameUser(me.username)) return
    closedDms.delete(id)
    set(s => ({ dms: bumpFront(s.dms, dm, dmKey, isSelfDm) }))
    pinSelf()
  }

  const bumpDm = (id: number) => {
    if (get().dms.some(d => d.id === id)) moveDmUp(id)
    else
      void get()
        .ensureDms([id])
        .then(() => moveDmUp(id))
        .catch(() => {})
  }

  const setOlder = (key: string, state: OlderState) =>
    set(s => ({ older: { ...s.older, [key]: state } }))

  const fetchPage = async (key: string, page: PageOpts): Promise<Message[]> => {
    const id = Number(key.slice(1))
    try {
      switch (key[0]) {
        case 'c':
          return await api.channelMessages(id, page)
        case 'd':
          return await api.dmMessages(id, page)
        default:
          return await api.threadMessages(id, page)
      }
    } catch (e) {
      const { servers, view } = get()
      const server =
        key[0] === 'c'
          ? Object.values(servers).find(d => d.channels.some(c => c.id === id))?.name
          : key[0] === 'd'
            ? null
            : view?.kind === 'channel'
              ? view.server
              : null
      throw banCheck(e, server)
    }
  }

  const detached = (key: string) => get().newer[key]?.more === true

  const loadOlderFor = async (key: string) => {
    const cur = get().older[key]
    if (cur?.loading || cur?.more === false) return
    const first = (get().messages[key] ?? [])[0]
    if (!first) return
    if (!historyGen.has(key)) newHistory(key)
    const gen = historyGen.get(key)
    const current = () => historyGen.get(key) === gen
    setOlder(key, { more: true, loading: true })
    let older: Message[]
    try {
      older = await fetchPage(key, { before: first.id })
    } catch (e) {
      if (!current()) return
      setOlder(key, { more: true, loading: false })
      throw e
    }
    if (!current()) return
    const bounded = trimWindow(merge(get().messages[key] ?? [], applyEmbeds(older)), 'oldest')
    if (bounded.trimmed) {
      newHistory(key)
      tails.delete(key)
    }
    set(s => ({
      messages: { ...s.messages, [key]: bounded.list },
      older: { ...s.older, [key]: { more: older.length === PAGE, loading: false } },
      ...(bounded.trimmed ? { newer: { ...s.newer, [key]: { more: true, loading: false } } } : {}),
    }))
    askP2p(older)
  }

  const loadNewerFor = async (key: string) => {
    const cur = get().newer[key]
    if (!cur?.more || cur.loading) return
    const list = get().messages[key] ?? []
    const last = list[list.length - 1]
    if (!last) return
    if (!historyGen.has(key)) newHistory(key)
    const gen = historyGen.get(key)
    const current = () => historyGen.get(key) === gen
    set(s => ({ newer: { ...s.newer, [key]: { more: true, loading: true } } }))
    let newer: Message[]
    try {
      newer = await fetchPage(key, { after: last.id })
    } catch (e) {
      if (!current()) return
      set(s => ({ newer: { ...s.newer, [key]: { more: true, loading: false } } }))
      throw e
    }
    if (!current()) return
    const more = newer.length === PAGE
    const caught = more ? [] : takeTail(key, Math.max(last.id, ...newer.map(m => m.id)))
    const bounded = trimWindow(
      merge(get().messages[key] ?? [], applyEmbeds([...newer, ...caught])),
      'newest'
    )
    if (bounded.trimmed) newHistory(key)
    set(s => ({
      messages: { ...s.messages, [key]: bounded.list },
      newer: keyed(s.newer, key, more ? { more: true, loading: false } : null),
      ...(bounded.trimmed ? { older: { ...s.older, [key]: { more: true, loading: false } } } : {}),
    }))
    askP2p(newer)
  }

  const firstPage = (key: string, msgs: Message[], focus?: Focus) => {
    newHistory(key)
    touchView(key)
    const sorted = [...msgs].sort(byId)
    const caught = takeTail(key, (sorted[0]?.id ?? 1) - 1)
    set(s => ({
      messages: { ...s.messages, [key]: applyEmbeds(merge(caught, sorted)) },
      older: { ...s.older, [key]: { more: msgs.length === PAGE, loading: false } },
      newer: keyed(s.newer, key, null),
      stale: keyed(s.stale, key, null),
      ...(focus ? { focus: { ...s.focus, [key]: focus } } : {}),
    }))
  }

  const windowPage = (
    key: string,
    msgs: Message[],
    at: number,
    focus: (sorted: Message[]) => Focus | null
  ) => {
    newHistory(key)
    touchView(key)
    const sorted = [...msgs].sort(byId)
    const edges = windowEdges(
      sorted.map(m => m.id),
      at,
      PAGE
    )
    const caught = edges.newer ? [] : takeTail(key, (sorted[0]?.id ?? 1) - 1)
    if (edges.newer) {
      const last = sorted.at(-1)?.id ?? 0
      const held = (tails.get(key) ?? []).filter(m => m.id > last)
      if (held.length) tails.set(key, held)
      else tails.delete(key)
    }
    set(s => ({
      messages: { ...s.messages, [key]: applyEmbeds(merge(caught, sorted)) },
      older: { ...s.older, [key]: { more: edges.older, loading: false } },
      newer: keyed(s.newer, key, edges.newer ? { more: true, loading: false } : null),
      stale: keyed(s.stale, key, null),
      focus: keyed(s.focus, key, focus(sorted)),
    }))
  }

  const loadAround = async (
    key: string,
    at: number,
    focus: (sorted: Message[]) => Focus | null = () => ({ id: at, flash: true })
  ) => {
    const msgs = await headLoad(key, () => fetchPage(key, { around: at, limit: PAGE }))
    windowPage(key, msgs, at, focus)
    askP2p(msgs)
  }

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

  const LINK_CARDS_MAX = 500
  const LINK_BATCH_MAX = 50
  const LINK_BATCH_DELAY = 50
  const LINK_BATCH_FLIGHTS = 2
  const linkOrder = new Set<number>()
  const linkQueue = new Set<number>()
  const linkLoads = new Set<number>()
  let linkTimer: ReturnType<typeof setTimeout> | null = null
  let linkFlights = 0
  let linkGen = 0

  const keepLinkCards = (cards: [number, MessageLocation | null][]) => {
    if (!cards.length) return
    set(s => {
      const next = { ...s.linkCards }
      for (const [id, card] of cards) {
        linkOrder.delete(id)
        linkOrder.add(id)
        next[id] = card
      }
      for (const old of linkOrder) {
        if (linkOrder.size <= LINK_CARDS_MAX) break
        linkOrder.delete(old)
        delete next[old]
      }
      return { linkCards: next }
    })
  }

  const keepLinkCard = (id: number, card: MessageLocation | null) => keepLinkCards([[id, card]])

  const reauthorLinkCards = (u: UserRef) =>
    set(s => {
      const hit = Object.entries(s.linkCards).filter(
        ([, card]) => card?.author.username === u.username
      )
      if (!hit.length) return {}
      const next = { ...s.linkCards }
      for (const [id, card] of hit) if (card) next[Number(id)] = { ...card, author: u }
      return { linkCards: next }
    })

  const dropLinkCards = (id?: number) => {
    linkGen += 1
    if (id === undefined) linkOrder.clear()
    else linkOrder.delete(id)
    set(s => {
      if (id === undefined) return Object.keys(s.linkCards).length ? { linkCards: {} } : {}
      if (!(id in s.linkCards)) return {}
      const { [id]: _, ...rest } = s.linkCards
      return { linkCards: rest }
    })
  }

  const queueLinkCards = () => {
    if (linkTimer === null && linkQueue.size && linkFlights < LINK_BATCH_FLIGHTS)
      linkTimer = setTimeout(flushLinkCards, LINK_BATCH_DELAY)
  }

  // Visible message links resolve in batches of up to 50, at most two batches at a time.
  const flushLinkCards = () => {
    linkTimer = null
    while (linkQueue.size && linkFlights < LINK_BATCH_FLIGHTS) {
      const ids = [...linkQueue].slice(0, LINK_BATCH_MAX)
      for (const id of ids) linkQueue.delete(id)
      linkFlights += 1
      const gen = linkGen
      void api
        .messageLocations(ids)
        .then(
          found => found,
          e => (refused(e) ? [] : undefined)
        )
        .then(found => {
          linkFlights -= 1
          for (const id of ids) linkLoads.delete(id)
          if (gen !== linkGen) for (const id of ids) get().resolveLinkCard(id)
          else if (found) {
            const byId = new Map(found.map(card => [card.id, card]))
            keepLinkCards(ids.map(id => [id, byId.get(id) ?? null]))
          }
          queueLinkCards()
        })
    }
  }

  const refused = (e: unknown) =>
    e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429

  // Where a message is, through the same gate as reading it; null for every refusal.
  const locateMessage = async (id: number) => {
    try {
      const loc = await api.messageLocation(id)
      keepLinkCard(id, loc)
      return loc
    } catch (e) {
      if (!refused(e)) throw e
      keepLinkCard(id, null)
      return null
    }
  }

  const openMessageAt = async (id: number, nav: Nav) => {
    const loc = await locateMessage(id)
    if (!loc) return false
    if (loc.dm_id !== null) {
      const v = get().view
      if (v?.kind === 'dm' && v.dmId === loc.dm_id) await get().jumpTo(`d${loc.dm_id}`, id)
      else await get().openDm(loc.dm_id, nav, id)
      return true
    }
    const { server, channel_id } = loc
    if (server === null || channel_id === null) return false
    const { guest, guestServers } = get()
    if (guest && !guestServers.includes(server)) {
      persistGuestServers([...guestServers, server])
      home.ws.subscribe([server])
    }
    await openChannelAt(server, channel_id, loc.thread_root_id, id, nav)
    return true
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

  const readsHub = readsSlice(set, get, { alertUser, detached, friendsHub })
  const { clearAnchor, forgetReads, groupAlert, lateAnchor, loadUnreads, placeAnchor, readQueue } =
    readsHub

  const serversHub = serversSlice(set, get, {
    act,
    noteMemberTimeouts,
    noteTimeout,
    applyMic,
    askP2p,
    atHome,
    bumpDmGen: () => void (dmGen += 1),
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

  // Hashes of files being attached, started when the file is picked (see buildSendOpts).
  const attachHashes = new WeakMap<File, Promise<string>>()
  const hashOf = (file: File) => {
    let hash = attachHashes.get(file)
    if (!hash) {
      hash = hashBlob(file)
      attachHashes.set(file, hash)
    }
    return hash
  }

  const p2pExpiry = (expiresIn: number | null | undefined) =>
    expiresIn == null ? null : Math.floor(Date.now() / 1000) + expiresIn

  const buildSendOpts = async (
    pending: PendingUpload | null,
    p2pExpiresIn: number | null | undefined
  ): Promise<{ opts: SendOpts; p2pId: string | null }> => {
    if (!pending) return { opts: {}, p2pId: null }
    const { file, spoiler, mode } = pending
    if (mode === 'p2p') {
      const relay = pending.relay ?? relayBook.prefs.choice
      await relayBook.check(relay)
      const id = newP2pId()
      const sha256 = await hashOf(file)
      await p2p.stage(id, file, p2pExpiry(p2pExpiresIn), sha256, relay)
      return {
        opts: {
          media_spoiler: spoiler,
          p2p: {
            filename: file.name,
            size: file.size,
            mime: (file.type || 'application/octet-stream').slice(0, 255),
            sha256,
            p2p_id: id,
            expires_in_seconds: p2pExpiresIn ?? undefined,
          },
        },
        p2pId: id,
      }
    }
    if (file.size > MAX_UPLOAD) throw new Error('File exceeds 25MB limit')
    const uploaded = await api.uploadMedia(file)
    return { opts: { media_id: uploaded.id, media_spoiler: spoiler }, p2pId: null }
  }

  const patchOutgoing = (key: string, tempId: number, status: OutgoingStatus) =>
    set(s => {
      const list = s.outbox[key]
      if (!list) return {}
      return {
        outbox: {
          ...s.outbox,
          [key]: list.map(o => (o.tempId === tempId ? { ...o, status } : o)),
        },
      }
    })

  const dropOutgoing = (map: Record<string, Outgoing[]>, key: string, tempId: number) => {
    const next = (map[key] ?? []).filter(o => o.tempId !== tempId)
    const outbox = { ...map }
    if (next.length) outbox[key] = next
    else delete outbox[key]
    return outbox
  }

  const drain = async (key: string) => {
    if (draining.has(key)) return
    draining.add(key)
    try {
      for (;;) {
        const head = (get().outbox[key] ?? [])[0]
        if (!head || head.status === 'failed') break
        patchOutgoing(key, head.tempId, 'sending')
        let real: Message
        try {
          const built = await buildSendOpts(head.pending, head.p2pExpiresIn)
          const { opts } = built
          let { p2pId } = built
          try {
            try {
              real = await head.send(opts)
            } catch (e) {
              if (p2pId === null || !p2pIdTaken(e) || !head.pending || !opts.p2p) throw e
              // Someone posted our P2P id first: keep the file under a fresh one and try once more.
              p2p.removeFile(p2pId)
              const id: string = newP2pId()
              p2pId = id
              await p2p.stage(
                id,
                head.pending.file,
                p2pExpiry(head.p2pExpiresIn),
                opts.p2p.sha256,
                head.pending.relay ?? relayBook.prefs.choice
              )
              real = await head.send({ ...opts, p2p: { ...opts.p2p, p2p_id: id } })
            }
          } catch (e) {
            if (p2pId !== null) p2p.removeFile(p2pId)
            throw e
          }
          if (p2pId !== null) p2p.posted(p2pId, real.id)
        } catch (e) {
          patchOutgoing(key, head.tempId, 'failed')
          settleSent(head.tempId, null)
          const wait = e instanceof ApiError && e.status === 429 ? slowWait(e.message) : null
          if (wait !== null) noteSlow(head.msg.channel_id, wait)
          fail(e)
          break
        }
        if (holding(key)) holdTail(key, real)
        const next = holding(key) ? {} : (appendLive(key, [real], true) ?? holdLive(key, [real]))
        set(s => ({ outbox: dropOutgoing(s.outbox, key, head.tempId), ...next }))
        settleSent(head.tempId, real)
        noteSlow(real.channel_id, null)
        if (key[0] !== 't') get().markRead(key, real.id)
      }
    } finally {
      draining.delete(key)
    }
  }

  const noteSlow = (channelId: number | null, wait: number | null) => {
    if (channelId === null) return
    const s = get()
    const detail = Object.values(s.servers).find(d => d.channels.some(c => c.id === channelId))
    const seconds = detail?.channels.find(c => c.id === channelId)?.slowmode_seconds ?? 0
    if (wait === null && (!detail || seconds <= 0 || slowExempt(myPerms(s, detail.name)))) return
    const until = Date.now() + (wait ?? seconds) * 1000
    set(st => ({ slowUntil: { ...st.slowUntil, [channelId]: until } }))
  }

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
    dmPager.reset(null)
    serverPager.reset(null)
    historyGen.clear()
    tails.clear()
    views.clear()
    presenceHub.forget()
    serversHub.forget()
    reactorCache.clear()
    quotes.clear()
    quoteReads.clear()
    rereads.clear()
    for (const id of [...sentWaiters.keys()]) settleSent(id, null)
    quoteGen += 1
    linkLoads.clear()
    linkGen += 1
  }
  forgetStoreSession = forgetSession

  const enqueue = (o: Outgoing) => {
    set(s => ({ outbox: { ...s.outbox, [o.key]: [...(s.outbox[o.key] ?? []), o] } }))
    void drain(o.key)
  }

  const onReaction = (ev: Extract<WsEvent, { type: 'reaction_added' | 'reaction_removed' }>) => {
    const mine = get().me?.username === ev.username
    const key = reactorKey(ev.message_id, ev.emoji)
    const added = ev.type === 'reaction_added'
    const at = Math.floor(Date.now() / 1000)
    forgetReactors(key)
    patchReactions(ev.message_id, m => {
      if (!mine || !reactionQueue.has(key) || ev.count === undefined)
        return withReaction(m, ev.emoji, added, mine, at, ev.count)
      const local = reacted(m, ev.emoji)
      const count = ev.count - (added ? 1 : 0) + (local ? 1 : 0)
      return withReaction(m, ev.emoji, local, true, at, count)
    })
  }

  const events = {
    message: ev => {
      const m = withQuote(ev.message)
      const rootId = m.thread_root_id
      if (rootId !== null) {
        const tkey = threadKey(rootId)
        const ckey = m.channel_id !== null ? `c${m.channel_id}` : null
        const bump = (list: Message[]) =>
          patchById(list, rootId, r => ({ ...r, reply_count: r.reply_count + 1 }))
        const held = ckey ? tails.get(ckey) : undefined
        if (ckey && held) tails.set(ckey, bump(held))
        const live = liveKey(tkey)
        if (live && holding(tkey)) holdTail(tkey, m)
        const thread = live && !holding(tkey) ? (appendLive(tkey, [m]) ?? holdLive(tkey, [m])) : {}
        set(s => {
          const messages = { ...s.messages, ...thread.messages }
          if (ckey && messages[ckey]) messages[ckey] = bump(messages[ckey])
          return {
            ...thread,
            messages,
            panel:
              s.panel?.kind === 'thread' && s.panel.root.id === rootId
                ? {
                    ...s.panel,
                    root: { ...s.panel.root, reply_count: s.panel.root.reply_count + 1 },
                  }
                : s.panel,
          }
        })
      } else {
        const key = messageKey(ev.channel_id, ev.dm_id)
        if (key && liveKey(key)) {
          if (holding(key)) holdTail(key, m)
          else set(appendLive(key, [m]) ?? holdLive(key, [m]))
        }
      }
      askP2p([m])
      readQuote(m)
      const typedIn = rootId !== null ? threadKey(rootId) : messageKey(ev.channel_id, ev.dm_id)
      if (typedIn) noteTyper(typedIn, m.author.username, '', false)
      if (ev.dm_id !== null && get().me) bumpDm(ev.dm_id)
      if (m.kind === 'call') return
      if (rootId === null) {
        const scope = messageKey(m.channel_id, m.dm_id)
        if (scope) {
          const meNow = get().me
          const mine = meNow?.username === m.author.username
          const viewNow = get().view
          const viewingScope = viewNow ? viewKey(viewNow) : null
          set(s => {
            const prev = s.reads[scope] ?? {
              lastRead: mine ? m.id : readsHub.more() ? 0 : m.id - 1,
              latest: 0,
            }
            return {
              reads: {
                ...s.reads,
                [scope]: {
                  ...prev,
                  latest: Math.max(prev.latest, m.id),
                  server: ev.server ?? prev.server,
                },
              },
            }
          })
          if (mine || (scope === viewingScope && get().atBottom[scope] && pageVisible()))
            get().markRead(scope, m.id)
        }
      }
      if (rootId === null && ev.server !== null && groupAlert(m, ev.server)) return
      const { me, view } = get()
      if (!me || m.author.username === me.username || (rootId !== null && m.dm_id === null)) return
      if (get().blocked[m.author.username]) return
      const scope = messageKey(m.channel_id, m.dm_id)
      const target = scope ? scopeOfKey(scope, ev.server ?? null) : null
      if (!scope || !target) return
      const toMe =
        repliesToMe(m, me.username) || (m.reply_to?.partial === true && m.reply_to.mention)
      if (!m.forward && (mentionsUser(m.content, me.username) || toMe)) return
      const watched =
        view !== null &&
        viewKey(view) === scope &&
        get().atBottom[scope] === true &&
        !detached(scope) &&
        pageVisible()
      if (!messageAlert(scopeRule(get(), target), watched)) return
      const { dm_id, channel_id } = ev
      const host = ev.server !== null ? get().servers[ev.server] : undefined
      const channel =
        channel_id !== null ? (host?.channels.find(c => c.id === channel_id)?.name ?? null) : null
      alertUser({
        key: scope,
        actor: m.author,
        action: '',
        body:
          m.kind === 'pin'
            ? 'Pinned a message'
            : isSystem(m)
              ? systemText(m)
              : m.content || (m.media?.spoiler ? '' : m.media?.filename) || 'Attachment',
        server: dm_id === null ? (host?.display_name ?? null) : null,
        channel,
        dm: dm_id !== null,
        message: true,
        name: m.author.display_name,
        generic: 'New message',
        go: () => {
          if (dm_id !== null) void get().openDm(dm_id, 'push', m.id)
          else if (ev.server !== null && channel_id !== null)
            void get().openChannel(ev.server, channel_id, 'push', m.id)
        },
      })
    },
    message_updated: ev => {
      dropLinkCards(ev.stub ? ev.id : ev.message.id)
      if (ev.stub) rereadEdited(ev)
      else applyUpdated(ev.message)
      refreshPins(ev.stub ? ev.id : ev.message.id)
    },
    message_pinned: ev => {
      setPinned(ev.message_id, ev.pinned_at)
      const key = messageKey(ev.channel_id, ev.dm_id)
      if (key && get().pins?.key === key) loadPins(key)
    },
    message_unpinned: ev => {
      setPinned(ev.message_id, null)
    },
    reaction_added: onReaction,
    reaction_removed: onReaction,
    message_deleted: ev => {
      dropDeleted(ev.id, ev.thread_root_id, ev.server)
    },
    messages_deleted: ev => {
      for (const id of ev.ids) dropDeleted(id, ev.thread_root_id, ev.server)
    },
    media_removed: ev => {
      unhost(ev.message_id)
      patchMessage(ev.message_id, m =>
        m.media
          ? {
              ...m,
              media: { ...m.media, removed: true, removed_by_author: ev.removed_by_author },
            }
          : m
      )
    },
    embeds_resolved: ev => {
      rememberEmbeds(ev.message_id, ev.embeds)
      patchMessage(ev.message_id, m => ({ ...m, embeds: ev.embeds }))
    },
    embeds_removed: ev => {
      const cur = pendingEmbeds.get(ev.message_id)
      if (cur) rememberEmbeds(ev.message_id, withoutEmbed(cur, ev.ord, ev.banner))
      patchMessage(ev.message_id, m => ({
        ...m,
        embeds: withoutEmbed(m.embeds, ev.ord, ev.banner),
      }))
    },
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
    p2p_availability: ev => {
      const { hoster, ids, online } = ev
      set(s => ({
        p2pAvailability: { ...s.p2pAvailability, [hoster]: { ids, online } },
      }))
    },
    p2p_peer: ev => {
      p2p.granted(ev)
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
    dm_created: ev => {
      const { me } = get()
      if (me && ev.dm_users.includes(me.username)) bumpDm(ev.dm_id)
    },
    dm_closed: ev => {
      if (get().me?.username === ev.username) hideDm(ev.dm_id)
    },
    dm_reopened: ev => {
      if (get().me?.username !== ev.username) return
      closedDms.delete(ev.dm_id)
      bumpDm(ev.dm_id)
    },
    user_blocked: ev => {
      if (get().me?.username === ev.username) noteBlocked(ev.blocked)
    },
    user_unblocked: ev => {
      if (get().me?.username === ev.username) noteUnblocked(ev.blocked)
    },
    p2p_hosted: ev => {
      if (typeof ev.key === 'string' && typeof ev.peer_id === 'string')
        p2p.setServeKey(ev.key, ev.peer_id, ev.now ?? null)
      void p2p.reconcile(ev.live, ev.checked)
    },
    resync: () => {
      dropLinkCards()
      resync()
    },
  } satisfies Handlers

  const tables = [presenceHub.handlers, readsHub.handlers, serversHub.handlers, events]
  type Routed =
    | keyof typeof presenceHub.handlers
    | keyof typeof readsHub.handlers
    | keyof typeof serversHub.handlers
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

    setDraft: (key, text) => set(s => ({ drafts: keyed(s.drafts, key, text || null) })),

    startDm: username =>
      act(async () => {
        const dm = await api.openDm(username)
        set(s => ({ dms: bumpFront(s.dms, dm, dmKey, isSelfDm) }))
        pinSelf()
        await get().openDm(dm.id)
      }),

    messageUser: (username, content) =>
      act(async () => {
        const { me } = get()
        if (!me) throw new Error('Create an account to send messages')
        const dm = await api.openDm(username)
        if (!sameUser(me.username)) return
        set(s => ({ dms: bumpFront(s.dms, dm, dmKey, isSelfDm) }))
        pinSelf()
        await get().openDm(dm.id)
        const author = get().me
        if (content.trim() && author?.username === me.username)
          queueMessage({ kind: 'dm', dmId: dm.id }, author, content, null, null)
      }),

    loadMoreDms: () =>
      act(async () => {
        if (get().me && get().dmsMore) await dmPager.load()
      }),

    ensureDms: async ids => {
      const me = get().me
      if (!me) return
      const have = new Set(get().dms.map(d => d.id))
      const missing = [...new Set(ids)].filter(id => Number.isSafeInteger(id) && !have.has(id))
      for (let i = 0; i < missing.length; i += LIST_MAX) {
        const batch = missing.slice(i, i + LIST_MAX)
        const found = await settled(
          () => dmGen,
          () => api.dmsById(batch)
        )
        if (!sameUser(me.username)) return
        for (const d of found) {
          if (d.closed) closedDms.set(d.id, d)
          else closedDms.delete(d.id)
        }
        set(s => ({
          dms: appendUnique(
            s.dms,
            found.filter(d => !d.closed),
            dmKey
          ),
        }))
        pinSelf()
      }
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

    closeDm: id =>
      act(async () => {
        const me = get().me
        if (!me) return
        hideDm(id)
        try {
          await api.closeDm(id)
        } catch (e) {
          if (!sameUser(me.username)) return
          closedDms.delete(id)
          await get()
            .ensureDms([id])
            .catch(() => {})
          throw e
        }
      }),

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

    sendMessage: (content, p2pExpiresIn, p2pRelay) => {
      const { view, me } = get()
      if (!view || !me) return
      const key = viewKey(view)
      const held = get().pending[key] ?? null
      const pending = held && p2pRelay !== undefined ? { ...held, relay: p2pRelay } : held
      if (!content.trim() && !pending) return
      const reply = get().replying[key] ?? null
      set(s => ({ pending: keyed(s.pending, key, null), replying: keyed(s.replying, key, null) }))
      clearAnchor(key)
      if (detached(key)) void get().jumpToPresent(key)
      queueMessage(view, me, content, pending, p2pExpiresIn ?? null, reply)
    },

    startReply: (key, m) => {
      const username = get().me?.username
      if (!username) return
      let mention = true
      try {
        mention = parseReplyMention(localStorage.getItem(home.scoped(replyMentionKey(username))))
      } catch {
        mention = true
      }
      set(s => ({
        replying: { ...s.replying, [key]: { message: m, mention } },
        composerFocus: { key, n: (s.composerFocus?.n ?? 0) + 1 },
      }))
    },

    cancelReply: key => set(s => ({ replying: keyed(s.replying, key, null) })),

    copyForward: m => {
      const { me, guest } = get()
      if (!me || guest || !canForward(m)) return
      saveForward(clipOf(m))
      toast('Message copied for forwarding')
    },

    clearForward: () => saveForward(null),

    copyForwardClip: clip => {
      const { me, guest } = get()
      if (!me || guest) return
      saveForward(clip)
      toast('Message copied for forwarding')
    },

    alertFrom: alert => alertUser(alert),

    openPins: () => {
      const { view } = get()
      if (!view) return
      const key = viewKey(view)
      set({ pins: { key, list: null, failed: false }, contextMenu: null })
      loadPins(key)
    },

    closePins: () => set(s => (s.pins ? { pins: null } : {})),

    pinMessage: id =>
      act(async () => {
        await api.pinMessage(id)
        patchReactions(id, m => (m.pinned_at ? m : withPinnedAt(m, Math.floor(Date.now() / 1000))))
      }),

    openPinned: (key, id) =>
      act(async () => {
        if (!(get().messages[key] ?? []).some(m => m.id === id)) {
          const probe = await fetchPage(key, { around: id, limit: 1 })
          if (probe[0]?.id !== id) {
            toast("You can't open this message")
            return
          }
        }
        await get().jumpTo(key, id)
      }),

    unpinMessage: id =>
      act(async () => {
        await api.unpinMessage(id)
        setPinned(id, null)
      }),

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

    sendForward: key => {
      const { me, guest, forwardClip: clip } = get()
      if (!me || guest || !clip || forwardPending(get().outbox[key], clip.id)) return
      // From a P2P conversation: the instance has no original to point at, so this posts a copy
      // of the text (the forward bar asked first).
      if (clip.p2p) {
        const body = clip.body ?? clip.snippet
        const view = get().view
        if (key[0] === 't') get().sendThreadMessage(body)
        else if (view && viewKey(view) === key) queueMessage(view, me, body, null, null, null)
        else return
        saveForward(null)
        return
      }
      const id = Number(key.slice(1))
      const kind = key[0]
      if (!Number.isSafeInteger(id) || !'cdt'.includes(kind)) return
      const s = get()
      const target =
        kind === 'c'
          ? {
              text: `Forwarded to #${
                Object.values(s.servers)
                  .flatMap(d => d.channels)
                  .find(c => c.id === id)?.name ?? 'channel'
              }`,
            }
          : kind === 'd'
            ? {
                text: 'Forwarded to',
                name: s.dms.find(d => d.id === id)?.other.display_name ?? 'direct message',
              }
            : { text: 'Forwarded to the thread' }
      home.ws.ensureConnected()
      if (kind !== 't') clearAnchor(key)
      if (detached(key)) void get().jumpToPresent(key)
      const tempId = nextTempId()
      const opts = { forward_of: clip.id }
      enqueue({
        tempId,
        key,
        status: 'queued',
        pending: null,
        p2pExpiresIn: null,
        msg: {
          id: tempId,
          channel_id: kind === 'c' ? id : null,
          dm_id: kind === 'd' ? id : null,
          thread_root_id: kind === 't' ? id : null,
          author: me,
          content: clip.snippet,
          created_at: Math.floor(Date.now() / 1000),
          reply_count: 0,
          media: null,
          embeds: [],
          kind: 'user',
          call: null,
          reply_to: null,
          forward: {
            author: clip.author,
            created_at: clip.created_at,
            source_id: clip.id,
            origin: null,
            dropped: null,
          },
        },
        send: () =>
          kind === 'c'
            ? api.sendChannelMessage(id, '', opts)
            : kind === 'd'
              ? api.sendDmMessage(id, '', opts)
              : api.sendThreadMessage(id, '', opts),
      })
      void sentAs(tempId).then(sent => {
        if (!sent) return
        if (get().forwardClip?.id === clip.id) saveForward(null)
        toast(target.text, target.name)
      })
    },

    openForward: m => {
      const fwd = m.forward
      return fwd ? get().openMessage(fwd.source_id) : Promise.resolve()
    },

    openMessage: (id, nav = 'push') =>
      act(async () => {
        if (!(await openMessageAt(id, nav))) toast("You can't open this message")
      }),

    resolveLinkCard: id => {
      if (id in get().linkCards || linkLoads.has(id)) return
      linkLoads.add(id)
      linkQueue.add(id)
      queueLinkCards()
    },

    startEdit: (key, m) => {
      const { me, guest } = get()
      if (guest || !me || m.author.username !== me.username || m.kind !== 'user' || m.forward)
        return
      set({ editing: { key, id: m.id, text: m.content } })
    },

    setEditText: text => set(s => (s.editing ? { editing: { ...s.editing, text } } : {})),

    cancelEdit: refocus => {
      const ed = get().editing
      if (!ed) return
      set(s => ({
        editing: null,
        ...(refocus ? { composerFocus: { key: ed.key, n: (s.composerFocus?.n ?? 0) + 1 } } : {}),
      }))
    },

    saveEdit: refocus => {
      const ed = get().editing
      if (!ed) return
      const m = findMessage(ed.id)
      if (!m) {
        set({ editing: null })
        fail(new Error('This message is no longer here'))
        return
      }
      const text = ed.text
      if (!text.trim() && !attached(m)) {
        confirmDeleteMessage(m.id)
        return
      }
      if (charCount(text) > MESSAGE_MAX) return
      get().cancelEdit(refocus)
      if (text === m.content) return
      const edited_at = Math.floor(Date.now() / 1000)
      patchReactions(m.id, x => ({ ...x, content: text, edited_at }))
      api
        .editMessage(m.id, text)
        .then(saved => {
          if (findMessage(m.id)?.content === text) applyUpdated(saved)
        })
        .catch(e => {
          patchReactions(m.id, x =>
            x.content === text ? { ...x, content: m.content, edited_at: m.edited_at } : x
          )
          fail(e)
        })
    },

    editLast: key => {
      const ed = get().editing
      if (ed && liveKey(ed.key)) {
        set({ editing: { ...ed, focus: (ed.focus ?? 0) + 1 } })
        return true
      }
      if (ed && ed.text !== findMessage(ed.id)?.content) {
        fail(new Error('Finish your other edit first'))
        return true
      }
      const m = editTarget(key)
      if (!m) return false
      get().startEdit(key, m)
      return get().editing?.id === m.id
    },

    sedEdit: async (key, sed) => {
      const sending = (get().outbox[key] ?? []).at(-1)
      if (sending) {
        if (sending.status === 'failed') {
          fail(new Error('Your last message was not sent'))
          return false
        }
        if (applySed(sending.msg.content, sed) === null) {
          fail(new Error('No match in your last message'))
          return false
        }
        const sent = await sentAs(sending.tempId)
        if (!sent) {
          fail(new Error('Your last message was not sent'))
          return false
        }
        return sedOn(sent, sed)
      }
      const m = editTarget(key)
      if (!m) {
        fail(new Error('You have no message here to edit'))
        return false
      }
      return sedOn(m, sed)
    },

    toggleReplyMention: key => {
      const cur = get().replying[key]
      const username = get().me?.username
      if (!cur || !username) return
      const mention = !cur.mention
      set(s => ({ replying: { ...s.replying, [key]: { ...cur, mention } } }))
      writeLocal(home.scoped(replyMentionKey(username)), replyMentionValue(mention))
    },

    ...readsHub.actions,

    setAtBottom: (key, v) =>
      set(s => (s.atBottom[key] === v ? {} : { atBottom: { ...s.atBottom, [key]: v } })),

    retryOutgoing: (key, tempId) => {
      patchOutgoing(key, tempId, 'queued')
      void drain(key)
    },

    cancelOutgoing: (key, tempId) => {
      set(s => ({ outbox: dropOutgoing(s.outbox, key, tempId) }))
      settleSent(tempId, null)
      void drain(key)
    },

    loadOlder: () =>
      act(async () => {
        const { view } = get()
        if (view) await loadOlderFor(viewKey(view))
      }),

    loadNewer: () =>
      act(async () => {
        const { view } = get()
        if (view) await loadNewerFor(viewKey(view))
      }),

    jumpTo: (key, id, flash = true) =>
      act(async () => {
        if (key === threadKey(id) || (get().messages[key] ?? []).some(m => m.id === id)) {
          set(s => ({ focus: { ...s.focus, [key]: { id, flash } } }))
          return
        }
        await loadAround(key, id, () => ({ id, flash }))
      }),

    jumpToUnread: () =>
      act(async () => {
        const { view } = get()
        if (!view) return
        const key = viewKey(view)
        const anchor = get().unreadAnchor[key] ?? 0
        if (anchor <= 0) return
        await loadAround(key, anchor, sorted => ({
          id: sorted.find(m => m.id > anchor)?.id ?? anchor,
          flash: false,
        }))
      }),

    jumpToPresent: key =>
      act(async () => {
        const msgs = await headLoad(key, () => fetchPage(key, {}))
        firstPage(key, msgs, { id: null, flash: false })
        askP2p(msgs)
      }),

    dismissUnread: key => {
      clearAnchor(key)
      const s = get()
      const latest = Math.max(s.reads[key]?.latest ?? 0, s.messages[key]?.at(-1)?.id ?? 0)
      if (latest > 0) s.markRead(key, latest)
    },

    clearFocus: key => set(s => (s.focus[key] ? { focus: keyed(s.focus, key, null) } : {})),

    openResult: result =>
      act(async () => {
        const { message, server } = result
        const { channel_id, thread_root_id, id } = message
        if (channel_id === null) return
        await openChannelAt(server, channel_id, thread_root_id, id)
      }),

    openPing: ping =>
      act(async () => {
        const id = Number(ping.scope.slice(1))
        if (ping.scope[0] === 'c') {
          if (ping.server !== null)
            await openChannelAt(ping.server, id, ping.thread_root_id, ping.message_id)
          return
        }
        const v = get().view
        if (v?.kind === 'dm' && v.dmId === id) await get().jumpTo(ping.scope, ping.message_id)
        else await get().openDm(id, 'push', ping.message_id)
      }),

    uploadFile: (key, file) => {
      const mode = file ? startMode(get().settings, file.size) : null
      if (file && mode === null) return
      if (file && mode === 'server' && file.size > MAX_UPLOAD) {
        fail(new Error('File exceeds 25MB limit'))
        return
      }
      if (file && get().settings.p2p_attachments) void hashOf(file).catch(() => {})
      const { panel } = get()
      const root = panel?.kind === 'thread' && threadKey(panel.root.id) === key ? panel.root : null
      const scope = root && root.channel_id !== null ? `c${root.channel_id}` : key
      const pending: PendingUpload | null =
        file && mode ? { file, spoiler: false, mode, scope } : null
      set(s => ({ pending: keyed(s.pending, key, pending) }))
    },

    toggleSpoiler: key =>
      set(s => {
        const cur = s.pending[key]
        return cur ? { pending: { ...s.pending, [key]: { ...cur, spoiler: !cur.spoiler } } } : {}
      }),

    toggleUploadMode: key =>
      set(s => {
        const cur = s.pending[key]
        if (!cur) return {}
        const mode: UploadMode = cur.mode === 'server' ? 'p2p' : 'server'
        if (!attachModes(s.settings).includes(mode)) return {}
        if (mode === 'server' && cur.file.size > MAX_UPLOAD) return {}
        if (mode === 'p2p') void hashOf(cur.file).catch(() => {})
        return { pending: { ...s.pending, [key]: { ...cur, mode } } }
      }),

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

    loadOlderThread: () =>
      act(async () => {
        const { panel } = get()
        if (panel?.kind === 'thread') await loadOlderFor(threadKey(panel.root.id))
      }),

    loadNewerThread: () =>
      act(async () => {
        const { panel } = get()
        if (panel?.kind === 'thread') await loadNewerFor(threadKey(panel.root.id))
      }),

    sendThreadMessage: (content, p2pExpiresIn, p2pRelay) => {
      const { panel, me } = get()
      if (panel?.kind !== 'thread' || !me) return
      const rootId = panel.root.id
      const key = threadKey(rootId)
      const held = get().pending[key] ?? null
      const pending = held && p2pRelay !== undefined ? { ...held, relay: p2pRelay } : held
      if (!content.trim() && !pending) return
      const tempId = nextTempId()
      const reply = get().replying[key] ?? null
      set(s => ({ pending: keyed(s.pending, key, null), replying: keyed(s.replying, key, null) }))
      if (detached(key)) void get().jumpToPresent(key)
      enqueue({
        tempId,
        key,
        status: 'queued',
        pending,
        p2pExpiresIn: p2pExpiresIn ?? null,
        msg: {
          id: tempId,
          channel_id: null,
          dm_id: null,
          thread_root_id: rootId,
          author: me,
          content,
          created_at: Math.floor(Date.now() / 1000),
          reply_count: 0,
          media: null,
          embeds: [],
          kind: 'user',
          call: null,
          reply_to: reply ? quoteOf(reply, me.username) : null,
        },
        send: opts => api.sendThreadMessage(rootId, content, { ...opts, ...sendReply(reply) }),
      })
    },

    searchRun: (args, reset) =>
      act(async () => {
        const cur = get().search
        if (!reset && (cur.loading || !cur.hasMore)) return
        if (reset) epochs.search = (epochs.search ?? 0) + 1
        const epoch = epochs.search ?? 0
        let results = reset ? [] : cur.results
        let cursor = reset ? null : (cur.cursor ?? null)
        set({ search: { results, hasMore: true, loading: true, cursor } })
        const { guest, guestServers } = get()
        const start = results.length
        for (let tries = 0; ; tries += 1) {
          let page: Page<SearchResult>
          try {
            page = await api.search(searchParams(args, cursor, guest ? guestServers : null))
          } catch (e) {
            if ((epochs.search ?? 0) === epoch)
              set({ search: { results, hasMore: true, loading: false, cursor } })
            throw e
          }
          if ((epochs.search ?? 0) !== epoch) return
          const next = addSearchPage(results, page.items, page.next)
          results = next.results
          cursor = page.next
          const done =
            !next.hasMore || results.length - start >= SEARCH_PAGE || tries + 1 >= SEARCH_TRIES
          set({ search: { ...next, loading: !done, cursor } })
          if (done) return
        }
      }),

    dismissNotice: id => {
      set(s => ({ notices: s.notices.filter(n => n.id !== id) }))
      scheduleNotices()
    },

    pauseNotices: paused => {
      if (get().noticesPaused === paused) return
      set(s => ({ noticesPaused: paused, notices: pauseNotices(s.notices, paused, Date.now()) }))
      scheduleNotices()
    },

    deleteMessage: id =>
      act(async () => {
        await api.deleteMessage(id)
        unhost(id)
        setPinned(id, null)
        const drop = (list: Message[]) => {
          const i = indexOfId(list, id)
          return unlinkPin(i === -1 ? list : [...list.slice(0, i), ...list.slice(i + 1)], id)
        }
        mapTails(drop)
        set(s => ({
          messages: mapLists(s.messages, drop),
          ...(s.editing?.id === id ? { editing: null } : {}),
        }))
      }),

    deleteMedia: messageId =>
      act(async () => {
        await api.deleteMedia(messageId)
        unhost(messageId)
        patchMessage(messageId, m =>
          m.media ? { ...m, media: { ...m.media, removed: true, removed_by_author: true } } : m
        )
      }),

    ...serversHub.actions,

    deleteEmbed: (messageId, ord, banner) =>
      act(async () => {
        await api.deleteEmbed(messageId, ord, banner)
        patchMessage(messageId, m => ({ ...m, embeds: withoutEmbed(m.embeds, ord, banner) }))
      }),

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

    toggleReaction: (m, emoji, note = true) => {
      const { me, guest } = get()
      if (!me || guest) return
      const cur = findMessage(m.id) ?? m
      const adding = !reacted(cur, emoji)
      if (adding && !canAddEmoji(cur, emoji)) return
      const key = reactorKey(m.id, emoji)
      const apply = (added: boolean) => {
        forgetReactors(key)
        patchReactions(m.id, x =>
          withReaction(x, emoji, added, true, Math.floor(Date.now() / 1000))
        )
      }
      apply(adding)
      if (adding && note) get().noteEmoji(emojiBase(get().emoji, emoji), emoji)
      const prev = reactionQueue.get(key) ?? Promise.resolve()
      const next = prev.then(async () => {
        try {
          if (adding) await api.addReaction(m.id, emoji)
          else await api.removeReaction(m.id, emoji)
        } catch (e) {
          apply(!adding)
          fail(e)
        }
      })
      reactionQueue.set(key, next)
      void next.then(() => {
        if (reactionQueue.get(key) === next) reactionQueue.delete(key)
      })
    },

    loadReactors: (messageId, emoji) => {
      const key = reactorKey(messageId, emoji)
      const known = reactorCache.get(key)
      if (known) return known
      const req = api.reactors(messageId, emoji).catch(e => {
        if (reactorCache.get(key) === req) reactorCache.delete(key)
        throw e
      })
      reactorCache.set(key, req)
      if (reactorCache.size > REACTOR_CACHE) {
        const oldest = reactorCache.keys().next().value
        if (oldest !== undefined) reactorCache.delete(oldest)
      }
      return req
    },

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
