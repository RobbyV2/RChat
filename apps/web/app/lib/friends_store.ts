// The store's friends actions and events, kept apart from store.ts. `friendsSlice` gets the
// store's helpers and returns the actions plus the hooks the store calls on sign-in, resync,
// pings and WS events.

import { api } from './instances'
import { addPing, clearPings, pingUntil, setScopePings } from './pings'
import {
  FRIENDS_SCOPE,
  addRequest,
  matchesFriendQuery,
  parsePrivacy,
  placeFriend,
  sendLabel,
  setOnline,
  withoutUser,
  type FriendsTab,
  type SendResult,
} from './friends'
import type { Paged, RChatState } from './store_types'
import type { Friend, FriendRequest, Ping, UserRef, WsEvent } from './types'
import type { Page } from './lists'

type SetState = (partial: Partial<RChatState> | ((s: RChatState) => Partial<RChatState>)) => void

export interface FriendsDeps {
  set: SetState
  get: () => RChatState
  act: (fn: () => Promise<void>) => Promise<void>
  loadPage: <T>(
    id: string,
    read: () => Paged<T>,
    write: (page: Paged<T>) => void,
    fetchPage: (cursor: string | null) => Promise<Page<T>>,
    keyOf: (item: T) => string,
    q: string,
    reset: boolean
  ) => Promise<void>
  toast: (text: string, name?: string) => void
  fail: (e: unknown) => void
  errorText: (e: unknown) => string
}

const empty = <T>(): Paged<T> => ({ list: [], hasMore: true, loading: false, q: '' })

export const friendsInitial = () => ({
  friends: empty<Friend>(),
  onlineFriends: empty<Friend>(),
  incomingRequests: empty<FriendRequest>(),
  outgoingRequests: empty<FriendRequest>(),
  friendCounts: { incoming: 0, outgoing: 0 },
  privacy: null,
})

const byName = (r: FriendRequest | Friend) => r.user.username

