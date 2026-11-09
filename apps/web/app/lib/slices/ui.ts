// The store's interface state: errors, toasts and notices, menus, dialogs and panels, the
// per-account display preferences, and the confirm builders.

import { ApiError } from '../api'
import {
  type CallRoute,
  DEFAULT_ROUTE,
  callRouteKey,
  callRouteValue,
  parseCallRoute,
} from '../call_choice'
import { EMPTY_PREFS, type EmojiPrefs, emojiKey, noteUse, parseEmojiPrefs, setTone } from '../emoji'
import { type ForwardClip, forwardKey, forwardValue, parseForward } from '../forward'
import { home, writeLocal } from '../instances'
import {
  type Layout,
  addToFolder as addIn,
  autoPinSelf,
  emptyLayout,
  layoutKey,
  mergeServers as mergeIn,
  moveFolder as moveFolderIn,
  moveIntoFolder as moveIntoIn,
  moveServer as moveServerIn,
  newFolderId,
  noteSelfPin,
  parseLayout,
  pinDm as pinIn,
  placeDm as placeIn,
  renameFolder as renameFolderIn,
  setFolderColor as setFolderColorIn,
  toggleFolder as toggleIn,
  ungroupFolder as ungroupIn,
  unpinDm as unpinIn,
} from '../nav_layout'
import {
  type AlertInput,
  type Notice,
  addNotice,
  desktopText,
  liveNotices,
  nextNoticeEnd,
  pauseNotices,
} from '../notices'
import {
  EMPTY_NOTIFY,
  type NotifyPrefs,
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
} from '../notify'
import { notifications } from '../platform'
import {
  maskOutsideCode,
  maskProfanity,
  parseProfanity,
  profanityKey,
  profanityValue,
  setMasking,
} from '../profanity'
import { dmView, serverNames } from '../selectors'
import { type ShowSpoilers, parseSpoilers, spoilersKey, spoilersValue } from '../spoilers'
import type { RChatState } from '../store_types'
import { type TimeoutWire, fromWire } from '../timeouts'
import { parseTyping, typingKey, typingValue } from '../typing'
import { Banned, type GetState, type SetState, emptySearch, errorText, readScoped } from './ctx'
import { isSelfDm } from './messages'
import type { StoreApi } from 'zustand'

let bound: StoreApi<RChatState> | null = null

// The store, for the builders below; store.ts binds it once it exists.
export const bindStore = (created: StoreApi<RChatState>) => {
  bound = created
}

const store = () => {
  if (!bound) throw new Error('The store is not bound yet: import store.ts first')
  return bound
}

export const confirmBan = (server: string, username: string) =>
  store()
    .getState()
    .askConfirm({
      title: 'Ban from Server',
      body: "Ban this user? They are removed from the server and can't join again until unbanned.",
      confirm: 'Ban',
      action: () => void store().getState().banMember(server, username),
    })

// Records the running timeouts (or none) of members of `server`, as a moderator sees them.
export const noteMemberTimeouts = (
  server: string,
  members: { username: string; timeout?: TimeoutWire }[]
) =>
  store().setState(s => {
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

export const confirmKick = (server: string, username: string, after?: () => void) =>
  store()
    .getState()
    .askConfirm({
      title: 'Kick Member',
      body: 'Kick this member? They are removed from the server but can join again.',
      confirm: 'Kick',
      action: () => void store().getState().kickMember(server, username).then(after),
    })

export const confirmTransfer = (server: string, username: string) =>
  store()
    .getState()
    .askConfirm({
      title: 'Transfer Admin',
      body: 'Make this member the server admin? You lose your own admin rights and cannot take them back yourself.',
      confirm: 'Transfer',
      action: () => void store().getState().transferAdmin(server, username),
    })

export const revokeAdminFor = (server: string, username: string, after?: () => void) => {
  const s = store().getState()
  const revoke = () => void store().getState().revokeAdmin(server, username).then(after)
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
  const s = store().getState()
  if (now) {
    void s.deleteMessage(id)
    return
  }
  s.askConfirm({
    title: 'Delete Message',
    body: 'Delete this message for everyone? Hold Shift while clicking the trash icon to skip this.',
    confirm: 'Delete',
    action: () => void store().getState().deleteMessage(id),
  })
}

export interface UiDeps {
  forgetTyping: (sendStop: boolean) => void
}

export const uiSlice = (set: SetState, get: GetState, deps: UiDeps) => {
  const { forgetTyping } = deps

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

  const forget = () => {
    if (noticeTimer !== null) clearTimeout(noticeTimer)
    noticeTimer = null
    if (expiryTimer !== null) clearTimeout(expiryTimer)
    expiryTimer = null
  }

  const actions: Pick<
    RChatState,
    | 'showToast'
    | 'openSearch'
    | 'closePanel'
    | 'setInboxOpen'
    | 'dismissNotice'
    | 'pauseNotices'
    | 'openContextMenu'
    | 'closeContextMenu'
    | 'openReactPicker'
    | 'closeReactPicker'
    | 'openProfile'
    | 'closeProfile'
    | 'openDialog'
    | 'closeDialog'
    | 'askConfirm'
    | 'closeConfirm'
    | 'setError'
    | 'moveServer'
    | 'moveFolder'
    | 'moveIntoFolder'
    | 'addToFolder'
    | 'mergeServers'
    | 'toggleFolder'
    | 'renameFolder'
    | 'setFolderColor'
    | 'ungroupFolder'
    | 'placeDm'
    | 'pinDm'
    | 'unpinDm'
    | 'reloadLayout'
    | 'noteEmoji'
    | 'setSkinTone'
    | 'reloadEmoji'
    | 'reloadForward'
    | 'setNotifyLevel'
    | 'setNotifySuppress'
    | 'muteScope'
    | 'muteServers'
    | 'resetNotify'
    | 'resetAllNotify'
    | 'setDesktopNotify'
    | 'reloadNotify'
    | 'pruneNotify'
    | 'setTypingOn'
    | 'setProfanityOn'
    | 'setShowSpoilers'
    | 'reloadTyping'
  > = {
    showToast: (text, name) => toast(text, name),

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
    setFolderColor: (id, color) => saveLayout(setFolderColorIn(get().layout, id, color)),
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
  }

  return {
    actions,
    limitedAt: () => limitedAt,
    act,
    fail,
    toast,
    notify,
    systemNotice,
    alertUser,
    readCallRoute,
    readEmoji,
    readForward,
    readLayout,
    readNotify,
    readProfanity,
    readSpoilers,
    readTyping,
    notifyOwner,
    useNotify,
    useProfanity,
    armExpiry,
    saveCallRoute,
    saveEmoji,
    saveForward,
    saveLayout,
    saveNotify,
    saveProfanityOn,
    saveShowSpoilers,
    saveTypingOn,
    forgetServerRules,
    selfDmId,
    pinSelf,
    forget,
  }
}
