import { create } from 'zustand'
import { relayBook } from './relays'
import { NO_PINGS } from './pings'
import { NO_GROUP_PINGS } from './group_pings'
import { EMPTY_NOTIFY } from './notify'
import { maskProfanity, showText } from './profanity'
import { EMPTY_PREFS } from './emoji'
import { DEFAULT_ROUTE } from './call_choice'
import { emptyLayout } from './nav_layout'
import { DEFAULT_FEATURES } from './features'
import { SELF_AUDIO_IDLE } from './voice_layout'
import type { RChatState } from './store_types'
import {
  emptyPage,
  emptySearch,
  errorText,
  pageLoader,
  routeEvent,
  type Handlers,
} from './slices/ctx'
import { presenceSlice } from './slices/presence'
import { readsSlice } from './slices/reads'
import { messagesSlice } from './slices/messages'
import { serversSlice } from './slices/servers'
import { rtcSlice } from './slices/rtc'
import { BOOT_RETRY_MS, p2pGate, sessionSlice, tapWs } from './slices/session'
import {
  bindStore,
  confirmBan,
  confirmDeleteMessage,
  confirmKick,
  confirmTransfer,
  noteMemberTimeouts,
  noteTimeout,
  revokeAdminFor,
  uiSlice,
} from './slices/ui'

import { friendsInitial, friendsSlice } from './friends_store'
import { pollsSlice } from './polls_store'
import { selectionInitial, selectionSlice } from './selection_store'
import type { BlockedUser, ServerSummaryLite, UserRef, WsEvent } from './types'

export * from './attachments'
export { siteSettings } from './features'
export * from './selectors'
export * from './store_types'
export * from './view'
export { errorText }
export {
  BOOT_RETRY_MS,
  confirmBan,
  confirmDeleteMessage,
  confirmKick,
  confirmTransfer,
  noteMemberTimeouts,
  noteTimeout,
  revokeAdminFor,
  tapWs,
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
  const loadPage = pageLoader(epochs)

  const presenceHub = presenceSlice(set, get)
  const { forgetTyping, noteTyper } = presenceHub

  const uiHub = uiSlice(set, get, { forgetTyping })
  const {
    act,
    alertUser,
    armExpiry,
    fail,
    forgetServerRules,
    limitedAt,
    notifyOwner,
    pinSelf,
    readCallRoute,
    readEmoji,
    readForward,
    readLayout,
    readNotify,
    readProfanity,
    readSpoilers,
    readTyping,
    saveCallRoute,
    saveEmoji,
    saveForward,
    saveLayout,
    saveNotify,
    saveProfanityOn,
    saveShowSpoilers,
    saveTypingOn,
    selfDmId,
    systemNotice,
    toast,
    useNotify,
    useProfanity,
  } = uiHub

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

  const rtcHub = rtcSlice(set, get, { act, fail, saveCallRoute })
  const { applyMic, endRtc, endVoiceMedia, joins } = rtcHub

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
    clearView: (...a) => sessionHub.clearView(...a),
    confirmDeleteMessage,
    epochs,
    fail,
    groupAlert,
    lateAnchor,
    noteBlocked: (...a) => sessionHub.noteBlocked(...a),
    noteTyper,
    noteUnblocked: (...a) => sessionHub.noteUnblocked(...a),
    openChannelAt: (...a) => sessionHub.openChannelAt(...a),
    persistGuestServers: (...a) => sessionHub.persistGuestServers(...a),
    pinSelf,
    readsHub,
    sameUser: (...a) => sessionHub.sameUser(...a),
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
    atHome: (...a) => sessionHub.atHome(...a),
    bumpDmGen: messagesHub.bumpDmGen,
    clearView: (...a) => sessionHub.clearView(...a),
    dmPager,
    dropEditIn,
    dropGrant: (...a) => sessionHub.dropGrant(...a),
    dropLinkCards,
    endVoiceMedia,
    epochs,
    expireSession: (...a) => sessionHub.expireSession(...a),
    fail,
    forgetPending,
    forgetReads,
    forgetServerRules,
    forgetViews,
    guestLocked: (...a) => sessionHub.guestLocked(...a),
    liveKey,
    loadPage,
    loadUnreads,
    lockedOut: (...a) => sessionHub.lockedOut(...a),
    mapLists,
    mapTails,
    persistGrants: (...a) => sessionHub.persistGrants(...a),
    persistGuestNames: (...a) => sessionHub.persistGuestNames(...a),
    persistGuestServers: (...a) => sessionHub.persistGuestServers(...a),
    presenceHub,
    reauthorLinkCards,
    refetchMe: (...a) => sessionHub.refetchMe(...a),
    rememberGuestName: (...a) => sessionHub.rememberGuestName(...a),
    sameUser: (...a) => sessionHub.sameUser(...a),
    saveLayout,
    saveNotify,
    syncUrl: (...a) => sessionHub.syncUrl(...a),
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

  const sessionHub = sessionSlice(set, get, {
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
  })
  forgetStoreSession = sessionHub.forgetSession

  const tables = [
    presenceHub.handlers,
    readsHub.handlers,
    serversHub.handlers,
    messagesHub.handlers,
    rtcHub.handlers,
    sessionHub.handlers,
  ]
  type Routed =
    | keyof typeof presenceHub.handlers
    | keyof typeof readsHub.handlers
    | keyof typeof serversHub.handlers
    | keyof typeof messagesHub.handlers
    | keyof typeof rtcHub.handlers
    | keyof typeof sessionHub.handlers
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
      profanity_filter: false,
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
      ...DEFAULT_FEATURES,
    },

    instance: null,
    instanceHost: '',

    ...friendsHub.actions,
    ...pollsHub.actions,
    ...selectionHub.actions,

    noteTyping: presenceHub.noteTyping,

    ...readsHub.actions,
    ...messagesHub.actions,

    ...serversHub.actions,
    ...uiHub.actions,
    ...rtcHub.actions,
    ...sessionHub.actions,

    applyWsEvent: ev => {
      if (friendsHub.onEvent(ev)) return
      if (pollsHub.onEvent(ev)) return
      if (selectionHub.onEvent(ev)) return
      routeEvent(ev, tables)
    },
  }
})

bindStore(useStore)

useStore.subscribe((s, prev) => {
  if (s.settings !== prev.settings) p2pGate.settings(s.settings)
})

// What every display path masks names and text with: the personal profanity filter once it is
// on and loaded, else the text as it is.
export const maskOf = (s: RChatState) => (s.profanityReady ? maskProfanity : showText)

export const useMask = () => useStore(maskOf)