export const friendsSlice = (d: FriendsDeps) => {
  const { set, get, act } = d
  const signedIn = () => !!get().me && !get().guest
  const mine = (username: string) => get().me?.username === username

  let summaryAsked = 0
  const loadSummary = async () => {
    const username = get().me?.username
    if (!username || get().guest) return
    const asked = ++summaryAsked
    let sum: Awaited<ReturnType<typeof api.friendSummary>>
    try {
      sum = await api.friendSummary()
    } catch {
      return
    }
    if (asked !== summaryAsked || !mine(username) || typeof sum !== 'object' || !sum) return
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    set(s => ({
      friendCounts: { incoming: n(sum.incoming), outgoing: n(sum.outgoing) },
      pings: setScopePings(s.pings, FRIENDS_SCOPE, null, {
        pings: n(sum.pings),
        pings_until: n(sum.pings_until),
      }),
    }))
  }

  const reloadOpenLists = () => {
    const s = get()
    if (s.panel?.kind !== 'friends') {
      set({
        friends: empty<Friend>(),
        onlineFriends: empty<Friend>(),
        incomingRequests: empty<FriendRequest>(),
        outgoingRequests: empty<FriendRequest>(),
      })
      return
    }
    void actions.loadFriends(s.friends.q, true)
    void actions.loadOnlineFriends(s.onlineFriends.q, true)
    void actions.loadFriendRequests(true, true)
    void actions.loadFriendRequests(false, true)
  }

  const panelOpen = () => get().panel?.kind === 'friends' && pageVisible()

  const pageVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'

  const markSeen = () => {
    const until = pingUntil(get().pings[FRIENDS_SCOPE])
    if (!until) return
    set(s => ({ pings: clearPings(s.pings, FRIENDS_SCOPE, until) }))
    if (get().token) void api.friendsSeen(until).catch(() => {})
  }

  const putFriend = (f: Friend) =>
    set(s => {
      const fits = (p: Paged<Friend>) => matchesFriendQuery(f.user, p.q)
      const all = fits(s.friends)
        ? { ...s.friends, list: placeFriend(s.friends.list, f, s.friends.hasMore) }
        : s.friends
      const online =
        f.online && fits(s.onlineFriends)
          ? {
              ...s.onlineFriends,
              list: placeFriend(s.onlineFriends.list, f, s.onlineFriends.hasMore),
            }
          : { ...s.onlineFriends, list: withoutUser(s.onlineFriends.list, f.user.username) }
      return { friends: all, onlineFriends: online }
    })

  const dropFriend = (name: string) =>
    set(s => ({
      friends: { ...s.friends, list: withoutUser(s.friends.list, name) },
      onlineFriends: { ...s.onlineFriends, list: withoutUser(s.onlineFriends.list, name) },
    }))

  const dropRequest = (name: string) =>
    set(s => ({
      incomingRequests: { ...s.incomingRequests, list: withoutUser(s.incomingRequests.list, name) },
      outgoingRequests: { ...s.outgoingRequests, list: withoutUser(s.outgoingRequests.list, name) },
    }))

  const actions = {
    openFriends: (tab: FriendsTab = 'online') => {
      if (!signedIn()) return
      set({ panel: { kind: 'friends', tab } })
      markSeen()
    },

    setFriendsTab: (tab: FriendsTab) => {
      if (get().panel?.kind === 'friends') set({ panel: { kind: 'friends', tab } })
    },

    loadFriends: (q: string, reset = false) =>
      act(() =>
        d.loadPage(
          'friends',
          () => get().friends,
          friends => set({ friends }),
          cursor => api.friends(cursor, q),
          byName,
          q,
          reset
        )
      ),

    loadOnlineFriends: (q: string, reset = false) =>
      act(() =>
        d.loadPage(
          'friends_online',
          () => get().onlineFriends,
          onlineFriends => set({ onlineFriends }),
          cursor => api.friends(cursor, q, true),
          byName,
          q,
          reset
        )
      ),

    loadFriendRequests: (incoming: boolean, reset = false) =>
      act(() =>
        d.loadPage(
          incoming ? 'friend_requests_in' : 'friend_requests_out',
          () => (incoming ? get().incomingRequests : get().outgoingRequests),
          page => set(incoming ? { incomingRequests: page } : { outgoingRequests: page }),
          cursor => api.friendRequests(incoming, cursor),
          byName,
          '',
          reset
        )
      ),

    sendFriendRequest: async (username: string): Promise<SendResult> => {
      if (!signedIn()) return { ok: false, error: 'Sign in to add friends' }
      try {
        const res = await api.sendFriendRequest(username.trim())
        return { ok: true, status: res.status, user: res.user }
      } catch (e) {
        return { ok: false, error: d.errorText(e) }
      }
    },

    // One request per name, in order; resolves to each result.
    sendFriendRequests: async (names: string[]) => {
      const out: Record<string, SendResult> = {}
      for (const name of names) out[name] = await actions.sendFriendRequest(name)
      const done = Object.values(out).filter(r => r.ok)
      const only = done.length === 1 && names.length === 1 ? done[0] : null
      if (only?.ok) d.toast(sendLabel(only.status), only.user.display_name)
      else if (done.length) d.toast(`Sent ${done.length} of ${names.length} friend requests`)
      return out
    },

    // The confirm with mini profile previews; the names come from the add box, a profile or the
    // palette.
    askAddFriends: (names: string[]) => {
      if (!signedIn() || !names.length) return
      set({ activeDialog: { kind: 'add_friends', names } })
    },

    acceptFriend: (user: UserRef) =>
      act(async () => {
        await api.acceptFriend(user.username)
        d.toast('Now friends with', user.display_name)
      }),

    denyFriend: (username: string) =>
      act(async () => {
        await api.denyFriend(username)
      }),

    cancelFriendRequest: (username: string) =>
      act(async () => {
        await api.cancelFriendRequest(username)
      }),

    removeFriend: (user: UserRef) =>
      act(async () => {
        await api.removeFriend(user.username)
        d.toast('Removed friend', user.display_name)
      }),

    askRemoveFriend: (user: UserRef) => {
      if (!signedIn()) return
      get().askConfirm({
        title: 'Remove friend',
        body: `Remove ${user.display_name} from your friends?`,
        confirm: 'Remove',
        action: () => void actions.removeFriend(user),
      })
    },

    loadPrivacy: async () => {
      const username = get().me?.username
      if (!username || get().guest) return
      try {
        const raw = await api.privacy()
        if (mine(username)) set({ privacy: parsePrivacy(raw) })
      } catch (e) {
        d.fail(e)
      }
    },

    setPrivacy: (patch: Partial<NonNullable<RChatState['privacy']>>) =>
      act(async () => {
        const username = get().me?.username
        if (!username || get().guest) return
        const prev = get().privacy
        if (prev) set({ privacy: { ...prev, ...patch } })
        try {
          const raw = await api.setPrivacy(patch)
          if (mine(username)) set({ privacy: parsePrivacy(raw) })
        } catch (e) {
          if (mine(username)) set({ privacy: prev })
          throw e
        }
      }),

    markFriendsSeen: markSeen,
  }

  // A `ping` in the friends scope: counted unless the friends panel is open, then a toast.
  const onPing = (ping: Ping, alert: (go: () => void, action: string, actor: UserRef) => void) => {
    const request = ping.kind === 'friend_request'
    if (panelOpen()) {
      set(s => ({ pings: addPing(s.pings, ping) }))
      markSeen()
      return
    }
    set(s => ({ pings: addPing(s.pings, ping) }))
    alert(
      () => actions.openFriends(request ? 'pending' : 'all'),
      request ? 'sent you a friend request' : 'accepted your friend request',
      ping.actor
    )
  }

  // Returns true when the event was a friends event.
  const onEvent = (ev: WsEvent): boolean => {
    switch (ev.type) {
      case 'friend_request_added': {
        if (!mine(ev.username)) return true
        const r = ev.request
        set(s =>
          r.incoming
            ? {
                incomingRequests: {
                  ...s.incomingRequests,
                  list: addRequest(s.incomingRequests.list, r),
                },
              }
            : {
                outgoingRequests: {
                  ...s.outgoingRequests,
                  list: addRequest(s.outgoingRequests.list, r),
                },
              }
        )
        void loadSummary()
        return true
      }
      case 'friend_request_removed': {
        if (!mine(ev.username)) return true
        dropRequest(ev.other)
        void loadSummary()
        return true
      }
      case 'friend_added': {
        if (mine(ev.username)) putFriend(ev.friend)
        return true
      }
      case 'friend_removed': {
        if (mine(ev.username)) dropFriend(ev.friend)
        return true
      }
      case 'friend_presence': {
        if (!mine(ev.username)) return true
        const known = get().friends.list.find(f => f.user.username === ev.friend)
        set(s => ({
          friends: { ...s.friends, list: setOnline(s.friends.list, ev.friend, ev.online) },
        }))
        if (known) putFriend({ ...known, online: ev.online })
        else if (!ev.online)
          set(s => ({
            onlineFriends: {
              ...s.onlineFriends,
              list: withoutUser(s.onlineFriends.list, ev.friend),
            },
          }))
        else if (get().panel?.kind === 'friends')
          void actions.loadOnlineFriends(get().onlineFriends.q, true)
        return true
      }
      case 'privacy_changed': {
        if (mine(ev.username)) set({ privacy: parsePrivacy(ev.privacy) })
        return true
      }
      default:
        return false
    }
  }

  return {
    actions,
    loadSummary,
    reloadOpenLists,
    onPing,
    onEvent,
  }
}
